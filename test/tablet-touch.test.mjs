// Touch behaviour that is invisible on a mouse and only shows up on the tablet
// WebView MSL actually runs in. Source-text assertions: the wiring is DOM-bound,
// but the properties below have each been regressed once and are cheap to pin.
// Run: node --test test/tablet-touch.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const root = new URL('../', import.meta.url);
const read = path => readFileSync(new URL(path, root), 'utf8');

test('long press never cancels touchstart, so the strip can still pan', () => {
    // Regression guard for 1e11e73: preventDefault on touchstart kills the
    // WebView's own panning for the whole gesture, and every drag across the
    // favourites strip starts on a button. touchstart/touchmove stay passive and
    // only mousedown is cancelled; a finger past the slop marks the gesture a
    // scroll instead of a press.
    const ui = read('src/modules/ui.js');
    const helper = ui.slice(ui.indexOf('export function setupPressAndHold'), ui.indexOf('export function flashElement'));
    assert.ok(helper.length > 0, 'setupPressAndHold not found');
    assert.match(helper, /addEventListener\('touchstart', startPress, \{ passive: true \}\)/);
    assert.match(helper, /addEventListener\('touchmove', trackMove, \{ passive: true \}\)/);
    assert.match(helper, /addEventListener\('touchcancel'/);
    assert.match(helper, /Math\.hypot\([\s\S]*?PRESS_MOVE_SLOP/);
    const startPress = helper.slice(helper.indexOf('const startPress'), helper.indexOf('const trackMove'));
    assert.match(startPress, /if \(e\.type === 'mousedown'\) e\.preventDefault\(\)/);
    // Comments stripped: this block explains the rule at length in prose.
    const code = startPress.replace(/^\s*\/\/.*$/gm, '');
    assert.equal(
        (code.match(/preventDefault/g) || []).length, 1,
        'the mousedown guard must be the only preventDefault — touchstart stays passive',
    );
});

test('tablet menus use larger rows, bottom sheets and focus restoration', () => {
    const menu = read('src/modules/context-menu.js');
    const css = read('src/css/context-menu.css');
    assert.match(menu, /actionCount >= 4/);
    assert.match(menu, /anchor\.focus\(\{ preventScroll: true \}\)/);
    assert.match(css, /@media \(pointer: coarse\)[\s\S]*min-height: 60px/);
    assert.match(css, /context-menu--bottom-sheet/);
    assert.match(css, /#sub-categories-separator::after[\s\S]*width: 48px/);
});
