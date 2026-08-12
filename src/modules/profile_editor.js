// Profile editor — single-screen redesign.
//
// What the old editor asked of the user, and what this replaces it with:
//
//   Three tabs (Step / Summary / Settings). You edited numbers in one tab and
//   could only see their effect on the curve in another.
//     → ONE screen: step list | the selected step | the live curve. Every edit
//       redraws the graph beside it, with the step you are editing shaded.
//
//   A transposed grid — attributes as rows, steps as horizontally-scrolling
//   columns, four visible at a time. Nothing else in the app is laid out that
//   way, and a shot is a sequence, not a spreadsheet.
//     → A vertical list of steps, in the order the machine runs them, each with
//       a plain-language one-line summary. Tap one to edit it, alone, with room.
//
//   ± buttons hidden until you tapped a value, plus a "hint" system (two module
//   globals and a dismissal flag) whose whole job was to teach that gesture.
//     → Every control is visible at rest. The hint machinery is gone.
//
//   Buttons that cycled through values on tap ("Pressure" → "Flow" → "off"),
//   so the options existed only in the user's memory.
//     → Segmented controls: all options on screen, the active one filled.
//
//   "Max" (weight/time/volume) and "Exit if" were separate rows in separate
//   places, though both answer one question, and nothing said the machine
//   honours whichever trips first.
//     → One "Ends when" panel: tick the conditions you want, with that sentence
//       written under them. A step with none ticked says so, in red.
//
//   Jargon with no explanation anywhere ("Exit if", "Limiter tolerance",
//   "Preinfusion ends after") and help only in hover tooltips, which a tablet
//   cannot show.
//     → A one-sentence explainer under every panel and setting, always visible.
//
// Unchanged on purpose: the profile data model, FIELD_LIMITS and their reasons,
// the save/versioning routing, share-code import, and the numpad/inline-edit
// split between tablet and desktop.

import { loadPage } from './router.js';
import { showToast, flashPlusMinusButton } from './ui.js';
import { openModal, shouldUseNumpad, resetNumpadModal } from './numpad-modal.js';
import { openNotesModal } from './notes-modal.js';
import { getTranslation } from './i18n.js';
import { callPluginEndpoint, getPluginSettings } from './api.js';
import { validateProfileStructure } from './profileManager.js';

// ─── State ──────────────────────────────────────────────────────────────────

let editorState = {
    sourceProfileId: null,
    sourceProfileRecord: null,
    profile: null,
    selectedStep: 0,
    // Title of the panel the user last touched, so the highlight survives the
    // renderStepEditor() that a toggle inside that same panel triggers.
    focusedPanel: null,
};

// IDs of profiles persisted to the server via share-code import during a
// new-profile session. Cleaned up on cancel so no orphans are left behind.
let _isNewProfileSession = false;
let _sessionImportedIds = [];
let _hasImportedInSession = false;

// Snapshot of the profile as last loaded or saved. Cancel compares against it
// to decide whether there is unsaved work worth warning about.
let _baselineProfileJson = null;

// ─── Constants ──────────────────────────────────────────────────────────────

// Rea API only supports pressure/flow exit types (profile.dart:129 ExitType
// enum). Weight-based stop is expressed via profile-level `target_weight`;
// time-based stop is expressed via step `seconds`. "No exit condition" is
// `step.exit = null`, which is why the UI models it as an unticked row rather
// than a third exit type.
const EXIT_UNIT_MAP = { pressure: 'bar', flow: 'mL/s' };
const EXIT_STEP_MAP = { pressure: 0.1, flow: 0.1 };
const EXIT_MAX_MAP  = { pressure: 12,  flow: 8 };

// Single source of truth for every numeric field's bounds. The grid and text
// tabs each used to carry their own copy, and they had drifted: weight/volume
// clamped at 1000 in the grid but 500 in the text tab, pressure at 12 vs 16.
// The same field would clamp differently depending on which tab you edited in.
const FIELD_LIMITS = {
    // 105 is the ceiling the TCL skin enforces (skin.tcl:1848).
    temperature:   { min: 0, max: 105, step: 0.5 },
    flow:          { min: 0, max: 15,  step: 0.1 },
    // 0 bar is a valid "pump off" target, same as a 0 limiter.
    pressure:      { min: 0, max: 12,  step: 0.1 },
    flowLimit:     { min: 0, max: 8,   step: 0.1 }, // flow limit on a pressure step
    pressureLimit: { min: 0, max: 12,  step: 0.1 }, // pressure limit on a flow step
    weight:        { min: 0, max: 500, step: 1 },
    // 127 is the protocol ceiling, not a taste call: frame length goes over the
    // wire as F8_1_7 (de1app binary.tcl:1053), whose encoder clamps anything
    // above 127 — "Numbers over 127 are not allowed this F8_1_7; limiting at
    // 127" (binary.tcl:555-559).
    seconds:       { min: 0, max: 127, step: 1 },
    volume:        { min: 0, max: 500, step: 1 },
    targetWeight:  { min: 0, max: 500, step: 0.1 },
    targetVolume:  { min: 0, max: 500, step: 1 },
    tankTemp:      { min: 0, max: 110, step: 1 },
    limiterRange:  { min: 0, max: 5,   step: 0.1 },
};

// Seeds used the first time an "ends when" row is ticked on.
const COND_SEEDS = { seconds: 30, weight: 20, volume: 50, exit: 9, limit: 6 };

// Last non-zero value each condition held, so unticking and re-ticking a row
// gives the number back instead of the seed. Module-level and keyed by field
// alone — the panel is rebuilt on every toggle, so a closure variable would be
// re-seeded from the now-zeroed step and forget immediately. Shared across
// steps on purpose: setting weight to 25 g on one step then ticking weight on
// another almost always means 25 g again.
const _condMemo = new Map();
function rememberCond(key, value) {
    if (value > 0) _condMemo.set(key, value);
}
function recallCond(key) {
    return _condMemo.get(key) ?? COND_SEEDS[key];
}

const DEFAULT_STEP = {
    name: 'New step',
    pump: 'flow',
    transition: 'fast',
    flow: 6.0,
    temperature: 93,
    sensor: 'coffee',
    seconds: 30,
    weight: 0,
    volume: 0,
    exit: null,
    limiter: null,
};

// The step-type picker. This is where a new user finds out what a step can
// even be — the old editor's only way to add one was a "+" that produced an
// unnamed default and left you to work the rest out from the field names.
// Every preset is an ordinary step afterwards: nothing here is a special mode.
const STEP_PRESETS = [
    {
        name: 'Preinfusion',
        desc: 'Gentle flow to wet the puck evenly. Moves on once pressure builds.',
        step: { name: 'Preinfusion', pump: 'flow', transition: 'fast', flow: 4, sensor: 'coffee', seconds: 20, weight: 0, volume: 0, exit: { type: 'pressure', condition: 'over', value: 4 }, limiter: null },
    },
    {
        name: 'Rise',
        desc: 'Climb smoothly to full pressure to start extraction.',
        step: { name: 'Rise', pump: 'pressure', transition: 'smooth', pressure: 9, sensor: 'coffee', seconds: 10, weight: 0, volume: 0, exit: null, limiter: null },
    },
    {
        name: 'Hold',
        desc: 'Keep a steady pressure while the shot pours.',
        step: { name: 'Hold', pump: 'pressure', transition: 'fast', pressure: 9, sensor: 'coffee', seconds: 30, weight: 0, volume: 0, exit: null, limiter: null },
    },
    {
        name: 'Decline',
        desc: 'Ease pressure back down towards the end of the shot.',
        step: { name: 'Decline', pump: 'pressure', transition: 'smooth', pressure: 6, sensor: 'coffee', seconds: 20, weight: 0, volume: 0, exit: null, limiter: null },
    },
    {
        name: 'Steady flow',
        desc: 'Hold one flow rate and let pressure go where it wants.',
        step: { name: 'Pour', pump: 'flow', transition: 'smooth', flow: 2, sensor: 'coffee', seconds: 30, weight: 0, volume: 0, exit: null, limiter: null },
    },
    {
        name: 'Blank step',
        desc: 'Start from nothing and set everything yourself.',
        step: DEFAULT_STEP,
    },
];

// ─── Small helpers ──────────────────────────────────────────────────────────

function deepCopy(obj) {
    return JSON.parse(JSON.stringify(obj));
}

function clamp(value, min, max) {
    if (min !== undefined && value < min) return min;
    if (max !== undefined && value > max) return max;
    return value;
}

function roundTo(value, step) {
    const decimals = step < 1 ? String(step).split('.')[1].length : 0;
    return parseFloat(value.toFixed(decimals));
}

function t(key) {
    return getTranslation(key);
}

/** el('div', 'class-name', 'text' | [children]) */
function el(tag, className, content) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (typeof content === 'string') node.textContent = content;
    else if (Array.isArray(content)) content.forEach(c => c && node.appendChild(c));
    else if (content) node.appendChild(content);
    return node;
}

// Icons are inline SVG paths so they inherit currentColor and need no font.
const ICONS = {
    grip: '<path d="M9 5h.01M9 12h.01M9 19h.01M15 5h.01M15 12h.01M15 19h.01" stroke-width="3"/>',
    copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
    trash: '<path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m3 0-1 14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2L4 6"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
};

function icon(name) {
    const span = document.createElement('span');
    span.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
    return span.firstChild;
}

function iconButton(name, ariaLabel, onClick, { disabled = false, className = 'pe-tool' } = {}) {
    const btn = el('button', className);
    btn.type = 'button';
    btn.setAttribute('aria-label', ariaLabel);
    btn.title = ariaLabel;
    btn.appendChild(icon(name));
    btn.disabled = disabled;
    if (!disabled) btn.addEventListener('click', onClick);
    return btn;
}

// ─── Value entry (numpad on tablet, inline input on desktop) ────────────────

