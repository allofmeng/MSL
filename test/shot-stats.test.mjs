// Run: node --test test/shot-stats.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    computeShotStats, filterShotsByDays, shotAxisValue, AXIS_VARIABLES,
    shotAnnotation, shotsPerDay, bucketDays, rankedBarRows, sparklineSeries,
} from '../src/modules/shot-stats.js';

// Six shots spanning three weeks, deliberately covering: missing dose/yield
// fields, a bean-less shot, a non-numeric grinder setting, two shots sharing
// a bean/grinder/profile/steam combo (so "usual"/mode logic has something to
// pick), and two shots with measurements (for duration) alongside four
// without (list-only records, as /shots returns them).
function extractionMeasurements(startIso, endIso) {
    return [
        { machine: { timestamp: startIso, state: { substate: 'preparingForShot' } } }, // excluded: not extraction
        { machine: { timestamp: startIso, state: { substate: 'preinfusion' } } },
        { machine: { timestamp: endIso, state: { substate: 'pouring' } } },
    ];
}

const shots = [
    {
        id: 'shot-1',
        timestamp: '2026-09-01T08:00:00.000Z',
        annotations: { actualDoseWeight: 18, actualYield: 36, enjoyment: 8, drinkTds: 9.5, drinkEy: 21 },
        workflow: {
            context: { coffeeName: 'Red Brick', coffeeRoaster: 'Square Mile', grinderModel: 'Niche Zero', grinderSetting: '1.6' },
            profile: { title: 'D-Flow / default' },
            steamSettings: { targetTemperature: 160, flow: 1.5, duration: 50 },
        },
        measurements: extractionMeasurements('2026-09-01T08:00:00.000Z', '2026-09-01T08:00:28.000Z'),
    },
    {
        id: 'shot-2',
        timestamp: '2026-09-03T08:00:00.000Z',
        annotations: { actualDoseWeight: 18.4, actualYield: 38 },
        workflow: {
            context: { coffeeName: 'Red Brick', coffeeRoaster: 'Square Mile', grinderModel: 'Niche Zero', grinderSetting: '1.6' },
            profile: { title: 'D-Flow / default' },
            steamSettings: { targetTemperature: 160, flow: 1.5, duration: 50 },
        },
        measurements: extractionMeasurements('2026-09-03T08:00:00.000Z', '2026-09-03T08:00:32.000Z'),
    },
    {
        // No dose/yield/annotations at all -- should not pollute any average,
        // but must still count toward count/perWeek.
        id: 'shot-3',
        timestamp: '2026-09-08T08:00:00.000Z',
        workflow: { context: { coffeeName: 'Miel Rosa', coffeeRoaster: 'Coffee Collective' }, profile: { title: 'Londinium' } },
    },
    {
        // Bean-less shot: has dose/yield but no coffeeName -- must not appear
        // in beans[], and its non-numeric grinder setting must not crash mode/min-max.
        id: 'shot-4',
        timestamp: '2026-09-10T08:00:00.000Z',
        annotations: { actualYield: 40 },
        workflow: {
            context: { targetDoseWeight: 19, grinderModel: 'Niche Zero', grinderSetting: 'extra fine' },
            profile: { title: 'Londinium' },
        },
    },
    {
        id: 'shot-5',
        timestamp: '2026-09-14T08:00:00.000Z',
        annotations: { actualDoseWeight: 18.2, actualYield: 0 }, // yield 0 must not divide into a ratio
        workflow: { context: { coffeeName: 'Miel Rosa', coffeeRoaster: 'Coffee Collective' } },
    },
    {
        id: 'shot-6',
        timestamp: '2026-09-15T08:00:00.000Z',
        annotations: { actualDoseWeight: 18, actualYield: 37 },
        workflow: {
            context: { coffeeName: 'Miel Rosa', coffeeRoaster: 'Coffee Collective', grinderModel: 'Niche Zero', grinderSetting: '1.8' },
            profile: { title: 'Londinium' },
            steamSettings: { targetTemperature: 155, flow: 1.2, duration: 45 },
        },
    },
];

