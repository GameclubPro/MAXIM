import {
  MARKETPLACE_BUTTON_DEFAULT_CAPTION,
  marketplaceButtonCaptionSchema,
  type MarketplaceButtonModule,
} from '@maxim/contracts/marketplace-integration';
import type { MaxMessageButton, MaxSendMessageOptions } from './max-client.service';
import { normalizeMaxInlineKeyboardButtons } from './max-inline-keyboard-layout';

/** Internal intent only: public request schemas must never accept this transport marker. */
export type MarketplacePublicationIntent = {
  purpose: 'PUBLICATION' | 'VK_IMPORT' | 'APPROVED_SUGGESTION' | 'GREETING' | 'MODERATION_NOTICE';
  entityId: string;
  module?: MarketplaceButtonModule;
};

export function withMarketplacePost(
  options: MaxSendMessageOptions = {},
  entityId: string,
): MaxSendMessageOptions {
  return { ...options, marketplacePublication: { purpose: 'PUBLICATION', entityId } };
}

/** Only authorized greeting/notice callers supply this internal intent. */
export function withMarketplaceModerationMessage(
  options: MaxSendMessageOptions | null | undefined,
  entityId: string,
  purpose: 'GREETING' | 'MODERATION_NOTICE',
  module?: MarketplaceButtonModule,
): MaxSendMessageOptions {
  const selectedModule = module ?? options?.marketplacePublication?.module;
  return {
    ...options,
    marketplacePublication: {
      purpose,
      entityId,
      ...(selectedModule ? { module: selectedModule } : {}),
    },
  };
}

export function marketplaceModuleForRule(rule: string): MarketplaceButtonModule {
  if (rule === 'LINK_BLOCKED') return 'LINKS';
  if (rule === 'PROFANITY') return 'PROFANITY';
  if (rule === 'COMMERCIAL_AD') return 'COMMERCIAL';
  if (rule === 'PHONE_NUMBER_BLOCKED') return 'PHONE_NUMBERS';
  if (rule === 'MESSAGE_BLOCKED_WORD' || rule === 'MESSAGE_BLOCKED_DOMAIN') return 'STOP_WORDS';
  if (
    [
      'MESSAGE_RATE_LIMIT',
      'MESSAGE_TOO_LONG',
      'MESSAGE_COUNT_LIMIT',
      'PHOTO_BLOCKED',
      'VIDEO_BLOCKED',
      'FILE_BLOCKED',
      'VOICE_BLOCKED',
      'FORWARDED_MESSAGE_BLOCKED',
      'PHOTO_RATE_LIMIT',
      'STICKER_RATE_LIMIT',
    ].includes(rule)
  )
    return 'MESSAGE_LIMITS';
  return 'OTHER_MODERATION';
}

export function isMarketplacePublicationTarget(
  chatId: string,
  intent: MarketplacePublicationIntent | undefined,
): boolean {
  return Boolean(
    intent &&
    /^-[1-9]\d{0,19}$/u.test(chatId) &&
    intent.entityId === chatId &&
    ['PUBLICATION', 'VK_IMPORT', 'APPROVED_SUGGESTION', 'GREETING', 'MODERATION_NOTICE'].includes(
      intent.purpose,
    ),
  );
}

function canonicalLink(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (
      url.protocol !== 'https:' ||
      url.hostname !== 'max.ru' ||
      url.port ||
      url.username ||
      url.password
    ) {
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
  caption = MARKETPLACE_BUTTON_DEFAULT_CAPTION,
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
    [{ type: 'link', text: marketplaceButtonCaptionSchema.parse(caption), url: identity }],
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

/** Append to the locked, already-preserved MAX payload without normalizing its existing fields. */
export function appendMarketplaceEditableAttachments(
  attachments: readonly Record<string, unknown>[],
  url: string,
  caption = MARKETPLACE_BUTTON_DEFAULT_CAPTION,
): {
  attachments: readonly Record<string, unknown>[];
  outcome: 'ADDED' | 'DUPLICATE' | 'KEYBOARD_FULL' | 'INVALID_LINK';
} {
  const identity = canonicalLink(url);
  if (!identity) return { attachments, outcome: 'INVALID_LINK' };
  const keyboards = attachments.filter((item) => item.type === 'inline_keyboard');
  // FLAG: Unknown/multiple keyboard envelopes must never be flattened just for optional UI.
  if (keyboards.length > 1) return { attachments, outcome: 'KEYBOARD_FULL' };
  const keyboard = keyboards[0];
  const payload = keyboard?.payload;
  if (keyboard && (!payload || typeof payload !== 'object' || Array.isArray(payload)))
    return { attachments, outcome: 'KEYBOARD_FULL' };
  const fields = (payload ?? {}) as Record<string, unknown>;
  const existing = fields.buttons ?? [];
  if (!Array.isArray(existing) || existing.some((row) => !Array.isArray(row)))
    return { attachments, outcome: 'KEYBOARD_FULL' };
  if (
    existing.some((row: unknown[]) =>
      row.some((value: unknown) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
        const button = value as Record<string, unknown>;
        return (
          button.type === 'link' &&
          typeof button.url === 'string' &&
          canonicalLink(button.url) === identity
        );
      }),
    )
  )
    return { attachments, outcome: 'DUPLICATE' };
  const buttons: unknown[] = [
    ...existing,
    [{ type: 'link', text: marketplaceButtonCaptionSchema.parse(caption), url: identity }],
  ];
  let trimmed = false;
  normalizeMaxInlineKeyboardButtons(buttons, {
    onTrimmed: () => {
      trimmed = true;
    },
  });
  if (trimmed) return { attachments, outcome: 'KEYBOARD_FULL' };
  const updated = { ...keyboard, type: 'inline_keyboard', payload: { ...fields, buttons } };
  return {
    attachments: keyboard
      ? attachments.map((item) => (item === keyboard ? updated : item))
      : [...attachments, updated],
    outcome: 'ADDED',
  };
}
