import type { MouseEvent } from 'react';
import { openMaxBotLinkAndClose } from './max-bridge';

export const PUBLIK_BOT_URL = 'https://max.ru/se14088825_bot';

export function openPublikBot(event: MouseEvent<HTMLAnchorElement>) {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
    return;
  }
  try {
    if (openMaxBotLinkAndClose(PUBLIK_BOT_URL)) {
      event.preventDefault();
    }
  } catch {
    // Leave ordinary anchor navigation available when the native bridge fails.
  }
}