function openNumpadForField(currentVal, numpadConfig, onCommit) {
    // After router navigation the DOM is rebuilt; reset flag if overlay was lost
    if (!document.getElementById('numpad-modal-overlay')) resetNumpadModal();
    const mockInput = { value: String(currentVal), dispatchEvent: () => {} };
    openModal(mockInput, {
        fieldType: numpadConfig.fieldType || 'pe-generic',
        config: numpadConfig,
        onConfirm: (val) => {
            const num = parseFloat(val);
            if (!isNaN(num)) onCommit(clamp(num, numpadConfig.min ?? 0, numpadConfig.max ?? 9999));
        },
    });
}

// Desktop: turn a value display into a text field so a number can be typed
// instead of stepped to. Restores the display on commit or Escape.
function inlineEditValue(displayEl, currentValue, { min, max, step, onCommit }) {
    if (displayEl.querySelector('input')) return;
    const savedText = displayEl.textContent;

    const input = document.createElement('input');
    input.type = 'number';
    input.value = currentValue;
    input.step = step || 'any';
    if (min !== undefined) input.min = min;
    if (max !== undefined) input.max = max;
    input.style.cssText = 'width:100%;background:transparent;border:none;outline:none;text-align:center;';

    displayEl.textContent = '';
    displayEl.appendChild(input);
    input.focus();
    input.select();

    let done = false;
    function finish(apply) {
        if (done) return;
        done = true;
        const num = parseFloat(input.value);
        displayEl.textContent = savedText;
        if (apply && !isNaN(num)) onCommit(clamp(roundTo(num, step || 0.1), min ?? 0, max ?? 9999));
    }

    input.addEventListener('blur', () => finish(true));
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
        if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    });
}

// Builds a numpad config from a FIELD_LIMITS entry so the displayed range label
// can never disagree with the range actually enforced.
function numpadConfig(fieldType, title, unit, lim) {
    return { fieldType, title, unit, min: lim.min, max: lim.max, label: `${lim.min}–${lim.max}` };
}

// ─── Widgets ────────────────────────────────────────────────────────────────

/**
 * [−] value [+], with the value tappable to type one directly.
 * Always visible — no reveal-on-tap, no timers, nothing to discover.
 */
function stepper({ value, lim, unit = '', title = 'Value', fieldType = 'pe-value', format, onChange }) {
    let current = typeof value === 'number' ? value : parseFloat(value) || 0;
    const fmt = format || ((v) => (unit ? `${roundTo(v, lim.step)} ${unit}` : `${roundTo(v, lim.step)}`));

    const wrap = el('div', 'pe-stepper');
    const display = el('span', 'pe-stepper-val');
    display.setAttribute('role', 'button');
    display.tabIndex = 0;
    display.setAttribute('aria-label', title);

    function render() {
        display.textContent = fmt(current);
        minus.disabled = current <= lim.min;
        plus.disabled = current >= lim.max;
    }

    function commit(val) {
        current = roundTo(clamp(val, lim.min, lim.max), lim.step);
        render();
        onChange(current);
    }

    function mkBtn(label, delta, aria) {
        const btn = el('button', 'pe-stepper-btn', label);
        btn.type = 'button';
        btn.setAttribute('aria-label', `${title} ${aria}`);
        btn.addEventListener('click', () => {
            flashPlusMinusButton(btn);
            commit(current + delta);
        });
        return btn;
    }

    const minus = mkBtn('−', -lim.step, 'decrease');
    const plus = mkBtn('+', lim.step, 'increase');

    function typeValue() {
        if (shouldUseNumpad()) {
            openNumpadForField(current, numpadConfig(fieldType, title.toUpperCase(), unit, lim), commit);
            return;
        }
        inlineEditValue(display, current, { min: lim.min, max: lim.max, step: lim.step, onCommit: commit });
    }
    display.addEventListener('click', typeValue);
    display.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); typeValue(); } });

    wrap.append(minus, display, plus);
    render();
    return wrap;
}

/**
 * Segmented control. Every option visible, active one filled — replaces the old
 * cycle-on-tap buttons where the alternatives were invisible until you guessed.
 * options: [{ value, label }]
 */
function segmented({ options, value, ariaLabel, onChange }) {
    const wrap = el('div', 'pe-seg');
    wrap.setAttribute('role', 'radiogroup');
    if (ariaLabel) wrap.setAttribute('aria-label', ariaLabel);

    options.forEach((opt) => {
        const btn = el('button', `pe-seg-btn${opt.value === value ? ' is-on' : ''}`, opt.label);
        btn.type = 'button';
        btn.setAttribute('role', 'radio');
        btn.setAttribute('aria-checked', String(opt.value === value));
        btn.addEventListener('click', () => {
            if (opt.value === value) return;
            onChange(opt.value);
        });
        wrap.appendChild(btn);
    });
    return wrap;
}

/**
 * One row of the "Ends when" panel: a checkbox, a label, and — when ticked —
 * the controls for its value. Unticking remembers the value so re-ticking does
 * not lose it.
 */
function conditionRow({ on, label, note, controls, onToggle }) {
    const row = el('div', `pe-cond ${on ? 'is-on' : 'is-off'}`);

    const check = el('button', 'pe-cond-check');
    check.type = 'button';
    check.setAttribute('role', 'checkbox');
    check.setAttribute('aria-checked', String(on));
    check.setAttribute('aria-label', label);
    check.appendChild(icon('check'));
    check.addEventListener('click', () => onToggle(!on));

    const body = el('div', 'pe-cond-body', [
        el('span', 'pe-cond-label', label),
        note ? el('span', 'pe-cond-note', note) : null,
    ]);

    row.append(check, body);
    if (on && controls) {
        // One control sits beside the label; several are a phrase and get their
        // own line (see .pe-cond--stack). Decided from the control count rather
        // than per-caller so a row that grows a control can't forget to opt in.
        if (controls.length > 1) row.classList.add('pe-cond--stack');
        row.appendChild(el('div', 'pe-cond-controls', controls));
    }
    // Tapping the label area is the same as tapping the checkbox when the row is
    // off — the whole row is the target for turning something on.
    if (!on) body.addEventListener('click', () => onToggle(true));
    return row;
}

function panel(title, hint, children) {
    // The title doubles as the panel's identity: it's what the focus highlight
    // is restored from after a rebuild (see attachPanelFocus).
    const node = el('div', `pe-panel${title === editorState.focusedPanel ? ' is-focused' : ''}`, [
        el('div', 'pe-panel-head', el('span', 'pe-panel-title', title)),
        hint ? el('p', 'pe-hint', hint) : null,
        ...children.filter(Boolean),
    ]);
    node.dataset.panelTitle = title;
    return node;
}

// Lift the panel the user is working in out of the page background, so at a
// glance it's clear which group of controls has their attention.
//
// pointerdown rather than :focus-within alone: tapping a value here opens the
// numpad modal, which takes focus out of the panel immediately, and on iOS a
// tap doesn't focus a button at all. :focus-within stays in the CSS for the
// keyboard path. Delegated from the static container, so it survives the
// innerHTML rebuilds renderStepEditor() does.
function attachPanelFocus(host) {
    host.addEventListener('pointerdown', (e) => {
        const panelEl = e.target.closest('.pe-panel');
        if (!panelEl || !host.contains(panelEl)) return;
        editorState.focusedPanel = panelEl.dataset.panelTitle || null;
        for (const p of host.querySelectorAll('.pe-panel.is-focused')) p.classList.remove('is-focused');
        panelEl.classList.add('is-focused');
    });
}

function field(labelText, control, sub) {
    return el('div', 'pe-field', [
        el('div', null, [
            el('div', 'pe-field-label', labelText),
            sub ? el('div', 'pe-field-sub', sub) : null,
        ]),
        control,
    ]);
}

// ─── Step list mutations ────────────────────────────────────────────────────
//
// profile.target_volume_count_start is a 1-based step index (0 = None), so it
// has to move with the steps around it. Splicing the array directly — as the
// old grid and text tabs both did — silently repointed it at a different step,
// or left it dangling past the end of the array.

function removeStepAt(index) {
    const p = editorState.profile;
    p.steps.splice(index, 1);
    const start = p.target_volume_count_start || 0;
    if (start === index + 1) p.target_volume_count_start = index;
    else if (start > index + 1) p.target_volume_count_start = start - 1;
}

function insertStepAt(index, step) {
    const p = editorState.profile;
    p.steps.splice(index, 0, step);
    const start = p.target_volume_count_start || 0;
    if (start >= index + 1) p.target_volume_count_start = start + 1;
}

function moveStep(from, to) {
    const p = editorState.profile;
    if (to < 0 || to >= p.steps.length || from === to) return false;

    const [moved] = p.steps.splice(from, 1);
    p.steps.splice(to, 0, moved);

    const start = p.target_volume_count_start || 0;
    if (start === 0) return true;            // None — nothing to track
    let marked = start - 1;                  // to 0-based
    if (marked === from) marked = to;        // the marked step is the one that moved
    else if (from < to && marked > from && marked <= to) marked -= 1;
    else if (from > to && marked >= to && marked < from) marked += 1;
    p.target_volume_count_start = marked + 1;
    return true;
}