test('computeShotStats: counts, span and perWeek', () => {
    const stats = computeShotStats(shots);
    assert.equal(stats.count, 6);
    assert.equal(stats.firstDate.toISOString(), '2026-09-01T08:00:00.000Z');
    assert.equal(stats.lastDate.toISOString(), '2026-09-15T08:00:00.000Z');
    // Span is 14 days = 2 weeks exactly; 6 shots / 2 weeks = 3/week.
    assert.equal(stats.perWeek, 3);
});

test('computeShotStats: averages skip missing fields, never divide by a zero yield', () => {
    const stats = computeShotStats(shots);
    // dose present on shots 1,2,4(via targetDoseWeight),5,6 -> 5 values
    assert.equal(stats.avg.dose, (18 + 18.4 + 19 + 18.2 + 18) / 5);
    // yield present on shots 1,2,3(none),4,5(0),6 -> 1,2,4,5,6 = 5 values (0 counts as present)
    assert.equal(stats.avg.yield, (36 + 38 + 40 + 0 + 37) / 5);
    // ratio only computed when both dose>0 and yield>0 -> shots 1,2,4,6 (shot 5's yield is 0, excluded;
    // shot 3 has neither field).
    assert.equal(stats.ratioPoints.length, 4);
    assert.ok(Math.abs(stats.avg.ratio - ((36 / 18 + 38 / 18.4 + 40 / 19 + 37 / 18) / 4)) < 1e-9);
    assert.equal(stats.avg.rating, 8); // only shot-1 has enjoyment
    assert.equal(stats.avg.tds, 9.5);
    assert.equal(stats.avg.ey, 21);
});

test('computeShotStats: ratioPoints is newest-first, one entry per shot with a real ratio', () => {
    const stats = computeShotStats(shots);
    // newest-first among shots with dose>0 and yield>0: shot-6, shot-4, shot-2, shot-1
    // (shot-5 excluded: yield 0; shot-3 excluded: neither field present).
    assert.deepEqual(stats.ratioPoints, [
        { dose: 18, yield: 37 },
        { dose: 19, yield: 40 },
        { dose: 18.4, yield: 38 },
        { dose: 18, yield: 36 },
    ]);
});

test('computeShotStats: bean-less shots are excluded from beans[], "usual" is the mode', () => {
    const stats = computeShotStats(shots);
    const names = stats.beans.map((b) => b.name);
    assert.ok(!names.includes(undefined));
    assert.equal(stats.beans.length, 2); // "Red Brick" and "Miel Rosa" only -- shot-4 has no coffeeName
    const redBrick = stats.beans.find((b) => b.name === 'Red Brick');
    assert.equal(redBrick.count, 2);
    assert.equal(redBrick.roaster, 'Square Mile');
    assert.equal(redBrick.usualGrind, 1.6);
    assert.equal(redBrick.lastDate.toISOString(), '2026-09-03T08:00:00.000Z');
    const mielRosa = stats.beans.find((b) => b.name === 'Miel Rosa');
    assert.equal(mielRosa.count, 3);
    assert.equal(mielRosa.roaster, 'Coffee Collective');
});

test('computeShotStats: non-numeric grinder setting is dropped, not NaN', () => {
    const stats = computeShotStats(shots);
    const niche = stats.grinders.find((g) => g.model === 'Niche Zero');
    assert.equal(niche.count, 4); // shots 1,2,4,6 all mention the grinder
    // settings collected: 1.6, 1.6, 1.8 -- shot-4's "extra fine" is skipped entirely
    assert.equal(niche.min, 1.6);
    assert.equal(niche.max, 1.8);
    assert.equal(niche.usualSetting, 1.6);
    assert.ok(!Number.isNaN(niche.min) && !Number.isNaN(niche.max));
    // settingCounts: distinct-value histogram, ascending -- 1.6 (shots 1,2), 1.8 (shot 6).
    assert.deepEqual(niche.settingCounts, [{ value: 1.6, count: 2 }, { value: 1.8, count: 1 }]);
});

