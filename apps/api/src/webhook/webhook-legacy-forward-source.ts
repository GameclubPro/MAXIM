import type { AdminForwardedCommandSettings } from '../moderation/admin-forwarded-command.util';
import { parseAdminForwardedModerationCommand } from '../moderation/admin-forwarded-command.util';
import { isSourceAbandonmentLinkedMedia } from './webhook-source-abandonment-media';
import {
  isLegacyImageAttachment,
  isLegacyOpaqueSequence,
} from './webhook-legacy-content-primitives';
export {
  isLegacyImageAttachment,
  isLegacyOpaqueSequence,
} from './webhook-legacy-content-primitives';
import {
  isSourceAbandonmentMarkup,
  isSourceAbandonmentOuterMarkup,
} from './webhook-source-abandonment-markup';
import { WebhookParser } from './webhook.parser';
import { extractVisiblePhotoMessageContent } from '../moderation/photo-duplicate/photo-attachment-extractor';

export type LegacyForwardRefusal =
  | 'source_forward_shape'
  | 'source_forward_text'
  | 'source_forward_command'
  | 'source_forward_media';

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}
function identity(value: unknown): boolean {
  return typeof value === 'number'
    ? Number.isSafeInteger(value)
    : typeof value === 'string' && value.length > 0 && value.trim() === value;
}
function body(
  value: unknown,
  allowImages = false,
  markup?: (body: Record<string, unknown>) => boolean,
  media?: (attachments: unknown) => boolean,
): Record<string, unknown> | null {
  const item = record(value);
  return item &&
    onlyKeys(item, ['mid', 'seq', 'text', 'attachments', ...(markup ? ['markup'] : [])]) &&
    identity(item.mid) &&
    isLegacyOpaqueSequence(item.seq) &&
    typeof item.text === 'string' &&
    (!markup || markup(item)) &&
    (media
      ? media(item.attachments)
      : item.attachments === undefined ||
        (Array.isArray(item.attachments) &&
          (item.attachments.length === 0 ||
            (allowImages &&
              item.attachments.length <= 10 &&
              item.attachments.every(isLegacyImageAttachment)))))
    ? item
    : null;
}

// FLAG: Forward metadata is content provenance, never an additional held person
// or mutation target. One official flat LinkedMessage with text/strict images; no recursion,
// reply, markup, arbitrary metadata objects or inferred missing source bodies.
export function inspectLegacyForwardText(
  update: Record<string, unknown>,
  settings?: AdminForwardedCommandSettings,
): LegacyForwardRefusal | null {
  return inspectForwardText(update, settings, 'legacy');
}

// FLAG: Only modern exact-source holds may accept an omitted linked sender.
// The outer human remains mandatory; no quoted author is inferred or held, and
// an explicitly malformed/null sender never becomes missing metadata.
export function inspectSourceAbandonmentForwardText(
  update: Record<string, unknown>,
  settings?: AdminForwardedCommandSettings,
): LegacyForwardRefusal | null {
  return inspectForwardText(update, settings, 'source-abandonment');
}

function inspectForwardText(
  update: Record<string, unknown>,
  settings: AdminForwardedCommandSettings | undefined,
  profile: 'legacy' | 'source-abandonment',
): LegacyForwardRefusal | null {
  const raw = record(update.raw);
  const message = record(raw?.message);
  const normalized = record(update.message);
  const modern = profile === 'source-abandonment';
  const direct = body(
    message?.body,
    false,
    modern ? (item) => isSourceAbandonmentOuterMarkup(item, message?.link) : undefined,
  );
  const link = record(message?.link);
  const linked = body(
    link?.message,
    true,
    modern ? (item) => isSourceAbandonmentMarkup(item.markup, item.text) : undefined,
    modern ? (attachments) => isSourceAbandonmentLinkedMedia(attachments, 'forward') : undefined,
  );
  const sender = record(link?.sender);
  const omittedSender = profile === 'source-abandonment' && link?.sender === undefined;
  if (
    !raw ||
    !message ||
    !normalized ||
    !direct ||
    !link ||
    !linked ||
    (!sender && !omittedSender) ||
    !onlyKeys(message, ['sender', 'recipient', 'timestamp', 'body', 'link']) ||
    !onlyKeys(link, ['type', 'sender', 'chat_id', 'message']) ||
    link.type !== 'forward' ||
    !identity(link.chat_id) ||
    (sender &&
      (!identity(sender.user_id) ||
        !onlyKeys(sender, [
          'user_id',
          'name',
          'first_name',
          'last_name',
          'username',
          'is_bot',
          'avatar_url',
          'last_activity_time',
        ]) ||
        typeof sender.is_bot !== 'boolean' ||
        ['name', 'first_name', 'last_name', 'username', 'avatar_url'].some(
          (key) =>
            sender[key] !== undefined && sender[key] !== null && typeof sender[key] !== 'string',
        ) ||
        (sender.last_activity_time !== undefined &&
          sender.last_activity_time !== null &&
          (typeof sender.last_activity_time !== 'number' ||
            !Number.isSafeInteger(sender.last_activity_time))))) ||
    typeof normalized.text !== 'string' ||
    typeof update.botId !== 'string'
  )
    return 'source_forward_shape';

  if (
    Array.isArray(linked.attachments) &&
    linked.attachments.length > 0 &&
    linked.attachments.every(isLegacyImageAttachment)
  ) {
    const photos = extractVisiblePhotoMessageContent(message);
    if (photos.kind !== 'complete' || photos.content.images.length !== linked.attachments.length)
      return 'source_forward_media';
  }

  // FLAG: Reuse the actual parser, including whitespace collapse, case-insensitive
  // snippet deduplication and forward composition. Never equate arbitrary texts
  // by trimming or trust the submitted normalized text independently of raw MAX.
  if (!legacyParsedTextMatches(update)) return 'source_forward_text';

  // FLAG: A forward can name another moderation target or Karavan seller. Deny
  // commands in EVERY component as well as the composed text, before any claim,
  // lookup, audit or SEND; current settings alone cannot prove an old trigger absent.
  for (const text of [direct.text, linked.text, normalized.text] as string[]) {
    try {
      if (
        /^[/$]/u.test(text.trim()) ||
        /^старт$/iu.test(text.trim()) ||
        parseAdminForwardedModerationCommand(text) ||
        (settings && parseAdminForwardedModerationCommand(text, settings))
      )
        return 'source_forward_command';
    } catch {
      return 'source_forward_command';
    }
  }
  return null;
}

export function legacyParsedTextMatches(update: Record<string, unknown>): boolean {
  const raw = record(update.raw);
  const normalized = record(update.message);
  if (
    !raw ||
    !normalized ||
    typeof normalized.text !== 'string' ||
    typeof update.botId !== 'string'
  )
    return false;
  try {
    return (
      new WebhookParser().parse(raw, { botId: update.botId }).message?.text === normalized.text
    );
  } catch {
    return false;
  }
}
