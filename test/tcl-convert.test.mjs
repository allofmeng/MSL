// The upload path on the receiver page (docs/share.html) turns a de1app .tcl
// profile into a v2 JSON profile with no skin and no middleware in the loop —
// so the conversion is checked here against the frame shape de1app writes.
// Sliced out of the HTML rather than imported: it is one self-contained page,
// not a module the skin ships.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../docs/share.html', import.meta.url), 'utf8');
const script = html.slice(html.indexOf('<script type="module">') + '<script type="module">'.length,
                          html.lastIndexOf('</script>'));
// Everything up to the DOM helpers is pure logic; the rest touches document.
const logic = script.slice(0, script.indexOf("const $ = (id) =>"));
const { tclToProfile, encodePayload, decodePayload, readProfileText } = await import(
    'data:text/javascript;base64,' + Buffer.from(logic).toString('base64'));

// One pressure frame, verbatim in de1app's key order — which is not the order
// this converter reads it in, and that is the point.
const FRAME = '{exit_if 1 flow 2.5 volume 0 max_flow_or_pressure 6 max_flow_or_pressure_range 0.6 '
    + 'transition smooth exit_flow_under 0 temperature 92.5 weight 0 name {Stored frame} pressure 9 '
    + 'pump pressure sensor coffee exit_type pressure_over exit_pressure_over 4 exit_flow_over 0 '
    + 'seconds 10 exit_pressure_under 0}';

const tcl = (extra = '', frames = `{${FRAME}}`) => `advanced_shot ${frames}
author Decent
settings_profile_type settings_2c
final_desired_shot_weight_advanced 36
final_desired_shot_volume_advanced 0
final_desired_shot_volume_advanced_count_start 2
profile_title {Test profile}
beverage_type espresso
tank_desired_water_temperature 0
${extra}`;

test('a de1app frame becomes a v2 step', () => {
    const { profile, warnings } = tclToProfile(tcl());
    assert.deepEqual(warnings, []);
    assert.equal(profile.title, 'Test profile');
    assert.equal(profile.author, 'Decent');
    assert.equal(profile.version, '2');
    assert.equal(profile.target_weight, 36);
    assert.equal(profile.target_volume_count_start, 2);
    assert.equal(profile.tank_temperature, 0);
    assert.deepEqual(profile.steps, [{
        name: 'Stored frame',
        pump: 'pressure',
        transition: 'smooth',
        sensor: 'coffee',
        temperature: 92.5,
        seconds: 10,
        volume: 0,
        weight: 0,
        pressure: 9,
        flow: 2.5,
        exit: { type: 'pressure', condition: 'over', value: 4 },
        limiter: { value: 6, range: 0.6 },
    }]);
});

test('exit_if 0 drops the exit condition, and an unset limiter is omitted', () => {
    const bare = FRAME.replace('exit_if 1', 'exit_if 0')
        .replace('max_flow_or_pressure 6', 'max_flow_or_pressure 0')
        .replace('max_flow_or_pressure_range 0.6', 'max_flow_or_pressure_range 0');
    const [step] = tclToProfile(tcl('', `{${bare}}`)).profile.steps;
    assert.equal('exit' in step, false);
    assert.equal('limiter' in step, false);
});

test('every frame is converted, in file order', () => {
    const second = FRAME.replace('{Stored frame}', '{Second frame}').replace('pump pressure', 'pump flow');
    const { profile } = tclToProfile(tcl('', `{${FRAME}} {${second}}`));
    assert.deepEqual(profile.steps.map((s) => [s.name, s.pump]),
        [['Stored frame', 'pressure'], ['Second frame', 'flow']]);
});

test('multi-line notes survive, braces and all', () => {
    const notes = 'profile_notes {First line\nsecond line: 12g in, 36g out\n}';
    assert.equal(tclToProfile(tcl(notes)).profile.notes, 'First line\nsecond line: 12g in, 36g out\n');
});

test('a slider profile converts, with a warning that its frames may be stale', () => {
    const { profile, warnings } = tclToProfile(tcl().replace('settings_2c', 'settings_2a'));
    assert.equal(profile.steps.length, 1);
    assert.match(warnings.join(' '), /simple \(slider\)/);
});

test('de1app beverage types are mapped onto the ones the machine knows', () => {
    assert.equal(tclToProfile(tcl().replace('beverage_type espresso', 'beverage_type tea')).profile.beverage_type,
        'pourover');
    const { profile, warnings } = tclToProfile(tcl().replace('beverage_type espresso', 'beverage_type latte'));
    assert.equal(profile.beverage_type, 'espresso');
    assert.match(warnings.join(' '), /Unknown beverage type/);
});

test('a file with no frames is rejected rather than converted to nothing', () => {
    assert.throws(() => tclToProfile('profile_title {Empty}\n'), /no advanced_shot frames/);
    assert.throws(() => tclToProfile(tcl('', '{}')), /no readable steps/);
});

test('a converted profile survives the share link round-trip', async () => {
    const { profile } = tclToProfile(tcl());
    assert.deepEqual((await decodePayload(await encodePayload(JSON.stringify(profile)))).profile, profile);
});

// The point of carrying the .tcl rather than the conversion: the reader can be
// handed the sender's own file back, which is the only thing de1app can read.
test('a .tcl link hands back the original file, byte for byte', async () => {
    const source = tcl();
    const decoded = await decodePayload(await encodePayload(source));
    assert.equal(decoded.tcl, source);
    assert.deepEqual(decoded.profile, tclToProfile(source).profile);
});

test('a payload is read as tcl or json by content, not by extension', () => {
    const source = tcl();
    assert.equal(readProfileText(source, 'That file').tcl, source);
    // Conversion warnings ride along, so a slider-profile caveat still reaches
    // the reader of a link rather than only whoever uploaded the file.
    assert.deepEqual(readProfileText(source, 'That file').warnings,
        tclToProfile(source).warnings);

    const json = JSON.stringify(tclToProfile(source).profile);
    assert.equal(readProfileText(json, 'That file').tcl, null);
});