test('computeShotStats: profiles sorted by count, steam picks the most common combo', () => {
    const stats = computeShotStats(shots);
    assert.deepEqual(stats.profiles, [
        { title: 'Londinium', count: 3 },
        { title: 'D-Flow / default', count: 2 },
    ]);
    assert.equal(stats.steam.targetTemperature, 160);
    assert.equal(stats.steam.flow, 1.5);
    assert.equal(stats.steam.duration, 50);
    assert.equal(stats.steam.count, 2);
});

test('computeShotStats: duration only comes from shots with measurements, matches preinfusion+pouring span', () => {
    const stats = computeShotStats(shots);
    // shot-1: 28s, shot-2: 32s -- the other four have no measurements at all.
    assert.equal(stats.durationSampleSize, 2);
    assert.equal(stats.avg.duration, 30);
});

test('computeShotStats: a shot with measurements but no extraction samples contributes no duration', () => {
    const noExtraction = [{
        id: 'x',
        timestamp: '2026-01-01T00:00:00.000Z',
        measurements: [{ machine: { timestamp: '2026-01-01T00:00:00.000Z', state: { substate: 'preparingForShot' } } }],
    }];
    const stats = computeShotStats(noExtraction);
    assert.equal(stats.durationSampleSize, 0);
    assert.equal(stats.avg.duration, null);
});

test('computeShotStats: empty array returns the empty shape, nothing throws', () => {
    const stats = computeShotStats([]);
    assert.equal(stats.count, 0);
    assert.equal(stats.firstDate, null);
    assert.equal(stats.lastDate, null);
    assert.equal(stats.perWeek, 0);
    assert.deepEqual(stats.avg, { dose: null, yield: null, ratio: null, rating: null, tds: null, ey: null, duration: null });
    assert.equal(stats.durationSampleSize, 0);
    assert.deepEqual(stats.ratioPoints, []);
    assert.deepEqual(stats.beans, []);
    assert.deepEqual(stats.grinders, []);
    assert.deepEqual(stats.profiles, []);
    assert.equal(stats.steam, null);
});

test('computeShotStats: tolerates non-array input', () => {
    assert.equal(computeShotStats(null).count, 0);
    assert.equal(computeShotStats(undefined).count, 0);
});

test('filterShotsByDays: null means all history, no timestamp parsing at all', () => {
    const withJunkTimestamp = [{ id: 'a', timestamp: 'not a date' }, { id: 'b', timestamp: '2026-01-01T00:00:00.000Z' }];
    assert.deepEqual(filterShotsByDays(withJunkTimestamp, null), withJunkTimestamp);
    assert.deepEqual(filterShotsByDays(shots, null), shots);
});

test('filterShotsByDays: 7-day boundary is inclusive', () => {
    const now = new Date('2026-09-15T12:00:00.000Z');
    const sevenDaysAgo = new Date(now.getTime() - 7 * 86400000);
    const fixture = [
        { id: 'exactly-cutoff', timestamp: sevenDaysAgo.toISOString() },
        { id: 'one-ms-before-cutoff', timestamp: new Date(sevenDaysAgo.getTime() - 1).toISOString() },
        { id: 'well-within', timestamp: now.toISOString() },
        { id: 'well-outside', timestamp: '2026-01-01T00:00:00.000Z' },
    ];
    const result = filterShotsByDays(fixture, 7, now);
    assert.deepEqual(result.map((s) => s.id), ['exactly-cutoff', 'well-within']);
});

test('filterShotsByDays: 30-day range, invalid timestamps dropped, empty input', () => {
    const now = new Date('2026-09-15T12:00:00.000Z');
    const fixture = [
        { id: 'within-30', timestamp: new Date(now.getTime() - 10 * 86400000).toISOString() },
        { id: 'outside-30', timestamp: new Date(now.getTime() - 31 * 86400000).toISOString() },
        { id: 'bad-timestamp', timestamp: 'garbage' },
        { id: 'missing-timestamp' },
    ];
    const result = filterShotsByDays(fixture, 30, now);
    assert.deepEqual(result.map((s) => s.id), ['within-30']);

    assert.deepEqual(filterShotsByDays([], 7), []);
    assert.deepEqual(filterShotsByDays([], null), []);
    assert.deepEqual(filterShotsByDays(null, 7), []);
    assert.deepEqual(filterShotsByDays(undefined, null), []);
});

