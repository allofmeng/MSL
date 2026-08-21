// Both stop-reason paths used to report a profile that ran out of frames as
// "Stopped by weight". These are the orderings that fix depends on.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    classifyStopReason,
    canonicalStopReason,
    isAutonomousWeightStop,
    STOP_TARGET_WEIGHT,
    STOP_TARGET_VOLUME,
    STOP_PROFILE_ENDED,
    STOP_UNKNOWN,
} from '../src/modules/stop-reason.js';

// A 30 s profile, 36 g target: the ordinary setup where the yield is roughly
// what the profile already pours, so BOTH targets read as hit.
const fullLength = {
    totalS: 30, profileSeconds: 30, targetWeight: 36, finalWeight: 36.2, isScaleConnected: true,
};

test('a shot that ran the profile full length was ended by the profile', () => {
    assert.equal(classifyStopReason(fullLength), STOP_PROFILE_ENDED);
});

test('a weight stop cuts the shot short, and still reports as weight', () => {
    assert.equal(classifyStopReason({ ...fullLength, totalS: 21 }), STOP_TARGET_WEIGHT);
});

test('volume is not silenced when no weight target could explain the stop', () => {
    // Scale attached but no target yield: volume is the only target there is.
    assert.equal(classifyStopReason({
        totalS: 20, profileSeconds: 40, targetWeight: 0, targetVolume: 40, finalVolume: 39,
        isScaleConnected: true,
    }), STOP_TARGET_VOLUME);
    // With a weight target present, a volume match alongside it is coincidental.
    assert.equal(classifyStopReason({
        totalS: 20, profileSeconds: 40, targetWeight: 36, finalWeight: 10,
        targetVolume: 40, finalVolume: 39, isScaleConnected: true,
    }), STOP_UNKNOWN);
});

test('nothing reached, nothing claimed', () => {
    assert.equal(classifyStopReason({ totalS: 12, profileSeconds: 40, targetWeight: 36, finalWeight: 9,
        isScaleConnected: true }), STOP_UNKNOWN);
});

test('firmware stop-at-weight reads as weight only when the shot was cut short', () => {
    const ctx = { machineHasAutonomousSAW: true, isScaleConnected: true, weight: 36.2, targetWeight: 36 };
    // Ran to the end of the profile: time, even on a Bengle, even at target.
    assert.equal(canonicalStopReason('machineEnded', { ...ctx, totalS: 30, profileSeconds: 30 }),
        STOP_PROFILE_ENDED);
    // Cut short at the yield: the firmware stopped it.
    assert.equal(canonicalStopReason('machineEnded', { ...ctx, totalS: 21, profileSeconds: 30 }),
        STOP_TARGET_WEIGHT);
});

test('machineEnded without yield evidence is left alone', () => {
    // No scale, or nowhere near target: nothing licenses a weight claim.
    assert.equal(canonicalStopReason('machineEnded', {
        machineHasAutonomousSAW: true, isScaleConnected: false, weight: 36, targetWeight: 36,
        totalS: 21, profileSeconds: 30,
    }), 'machineEnded');
    assert.equal(canonicalStopReason('machineEnded', {
        machineHasAutonomousSAW: true, isScaleConnected: true, weight: 12, targetWeight: 36,
        totalS: 21, profileSeconds: 30,
    }), 'machineEnded');
});

test('every other wire reason passes through untouched', () => {
    for (const reason of ['targetWeight', 'targetVolume', 'apiStop', 'appStop', 'somethingNewer']) {
        assert.equal(canonicalStopReason(reason, { totalS: 30, profileSeconds: 30 }), reason);
    }
});

test('a weight claim needs a real number', () => {
    assert.equal(isAutonomousWeightStop(NaN, 36), false);
    assert.equal(isAutonomousWeightStop(null, 36), false);
    assert.equal(isAutonomousWeightStop(36, 0), false);
    assert.equal(isAutonomousWeightStop(33.5, 36), true); // 93% tolerance
});
