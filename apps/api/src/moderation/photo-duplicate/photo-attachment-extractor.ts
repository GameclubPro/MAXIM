import type { MaxUpdate } from '@maxim/contracts';
import { extractRawMessageNode } from '../moderation-update-extractors';

const MAX_FORWARD_DEPTH = 8;
const MAX_FORWARD_MESSAGE_NODES = 32;
const MAX_FORWARD_REFERENCES_SCANNED = 64;
const MAX_ATTACHMENT_ENTRIES_SCANNED = 256;
const MAX_VISIBLE_CAPTION_LENGTH = 8_000;
export const MAX_PHOTO_ALBUM_IMAGES = 10;

const FORWARD_KEYS = [
  'forward',
  'forwarded',
  'forwarded_message',
  'forwarded_messages',
  'forwardedMessage',
  'forwardedMessages',
] as const;

export type ExtractedPhotoAttachment = {
  source: 'direct' | 'forward';
  photoId: string | null;
  downloadUrl: string | null;
};

export type LogicalPhotoAlbum = {
  chatId: string;
  messageId: string;
  senderId: string;
  createdAtMs: number;
  caption: string;
  images: ExtractedPhotoAttachment[];
};

export type VisiblePhotoMessageContent = {
  caption: string;
  images: ExtractedPhotoAttachment[];
};

export type VisiblePhotoMessageContentExtractionResult =
  | { kind: 'none' }
  | {
      kind: 'incomplete';
      reason:
        | 'missing_identity'
        | 'too_many_images'
        | 'forward_traversal_limit'
        | 'attachment_scan_limit'
        | 'caption_too_long';
    }
  | { kind: 'complete'; content: VisiblePhotoMessageContent };

export type LogicalPhotoAlbumExtractionResult =
  | { kind: 'none' }
  | Extract<VisiblePhotoMessageContentExtractionResult, { kind: 'incomplete' }>
  | { kind: 'complete'; album: LogicalPhotoAlbum };

/**
 * Canonical visible OCR content for both persisted webhooks and fresh exact-message rows.
 * Only explicit forward relations are traversed; replies and quoted previews are excluded.
 */
export function extractVisiblePhotoMessageContent(
  messageNode: unknown,
): VisiblePhotoMessageContentExtractionResult {
  const root = asRecord(messageNode);
  if (!root) {
    return { kind: 'none' };
  }

  const attachmentArrays = new Set<unknown[]>();
  const images: ExtractedPhotoAttachment[] = [];
  const captionSnippets: string[] = [];
  const captionSnippetKeys = new Set<string>();
  let attachmentEntriesScanned = 0;
  let sawIncompleteImage = false;
  let captionLength = 0;
  let captionTooLong = false;
  let attachmentScanLimitReached = false;

  const appendContent = (node: Record<string, unknown>, source: 'direct' | 'forward') => {
    const snippet = normalizeVisibleText(extractContentText(node));
    if (snippet) {
      const key = snippet.toLowerCase();
      if (!captionSnippetKeys.has(key)) {
        captionSnippetKeys.add(key);
        const nextLength = captionLength + (captionSnippets.length > 0 ? 1 : 0) + snippet.length;
        if (nextLength > MAX_VISIBLE_CAPTION_LENGTH) {
          captionTooLong = true;
        } else {
          captionLength = nextLength;
          captionSnippets.push(snippet);
        }
      }
    }

    for (const attachments of collectOwnAttachmentArrays(node)) {
      if (attachmentArrays.has(attachments)) {
        continue;
      }
      attachmentArrays.add(attachments);

      for (const value of attachments) {
        attachmentEntriesScanned += 1;
        if (attachmentEntriesScanned > MAX_ATTACHMENT_ENTRIES_SCANNED) {
          attachmentScanLimitReached = true;
          return;
        }

        const attachment = asRecord(value);
        if (!attachment || !isImageAttachment(attachment)) {
          continue;
        }

        const payload = asRecord(attachment.payload);
        const photoId = firstString(
          attachment.photo_id,
          attachment.photoId,
          payload?.photo_id,
          payload?.photoId,
        );
        const downloadUrl = firstString(
          attachment.url,
          attachment.image_url,
          attachment.imageUrl,
          payload?.url,
          payload?.image_url,
          payload?.imageUrl,
        );

        if (!photoId && !downloadUrl) {
          sawIncompleteImage = true;
          continue;
        }

        images.push({ source, photoId, downloadUrl });
        if (images.length > MAX_PHOTO_ALBUM_IMAGES) {
          return;
        }
      }
    }
  };

  appendContent(root, 'direct');
  const forwardTraversal = collectForwardedMessageNodes(root);
  for (const forwardedNode of forwardTraversal.nodes) {
    if (attachmentScanLimitReached || captionTooLong || images.length > MAX_PHOTO_ALBUM_IMAGES) {
      break;
    }
    appendContent(forwardedNode, 'forward');
  }

  if (forwardTraversal.truncated) {
    return { kind: 'incomplete', reason: 'forward_traversal_limit' };
  }
  if (attachmentScanLimitReached) {
    return { kind: 'incomplete', reason: 'attachment_scan_limit' };
  }
  if (captionTooLong) {
    return { kind: 'incomplete', reason: 'caption_too_long' };
  }
  if (images.length === 0 && !sawIncompleteImage) {
    return { kind: 'none' };
  }
  if (sawIncompleteImage) {
    return { kind: 'incomplete', reason: 'missing_identity' };
  }
  if (images.length > MAX_PHOTO_ALBUM_IMAGES) {
    return { kind: 'incomplete', reason: 'too_many_images' };
  }

  return {
    kind: 'complete',
    content: {
      caption: captionSnippets.join(' '),
      images,
    },
  };
}