test('shotAxisValue: date/dose/yield/ratio', () => {
    const shot1 = shots.find((s) => s.id === 'shot-1');
    assert.equal(shotAxisValue(shot1, 'date'), Date.parse('2026-09-01T08:00:00.000Z'));
    assert.equal(shotAxisValue(shot1, 'dose'), 18);
    assert.equal(shotAxisValue(shot1, 'yield'), 36);
    assert.equal(shotAxisValue(shot1, 'ratio'), 2);

    const shot3 = shots.find((s) => s.id === 'shot-3'); // no dose/yield at all
    assert.equal(shotAxisValue(shot3, 'dose'), null);
    assert.equal(shotAxisValue(shot3, 'ratio'), null);

    const shot5 = shots.find((s) => s.id === 'shot-5'); // yield is 0
    assert.equal(shotAxisValue(shot5, 'ratio'), null);

    assert.equal(shotAxisValue({ timestamp: 'not a date' }, 'date'), null);
});

test('shotAxisValue: grind skips non-numeric settings and grinder-less shots', () => {
    const shot1 = shots.find((s) => s.id === 'shot-1');
    assert.equal(shotAxisValue(shot1, 'grind'), 1.6);

    const shot3 = shots.find((s) => s.id === 'shot-3'); // no grinderModel at all
    assert.equal(shotAxisValue(shot3, 'grind'), null);

    const shot4 = shots.find((s) => s.id === 'shot-4'); // grinderSetting: 'extra fine'
    assert.equal(shotAxisValue(shot4, 'grind'), null);
});

test('shotAxisValue: rating/tds/ey are null when the annotation is absent', () => {
    const shot1 = shots.find((s) => s.id === 'shot-1');
    assert.equal(shotAxisValue(shot1, 'rating'), 8);
    assert.equal(shotAxisValue(shot1, 'tds'), 9.5);
    assert.equal(shotAxisValue(shot1, 'ey'), 21);

    const shot2 = shots.find((s) => s.id === 'shot-2'); // no enjoyment/drinkTds/drinkEy
    assert.equal(shotAxisValue(shot2, 'rating'), null);
    assert.equal(shotAxisValue(shot2, 'tds'), null);
    assert.equal(shotAxisValue(shot2, 'ey'), null);
});

test('shotAxisValue: time reuses the duration calc, null without measurements', () => {
    const shot1 = shots.find((s) => s.id === 'shot-1'); // 28s of preinfusion+pouring
    assert.equal(shotAxisValue(shot1, 'time'), 28);

    const shot3 = shots.find((s) => s.id === 'shot-3'); // no measurements
    assert.equal(shotAxisValue(shot3, 'time'), null);
});

test('shotAxisValue: unknown key or missing shot returns null, never throws', () => {
    const shot1 = shots.find((s) => s.id === 'shot-1');
    assert.equal(shotAxisValue(shot1, 'nonsense'), null);
    assert.equal(shotAxisValue(null, 'dose'), null);
    assert.equal(shotAxisValue(undefined, 'date'), null);
});

test('AXIS_VARIABLES lists the nine plot variables, each with a key/label/unit', () => {
    assert.deepEqual(AXIS_VARIABLES.map((v) => v.key), [
        'date', 'dose', 'yield', 'ratio', 'grind', 'rating', 'tds', 'ey', 'time',
    ]);
    for (const v of AXIS_VARIABLES) {
        assert.equal(typeof v.label, 'string');
        assert.ok(v.unit === null || typeof v.unit === 'string');
    }
});

