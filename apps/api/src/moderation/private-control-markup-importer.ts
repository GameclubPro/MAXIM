import type { BroadcastTextFormat, MaxUpdate } from '@maxim/contracts';
import {
  isMaxTextMarkupType,
  normalizeMaxUserMentionLink,
  renderMaxTextMarkupAsMarkdown,
  type MaxTextMarkup,
} from '../common/max-text-markup.util';

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
  const contentNode = resolveIncomingContentNode(messageNode);
  const sourceText = (contentNode ? extractMessageTextFromNode(contentNode) : null) || fallbackText;
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
    textMarkup: extractIncomingMessageMarkup(contentNode),
  };
}

export function extractIncomingFormattedTextPayload(
  update: MaxUpdate,
  fallbackText: string,
): IncomingFormattedTextPayload {
  const messageNode = extractIncomingMessageNode(update);
  const contentNode = resolveIncomingContentNode(messageNode);
  const sourceText = (contentNode ? extractMessageTextFromNode(contentNode) : null) || fallbackText;
  if (!sourceText) {
    return {
      text: fallbackText,
      textFormat: 'plain',
    };
  }

  const markup = extractIncomingMessageMarkup(contentNode);
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
  const candidates = [
    body?.markup,
    body?.text_markup,
    body?.textMarkup,
    body?.caption_markup,
    body?.captionMarkup,
    content?.markup,
    content?.text_markup,
    content?.textMarkup,
    content?.caption_markup,
    content?.captionMarkup,
    payload?.markup,
    payload?.text_markup,
    payload?.textMarkup,
    payload?.caption_markup,
    payload?.captionMarkup,
    nestedMessage?.markup,
    nestedMessage?.text_markup,
    nestedMessage?.textMarkup,
    nestedMessage?.caption_markup,
    nestedMessage?.captionMarkup,
    messageNode?.markup,
    messageNode?.text_markup,
    messageNode?.textMarkup,
    messageNode?.caption_markup,
    messageNode?.captionMarkup,
  ];

  for (const candidate of candidates) {
    if (!Array.isArray(candidate) || candidate.length === 0) {
      continue;
    }
    const markup = candidate
      .map((item) => normalizeIncomingMessageMarkup(item))
      .filter((item): item is IncomingMessageMarkup => item !== null);
    if (markup.length > 0) {
      return markup;
    }
  }

  return [];
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
    !isMaxTextMarkupType(type)
  ) {
    return null;
  }

  return {
    from,
    length,
    type,
    url: readString(row.url) || null,
    userLink: normalizeMaxUserMentionLink(
      row.user_link ?? row.userLink,
      row.user_id ?? row.userId,
    ),
  };
}

export function renderIncomingMarkupAsMarkdown(
  text: string,
  markup: IncomingMessageMarkup[],
): string | null {
  return renderMaxTextMarkupAsMarkdown(text, markup);
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
    const sourceText = readNonBlankString(candidate);
    if (sourceText) {
      return sourceText;
    }
  }

  return null;
}

function resolveIncomingContentNode(
  messageNode: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!messageNode || extractMessageTextFromNode(messageNode)) {
    return messageNode;
  }

  const link = asRecord(messageNode.link);
  if (readLowerString(link?.type) === 'forward') {
    for (const candidate of [asRecord(link?.message), asRecord(link?.body)]) {
      if (candidate && extractMessageTextFromNode(candidate)) {
        return candidate;
      }
    }
  }

  const body = asRecord(messageNode.body);
  for (const candidate of [
    asRecord(body?.forwarded_message),
    asRecord(body?.forwardedMessage),
  ]) {
    if (candidate && extractMessageTextFromNode(candidate)) {
      return candidate;
    }
  }

  return messageNode;
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

function readNonBlankString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  return value.trim().length > 0 ? value : null;
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
