// Checks for the logic ported from upstream streamline-js v0.1.106–v0.1.110.
// Each test locks in the bug the port exists to prevent, not the shape of the
// code around it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { selectMilkProbeSensorId } from '../src/modules/steam-mode.js';
import { steamCoolEnoughToDescale, DESCALE_STEAM_MAX_C } from '../src/modules/machine.js';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

// --- milk probe: sensor bus, not the machine snapshot ----------------------
// MachineSnapshot has never carried milkTemperature, so the old feed resolved
// to undefined forever and the probe read as absent on every Bengle.

test('the probe is selected by its registered name, never a guessed id', () => {
    const sensors = [
        { id: 'de1-scale', info: { name: 'Bengle Load Cells' } },
        { id: 'abc-milkprobe', info: { name: 'Bengle Milk Probe' } },
    ];
    assert.equal(selectMilkProbeSensorId(sensors), 'abc-milkprobe');
});

test('no probe registered is null, never a fabricated id', () => {
    assert.equal(selectMilkProbeSensorId([]), null);
    assert.equal(selectMilkProbeSensorId(null), null);
    assert.equal(selectMilkProbeSensorId([{ id: 'x', info: { name: 'Felicita Arc' } }]), null);
    assert.equal(selectMilkProbeSensorId([{ info: { name: 'Bengle Milk Probe' } }]), null, 'entry with no id');
});

test('app.js feeds the probe from the sensor socket, not the snapshot frame', () => {
    const app = read('src/modules/app.js');
    assert.match(app, /updateMilkProbeFromSnapshot\(currentMilkProbeReading\(\)\)/);
    assert.doesNotMatch(app, /data\.milkTemperature/);
});

// --- descaling gate --------------------------------------------------------

test('a hot steam boiler blocks descaling, an unknown reading does not', () => {
    assert.equal(DESCALE_STEAM_MAX_C, 60);
    assert.equal(steamCoolEnoughToDescale(85), false);
    assert.equal(steamCoolEnoughToDescale(60), true, 'inclusive at the threshold');
    assert.equal(steamCoolEnoughToDescale(21), true);
    // Some machines never report one; blocking on it would make descaling
    // impossible, so unknown proceeds.
    assert.equal(steamCoolEnoughToDescale(null), true);
    assert.equal(steamCoolEnoughToDescale(undefined), true);
    assert.equal(steamCoolEnoughToDescale(NaN), true);
});

test('the descale flow cools the boiler itself and always puts the heater back', () => {
    const settings = read('src/settings/settings.js');
    const start = settings.match(/window\.startDescaling = async function\(\)[\s\S]*?\n {4}\};/)[0];
    // The cycle may only be requested after the gate has passed.
    assert.ok(
        start.indexOf('steamCoolEnoughToDescale') < start.indexOf("setMachineState('descaling')"),
        'descaling must not be started before the steam temperature is checked',
    );
    assert.equal(
        (settings.match(/setMachineState\('descaling'\)/g) || []).length, 1,
        'one entry point, so one gate',
    );
    // Every path that leaves after the heater was switched off has to restore it:
    // the cooldown failing or being cancelled, the user backing out of the start
    // confirmation, the start call failing, and the cycle finishing.
    assert.equal((start.match(/restoreSteamHeater\(\)/g) || []).length, 3);
    assert.match(start, /restoreSteamHeaterAfterCycle\(\)/);
    // The snapshot socket is opened first, so a boot straight onto ?page=settings
    // decides on a real reading instead of falling through as unknown.
    assert.match(settings, /ensureSnapshotSocket\(\);[\s\S]{0,400}steamTemperature\(\) === undefined/);
});

// --- old Android WebViews (pre-Chromium 92) --------------------------------
// Array.prototype.at() threw on every snapshot frame there, which is what
// stopped the live trace growing (upstream #72) and then stranded shot state.

test('no source file uses an API newer than the oldest WebView we support', () => {
    const files = [
        'src/modules/app.js', 'src/modules/chart.js', 'src/modules/ui.js',
        'src/modules/api.js', 'src/modules/shotData.js', 'src/modules/history.js',
        'src/modules/profile_editor.js', 'src/modules/profile_selector.js',
        'src/settings/settings.js',
    ];
    const banned = /\.at\(-?\d|structuredClone\(|Object\.hasOwn\(|\.findLast\(|\.toSorted\(|\.toReversed\(|Object\.groupBy\(/;
    for (const file of files) {
        const hit = read(file).split('\n').find(line => banned.test(line) && !line.trimStart().startsWith('//'));
        assert.equal(hit, undefined, `${file}: ${hit}`);
    }
});

// --- shot end survives a chart throw (upstream #73) ------------------------

test('shot state is cleared before the chart is finalized, and the finalize is guarded', () => {
    const app = read('src/modules/app.js');
    const branch = app.match(/shotEndedAt = Date\.now\(\);[\s\S]*?\n {8}\}/)[0];
    assert.ok(
        branch.indexOf('shotStartTime = null') < branch.indexOf('finalizeLiveChart'),
        'a throw in finalizeLiveChart must not leave shotStartTime set',
    );
    assert.match(branch, /try \{[\s\S]*finalizeLiveChart\(\);[\s\S]*\} catch/);
});

// --- profile save: the server's content-addressed dedup --------------------
// POST /profiles answers 201 with an EXISTING record when the execution hash
// collides. The overwrite branch then flipped that record visible and hid it
// again one line later — erasing the user's only copy.

test('every fork/save-as path checks for a deduped record before acting on it', () => {
    const editor = read('src/modules/profile_editor.js');
    const forks = editor.match(/saved = await uploadProfileWithParent\([^\n]*\n\s*(?:\/\/[^\n]*\n\s*)*if \(forkDeduped/g) || [];
    assert.equal(forks.length, 3, 'all three POST call sites must guard');
    const overwrite = editor.match(/A dedup here would return src itself[\s\S]*?updateProfileVisibility\(src\.id, 'hidden'\)/)[0];
    assert.ok(
        overwrite.indexOf('forkDeduped') < overwrite.indexOf("updateProfileVisibility(saved.id, 'visible')"),
        'the guard has to run before either visibility call',
    );
});