test('shotAnnotation: full shot -> every field populated', () => {
    const shot1 = shots.find((s) => s.id === 'shot-1');
    const a = shotAnnotation(shot1);
    assert.equal(a.date.toISOString(), '2026-09-01T08:00:00.000Z');
    assert.equal(a.profileTitle, 'D-Flow / default');
    assert.equal(a.beanName, 'Red Brick');
    assert.equal(a.beanRoaster, 'Square Mile');
    assert.equal(a.dose, 18);
    assert.equal(a.yield, 36);
    assert.equal(a.ratio, 2);
    assert.equal(a.duration, 28);
    assert.equal(a.rating, 8);
    assert.equal(a.tds, 9.5);
    assert.equal(a.ey, 21);
    assert.equal(a.grind, 1.6);
    assert.equal(a.notes, null); // fixture has no espressoNotes
});

test('shotAnnotation: sparse shot -> missing fields are null, notes trimmed and blank-string treated as absent', () => {
    const shot3 = shots.find((s) => s.id === 'shot-3'); // no dose/yield/annotations/measurements
    const a = shotAnnotation(shot3);
    assert.equal(a.profileTitle, 'Londinium');
    assert.equal(a.beanName, 'Miel Rosa');
    assert.equal(a.dose, null);
    assert.equal(a.yield, null);
    assert.equal(a.ratio, null);
    assert.equal(a.duration, null);
    assert.equal(a.rating, null);
    assert.equal(a.grind, null);
    assert.equal(a.notes, null);

    const withNotes = { ...shot3, annotations: { espressoNotes: '  Tastes great, a touch sour.  ' } };
    assert.equal(shotAnnotation(withNotes).notes, 'Tastes great, a touch sour.');

    const withBlankNotes = { ...shot3, annotations: { espressoNotes: '   ' } };
    assert.equal(shotAnnotation(withBlankNotes).notes, null);
});

