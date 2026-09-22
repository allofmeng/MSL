// Pure, DOM-free aggregation over shot records for the "Shot overview"
// sub-page. Takes whatever shape the /shots list endpoint (no measurements)
// or a full /shots/{id} record (annotations, workflow.context,
// workflow.profile, workflow.steamSettings, timestamp, optionally
// measurements) gives us, and reduces it to summary numbers the page renders.
// No fetch, no DOM -- everything here is unit tested directly in
// test/shot-stats.test.mjs. Keep it that way (see CLAUDE.md's
// "Pure/DOM-free modules" list); put any DOM/network work in shot_overview.js.
//
// Field fallbacks mirror what history.js / shotSummary.js already use for the
// same records, so this page never disagrees with the main dashboard about
// what a shot's dose/yield/duration was.

const MS_PER_WEEK = 7 * 24 * 60 * 60 * 1000;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

// A shot's measurements array carries the whole prep+brew timeline; only
// these two substates are the actual pour, matching shotData.js's
// renderPastShot() (the code behind the main page's "Total time" readout).
const EXTRACTION_SUBSTATES = ['preinfusion', 'pouring'];

function finiteOrNull(v) {
    return typeof v === 'number' && isFinite(v) ? v : null;
}

function readDose(shot) {
    const ann = shot?.annotations ?? {};
    const ctx = shot?.workflow?.context ?? {};
    const doseData = shot?.workflow?.doseData ?? {};
    return finiteOrNull(ann.actualDoseWeight ?? ctx.targetDoseWeight ?? doseData.doseIn);
}

function readYield(shot) {
    const ann = shot?.annotations ?? {};
    const ctx = shot?.workflow?.context ?? {};
    return finiteOrNull(ann.actualYield ?? ctx.targetYield);
}

function readRating(shot) {
    return finiteOrNull(shot?.annotations?.enjoyment);
}

function readTds(shot) {
    return finiteOrNull(shot?.annotations?.drinkTds);
}

function readEy(shot) {
    return finiteOrNull(shot?.annotations?.drinkEy);
}

function readBean(shot) {
    const ctx = shot?.workflow?.context ?? {};
    if (!ctx.coffeeName) return null;
    return { name: ctx.coffeeName, roaster: ctx.coffeeRoaster ?? null };
}

// grinderSetting is a free-text field upstream (a plain number for most
// grinders, but some record a range like "18-20") -- parseFloat reads the
// leading number and quietly gives NaN for anything else, which we treat the
// same as "no setting recorded" rather than showing NaN downstream.
function readGrinder(shot) {
    const ctx = shot?.workflow?.context ?? {};
    if (!ctx.grinderModel) return null;
    return { model: ctx.grinderModel, setting: finiteOrNull(parseFloat(ctx.grinderSetting)) };
}

function readProfileTitle(shot) {
    return shot?.workflow?.profile?.title ?? null;
}

// Snapshot of the machine's steam setting at the time the shot was pulled --
// not a live reading, so it's fine to aggregate across shots.
function readSteam(shot) {
    const s = shot?.workflow?.steamSettings;
    if (!s) return null;
    const { targetTemperature, flow, duration } = s;
    if (targetTemperature == null && flow == null && duration == null) return null;
    return {
        targetTemperature: targetTemperature ?? null,
        flow: flow ?? null,
        duration: duration ?? null,
    };
}

// Extraction duration in seconds: last-minus-first timestamp across the
// preinfusion/pouring samples. Same definition as shotData.js's
// calculateAndRender() totalTime, so this page's average can't disagree with
// what the per-shot view already shows. Requires a full record (measurements
// array) -- list-only shots (no measurements) contribute nothing here.
function readDurationSeconds(shot) {
    const ms = shot?.measurements;
    if (!Array.isArray(ms) || ms.length === 0) return null;
    let first = null;
    let last = null;
    for (const m of ms) {
        if (!EXTRACTION_SUBSTATES.includes(m?.machine?.state?.substate)) continue;
        const t = Date.parse(m.machine.timestamp);
        if (Number.isNaN(t)) continue;
        if (first === null) first = t;
        last = t;
    }
    if (first === null || last === null || last <= first) return null;
    return (last - first) / 1000;
}

