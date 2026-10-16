import type { MaxUpdate } from '@maxim/contracts';
import { extractUrlsFromText } from '../common/url-text.util';

export const MESSAGE_LENGTH_POLICY_VERSION = 'visible-graphemes-v1';
const segmenter = new Intl.Segmenter('ru', { granularity: 'grapheme' });
const TEXT_KEYS = ['text', 'caption', 'plain', 'message_text', 'messageText'] as const;
const FORWARD_KEYS = [
  'forward',
  'forwarded',
  'forwarded_message',
  'forwardedMessage',
  'forwarded_messages',
  'forwardedMessages',
] as const;
const MAX_NODES = 128;
const MAX_DEPTH = 8;

export function countMessageCharacters(text: string): number {
  let count = 0;
  const segments = segmenter.segment(text)[Symbol.iterator]();
  while (!segments.next().done) count++;
  return count;
}

export function measureVisibleMessageLength(update: MaxUpdate): number {
  const content = readContent(update.raw, update.type);
  if (!content.hasText) return countMessageCharacters(update.message?.text ?? '');
  // FLAG: Count only source text, without normalized-parser separators or transport metadata.
  // Separate visible forwarded parts remain separate even when their text is identical.
  return [...content.direct, ...content.forwarded].reduce(
    (total, text) => total + countMessageCharacters(stripPreviewUrls(text, content.previewUrls)),
    0,
  );
}

export function collectForwardedVisibleText(raw: unknown): string[] {
  const content = readContent(raw);
  return content.forwarded.map((text) => stripPreviewUrls(text, content.previewUrls));
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function containers(row: Record<string, unknown>): Record<string, unknown>[] {
  return [row, record(row.body), record(row.content), record(row.payload)].filter(
    (value): value is Record<string, unknown> => value !== undefined,
  );
}

function visibleText(row: Record<string, unknown>): string | undefined {
  // FLAG: MessageBody.text is authoritative. Other shapes are aliases, not extra captions.
  // Prefer the original body over an envelope's normalized copy of the same text.
  const sources = [
    record(row.body),
    row,
    record(row.content),
    record(row.payload),
    record(row.message),
  ];
  for (const source of sources) {
    if (!source) continue;
    for (const key of TEXT_KEYS) {
      const value = source[key];
      if (typeof value === 'string') return value;
      if (key === 'text' && value === null) return '';
    }
  }
  return undefined;
}

function currentMessage(raw: unknown, type?: string): Record<string, unknown> | undefined {
  const root = record(raw);
  if (!root) return undefined;
  const direct = record(root.message);
  if (direct) return direct;
  for (const key of [type, root.update_type, root.event_type, root.type, 'data', 'event']) {
    if (typeof key !== 'string') continue;
    const envelope = record(root[key]);
    if (!envelope) continue;
    const message = record(envelope.message) ?? record(record(envelope.data)?.message);
    if (message) return message;
    if (record(envelope.body) || TEXT_KEYS.some((field) => typeof envelope[field] === 'string'))
      return envelope;
  }
  return root;
}

function readContent(raw: unknown, type?: string) {
  const direct: string[] = [];
  const forwarded: string[] = [];
  const previewUrls = new Set<string>();
  const visited = new Set<object>();
  let remaining = MAX_NODES;
  let hasText = false;

  function visit(value: unknown, isForward: boolean, depth: number): void {
    if (depth > MAX_DEPTH || remaining <= 0 || !value || typeof value !== 'object') return;
    if (visited.has(value)) return;
    visited.add(value);
    remaining--;
    if (Array.isArray(value)) {
      for (let i = 0; i < Math.min(value.length, MAX_NODES) && remaining > 0; i++)
        visit(value[i], true, depth + 1);
      return;
    }
    const row = record(value)!;
    const sources = containers(row);
    const text = visibleText(row);
    if (text !== undefined) {
      hasText = true;
      (isForward ? forwarded : direct).push(text);
    }
    if (isForward) {
      for (const source of sources) {
        if (!Array.isArray(source.attachments)) continue;
        for (const attachment of source.attachments.slice(0, 64)) {
          const item = record(attachment);
          const payload = record(item?.payload);
          if (!item || !payload || typeof payload.url !== 'string') continue;
          const kind = String(item.type ?? payload.type ?? '').toLowerCase();
          if (
            ![
              'image',
              'photo',
              'picture',
              'video',
              'voice',
              'audio',
              'audio_message',
              'file',
              'document',
              'sticker',
            ].includes(kind)
          )
            continue;
          const url = previewUrl(payload.url);
          if (url) previewUrls.add(url);
        }
      }
    }
    // FLAG: Only a direct forward belongs to this message. Never walk reply/quote,
    // sender, markup, attachment payloads or arbitrary objects looking for more text.
    for (const source of sources) {
      const link = record(source.link);
      if (typeof link?.type === 'string' && link.type.trim().toLowerCase() === 'forward') {
        visit(record(link.message) ?? record(link.body), true, depth + 1);
        return;
      }
    }
    for (const source of sources) {
      for (const key of FORWARD_KEYS) {
        const child = source[key];
        if (record(child) || Array.isArray(child)) {
          visit(child, true, depth + 1);
          return;
        }
      }
    }
  }
  visit(currentMessage(raw, type), false, 0);
  return { direct, forwarded, previewUrls, hasText };
}

function previewUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (
      url.protocol === 'https:' &&
      url.hostname === 'i.oneme.ru' &&
      !url.port &&
      !url.username &&
      !url.password &&
      url.pathname === '/i' &&
      url.searchParams.get('r')
    )
      return `https://i.oneme.ru/i${url.search}${url.hash}`;
  } catch {
    /* FLAG: Invalid media metadata cannot supply visible text. */
  }
  return undefined;
}

function stripPreviewUrls(text: string, previewUrls: ReadonlySet<string>): string {
  if (previewUrls.size === 0) return text;
  let result = text;
  for (const url of extractUrlsFromText(text)) {
    const normalized = previewUrl(url);
    if (normalized && previewUrls.has(normalized)) result = result.replaceAll(url, '');
  }
  return result === text ? text : result.trim();
}