export function extractLogicalPhotoAlbumResult(
  update: MaxUpdate,
): LogicalPhotoAlbumExtractionResult {
  if (normalizeString(update.type)?.toLowerCase() !== 'message_created' || !update.message) {
    return { kind: 'none' };
  }

  const raw = asRecord(update.raw);
  if (!raw) {
    return { kind: 'none' };
  }

  const messageNode = extractRawMessageNode(raw);
  if (!messageNode) {
    return { kind: 'none' };
  }

  const content = extractVisiblePhotoMessageContent(messageNode);
  if (content.kind !== 'complete') {
    return content;
  }

  const createdAtMs = Date.parse(update.message.createdAt);
  if (!Number.isFinite(createdAtMs)) {
    return { kind: 'none' };
  }

  return {
    kind: 'complete',
    album: {
      chatId: update.message.chatId,
      messageId: update.message.messageId,
      senderId: update.message.senderId,
      createdAtMs,
      caption: content.content.caption,
      images: content.content.images,
    },
  };
}

export function extractLogicalPhotoAlbum(update: MaxUpdate): LogicalPhotoAlbum | null {
  const result = extractLogicalPhotoAlbumResult(update);
  return result.kind === 'complete' ? result.album : null;
}

function collectOwnAttachmentArrays(node: Record<string, unknown>): unknown[][] {
  const body = asRecord(node.body);
  const content = asRecord(node.content);
  const payload = asRecord(node.payload);
  const candidates = [
    node.attachments,
    body?.attachments,
    content?.attachments,
    payload?.attachments,
  ];

  return candidates.filter((value): value is unknown[] => Array.isArray(value));
}