// Metadata for the "Shot overview" plot's axis picker: one entry per
// pickable variable, in the order the <select> options should list them.
// `unit` feeds the axis title (e.g. "Dose (g)"); null for unitless variables.
export const AXIS_VARIABLES = [
    { key: 'date', label: 'Date', unit: null },
    { key: 'dose', label: 'Dose', unit: 'g' },
    { key: 'yield', label: 'Yield', unit: 'g' },
    { key: 'ratio', label: 'Ratio', unit: null },
    { key: 'grind', label: 'Grind', unit: null },
    { key: 'rating', label: 'Rating', unit: null },
    { key: 'tds', label: 'TDS', unit: '%' },
    { key: 'ey', label: 'EY', unit: '%' },
    { key: 'time', label: 'Time', unit: 's' },
];

/**
 * A single shot's value for one plot axis variable, or null if that shot
 * doesn't have it. Reuses the same field-fallback readers computeShotStats
 * does, so the plot never disagrees with the averages shown above it.
 * @param {object} shot
 * @param {'date'|'dose'|'yield'|'ratio'|'grind'|'rating'|'tds'|'ey'|'time'} key
 * @returns {number|null}
 */
export function shotAxisValue(shot, key) {
    switch (key) {
        case 'date': {
            const t = Date.parse(shot?.timestamp);
            return Number.isNaN(t) ? null : t;
        }
        case 'dose':
            return readDose(shot);
        case 'yield':
            return readYield(shot);
        case 'ratio': {
            const dose = readDose(shot);
            const yld = readYield(shot);
            return dose != null && dose > 0 && yld != null && yld > 0 ? yld / dose : null;
        }
        case 'grind':
            return readGrinder(shot)?.setting ?? null;
        case 'rating':
            return readRating(shot);
        case 'tds':
            return readTds(shot);
        case 'ey':
            return readEy(shot);
        case 'time':
            return readDurationSeconds(shot);
        default:
            return null;
    }
}

/**
 * Plain-field extraction of everything the plot's tap callout shows for one
 * shot. Deliberately returns raw data only (a Date, numbers, strings) --
 * date/time formatting, "18.0 g -> 36.4 g" composition and notes-clamping
 * are DOM/locale concerns that belong in shot_overview.js, not here.
 * @param {object} shot
 * @returns {{
 *   date: Date|null, profileTitle: string|null,
 *   beanName: string|null, beanRoaster: string|null,
 *   dose: number|null, yield: number|null, ratio: number|null, duration: number|null,
 *   rating: number|null, tds: number|null, ey: number|null, grind: number|null,
 *   notes: string|null,
 * }}
 */
export function shotAnnotation(shot) {
    const t = Date.parse(shot?.timestamp);
    const dose = readDose(shot);
    const yld = readYield(shot);
    const bean = readBean(shot);
    const grinder = readGrinder(shot);
    const notesRaw = shot?.annotations?.espressoNotes;
    const notes = typeof notesRaw === 'string' && notesRaw.trim() !== '' ? notesRaw.trim() : null;
    return {
        date: Number.isNaN(t) ? null : new Date(t),
        profileTitle: readProfileTitle(shot),
        beanName: bean?.name ?? null,
        beanRoaster: bean?.roaster ?? null,
        dose,
        yield: yld,
        ratio: dose != null && dose > 0 && yld != null && yld > 0 ? yld / dose : null,
        duration: readDurationSeconds(shot),
        rating: readRating(shot),
        tds: readTds(shot),
        ey: readEy(shot),
        grind: grinder?.setting ?? null,
        notes,
    };
}

