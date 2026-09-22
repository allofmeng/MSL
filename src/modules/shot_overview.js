// "Shot overview" sub-page: a read-only summary of the user's shot history
// (dose/yield/ratio/rating averages, a configurable X/Y plot, and
// beans/grinder/profiles/steam breakdowns). Opened by a short tap on the main
// page's shot-history panel (see history.js setupHistoryLongPress). All
// aggregation math lives in the pure shot-stats.js; this module is the DOM +
// fetch layer that feeds it.
import { getShots, getShotById, API_BASE_URL } from './api.js';
import { openDB, getAllShots, addShot } from './idb.js';
import {
    computeShotStats, filterShotsByDays, shotAxisValue, AXIS_VARIABLES,
    shotAnnotation, shotsPerDay, bucketDays, rankedBarRows, sparklineSeries,
} from './shot-stats.js';
import { getTranslation } from './i18n.js';
import { loadPage } from './router.js';
import { formatTemp } from './units.js';
import { logger } from './logger.js';

const PAGE_SIZE = 100;
// ponytail: 500-shot cap, raise or page on scroll if users ask -- nobody's
// asked, and 500 list-only records is plenty to characterize months of shots.
const MAX_SHOTS = 500;
// How many of the newest shots get a full-record fetch (for duration) if they
// aren't already cached with measurements. Keeps the background enrichment
// to a handful of requests instead of hundreds.
const DURATION_FETCH_COUNT = 20;
const NEWEST_FULL_OPACITY_COUNT = 10;

const SVG_NS = 'http://www.w3.org/2000/svg';

// Time-range filter (7 days / 30 days / all history). '7'/'30' map to
// filterShotsByDays' `days` argument; 'all' maps to `null` (no filtering).
const RANGE_DAYS = { '7': 7, '30': 30, all: null };
const VALID_RANGES = Object.keys(RANGE_DAYS);
const RANGE_STORAGE_KEY = 'msl.shotOverviewRange';
const RANGE_SELECTED_CLASSES = ['bg-[var(--mimoja-blue)]', 'text-white'];
const RANGE_UNSELECTED_CLASSES = ['bg-transparent', 'text-[var(--text-primary)]'];

// Plot axis picker (X axis / Y axis selects). Keyed the same way
// shot-stats.js's AXIS_VARIABLES/shotAxisValue are, plus the special
// Y-only 'shotsPerDay' bar-chart mode (not a per-shot value, so it isn't in
// AXIS_VARIABLES/shotAxisValue at all -- see renderPlotArea's branch).
// No persistence: the page always opens on this default (coordinator call --
// dropped the earlier localStorage['msl.shotOverviewAxes']).
const DEFAULT_AXES = { x: 'date', y: 'shotsPerDay' };
const SHOTS_PER_DAY_VARIABLE = { key: 'shotsPerDay', label: 'Shots per day', unit: null };
const AXIS_VARIABLES_BY_KEY = Object.fromEntries(AXIS_VARIABLES.map((v) => [v.key, v]));
const MS_PER_DAY = 24 * 60 * 60 * 1000;

const MAX_DAY_CALLOUT_SHOTS = 5;

// The full enriched shot list (newest-first), independent of whatever range
// is currently selected -- the background duration fetch updates this in
// place and re-renders through the same filter, so it's always current
// regardless of which range the user is looking at.
let fullShotList = [];
let currentRange = 'all';
// The range-filtered list behind whatever's currently plotted -- an axis
// change alone re-plots from this without recomputing the range filter.
let currentFilteredShots = [];
let currentAxes = { ...DEFAULT_AXES };
// shot id -> shot, rebuilt every renderPlotArea() call, used by both plot
// modes' tap callouts to look up full shot records from a point/bucket.
let currentShotById = new Map();
// Populated by the scatter branch of renderPlotArea(); consumed by
// selectShot() when a hit circle is tapped.
let currentPlotPoints = [];
// Populated by the bar-chart branch; consumed by selectDay().
let currentDayBuckets = [];

function loadRangePreference() {
    try {
        const saved = localStorage.getItem(RANGE_STORAGE_KEY);
        return VALID_RANGES.includes(saved) ? saved : 'all';
    } catch (_) {
        return 'all';
    }
}

function saveRangePreference(range) {
    try {
        localStorage.setItem(RANGE_STORAGE_KEY, range);
    } catch (_) {
        // Storage unavailable (private mode, quota, ...) -- the choice just
        // won't survive a reload; not worth surfacing to the user for this.
    }
}

// Keeps a selection if it's still pickable, otherwise falls back to the
// Dose/Yield default, and only as a last resort to whatever IS available --
// used after a range change removes a variable (e.g. no TDS recorded in the
// last 7 days). 'shotsPerDay' is a standing Y option, not drawn from
// `available` (which only lists per-shot AXIS_VARIABLES keys) -- it's always
// valid once we get this far (there's always >=1 day span when there's >=1 shot).
function resolveAxisSelection(available, desired) {
    const fallback = available[0] ?? null;
    const x = available.includes(desired.x) ? desired.x : (available.includes(DEFAULT_AXES.x) ? DEFAULT_AXES.x : fallback);
    const y = desired.y === 'shotsPerDay' || available.includes(desired.y) ? desired.y : fallback;
    return { x, y };
}

function svgEl(tag, attrs) {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
    return el;
}

