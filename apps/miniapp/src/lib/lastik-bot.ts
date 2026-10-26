import type { MouseEvent } from 'react';
import { openMaxBotLink } from './max-bridge';

export const LASTIK_BOT_URL = 'https://max.ru/id613000037577_5_bot';

export function openLastikBot(event: MouseEvent<HTMLAnchorElement>) {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
    return;
  try {
    if (openMaxBotLink(LASTIK_BOT_URL) !== 'noop') event.preventDefault();
  } catch {
    // Keep the ordinary link available if the native bridge fails.
  }
}