// ─── Drag-to-reorder ────────────────────────────────────────────────────────
//
// Pointer events, not the HTML5 drag-and-drop API: this UI runs on the
// machine's touchscreen, where dragstart/drop never fire.
//
// The card follows the pointer and the list re-flows live underneath it, so a
// step can be taken from anywhere to anywhere in one gesture. The target index
// is recomputed from the whole list on every move (count the neighbours whose
// midpoint the pointer has passed) rather than by swapping with the neighbour
// being crossed — a fast flick past three cards lands three positions down
// instead of one.
//
// Only the DOM moves during the drag; the model is updated once on release,
// because moveStep() also has to carry target_volume_count_start along and
// re-running that per pointermove would rewrite it dozens of times per drag.
//
// The pointer is captured on the handle, which travels inside the card, so
// re-inserting the card mid-drag doesn't break the gesture. clientY compares
// cleanly against getBoundingClientRect() — both are post-transform viewport
// coordinates under scaling.js's CSS transform. The translateY that keeps the
// card under the finger is NOT: it's applied inside that transform, so the
// viewport-space delta has to be divided by the scale factor or the card
// outruns (or trails) the finger by however much the page is scaled.
//
// ponytail: no edge autoscroll — the rail shows ~9 cards and profiles longer
// than that are rare. Add it if long profiles start showing up.
function attachStepDrag(handle, card, index) {
    handle.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();   // the handle is inside the card; don't also select it
        const list = card.parentElement;
        if (!list || list.children.length < 2) return;

        handle.setPointerCapture(e.pointerId);
        card.classList.add('is-dragging');

        const startRect = card.getBoundingClientRect();
        const scale = card.offsetHeight ? startRect.height / card.offsetHeight : 1;
        const grabOffset = e.clientY - startRect.top;   // where in the card the finger landed

        const onMove = (ev) => {
            // Where should the card sit now? One past every other card whose
            // midpoint is above the pointer.
            const others = [...list.children].filter((c) => c !== card);
            let target = 0;
            for (const other of others) {
                const r = other.getBoundingClientRect();
                if (ev.clientY > r.top + r.height / 2) target++;
            }
            const ref = others[target] || null;
            if (ref !== card.nextElementSibling) list.insertBefore(card, ref);

            // Re-measure with the offset cleared: the insert above just moved the
            // card's own slot, so last frame's translate is against a stale origin.
            card.style.transform = '';
            const rect = card.getBoundingClientRect();
            card.style.transform = `translateY(${(ev.clientY - grabOffset - rect.top) / scale}px)`;
        };

        const onEnd = (ev) => {
            card.style.transform = '';
            handle.removeEventListener('pointermove', onMove);
            handle.removeEventListener('pointerup', onEnd);
            handle.removeEventListener('pointercancel', onEnd);
            if (handle.hasPointerCapture(ev.pointerId)) handle.releasePointerCapture(ev.pointerId);
            card.classList.remove('is-dragging');

            const to = [...list.children].indexOf(card);
            // renderAll() either way: on a real move it renumbers and repaints the
            // curve, on a no-op it puts back the card this handler shuffled.
            if (to !== index && to >= 0 && moveStep(index, to)) editorState.selectedStep = to;
            renderAll();
        };

        handle.addEventListener('pointermove', onMove);
        handle.addEventListener('pointerup', onEnd);
        handle.addEventListener('pointercancel', onEnd);
    });

    // A drag handle is unreachable without a pointer, and the arrow buttons it
    // replaced were the only keyboard path to reordering.
    handle.addEventListener('keydown', (e) => {
        const to = e.key === 'ArrowUp' ? index - 1 : e.key === 'ArrowDown' ? index + 1 : null;
        if (to === null) return;
        e.preventDefault();
        e.stopPropagation();
        if (!moveStep(index, to)) return;
        editorState.selectedStep = to;
        renderAll();
        // The rail was rebuilt; focus the same step's handle so a second press
        // keeps moving the same card.
        document.querySelector(`#pe-step-list > :nth-child(${to + 1}) .pe-drag-handle`)?.focus();
    });
}

/** A new step seeded from a preset, inheriting temperature from its neighbour. */
function makeStepFromPreset(preset, neighbour) {
    const step = deepCopy(preset.step);
    step.temperature = neighbour?.temperature ?? 93;
    if (step.sensor === undefined) step.sensor = neighbour?.sensor ?? 'coffee';
    return step;
}

// ─── Step summary (used in the rail and the step count) ─────────────────────

function stepDuration(step) {
    // A step with no time limit still occupies the graph; 10 s is a drawing
    // assumption, not a claim about the machine.
    return (step.seconds && step.seconds > 0) ? step.seconds : 10;
}

function summariseStep(step) {
    const isFlow = step.pump !== 'pressure';
    const parts = [];
    parts.push(isFlow
        ? `${roundTo(step.flow ?? 0, 0.1)} mL/s`
        : `${roundTo(step.pressure ?? 0, 0.1)} bar`);
    parts.push(`${roundTo(step.temperature ?? 0, 0.5)} °C`);
    if (step.seconds > 0) parts.push(`${step.seconds} s`);
    if (step.weight > 0) parts.push(`${step.weight} g`);
    if (step.volume > 0) parts.push(`${step.volume} ml`);
    if (step.exit) {
        const dir = step.exit.condition === 'under' ? '<' : '>';
        parts.push(`${t(step.exit.type === 'flow' ? 'Flow' : 'Pressure')} ${dir} ${roundTo(step.exit.value ?? 0, 0.1)} ${EXIT_UNIT_MAP[step.exit.type] || ''}`);
    }
    return parts.join(' · ');
}

/** True when nothing at all would end this step — worth saying out loud. */
function stepHasNoEnd(step) {
    return !(step.seconds > 0) && !(step.weight > 0) && !(step.volume > 0) && !step.exit;
}

// ─── Render: step rail ──────────────────────────────────────────────────────

function renderRail() {
    const list = document.getElementById('pe-step-list');
    const count = document.getElementById('pe-step-count');
    if (!list) return;
    list.innerHTML = '';

    const steps = editorState.profile.steps || [];

    if (count) {
        const total = steps.reduce((sum, s) => sum + stepDuration(s), 0);
        count.textContent = steps.length
            ? `${steps.length} · ~${Math.round(total)} s`
            : '';
    }

    if (!steps.length) {
        list.appendChild(el('p', 'pe-empty',
            t('This profile has no steps yet. Add one below to say what the machine should do first.')));
        return;
    }

    steps.forEach((step, index) => {
        const active = index === editorState.selectedStep;
        const card = el('div', `pe-step-card${active ? ' is-active' : ''}`);
        card.dataset.pump = step.pump === 'pressure' ? 'pressure' : 'flow';
        card.setAttribute('role', 'button');
        card.tabIndex = 0;
        card.setAttribute('aria-current', String(active));

        card.appendChild(el('div', 'pe-step-num', String(index + 1)));
        card.appendChild(el('div', 'pe-step-name', step.name || `${t('Step')} ${index + 1}`));
        card.appendChild(el('div', 'pe-step-sum', summariseStep(step)));

        // Drag handle, on every card rather than only the selected one: reordering
        // shouldn't cost a select-then-drag. Lives outside .pe-step-tools so it
        // isn't hidden with them.
        const handle = el('div', 'pe-drag-handle');
        handle.appendChild(icon('grip'));
        handle.setAttribute('role', 'button');
        handle.tabIndex = 0;
        handle.setAttribute('aria-label', `${t('Move up')} / ${t('Move down')} — ${t('Step')} ${index + 1}`);
        handle.setAttribute('aria-keyshortcuts', 'ArrowUp ArrowDown');
        handle.title = t('Drag to reorder');
        attachStepDrag(handle, card, index);
        card.appendChild(handle);

        const tools = el('div', 'pe-step-tools');
        tools.append(
            iconButton('copy', t('Duplicate'), () => { insertStepAt(index + 1, deepCopy(step)); editorState.selectedStep = index + 1; renderAll(); }),
            iconButton('trash', t('Delete'), async () => {
                if (!await promptConfirm({
                    message: `${t('Delete')} ${t('Step')} ${index + 1}?`,
                    confirmLabel: t('Delete'),
                    cancelLabel: t('Cancel'),
                })) return;
                removeStepAt(index);
                editorState.selectedStep = Math.max(0, Math.min(index, editorState.profile.steps.length - 1));
                renderAll();
            }),
        );
        // Tool clicks must not also re-select the card underneath them.
        tools.addEventListener('click', (e) => e.stopPropagation());
        card.appendChild(tools);

        function select() {
            if (editorState.selectedStep === index) return;
            editorState.selectedStep = index;
            renderAll();
        }
        card.addEventListener('click', select);
        card.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(); } });

        list.appendChild(card);
    });
}

// ─── Render: the selected step ──────────────────────────────────────────────

