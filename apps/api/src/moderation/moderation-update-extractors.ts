import type { MaxUpdate } from '@maxim/contracts';
import { selectMaxMessageCandidate } from '../max/max-message-candidate.util';

const MAX_FORWARD_SCAN_DEPTH = 8;

export type ModerationMediaFlags = {
  hasPhotoAttachment: boolean;
  hasStickerAttachment: boolean;
  hasVideoAttachment: boolean;
  hasFileAttachment: boolean;
  hasVoiceAttachment: boolean;
  hasMediaBatch: boolean;
};

export function calculateEffectiveMessageLength(update: MaxUpdate): number {
  const baseText = update.message?.text ?? '';
  const baseLength = baseText.length;
  const forwardedSnippets = collectForwardedTextSnippets(update.raw);

  if (forwardedSnippets.length === 0) {
    return baseLength;
  }

  const normalizedBaseText = baseText.toLowerCase();
  let totalLength = baseLength;

  for (const snippet of forwardedSnippets) {
    if (!snippet) {
      continue;
    }

    if (normalizedBaseText.includes(snippet.toLowerCase())) {
      continue;
    }

    totalLength += snippet.length;
  }

  return totalLength;
}

export function collectForwardedTextSnippets(raw: unknown): string[] {
  const rawRecord = asRecord(raw);
  if (!rawRecord) {
    return [];
  }

  const messageNode = extractRawMessageNode(rawRecord) ?? rawRecord;
  const forwardedNodes = collectForwardedNodes(messageNode);
  if (forwardedNodes.length === 0) {
    return [];
  }

  const snippets = new Set<string>();
  for (const node of forwardedNodes) {
    collectTextSnippets(node, snippets);
  }

  return [...snippets];
}

export function hasForwardedMessage(update: MaxUpdate): boolean {
  const rawRecord = asRecord(update.raw);
  if (!rawRecord) {
    return false;
  }

  const messageNode = selectMaxMessageCandidate(rawRecord, update.type)?.node ?? rawRecord;
  const body = asRecord(messageNode.body);
  const content = asRecord(messageNode.content);
  const payload = asRecord(messageNode.payload);
  return [messageNode, body, content, payload].some(hasDirectForwardMarker);
}

export function shouldSkipAntiSpamBurstForForward(update: MaxUpdate): boolean {
  const rawRecord = asRecord(update.raw);
  if (!rawRecord) {
    return false;
  }

  const messageNode = selectMaxMessageCandidate(rawRecord, update.type)?.node ?? rawRecord;
  return hasForwardedMessage(update) && !hasDirectCurrentMessageText(messageNode);
}

export function extractRawMessageNode(
  raw: Record<string, unknown>,
): Record<string, unknown> | null {
  const directMessage = asRecord(raw.message);
  if (directMessage) {
    return directMessage;
  }

  const envelopeKeys = ['message_created', 'data', 'event'];
  if (typeof raw.update_type === 'string') {
    envelopeKeys.push(raw.update_type);
  }
  if (typeof raw.type === 'string') {
    envelopeKeys.push(raw.type);
  }

  for (const key of envelopeKeys) {
    const envelope = asRecord(raw[key]);
    if (!envelope) {
      continue;
    }

    const nestedMessage = asRecord(envelope.message);
    if (nestedMessage) {
      return nestedMessage;
    }

    const nestedData = asRecord(envelope.data);
    const nestedDataMessage = nestedData ? asRecord(nestedData.message) : null;
    if (nestedDataMessage) {
      return nestedDataMessage;
    }
  }

  return null;
}

export function collectForwardedNodes(node: unknown, depth = 0, acc: unknown[] = []): unknown[] {
  if (depth > MAX_FORWARD_SCAN_DEPTH || node === null || node === undefined) {
    return acc;
  }

  if (Array.isArray(node)) {
    for (const item of node) {
      collectForwardedNodes(item, depth + 1, acc);
    }
    return acc;
  }

  if (typeof node !== 'object') {
    return acc;
  }

  const row = node as Record<string, unknown>;
  if (isForwardLinkedMessage(row)) {
    acc.push(readForwardLinkedMessagePayload(row) ?? row);
  }

  for (const [key, value] of Object.entries(row)) {
    if (/forward/i.test(key)) {
      acc.push(value);
    }

    if (value && (typeof value === 'object' || Array.isArray(value))) {
      collectForwardedNodes(value, depth + 1, acc);
    }
  }

  return acc;
}

export function detectMediaFlags(update: MaxUpdate): ModerationMediaFlags {
  const rawRecord = asRecord(update.raw);
  if (!rawRecord) {
    return createEmptyMediaFlags();
  }

  const messageNode = extractRawMessageNode(rawRecord) ?? rawRecord;
  const flags = createEmptyMediaFlags();
  collectMediaFlags(messageNode, flags);
  return flags;
}

