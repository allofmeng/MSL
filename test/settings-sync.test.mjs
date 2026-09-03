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
        `${pick(/export async function readSharedValue\([\s\S]*?\r?\n\}/)}
         ${pick(/export async function resyncIfDrifted\([\s\S]*?\r?\n\}/)}
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

// ── Steam duration 0 = steam off, heater included ───────────────────────────
// rest_v1.yml: SteamSettings.duration "does not control steam-heater
// preheating" — only targetTemperature 0 does, and Decaid reads anything below
// 135 as off (de1_controller.dart). So the duration setter has to carry the
// heater with it.

// `remembered` is the KV record of the last enabled temperature; `machineTemp`
// is what the workflow currently holds.
function buildSteam(remembered, machineTemp = 150) {
    const kvWrites = [];
    const workflowWrites = [];
    const api = new Function(
        'logger', 'persistSharedValue', 'updateWorkflow', 'getWorkflow',
        'getValueFromStore', 'SETTINGS_NAMESPACE', 'openDB', 'getSetting',
        `${pick(/export const STEAM_DURATION_LAST_VALUE_KEY = .*;/)}
         ${pick(/export const STEAM_TEMP_LAST_VALUE_KEY = .*;/)}
         ${pick(/export async function readSharedValue\([\s\S]*?\r?\n\}/)}
         ${pick(/export async function setTargetSteamTemp\([\s\S]*?\r?\n\}/)}
         ${pick(/\nasync function steamHeaterFor\([\s\S]*?\r?\n\}/)}
         ${pick(/export async function setTargetSteamDuration\([\s\S]*?\r?\n\}/)}
         return { setTargetSteamDuration, setTargetSteamTemp };`,
    )(
        { warn() {}, error() {} },
        async (key, value) => { kvWrites.push([key, value]); },
        async (patch) => { workflowWrites.push(patch); },
        async () => ({ steamSettings: { targetTemperature: machineTemp } }),
        async () => remembered,
        'streamline-app',
        async () => {},
        async () => remembered,
    );
    return { api, kvWrites, workflowWrites };
}

test('duration 0 switches the heater off too', async () => {
    // Sending duration alone left the boiler heating for a user who had asked
    // for steam off.
    const { api, kvWrites, workflowWrites } = buildSteam(null, 150);
    await api.setTargetSteamDuration(0);
    assert.deepEqual(workflowWrites, [{ steamSettings: { duration: 0, targetTemperature: 0 } }]);
    // The temperature it was switched off from is remembered, not lost.
    assert.deepEqual(kvWrites, [['last-steam-duration', 0], ['last-steam-temp', 150]]);
});

test('re-arming steam restores the remembered temperature', async () => {
    const { api, workflowWrites } = buildSteam(150, 0);
    await api.setTargetSteamDuration(30);
    assert.deepEqual(workflowWrites, [{ steamSettings: { duration: 30, targetTemperature: 150 } }]);
});

test('with nothing remembered the machine keeps whatever temperature it has', async () => {
    const { api, workflowWrites } = buildSteam(null, 150);
    await api.setTargetSteamDuration(30);
    assert.deepEqual(workflowWrites, [{ steamSettings: { duration: 30 } }]);
});

test('an already-off machine has no temperature worth remembering', async () => {
    const { api, kvWrites } = buildSteam(null, 0);
    await api.setTargetSteamDuration(0);
    assert.deepEqual(kvWrites, [['last-steam-duration', 0]]);
});

test('only enabled steam temperatures are remembered', async () => {
    const on = buildSteam(null);
    await on.api.setTargetSteamTemp(155);
    assert.deepEqual(on.kvWrites, [['last-steam-temp', 155]]);
    assert.deepEqual(on.workflowWrites, [{ steamSettings: { targetTemperature: 155 } }]);

    const off = buildSteam(null);
    await off.api.setTargetSteamTemp(0);
    assert.deepEqual(off.kvWrites, []);
    assert.deepEqual(off.workflowWrites, [{ steamSettings: { targetTemperature: 0 } }]);
});