function renderStepEditor() {
    const host = document.getElementById('pe-step-editor');
    const heading = document.getElementById('pe-editor-heading');
    if (!host) return;
    host.innerHTML = '';

    const steps = editorState.profile.steps || [];
    const index = editorState.selectedStep;
    const step = steps[index];

    if (!step) {
        if (heading) heading.textContent = t('Step');
        host.appendChild(el('p', 'pe-empty', t('Pick a step on the left, or add one, to edit it here.')));
        return;
    }

    // "1 / 4", not "1 of 4": the surrounding word is translated but "of" is not
    // in the sheet, so the spelled-out form comes out half-translated.
    if (heading) heading.textContent = `${t('Step')} ${index + 1} / ${steps.length}`;

    // Any edit inside a step changes the summary in the rail and the curve on
    // the right, but must not rebuild the panel the user is touching.
    const touch = () => { renderRail(); renderPreview(); };

    const isFlow = step.pump !== 'pressure';

    // ── Name ────────────────────────────────────────────────────────────────
    const nameInput = el('input', 'pe-name-input');
    nameInput.type = 'text';
    nameInput.value = step.name || '';
    nameInput.setAttribute('aria-label', t('Name'));
    nameInput.placeholder = `${t('Step')} ${index + 1}`;
    nameInput.addEventListener('input', () => {
        step.name = nameInput.value;
        // Patch the rail card in place — a full renderRail() here would be fine
        // for the DOM but pointless work on every keystroke.
        const card = document.querySelectorAll('#pe-step-list .pe-step-card')[index];
        const nameEl = card?.querySelector('.pe-step-name');
        if (nameEl) nameEl.textContent = nameInput.value || `${t('Step')} ${index + 1}`;
    });

    host.appendChild(panel(
        t('Name'),
        t('What this step is for. It shows up in the list and on the shot graph.'),
        [nameInput],
    ));

    // ── Water ───────────────────────────────────────────────────────────────
    host.appendChild(panel(
        t('Water'),
        t('How hot the water is during this step, and which sensor the machine uses to hold that temperature.'),
        [
            field(t('Temperature'), stepper({
                value: step.temperature ?? 93,
                lim: FIELD_LIMITS.temperature,
                unit: '°C',
                title: t('Temperature'),
                fieldType: 'pe-temp',
                onChange: (val) => { step.temperature = val; touch(); },
            })),
            field(t('Sensor'), segmented({
                options: [
                    { value: 'coffee', label: t('Group') },
                    { value: 'water', label: t('Mix') },
                ],
                value: step.sensor === 'water' ? 'water' : 'coffee',
                ariaLabel: t('Temperature sensor'),
                onChange: (val) => { step.sensor = val; renderStepEditor(); touch(); },
            }), t('Group is the shower screen; Mix is the water before it gets there.')),
        ],
    ));

    // ── Pump ────────────────────────────────────────────────────────────────
    const pumpLim = isFlow ? FIELD_LIMITS.flow : FIELD_LIMITS.pressure;
    const pumpControls = [
        field(t('Type'), segmented({
            options: [
                { value: 'flow', label: t('Flow') },
                { value: 'pressure', label: t('Pressure') },
            ],
            value: isFlow ? 'flow' : 'pressure',
            ariaLabel: t('Pump mode'),
            onChange: (val) => {
                if (val === 'pressure') {
                    step.pump = 'pressure';
                    if (!step.pressure) step.pressure = 6.0;
                    delete step.flow;
                } else {
                    step.pump = 'flow';
                    if (!step.flow) step.flow = 6.0;
                    delete step.pressure;
                }
                // Units, bounds and the limiter's axis all change with the mode.
                renderStepEditor();
                touch();
            },
        }), isFlow
            ? t('Flow is fixed; pressure ends up wherever the puck puts it.')
            : t('Pressure is fixed; flow ends up wherever the puck puts it.')),

        field(t('Target'), stepper({
            value: isFlow ? (step.flow ?? 0) : (step.pressure ?? 0),
            lim: pumpLim,
            unit: isFlow ? 'mL/s' : 'bar',
            title: isFlow ? t('Flow') : t('Pressure'),
            fieldType: 'pe-pump',
            onChange: (val) => {
                if (isFlow) step.flow = val; else step.pressure = val;
                touch();
            },
        })),

        field(t('Transition'), segmented({
            options: [
                { value: 'fast', label: t('Quickly') },
                { value: 'smooth', label: t('Slowly') },
            ],
            value: step.transition === 'smooth' ? 'smooth' : 'fast',
            ariaLabel: t('Transition'),
            onChange: (val) => { step.transition = val; renderStepEditor(); touch(); },
        }), t('Quickly jumps to the target; slowly ramps into it over the first few seconds.')),
    ];

    // Limiter — a cap on the OTHER channel. Off is the normal case, so it stays
    // a single ticked-off row rather than a stepper permanently reading 0.
    const limLim = isFlow ? FIELD_LIMITS.pressureLimit : FIELD_LIMITS.flowLimit;
    const limUnit = isFlow ? 'bar' : 'mL/s';
    const limOn = (step.limiter?.value ?? 0) > 0;
    const limMemoKey = isFlow ? 'limitPressure' : 'limitFlow';
    rememberCond(limMemoKey, step.limiter?.value ?? 0);

    pumpControls.push(conditionRow({
        on: limOn,
        label: isFlow ? t('Limit pressure') : t('Limit flow'),
        note: isFlow
            ? t('Never let pressure climb past this, even if it means less flow.')
            : t('Never let flow climb past this, even if it means less pressure.'),
        controls: limOn ? [stepper({
            value: step.limiter.value,
            lim: limLim,
            unit: limUnit,
            title: isFlow ? t('Pressure limit') : t('Flow limit'),
            fieldType: 'pe-limit',
            onChange: (val) => {
                rememberCond(limMemoKey, val);
                if (!step.limiter) step.limiter = { value: val, range: 0.6 };
                else step.limiter.value = val;
                // 0 means "no cap" on the wire, so stepping to it is the same as
                // unticking — rebuild so the row stops claiming a limit of 0.
                if (val === 0) { step.limiter = null; renderStepEditor(); }
                touch();
            },
        })] : null,
        onToggle: (on) => {
            if (on) step.limiter = { value: recallCond(limMemoKey) ?? COND_SEEDS.limit, range: step.limiter?.range ?? 0.6 };
            else step.limiter = null;
            renderStepEditor();
            touch();
        },
    }));

    host.appendChild(panel(t('Pump'), t('What the pump aims for while this step runs.'), pumpControls));

    // ── Ends when ───────────────────────────────────────────────────────────
    // Time / weight / volume / exit condition all answer the same question, and
    // the machine honours whichever happens first. The old editor spread them
    // over two rows in two different places and never said that.
    const endsControls = [];

    function maxRow({ key, label, note, unit, lim, fieldType, title }) {
        const on = (step[key] || 0) > 0;
        rememberCond(key, step[key] || 0);
        return conditionRow({
            on,
            label,
            note,
            controls: on ? [stepper({
                value: step[key],
                lim,
                unit,
                title,
                fieldType,
                onChange: (val) => {
                    step[key] = val;
                    rememberCond(key, val);
                    // 0 IS "no limit" in the profile format, so stepping down to
                    // it unticks the row rather than leaving a live "0 g".
                    if (val === 0) renderStepEditor();
                    touch();
                },
            })] : null,
            onToggle: (want) => {
                step[key] = want ? recallCond(key) : 0;
                renderStepEditor();
                touch();
            },
        });
    }

    endsControls.push(maxRow({
        key: 'seconds', label: t('Time'), note: t('How long this step may run.'),
        unit: 's', lim: FIELD_LIMITS.seconds, fieldType: 'pe-max-seconds', title: t('Max time'),
    }));
    endsControls.push(maxRow({
        key: 'weight', label: t('Weight'), note: t('Needs a connected scale.'),
        unit: 'g', lim: FIELD_LIMITS.weight, fieldType: 'pe-max-weight', title: t('Max weight'),
    }));
    endsControls.push(maxRow({
        key: 'volume', label: t('Volume'), note: t('Water the pump has pushed through during this step.'),
        unit: 'ml', lim: FIELD_LIMITS.volume, fieldType: 'pe-max-volume', title: t('Max volume'),
    }));

    // Exit condition — pressure/flow crossing a threshold.
    const exitOn = !!step.exit;
    const exitType = step.exit?.type === 'flow' ? 'flow' : 'pressure';
    const exitCond = step.exit?.condition === 'under' ? 'under' : 'over';
    const exitValue = step.exit?.value ?? recallCond('exit');
    rememberCond('exit', step.exit?.value ?? 0);
    const exitLim = { min: 0, max: EXIT_MAX_MAP[exitType], step: EXIT_STEP_MAP[exitType] };

    endsControls.push(conditionRow({
        on: exitOn,
        label: t('Move on if'),
        note: t('Typical use: leave preinfusion as soon as the puck is saturated.'),
        controls: exitOn ? [
            segmented({
                options: [
                    { value: 'pressure', label: t('Pressure') },
                    { value: 'flow', label: t('Flow') },
                ],
                value: exitType,
                ariaLabel: t('Exit channel'),
                onChange: (val) => {
                    // Bounds are per-type — pressure tops out at 12 bar, flow at
                    // 8 mL/s — so the value has to come along into the new range.
                    step.exit = { type: val, condition: exitCond, value: clamp(exitValue, 0, EXIT_MAX_MAP[val]) };
                    renderStepEditor();
                    touch();
                },
            }),
            segmented({
                options: [
                    { value: 'over', label: t('is over') },
                    { value: 'under', label: t('is under') },
                ],
                value: exitCond,
                ariaLabel: t('Exit direction'),
                onChange: (val) => { step.exit = { ...step.exit, condition: val }; renderStepEditor(); touch(); },
            }),
            stepper({
                value: exitValue,
                lim: exitLim,
                unit: EXIT_UNIT_MAP[exitType],
                title: `${t('Exit')} ${exitType === 'flow' ? t('Flow') : t('Pressure')}`,
                fieldType: 'pe-exit',
                onChange: (val) => { step.exit = { ...step.exit, value: val }; rememberCond('exit', val); touch(); },
            }),
        ] : null,
        onToggle: (want) => {
            step.exit = want ? { type: exitType, condition: exitCond, value: exitValue } : null;
            renderStepEditor();
            touch();
        },
    }));

    endsControls.push(stepHasNoEnd(step)
        ? (() => {
            const warn = el('p', 'pe-note', t('Nothing ends this step, so it will run until you stop the shot yourself. Tick at least one condition above.'));
            warn.style.color = 'var(--status-red-color)';
            return warn;
        })()
        : el('p', 'pe-note', t('The step ends as soon as the FIRST ticked condition happens.')));

    host.appendChild(panel(t('Ending criteria'), t('What makes the machine move on to the next step.'), endsControls));
}

// ─── Render: live preview ───────────────────────────────────────────────────

function renderPreview() {
    renderStats();

    const graphDiv = document.getElementById('pe-graph');
    if (!graphDiv || typeof Plotly === 'undefined') return;

    const { traces, layout } = buildPreviewFigure();
    Plotly.react(graphDiv, traces, layout, { responsive: true, displayModeBar: false });
}

