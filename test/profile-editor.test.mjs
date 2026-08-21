// The two step properties the editor can misreport: an exit condition it cannot
// write, and the shape of a smooth transition on the review graph.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Sliced out of the source rather than imported: profile_editor.js pulls in
// router.js, which touches `window` at module scope.
const source = readFileSync(new URL('../src/modules/profile_editor.js', import.meta.url), 'utf8');
const pick = (pattern) => {
    const match = source.match(pattern);
    assert.ok(match, `no match for ${pattern}`);
    return match[0];
};
const { readExitDef, pushChannel } = new Function(`
    ${pick(/function readExitDef\(step\) \{[\s\S]*?\r?\n\}/)}
    ${pick(/function pushChannel\([\s\S]*?\r?\n\}/)}
    return { readExitDef, pushChannel };
`)();

test('an exit the editor cannot write reads as off', () => {
    assert.equal(readExitDef({}).on, false);
    assert.equal(readExitDef({ exit: null }).on, false);
    // Legacy type: the save path nulls it, so showing it would offer to edit a
    // condition that is about to be discarded.
    assert.equal(readExitDef({ exit: { type: 'temperature', value: 92 } }).on, false);
});

test('a real exit keeps its type, direction and value', () => {
    assert.deepEqual(readExitDef({ exit: { type: 'flow', condition: 'under', value: 1.5 } }),
        { on: true, type: 'flow', condition: 'under', value: 1.5 });
    // Direction defaults to over; a missing value is 0, not undefined.
    assert.deepEqual(readExitDef({ exit: { type: 'pressure' } }),
        { on: true, type: 'pressure', condition: 'over', value: 0 });
});

test('a smooth transition ramps across the whole frame, from the previous value', () => {
    const x = [], y = [];
    pushChannel(x, y, 10, 20, 3, 9, 'smooth');
    assert.deepEqual(x, [10, 20]);
    assert.deepEqual(y, [3, 9], 'must open at the previous value, not the target');
});

test('a fast transition steps at the frame boundary', () => {
    const x = [], y = [];
    pushChannel(x, y, 10, 20, 3, 9, 'fast');
    assert.deepEqual(y, [9, 9]);
});

test('the opening step distinguishes smooth from fast', () => {
    // The bug: step 1 has no previous trace point to slope up from, so the old
    // version plotted both the same.
    const smooth = [], fast = [];
    pushChannel([], smooth, 0, 10, 0, 6, 'smooth');
    pushChannel([], fast, 0, 10, 0, 6, 'fast');
    assert.notDeepEqual(smooth, fast);
});