function formatDate(date) {
    if (!(date instanceof Date) || isNaN(date)) return '';
    return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

// "1 shot" / "{n} shots" -- every place a shot count is printed on this page
// (summary sentence, bean/grinder rows, the duration stat's "last N" note,
// the day-bar callout).
function shotCountLabel(count) {
    return count === 1 ? `1 ${getTranslation('shot')}` : `${count} ${getTranslation('shots')}`;
}

// Fetches the shot list, paging until the server says there's nothing more
// left or the cap is hit. Falls back to the IDB cache (sorted newest-first)
// if the network is unreachable. `source` tells the caller which of the two
// distinct empty states (plan: "no shots yet" vs "load failed, empty cache")
// applies when the result is empty.
async function loadShotList() {
    try {
        let items = [];
        let offset = 0;
        let total = Infinity;
        while (items.length < total && items.length < MAX_SHOTS) {
            const data = await getShots({ limit: PAGE_SIZE, offset, order: 'desc' });
            total = data.total ?? 0;
            const page = data.items ?? [];
            if (page.length === 0) break; // guard against a `total` that never catches up
            items = items.concat(page);
            offset += page.length;
        }
        if (items.length > MAX_SHOTS) items = items.slice(0, MAX_SHOTS);
        return { items, source: 'network' };
    } catch (error) {
        logger.warn('Shot overview: could not fetch shots from API, falling back to cache:', error);
    }

    try {
        await openDB();
        const cached = await getAllShots();
        cached.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
        return { items: cached.slice(0, MAX_SHOTS), source: 'cache' };
    } catch (error) {
        logger.error('Shot overview: cache fallback also failed:', error);
        return { items: [], source: 'error' };
    }
}

// The list endpoint never carries `measurements` (plan: "do not fetch
// per-shot records" for the list itself) -- but history.js's own browsing
// already caches full records for shots the user has looked at, so merge
// those in for free before falling back to a network fetch for duration.
async function mergeCachedMeasurements(items) {
    let cachedById = new Map();
    try {
        await openDB();
        const cached = await getAllShots();
        cachedById = new Map(cached.map((s) => [s.id, s]));
    } catch (error) {
        logger.warn('Shot overview: could not read IDB cache for measurement merge:', error);
        return items;
    }
    return items.map((item) => {
        const cached = cachedById.get(item.id);
        return cached?.measurements ? { ...item, measurements: cached.measurements } : item;
    });
}

// Best-effort background fetch of full records for the newest shots that
// still lack measurements, so the average-duration stat has something to
// work with. Never blocks the initial render; failures are swallowed per
// shot (a shot the server can no longer find just stays duration-less).
async function fetchDurationSample(items) {
    const candidates = items.slice(0, DURATION_FETCH_COUNT).filter((s) => !s.measurements);
    if (candidates.length === 0) return null;

    const results = await Promise.allSettled(candidates.map((s) => getShotById(s.id)));
    const byId = new Map();
    results.forEach((result, i) => {
        if (result.status === 'fulfilled' && result.value?.measurements) {
            const full = { ...candidates[i], ...result.value };
            byId.set(candidates[i].id, full);
            addShot(full).catch(() => {}); // fire-and-forget cache write
        }
    });
    if (byId.size === 0) return null;

    return items.map((item) => byId.get(item.id) ?? item);
}

function setDoneHandler() {
    const btn = document.getElementById('shot-overview-done-btn');
    if (btn) btn.onclick = () => loadPage('index.html');

    // "All shots" -> DYE2's full shot dashboard. Built from API_BASE_URL so it
    // hits the same Decaid the skin talks to (reaHostname), not localhost --
    // same reasoning as the decent-profile link in profile_selector.js. A plain
    // same-frame <a href>: the WebView host intercepts it and opens the OS
    // browser; target="_blank" would be blocked there.
    const allShots = document.getElementById('shot-overview-all-shots-link');
    if (allShots) allShots.href = `${API_BASE_URL}/plugins/dye2.reaplugin/dashboard`;
}

function showState(state) {
    const empty = document.getElementById('shot-overview-empty');
    const error = document.getElementById('shot-overview-error');
    const content = document.getElementById('shot-overview-content');
    empty?.classList.toggle('hidden', state !== 'empty');
    error?.classList.toggle('hidden', state !== 'error');
    content?.classList.toggle('hidden', state !== 'content');
}

// "All" keeps the original since-{date}/per-week sentence; the 7/30-day
// ranges get a simpler one -- "since {first shot's date}" reads oddly when
// that date is always within the last week or month.
function buildSummaryText(stats, rangeKey) {
    const countLabel = shotCountLabel(stats.count);
    if (rangeKey === '7' || rangeKey === '30') {
        const dayKey = rangeKey === '7' ? 7 : 30;
        return `${countLabel} ${getTranslation(`in the last ${dayKey} days.`)}`;
    }
    if (stats.count === 1) {
        return `${countLabel}, ${getTranslation('on')} ${formatDate(stats.firstDate)}.`;
    }
    const perWeek = Math.max(1, Math.round(stats.perWeek));
    return `${countLabel} ${getTranslation('since')} ${formatDate(stats.firstDate)}, `
        + `${getTranslation('about')} ${perWeek} ${getTranslation('a week.')}`;
}

// ~140x36 design px, 2px line, no axes, last point a 6px dot -- a quiet
// per-shot trend under the average, not a second chart to read numbers off.
// Single-hue: stroke/dot both read var(--accent-text), same as the plot's dots.
function renderSparkline(values) {
    const svg = svgEl('svg', {
        viewBox: '0 0 140 36', class: 'so-sparkline', 'aria-hidden': 'true', focusable: 'false',
    });
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = max - min || 1; // flat series (all-equal values) draws a straight mid-line, not div/0
    const stepX = values.length > 1 ? 140 / (values.length - 1) : 0;
    const PAD = 4;
    const y = (v) => PAD + (1 - (v - min) / span) * (36 - PAD * 2);

    const points = values.map((v, i) => `${(i * stepX).toFixed(2)},${y(v).toFixed(2)}`).join(' ');
    svg.appendChild(svgEl('polyline', {
        points, fill: 'none', stroke: 'var(--accent-text)',
        'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
    }));
    const lastIndex = values.length - 1;
    svg.appendChild(svgEl('circle', {
        cx: lastIndex * stepX, cy: y(values[lastIndex]), r: 3, fill: 'var(--accent-text)',
    }));
    return svg;
}

// Builds one stat tile. `note` is the small muted line under the value (e.g.
// "last 12 shots") -- omitted when null, per the "a stat with no data is
// omitted" rule (this only ever fires for the duration tile). `sparkValues`
// (chronological per-shot values for this stat, from sparklineSeries()) is
// omitted below 3 points -- a 1-2-point trend isn't a trend.
function statTile(labelKey, valueText, note, sparkValues) {
    const wrap = document.createElement('div');
    wrap.className = 'so-stat';

    const value = document.createElement('div');
    value.className = 'so-stat-value';
    value.textContent = valueText;
    wrap.appendChild(value);

    const label = document.createElement('div');
    label.className = 'so-stat-label';
    label.setAttribute('data-i18n-key', labelKey);
    label.textContent = getTranslation(labelKey);
    wrap.appendChild(label);

    if (sparkValues && sparkValues.length >= 3) {
        wrap.appendChild(renderSparkline(sparkValues));
    }

    if (note) {
        const noteEl = document.createElement('div');
        noteEl.className = 'so-stat-note';
        noteEl.textContent = note;
        wrap.appendChild(noteEl);
    }
    return wrap;
}

// Renders the whole stat row from scratch each time. Called once at initial
// render and again when the background duration fetch resolves -- cheap
// (a handful of tiles), and simpler than patching one tile in place. `shots`
// (the same range-filtered list `stats` was computed from) feeds each tile's
// sparkline -- computeShotStats itself only keeps averages, not per-shot series.
function renderStatsRow(stats, shots) {
    const row = document.getElementById('shot-overview-stats');
    if (!row) return;
    row.innerHTML = '';

    const { avg } = stats;
    if (avg.dose != null) row.appendChild(statTile('Dose', `${avg.dose.toFixed(1)} g`, null, sparklineSeries(shots, 'dose')));
    if (avg.yield != null) row.appendChild(statTile('Yield', `${avg.yield.toFixed(1)} g`, null, sparklineSeries(shots, 'yield')));
    if (avg.ratio != null) row.appendChild(statTile('Ratio', `1 : ${avg.ratio.toFixed(1)}`, null, sparklineSeries(shots, 'ratio')));
    if (avg.rating != null) row.appendChild(statTile('Rating', avg.rating.toFixed(1), null, sparklineSeries(shots, 'rating')));
    if (avg.duration != null) {
        const note = stats.durationSampleSize < stats.count
            ? `${getTranslation('last')} ${shotCountLabel(stats.durationSampleSize)}`
            : null;
        row.appendChild(statTile('Time', `${Math.round(avg.duration)} s`, note, sparklineSeries(shots, 'time')));
    }
    if (avg.tds != null) row.appendChild(statTile('TDS', `${avg.tds.toFixed(1)}%`));
    if (avg.ey != null) row.appendChild(statTile('EY', `${avg.ey.toFixed(1)}%`));
}

// Which of the plot variables actually have a value on at least one of these
// (already range-filtered) shots -- that's the select options list.
function availableAxisKeys(shots) {
    return AXIS_VARIABLES
        .filter((v) => shots.some((shot) => shotAxisValue(shot, v.key) != null))
        .map((v) => v.key);
}

// {x,y} pairs for every shot that has both values, in `shots`' order (which
// is newest-first) -- feeds the dot plot and the newest-N-full-opacity
// styling. Carries `shotId` so a tapped dot's hit circle can look the shot
// back up.
function computeAxisPoints(shots, xKey, yKey) {
    const points = [];
    for (const shot of shots) {
        const x = shotAxisValue(shot, xKey);
        const y = shotAxisValue(shot, yKey);
        if (x != null && y != null) points.push({ x, y, shotId: shot?.id ?? null });
    }
    return points;
}

// Rounds `range` to a "nice" 1/2/5x10^n value -- Heckbert's "nice numbers for
// graph labels". `round` picks the nearest nice fraction (for a tick step);
// without it, picks the smallest nice fraction >= range (for the overall span).
function niceNumber(range, round) {
    const exponent = Math.floor(Math.log10(range));
    const fraction = range / 10 ** exponent;
    let niceFraction;
    if (round) {
        if (fraction < 1.5) niceFraction = 1;
        else if (fraction < 3) niceFraction = 2;
        else if (fraction < 7) niceFraction = 5;
        else niceFraction = 10;
    } else if (fraction <= 1) niceFraction = 1;
    else if (fraction <= 2) niceFraction = 2;
    else if (fraction <= 5) niceFraction = 5;
    else niceFraction = 10;
    return niceFraction * 10 ** exponent;
}

// Numeric axis: rounds the padded [min,max] out to nice bounds/step so
// gridlines land on clean values instead of the data's raw decimals. Targets
// 5 ticks (4 intervals) but a nice step can round outward enough to add an
// extra one or two -- retry with fewer, coarser intervals until the count is
// back in the requested 4-6 range instead of just taking whatever 4 gives.
function niceNumberAxis(min, max) {
    if (min === max) { min -= 1; max += 1; }
    const span = niceNumber(max - min, false);
    let result = null;
    for (const intervals of [4, 3, 2, 1]) {
        const step = niceNumber(span / intervals, true);
        const niceMin = Math.floor(min / step) * step;
        const niceMax = Math.ceil(max / step) * step;
        const ticks = [];
        for (let v = niceMin; v <= niceMax + step / 2; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
        result = { min: niceMin, max: niceMax, ticks };
        if (ticks.length <= 6) break;
    }
    return result;
}

// Integer-only axis (Shot number, and the bar chart's Y count) -- same
// coarsening retry as niceNumberAxis, but the step is floored/rounded to a
// whole number (a "0.2 shots" tick makes no sense) and every tick is rounded.
function integerAxis(min, max) {
    if (min === max) { min -= 1; max += 1; }
    const span = niceNumber(max - min, false);
    let result = null;
    for (const intervals of [4, 3, 2, 1]) {
        const step = Math.max(1, Math.round(niceNumber(span / intervals, true)));
        const niceMin = Math.floor(min / step) * step;
        const niceMax = Math.ceil(max / step) * step;
        const ticks = [];
        for (let v = niceMin; v <= niceMax + step / 2; v += step) ticks.push(Math.round(v));
        result = { min: niceMin, max: niceMax, ticks };
        if (ticks.length <= 6) break;
    }
    return result;
}

// Date axis: "nice" rounding means nothing for a calendar date, so this just
// divides the padded range into evenly spaced ticks.
function dateAxis(min, max) {
    const TICK_COUNT = 5;
    if (min === max) { min -= MS_PER_DAY; max += MS_PER_DAY; }
    const step = (max - min) / (TICK_COUNT - 1);
    const ticks = Array.from({ length: TICK_COUNT }, (_, i) => min + step * i);
    return { min, max, ticks };
}

// Pads the raw data span ~5% on each side (never anchored to zero -- a
// cluster of 1:1.7-ish shots should fill the box, not sit near one edge of a
// 0..40 axis) and rounds out to axis bounds/ticks. `key` picks the rounding
// strategy: calendar dates, whole-number-only (shot number), or "nice" decimals.
function computeAxisDomain(values, key) {
    const isDate = key === 'date';
    const rawMin = Math.min(...values);
    const rawMax = Math.max(...values);
    const pad = rawMin === rawMax
        ? (isDate ? MS_PER_DAY : (Math.abs(rawMin) * 0.05 || 1))
        : (rawMax - rawMin) * 0.05;
    // Every plotted variable is non-negative, so padding must not push the
    // axis below zero -- a 0 s shot otherwise produced a -50 s tick.
    const min = rawMin >= 0 ? Math.max(0, rawMin - pad) : rawMin - pad;
    const max = rawMax + pad;
    if (isDate) return dateAxis(min, max);
    return niceNumberAxis(min, max);
}

function formatTickLabel(value, isDate) {
    if (isDate) return new Date(value).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
    return Number(value.toFixed(2)).toString(); // ticks are already "nice"; this just drops float noise
}

function axisTitle(variable) {
    const label = getTranslation(variable.label);
    return variable.unit ? `${label} (${variable.unit})` : label;
}

// Clips the ray y = k*x (k>0, x,y>=0) to the visible [xMin,xMax]x[yMin,yMax]
// box, returning the visible segment's endpoints or null if the line never
// crosses the box at all. Domains are no longer anchored at the origin (see
// computeAxisDomain), so a ratio line frequently doesn't reach x=0,y=0
// on-screen -- only whatever portion actually falls inside the box is drawn.
function clipRatioLine(k, xMin, xMax, yMin, yMax) {
    let x0 = xMin, y0 = k * xMin;
    let x1 = xMax, y1 = k * xMax;
    if (y0 < yMin) { x0 = yMin / k; y0 = yMin; } else if (y0 > yMax) { x0 = yMax / k; y0 = yMax; }
    if (y1 < yMin) { x1 = yMin / k; y1 = yMin; } else if (y1 > yMax) { x1 = yMax / k; y1 = yMax; }
    const EPS = 1e-9;
    if (x0 > x1 + EPS || x0 < xMin - EPS || x0 > xMax + EPS || x1 < xMin - EPS || x1 > xMax + EPS) return null;
    return { x0, y0, x1, y1 };
}

// Picks up to `maxTicks` evenly spaced indices into a 0..count-1 range
// (always including the first and last) -- used for the bar chart's X date
// labels, since one label per bar would overlap once there are more than a
// handful of days.
function pickTickIndices(count, maxTicks = 6) {
    if (count <= maxTicks) return Array.from({ length: count }, (_, i) => i);
    const step = (count - 1) / (maxTicks - 1);
    const indices = new Set();
    for (let i = 0; i < maxTicks; i++) indices.add(Math.round(i * step));
    return [...indices].sort((a, b) => a - b);
}

// --- Tap-to-select callout -------------------------------------------------

function svgPointToContainerPixels(svg, container, svgX, svgY) {
    const pt = svg.createSVGPoint();
    pt.x = svgX;
    pt.y = svgY;
    const screenPt = pt.matrixTransform(svg.getScreenCTM());
    const containerRect = container.getBoundingClientRect();
    return { x: screenPt.x - containerRect.left, y: screenPt.y - containerRect.top };
}

// Anchors the callout near (anchorX, anchorY) -- default above-right of the
// point -- then flips to the left/below and finally hard-clamps so it can
// never sit outside the plot area regardless of where the tap landed.
function positionCallout(calloutEl, container, anchorX, anchorY) {
    const containerRect = container.getBoundingClientRect();
    const calloutRect = calloutEl.getBoundingClientRect();
    const OFFSET = 16;

    let left = anchorX + OFFSET;
    if (left + calloutRect.width > containerRect.width) left = anchorX - calloutRect.width - OFFSET;

    let top = anchorY - calloutRect.height - OFFSET;
    if (top < 0) top = anchorY + OFFSET;

    left = Math.max(0, Math.min(left, containerRect.width - calloutRect.width));
    top = Math.max(0, Math.min(top, containerRect.height - calloutRect.height));

    calloutEl.style.left = `${left}px`;
    calloutEl.style.top = `${top}px`;
}

function renderCalloutBody(callout, { lines, notes }) {
    callout.innerHTML = '';
    for (const line of lines) {
        const el = document.createElement('div');
        el.className = line.className;
        el.textContent = line.text;
        callout.appendChild(el);
    }
    if (notes) {
        const notesEl = document.createElement('div');
        notesEl.className = 'so-callout-notes';
        notesEl.textContent = notes;
        callout.appendChild(notesEl);
    }
}

function showCallout(content, anchorSvgX, anchorSvgY) {
    const callout = document.getElementById('shot-overview-callout');
    const svg = document.getElementById('shot-overview-plot');
    const wrap = document.getElementById('shot-overview-plot-wrap');
    if (!callout || !svg || !wrap) return;

    renderCalloutBody(callout, content);
    callout.classList.remove('hidden');
    const anchor = svgPointToContainerPixels(svg, wrap, anchorSvgX, anchorSvgY);
    positionCallout(callout, wrap, anchor.x, anchor.y);
}

// Ring/callout are the only selection state -- nothing to reset beyond the
// DOM, so this alone satisfies "only one open at a time".
function closeCallout() {
    document.getElementById('shot-overview-plot')?.querySelector('.so-selection-ring')?.remove();
    document.getElementById('shot-overview-callout')?.classList.add('hidden');
}

// Dot-plot callout content: date+time, profile, bean, dose/yield/ratio/time,
// rating/TDS/EY, grind, then the full espresso notes -- each line omitted
// when missing.
function formatShotCalloutContent(shot) {
    const a = shotAnnotation(shot);
    const lines = [];

    if (a.date) {
        const dateStr = a.date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
        const timeStr = a.date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
        lines.push({ text: `${dateStr}, ${timeStr}`, className: 'so-callout-title' });
    }
    if (a.profileTitle) lines.push({ text: a.profileTitle, className: 'so-callout-line' });
    if (a.beanName) {
        const bean = a.beanRoaster ? `${a.beanName}, ${a.beanRoaster}` : a.beanName;
        lines.push({ text: bean, className: 'so-callout-line' });
    }

    const brew = [];
    if (a.dose != null && a.yield != null) brew.push(`${a.dose.toFixed(1)} g → ${a.yield.toFixed(1)} g`);
    else if (a.dose != null) brew.push(`${a.dose.toFixed(1)} g`);
    else if (a.yield != null) brew.push(`${a.yield.toFixed(1)} g`);
    if (a.ratio != null) brew.push(`1 : ${a.ratio.toFixed(1)}`);
    if (a.duration != null) brew.push(`${Math.round(a.duration)} s`);
    if (brew.length) lines.push({ text: brew.join(', '), className: 'so-callout-line' });

    const quality = [];
    if (a.rating != null) quality.push(`${getTranslation('Rating')} ${a.rating}`);
    if (a.tds != null) quality.push(`TDS ${a.tds.toFixed(1)}%`);
    if (a.ey != null) quality.push(`EY ${a.ey.toFixed(1)}%`);
    if (quality.length) lines.push({ text: quality.join(', '), className: 'so-callout-line' });

    if (a.grind != null) lines.push({ text: `${getTranslation('Grind')} ${a.grind}`, className: 'so-callout-line' });

    return { lines, notes: a.notes };
}

function selectShot(rawShotId) {
    const point = currentPlotPoints.find((p) => String(p.shotId) === String(rawShotId));
    const shot = point && currentShotById.get(point.shotId);
    if (!point || !shot) { closeCallout(); return; }

    const svg = document.getElementById('shot-overview-plot');
    svg?.querySelector('.so-selection-ring')?.remove();
    svg?.appendChild(svgEl('circle', {
        cx: point.px, cy: point.py, r: 13,
        style: 'fill:none;stroke:var(--accent-text);stroke-width:2.5',
        class: 'so-selection-ring', 'pointer-events': 'none',
    }));

    showCallout(formatShotCalloutContent(shot), point.px, point.py);
}

// Day-bar callout content: "Sep 18" + shot count, then up to
// MAX_DAY_CALLOUT_SHOTS "08:42  Profile, bean" lines (newest first), "+N more".
function formatDayCalloutContent(bucket) {
    const fmt = (key) => new Date(`${key}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    // Weekly / 30-day bars (bucketDays) name their whole span.
    const title = bucket.endDate && bucket.endDate !== bucket.date ? `${fmt(bucket.date)} – ${fmt(bucket.endDate)}` : fmt(bucket.date);
    const lines = [
        { text: title, className: 'so-callout-title' },
        { text: shotCountLabel(bucket.count), className: 'so-callout-line' },
    ];

    const dayShots = bucket.shotIds
        .map((id) => currentShotById.get(id))
        .filter(Boolean)
        .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));

    dayShots.slice(0, MAX_DAY_CALLOUT_SHOTS).forEach((shot) => {
        const a = shotAnnotation(shot);
        const time = a.date ? a.date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : '';
        const desc = [a.profileTitle, a.beanName].filter(Boolean).join(', ');
        lines.push({ text: desc ? `${time}  ${desc}` : time, className: 'so-callout-line' });
    });
    if (dayShots.length > MAX_DAY_CALLOUT_SHOTS) {
        lines.push({ text: `+${dayShots.length - MAX_DAY_CALLOUT_SHOTS} ${getTranslation('more')}`, className: 'so-callout-line' });
    }
    return { lines, notes: null };
}

function selectDay(dayKey) {
    const bucket = currentDayBuckets.find((d) => d.date === dayKey);
    if (!bucket || bucket.count === 0) { closeCallout(); return; } // "zero days show nothing on tap"

    const svg = document.getElementById('shot-overview-plot');
    svg?.querySelector('.so-selection-ring')?.remove();
    svg?.appendChild(svgEl('rect', {
        x: bucket.barX - 3, y: bucket.barY - 3, width: bucket.barW + 6, height: bucket.barH + 6,
        style: 'fill:none;stroke:var(--accent-text);stroke-width:2.5',
        class: 'so-selection-ring', 'pointer-events': 'none',
    }));

    showCallout(formatDayCalloutContent(bucket), bucket.barX + bucket.barW / 2, bucket.barY);
}

// Installed once (the <svg>/callout elements are static markup, never
// replaced -- only their children are rebuilt on every render) rather than
// per-render, so taps keep working without re-attaching listeners each time.
function setupPlotInteraction() {
    const svg = document.getElementById('shot-overview-plot');
    const callout = document.getElementById('shot-overview-callout');
    if (!svg || !callout) return;

    svg.addEventListener('click', (e) => {
        const shotId = e.target.getAttribute?.('data-shot-id');
        if (shotId != null) { selectShot(shotId); return; }
        const dayKey = e.target.getAttribute?.('data-day-key');
        if (dayKey != null) { selectDay(dayKey); return; }
        closeCallout(); // tapped empty plot area
    });
    callout.addEventListener('click', () => closeCallout());
}

// --- Plot rendering ---------------------------------------------------------

const PLOT_W = 1000, PLOT_H = 600;
const PLOT_PAD_L = 90, PLOT_PAD_R = 40, PLOT_PAD_T = 30, PLOT_PAD_B = 70;

function plotInnerSize() {
    return { w: PLOT_W - PLOT_PAD_L - PLOT_PAD_R, h: PLOT_H - PLOT_PAD_T - PLOT_PAD_B };
}

// Scatter/dot plot for a numeric X/Y pair (everything except the
// 'shotsPerDay' bar-chart mode below).
function renderScatterPlot(shots, svg, emptyEl, captionEl) {
    const xVar = AXIS_VARIABLES_BY_KEY[currentAxes.x];
    const yVar = AXIS_VARIABLES_BY_KEY[currentAxes.y];
    // Defensive: resolveAxisSelection() should always leave currentAxes on
    // real, currently-offered keys, so this shouldn't be reachable -- but
    // xVar/yVar being undefined would otherwise throw out of an event
    // handler (dispatchEvent swallows it, so the plot would silently go
    // stale with no visible error). Fail into the same empty state instead.
    if (!xVar || !yVar) {
        svg.classList.add('hidden');
        captionEl.classList.add('hidden');
        emptyEl.classList.remove('hidden');
        emptyEl.textContent = '';
        currentPlotPoints = [];
        return;
    }
    const points = computeAxisPoints(shots, currentAxes.x, currentAxes.y);

    if (points.length < 2) {
        svg.classList.add('hidden');
        captionEl.classList.add('hidden');
        emptyEl.classList.remove('hidden');
        emptyEl.textContent = `${getTranslation('Not enough shots with')} ${getTranslation(xVar.label)} `
            + `${getTranslation('and')} ${getTranslation(yVar.label)} ${getTranslation('to plot.')}`;
        currentPlotPoints = [];
        return;
    }

    svg.classList.remove('hidden');
    captionEl.classList.remove('hidden');
    emptyEl.classList.add('hidden');
    while (svg.firstChild) svg.removeChild(svg.firstChild);

    const { w: plotW, h: plotH } = plotInnerSize();
    const xIsDate = currentAxes.x === 'date';
    const yIsDate = currentAxes.y === 'date';
    const xDomain = computeAxisDomain(points.map((p) => p.x), currentAxes.x);
    const yDomain = computeAxisDomain(points.map((p) => p.y), currentAxes.y);

    const xScale = (v) => PLOT_PAD_L + ((v - xDomain.min) / (xDomain.max - xDomain.min)) * plotW;
    const yScale = (v) => PLOT_PAD_T + plotH - ((v - yDomain.min) / (yDomain.max - yDomain.min)) * plotH;

    for (const t of xDomain.ticks) {
        const gx = xScale(t);
        svg.appendChild(svgEl('line', { x1: gx, y1: PLOT_PAD_T, x2: gx, y2: PLOT_PAD_T + plotH, stroke: 'var(--border-color)', 'stroke-width': 1 }));
        const label = svgEl('text', { x: gx, y: PLOT_PAD_T + plotH + 26, 'font-size': 20, fill: 'var(--data-card-title-text-color)', 'text-anchor': 'middle' });
        label.textContent = formatTickLabel(t, xIsDate);
        svg.appendChild(label);
    }
    for (const t of yDomain.ticks) {
        const gy = yScale(t);
        svg.appendChild(svgEl('line', { x1: PLOT_PAD_L, y1: gy, x2: PLOT_PAD_L + plotW, y2: gy, stroke: 'var(--border-color)', 'stroke-width': 1 }));
        const label = svgEl('text', { x: PLOT_PAD_L - 12, y: gy + 6, 'font-size': 20, fill: 'var(--data-card-title-text-color)', 'text-anchor': 'end' });
        label.textContent = formatTickLabel(t, yIsDate);
        svg.appendChild(label);
    }

    const xTitle = svgEl('text', {
        x: PLOT_PAD_L + plotW / 2, y: PLOT_H - 14, 'font-size': 20,
        fill: 'var(--data-card-title-text-color)', 'text-anchor': 'middle',
    });
    xTitle.textContent = axisTitle(xVar);
    svg.appendChild(xTitle);

    const yTitleY = PLOT_PAD_T + plotH / 2;
    const yTitle = svgEl('text', {
        x: 20, y: yTitleY, 'font-size': 20, fill: 'var(--data-card-title-text-color)',
        'text-anchor': 'middle', transform: `rotate(-90 20 ${yTitleY})`,
    });
    yTitle.textContent = axisTitle(yVar);
    svg.appendChild(yTitle);

    // Ratio guide lines -- only for the original Dose/Yield pairing.
    const showGuides = currentAxes.x === 'dose' && currentAxes.y === 'yield';
    if (showGuides) {
        [1, 2, 3].forEach((k) => {
            const seg = clipRatioLine(k, xDomain.min, xDomain.max, yDomain.min, yDomain.max);
            if (!seg) return;
            svg.appendChild(svgEl('line', {
                x1: xScale(seg.x0), y1: yScale(seg.y0), x2: xScale(seg.x1), y2: yScale(seg.y1),
                stroke: 'var(--border-color)', 'stroke-width': 2,
            }));
            const label = svgEl('text', {
                x: xScale(seg.x1) + 8, y: yScale(seg.y1) - 6,
                'font-size': 18, fill: 'var(--data-card-title-text-color)',
            });
            label.textContent = `1:${k}`;
            svg.appendChild(label);
        });
    }

    // points[] follows `shots`' order (newest-first); the first N that have
    // both axis values get full opacity so recent pulls stand out.
    currentPlotPoints = points.map((p, i) => ({
        ...p,
        px: xScale(p.x),
        py: yScale(p.y),
        opacity: i < NEWEST_FULL_OPACITY_COUNT ? 1 : 0.45,
    }));

    for (const p of currentPlotPoints) {
        svg.appendChild(svgEl('circle', {
            cx: p.px, cy: p.py, r: 7,
            style: 'fill:var(--accent-text)',
            'fill-opacity': p.opacity,
        }));
    }
    // Hit circles drawn AFTER dots so they sit on top and reliably catch taps
    // across the full ~28px target, not just the painted 7px dot.
    for (const p of currentPlotPoints) {
        if (p.shotId == null) continue;
        svg.appendChild(svgEl('circle', {
            cx: p.px, cy: p.py, r: 28,
            fill: 'transparent', 'pointer-events': 'all',
            'data-shot-id': String(p.shotId),
        }));
    }

    captionEl.textContent = showGuides
        ? getTranslation('Each dot is a shot. Lines mark 1:1, 1:2 and 1:3 ratios.')
        : getTranslation('Each dot is a shot.');
}

// Bar chart for the 'shotsPerDay' Y mode: one bar per LOCAL calendar day
// (shotsPerDay() already fills zero-count gaps), X fixed to Date. Y starts
// at 0 with integer-only ticks; no ratio guides (that's a Dose/Yield-only
// scatter concept and doesn't apply here).
const BUCKET_LABELS = {
    1: { y: 'Shots per day', caption: 'Each bar is a day.' },
    7: { y: 'Shots per week', caption: 'Each bar is a week.' },
    30: { y: 'Shots per 30 days', caption: 'Each bar is 30 days.' },
};

function renderBarChart(shots, svg, emptyEl, captionEl) {
    svg.classList.remove('hidden');
    captionEl.classList.remove('hidden');
    emptyEl.classList.add('hidden');
    while (svg.firstChild) svg.removeChild(svg.firstChild);

    // Long ranges coarsen to weekly / 30-day bars (bucketDays) so bars stay
    // readable and each tap target is a real slot, not a ~1px sliver.
    const { size: bucketSize, buckets: days } = bucketDays(shotsPerDay(shots));
    currentDayBuckets = [];
    currentPlotPoints = [];
    if (days.length === 0) return; // unreachable in practice: renderForRange already guards shots.length>0

    const { w: plotW, h: plotH } = plotInnerSize();
    const maxCount = Math.max(1, ...days.map((d) => d.count));
    const yDomain = integerAxis(0, maxCount * 1.15);
    const yScale = (v) => PLOT_PAD_T + plotH - (v / yDomain.max) * plotH;

    const dayCount = days.length;
    const slotWidth = plotW / dayCount;
    const barGap = Math.min(slotWidth * 0.3, Math.max(2, slotWidth * 0.15));
    const barWidth = Math.max(1, slotWidth - barGap);

    for (const t of yDomain.ticks) {
        const gy = yScale(t);
        svg.appendChild(svgEl('line', { x1: PLOT_PAD_L, y1: gy, x2: PLOT_PAD_L + plotW, y2: gy, stroke: 'var(--border-color)', 'stroke-width': 1 }));
        const label = svgEl('text', { x: PLOT_PAD_L - 12, y: gy + 6, 'font-size': 20, fill: 'var(--data-card-title-text-color)', 'text-anchor': 'end' });
        label.textContent = String(Math.round(t));
        svg.appendChild(label);
    }

    for (const i of pickTickIndices(dayCount)) {
        const gx = PLOT_PAD_L + i * slotWidth + slotWidth / 2;
        const label = svgEl('text', { x: gx, y: PLOT_PAD_T + plotH + 26, 'font-size': 20, fill: 'var(--data-card-title-text-color)', 'text-anchor': 'middle' });
        label.textContent = formatTickLabel(Date.parse(`${days[i].date}T00:00:00`), true);
        svg.appendChild(label);
    }

    const xTitle = svgEl('text', {
        x: PLOT_PAD_L + plotW / 2, y: PLOT_H - 14, 'font-size': 20,
        fill: 'var(--data-card-title-text-color)', 'text-anchor': 'middle',
    });
    xTitle.textContent = axisTitle(AXIS_VARIABLES_BY_KEY.date);
    svg.appendChild(xTitle);

    const yTitleY = PLOT_PAD_T + plotH / 2;
    const yTitle = svgEl('text', {
        x: 20, y: yTitleY, 'font-size': 20, fill: 'var(--data-card-title-text-color)',
        'text-anchor': 'middle', transform: `rotate(-90 20 ${yTitleY})`,
    });
    yTitle.textContent = getTranslation(BUCKET_LABELS[bucketSize].y);
    svg.appendChild(yTitle);

    days.forEach((day, i) => {
        const barY = yScale(day.count);
        const barH = (PLOT_PAD_T + plotH) - barY;
        const barX = PLOT_PAD_L + i * slotWidth + (slotWidth - barWidth) / 2;

        if (day.count > 0) {
            svg.appendChild(svgEl('rect', { x: barX, y: barY, width: barWidth, height: barH, fill: 'var(--accent-text)' }));
        }
        currentDayBuckets.push({ ...day, barX, barY, barW: barWidth, barH });

        // Full day-slot hit target (not just the bar), drawn on top -- short
        // bars and zero-count gaps are just as easy to tap as a tall bar.
        svg.appendChild(svgEl('rect', {
            x: PLOT_PAD_L + i * slotWidth, y: PLOT_PAD_T, width: slotWidth, height: plotH,
            fill: 'transparent', 'pointer-events': 'all', 'data-day-key': day.date,
        }));
    });

    captionEl.textContent = getTranslation(BUCKET_LABELS[bucketSize].caption);
}

// Inline SVG plot for whatever pair of variables is currently selected.
// Not Plotly -- #plotly-chart is shared with the main page/profile selector
// (see CLAUDE.md), and this plot needs to sit permanently on this page.
function renderPlotArea(shots) {
    closeCallout();
    currentShotById = new Map(shots.map((s) => [s.id, s]));

    const svg = document.getElementById('shot-overview-plot');
    const emptyEl = document.getElementById('shot-overview-plot-empty');
    const captionEl = document.getElementById('shot-overview-plot-caption');
    if (!svg || !emptyEl || !captionEl) return;

    if (currentAxes.y === 'shotsPerDay') {
        renderBarChart(shots, svg, emptyEl, captionEl);
        return;
    }
    renderScatterPlot(shots, svg, emptyEl, captionEl);
}

// X is fixed to Date and disabled whenever Y is the day-bar mode (X has no
// meaning there -- every bar already IS one day); re-enabling it afterwards
// leaves X on Date rather than resetting to something else ("keep Date").
function updateXAxisAvailability() {
    const xSelect = document.getElementById('shot-overview-x-axis');
    if (!xSelect) return;
    const locked = currentAxes.y === 'shotsPerDay';
    if (locked && currentAxes.x !== 'date') currentAxes.x = 'date';
    xSelect.disabled = locked;
    xSelect.value = currentAxes.x;
}

function populateAxisSelects(available) {
    const xSelect = document.getElementById('shot-overview-x-axis');
    const ySelect = document.getElementById('shot-overview-y-axis');
    if (!xSelect || !ySelect) return;

    xSelect.innerHTML = '';
    for (const key of available) {
        const variable = AXIS_VARIABLES_BY_KEY[key];
        const opt = document.createElement('option');
        opt.value = variable.key;
        opt.textContent = getTranslation(variable.label);
        xSelect.appendChild(opt);
    }

    // 'Shots per day' is Y-only (a per-day aggregate, not a per-shot value --
    // see the module header comment) and always offered once there's at
    // least one shot in range, so it isn't drawn from `available`.
    ySelect.innerHTML = '';
    const yVariables = [SHOTS_PER_DAY_VARIABLE, ...available.map((key) => AXIS_VARIABLES_BY_KEY[key])];
    for (const variable of yVariables) {
        const opt = document.createElement('option');
        opt.value = variable.key;
        opt.textContent = getTranslation(variable.label);
        ySelect.appendChild(opt);
    }

    xSelect.value = currentAxes.x;
    ySelect.value = currentAxes.y;
    updateXAxisAvailability();
}

function setupAxisControls() {
    const xSelect = document.getElementById('shot-overview-x-axis');
    const ySelect = document.getElementById('shot-overview-y-axis');
    if (!xSelect || !ySelect) return;
    const onChange = () => {
        // X === Y is allowed (plan: "just a diagonal") -- no validation here.
        currentAxes = { x: xSelect.value, y: ySelect.value };
        updateXAxisAvailability();
        renderPlotArea(currentFilteredShots);
    };
    xSelect.addEventListener('change', onChange);
    ySelect.addEventListener('change', onChange);
}

function listItem(rows) {
    const el = document.createElement('div');
    el.className = 'so-list-item';
    for (const row of rows) el.appendChild(row);
    return el;
}

function primaryRow(nameText, figures) {
    const row = document.createElement('div');
    row.className = 'so-row-primary';
    const name = document.createElement('span');
    name.className = 'so-row-name';
    name.textContent = nameText;
    row.appendChild(name);
    for (const fig of figures) {
        const span = document.createElement('span');
        span.className = 'so-row-figure';
        span.textContent = fig;
        row.appendChild(span);
    }
    return row;
}

function metaRow(text) {
    const row = document.createElement('div');
    row.className = 'so-row-meta';
    row.textContent = text;
    return row;
}

// Shared bar-row builder for Profiles/Beans: name on top (ellipsis if long),
// a full-width var(--border-color) track below it with a var(--accent-text)
// fill sized by `share` (0..1, from rankedBarRows -- 1 = the top entry), and
// the count labelled at the row's right end. Single-hue throughout: only the
// fill reads --accent-text, the name/count text always stays
// --text-primary/--data-card-title-text-color like the rest of the page.
function barRow(name, count, share) {
    const wrap = document.createElement('div');
    wrap.className = 'so-bar-row';

    const nameEl = document.createElement('div');
    nameEl.className = 'so-bar-row-name';
    nameEl.textContent = name;
    wrap.appendChild(nameEl);

    const line = document.createElement('div');
    line.className = 'so-bar-line';
    const track = document.createElement('div');
    track.className = 'so-bar-track';
    const fill = document.createElement('div');
    fill.className = 'so-bar-fill';
    fill.style.width = `${Math.max(0, Math.min(1, share)) * 100}%`;
    track.appendChild(fill);
    line.appendChild(track);
    const countEl = document.createElement('span');
    countEl.className = 'so-bar-count';
    countEl.textContent = shotCountLabel(count);
    line.appendChild(countEl);
    wrap.appendChild(line);

    return wrap;
}

// Grinder "dot strip": one 8px dot per shot at its recorded setting, stacked
// upward when several shots share a value (capped at DOT_STACK_CAP high --
// no "+N" count on the overflow, matching "no numbers on every point"), a
// short tick at the modal setting (its "usually X" text is in the HTML meta
// line above -- see renderGrinders), min/max tick labels
// at the ends (omitted when min === max -- a single value has no range).
// Layout, top to bottom: a 5-dot stack sitting on the axis at 56, min/max
// labels under it. The SVG scales to the column width (see .so-dotstrip).
const DOT_STRIP_W = 772, DOT_STRIP_H = 82; // keep in sync with .so-dotstrip aspect-ratio
const DOT_STRIP_PAD = 16; // keeps end dots off the strip edge; min/max labels still align to it
const DOT_STRIP_AXIS_Y = 56; // room above for a 5-dot stack (top dot ~y 12)
const DOT_STACK_CAP = 5;
const DOT_PITCH = 10;

function renderGrinderDotStrip(grinder) {
    const svg = svgEl('svg', {
        viewBox: `0 0 ${DOT_STRIP_W} ${DOT_STRIP_H}`, class: 'so-dotstrip',
        role: 'img', 'aria-label': 'Grind setting distribution',
    });
    const { min, max, usualSetting, settingCounts } = grinder;
    if (min == null || max == null || settingCounts.length === 0) return svg; // no numeric settings ever recorded

    const usableWidth = DOT_STRIP_W - DOT_STRIP_PAD * 2;
    const single = min === max;
    const xScale = (v) => (single
        ? DOT_STRIP_PAD + usableWidth / 2
        : DOT_STRIP_PAD + ((v - min) / (max - min)) * usableWidth);

    svg.appendChild(svgEl('line', {
        x1: DOT_STRIP_PAD, y1: DOT_STRIP_AXIS_Y, x2: DOT_STRIP_W - DOT_STRIP_PAD, y2: DOT_STRIP_AXIS_Y,
        stroke: 'var(--border-color)', 'stroke-width': 1,
    }));

    for (const { value, count } of settingCounts) {
        const cx = xScale(value);
        const stack = Math.min(count, DOT_STACK_CAP);
        for (let i = 0; i < stack; i++) {
            svg.appendChild(svgEl('circle', {
                cx, cy: DOT_STRIP_AXIS_Y - 6 - i * DOT_PITCH, r: 4, fill: 'var(--accent-text)',
            }));
        }
    }

    if (usualSetting != null) {
        const ux = xScale(usualSetting);
        // Tick only -- the "usually X" text lives in the HTML meta line above
        // (renderGrinders). As SVG text it kept clipping against the strip's
        // top and side edges however it was nudged.
        svg.appendChild(svgEl('line', {
            x1: ux, y1: DOT_STRIP_AXIS_Y, x2: ux, y2: 6, // stops at the axis: a stub below it ran through the min/max label
            stroke: 'var(--accent-text)', 'stroke-width': 1.5,
        }));
    }

    if (!single) {
        const minLabel = svgEl('text', {
            x: DOT_STRIP_PAD, y: DOT_STRIP_AXIS_Y + 22, 'font-size': 20,
            fill: 'var(--data-card-title-text-color)', 'text-anchor': 'start',
        });
        minLabel.textContent = String(min);
        svg.appendChild(minLabel);
        const maxLabel = svgEl('text', {
            x: DOT_STRIP_W - DOT_STRIP_PAD, y: DOT_STRIP_AXIS_Y + 22, 'font-size': 20,
            fill: 'var(--data-card-title-text-color)', 'text-anchor': 'end',
        });
        maxLabel.textContent = String(max);
        svg.appendChild(maxLabel);
    }

    return svg;
}

// Bar-row name on top, track+fill+count below (barRow()); roaster/last-date/
// usual-grind stays as the muted meta line under the bar, comma-joined, each
// part omitted when missing. Every bean gets a row -- unlike Profiles, this
// list was never capped, so rankedBarRows() here (no limit) never produces
// an "Other" bucket.
function renderBeans(beans) {
    const section = document.getElementById('shot-overview-beans-section');
    const list = document.getElementById('shot-overview-beans-list');
    if (!section || !list) return;
    section.classList.toggle('hidden', beans.length === 0);
    if (beans.length === 0) return;

    list.innerHTML = '';
    const { top } = rankedBarRows(beans);
    for (const bean of top) {
        const metaParts = [];
        if (bean.roaster) metaParts.push(bean.roaster);
        metaParts.push(`${getTranslation('last')} ${formatDate(bean.lastDate)}`);
        if (bean.usualGrind != null) metaParts.push(`${getTranslation('grind')} ${bean.usualGrind}`);
        list.appendChild(listItem([
            barRow(bean.name, bean.count, bean.share),
            metaRow(metaParts.join(', ')),
        ]));
    }
}

// Model + shot-count header row (unchanged shape), then a dot-strip
// visualizing the grind-setting distribution in place of the old
// "usually X, range Y-Z" text line.
function renderGrinders(grinders) {
    const section = document.getElementById('shot-overview-grinders-section');
    const list = document.getElementById('shot-overview-grinders-list');
    if (!section || !list) return;
    section.classList.toggle('hidden', grinders.length === 0);
    if (grinders.length === 0) return;

    list.innerHTML = '';
    for (const g of grinders) {
        const rows = [primaryRow(g.model, [shotCountLabel(g.count)])];
        // Shots without a recorded setting have no dot, so "9 shots" over a
        // single dot read as a broken stack. Say how many the strip covers.
        const withSetting = g.settingCounts.reduce((n, s) => n + s.count, 0);
        // "usually X" names the strip's tick; it's HTML here rather than SVG
        // text in the strip so it can never clip (see renderGrinderDotStrip).
        const parts = [];
        if (g.usualSetting != null) parts.push(`${getTranslation('usually')} ${g.usualSetting}`);
        if (withSetting === 0) parts.push(getTranslation('No grind setting recorded'));
        else if (withSetting < g.count) {
            parts.push(`${getTranslation('grind setting on')} ${withSetting} ${getTranslation('of')} ${shotCountLabel(g.count)}`);
        }
        if (parts.length) {
            const note = document.createElement('div');
            note.className = 'so-row-meta';
            note.textContent = parts.join(', ');
            rows.push(note);
        }
        if (withSetting > 0) rows.push(renderGrinderDotStrip(g));
        list.appendChild(listItem(rows));
    }
}

// Ranked bar chart, not a pie: close counts (3/3/2) are unreadable as slices.
// Top 5 profiles, then one "Other" row summing the rest when there is any.
function renderProfiles(profiles) {
    const section = document.getElementById('shot-overview-profiles-section');
    const list = document.getElementById('shot-overview-profiles-list');
    if (!section || !list) return;
    section.classList.toggle('hidden', profiles.length === 0);
    if (profiles.length === 0) return;

    list.innerHTML = '';
    const { top, other } = rankedBarRows(profiles, 5);
    for (const p of top) {
        list.appendChild(listItem([barRow(p.title, p.count, p.share)]));
    }
    if (other) {
        list.appendChild(listItem([barRow(getTranslation('Other'), other.count, other.share)]));
    }
}

function renderSteam(steam) {
    const section = document.getElementById('shot-overview-steam-section');
    const valueEl = document.getElementById('shot-overview-steam-value');
    if (!section || !valueEl) return;
    section.classList.toggle('hidden', steam === null);
    if (steam === null) return;

    const parts = [];
    if (steam.targetTemperature != null) parts.push(formatTemp(steam.targetTemperature, 0));
    if (steam.flow != null) parts.push(`${steam.flow} mL/s`);
    if (steam.duration != null) parts.push(`${steam.duration} s`);
    valueEl.textContent = parts.join(', ');
}

// Sections are hidden with the `.hidden` class rather than removed, so a
// plain CSS :first-child can't tell which one is first among the *visible*
// ones -- do that bit in JS instead, after every section has decided whether
// it has data to show.
function updateSectionSeparators() {
    const sections = document.querySelectorAll('#shot-overview-right .so-section');
    let foundFirst = false;
    sections.forEach((section) => {
        const visible = !section.classList.contains('hidden');
        section.classList.toggle('so-section-first', visible && !foundFirst);
        if (visible) foundFirst = true;
    });
}

// Stats-row/plot/right-column visibility, independent of the overall page
// state -- used to hide everything but the summary+range control when the
// *selected range* has no shots (there ARE shots, just not in that window;
// the global "No shots yet" empty state is a different, earlier-checked case).
// This is a different, coarser thing than the plot's own "not enough shots
// for THIS axis pair" state inside renderPlotArea() -- that one only hides
// the plot box, since the stats row/right column can still have data even
// when the chosen axis pair doesn't.
function setDataSectionsVisible(visible) {
    document.getElementById('shot-overview-stats')?.classList.toggle('hidden', !visible);
    document.getElementById('shot-overview-plot-section')?.classList.toggle('hidden', !visible);
    document.getElementById('shot-overview-right')?.classList.toggle('hidden', !visible);
}

function updateRangeButtons() {
    document.querySelectorAll('#shot-overview-range .so-range-btn').forEach((btn) => {
        const selected = btn.dataset.range === currentRange;
        btn.setAttribute('aria-pressed', String(selected));
        btn.classList.remove(...RANGE_SELECTED_CLASSES, ...RANGE_UNSELECTED_CLASSES);
        btn.classList.add(...(selected ? RANGE_SELECTED_CLASSES : RANGE_UNSELECTED_CLASSES));
    });
}

function setupRangeControl() {
    const group = document.getElementById('shot-overview-range');
    if (!group) return;
    group.querySelectorAll('.so-range-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
            const range = btn.dataset.range;
            if (!VALID_RANGES.includes(range) || range === currentRange) return;
            currentRange = range;
            saveRangePreference(range);
            renderForRange();
        });
    });
}

// Filters fullShotList by the currently selected range and renders. Called
// on initial load, on every range-button tap, and again whenever the
// background duration fetch updates fullShotList -- so a fetch that lands
// while "7 days" is selected still shows up immediately.
function renderForRange() {
    showState('content');
    updateRangeButtons();

    const filtered = filterShotsByDays(fullShotList, RANGE_DAYS[currentRange]);
    const summaryEl = document.getElementById('shot-overview-summary');

    if (filtered.length === 0) {
        // Only reachable for 7/30 days -- fullShotList is never empty here
        // (that's the global empty state, checked before this ever runs).
        const dayKey = currentRange === '7' ? 7 : 30;
        summaryEl.textContent = getTranslation(`No shots in the last ${dayKey} days.`);
        setDataSectionsVisible(false);
        return;
    }

    const stats = computeShotStats(filtered);
    summaryEl.textContent = buildSummaryText(stats, currentRange);
    setDataSectionsVisible(true);
    renderStatsRow(stats, filtered);
    renderBeans(stats.beans);
    renderGrinders(stats.grinders);
    renderProfiles(stats.profiles);
    renderSteam(stats.steam);
    updateSectionSeparators();

    // The range filter can remove a variable's only data (e.g. no TDS shot
    // in the last 7 days) -- rebuild the option lists and re-resolve the
    // selection every time, not just at boot. Only reachable from a direct
    // user action (initial load or a range-pill tap, both below) -- see the
    // BUG note on refreshAfterEnrichment() for why that matters.
    currentFilteredShots = filtered;
    const available = availableAxisKeys(filtered);
    currentAxes = resolveAxisSelection(available, currentAxes);
    populateAxisSelects(available);
    renderPlotArea(filtered);
}

// BUG (user-reported): the plot "jumped back to Shots per day" while picking
// X/Y. Root cause: the background duration-fetch's .then() used to call the
// full renderForRange(), which -- via populateAxisSelects() -- clears and
// rebuilds BOTH <select>'s <option> lists and then reassigns their .value
// from scratch, unconditionally, on every call. That fetch resolves on its
// own schedule (a few hundred ms to a couple of seconds after boot, see
// fetchDurationSample's own comment) -- often exactly while a user is
// mid-interaction with the axis pickers moments after opening the page. On
// a real touch device a live-select's underlying <option> nodes being torn
// out and replaced while the native picker is open (or the instant after a
// tap, before its 'change' event is fully processed) drops the in-flight
// selection; the rebuild's own `select.value = currentAxes.x/y` then leaves
// the control (and the plot) showing whatever DEFAULT_AXES/currentAxes was
// at that moment -- 'shotsPerDay' if the user's very first pick raced it.
//
// Fix: duration enrichment only ever adds `measurements` (and so `time`/
// duration averages) to shots that already existed -- it can't change which
// axis *should* be selected, so it must not touch the axis <select> DOM or
// re-resolve currentAxes at all. It only refreshes what actually depends on
// the new data: the stats row (Time average/sample-size) and the current
// plot's points (in case Time is what's plotted). Axis *options* still get
// recomputed on the next real user action (a range-pill tap -> renderForRange()
// above), matching the rule that only the user changes the axis selection.
function refreshAfterEnrichment(filtered) {
    currentFilteredShots = filtered;
    renderStatsRow(computeShotStats(filtered), filtered);
    renderPlotArea(filtered);
}

// Bumped on every page entry. State here is module-level and outlives the
// fragment, so an await from an earlier visit (Done tapped mid-load, page
// reopened after a new shot) could land late and overwrite the newer visit's
// fullShotList with an older list. Each continuation checks it still owns
// the page before touching state.
let visitId = 0;

export async function initializeShotOverview() {
    const visit = ++visitId;
    setDoneHandler();
    setupRangeControl();
    setupAxisControls();
    setupPlotInteraction();
    currentRange = loadRangePreference();
    // Always opens on Date / Shots per day -- no persisted axis choice.
    currentAxes = { ...DEFAULT_AXES };

    const { items, source } = await loadShotList();
    if (visit !== visitId) return;

    if (items.length === 0) {
        // Network returning a real empty list means "no shots yet"; only
        // falling all the way back to an empty cache means the load failed.
        showState(source === 'network' ? 'empty' : 'error');
        return;
    }

    const merged = await mergeCachedMeasurements(items);
    if (visit !== visitId) return;
    fullShotList = merged;
    renderForRange();

    // Duration needs full per-shot records the list endpoint doesn't carry.
    // Fetch just the newest DURATION_FETCH_COUNT that aren't already cached
    // with measurements, and refresh (through whatever range is currently
    // selected) once that lands -- the rest of the page must not wait on
    // this network round trip. Uses refreshAfterEnrichment(), not
    // renderForRange() -- see that function's BUG note.
    fetchDurationSample(fullShotList)
        .then((enriched) => {
            if (!enriched || visit !== visitId) return;
            fullShotList = enriched;
            const filtered = filterShotsByDays(fullShotList, RANGE_DAYS[currentRange]);
            if (filtered.length === 0) return; // range emptied out from under us; nothing to refresh
            refreshAfterEnrichment(filtered);
        })
        .catch((error) => logger.warn('Shot overview: duration enrichment failed:', error));
}
