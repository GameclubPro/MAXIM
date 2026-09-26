export async function copyCommentText(text: string, owner: HTMLElement): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  // FLAG: The legacy selection stays inside the active dialog, never in the user's draft.
  const field = document.createElement('textarea');
  const previousFocus = document.activeElement;
  field.value = text;
  field.readOnly = true;
  field.tabIndex = -1;
  field.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;';
  owner.append(field);
  try {
    field.select();
    if (!document.execCommand('copy')) throw new Error('Clipboard unavailable');
  } finally {
    field.remove();
    if (previousFocus instanceof HTMLElement && previousFocus.isConnected)
      previousFocus.focus({ preventScroll: true });
  }
}