// Traces + layout for the curve, built once and plotted into either the inline
// preview or the zoom dialog. Split out so the two can never drift apart.
function buildPreviewFigure() {
    const profile = editorState.profile;

    const isDark = (localStorage.getItem('theme') || 'light') === 'dark';
    const gridColor = isDark ? '#3D4255' : '#E0E0E0';
    const axisColor = isDark ? '#606579' : '#959595';
    const bg = isDark ? '#17191e' : '#f8f9fb';
    const tempColor = isDark ? '#AE6D73' : '#ff97a1';

    const pressureX = [], pressureY = [], flowX = [], flowY = [], tempX = [], tempY = [];
    const shapes = [];
    let t0 = 0;
    let prevPressure = 0;
    let prevFlow = 0;
    let selStart = null, selEnd = null;

    // 'smooth' ramps from the channel's last value into the new target over
    // part of the step instead of jumping there instantly like 'fast' does.
    function rampDuration(dur) {
        return Math.min(dur, Math.min(3, Math.max(0.5, dur * 0.3)));
    }
    function pushChannel(xArr, yArr, startT, endT, prevVal, target, transition) {
        if (transition === 'smooth' && prevVal !== target) {
            const rampEnd = startT + rampDuration(endT - startT);
            if (rampEnd < endT) {
                xArr.push(rampEnd, endT);
                yArr.push(target, target);
                return;
            }
        }
        xArr.push(startT, endT);
        yArr.push(target, target);
    }

    (profile.steps || []).forEach((step, i) => {
        const dur = stepDuration(step);
        const startT = t0;
        const endT = t0 + dur;
        const transition = step.transition || 'fast';

        if (i === editorState.selectedStep) { selStart = startT; selEnd = endT; }

        if (startT > 0) {
            shapes.push({
                type: 'line',
                x0: startT, x1: startT,
                y0: 0, y1: 1, yref: 'paper',
                line: { color: axisColor, width: 1, dash: 'dot' },
            });
        }

        if (step.pump === 'pressure') {
            const target = step.pressure ?? 0;
            pushChannel(pressureX, pressureY, startT, endT, prevPressure, target, transition);
            prevPressure = target;
            flowX.push(startT, endT);
            flowY.push(0, 0);
            prevFlow = 0;
        } else {
            const target = step.flow ?? 0;
            pushChannel(flowX, flowY, startT, endT, prevFlow, target, transition);
            prevFlow = target;
            pressureX.push(startT, endT);
            pressureY.push(0, 0);
            prevPressure = 0;
        }

        const temp = step.temperature ?? 0;
        tempX.push(startT, endT);
        tempY.push(temp, temp);
        t0 = endT;
    });

    // Shade the step being edited. This is the whole reason the graph moved
    // next to the controls: you can see which part of the curve you are on.
    if (selStart !== null) {
        shapes.push({
            type: 'rect',
            x0: selStart, x1: selEnd,
            y0: 0, y1: 1, yref: 'paper',
            fillcolor: isDark ? 'rgba(65,89,150,0.30)' : 'rgba(56,90,146,0.13)',
            line: { width: 0 },
            layer: 'below',
        });
    }

    const traces = [
        { x: pressureX, y: pressureY, name: t('Pressure'), mode: 'lines', line: { color: '#17c29a', width: 3 }, hovertemplate: '%{y:.1f} bar<extra></extra>' },
        { x: flowX, y: flowY, name: t('Flow'), mode: 'lines', line: { color: isDark ? '#5b8dff' : '#0358cf', width: 3 }, hovertemplate: '%{y:.1f} mL/s<extra></extra>' },
        { x: tempX, y: tempY, name: '°C', mode: 'lines', yaxis: 'y2', line: { color: tempColor, width: 2, dash: 'dot' }, hovertemplate: '%{y:.1f} °C<extra></extra>' },
    ];

    const layout = {
        plot_bgcolor: bg,
        paper_bgcolor: bg,
        font: { color: axisColor, size: 13 },
        autosize: true,
        margin: { l: 44, r: 44, t: 10, b: 34, pad: 0 },
        showlegend: false,
        shapes,
        hovermode: 'x unified',
        xaxis: { gridcolor: gridColor, linecolor: axisColor, tickcolor: axisColor, fixedrange: true, ticksuffix: 's' },
        // Pressure (bar) and flow (mL/s) share the left axis as they always have
        // on the shot chart. Temperature gets its own axis instead of the old
        // divide-by-ten trick, which drew 93 °C as "9.3" against a bar scale.
        yaxis: { gridcolor: gridColor, linecolor: axisColor, tickcolor: axisColor, range: [0, 12], dtick: 2, fixedrange: true },
        yaxis2: { overlaying: 'y', side: 'right', showgrid: false, linecolor: tempColor, tickcolor: tempColor, tickfont: { color: tempColor }, fixedrange: true, ticksuffix: '°' },
    };

    return { traces, layout };
}

// One tap on the preview blows the curve up to near-full-screen. The inline
// graph is 330 design px tall next to three columns of controls, which is too
// small to read a ramp on a tablet. Snapshot, not a live view: it plots the
// profile as it stands when opened and nothing behind it can change while the
// modal is up.
function openGraphZoom() {
    if (typeof Plotly === 'undefined') return;

    const dlg = document.createElement('dialog');
    dlg.className = 'pe-dialog pe-zoom';

    const big = el('div', 'pe-zoom-graph');
    const close = el('button', 'pe-btn pe-btn--primary', t('Close'));
    close.type = 'button';
    const body = el('div', 'pe-dialog-body', [
        big,
        el('div', 'pe-dialog-actions', close),
    ]);
    dlg.appendChild(body);

    function done() {
        // Purge before removing: Plotly keeps a resize listener per plot, and a
        // detached div would leak one on every open.
        try { Plotly.purge(big); } catch (_) {}
        try { dlg.close(); } catch (_) {}
        dlg.remove();
    }
    close.addEventListener('click', done);
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); done(); });

    document.body.appendChild(dlg);
    dlg.showModal();

    // After showModal, so the div has its real size and responsive sizing lands
    // on the first draw instead of needing a resize.
    const { traces, layout } = buildPreviewFigure();
    // At this size there is room to say which line is which.
    layout.showlegend = true;
    layout.legend = { orientation: 'h', y: 1.08, x: 0 };
    layout.margin = { l: 60, r: 60, t: 10, b: 44, pad: 0 };
    Plotly.newPlot(big, traces, layout, { responsive: true, displayModeBar: false });
}

function renderStats() {
    const host = document.getElementById('pe-stats');
    if (!host) return;
    host.innerHTML = '';

    const p = editorState.profile;
    const steps = p.steps || [];
    const total = steps.reduce((sum, s) => sum + stepDuration(s), 0);

    // What ends the WHOLE shot. target_weight / target_volume are early stops;
    // with neither set the shot simply ends when the last step does, which the
    // Time tile beside this one already estimates — so that case is 'None', not
    // 'Manual'. This tile used to say 'Manual' for it, which claimed the user
    // had to stop the shot by hand and also collided with the unrelated
    // beverage_type: 'manual'. It is only genuinely manual when the LAST step
    // has nothing to end it either, which is the one case left below.
    const last = steps[steps.length - 1];
    let stop = (last && stepHasNoEnd(last)) ? t('Manual') : t('None');
    if (p.target_weight > 0) stop = `${roundTo(p.target_weight, 0.1)} g`;
    else if (p.target_volume > 0) stop = `${Math.round(p.target_volume)} ml`;

    const stat = (k, v) => el('div', 'pe-stat', [el('div', 'pe-stat-k', k), el('div', 'pe-stat-v', v)]);
    host.append(
        stat(t('Steps'), String(steps.length)),
        stat(t('Time'), `~${Math.round(total)} s`),
        stat(t('Stop at'), stop),
    );
}

// ─── Render: whole-shot settings ────────────────────────────────────────────

function setting(labelText, hint, control) {
    return el('div', 'pe-set', [
        el('div', 'pe-set-label', labelText),
        hint ? el('div', 'pe-set-hint', hint) : null,
        control,
    ]);
}

