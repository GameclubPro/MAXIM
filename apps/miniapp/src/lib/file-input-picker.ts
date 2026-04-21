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
