// Durable home for the user's UI preferences.
//
// Everything in localStorage (and IndexedDB) belongs to the WebView's origin:
// it is lost when Decaid is reinstalled, when its data directory is replaced,
// or when the skin ends up served from a different port. Decaid's KV store is
// a Hive box in the app's own data directory — the same place profiles and
// shots live, so it survives an app update, and Decaid's backup export walks
// every KV namespace, so these settings ride along in a backup too.
//
// The shape is deliberately dumb: localStorage stays the working copy that
// every existing synchronous `localStorage.getItem(...)` call site reads, and
// KV is a mirror behind it. On boot we pull the mirror down; on every write we
// push the key up. No new read API, no call-site changes.
//
// Own namespace, distinct from the two other KV homes this skin already uses:
// 'streamline-app' holds machine-tile last-values (steam duration, flush,
// hot water — persistSharedValue/readSharedValue in api.js) and 'streamline'
// is the legacy de1app-profile migration source that profileManager.js
// deletes keys out of once imported. Mixing UI prefs into either would be
// confusing even though the key names don't collide.

import { logger } from './logger.js';

export const SETTINGS_SYNC_NAMESPACE = 'streamline-settings';

// Preferences the user set on purpose and would have to hunt through Settings
// (or a long-press, or a first-run overlay) to restore. Machine-side settings
// are already Decaid's and are not mirrored here.
//
// Deliberately excluded:
//  - reaHostname: names the Decaid we are talking to, so it cannot come from it.
//  - visualizerUsername / visualizerPassword: the KV store answers over the
//    same LAN connection the whole skin already uses, but a credential is at
//    least confined to the WebView while it stays local-only. Not worth the
//    trade for skipping one re-login after a wipe.
//  - last-* tile values (steam duration/flow/temp, milk stop, flush, hot
//    water, brightness): already synced via persistSharedValue/readSharedValue
//    under 'streamline-app', a narrower per-key mirror built for those.
//  - preset lists (steam-time-presets-user etc.), favourite/profile caches,
//    scale device id, deviceLastConnected: bookkeeping and caches, not a
//    preference the user would describe as "a setting".
export const SYNCED_KEYS = [
    'language',
    'theme',
    'tempUnit',
    'uiZoom',
    'maxStretch',
    'keyboardBindings',
    'streamlineHelpHidden',
    'streamlineHelpLaunches',
    'screensaverEnabled',
    'screensaverCycleSeconds',
    'blackScreenSaver',
    'wakeLockEnabled',
    'waterTankUnit',
    'waterRefillLevel',
    'visualizerEnabled',
    'visualizerAutoUpload',
    'streamline.steamStopMode',
    'streamline.steamStopModeFallback',
    'streamline.cupWarmerTarget',
    'streamline.dye2Enabled',
    'streamline.dyeStripMode',
];

const synced = new Set(SYNCED_KEYS);

// Nothing may be written to KV until the durable copy has been READ at least
// once. This is the invariant that makes the mirror safe — losing it is
// exactly what wiped users' settings on a Decaid update in the upstream skin
// this was ported from:
//
// The WebView can come up while Decaid's webservice is still starting, so the
// hydrate read below fails. If localStorage was just emptied by an update,
// the app runs on stock defaults — and boot writes some of them straight back
// out (initI18n() writes `language` on every boot, the help overlay writes
// `streamlineHelpLaunches` on every boot). With the mirror armed and nothing
// hydrated, those defaults would push straight over the one copy that had
// survived: the setting would not just look reset for that session, the
// durable record of it would be destroyed, and the next boot would have
// nothing left to restore.
//
// A gate that only opens on a successful read fixes that at the source: a
// session that could not read KV simply never writes to it. Anything the user
// changes meanwhile is not lost — hydrate() seeds every key KV is missing from
// whatever localStorage holds at that point.
export function createWriteGate({ push: sendPush, drop: sendDrop }) {
    let open = false;
    return {
        // Called only after a hydrate has actually returned a remote snapshot.
        open() { open = true; },
        get isOpen() { return open; },
        push(key, value) { if (open) sendPush(key, value); },
        // Suppressed while closed for the same reason as push: a removeItem (or
        // a clear()) driven by wiped local storage must not delete the durable
        // copy we have not managed to read.
        drop(key) { if (open) sendDrop(key); },
    };
}

// Mirror writes to KV by wrapping Storage.prototype once, rather than editing
// every existing setItem call site. Writes are fire-and-forget: a settings
// change must never block on (or fail because of) the network.
export function installMirror(storageProto, push, drop) {
    if (storageProto.__streamlineMirrored) return;
    const { setItem, removeItem, clear } = storageProto;
    storageProto.setItem = function (key, value) {
        // A hot-path writer can call setItem with the same value over and
        // over — waterRefillLevel is written from the water-level websocket
        // handler, and Decaid's water-level frames carry it alongside a
        // per-notification current level, so an unchanged threshold would
        // otherwise be echoed to KV at BLE notification cadence. Push only on
        // a real change — the same equality idiom hydrate() uses below.
        const str = String(value);
        const changed = synced.has(key) && this.getItem(key) !== str;
        setItem.call(this, key, value);
        if (changed) push(key, str);
    };
    storageProto.removeItem = function (key) {
        removeItem.call(this, key);
        if (synced.has(key)) drop(key);
    };
    // clear() is a reset, and a reset the user asked for should clear the
    // durable copy too — otherwise the next boot hydrates it all back.
    storageProto.clear = function () {
        clear.call(this);
        for (const key of synced) drop(key);
    };
    storageProto.__streamlineMirrored = true;
    return () => { Object.assign(storageProto, { setItem, removeItem, clear }); delete storageProto.__streamlineMirrored; };
}

