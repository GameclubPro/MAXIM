import type { BroadcastLinkButton } from '@maxim/contracts';
import { createEmptyBroadcastLinkButton } from '../../lib/broadcast-link-buttons';

function meaningfulButtons(buttons: readonly BroadcastLinkButton[]): BroadcastLinkButton[] {
  const emptyLabel = createEmptyBroadcastLinkButton().text;
  return buttons
    .map((button) => ({ text: button.text.trim(), url: button.url.trim() }))
    .filter((button) => button.url || (button.text && button.text !== emptyLabel));
}

export function havePublicationButtonsChanged(
  opening: readonly BroadcastLinkButton[],
  working: readonly BroadcastLinkButton[],
): boolean {
  return JSON.stringify(meaningfulButtons(opening)) !== JSON.stringify(meaningfulButtons(working));
}