function renderShotSettings() {
    const host = document.getElementById('pe-shot-settings');
    if (!host) return;
    host.innerHTML = '';

    const p = editorState.profile;

    host.appendChild(el('div', 'pe-section-head', el('span', 'pe-col-title', t('Profile settings'))));

    // Stop at weight
    host.appendChild(setting(t('Stop at weight'), t('Ends the whole shot at this weight in the cup. 0 means no weight stop.'),
        stepper({
            value: p.target_weight || 0,
            lim: FIELD_LIMITS.targetWeight,
            unit: 'g',
            title: t('Target Weight (g)'),
            fieldType: 'pe-target-weight',
            onChange: (val) => { p.target_weight = val; renderStats(); },
        })));

    // Stop at volume
    host.appendChild(setting(t('Stop at volume'), t('Ends the shot after this much water has been pushed through. 0 means no volume stop.'),
        stepper({
            value: p.target_volume || 0,
            lim: FIELD_LIMITS.targetVolume,
            unit: 'ml',
            title: t('Volume (ml)'),
            fieldType: 'pe-target-volume',
            onChange: (val) => { p.target_volume = val; renderStats(); },
        })));

    // Preinfusion ends after
    {
        const steps = p.steps || [];
        const countStart = p.target_volume_count_start || 0;
        const select = el('select', 'pe-select');
        select.setAttribute('aria-label', t('Preinfusion ends after'));

        const none = el('option', null, t('None'));
        none.value = '0';
        if (countStart === 0) none.selected = true;
        select.appendChild(none);

        steps.forEach((step, i) => {
            const opt = el('option', null, `${i + 1}. ${step.name || `${t('Step')} ${i + 1}`}`);
            opt.value = String(i + 1);
            if (countStart === i + 1) opt.selected = true;
            select.appendChild(opt);
        });

        select.addEventListener('change', () => { p.target_volume_count_start = parseInt(select.value, 10); });
        host.appendChild(setting(t('Preinfusion ends after'), t('Volume for the stop above only starts counting after this step.'), select));
    }

    // Beverage type
    {
        const select = el('select', 'pe-select');
        select.setAttribute('aria-label', t('Beverage type'));
        ['espresso', 'manual', 'cleaning'].forEach((type) => {
            const opt = el('option', null, t(type.charAt(0).toUpperCase() + type.slice(1)));
            opt.value = type;
            if (p.beverage_type === type) opt.selected = true;
            select.appendChild(opt);
        });
        select.addEventListener('change', () => { p.beverage_type = select.value; });
        host.appendChild(setting(t('Beverage type'), t('Groups the profile in the profile list.'), select));
    }

    // Notes
    {
        const preview = el('div', 'pe-notes');
        function paint() {
            const text = p.notes || '';
            preview.textContent = text || t('Tap to edit notes…');
            preview.classList.toggle('is-empty', !text);
        }
        paint();
        preview.addEventListener('click', () => {
            openNotesModal(p.notes || '', (newText) => { p.notes = newText; paint(); });
        });
        host.appendChild(setting(t('Notes'), t('Shown with the profile in the selector.'), preview));
    }

    // Author
    {
        const input = el('input', 'pe-input');
        input.type = 'text';
        input.value = p.author || '';
        input.setAttribute('aria-label', t('Author'));
        input.addEventListener('change', () => { p.author = input.value; });
        host.appendChild(setting(t('Author'), null, input));
    }

    // Advanced — folded away in a native <details>. These two settle how far the
    // limiter may overshoot before it clamps; almost nobody needs to touch them,
    // and at full size they read as important.
    {
        const steps = p.steps || [];
        const details = document.createElement('details');
        const summary = document.createElement('summary');
        summary.className = 'pe-set-label';
        summary.style.cursor = 'pointer';
        summary.style.padding = '14px 0';
        summary.textContent = t('Advanced');
        details.appendChild(summary);

        const barRange = parseFloat(steps.find(s => s.pump === 'flow')?.limiter?.range ?? 0.6);
        details.appendChild(setting(t('Limiter Tolerance (bar)'), t('How far over a pressure cap the machine may drift before clamping.'),
            stepper({
                value: barRange, lim: FIELD_LIMITS.limiterRange, unit: 'bar',
                title: t('Limiter tolerance'), fieldType: 'pe-lim-range-bar',
                onChange: (val) => {
                    (p.steps || []).forEach(step => {
                        if (step.pump === 'flow' && step.limiter) step.limiter.range = val;
                    });
                },
            })));

        const mlsRange = parseFloat(steps.find(s => s.pump === 'pressure')?.limiter?.range ?? 0.6);
        details.appendChild(setting(t('Limiter Tolerance (mL/s)'), t('Same, for a flow cap on a pressure-held step.'),
            stepper({
                value: mlsRange, lim: FIELD_LIMITS.limiterRange, unit: 'mL/s',
                title: t('Limiter tolerance'), fieldType: 'pe-lim-range-mls',
                onChange: (val) => {
                    (p.steps || []).forEach(step => {
                        if (step.pump === 'pressure' && step.limiter) step.limiter.range = val;
                    });
                },
            })));

        details.appendChild(setting(t('Tank Temperature (°c)'), t('Preheats the water tank before the shot. 0 leaves it alone.'),
            stepper({
                value: p.tank_temperature || 0, lim: FIELD_LIMITS.tankTemp, unit: '°C',
                title: t('Tank Temperature (°c)'), fieldType: 'pe-tank-temp',
                onChange: (val) => { p.tank_temperature = val; },
            })));

        host.appendChild(details);
    }

    // Start-from — only meaningful while creating a brand-new profile. Falsy,
    // not `=== null`: the selector's "add profile" record sets id: null but a
    // record arriving from anywhere else may simply omit it, and this has to
    // agree with _isNewProfileSession (which is `!profileRecord.id`) or cancel
    // would clean up imports the UI never offered.
    if (!editorState.sourceProfileId) {
        host.appendChild(el('div', 'pe-section-head', el('span', 'pe-col-title', t('Import'))));
        host.appendChild(setting(t('Upload Local File'), t('Load a .json profile from this device.'), buildUploadButton()));
        host.appendChild(setting(t('Import from Share Code'), t('Paste a 4-character Visualizer share code.'), buildShareImport()));
    }
}

function reloadEditorWithProfile(newProfile, sourceRecord) {
    // Track any server record created during a new-profile session so cancel can
    // delete it.
    if (_isNewProfileSession) {
        _hasImportedInSession = true;
        if (sourceRecord?.id && !_sessionImportedIds.includes(sourceRecord.id)) {
            _sessionImportedIds.push(sourceRecord.id);
        }
    }
    editorState.profile = normalizeLegacySteps(deepCopy(newProfile));
    editorState.sourceProfileRecord = sourceRecord || null;
    editorState.sourceProfileId = sourceRecord?.id || null;
    editorState.selectedStep = 0;
    _baselineProfileJson = JSON.stringify(editorState.profile);
    paintTitle();
    renderAll();
}

function buildUploadButton() {
    const btn = el('button', 'pe-btn', t('Upload Local File'));
    btn.type = 'button';
    btn.style.width = '100%';
    btn.addEventListener('click', () => {
        let fileInput = document.getElementById('pe-upload-input');
        if (!fileInput) {
            fileInput = document.createElement('input');
            fileInput.type = 'file';
            fileInput.id = 'pe-upload-input';
            fileInput.accept = '.json';
            fileInput.style.display = 'none';
            document.body.appendChild(fileInput);
        }
        fileInput.value = '';
        fileInput.onchange = async (e) => {
            const file = e.target.files[0];
            if (!file) return;
            try {
                const parsed = JSON.parse(await file.text());
                const validation = validateProfileStructure(parsed);
                if (!validation.isValid) throw new Error(validation.errorMessage);
                reloadEditorWithProfile(parsed, null);
                showToast(`${t('Loaded')}: ${parsed.title || t('Profile')}`, 2500, 'success');
            } catch (err) {
                showToast(`${t('Error')}: ${err.message}`, 4000, 'error');
            }
        };
        fileInput.click();
    });
    return btn;
}

function buildShareImport() {
    const wrap = el('div', null);
    const row = el('div', 'pe-row');

    const input = el('input', 'pe-input pe-code-input');
    input.type = 'text';
    input.maxLength = 4;
    input.placeholder = 'ABCD';
    input.setAttribute('aria-label', t('Import from Share Code'));
    input.addEventListener('input', () => { input.value = input.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); });

    const btn = el('button', 'pe-btn pe-btn--primary', t('Import'));
    btn.type = 'button';
    btn.style.minWidth = '140px';

    const status = el('p', 'pe-status');

    btn.addEventListener('click', async () => {
        const code = input.value.trim();
        if (code.length !== 4) {
            status.textContent = t('Enter a 4-character code.');
            return;
        }
        btn.disabled = true;
        // No ellipsis: the sheet carries 'Importing' (row 1813), not 'Importing…'.
        btn.textContent = t('Importing');
        status.textContent = '';
        try {
            const vizSettings = await getPluginSettings('visualizer.reaplugin');
            // Secure settings come back as { isSet } state, never plaintext (decaid #588).
            const password = vizSettings?.Password;
            const passwordSet = password == null ? false
                : typeof password === 'object' ? password.isSet === true
                : !!password; // legacy cleartext from older decaid
            const isConfigured = vizSettings?.Enabled !== false && !!(vizSettings?.Username && passwordSet);
            if (!isConfigured) {
                status.innerHTML = t('No Visualizer account found. Go to <strong>Settings → Extensions → Visualizer</strong> to log in first.');
                return;
            }
            const result = await callPluginEndpoint('visualizer.reaplugin', 'import', { shareCode: code });
            if (!result.success) {
                const msg = result.error || t('Import failed');
                const isAuthError = /credential|login|auth|unauthorized|password|username/i.test(msg);
                status.innerHTML = isAuthError
                    ? `${msg} — ${t('Go to <strong>Settings → Extensions → Visualizer</strong> to log in.')}`
                    : msg;
                return;
            }
            const { init: initPM, availableProfiles } = await import('./profileManager.js');
            await initPM();
            const rec = availableProfiles[result.profileId];
            if (!rec) throw new Error(t('Profile not found after import'));
            reloadEditorWithProfile(rec.profile, rec);
            showToast(`${t('Imported')}: ${rec.profile.title}`, 2500, 'success');
        } catch (err) {
            status.textContent = err.message;
        } finally {
            btn.disabled = false;
            btn.textContent = t('Import');
        }
    });

    row.append(input, btn);
    wrap.append(row, status);
    return wrap;
}

// ─── Whole-screen render ────────────────────────────────────────────────────

// Full repaint. Called only on structural changes (select / add / move /
// duplicate / delete / load) — never while a value is being typed, so it is
// safe for it to rebuild the shot-settings column too, whose "Preinfusion ends
// after" dropdown lists the steps by name and would otherwise go stale.
// Per-value edits use the lighter renderRail + renderPreview pair instead.
function renderAll() {
    const steps = editorState.profile.steps || [];
    editorState.selectedStep = clamp(editorState.selectedStep, 0, Math.max(0, steps.length - 1));
    renderRail();
    renderStepEditor();
    renderShotSettings();
    renderPreview();
}

// ─── Step-type picker ───────────────────────────────────────────────────────

