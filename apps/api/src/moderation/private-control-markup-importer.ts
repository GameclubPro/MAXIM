import type { BroadcastTextFormat, MaxUpdate } from '@maxim/contracts';
import type { MaxTextMarkup } from '../common/max-text-markup.util';

export type IncomingMessageMarkup = MaxTextMarkup;

export type IncomingSuggestionTextPayload = {
  text: string;
  textFormat: BroadcastTextFormat;
  textMarkup: IncomingMessageMarkup[];
};

export type IncomingFormattedTextPayload = {
  text: string;
  textFormat: BroadcastTextFormat;
};

export function extractIncomingSuggestionTextPayload(
  update: MaxUpdate,
  fallbackText: string,
): IncomingSuggestionTextPayload {
  const messageNode = extractIncomingMessageNode(update);
  const sourceText = (messageNode ? extractMessageTextFromNode(messageNode) : null) || fallbackText;
  if (!sourceText) {
    return {
      text: fallbackText,
      textFormat: 'plain',
      textMarkup: [],
    };
  }

  return {
    text: sourceText,
    textFormat: 'plain',
    textMarkup: extractIncomingMessageMarkup(messageNode),
  };
}

export function extractIncomingFormattedTextPayload(
  update: MaxUpdate,
  fallbackText: string,
): IncomingFormattedTextPayload {
  const messageNode = extractIncomingMessageNode(update);
  const sourceText = (messageNode ? extractMessageTextFromNode(messageNode) : null) || fallbackText;
  if (!sourceText) {
    return {
      text: fallbackText,
      textFormat: 'plain',
    };
  }

  const markup = extractIncomingMessageMarkup(messageNode);
  const rendered = renderIncomingMarkupAsMarkdown(sourceText, markup);
  if (rendered) {
    return {
      text: rendered,
      textFormat: 'markdown',
    };
  }

  return {
    text: sourceText,
    textFormat: 'plain',
  };
}

export function extractIncomingFormattedText(update: MaxUpdate, fallbackText: string): string {
  return extractIncomingFormattedTextPayload(update, fallbackText).text;
}

export function extractIncomingMessageNode(update: MaxUpdate): Record<string, unknown> | null {
  const raw = asRecord(update.raw);
  if (!raw) {
    return null;
  }

  const data = asRecord(raw.data);
  const event = asRecord(raw.event);
  return (
    asRecord(raw.message) ??
    (data ? asRecord(data.message) : null) ??
    (event ? asRecord(event.message) : null) ??
    null
  );
}

export function extractIncomingMessageMarkup(
  messageNode: Record<string, unknown> | null,
): IncomingMessageMarkup[] {
  const body = asRecord(messageNode?.body);
  const content = asRecord(messageNode?.content);
  const payload = asRecord(messageNode?.payload);
  const nestedMessage = asRecord(messageNode?.message);
  const rawMarkup =
    [
      body?.markup,
      body?.text_markup,
      body?.caption_markup,
      content?.markup,
      content?.text_markup,
      content?.caption_markup,
      payload?.markup,
      payload?.text_markup,
      payload?.caption_markup,
      nestedMessage?.markup,
      nestedMessage?.text_markup,
      nestedMessage?.caption_markup,
      messageNode?.markup,
    ].find((value) => Array.isArray(value)) ?? [];

  return rawMarkup
    .map((item) => normalizeIncomingMessageMarkup(item))
    .filter((item): item is IncomingMessageMarkup => item !== null);
}

export function normalizeIncomingMessageMarkup(value: unknown): IncomingMessageMarkup | null {
  const row = asRecord(value);
  if (!row) {
    return null;
  }

  const type = readLowerString(row.type);
  const from = readOptionalInteger(row.from);
  const length = readOptionalInteger(row.length);
  if (
    !type ||
    from === null ||
    length === null ||
    from < 0 ||
    length <= 0 ||
    ![
      'emphasized',
      'heading',
      'link',
      'monospaced',
      'strikethrough',
      'strong',
      'underline',
      'user_mention',
    ].includes(type)
  ) {
    return null;
  }

  return {
    from,
    length,
    type: type as IncomingMessageMarkup['type'],
    url: readString(row.url) || null,
    userLink: readString(row.user_link ?? row.userLink) || null,
  };
}

