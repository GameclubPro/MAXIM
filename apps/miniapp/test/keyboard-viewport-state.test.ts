import assert from 'node:assert/strict';
import test from 'node:test';
import {
  rebaseKeyboardViewportState,
  resolveKeyboardViewportState,
} from '../src/lib/keyboard-viewport-state';

const BASE_STATE = { baselineHeight: 800, baselineWidth: 400, keyboardOpen: false } as const;

test('keyboard viewport keeps its baseline through gradual Android adjustResize', () => {
  const opening = resolveKeyboardViewportState({
    ...BASE_STATE,
    currentHeight: 730,
    innerHeight: 730,
    visualOffsetTop: 0,
    editableFocused: true,
    keyboardThreshold: 96,
  });
  assert.deepEqual(opening, BASE_STATE);

  const opened = resolveKeyboardViewportState({
    ...opening,
    currentHeight: 620,
    innerHeight: 620,
    visualOffsetTop: 0,
    editableFocused: true,
    keyboardThreshold: 96,
  });
  assert.deepEqual(opened, { ...BASE_STATE, keyboardOpen: true });
});

test('keyboard viewport detects iOS visual occlusion and uses close hysteresis', () => {
  const opened = resolveKeyboardViewportState({
    ...BASE_STATE,
    baselineHeight: 520,
    currentHeight: 520,
    innerHeight: 800,
    visualOffsetTop: 72,
    editableFocused: true,
    keyboardThreshold: 96,
  });
  assert.equal(opened.keyboardOpen, true);

  const closing = resolveKeyboardViewportState({
    ...opened,
    currentHeight: 760,
    innerHeight: 800,
    visualOffsetTop: 0,
    editableFocused: true,
    keyboardThreshold: 96,
  });
  assert.equal(closing.keyboardOpen, false);
  assert.equal(closing.baselineHeight, 760);
});

test('keyboard viewport rebases when focus leaves without meaningful occlusion', () => {
  assert.deepEqual(
    resolveKeyboardViewportState({
      baselineHeight: 800,
      baselineWidth: 400,
      keyboardOpen: false,
      currentHeight: 760,
      innerHeight: 760,
      visualOffsetTop: 0,
      editableFocused: false,
      keyboardThreshold: 96,
    }),
    { baselineHeight: 760, baselineWidth: 400, keyboardOpen: false },
  );
});

test('keyboard viewport preserves its open state and baseline through a real blur', () => {
  const blurred = resolveKeyboardViewportState({
    ...BASE_STATE,
    keyboardOpen: true,
    currentHeight: 620,
    innerHeight: 620,
    visualOffsetTop: 0,
    editableFocused: false,
    keyboardThreshold: 96,
    preserveOnBlur: true,
  });
  assert.deepEqual(blurred, { ...BASE_STATE, keyboardOpen: true });

  const restored = resolveKeyboardViewportState({
    ...blurred,
    currentHeight: 800,
    innerHeight: 800,
    visualOffsetTop: 0,
    editableFocused: false,
    keyboardThreshold: 96,
  });
  assert.deepEqual(restored, BASE_STATE);
});

test('keyboard viewport keeps a not-yet-open baseline across editable focus handoff', () => {
  const transientBlur = resolveKeyboardViewportState({
    ...BASE_STATE,
    currentHeight: 730,
    innerHeight: 730,
    visualOffsetTop: 0,
    editableFocused: false,
    keyboardThreshold: 96,
    preserveOnBlur: true,
  });
  assert.deepEqual(transientBlur, BASE_STATE);

  const nextEditable = resolveKeyboardViewportState({
    ...transientBlur,
    currentHeight: 620,
    innerHeight: 620,
    visualOffsetTop: 0,
    editableFocused: true,
    keyboardThreshold: 96,
  });
  assert.deepEqual(nextEditable, { ...BASE_STATE, keyboardOpen: true });
});

test('orientation rebase preserves an iOS overlay keyboard from visual occlusion', () => {
  const landscape = rebaseKeyboardViewportState({
    ...BASE_STATE,
    keyboardOpen: true,
    currentHeight: 250,
    currentWidth: 800,
    innerHeight: 400,
    visualOffsetTop: 0,
    editableFocused: true,
    keyboardThreshold: 96,
    preserveOpen: true,
  });
  assert.deepEqual(landscape, {
    baselineHeight: 250,
    baselineWidth: 800,
    keyboardOpen: true,
  });

  const keyboardClosed = resolveKeyboardViewportState({
    ...landscape,
    currentHeight: 400,
    innerHeight: 400,
    visualOffsetTop: 0,
    editableFocused: true,
    keyboardThreshold: 96,
  });
  assert.deepEqual(keyboardClosed, {
    baselineHeight: 400,
    baselineWidth: 800,
    keyboardOpen: false,
  });
});

test('orientation rebase closes when the rotated viewport is already restored', () => {
  assert.deepEqual(
    rebaseKeyboardViewportState({
      ...BASE_STATE,
      keyboardOpen: true,
      currentHeight: 400,
      currentWidth: 800,
      innerHeight: 400,
      visualOffsetTop: 0,
      editableFocused: true,
      keyboardThreshold: 96,
      preserveOpen: true,
    }),
    { baselineHeight: 400, baselineWidth: 800, keyboardOpen: false },
  );
});

test('orientation rebase preserves Android adjustResize until the viewport restores', () => {
  const landscape = rebaseKeyboardViewportState({
    ...BASE_STATE,
    keyboardOpen: true,
    currentHeight: 250,
    currentWidth: 800,
    innerHeight: 250,
    visualOffsetTop: 0,
    editableFocused: true,
    keyboardThreshold: 96,
    preserveOpen: true,
  });
  assert.deepEqual(landscape, {
    baselineHeight: 250,
    baselineWidth: 800,
    keyboardOpen: true,
  });

  assert.deepEqual(
    resolveKeyboardViewportState({
      ...landscape,
      currentHeight: 400,
      innerHeight: 400,
      visualOffsetTop: 0,
      editableFocused: true,
      keyboardThreshold: 96,
    }),
    { baselineHeight: 400, baselineWidth: 800, keyboardOpen: false },
  );
});

test('ordinary width changes rebase directly to their stable viewport', () => {
  assert.deepEqual(
    rebaseKeyboardViewportState({
      ...BASE_STATE,
      keyboardOpen: true,
      currentHeight: 700,
      currentWidth: 600,
      innerHeight: 700,
      visualOffsetTop: 0,
      editableFocused: true,
      keyboardThreshold: 96,
      preserveOpen: false,
    }),
    { baselineHeight: 700, baselineWidth: 600, keyboardOpen: false },
  );
});
