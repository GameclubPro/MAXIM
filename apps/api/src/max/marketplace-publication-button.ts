import type { MaxMessageButton, MaxSendMessageOptions } from './max-client.service';
import { normalizeMaxInlineKeyboardButtons } from './max-inline-keyboard-layout';

/** Internal intent only: public request schemas must never accept this transport marker. */
export type MarketplacePublicationIntent = {
  purpose: 'PUBLICATION' | 'VK_IMPORT' | 'APPROVED_SUGGESTION';
  entityId: string;
};

export function withMarketplacePost(
  options: MaxSendMessageOptions = {},
  entityId: string,
): MaxSendMessageOptions {
  return { ...options, marketplacePublication: { purpose: 'PUBLICATION', entityId } };
}

export function isMarketplacePublicationTarget(
  chatId: string,
  intent: MarketplacePublicationIntent | undefined,
): boolean {
  return Boolean(
    intent &&
    /^-[1-9]\d{0,19}$/u.test(chatId) &&
    intent.entityId === chatId &&
    ['PUBLICATION', 'VK_IMPORT', 'APPROVED_SUGGESTION'].includes(intent.purpose),
  );
}

function canonicalLink(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.hostname !== 'max.ru' || url.username || url.password) {
      return null;
    }
    url.hash = '';
    url.searchParams.sort();
    return url.toString();
  } catch {
    return null;
  }
}

export function appendMarketplacePublicationButton(
  options: MaxSendMessageOptions,
  url: string,
): {
  options: MaxSendMessageOptions;
  outcome: 'ADDED' | 'DUPLICATE' | 'KEYBOARD_FULL' | 'INVALID_LINK';
} {
  const identity = canonicalLink(url);
  if (!identity) return { options, outcome: 'INVALID_LINK' };
  const original = options.buttons?.length
    ? options.buttons
    : options.button
      ? [[options.button]]
      : [];
  if (
    original.some((row) =>
      row.some((button) => button.type === 'link' && canonicalLink(button.url) === identity),
    )
  )
    return { options, outcome: 'DUPLICATE' };
  const rows: MaxMessageButton[][] = [
    ...original.map((row) => row.map((button) => ({ ...button }))),
    [{ type: 'link', text: 'Профиль на бирже', url: identity }],
  ];
  let trimmed = false;
  normalizeMaxInlineKeyboardButtons(rows, {
    onTrimmed: () => {
      trimmed = true;
    },
  });
  // FLAG: Optional marketplace UI must never evict an authored or managed dialog button.
  if (trimmed) return { options, outcome: 'KEYBOARD_FULL' };
  return { options: { ...options, buttons: rows }, outcome: 'ADDED' };
}