function promptStepType() {
    return new Promise((resolve) => {
        const dlg = document.createElement('dialog');
        dlg.className = 'pe-dialog pe-pick';

        const body = el('div', 'pe-dialog-body');
        body.appendChild(el('h3', null, t('Insert a step')));
        body.appendChild(el('p', 'pe-hint', t('Pick what this step should do. You can change anything about it afterwards.')));

        const grid = el('div', 'pe-pick-grid');
        STEP_PRESETS.forEach((preset) => {
            const card = el('button', 'pe-pick-card', [
                el('div', 'pe-pick-name', t(preset.name)),
                el('div', 'pe-pick-desc', t(preset.desc)),
            ]);
            card.type = 'button';
            card.addEventListener('click', () => done(preset));
            grid.appendChild(card);
        });
        body.appendChild(grid);

        const cancel = el('button', 'pe-btn', t('Cancel'));
        cancel.type = 'button';
        cancel.addEventListener('click', () => done(null));
        body.appendChild(el('div', 'pe-dialog-actions', cancel));

        dlg.appendChild(body);

        function done(result) {
            try { dlg.close(); } catch (_) {}
            dlg.remove();
            resolve(result);
        }
        dlg.addEventListener('cancel', (e) => { e.preventDefault(); done(null); });

        document.body.appendChild(dlg);
        dlg.showModal();
    });
}

async function addStep() {
    const preset = await promptStepType();
    if (!preset) return;
    const steps = editorState.profile.steps || [];
    // New steps land after the selected one, which is where "and then…" belongs.
    const at = steps.length ? editorState.selectedStep + 1 : 0;
    insertStepAt(at, makeStepFromPreset(preset, steps[editorState.selectedStep]));
    editorState.selectedStep = at;
    renderAll();
}

// ─── Title ──────────────────────────────────────────────────────────────────

function paintTitle() {
    const text = document.getElementById('editor-title-text');
    if (text) text.textContent = editorState.profile.title || t('Untitled');
    const sub = document.getElementById('editor-subtitle');
    if (sub) {
        const author = editorState.profile.author;
        sub.textContent = editorState.sourceProfileId
            ? (author ? `${t('Author')}: ${author}` : '')
            : t('New profile');
    }
}

function initTitleEditing() {
    const display = document.getElementById('editor-title-display');
    const input = document.getElementById('editor-title-input');
    if (!display || !input) return;

    display.addEventListener('click', () => {
        display.classList.add('hidden');
        input.classList.remove('hidden');
        input.value = editorState.profile.title || '';
        input.focus();
        input.select();
    });

    function stop() {
        const val = input.value.trim();
        if (val) editorState.profile.title = val;
        input.classList.add('hidden');
        display.classList.remove('hidden');
        paintTitle();
    }

    input.addEventListener('blur', stop);
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
        if (e.key === 'Escape') { input.value = editorState.profile.title || ''; input.blur(); }
    });
}

// ─── Dialogs ────────────────────────────────────────────────────────────────

// Yes/no dialog. Replaces window.confirm, which renders as browser chrome
// inside the host webview.
function promptConfirm({ title, message, confirmLabel, cancelLabel }) {
    return new Promise((resolve) => {
        const dlg = document.createElement('dialog');
        dlg.className = 'pe-dialog';

        const body = el('div', 'pe-dialog-body');
        if (title) body.appendChild(el('h3', null, title));
        body.appendChild(el('p', null, message));

        const cancel = el('button', 'pe-btn', cancelLabel);
        cancel.type = 'button';
        const ok = el('button', 'pe-btn pe-btn--primary', confirmLabel);
        ok.type = 'button';
        body.appendChild(el('div', 'pe-dialog-actions', [cancel, ok]));
        dlg.appendChild(body);

        function done(result) {
            try { dlg.close(); } catch (_) {}
            dlg.remove();
            resolve(result);
        }
        cancel.addEventListener('click', () => done(false));
        ok.addEventListener('click', () => done(true));
        dlg.addEventListener('cancel', (e) => { e.preventDefault(); done(false); });

        document.body.appendChild(dlg);
        dlg.showModal();
    });
}

// Version picker. Returns the chosen ProfileRecord, or null on cancel. Picking
// a row selects it; Confirm applies it — restoring discards unsaved edits, so
// it must not happen on the tap that merely selects a row.
function promptVersionRestore(versions) {
    return new Promise((resolve) => {
        const dlg = document.createElement('dialog');
        dlg.className = 'pe-dialog';

        const body = el('div', 'pe-dialog-body');
        body.appendChild(el('h3', null, t('Version')));
        const rows = el('div', 'pe-dialog-rows');
        body.appendChild(rows);

        const cancel = el('button', 'pe-btn', t('Cancel'));
        cancel.type = 'button';
        const confirm = el('button', 'pe-btn pe-btn--primary', t('Confirm'));
        confirm.type = 'button';
        confirm.style.display = 'none';
        body.appendChild(el('div', 'pe-dialog-actions', [cancel, confirm]));
        dlg.appendChild(body);

        let selected = null;
        // Rows are built as DOM, not interpolated markup: the title is
        // user-supplied text.
        const rowBtns = versions.map((v) => {
            const when = new Date(v.createdAt);
            const stamp = isNaN(when.getTime()) ? '' : when.toLocaleString();
            const btn = el('button', 'pe-version-row', [
                el('div', 'pe-version-title', v.profile?.title || t('Untitled')),
                el('div', 'pe-version-stamp', stamp),
            ]);
            btn.type = 'button';
            btn.setAttribute('aria-pressed', 'false');
            btn.addEventListener('click', () => {
                selected = v;
                rowBtns.forEach((b) => {
                    const on = b === btn;
                    b.classList.toggle('is-on', on);
                    b.setAttribute('aria-pressed', String(on));
                });
                confirm.style.display = '';
            });
            rows.appendChild(btn);
            return btn;
        });

        function done(result) {
            try { dlg.close(); } catch (_) {}
            dlg.remove();
            resolve(result);
        }
        cancel.addEventListener('click', () => done(null));
        confirm.addEventListener('click', () => done(selected));
        dlg.addEventListener('cancel', (e) => { e.preventDefault(); done(null); });

        document.body.appendChild(dlg);
        dlg.showModal();
    });
}

// ─── Save / Cancel ──────────────────────────────────────────────────────────

// Presentation fields don't feed the execution hash — REA treats a change to
// only these as a metadata update (same id). Everything else is execution.
const PRESENTATION_FIELDS = ['title', 'author', 'notes'];
function executionChanged(orig, edited) {
    const strip = p => {
        const c = { ...p };
        PRESENTATION_FIELDS.forEach(k => delete c[k]);
        return JSON.stringify(c);
    };
    return strip(orig) !== strip(edited);
}

async function saveProfile() {
    if (!editorState.profile.title?.trim()) {
        showToast(t('Profile needs a name'), 3000, 'error');
        return;
    }
    if (!editorState.profile.steps?.length) {
        showToast(t('Add at least one step'), 3000, 'error');
        return;
    }

    // Creating a brand-new profile with nothing touched: saving would mint a
    // duplicate of the starting template. Keep the user in the editor and ask
    // for an edit instead of bouncing them back to the selector.
    // An import IS the change — saving a freshly uploaded/share-code profile
    // untouched is a real save, so it stays exempt.
    if (_isNewProfileSession && !_hasImportedInSession
        && JSON.stringify(editorState.profile) === _baselineProfileJson) {
        showToast(t('Change something before saving'), 3000, 'info');
        return;
    }

    try {
        const { updateProfile, uploadProfileWithParent, updateProfileVisibility } = await import('./api.js');
        const { availableProfiles, remapFavorite } = await import('./profileManager.js');

        // No-op save guard — if the profile is byte-identical to its source,
        // skip writing a new KV record. Prevents duplicating a default the user
        // opened but didn't actually modify.
        const sourceProfileJson = editorState.sourceProfileRecord?.profile
            ? JSON.stringify(editorState.sourceProfileRecord.profile)
            : null;
        if (sourceProfileJson && sourceProfileJson === JSON.stringify(editorState.profile)) {
            showToast(t('No changes to save'), 2000, 'info');
            if (editorState.sourceProfileId) {
                sessionStorage.setItem('lastEditedProfileKey', editorState.sourceProfileId);
            }
            setTimeout(() => { loadPage('src/profiles/profile_selector.html'); }, 500);
            return;
        }

        // Overwrite-in-place is the default: editing an existing user profile and
        // keeping its title updates the same record (no "(2)" cruft on a
        // draft→test→tweak loop). Renaming via the inline title editor is the
        // explicit save-as — titleChanged below routes it to a new record.
        const src = editorState.sourceProfileRecord;

        const sourceTitle = (src?.profile?.title || '').trim();
        const currentTitle = editorState.profile.title.trim();
        const titleChanged = sourceTitle && currentTitle !== sourceTitle;

        // Decide before stripping legacy fields (source still carries them too,
        // so the comparison is apples-to-apples).
        const execChanged = !src || executionChanged(src.profile, editorState.profile);

        // Auto-suffix title only when minting a NEW record (a save-as, a fresh
        // profile, or a default forked on execution change). An in-place PUT can
        // keep its own title, so exclude self from the collision set.
        const willCreateNew = !src || titleChanged || (src.isDefault && execChanged);
        const existingTitles = new Set(
            Object.values(availableProfiles)
                .filter(r => r.id !== src?.id)
                .map(r => r.profile?.title)
                .filter(Boolean)
        );
        let finalTitle = editorState.profile.title.trim();
        if (willCreateNew && existingTitles.has(finalTitle)) {
            let n = 2;
            while (existingTitles.has(`${finalTitle} (${n})`)) n++;
            finalTitle = `${finalTitle} (${n})`;
            editorState.profile.title = finalTitle;
            paintTitle();
        }

        // Legacy-field stripping + REA Profile-model adaptation happens at the
        // api.js write boundary (sanitizeProfileForRea), covering every path.
        //
        // Save routing (REA versioning model):
        //  - default + execution change → POST fork (PUT would be rejected); the
        //    default stays as the parent/reset point.
        //  - new profile or explicit save-as → POST (parentId links the source).
        //  - otherwise → PUT in place; the server keeps the id on a
        //    presentation-only change or rehashes it (deleting the old) on a
        //    user execution change.
        let saved;
        if (src?.isDefault && execChanged) {
            saved = await uploadProfileWithParent(editorState.profile, src.id);
        } else if (!src || titleChanged) {
            saved = await uploadProfileWithParent(editorState.profile, src?.id ?? null);
        } else if (execChanged) {
            // Overwrite of an existing user profile: keep the prior version as a
            // hidden, restorable snapshot instead of letting the server drop it on
            // rehash. The new record links back via parentId, so /lineage returns
            // the full history the Revert picker reads.
            try { await updateProfileVisibility(src.id, 'hidden'); } catch (_) {}
            saved = await uploadProfileWithParent(editorState.profile, src.id);
        } else {
            // Presentation-only change (title/author/notes) → same id, PUT in place.
            saved = await updateProfile(src.id, editorState.profile);
        }

        const oldId = editorState.sourceProfileId;
        availableProfiles[saved.id] = saved;

        // Only an in-place user PUT replaces the old hash — follow the favorite then.
        if (oldId && oldId !== saved.id && !src?.isDefault && !titleChanged) {
            delete availableProfiles[oldId];
            await remapFavorite(oldId, saved.id);
        }

        // Rebind editor to the saved record so repeat saves update in place.
        editorState.sourceProfileRecord = saved;
        editorState.sourceProfileId = saved.id;
        _baselineProfileJson = JSON.stringify(editorState.profile);

        // Hint to selector so it pre-selects the profile we just edited.
        sessionStorage.setItem('lastEditedProfileKey', saved.id);

        showToast(t('Profile saved!'), 2000, 'success');
        setTimeout(() => { loadPage('src/profiles/profile_selector.html'); }, 1000);
    } catch (err) {
        console.error('Profile save failed:', err);
        showToast(`${t('Save failed')}: ${err.message}`, 4000, 'error');
    }
}

