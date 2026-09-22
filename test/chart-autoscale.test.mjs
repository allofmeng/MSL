// Run: node --test test/chart-autoscale.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computeMainYMax, chartSizeFactors, scaleChartFont, CHART_FONT_MAX } from '../src/modules/chart-autoscale.js';

test('main chart Y stays 0..10 until a line goes over 10, then grows to a clean tick', () => {
    assert.equal(computeMainYMax([]), 10);
    assert.equal(computeMainYMax([[3, 9.9], [10]]), 10);   // exactly 10 does not grow
    assert.equal(computeMainYMax([[3, 10.3]]), 12);
    assert.equal(computeMainYMax([[1], [12.5, 4]]), 14);
    assert.equal(computeMainYMax([[31]]), 35);
});

test('chart size grows lines and fonts, fonts never pass 25, unknown level = normal', () => {
    assert.deepEqual(chartSizeFactors('nope'), chartSizeFactors('normal'));
    assert.equal(scaleChartFont(20, 1), 20);
    assert.equal(scaleChartFont(20, 1.15), 23);
    for (const base of [15, 16, 18, 20]) {
        assert.ok(scaleChartFont(base, chartSizeFactors('xlarge').font) <= CHART_FONT_MAX);
    }
    assert.equal(scaleChartFont(20, 1.3), 25);          // 26 clamped
    assert.equal(scaleChartFont(26, 1.3), 26);          // already-bigger legend never shrinks
    assert.ok(chartSizeFactors('xlarge').line > chartSizeFactors('large').line);
});
