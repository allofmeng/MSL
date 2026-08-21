// Machine-scoped tile values are backed by a KV record of what the user last
// set, replayed whenever Decaid's workflow disagrees. These are the two rules
// that make the record win without it re-arming things the user turned off.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';

const source = readFileSync(new URL('../src/modules/api.js', import.meta.url), 'utf8');
const pick = (pattern) => {
    const match = source.match(pattern);
    assert.ok(match, `no match for ${pattern}`);
    return match[0].replace('export ', '');
};

// Build the resync pair over a stubbed KV store.
function makeResync(stored) {
    return new Function(
        'getValueFromStore', 'SETTINGS_NAMESPACE', 'logger', 'openDB', 'getSetting', 'setStopAtTemperature',
        `${pick(/export async function resyncIfDrifted\([\s\S]*?\r?\n\}/)}
         ${pick(/export async function resyncMilkStopIfDrifted\([\s\S]*?\r?\n\}/)}
         const MILK_STOP_LAST_VALUE_KEY = 'last-milk-stop';
         return { resyncIfDrifted, resyncMilkStopIfDrifted };`,
    )(
        async (_ns, key) => stored[key],
        'streamline-app',
        { warn() {} },
        async () => {},
        async () => undefined,
        async (v) => { stored.pushed = v; },
    );
}

test('a workflow with no value at all still gets the remembered one', async () => {
    const pushed = [];
    const { resyncIfDrifted } = makeResync({ 'last-steam-duration': 45 });
    await resyncIfDrifted('last-steam-duration', undefined, (v) => pushed.push(v));
    await resyncIfDrifted('last-steam-duration', null, (v) => pushed.push(v));
    assert.deepEqual(pushed, [45, 45], 'a missing field is the strongest reason to push');
});

test('nothing remembered means the machine value stands', async () => {
    const pushed = [];
    const { resyncIfDrifted } = makeResync({});
    await resyncIfDrifted('last-steam-duration', 30, (v) => pushed.push(v));
    assert.deepEqual(pushed, []);
});

test('agreement pushes nothing', async () => {
    const pushed = [];
    const { resyncIfDrifted } = makeResync({ 'last-steam-duration': 30 });
    await resyncIfDrifted('last-steam-duration', 30, (v) => pushed.push(v));
    assert.deepEqual(pushed, []);
});

test('a milk stop that is switched off is not re-armed', async () => {
    // Off reads as 0 in the workflow. Without the armed-only guard the
    // remembered target would "drift" from it and be pushed back every boot.
    const stored = { 'last-milk-stop': 65 };
    const { resyncMilkStopIfDrifted } = makeResync(stored);
    await resyncMilkStopIfDrifted(0);
    assert.equal(stored.pushed, undefined);
    await resyncMilkStopIfDrifted(undefined);
    assert.equal(stored.pushed, undefined);
    // Armed but drifted: the remembered target wins.
    await resyncMilkStopIfDrifted(70);
    assert.equal(stored.pushed, 65);
});

test('the milk stop is clamped and only remembered while armed', async () => {
    const persisted = [];
    const sent = [];
    const { setStopAtTemperature } = new Function(
        'persistSharedValue', 'updateWorkflow', 'MILK_STOP_LAST_VALUE_KEY',
        `${pick(/export async function setStopAtTemperature\([\s\S]*?\r?\n\}/)}
         return { setStopAtTemperature };`,
    )(async (_k, v) => persisted.push(v), async (w) => sent.push(w), 'last-milk-stop');

    await setStopAtTemperature(85);   // stored under the old ceiling
    await setStopAtTemperature(65);
    await setStopAtTemperature(0);    // switched off
    assert.deepEqual(sent.map(w => w.steamSettings.stopAtTemperature), [80, 65, 0]);
    assert.deepEqual(persisted, [80, 65], 'off is not a temperature worth remembering');
});
