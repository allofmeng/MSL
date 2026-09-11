// UI preferences must survive an app update: WebView storage (localStorage,
// IndexedDB) belongs to the WebView's origin and is gone after a reinstall or a
// data-directory swap, so src/modules/settingsSync.js mirrors them into
// Decaid's KV store and pulls them back on boot.
// Run: node --test test/settings-persistence.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { hydrate, installMirror, createWriteGate, SYNCED_KEYS, SETTINGS_SYNC_NAMESPACE } from '../src/modules/settingsSync.js';

// Stand-in for window.localStorage with a shared prototype to patch, matching
// the browser's Storage/Storage.prototype split.
function makeStorage(initial = {}) {
    class FakeStorage {
        constructor(data) { this._data = { ...data }; }
        getItem(key) { return key in this._data ? this._data[key] : null; }
        setItem(key, value) { this._data[key] = String(value); }
        removeItem(key) { delete this._data[key]; }
        clear() { this._data = {}; }
    }
    return { storage: new FakeStorage(initial), proto: FakeStorage.prototype };
}

test('a synced write is mirrored to KV, an unsynced one is not', () => {
    const { storage, proto } = makeStorage();
    const pushed = [], dropped = [];
    installMirror(proto, (k, v) => pushed.push([k, v]), k => dropped.push(k));

    storage.setItem('theme', 'dark');
    storage.setItem('reaHostname', '10.0.0.5');   // device-specific, never mirrored
    storage.removeItem('theme');

    assert.deepEqual(pushed, [['theme', 'dark']]);
    assert.deepEqual(dropped, ['theme']);
    assert.equal(storage.getItem('reaHostname'), '10.0.0.5', 'the real write still happens');
});

test('a repeated identical value is written locally but never re-pushed to KV', () => {
    // A hot-path writer (waterTank.js's per-frame websocket handler) can call
    // setItem with the same value on every frame. Only a real change should
    // reach the network — see decaid#816 (1400+ POSTs/session for an
    // unchanging waterRefillLevel, on the upstream skin this was ported from).
    const { storage, proto } = makeStorage();
    const pushed = [];
    installMirror(proto, (k, v) => pushed.push([k, v]), () => {});

    storage.setItem('waterRefillLevel', '15');
    storage.setItem('waterRefillLevel', '15');
    storage.setItem('waterRefillLevel', '15');

    assert.deepEqual(pushed, [['waterRefillLevel', '15']], 'only the first write is a real change');
    assert.equal(storage.getItem('waterRefillLevel'), '15', 'the local value is still current');
});

test('a genuine change is still pushed after repeats of the old value', () => {
    const { storage, proto } = makeStorage();
    const pushed = [];
    installMirror(proto, (k, v) => pushed.push([k, v]), () => {});

    storage.setItem('waterRefillLevel', '15');
    storage.setItem('waterRefillLevel', '15');
    storage.setItem('waterRefillLevel', '20');   // the user (or Decaid) actually changed it

    assert.deepEqual(pushed, [['waterRefillLevel', '15'], ['waterRefillLevel', '20']]);
});

test('credentials and the hostname stay out of the KV store', () => {
    // KV answers over the LAN (webui binds the WiFi address), localStorage does not.
    for (const key of ['visualizerPassword', 'visualizerUsername', 'reaHostname']) {
        assert.ok(!SYNCED_KEYS.includes(key), `${key} must not be mirrored`);
    }
    assert.notEqual(SETTINGS_SYNC_NAMESPACE, 'streamline',
        'that namespace is the legacy de1app migration source profileManager deletes keys out of');
    assert.notEqual(SETTINGS_SYNC_NAMESPACE, 'streamline-app',
        'that namespace holds machine-tile last-values with their own narrower mirror');
});

test('clear() also clears the durable copy', () => {
    // Otherwise a reset the user asked for comes straight back on the next boot.
    const { storage, proto } = makeStorage({ theme: 'dark' });
    const dropped = [];
    installMirror(proto, () => {}, k => dropped.push(k));
    storage.clear();
    assert.deepEqual(dropped.sort(), [...SYNCED_KEYS].sort());
});

test('the mirror installs once, so a second call cannot double-push', () => {
    const { storage, proto } = makeStorage();
    const pushed = [];
    installMirror(proto, (k, v) => pushed.push([k, v]), () => {});
    installMirror(proto, (k, v) => pushed.push([k, v]), () => {});
    storage.setItem('theme', 'dark');
    assert.equal(pushed.length, 1);
});

test('after a wipe, boot restores the settings from KV', async () => {
    const { storage, proto } = makeStorage();   // localStorage is empty: fresh install
    const pushed = [];
    const { applied, seeded } = await hydrate(
        storage,
        { theme: 'dark', language: 'de', streamlineHelpHidden: '1' },
        proto.setItem, (k, v) => pushed.push([k, v]),
    );

    assert.equal(storage.getItem('theme'), 'dark');
    assert.equal(storage.getItem('language'), 'de');
    assert.equal(storage.getItem('streamlineHelpHidden'), '1');
    assert.deepEqual(applied, { theme: 'dark', language: 'de', streamlineHelpHidden: '1' });
    assert.deepEqual(seeded, {}, 'nothing local to protect');
    assert.deepEqual(pushed, [], 'hydrating must not echo back to the server');
});

test('the first boot after install seeds KV from what this device has', async () => {
    // KV is empty and localStorage still holds the real settings — push them up
    // rather than treating the empty store as "no preferences".
    const { storage, proto } = makeStorage({ theme: 'dark', uiZoom: '1.2' });
    const pushed = [];
    const { applied, seeded } = await hydrate(storage, {}, proto.setItem, (k, v) => pushed.push([k, v]));

    assert.deepEqual(applied, {});
    assert.deepEqual(seeded, { theme: 'dark', uiZoom: '1.2' });
    assert.deepEqual(pushed, [['theme', 'dark'], ['uiZoom', '1.2']]);
    assert.equal(storage.getItem('theme'), 'dark', 'local values are left alone');
});

