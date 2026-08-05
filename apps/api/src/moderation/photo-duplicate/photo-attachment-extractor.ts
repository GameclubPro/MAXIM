import type { MaxUpdate } from '@maxim/contracts';
import { extractRawMessageNode } from '../moderation-update-extractors';

const MAX_FORWARD_DEPTH = 8;
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
  images: ExtractedPhotoAttachment[];
};

export type LogicalPhotoAlbumExtractionResult =
  | { kind: 'none' }
  | { kind: 'incomplete'; reason: 'missing_identity' | 'too_many_images' }
  | { kind: 'complete'; album: LogicalPhotoAlbum };

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

  const attachmentArrays = new Set<unknown[]>();
  const images: ExtractedPhotoAttachment[] = [];
  let sawIncompleteImage = false;

  const appendImages = (node: Record<string, unknown>, source: 'direct' | 'forward') => {
    for (const attachments of collectOwnAttachmentArrays(node)) {
      if (attachmentArrays.has(attachments)) {
        continue;
      }
      attachmentArrays.add(attachments);

      for (const value of attachments) {
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

        images.push({
          source,
          photoId,
          downloadUrl,
        });
      }
    }
  };

  appendImages(messageNode, 'direct');
  for (const forwardedNode of collectForwardedMessageNodes(messageNode)) {
    appendImages(forwardedNode, 'forward');
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
      images,
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
  const nestedMessage = asRecord(node.message);
  const candidates = [
    node.attachments,
    body?.attachments,
    content?.attachments,
    payload?.attachments,
    nestedMessage?.attachments,
  ];

  return candidates.filter((value): value is unknown[] => Array.isArray(value));
}

function collectForwardedMessageNodes(root: Record<string, unknown>): Record<string, unknown>[] {
  const forwarded: Record<string, unknown>[] = [];
  const visited = new Set<Record<string, unknown>>();

  const visitContainer = (container: Record<string, unknown>, depth: number) => {
    if (depth > MAX_FORWARD_DEPTH || visited.has(container)) {
      return;
    }
    visited.add(container);

    const link = asRecord(container.link);
    const linkType = normalizeString(
      link?.type ?? link?.link_type ?? link?.linkType,
    )?.toLowerCase();
    if (link && linkType === 'forward') {
      for (const target of readLinkedPayloads(link)) {
        visitForwardTarget(target, depth + 1);
      }
    }

    for (const holder of [container, asRecord(container.body), asRecord(container.content)]) {
      if (!holder) {
        continue;
      }
      for (const key of FORWARD_KEYS) {
        for (const target of asRecords(holder[key])) {
          visitForwardTarget(target, depth + 1);
        }
      }
    }
  };

  const visitForwardTarget = (target: Record<string, unknown>, depth: number) => {
    if (depth > MAX_FORWARD_DEPTH || isReplyNode(target) || visited.has(target)) {
      return;
    }
    forwarded.push(target);
    visitContainer(target, depth);

    const nestedMessage = asRecord(target.message);
    if (nestedMessage && !isReplyNode(nestedMessage)) {
      forwarded.push(nestedMessage);
      visitContainer(nestedMessage, depth + 1);
    }
  };

  visitContainer(root, 0);
  return forwarded;
}

function readLinkedPayloads(link: Record<string, unknown>): Record<string, unknown>[] {
  return [link.message, link.body, link.content, link.payload]
    .flatMap((value) => asRecords(value))
    .filter((value, index, values) => values.indexOf(value) === index);
}

function asRecords(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    return value.map(asRecord).filter((entry): entry is Record<string, unknown> => Boolean(entry));
  }
  const record = asRecord(value);
  return record ? [record] : [];
}

function isReplyNode(node: Record<string, unknown>): boolean {
  const type = normalizeString(node.type ?? node.link_type ?? node.linkType)?.toLowerCase();
  return (
    type === 'reply' ||
    type === 'reply_message' ||
    type === 'replymessage' ||
    type === 'quoted' ||
    type === 'quoted_message'
  );
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