function collectTextSnippets(node: unknown, acc: Set<string>, depth = 0): void {
  if (depth > MAX_FORWARD_SCAN_DEPTH || node === null || node === undefined) {
    return;
  }

  if (typeof node === 'string') {
    const normalized = node.trim();
    if (normalized.length > 0) {
      acc.add(normalized);
    }
    return;
  }

  if (Array.isArray(node)) {
    for (const item of node) {
      collectTextSnippets(item, acc, depth + 1);
    }
    return;
  }

  if (typeof node !== 'object') {
    return;
  }

  const row = node as Record<string, unknown>;
  for (const [key, value] of Object.entries(row)) {
    if (
      (key === 'text' ||
        key === 'caption' ||
        key === 'plain' ||
        key === 'message_text' ||
        key === 'messageText') &&
      typeof value === 'string'
    ) {
      const normalized = value.trim();
      if (normalized.length > 0) {
        acc.add(normalized);
      }
      continue;
    }

    if (value && (typeof value === 'object' || Array.isArray(value) || typeof value === 'string')) {
      collectTextSnippets(value, acc, depth + 1);
    }
  }
}

function hasDirectCurrentMessageText(messageNode: Record<string, unknown>): boolean {
  const body = asRecord(messageNode.body);
  const content = asRecord(messageNode.content);
  const payload = asRecord(messageNode.payload);
  const nestedMessage = asRecord(messageNode.message);
  const candidates = [
    messageNode.text,
    messageNode.caption,
    messageNode.plain,
    messageNode.message_text,
    messageNode.messageText,
    body?.text,
    body?.caption,
    body?.plain,
    content?.text,
    content?.caption,
    content?.plain,
    payload?.text,
    payload?.caption,
    payload?.plain,
    nestedMessage?.text,
    nestedMessage?.caption,
    nestedMessage?.plain,
  ];

  return candidates.some((candidate) => typeof candidate === 'string' && candidate.trim());
}

function collectMediaFlags(
  node: unknown,
  flags: ModerationMediaFlags,
  depth = 0,
  inStickerContext = false,
  inFileContext = false,
): void {
  if (
    depth > MAX_FORWARD_SCAN_DEPTH ||
    node === null ||
    node === undefined ||
    (flags.hasPhotoAttachment &&
      flags.hasStickerAttachment &&
      flags.hasVideoAttachment &&
      flags.hasFileAttachment &&
      flags.hasVoiceAttachment &&
      flags.hasMediaBatch)
  ) {
    return;
  }

  if (Array.isArray(node)) {
    for (const item of node) {
      collectMediaFlags(item, flags, depth + 1, inStickerContext, inFileContext);
    }
    return;
  }

  if (typeof node !== 'object') {
    return;
  }

  const row = node as Record<string, unknown>;
  const relationType = readLowerString(row.type ?? row.kind ?? row.entity_type ?? row.entityType);
  if (isReplyReferenceType(relationType)) {
    return;
  }

  const payload =
    row.payload && typeof row.payload === 'object' && !Array.isArray(row.payload)
      ? (row.payload as Record<string, unknown>)
      : null;
  const type = readLowerString(row.type ?? payload?.type);
  const mimeType = readLowerString(
    row.mime_type ?? row.mimeType ?? payload?.mime_type ?? payload?.mimeType,
  );
  const fileName = readLowerString(
    row.file_name ??
      row.fileName ??
      row.filename ??
      payload?.file_name ??
      payload?.fileName ??
      payload?.filename ??
      payload?.url,
  );
  const mediaType = readLowerString(
    row.media_type ?? row.mediaType ?? payload?.media_type ?? payload?.mediaType,
  );
  const stickerContext = inStickerContext || type === 'sticker' || mediaType === 'sticker';
  const imageLike =
    !stickerContext &&
    (type === 'photo' ||
      type === 'image' ||
      type === 'picture' ||
      mimeType?.startsWith('image/') ||
      mediaType === 'photo' ||
      mediaType === 'image' ||
      isLikelyImageFileName(fileName));
  const fileContext =
    !imageLike &&
    (inFileContext ||
      type === 'file' ||
      type === 'document' ||
      type === 'doc' ||
      mediaType === 'file' ||
      mediaType === 'document');

  if (imageLike) {
    flags.hasPhotoAttachment = true;
  }

  if (stickerContext) {
    flags.hasStickerAttachment = true;
  }

  if (
    type === 'video' ||
    mimeType?.startsWith('video/') ||
    mediaType === 'video' ||
    isLikelyVideoFileName(fileName)
  ) {
    flags.hasVideoAttachment = true;
  }

  if (
    type === 'voice' ||
    type === 'audio' ||
    type === 'audio_message' ||
    type === 'ptt' ||
    mimeType?.startsWith('audio/') ||
    mediaType === 'voice' ||
    mediaType === 'audio' ||
    isLikelyVoiceFileName(fileName)
  ) {
    flags.hasVoiceAttachment = true;
  }

  if (fileContext) {
    flags.hasFileAttachment = true;
  }

  for (const [key, value] of Object.entries(row)) {
    const keyLower = key.toLowerCase();
    if (isMediaBatchKey(keyLower)) {
      flags.hasMediaBatch = true;
    }

    if (
      !stickerContext &&
      !fileContext &&
      (keyLower === 'photo' ||
        keyLower === 'photos' ||
        keyLower === 'image' ||
        keyLower === 'picture' ||
        keyLower === 'images')
    ) {
      flags.hasPhotoAttachment = true;
    }

    if (keyLower === 'sticker' || keyLower === 'stickers') {
      flags.hasStickerAttachment = true;
    }

    if (keyLower === 'video' || keyLower === 'videos') {
      flags.hasVideoAttachment = true;
    }

    if (
      keyLower === 'voice' ||
      keyLower === 'voices' ||
      keyLower === 'audio' ||
      keyLower === 'audio_message'
    ) {
      flags.hasVoiceAttachment = true;
    }

    if (value && (typeof value === 'object' || Array.isArray(value))) {
      if (isReplyReferenceKey(keyLower)) {
        continue;
      }

      const childStickerContext =
        stickerContext || keyLower === 'sticker' || keyLower === 'stickers';
      const childFileContext =
        fileContext ||
        keyLower === 'file' ||
        keyLower === 'files' ||
        keyLower === 'document' ||
        keyLower === 'documents';
      collectMediaFlags(value, flags, depth + 1, childStickerContext, childFileContext);
    }
  }
}

