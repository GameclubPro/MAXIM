import { createHash } from 'node:crypto';
import {
  adaptMaxMessageNavigationView,
  adaptMaxWebhookNavigationView,
} from '../navigation/max-navigation-view.adapter';
import { extractClientClickableTextEvidence } from '../navigation/client-clickable-text.extractor';
import { extractNavigationEvidence } from '../navigation/navigation-evidence.extractor';
import type { NavigationTargetEvidence } from '../navigation/navigation-evidence.types';

export type MessageDuplicateCompareMode = 'MESSAGE' | 'TEXT';
export type DuplicateMediaKind = 'photo' | 'video' | 'audio' | 'file';
export type DuplicateMediaSource = {
  kind: DuplicateMediaKind;
  photoId: string | null;
  url: string | null;
  identity: string;
};

export type DuplicateMessageContent = {
  text: string;
  navigation: string[];
  navigationTargets: NavigationTargetEvidence[];
  actions: string[];
  media: DuplicateMediaSource[];
  complete: boolean;
  reason:
    | 'complete'
    | 'missing_message'
    | 'invalid_content'
    | 'content_limit'
    | 'unsupported_attachment'
    | 'split_album';
  sourceDigest: string;
};

const MAX_TEXT = 8_000;
const MAX_MEDIA = 10;
const MAX_ATTACHMENTS = 64;
const MAX_DEPTH = 8;
const MAX_ACTION_BYTES = 8_192;
const FORWARD_KEYS = [
  'forward',
  'forwarded',
  'forwarded_message',
  'forwarded_messages',
  'forwardedMessage',
  'forwardedMessages',
];
const BUTTON_KEYS = [
  'type',
  'text',
  'url',
  'payload',
  'web_app',
  'contact_id',
  'chat_title',
  'chat_description',
  'start_payload',
  'uuid',
];
const MEDIA_KINDS: Readonly<Record<string, DuplicateMediaKind>> = {
  image: 'photo',
  photo: 'photo',
  video: 'video',
  audio: 'audio',
  voice: 'audio',
  file: 'file',
};