test('shotsPerDay: fills zero-count gap days, oldest first', () => {
    const local = (y, m, d, h = 12) => new Date(y, m - 1, d, h).toISOString();
    const fixture = [
        { id: 'a', timestamp: local(2026, 9, 1) },
        { id: 'b', timestamp: local(2026, 9, 1, 18) }, // same day as 'a'
        { id: 'c', timestamp: local(2026, 9, 4) },     // 2 and 3 have no shots
    ];
    const days = shotsPerDay(fixture);
    assert.deepEqual(days.map((d) => d.date), ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04']);
    assert.deepEqual(days.map((d) => d.count), [2, 0, 0, 1]);
    assert.deepEqual(days[0].shotIds, ['a', 'b']);
    assert.deepEqual(days[1].shotIds, []);
    assert.deepEqual(days[3].shotIds, ['c']);
});

test('shotsPerDay: buckets by LOCAL calendar day, not UTC', () => {
    // Constructed via the local-time Date constructor, so these are
    // unambiguously different local calendar days regardless of which TZ
    // this test happens to run in.
    const lateNight = new Date(2026, 8, 17, 23, 30); // Sep 17, 23:30 local
    const earlyNext = new Date(2026, 8, 18, 0, 10);  // Sep 18, 00:10 local
    const fixture = [
        { id: 'late', timestamp: lateNight.toISOString() },
        { id: 'early', timestamp: earlyNext.toISOString() },
    ];
    const days = shotsPerDay(fixture);
    assert.deepEqual(days.map((d) => d.date), ['2026-09-17', '2026-09-18']);
    assert.deepEqual(days.map((d) => d.count), [1, 1]);
});

test('shotsPerDay: single day, invalid timestamps dropped, empty/non-array input', () => {
    const single = shotsPerDay([{ id: 'x', timestamp: '2026-06-01T09:00:00.000Z' }]);
    assert.deepEqual(single, [{ date: single[0].date, count: 1, shotIds: ['x'] }]);

    const withJunk = shotsPerDay([{ id: 'x', timestamp: '2026-06-01T09:00:00.000Z' }, { id: 'bad', timestamp: 'garbage' }]);
    assert.equal(withJunk.length, 1);
    assert.equal(withJunk[0].count, 1);

    assert.deepEqual(shotsPerDay([]), []);
    assert.deepEqual(shotsPerDay(null), []);
    assert.deepEqual(shotsPerDay(undefined), []);
});

test('rankedBarRows: shares are relative to the top entry, Other sums whatever is past the limit', () => {
    const entries = [
        { title: 'A', count: 10 }, { title: 'B', count: 8 }, { title: 'C', count: 4 },
        { title: 'D', count: 2 }, { title: 'E', count: 1 }, { title: 'F', count: 1 },
    ];
    const { top, other } = rankedBarRows(entries, 5);
    assert.equal(top.length, 5);
    assert.deepEqual(top.map((e) => e.title), ['A', 'B', 'C', 'D', 'E']);
    assert.equal(top[0].share, 1); // top entry is always share 1
    assert.equal(top[1].share, 0.8); // 8/10
    assert.equal(top[2].share, 0.4); // 4/10
    assert.deepEqual(other, { count: 1, share: 0.1 }); // just 'F', 1/10
});

test('rankedBarRows: no limit (beans) never produces an Other bucket', () => {
    const entries = [{ name: 'X', count: 5 }, { name: 'Y', count: 1 }];
    const { top, other } = rankedBarRows(entries);
    assert.equal(top.length, 2);
    assert.equal(other, null);
});

test('rankedBarRows: nothing beyond the limit -> Other is null; empty/non-array input', () => {
    const entries = [{ title: 'Only', count: 3 }];
    assert.equal(rankedBarRows(entries, 5).other, null);

    const empty = rankedBarRows([], 5);
    assert.deepEqual(empty, { top: [], other: null });
    assert.deepEqual(rankedBarRows(null, 5), { top: [], other: null });
});

test('rankedBarRows: an all-zero-count list never divides by zero', () => {
    const { top, other } = rankedBarRows([{ title: 'Zero', count: 0 }], 5);
    assert.equal(top[0].share, 0);
    assert.equal(other, null);
});

test('sparklineSeries: chronological (oldest-first), skips shots without the value', () => {
    // shots fixture is oldest-first already (shot-1 .. shot-6); dose present
    // on 1,2,4(19 via targetDoseWeight),5,6 -- shot-3 has none.
    assert.deepEqual(sparklineSeries(shots, 'dose'), [18, 18.4, 19, 18.2, 18]);
    // rating only on shot-1 (8).
    assert.deepEqual(sparklineSeries(shots, 'rating'), [8]);
    // time only on shots with measurements: shot-1 (28s), shot-2 (32s).
    assert.deepEqual(sparklineSeries(shots, 'time'), [28, 32]);
});

test('sparklineSeries: invalid timestamps dropped, empty/non-array input', () => {
    const fixture = [
        { id: 'a', timestamp: 'garbage', annotations: { actualDoseWeight: 20 } },
        { id: 'b', timestamp: '2026-01-01T00:00:00.000Z', annotations: { actualDoseWeight: 18 } },
    ];
    assert.deepEqual(sparklineSeries(fixture, 'dose'), [18]);
    assert.deepEqual(sparklineSeries([], 'dose'), []);
    assert.deepEqual(sparklineSeries(null, 'dose'), []);
});

test('bucketDays: daily up to 60 bars, then weeks, then 30-day blocks; sums counts and ids', () => {
    const days = (n) => Array.from({ length: n }, (_, i) => ({ date: `d${i}`, count: 1, shotIds: [i] }));
    assert.equal(bucketDays(days(60)).size, 1);
    const weekly = bucketDays(days(61));
    assert.equal(weekly.size, 7);
    assert.equal(weekly.buckets.length, 9);
    assert.deepEqual(weekly.buckets[0], { date: 'd0', endDate: 'd6', count: 7, shotIds: [0, 1, 2, 3, 4, 5, 6] });
    assert.deepEqual(weekly.buckets[8], { date: 'd56', endDate: 'd60', count: 5, shotIds: [56, 57, 58, 59, 60] }); // partial last block
    const twoYears = bucketDays(days(730));
    assert.equal(twoYears.size, 30);
    assert.ok(twoYears.buckets.length <= 60 * 1 && twoYears.buckets.length === 25);
    assert.deepEqual(bucketDays([]), { size: 1, buckets: [] });
    assert.deepEqual(bucketDays(null), { size: 1, buckets: [] });
});
