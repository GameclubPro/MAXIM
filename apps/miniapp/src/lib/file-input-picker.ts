export type FileInputActivationMode = 'native-tap' | 'programmatic';

export type FilePickerReturnState = {
  focusTarget: HTMLElement | null;
  scrollX: number;
  scrollY: number;
  scrollContainer: FilePickerScrollContainer | null;
  scrollLeft: number;
  scrollTop: number;
};

type FilePickerWindowScrollTarget = {
  scrollX: number;
  scrollY: number;
  scrollTo: (options: ScrollToOptions) => void;
};

type FilePickerScrollContainer = {
  isConnected?: boolean;
  scrollLeft: number;
  scrollTop: number;
  scrollTo?: (options: ScrollToOptions) => void;
};

export function resolveFileInputActivationMode(
  platform: string | null | undefined,
): FileInputActivationMode {
  return platform?.trim().toLowerCase() === 'android' ? 'native-tap' : 'programmatic';
}

export function openFileInputPicker(input: HTMLInputElement | null): 'shown' | 'clicked' | 'noop' {
  if (!input || input.disabled) {
    return 'noop';
  }

  if (typeof input.showPicker === 'function') {
    try {
      input.showPicker();
      return 'shown';
    } catch {
      // Fall back to click() for webviews with partial showPicker support.
    }
  }

  input.click();
  return 'clicked';
}

function isEditableReturnTarget(element: HTMLElement | null): boolean {
  if (!element) {
    return false;
  }
  const tagName = element.tagName.toLowerCase();
  return (
    element.isContentEditable ||
    tagName === 'textarea' ||
    (tagName === 'input' && (element as HTMLInputElement).type !== 'file')
  );
}

export function captureFilePickerReturnState(
  activeElement: Element | null = typeof document === 'undefined' ? null : document.activeElement,
  scrollTarget: Pick<FilePickerWindowScrollTarget, 'scrollX' | 'scrollY'> | null = typeof window ===
  'undefined'
    ? null
    : window,
  scrollContainer: FilePickerScrollContainer | null = null,
): FilePickerReturnState {
  const focusTarget =
    activeElement &&
    typeof (activeElement as HTMLElement).tagName === 'string' &&
    typeof (activeElement as HTMLElement).focus === 'function'
      ? (activeElement as HTMLElement)
      : null;
  return {
    focusTarget: isEditableReturnTarget(focusTarget) ? focusTarget : null,
    scrollX: scrollTarget?.scrollX ?? 0,
    scrollY: scrollTarget?.scrollY ?? 0,
    scrollContainer,
    scrollLeft: scrollContainer?.scrollLeft ?? 0,
    scrollTop: scrollContainer?.scrollTop ?? 0,
  };
}

export function restoreFilePickerReturnState(
  state: FilePickerReturnState | null,
  scrollTarget: FilePickerWindowScrollTarget | null = typeof window === 'undefined' ? null : window,
): boolean {
  if (!state) {
    return false;
  }

  const focusTarget = state.focusTarget;
  const restoredFocus = Boolean(focusTarget?.isConnected && isEditableReturnTarget(focusTarget));
  if (restoredFocus) {
    focusTarget?.focus({ preventScroll: true });
  }
  const scrollContainer = state.scrollContainer;
  if (scrollContainer && scrollContainer.isConnected !== false) {
    if (typeof scrollContainer.scrollTo === 'function') {
      scrollContainer.scrollTo({
        left: state.scrollLeft,
        top: state.scrollTop,
        behavior: 'auto',
      });
    } else {
      scrollContainer.scrollLeft = state.scrollLeft;
      scrollContainer.scrollTop = state.scrollTop;
    }
  }
  scrollTarget?.scrollTo({
    left: state.scrollX,
    top: state.scrollY,
    behavior: 'auto',
  });
  return restoredFocus;
}
