import {
  parseAdminForwardedModerationCommand,
  type AdminForwardedCommandSettings,
} from '../moderation/admin-forwarded-command.util';
import { isLegacyPassiveMarkup } from './webhook-legacy-direct-source';
import {
  isLegacyImageAttachment,
  isLegacyOpaqueSequence,
  legacyParsedTextMatches,
} from './webhook-legacy-forward-source';

export type SourceAbandonmentReplyRefusal =
  | 'source_reply_shape'
  | 'source_reply_text'
  | 'source_reply_command';

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
    : typeof value === 'string' && value.length > 0 && value === value.trim();
}

function httpsUrl(value: unknown): boolean {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 8192 ||
    value !== value.trim() ||
    Array.from(value).some((character) => {
      const code = character.charCodeAt(0);
      return code <= 32 || code === 127;
    })
  )
    return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch {
    return false;
  }
}

// FLAG: Modern link formatting decorates only the original bounded text. Its
// URL never supplies a secondary mutation target; mentions and unknown metadata
// remain refused. Bounds use JavaScript UTF-16 offsets, as the runtime text does.
export function isSourceAbandonmentMarkup(value: unknown, text: unknown): boolean {
  if (value === undefined) return true;
  if (!Array.isArray(value) || value.length > 64 || typeof text !== 'string') return false;
  return value.every((entry) => {
    if (isLegacyPassiveMarkup([entry], text)) return true;
    const item = record(entry);
    return Boolean(
      item &&
      item.type === 'link' &&
      onlyKeys(item, ['type', 'from', 'length', 'url']) &&
      typeof item.from === 'number' &&
      Number.isSafeInteger(item.from) &&
      item.from >= 0 &&
      typeof item.length === 'number' &&
      Number.isSafeInteger(item.length) &&
      item.length > 0 &&
      item.from + item.length <= text.length &&
      typeof item.url === 'string' &&
      item.url.length <= 2048 &&
      httpsUrl(item.url),
    );
  });
}

// FLAG: Only the modern exact-source exclusion profile accepts one official
// ShareAttachment preview. Its metadata adds no message, person or effect target;
// no URL is fetched, and unknown fields/media or combinations remain unproved.
export function isSourceAbandonmentDirectMedia(value: unknown, link: unknown): boolean {
  if (value === undefined || (Array.isArray(value) && value.length === 0)) return true;
  if (link !== undefined || !Array.isArray(value) || value.length !== 1) return false;
  const item = record(value[0]);
  const payload = record(item?.payload);
  return Boolean(
    item &&
    item.type === 'share' &&
    onlyKeys(item, ['type', 'payload', 'title', 'description', 'image_url']) &&
    payload &&
    onlyKeys(payload, ['url', 'token']) &&
    httpsUrl(payload.url) &&
    (payload.token === undefined ||
      payload.token === null ||
      (typeof payload.token === 'string' && payload.token.length <= 32768)) &&
    ['title', 'description'].every(
      (key) =>
        item[key] === undefined ||
        item[key] === null ||
        (typeof item[key] === 'string' && item[key].length <= 32768),
    ) &&
    (item.image_url === undefined || item.image_url === null || httpsUrl(item.image_url)),
  );
}

function body(value: unknown, images: boolean): Record<string, unknown> | null {
  const item = record(value);
  return item &&
    onlyKeys(item, ['mid', 'seq', 'text', 'attachments']) &&
    identity(item.mid) &&
    isLegacyOpaqueSequence(item.seq) &&
    typeof item.text === 'string' &&
    (item.attachments === undefined ||
      (Array.isArray(item.attachments) &&
        (item.attachments.length === 0 ||
          (images &&
            item.attachments.length <= 10 &&
            item.attachments.every(isLegacyImageAttachment)))))
    ? item
    : null;
}

// FLAG: Reply metadata belongs only to the modern source profile. The original
// outer chat/mid/author remain the sole excluded source. Quoted images are not
// visible source photos, and a linked sender/message never gains hold authority.
export function inspectSourceAbandonmentReplyText(
  update: Record<string, unknown>,
  settings?: AdminForwardedCommandSettings,
): SourceAbandonmentReplyRefusal | null {
  const raw = record(update.raw);
  const message = record(raw?.message);
  const normalized = record(update.message);
  const direct = body(message?.body, false);
  const link = record(message?.link);
  const linked = body(link?.message, true);
  const sender = record(link?.sender);
  if (
    !message ||
    !normalized ||
    !direct ||
    !link ||
    !linked ||
    !sender ||
    !onlyKeys(message, ['sender', 'recipient', 'timestamp', 'body', 'link']) ||
    !onlyKeys(link, ['type', 'sender', 'chat_id', 'message']) ||
    link.type !== 'reply' ||
    !identity(link.chat_id) ||
    !identity(sender.user_id) ||
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
      (key) => sender[key] !== undefined && sender[key] !== null && typeof sender[key] !== 'string',
    ) ||
    (sender.last_activity_time !== undefined &&
      sender.last_activity_time !== null &&
      (typeof sender.last_activity_time !== 'number' ||
        !Number.isSafeInteger(sender.last_activity_time))) ||
    typeof normalized.text !== 'string'
  )
    return 'source_reply_shape';

  // FLAG: Reparse the untouched original MAX payload; a reply's quoted text is
  // not composed into its normalized text. Never manufacture a forward or trim
  // independently to establish equivalence.
  if (!legacyParsedTextMatches(update)) return 'source_reply_text';
  for (const text of [direct.text, linked.text, normalized.text] as string[]) {
    try {
      if (
        /^[/$]/u.test(text.trim()) ||
        /^старт$/iu.test(text.trim()) ||
        parseAdminForwardedModerationCommand(text) ||
        (settings && parseAdminForwardedModerationCommand(text, settings))
      )
        return 'source_reply_command';
    } catch {
      return 'source_reply_command';
    }
  }
  return null;
}
