// Two behaviours in api.js that fail silently when broken, so they get the one
// check: a settings write must expire its read cache, and a display command sent
// while the socket is down must survive until it reopens.
//
// The functions are sliced out of the source and re-instantiated with stub
// dependencies rather than imported: api.js opens sockets at module scope.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const source = readFileSync(new URL('../src/modules/api.js', import.meta.url), 'utf8');
const pick = (pattern) => {
    const match = source.match(pattern);
    assert.ok(match, `no match for ${pattern}`);
    return match[0].replace('export ', '');
};

test('a settings write expires its read cache', async () => {
    const state = new Map();
    const fetch = async (url, options = {}) => {
        const method = options.method || 'GET';
        if (method === 'POST') state.set(url, JSON.parse(options.body).value);
        return { ok: true, json: async () => ({ value: state.get(url) ?? 'old' }) };
    };
    const api = new Function(
        'fetch', 'logger', 'API_BASE_URL', 'AbortController', 'setTimeout', 'clearTimeout',
        [
            pick(/(?:const|let) reatsettingscache = \{[\s\S]*?\r?\n\};/),
            pick(/(?:const|let) de1SettingsCache = \{[\s\S]*?\r?\n\};/),
            pick(/(?:const|let) de1AdvancedSettingsCache = \{[\s\S]*?\r?\n\};/),
            pick(/export async function getReaSettings\(\) \{[\s\S]*?\r?\n\}/),
            pick(/export async function setReaSettings\(settings\) \{[\s\S]*?\r?\n\}/),
            pick(/export async function getDe1Settings\(\) \{[\s\S]*?\r?\n\}/),
            pick(/export async function setDe1Settings\(settings\) \{[\s\S]*?\r?\n\}/),
            pick(/export async function getDe1AdvancedSettings\(\) \{[\s\S]*?\r?\n\}/),
            pick(/export async function setDe1AdvancedSettings\(settings\) \{[\s\S]*?\r?\n\}/),
            'return { getReaSettings, setReaSettings, getDe1Settings, setDe1Settings, getDe1AdvancedSettings, setDe1AdvancedSettings };',
        ].join('\n'),
    )(fetch, { info() {}, error() {}, warn() {} }, 'http://decaid/api/v1', AbortController, setTimeout, clearTimeout);

    for (const [get, set] of [
        [api.getReaSettings, api.setReaSettings],
        [api.getDe1Settings, api.setDe1Settings],
        [api.getDe1AdvancedSettings, api.setDe1AdvancedSettings],
    ]) {
        assert.equal((await get()).value, 'old');   // fills the cache
        await set({ value: 'new' });
        assert.equal((await get()).value, 'new');   // stale cache would answer 'old'
    }
});

test('a display command sent while the socket is down is delivered on open', () => {
    let readyState = 0; // CONNECTING
    const sent = [];
    const socket = {
        get readyState() { return readyState; },
        send(value) { sent.push(JSON.parse(value)); },
    };
    const start = source.indexOf('export function connectDisplayWebSocket');
    const end = source.indexOf('export function getDisplayWebSocket', start);
    assert.ok(start !== -1 && end !== -1);

    const { connectDisplayWebSocket, sendDisplayCommand } = new Function(
        'ReconnectingWebSocket', 'WebSocket', 'WS_PROTOCOL', 'reaHostname', 'REA_PORT',
        'logger', 'isWakeLockEnabled', 'enableWakeLock',
        [
            pick(/let displayWebSocket = null;/),
            pick(/let displayWebSocketReady = false;/),
            pick(/let pendingDisplayCommand = null;/),
            pick(/let lastDisplayState = null;/),
            pick(/const displayListeners = new Set\(\);/),
            source.slice(start, end).replaceAll('export ', ''),
            'return { connectDisplayWebSocket, sendDisplayCommand };',
        ].join('\n'),
    )(function () { return socket; }, { OPEN: 1 }, 'ws:', 'decaid', 8080,
      { error() {}, info() {}, warn() {} }, () => false, async () => {});

    connectDisplayWebSocket();
    sendDisplayCommand({ command: 'setBrightness', brightness: 0 });
    sendDisplayCommand({ command: 'setBrightness', brightness: 75 });
    assert.deepEqual(sent, []);

    readyState = 1; // OPEN
    socket.onopen();
    // Only the latest: brightness is a level, not an event to replay in order.
    assert.deepEqual(sent, [{ command: 'setBrightness', brightness: 75 }]);
});