async function cancelEditor() {
    if (_isNewProfileSession && _hasImportedInSession) {
        // Keep this exact message — it is the one already carried in the
        // translation sheet for this prompt. Confirming really does DELETE the
        // imported record from the server (deleteProfile below).
        const ok = await promptConfirm({
            message: t('Discard the imported profile? This cannot be undone.'),
            confirmLabel: t('Delete'),
            cancelLabel: t('Cancel'),
        });
        if (!ok) return;
    } else if (JSON.stringify(editorState.profile) !== _baselineProfileJson) {
        const ok = await promptConfirm({
            message: `${t('Undo changes')}?`,
            confirmLabel: t('Undo changes'),
            cancelLabel: t('Cancel'),
        });
        if (!ok) return;
    }
    if (_isNewProfileSession && _sessionImportedIds.length > 0) {
        try {
            const { deleteProfile } = await import('./api.js');
            const { availableProfiles } = await import('./profileManager.js');
            for (const id of _sessionImportedIds) {
                try { await deleteProfile(id); } catch (_) {}
                delete availableProfiles[id];
            }
        } catch (_) {}
    }
    // Back to the selector on the profile that was being edited, not to the main
    // page. Abandoning an edit is a decision about this profile — you are far
    // more likely to want another look at it, or a different profile, than to be
    // dropped on the shot screen. Same hint the save path uses, so the selector
    // opens on it and scrolls it into view.
    //
    // Skipped for a discarded new-profile session: the record was just deleted
    // above, so the hint would point at nothing and the selector would silently
    // fall back to its first entry anyway.
    if (editorState.sourceProfileId && !_isNewProfileSession) {
        sessionStorage.setItem('lastEditedProfileKey', editorState.sourceProfileId);
    }
    loadPage('src/profiles/profile_selector.html');
}

// ─── Version history / revert ────────────────────────────────────────────────

// Coerce legacy step shape onto the current Rea spec: prior versions persisted
// exit.type of 'weight'/'time'/'off' (not in spec) and stored both flow and
// pressure on every step. Applied when loading any saved profile so the UI never
// reads undefined EXIT_UNIT_MAP entries.
// Numeric fields also get coerced to actual numbers. Profiles in the de1app v2
// format carry them as STRINGS ("82.0", "7.5") — see any file in src/profiles —
// and one of those reaching roundTo() throws (`"82.0".toFixed` is not a
// function), taking the whole editor down on load rather than mis-rendering one
// value. Coercing here covers every entry point: fresh edit, restored version,
// uploaded file and share-code import all pass through this function.
const NUMERIC_STEP_FIELDS = ['temperature', 'pressure', 'flow', 'seconds', 'weight', 'volume'];
function num(value, fallback = 0) {
    const n = typeof value === 'number' ? value : parseFloat(value);
    return Number.isFinite(n) ? n : fallback;
}

function normalizeLegacySteps(profile) {
    if (Array.isArray(profile?.steps)) {
        for (const step of profile.steps) {
            if (step.pump === 'flow') delete step.pressure;
            else if (step.pump === 'pressure') delete step.flow;

            for (const key of NUMERIC_STEP_FIELDS) {
                if (step[key] !== undefined) step[key] = num(step[key]);
            }
            if (step.limiter) {
                step.limiter.value = num(step.limiter.value);
                step.limiter.range = num(step.limiter.range, 0.6);
                if (step.limiter.value === 0) step.limiter = null;
            }
            if (step.exit) {
                if (step.exit.type !== 'pressure' && step.exit.type !== 'flow') step.exit = null;
                else step.exit.value = num(step.exit.value);
            }
        }
    }
    if (profile) {
        for (const key of ['target_weight', 'target_volume', 'tank_temperature']) {
            if (profile[key] !== undefined) profile[key] = num(profile[key]);
        }
        if (profile.target_volume_count_start !== undefined) {
            profile.target_volume_count_start = Math.round(num(profile.target_volume_count_start));
        }
    }
    return profile;
}

async function openVersionHistory() {
    const id = editorState.sourceProfileId;
    if (!id) return;

    let lineage;
    try {
        const { getProfileLineage } = await import('./api.js');
        lineage = await getProfileLineage(id);
    } catch (err) {
        showToast(t('Could not load version history'), 3000, 'error');
        return;
    }

    // Prior versions = the chain minus the record we're editing, newest first.
    const versions = (lineage || [])
        .filter(r => r.id !== id && r.profile)
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    if (!versions.length) {
        showToast(t('No previous versions yet'), 2500, 'info');
        return;
    }

    const chosen = await promptVersionRestore(versions);
    if (!chosen) return;

    // Restoring replaces the whole in-memory profile, so any unsaved edits are
    // gone the instant a version is picked. (The server side is safe either way:
    // saving hides the prior version rather than deleting it, and it stays
    // restorable from this same picker.)
    if (JSON.stringify(editorState.profile) !== _baselineProfileJson) {
        const ok = await promptConfirm({
            message: `${t('Undo changes')}?`,
            confirmLabel: t('Undo changes'),
            cancelLabel: t('Cancel'),
        });
        if (!ok) return;
    }

    editorState.profile = normalizeLegacySteps(deepCopy(chosen.profile));
    editorState.selectedStep = 0;
    paintTitle();
    // Baseline deliberately not reset: a restored version is unsaved work, so
    // Cancel must still warn before throwing it away.
    renderAll();
    showToast(t('Restored — Save to keep this version'), 3000, 'success');
}

// ─── Init ───────────────────────────────────────────────────────────────────

export async function initializeProfileEditor() {
    // Profile arrives on a window global set by profile_selector.js / app.js.
    const profileRecord = window.__pendingEditProfile;
    if (!profileRecord) {
        console.warn('[ProfileEditor] No profile data on window.__pendingEditProfile — aborting.');
        showToast(t('No profile data found. Returning to selector.'), 3000, 'error');
        setTimeout(() => { loadPage('src/profiles/profile_selector.html'); }, 1000);
        return;
    }
    window.__pendingEditProfile = null;

    editorState.sourceProfileRecord = profileRecord;
    editorState.sourceProfileId = profileRecord.id;
    editorState.profile = normalizeLegacySteps(deepCopy(profileRecord.profile));
    editorState.selectedStep = 0;
    _baselineProfileJson = JSON.stringify(editorState.profile);
    _isNewProfileSession = !profileRecord.id;
    _sessionImportedIds = [];
    _hasImportedInSession = false;

    paintTitle();
    initTitleEditing();
    renderAll();

    document.getElementById('pe-add-step')?.addEventListener('click', addStep);

    const stepEditorHost = document.getElementById('pe-step-editor');
    if (stepEditorHost) attachPanelFocus(stepEditorHost);

    // Tap the curve to blow it up. Plotly owns the graph's innards, so the
    // handler goes on the container and the affordance is spelled out for
    // screen readers and keyboards rather than left to a hover cursor.
    const graphDiv = document.getElementById('pe-graph');
    if (graphDiv) {
        graphDiv.setAttribute('role', 'button');
        graphDiv.tabIndex = 0;
        graphDiv.setAttribute('aria-label', t('Zoom'));
        graphDiv.title = t('Zoom');
        graphDiv.addEventListener('click', openGraphZoom);
        graphDiv.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openGraphZoom(); }
        });
    }

    document.getElementById('editor-save-btn')?.addEventListener('click', saveProfile);
    document.getElementById('editor-cancel-btn')?.addEventListener('click', cancelEditor);

    // Version history — only for an already-saved, non-default profile.
    const historyBtn = document.getElementById('editor-history-btn');
    if (historyBtn) {
        historyBtn.addEventListener('click', openVersionHistory);
        if (editorState.sourceProfileId && !editorState.sourceProfileRecord?.isDefault) {
            historyBtn.classList.remove('hidden');
        }
    }

    // The graph is laid out inside a column that has just been inserted by the
    // router; one frame lets it take its real width before Plotly measures it.
    requestAnimationFrame(() => renderPreview());
}