function createEmptyMediaFlags(): ModerationMediaFlags {
  return {
    hasPhotoAttachment: false,
    hasStickerAttachment: false,
    hasVideoAttachment: false,
    hasFileAttachment: false,
    hasVoiceAttachment: false,
    hasMediaBatch: false,
  };
}

function isMediaBatchKey(value: string): boolean {
  return (
    value === 'album' ||
    value === 'albumid' ||
    value === 'album_id' ||
    value === 'mediagroup' ||
    value === 'mediagroupid' ||
    value === 'media_group' ||
    value === 'media_group_id'
  );
}

function isForwardLinkedMessage(row: Record<string, unknown>): boolean {
  return readLowerString(row.type ?? row.link_type ?? row.linkType) === 'forward';
}

function hasDirectForwardMarker(container: Record<string, unknown> | null): boolean {
  if (!container) {
    return false;
  }

  const link = asRecord(container.link);
  if (readLowerString(link?.type ?? link?.link_type ?? link?.linkType) === 'forward') {
    return true;
  }

  return [
    container.forward,
    container.forwarded,
    container.forwarded_message,
    container.forwardedMessage,
    container.forwarded_messages,
    container.forwardedMessages,
  ].some(isPresentForwardPayload);
}

function isPresentForwardPayload(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => item !== null && item !== undefined && item !== false);
  }
  if (value && typeof value === 'object') {
    return true;
  }
  if (typeof value === 'string') {
    return value.trim().length > 0;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) && value !== 0;
  }
  return value === true;
}

function readForwardLinkedMessagePayload(row: Record<string, unknown>): unknown {
  return row.message ?? row.body ?? row.content ?? row.payload ?? null;
}

function isReplyReferenceType(value: string | null): boolean {
  return (
    value === 'reply' ||
    value === 'reply_message' ||
    value === 'replymessage' ||
    value === 'quoted' ||
    value === 'quoted_message' ||
    value === 'quotedmessage'
  );
}

function isReplyReferenceKey(value: string): boolean {
  return (
    value === 'reply' ||
    value === 'replyto' ||
    value === 'reply_to' ||
    value === 'replymessage' ||
    value === 'reply_message' ||
    value === 'replytomessage' ||
    value === 'reply_to_message' ||
    value === 'repliedmessage' ||
    value === 'replied_message' ||
    value === 'quoted' ||
    value === 'quotedmessage' ||
    value === 'quoted_message'
  );
}

function isLikelyVideoFileName(value: string | null): boolean {
  if (!value) {
    return false;
  }

  return /\.(mp4|mov|avi|mkv|webm|m4v)$/i.test(value);
}

function isLikelyImageFileName(value: string | null): boolean {
  if (!value) {
    return false;
  }

  return /\.(avif|bmp|gif|heic|heif|jpe?g|png|tiff?|webp)$/i.test(value);
}

function isLikelyVoiceFileName(value: string | null): boolean {
  if (!value) {
    return false;
  }

  return /\.(ogg|opus|mp3|m4a|wav|flac)$/i.test(value);
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