function collectForwardedMessageNodes(root: Record<string, unknown>): {
  nodes: Record<string, unknown>[];
  truncated: boolean;
} {
  const nodes: Record<string, unknown>[] = [];
  const visited = new Set<Record<string, unknown>>();
  let referencesScanned = 0;
  let truncated = false;

  const visitContainer = (container: Record<string, unknown>, depth: number) => {
    if (visited.has(container) || truncated) {
      return;
    }
    visited.add(container);

    for (const holder of [
      container,
      asRecord(container.body),
      asRecord(container.content),
      asRecord(container.payload),
    ]) {
      if (!holder) {
        continue;
      }

      const link = asRecord(holder.link);
      const linkType = normalizeString(
        link?.type ?? link?.link_type ?? link?.linkType,
      )?.toLowerCase();
      if (link && linkType === 'forward') {
        forEachRecord(link.message, (target) => visitForwardTarget(target, depth + 1));
        forEachRecord(link.body, (target) => visitForwardTarget(target, depth + 1));
        forEachRecord(link.content, (target) => visitForwardTarget(target, depth + 1));
        forEachRecord(link.payload, (target) => visitForwardTarget(target, depth + 1));
      }

      for (const key of FORWARD_KEYS) {
        forEachRecord(holder[key], (target) => visitForwardTarget(target, depth + 1));
      }
    }
  };

  const visitForwardTarget = (target: Record<string, unknown>, depth: number) => {
    if (isReplyNode(target) || visited.has(target)) {
      return;
    }
    if (depth > MAX_FORWARD_DEPTH || nodes.length >= MAX_FORWARD_MESSAGE_NODES) {
      truncated = true;
      return;
    }

    nodes.push(target);
    visitContainer(target, depth);

    const nestedMessage = asRecord(target.message);
    if (nestedMessage && !isReplyNode(nestedMessage)) {
      forEachRecord(nestedMessage, (nestedTarget) => visitForwardTarget(nestedTarget, depth));
    }
  };

  const forEachRecord = (
    value: unknown,
    visit: (target: Record<string, unknown>) => void,
  ): void => {
    if (truncated) {
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        referencesScanned += 1;
        if (referencesScanned > MAX_FORWARD_REFERENCES_SCANNED) {
          truncated = true;
          return;
        }
        const target = asRecord(item);
        if (target) {
          visit(target);
        }
        if (truncated) {
          return;
        }
      }
      return;
    }
    if (value !== null && value !== undefined) {
      referencesScanned += 1;
      if (referencesScanned > MAX_FORWARD_REFERENCES_SCANNED) {
        truncated = true;
        return;
      }
    }
    const target = asRecord(value);
    if (target) {
      visit(target);
    }
  };

  visitContainer(root, 0);
  return { nodes, truncated };
}

function isReplyNode(node: Record<string, unknown>): boolean {
  const type = normalizeString(
    node.type ??
      node.kind ??
      node.link_type ??
      node.linkType ??
      node.relation_type ??
      node.relationType,
  )?.toLowerCase();
  return (
    type === 'reply' ||
    type === 'reply_message' ||
    type === 'replymessage' ||
    type === 'quoted' ||
    type === 'quoted_message'
  );
}

function extractContentText(message: Record<string, unknown>): string {
  const body = asRecord(message.body);
  const content = asRecord(message.content);
  const payload = asRecord(message.payload);
  const candidates = [
    message.text,
    message.caption,
    message.plain,
    message.message_text,
    message.messageText,
    body?.text,
    body?.caption,
    body?.plain,
    body?.message_text,
    body?.messageText,
    content?.text,
    content?.caption,
    content?.plain,
    content?.message_text,
    content?.messageText,
    payload?.text,
    payload?.caption,
    payload?.plain,
    payload?.message_text,
    payload?.messageText,
  ];
  const snippets: string[] = [];
  const seen = new Set<string>();
  for (const value of candidates) {
    if (typeof value !== 'string') {
      continue;
    }
    const normalized = normalizeVisibleText(value);
    const key = normalized.toLowerCase();
    if (!normalized || seen.has(key)) {
      continue;
    }
    seen.add(key);
    snippets.push(normalized);
  }
  return snippets.join(' ');
}

function normalizeVisibleText(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

function isImageAttachment(attachment: Record<string, unknown>): boolean {
  const payload = asRecord(attachment.payload);
  const type = normalizeString(attachment.type ?? payload?.type)?.toLowerCase();
  if (type === 'sticker') {
    return false;
  }
  const mediaType = normalizeString(
    attachment.media_type ?? attachment.mediaType ?? payload?.media_type ?? payload?.mediaType,
  )?.toLowerCase();
  const mimeType = normalizeString(
    attachment.mime_type ?? attachment.mimeType ?? payload?.mime_type ?? payload?.mimeType,
  )?.toLowerCase();
  const fileName = normalizeString(
    attachment.file_name ??
      attachment.fileName ??
      attachment.filename ??
      payload?.file_name ??
      payload?.fileName ??
      payload?.filename ??
      payload?.url,
  )?.toLowerCase();
  return (
    type === 'image' ||
    type === 'photo' ||
    type === 'picture' ||
    mediaType === 'image' ||
    mediaType === 'photo' ||
    mimeType?.startsWith('image/') === true ||
    (fileName ? /\.(?:avif|gif|heic|heif|jpe?g|png|tiff?|webp)(?:$|[?#])/u.test(fileName) : false)
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    const normalized = normalizeString(value);
    if (normalized) {
      return normalized;
    }
  }
  return null;
}

function normalizeString(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') {
    return null;
  }
  const normalized = String(value).trim();
  return normalized.length > 0 ? normalized : null;
}
