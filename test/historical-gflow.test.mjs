// The scale-sourced GFlow trace is gated on a phase that arrives on MACHINE
// frames, so the tracker is what lets a scale-only snapshot inherit it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPourPhaseTracker, isPourPhase } from '../src/modules/historical-gflow.js';

test('pour phases are the two the rest of the rebuild gates on', () => {
    assert.equal(isPourPhase('preinfusion'), true);
    assert.equal(isPourPhase('pouring'), true);
    assert.equal(isPourPhase('ending'), false);
    assert.equal(isPourPhase(undefined), false);
});

test('a scale-only frame inherits the last machine frame phase', () => {
    const phase = createPourPhaseTracker();
    assert.equal(phase.inPour, false);        // before any machine frame

    phase.observe('pouring');
    assert.equal(phase.inPour, true);
    phase.observe(undefined);                 // scale-only snapshot: no substate
    assert.equal(phase.inPour, true, 'must inherit, not reset');

    phase.observe('ending');
    assert.equal(phase.inPour, false);        // pour is over: no more GFlow samples
    phase.observe(undefined);
    assert.equal(phase.inPour, false);
});

test('observe reports the phase it just recorded', () => {
    const phase = createPourPhaseTracker();
    assert.equal(phase.observe('preinfusion'), true);
    assert.equal(phase.observe('ending'), false);
});
