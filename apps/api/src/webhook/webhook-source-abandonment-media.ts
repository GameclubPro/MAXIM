import { isLegacyDirectMedia } from './webhook-legacy-direct-source';
import {
  isLegacyImageAttachment,
  isLegacyOpaqueSequence,
} from './webhook-legacy-content-primitives';
import { sourceAbandonmentHttpsUrl as httpsUrl } from './webhook-source-abandonment-markup';

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

export type SourceAbandonmentContentPurpose = 'SOURCE_ABANDONMENT' | 'PRISTINE_OPERATOR_DISCARD_V1';

export type SourceAbandonmentLinkedMediaRefusal =
  | 'array'
  | 'count'
  | 'item'
  | 'mixed'
  | 'other'
  | `${'image' | 'photo' | 'video' | 'audio' | 'share' | 'sticker'}_${'strict' | 'unproved'}`;

// FLAG: Diagnose only an already rejected linked-media guard. A strict passive
// family shape does not admit that family to forwards or pristine settlement.
// Bound the complete array before inspection; expose fixed codes, never values.
export function inspectSourceAbandonmentLinkedMediaRefusal(
  value: unknown,
): SourceAbandonmentLinkedMediaRefusal {
  if (!Array.isArray(value)) return 'array';
  if (value.length === 0 || value.length > 10) return 'count';
  const items = value.map(record);
  if (items.some((item) => !item)) return 'item';
  if (items.length !== 1)
    return new Set(items.map((item) => item?.type)).size > 1 ? 'mixed' : 'count';
  const item = items[0]!;
  switch (item.type) {
    case 'image':
    case 'photo':
      return `${item.type}_${isLegacyImageAttachment(item) ? 'strict' : 'unproved'}`;
    case 'video':
      return isLegacyDirectMedia(value) ? 'video_strict' : 'video_unproved';
    case 'audio':
      return isSourceAbandonmentDirectMedia(value, undefined) ? 'audio_strict' : 'audio_unproved';
    case 'share':
      return isSourceAbandonmentDirectMedia(value, undefined) ? 'share_strict' : 'share_unproved';
    case 'sticker':
      return isSourceAbandonmentLinkedMedia(value, 'reply', 'SOURCE_ABANDONMENT')
        ? 'sticker_strict'
        : 'sticker_unproved';
    default:
      return 'other';
  }
}

// FLAG: A linked attachment is passive source content, never an additional held
// message or actor. Only explicit source abandonment admits one strict reply audio;
// automatic pristine discard keeps its v6 shapes. No mixtures, nested payloads,
// downloads or inferred missing attachment data are permitted.
export function isSourceAbandonmentLinkedMedia(
  value: unknown,
  relation: 'forward' | 'reply',
  purpose: SourceAbandonmentContentPurpose,
): boolean {
  if (value === undefined) return true;
  if (!Array.isArray(value) || value.length > 10) return false;
  if (value.every(isLegacyImageAttachment)) return true;
  if (value.length !== 1) return false;
  const item = record(value[0]);
  if (item?.type === 'video') return isLegacyDirectMedia(value);
  if (relation === 'reply' && item?.type === 'audio')
    return purpose === 'SOURCE_ABANDONMENT' && isSourceAbandonmentDirectMedia(value, undefined);
  if (relation === 'forward' && item?.type === 'share')
    return isSourceAbandonmentDirectMedia(value, undefined);
  if (relation !== 'reply' || item?.type !== 'sticker') return false;
  const payload = record(item.payload);
  return Boolean(
    onlyKeys(item, ['type', 'payload', 'width', 'height']) &&
    payload &&
    onlyKeys(payload, ['url', 'code']) &&
    httpsUrl(payload.url) &&
    typeof payload.code === 'string' &&
    payload.code.length > 0 &&
    payload.code.length <= 32768 &&
    ['width', 'height'].every(
      (key) =>
        typeof item[key] === 'number' &&
        Number.isSafeInteger(item[key]) &&
        item[key] > 0 &&
        item[key] <= 2147483647,
    ),
  );
}

// FLAG: Direct media reuses the finite legacy image/video validator without a
// linked message. Only the modern profile additionally accepts one official share
// preview. Neither family adds a target or fetch; mixed previews remain unproved.
export function isSourceAbandonmentDirectMedia(value: unknown, link: unknown): boolean {
  if (value === undefined || (Array.isArray(value) && value.length === 0)) return true;
  if (link !== undefined || !Array.isArray(value)) return false;
  if (isLegacyDirectMedia(value)) return true;
  if (value.length !== 1) return false;
  const item = record(value[0]);
  const payload = record(item?.payload);
  // FLAG: An audio URL/token and optional opaque MAX media id are passive
  // source metadata. Never download/transcribe it or infer another target.
  if (item?.type === 'audio')
    return Boolean(
      onlyKeys(item, ['type', 'payload']) &&
      payload &&
      onlyKeys(payload, ['url', 'token', 'id']) &&
      httpsUrl(payload.url) &&
      typeof payload.token === 'string' &&
      payload.token.length > 0 &&
      payload.token.length <= 32768 &&
      isLegacyOpaqueSequence(payload.id),
    );
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