export function digestDuplicateContent(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function normalizeMessageDuplicateText(value: string): string {
  // FLAG: Keep punctuation, numbers, emoji joiners and word order in exact comparisons.
  return value.normalize('NFC').toLowerCase().replace(/\s+/gu, ' ').trim();
}

export function extractDuplicateMessageContent(
  raw: unknown,
  webhook = true,
): DuplicateMessageContent {
  const initial = webhook ? adaptMaxWebhookNavigationView(raw) : adaptMaxMessageNavigationView(raw);
  const root = asRecord(raw);
  const selected = root && initial.messagePath ? readPath(root, initial.messagePath) : root;
  const texts: string[] = [];
  const navigation = new Set<string>();
  const navigationTargets: NavigationTargetEvidence[] = [];
  const actions: string[] = [];
  const media: DuplicateMediaSource[] = [];
  let reason: DuplicateMessageContent['reason'] = selected ? 'complete' : 'missing_message';
  let totalText = 0;
  let attachmentsSeen = 0;
  let nodesSeen = 0;
  const seen = new Set<object>();
  const reject = (value: DuplicateMessageContent['reason']) => {
    if (
      reason === 'complete' ||
      (reason === 'unsupported_attachment' && value !== 'unsupported_attachment')
    )
      reason = value;
  };
  if (initial.diagnostics.length > 0) reject('invalid_content');

  const visit = (message: Record<string, unknown>, depth: number): void => {
    if (depth > MAX_DEPTH || ++nodesSeen > 32) {
      reject('content_limit');
      return;
    }
    if (seen.has(message)) return;
    seen.add(message);
    const body = asRecord(message.body) ?? asRecord(message.content) ?? message;
    const text = readString(body.text) ?? readString(body.caption) ?? '';
    totalText += text.length;
    if (totalText > MAX_TEXT) {
      reject('content_limit');
      return;
    }
    if (text) texts.push(text);
    for (const key of ['markup', 'text_markup', 'caption_markup']) {
      if (
        body[key] !== undefined &&
        body[key] !== null &&
        (!Array.isArray(body[key]) || (body[key] as unknown[]).length > 256)
      ) {
        reject('content_limit');
        return;
      }
    }
    const directView = adaptMaxMessageNavigationView({ body });
    const evidence = extractNavigationEvidence(directView, {
      plainTextCandidates: extractClientClickableTextEvidence(directView),
    });
    if (evidence.diagnostics.length > 0) reject('invalid_content');
    for (const target of evidence.targets) {
      navigation.add(`${target.kind}:${target.normalizedTarget}`);
      navigationTargets.push(target);
    }
    if (
      body.attachments !== undefined &&
      body.attachments !== null &&
      !Array.isArray(body.attachments)
    ) {
      reject('invalid_content');
    }
    for (const rawAttachment of Array.isArray(body.attachments) ? body.attachments : []) {
      if (++attachmentsSeen > MAX_ATTACHMENTS) {
        reject('content_limit');
        return;
      }
      const attachment = asRecord(rawAttachment);
      const kind = readString(attachment?.type)?.toLowerCase();
      const payload = asRecord(attachment?.payload);
      if (!attachment || !kind) {
        reject('invalid_content');
        continue;
      }
      if (kind === 'share') continue;
      if (kind === 'inline_keyboard') {
        const buttons = payload?.buttons;
        if (!Array.isArray(buttons)) {
          reject('invalid_content');
          continue;
        }
        const normalizedButtons: unknown[] = [];
        for (const row of buttons) {
          if (!Array.isArray(row) || row.length > 32 || normalizedButtons.length > 32) {
            reject('invalid_content');
            break;
          }
          const normalizedRow: Record<string, unknown>[] = [];
          for (const value of row) {
            const button = asRecord(value);
            if (
              !button ||
              Object.entries(button).some(
                ([key, value]) =>
                  !BUTTON_KEYS.includes(key) ||
                  (typeof value === 'string' && value.length > MAX_ACTION_BYTES) ||
                  (value !== null && !['string', 'number', 'boolean'].includes(typeof value)),
              )
            ) {
              reject('invalid_content');
              break;
            }
            normalizedRow.push(
              Object.fromEntries(
                BUTTON_KEYS.filter((key) => key in button).map((key) => [key, button[key]]),
              ),
            );
          }
          normalizedButtons.push(normalizedRow);
        }
        const serialized = JSON.stringify(normalizedButtons);
        if (serialized.length > MAX_ACTION_BYTES) reject('content_limit');
        else actions.push(digestDuplicateContent(normalizedButtons));
        continue;
      }
      const mediaKind = MEDIA_KINDS[kind];
      if (!mediaKind) {
        reject(
          ['sticker', 'contact', 'location'].includes(kind)
            ? 'unsupported_attachment'
            : 'invalid_content',
        );
        continue;
      }
      if (!payload) {
        reject('unsupported_attachment');
        continue;
      }
      const url =
        readString(payload.url) ?? readString(attachment.url) ?? readString(payload.image_url);
      const rawPhotoId =
        readString(payload.photo_id) ??
        readString(payload.photoId) ??
        readString(attachment.photo_id);
      const photoId = rawPhotoId?.trim() || null;
      const resourceId = (readString(payload.id) ?? readString(payload.file_id))?.trim() || null;
      const token = readString(payload.token)?.trim() || null;
      if ([url, photoId, resourceId, token].some((value) => value && value.length > 2048)) {
        reject('content_limit');
        continue;
      }
      // FLAG: This identity binds a verified download to a fresh message, never proves equality
      // between two different messages. Only independently computed content hashes can do that.
      const identity = digestDuplicateContent([mediaKind, photoId, resourceId, token, url]);
      if (!photoId && !url) reject('unsupported_attachment');
      media.push({ kind: mediaKind, photoId, url, identity });
      if (media.length > MAX_MEDIA) {
        reject('content_limit');
        return;
      }
    }
    if (
      ['media_group_id', 'mediaGroupId', 'album_id', 'albumId'].some(
        (key) => message[key] || body[key],
      )
    ) {
      reject('split_album');
    }
    const link = asRecord(message.link);
    if (link && link.type !== 'reply') {
      if (link.type !== 'forward') reject('invalid_content');
      else {
        const forward = asRecord(link.message) ?? asRecord(link.body);
        if (!forward) reject('invalid_content');
        else visit(forward, depth + 1);
      }
    }
    for (const source of [message, ...(body === message ? [] : [body])]) {
      for (const key of FORWARD_KEYS) {
        const value = source[key];
        for (const candidate of Array.isArray(value) ? value.slice(0, 33) : [value]) {
          const node = asRecord(candidate);
          if (node) visit(asRecord(node.message) ?? node, depth + 1);
        }
        if (Array.isArray(value) && value.length > 32) reject('content_limit');
      }
    }
  };
  if (selected) visit(selected, 0);
  const text = normalizeMessageDuplicateText(texts.join('\n'));
  const links = [...navigation].sort();
  return {
    text,
    navigation: links,
    navigationTargets,
    actions,
    media,
    complete: reason === 'complete',
    reason,
    sourceDigest: digestDuplicateContent({
      text,
      navigation: links,
      actions,
      media: media.map((m) => [m.kind, m.identity]),
    }),
  };
}

export function buildMessageDuplicateIdentity(
  content: DuplicateMessageContent,
  mode: MessageDuplicateCompareMode,
  mediaHashes: readonly string[] = [],
): string | null {
  if (!content.complete && !(mode === 'TEXT' && content.reason === 'unsupported_attachment'))
    return null;
  if (
    !content.text &&
    content.navigation.length === 0 &&
    content.actions.length === 0 &&
    (mode === 'TEXT' || content.media.length === 0)
  )
    return null;
  if (
    mode === 'MESSAGE' &&
    (mediaHashes.length !== content.media.length ||
      mediaHashes.some((hash) => !/^[a-f0-9]{64}$/.test(hash)))
  )
    return null;
  return digestDuplicateContent({
    version: 1,
    mode,
    text: content.text,
    navigation: content.navigation,
    actions: content.actions,
    media:
      mode === 'MESSAGE' ? content.media.map((item, index) => [item.kind, mediaHashes[index]]) : [],
  });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string'
    ? value
    : typeof value === 'number' && Number.isSafeInteger(value)
      ? String(value)
      : null;
}

function readPath(root: Record<string, unknown>, path: string): Record<string, unknown> | null {
  if (path === '$' || (path === 'message' && !root.message && ('body' in root || 'text' in root)))
    return root;
  let value: unknown = root;
  for (const key of path.split('.')) value = asRecord(value)?.[key];
  return asRecord(value);
}