// Pull KV into localStorage, then push up anything KV does not have yet.
// KV wins on conflict: it is the copy that survived, and the local copy after
// a wipe is either absent or a stock default.
// `write` is the *unwrapped* setter — hydrating must not echo straight back to
// the server. Returns what changed, for the caller and for tests.
export async function hydrate(storage, remote, write, push) {
    const applied = {};
    const seeded = {};
    for (const key of SYNCED_KEYS) {
        const value = remote[key];
        const local = storage.getItem(key);
        if (value === undefined || value === null) {
            // Nothing durable yet — protect what this device already has.
            if (local !== null) { seeded[key] = local; push(key, local); }
            continue;
        }
        const str = String(value);
        if (local !== str) { write.call(storage, key, str); applied[key] = str; }
    }
    return { applied, seeded };
}

// How long to keep trying to reach Decaid in the background after the first
// read fails. The boot read itself is never retried inline: settingsReady
// gates app.js's first paint, so a machine with no Decaid at all (browser dev)
// must not pay for the wait.
const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 15000];

// Boot-time wiring. Kept out of hydrate()/installMirror() so the logic above
// stays testable without a DOM or a network.
async function boot() {
    // Imported here, not at the top: api.js pulls in DOM-touching modules, and
    // keeping this file importable on its own is what makes hydrate()/
    // installMirror() testable in isolation.
    const { getKVAll, setKVValue, deleteKVValue } = await import('./api.js');
    const { openDB, setSetting } = await import('./idb.js');

    const proto = window.Storage.prototype;
    const rawSetItem = proto.setItem;
    const gate = createWriteGate({
        push: (key, value) => setKVValue(SETTINGS_SYNC_NAMESPACE, key, value)
            .catch(e => logger.info(`settings push ${key} failed: ${e.message}`)),
        drop: (key) => deleteKVValue(SETTINGS_SYNC_NAMESPACE, key)
            .catch(e => logger.info(`settings drop ${key} failed: ${e.message}`)),
    });
    installMirror(proto, gate.push, gate.drop);

    // Apply a remote snapshot. Also used by the background retry below, so a
    // late restore behaves exactly like an on-time one.
    const apply = async (remote) => {
        const { applied } = await hydrate(
            localStorage, remote, rawSetItem,
            (key, value) => setKVValue(SETTINGS_SYNC_NAMESPACE, key, value).catch(() => {}),
        );
        // The read succeeded, so writing back is safe from here on.
        gate.open();

        // The theme was already applied by the inline script in index.html,
        // before this ran — re-apply it if KV disagreed.
        if (applied.theme) document.documentElement.setAttribute('data-theme', applied.theme);
        // i18n reads IndexedDB first and only falls back to localStorage, so a
        // stale IDB copy would outrank what was just hydrated. setSetting
        // rejects unless the DB is already open, and this runs before
        // initI18n opens it.
        if (applied.language) {
            await openDB().then(() => setSetting('language', applied.language)).catch(() => {});
        }
        if (applied.tempUnit) {
            await openDB().then(() => setSetting('tempUnit', applied.tempUnit)).catch(() => {});
        }

        if (Object.keys(applied).length) logger.info(`Restored settings from KV: ${Object.keys(applied).join(', ')}`);
        return applied;
    };

    try {
        await apply(await getKVAll(SETTINGS_SYNC_NAMESPACE));
        return;
    } catch (e) {
        // No Decaid yet. This is the update case: the WebView is up before the
        // webservice is listening. Boot on what localStorage has, keep the
        // gate shut so this session cannot overwrite the durable copy, and
        // keep trying in the background.
        logger.info(`settings hydrate deferred: ${e.message}`);
    }

    // Deliberately NOT awaited: settingsReady gates app.js's first paint, and a
    // device with no Decaid at all (browser dev) must not wait out the ladder
    // before the app is allowed to render.
    (async () => {
        for (const delay of RETRY_DELAYS_MS) {
            await new Promise(resolve => setTimeout(resolve, delay));
            let applied;
            try {
                applied = await apply(await getKVAll(SETTINGS_SYNC_NAMESPACE));
            } catch {
                continue;
            }
            // The page has already rendered in whatever language/unit boot fell
            // back to, so unlike the on-time path a write to IndexedDB alone is
            // not enough — re-apply what the user is looking at.
            if (applied.language) {
                await import('./i18n.js')
                    .then(({ setLanguage, getCurrentLanguage }) =>
                        getCurrentLanguage() === applied.language ? null : setLanguage(applied.language))
                    .catch(e => logger.info(`late language restore failed: ${e.message}`));
            }
            return;
        }
        logger.warn('Settings could not be restored from KV: Decaid never answered. '
            + 'This session will not write settings, so the durable copy stays intact.');
    })();
}

// Await this before reading any synced preference. Resolves either way — a
// hydrate failure must not stop the app booting.
export const settingsReady = typeof window === 'undefined'
    ? Promise.resolve()
    : boot().catch(e => { logger.warn('Settings hydrate failed', e); });