export function renderIncomingMarkupAsMarkdown(
  text: string,
  markup: IncomingMessageMarkup[],
): string | null {
  if (markup.length === 0) {
    return null;
  }

  const openTags = new Map<
    number,
    Array<{ open: string; close: string; end: number; priority: number }>
  >();
  const closeTags = new Map<
    number,
    Array<{ close: string; start: number; end: number; priority: number }>
  >();
  const boundaries = new Set<number>([0, text.length]);

  for (const item of markup) {
    const start = item.from;
    const end = item.from + item.length;
    if (start < 0 || end <= start || end > text.length) {
      continue;
    }

    for (const segment of splitIncomingMarkupRangeByLines(text, start, end)) {
      const delimiters = resolveIncomingMarkupMarkdownDelimiters(
        item,
        text.slice(segment.start, segment.end),
      );
      if (!delimiters) {
        continue;
      }

      const openBucket = openTags.get(segment.start) ?? [];
      openBucket.push({
        open: delimiters.open,
        close: delimiters.close,
        end: segment.end,
        priority: delimiters.priority,
      });
      openTags.set(segment.start, openBucket);

      const closeBucket = closeTags.get(segment.end) ?? [];
      closeBucket.push({
        close: delimiters.close,
        start: segment.start,
        end: segment.end,
        priority: delimiters.priority,
      });
      closeTags.set(segment.end, closeBucket);
      boundaries.add(segment.start);
      boundaries.add(segment.end);
    }
  }

  if (openTags.size === 0 && closeTags.size === 0) {
    return null;
  }

  let markdown = '';
  let previousBoundary = 0;
  const sortedBoundaries = Array.from(boundaries).sort((left, right) => left - right);

  for (const boundary of sortedBoundaries) {
    if (boundary > previousBoundary) {
      markdown += escapeMarkdownText(text.slice(previousBoundary, boundary));
    }

    const closing = closeTags.get(boundary);
    if (closing) {
      closing
        .slice()
        .sort(
          (left, right) =>
            right.start - left.start || left.end - right.end || right.priority - left.priority,
        )
        .forEach((tag) => {
          markdown += tag.close;
        });
    }

    const opening = openTags.get(boundary);
    if (opening) {
      opening
        .slice()
        .sort((left, right) => right.end - left.end || left.priority - right.priority)
        .forEach((tag) => {
          markdown += tag.open;
        });
    }
    previousBoundary = boundary;
  }

  return markdown;
}

function extractMessageTextFromNode(node: Record<string, unknown>): string | null {
  const body = asRecord(node.body);
  const content = asRecord(node.content);
  const payload = asRecord(node.payload);
  const nestedMessage = asRecord(node.message);
  const candidates = [
    node.text,
    node.caption,
    node.message_text,
    node.messageText,
    body?.text,
    body?.caption,
    body?.plain,
    content?.text,
    content?.caption,
    payload?.text,
    payload?.caption,
    nestedMessage?.text,
    nestedMessage?.caption,
  ];

  for (const candidate of candidates) {
    const normalized = readString(candidate);
    if (normalized) {
      return normalized;
    }
  }

  return null;
}

function splitIncomingMarkupRangeByLines(
  text: string,
  start: number,
  end: number,
): Array<{ start: number; end: number }> {
  const segments: Array<{ start: number; end: number }> = [];
  let segmentStart = start;

  for (let index = start; index < end; index += 1) {
    const char = text[index];
    if (char !== '\n' && char !== '\r') {
      continue;
    }

    if (segmentStart < index && text.slice(segmentStart, index).trim().length > 0) {
      segments.push({ start: segmentStart, end: index });
    }

    if (char === '\r' && text[index + 1] === '\n' && index + 1 < end) {
      index += 1;
    }
    segmentStart = index + 1;
  }

  if (segmentStart < end && text.slice(segmentStart, end).trim().length > 0) {
    segments.push({ start: segmentStart, end });
  }

  return segments;
}

function resolveIncomingMarkupMarkdownDelimiters(
  markup: IncomingMessageMarkup,
  visibleText: string,
): { open: string; close: string; priority: number } | null {
  switch (markup.type) {
    case 'strong':
      return { open: '**', close: '**', priority: 20 };
    case 'heading':
      return { open: '# ', close: '', priority: 5 };
    case 'emphasized':
      return { open: '_', close: '_', priority: 30 };
    case 'underline':
      return { open: '++', close: '++', priority: 40 };
    case 'strikethrough':
      return { open: '~~', close: '~~', priority: 50 };
    case 'monospaced':
      return visibleText.includes('\n') ? null : { open: '`', close: '`', priority: 60 };
    case 'link':
      return markup.url && !isRedundantIncomingAutoLink(visibleText, markup.url)
        ? {
            open: '[',
            close: `](${markup.url})`,
            priority: 10,
          }
        : null;
    case 'user_mention': {
      const mentionTarget = markup.userLink
        ? markup.userLink.startsWith('max://')
          ? markup.userLink
          : `https://max.ru/${markup.userLink}`
        : null;
      return mentionTarget
        ? {
            open: '[',
            close: `](${mentionTarget})`,
            priority: 10,
          }
        : null;
    }
    default:
      return null;
  }
}

function isRedundantIncomingAutoLink(visibleText: string, targetUrl: string): boolean {
  const normalizedVisibleText = visibleText.trim();
  const normalizedTargetUrl = targetUrl.trim();
  if (!normalizedVisibleText || !normalizedTargetUrl) {
    return false;
  }

  if (!/^(https?:\/\/|max:\/\/)\S+$/iu.test(normalizedVisibleText)) {
    return false;
  }

  return (
    normalizeIncomingComparableUrl(normalizedVisibleText) ===
    normalizeIncomingComparableUrl(normalizedTargetUrl)
  );
}

function normalizeIncomingComparableUrl(value: string): string {
  return value.trim().replace(/\/+$/u, '').toLowerCase();
}

function escapeMarkdownText(value: string): string {
  return value.replace(/([\\`*_[\]()~+])/g, '\\$1');
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function readLowerString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

function readString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function readOptionalInteger(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.trunc(value);
  }

  if (typeof value === 'string' && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return null;
}