test('KV wins where the two disagree, and untouched keys are left alone', async () => {
    const { storage, proto } = makeStorage({ theme: 'light', uiZoom: '1.0' });
    const writes = [];
    const write = function (key, value) { writes.push(key); proto.setItem.call(this, key, value); };
    const { applied } = await hydrate(storage, { theme: 'dark', uiZoom: '1.0' }, write, () => {});

    assert.equal(storage.getItem('theme'), 'dark');
    assert.deepEqual(applied, { theme: 'dark' });
    assert.deepEqual(writes, ['theme'], 'a matching value must not be rewritten');
});

test('a KV value of null is treated as absent, not as a wipe', async () => {
    // The store answers 200 with null for a key it has never held.
    const { storage, proto } = makeStorage({ theme: 'dark' });
    const { applied, seeded } = await hydrate(storage, { theme: null }, proto.setItem, () => {});
    assert.equal(storage.getItem('theme'), 'dark');
    assert.deepEqual(applied, {});
    assert.deepEqual(seeded, { theme: 'dark' });
});

// ── The write gate ───────────────────────────────────────────────────────────
// The mirror must never write to KV before it has read it. Without this, a boot
// that could not reach Decaid (the WebView is up before the webservice is,
// which is exactly what an app update looks like) pushed post-wipe defaults
// over the one copy that had survived — so the settings were not merely reset
// for that session, the durable record of them was destroyed.

test('nothing reaches KV until a hydrate has actually read it', () => {
    const { storage, proto } = makeStorage();
    const pushed = [], dropped = [];
    const gate = createWriteGate({ push: (k, v) => pushed.push([k, v]), drop: k => dropped.push(k) });
    installMirror(proto, gate.push, gate.drop);

    // Boot on a wiped device with Decaid not answering: these are the writes
    // initI18n() and the help overlay make on every single startup.
    storage.setItem('language', 'en');
    storage.setItem('streamlineHelpLaunches', '1');
    storage.removeItem('theme');

    assert.deepEqual(pushed, [], 'a session that never read KV must not write to it');
    assert.deepEqual(dropped, [], 'nor delete from it');
    assert.equal(storage.getItem('language'), 'en', 'the local write still happens');
});

test('once the read succeeds the mirror writes through again', () => {
    const { storage, proto } = makeStorage();
    const pushed = [], dropped = [];
    const gate = createWriteGate({ push: (k, v) => pushed.push([k, v]), drop: k => dropped.push(k) });
    installMirror(proto, gate.push, gate.drop);

    storage.setItem('theme', 'dark');       // pre-hydrate, suppressed
    gate.open();
    storage.setItem('theme', 'light');      // post-hydrate, mirrored
    storage.removeItem('uiZoom');

    assert.equal(gate.isOpen, true);
    assert.deepEqual(pushed, [['theme', 'light']]);
    assert.deepEqual(dropped, ['uiZoom']);
});

test('a setting changed before a late hydrate is still seeded, not lost', async () => {
    // The gate drops the push, so the value only survives because hydrate()
    // seeds every key KV is missing from whatever localStorage holds by then.
    const { storage, proto } = makeStorage();
    const pushed = [];
    const gate = createWriteGate({ push: () => {}, drop: () => {} });
    installMirror(proto, gate.push, gate.drop);

    storage.setItem('uiZoom', '1.4');       // user changes it while KV is unreachable
    const { seeded } = await hydrate(storage, {}, proto.setItem, (k, v) => pushed.push([k, v]));

    assert.deepEqual(seeded, { uiZoom: '1.4' });
    assert.deepEqual(pushed, [['uiZoom', '1.4']]);
});

test('a late hydrate still lets KV win over a default written this session', async () => {
    // initI18n() writes language='en' on a wiped device before KV answers. That
    // write is a fallback, not a choice, so the restored value must beat it —
    // the documented "KV wins a conflict" rule, which is why the gate discards
    // pre-hydrate writes rather than replaying them afterwards.
    const { storage, proto } = makeStorage();
    const gate = createWriteGate({ push: () => {}, drop: () => {} });
    installMirror(proto, gate.push, gate.drop);

    storage.setItem('language', 'en');
    const { applied } = await hydrate(storage, { language: 'de' }, proto.setItem, () => {});

    assert.equal(storage.getItem('language'), 'de');
    assert.deepEqual(applied, { language: 'de' });
});

// ── Coverage integrity ───────────────────────────────────────────────────────
// Every synced key should be a literal string, or a *_KEY constant's value,
// that some module actually uses — this test exists to catch a typo'd key
// silently never syncing anything, and to be updated deliberately whenever a
// new persisted preference is added.
test('every synced key is an actual localStorage key somewhere in the skin', () => {
    const files = [
        'src/modules/app.js', 'src/modules/ui.js', 'src/modules/units.js',
        'src/modules/i18n.js', 'src/modules/helpOverlay.js', 'src/modules/cup-warmer.js',
        'src/modules/dyeStrip.js', 'src/modules/waterTank.js', 'src/modules/scaling.js',
        'src/modules/numpad-modal.js', 'src/settings/settings.js',
    ];
    const source = files.map(f => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')).join('\n');
    for (const key of SYNCED_KEYS) {
        assert.ok(source.includes(`'${key}'`), `"${key}" is in SYNCED_KEYS but no scanned file references it`);
    }
});