// 'YYYY-MM-DD' for the LOCAL calendar day a Date falls on -- not
// toISOString() (UTC), which would put a late-evening shot on the wrong day.
function localDayKey(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

/**
 * Daily shot counts for the "Shots per day" bar-chart Y axis: one entry per
 * LOCAL calendar day from the first shot's day to the last shot's day
 * (inclusive), oldest first, zero-count days included so gaps in brewing
 * show up as real gaps instead of being silently skipped.
 * @param {Array<object>} shots
 * @returns {Array<{date: string, count: number, shotIds: Array<string|number>}>}
 */
export function shotsPerDay(shots) {
    const list = Array.isArray(shots) ? shots : [];
    const withTime = list
        .map((shot) => ({ shot, t: Date.parse(shot?.timestamp) }))
        .filter((x) => !Number.isNaN(x.t))
        .sort((a, b) => a.t - b.t);
    if (withTime.length === 0) return [];

    const byDay = new Map();
    for (const { shot, t } of withTime) {
        const key = localDayKey(new Date(t));
        const entry = byDay.get(key) ?? { count: 0, shotIds: [] };
        entry.count += 1;
        if (shot?.id != null) entry.shotIds.push(shot.id);
        byDay.set(key, entry);
    }

    // Walk every calendar day between the first and last shot, one local day
    // at a time -- setDate() arithmetic is calendar-aware (handles month/year
    // rollover and DST-shortened/lengthened days correctly), unlike adding a
    // fixed 24h in milliseconds.
    const first = new Date(withTime[0].t);
    const last = new Date(withTime[withTime.length - 1].t);
    const cursor = new Date(first.getFullYear(), first.getMonth(), first.getDate());
    const end = new Date(last.getFullYear(), last.getMonth(), last.getDate());

    const result = [];
    while (cursor.getTime() <= end.getTime()) {
        const key = localDayKey(cursor);
        const entry = byDay.get(key);
        result.push({ date: key, count: entry?.count ?? 0, shotIds: entry?.shotIds ?? [] });
        cursor.setDate(cursor.getDate() + 1);
    }
    return result;
}

// Bar-chart bucket sizes, smallest first. One bar per day stops working past
// ~60 bars on the 870px plot: two years of history is ~730 days = ~1px slots,
// so bars merge and every tap target is a sliver. Coarsen to weeks, then to
// 30-day blocks, whichever first keeps the chart at <= maxBars.
export const BAR_BUCKET_DAYS = [1, 7, 30];

/**
 * Groups shotsPerDay() output into consecutive blocks of `size` days (the
 * smallest size in BAR_BUCKET_DAYS giving <= maxBars blocks). Each block keeps
 * its first day as `date` and last as `endDate`; counts and ids are summed.
 * @param {Array<{date: string, count: number, shotIds: Array}>} days oldest first
 * @param {number} [maxBars=60]
 * @returns {{size: number, buckets: Array<{date: string, endDate: string, count: number, shotIds: Array}>}}
 */
export function bucketDays(days, maxBars = 60) {
    const list = Array.isArray(days) ? days : [];
    const size = BAR_BUCKET_DAYS.find((s) => Math.ceil(list.length / s) <= maxBars)
        ?? BAR_BUCKET_DAYS[BAR_BUCKET_DAYS.length - 1];
    const buckets = [];
    for (let i = 0; i < list.length; i += size) {
        const block = list.slice(i, i + size);
        buckets.push({
            date: block[0].date,
            endDate: block[block.length - 1].date,
            count: block.reduce((n, d) => n + d.count, 0),
            shotIds: block.flatMap((d) => d.shotIds),
        });
    }
    return { size, buckets };
}

function mean(values) {
    if (values.length === 0) return null;
    return values.reduce((a, b) => a + b, 0) / values.length;
}

// Most frequent value (mode); ties keep whichever value was seen first.
function mode(values) {
    if (values.length === 0) return null;
    const counts = new Map();
    for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
    let best = values[0];
    let bestCount = 0;
    for (const v of values) {
        const c = counts.get(v);
        if (c > bestCount) { best = v; bestCount = c; }
    }
    return best;
}

// Distinct-value histogram, sorted ascending by value -- feeds the grinder
// dot-strip (one dot-stack per distinct setting, left-to-right by value).
function histogram(values) {
    const counts = new Map();
    for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
    return [...counts.entries()]
        .map(([value, count]) => ({ value, count }))
        .sort((a, b) => a.value - b.value);
}

/**
 * Ranks {..., count} entries (already sorted desc by count, as
 * computeShotStats's profiles/beans already are) for a horizontal bar-row
 * chart: the top `limit` entries each get `share` = count / (top entry's
 * count), plus one "Other" bucket summing everything beyond the limit (null
 * when there's nothing left over -- e.g. beans, called with no limit, never
 * has one). Pure UI-shaping math kept here rather than in shot_overview.js
 * so Profiles and Beans compute identical bar widths off one implementation.
 * @param {Array<{count: number}>} entries
 * @param {number} [limit]
 * @returns {{ top: Array<object & {share: number}>, other: {count: number, share: number}|null }}
 */
export function rankedBarRows(entries, limit = Infinity) {
    const list = Array.isArray(entries) ? entries : [];
    const top = list.slice(0, limit);
    const rest = list.slice(limit);
    const max = top.length ? top[0].count : 0;
    const share = (c) => (max > 0 ? c / max : 0);
    const topWithShare = top.map((e) => ({ ...e, share: share(e.count) }));
    const otherCount = rest.reduce((sum, e) => sum + e.count, 0);
    const other = otherCount > 0 ? { count: otherCount, share: share(otherCount) } : null;
    return { top: topWithShare, other };
}

/**
 * Chronological (oldest-first) series of one stat's per-shot values, skipping
 * shots that don't have it -- feeds the stats row's sparklines. `key` reuses
 * shotAxisValue's field-fallback readers, so a sparkline can never disagree
 * with the average/plot value it sits under.
 * @param {Array<object>} shots
 * @param {'dose'|'yield'|'ratio'|'rating'|'time'} key
 * @returns {Array<number>}
 */
export function sparklineSeries(shots, key) {
    const list = Array.isArray(shots) ? shots : [];
    const withTime = list
        .map((shot) => ({ shot, t: Date.parse(shot?.timestamp) }))
        .filter((x) => !Number.isNaN(x.t))
        .sort((a, b) => a.t - b.t);
    const values = [];
    for (const { shot } of withTime) {
        const v = shotAxisValue(shot, key);
        if (v != null) values.push(v);
    }
    return values;
}

function emptyStats() {
    return {
        count: 0,
        firstDate: null,
        lastDate: null,
        perWeek: 0,
        avg: { dose: null, yield: null, ratio: null, rating: null, tds: null, ey: null, duration: null },
        durationSampleSize: 0,
        ratioPoints: [],
        beans: [],
        grinders: [],
        profiles: [],
        steam: null,
    };
}

/**
 * Filters shots to those within the past `days` days, measured back from
 * `now` (inclusive: a shot exactly `days` old stays in). `days === null`
 * means "all history" -- returned as-is, no timestamp parsing at all.
 * @param {Array<object>} shots
 * @param {number|null} days
 * @param {Date} [now]
 * @returns {Array<object>}
 */
export function filterShotsByDays(shots, days, now = new Date()) {
    const list = Array.isArray(shots) ? shots : [];
    if (days == null) return list;
    const cutoff = now.getTime() - days * MS_PER_DAY;
    return list.filter((shot) => {
        const t = Date.parse(shot?.timestamp);
        return !Number.isNaN(t) && t >= cutoff;
    });
}

/**
 * Reduces a list of shot records to the "Shot overview" page's summary shape.
 * @param {Array<object>} shots
 * @returns {{
 *   count: number, firstDate: Date|null, lastDate: Date|null, perWeek: number,
 *   avg: { dose: number|null, yield: number|null, ratio: number|null, rating: number|null, tds: number|null, ey: number|null, duration: number|null },
 *   durationSampleSize: number,
 *   ratioPoints: Array<{dose: number, yield: number}>,
 *   beans: Array<{name: string, roaster: string|null, count: number, lastDate: Date, usualGrind: number|null}>,
 *   grinders: Array<{model: string, count: number, min: number|null, max: number|null, usualSetting: number|null}>,
 *   profiles: Array<{title: string, count: number}>,
 *   steam: {targetTemperature: number|null, flow: number|null, duration: number|null, count: number}|null,
 * }}
 */
export function computeShotStats(shots) {
    const list = Array.isArray(shots) ? shots : [];
    if (list.length === 0) return emptyStats();

    const withTime = list
        .map((shot) => ({ shot, t: Date.parse(shot?.timestamp) }))
        .filter((x) => !Number.isNaN(x.t));

    // Newest-first: ratioPoints' "newest 10 full opacity" reads off the front
    // of that array, and beans/grinders' lastDate is a max over what's seen.
    const newestFirst = [...withTime].sort((a, b) => b.t - a.t);
    const oldest = newestFirst.length ? newestFirst[newestFirst.length - 1].t : null;
    const newest = newestFirst.length ? newestFirst[0].t : null;

    const spanMs = oldest !== null && newest !== null ? newest - oldest : 0;
    const weeks = Math.max(1, spanMs / MS_PER_WEEK);
    const perWeek = list.length / weeks;

    const doses = [];
    const yields = [];
    const ratios = [];
    const ratings = [];
    const tdss = [];
    const eys = [];
    const durations = [];
    const ratioPoints = [];

    const beanMap = new Map();
    const grinderMap = new Map();
    const profileCounts = new Map();
    const steamCounts = new Map();

    for (const { shot, t } of newestFirst) {
        const dose = readDose(shot);
        const yld = readYield(shot);
        if (dose != null) doses.push(dose);
        if (yld != null) yields.push(yld);
        if (dose != null && dose > 0 && yld != null && yld > 0) {
            ratios.push(yld / dose);
            ratioPoints.push({ dose, yield: yld });
        }

        const rating = readRating(shot);
        if (rating != null) ratings.push(rating);
        const tds = readTds(shot);
        if (tds != null) tdss.push(tds);
        const ey = readEy(shot);
        if (ey != null) eys.push(ey);
        const duration = readDurationSeconds(shot);
        if (duration != null) durations.push(duration);

        const grinder = readGrinder(shot);

        const bean = readBean(shot);
        if (bean) {
            const key = `${bean.name}\u0000${bean.roaster ?? ''}`;
            const entry = beanMap.get(key) ?? {
                name: bean.name, roaster: bean.roaster, count: 0, lastDate: t, grindSettings: [],
            };
            entry.count += 1;
            if (t > entry.lastDate) entry.lastDate = t;
            if (grinder?.setting != null) entry.grindSettings.push(grinder.setting);
            beanMap.set(key, entry);
        }

        if (grinder) {
            const entry = grinderMap.get(grinder.model) ?? { model: grinder.model, count: 0, settings: [] };
            entry.count += 1;
            if (grinder.setting != null) entry.settings.push(grinder.setting);
            grinderMap.set(grinder.model, entry);
        }

        const profileTitle = readProfileTitle(shot);
        if (profileTitle) profileCounts.set(profileTitle, (profileCounts.get(profileTitle) ?? 0) + 1);

        const steam = readSteam(shot);
        if (steam) {
            const key = `${steam.targetTemperature}|${steam.flow}|${steam.duration}`;
            const entry = steamCounts.get(key) ?? { ...steam, count: 0 };
            entry.count += 1;
            steamCounts.set(key, entry);
        }
    }

    const beans = [...beanMap.values()]
        .map((b) => ({
            name: b.name,
            roaster: b.roaster,
            count: b.count,
            lastDate: new Date(b.lastDate),
            usualGrind: mode(b.grindSettings),
        }))
        .sort((a, b) => b.count - a.count);

    const grinders = [...grinderMap.values()]
        .map((g) => ({
            model: g.model,
            count: g.count,
            min: g.settings.length ? Math.min(...g.settings) : null,
            max: g.settings.length ? Math.max(...g.settings) : null,
            usualSetting: mode(g.settings),
            settingCounts: histogram(g.settings), // feeds the dot-strip
        }))
        .sort((a, b) => b.count - a.count);

    // Not capped here -- the "Shot overview" page caps to a top-5-plus-Other
    // bar chart via rankedBarRows(profiles, 5) at render time; keeping the
    // full sorted list here is what lets rankedBarRows sum "everything past
    // the top 5" into that Other bucket.
    const profiles = [...profileCounts.entries()]
        .map(([title, count]) => ({ title, count }))
        .sort((a, b) => b.count - a.count);

    const steam = steamCounts.size
        ? [...steamCounts.values()].sort((a, b) => b.count - a.count)[0]
        : null;

    return {
        count: list.length,
        firstDate: oldest !== null ? new Date(oldest) : null,
        lastDate: newest !== null ? new Date(newest) : null,
        perWeek,
        avg: {
            dose: mean(doses),
            yield: mean(yields),
            ratio: mean(ratios),
            rating: mean(ratings),
            tds: mean(tdss),
            ey: mean(eys),
            duration: mean(durations),
        },
        durationSampleSize: durations.length,
        ratioPoints,
        beans,
        grinders,
        profiles,
        steam,
    };
}
