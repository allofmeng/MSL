import { test } from 'node:test';
import assert from 'node:assert/strict';

import { shouldUseBottomSheet } from '../src/modules/context-menu-layout.js';

// The bug: `.context-menu--bottom-sheet` pins the menu to left:12px/right:12px
// with max-width:none, which is right for a phone and absurd on the Decent
// tablet — a coarse-pointer screen ~1920px wide, where the menu stretched edge
// to edge. Only the profile selector hit it, because it is the one menu with
// enough actions to cross the threshold.
const TABLET = 1920;
const PHONE = 390;

test('the tablet gets an anchored popover, whatever the menu length', () => {
    for (const actions of [1, 3, 4, 7, 12]) {
        assert.equal(shouldUseBottomSheet(actions, true, TABLET), false, `${actions} actions`);
    }
});

test('a phone still gets the bottom sheet for a long menu', () => {
    // profile_selector: Hide + 5 favourite slots + Edit
    assert.equal(shouldUseBottomSheet(7, true, PHONE), true);
    assert.equal(shouldUseBottomSheet(4, true, PHONE), true);
});

test('a short menu stays a popover everywhere — it always fitted', () => {
    // index.html: Browse Profiles / Edit / Use Profile Defaults, and the
    // favourite button's Edit / Replace with / Clear button.
    assert.equal(shouldUseBottomSheet(3, true, PHONE), false);
    assert.equal(shouldUseBottomSheet(3, true, TABLET), false);
});

test('a mouse never gets the sheet, however narrow the window', () => {
    assert.equal(shouldUseBottomSheet(7, false, PHONE), false);
    assert.equal(shouldUseBottomSheet(7, false, TABLET), false);
});

test('the width cut-off sits between a large phone and a small tablet', () => {
    assert.equal(shouldUseBottomSheet(7, true, 700), true, 'inclusive at the boundary');
    assert.equal(shouldUseBottomSheet(7, true, 701), false);
});
