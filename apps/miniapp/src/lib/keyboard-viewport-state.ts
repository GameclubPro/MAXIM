export type KeyboardViewportState = {
  baselineHeight: number;
  baselineWidth: number;
  keyboardOpen: boolean;
};

type ResolveKeyboardViewportStateOptions = KeyboardViewportState & {
  currentHeight: number;
  innerHeight: number;
  visualOffsetTop: number;
  editableFocused: boolean;
  keyboardThreshold: number;
  preserveOnBlur?: boolean;
};

type RebaseKeyboardViewportStateOptions = KeyboardViewportState & {
  currentHeight: number;
  currentWidth: number;
  innerHeight: number;
  visualOffsetTop: number;
  editableFocused: boolean;
  keyboardThreshold: number;
  preserveOpen: boolean;
};

function resolveKeyboardCloseThreshold(keyboardThreshold: number): number {
  return Math.max(48, Math.round(keyboardThreshold * 0.45));
}

export function resolveKeyboardViewportState({
  baselineHeight,
  baselineWidth,
  keyboardOpen,
  currentHeight,
  innerHeight,
  visualOffsetTop,
  editableFocused,
  keyboardThreshold,
  preserveOnBlur = false,
}: ResolveKeyboardViewportStateOptions): KeyboardViewportState {
  const nextBaselineHeight = Math.max(baselineHeight, currentHeight);
  const viewportShrink = Math.max(0, nextBaselineHeight - currentHeight);
  const visualOcclusion = Math.max(0, innerHeight - (currentHeight + visualOffsetTop));
  const closeThreshold = resolveKeyboardCloseThreshold(keyboardThreshold);

  if (!editableFocused) {
    const viewportStillOccluded =
      viewportShrink > closeThreshold || visualOcclusion > closeThreshold;
    if ((keyboardOpen || preserveOnBlur) && viewportStillOccluded) {
      return { baselineHeight: nextBaselineHeight, baselineWidth, keyboardOpen };
    }
    return { baselineHeight: currentHeight, baselineWidth, keyboardOpen: false };
  }

  const nextKeyboardOpen = keyboardOpen
    ? viewportShrink > closeThreshold || visualOcclusion > closeThreshold
    : viewportShrink > keyboardThreshold || visualOcclusion > keyboardThreshold;

  return { baselineHeight: nextBaselineHeight, baselineWidth, keyboardOpen: nextKeyboardOpen };
}

export function rebaseKeyboardViewportState({
  baselineWidth,
  keyboardOpen,
  currentHeight,
  currentWidth,
  innerHeight,
  visualOffsetTop,
  editableFocused,
  keyboardThreshold,
  preserveOpen,
}: RebaseKeyboardViewportStateOptions): KeyboardViewportState {
  const closeThreshold = resolveKeyboardCloseThreshold(keyboardThreshold);
  const visualOcclusion = Math.max(0, innerHeight - (currentHeight + visualOffsetTop));
  const rotatedAdjustResizeOcclusion = Math.max(0, baselineWidth - currentHeight);
  const shouldPreserveOpen =
    preserveOpen &&
    keyboardOpen &&
    editableFocused &&
    (visualOcclusion > closeThreshold || rotatedAdjustResizeOcclusion > keyboardThreshold);

  return {
    baselineHeight: currentHeight,
    baselineWidth: currentWidth,
    keyboardOpen: shouldPreserveOpen,
  };
}
