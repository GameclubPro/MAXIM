import {
  MAX_CHANNEL_DIALOG_ATTACHMENTS,
  MAX_CHANNEL_DIALOG_SUGGEST_IMAGES,
  type ChannelDialogAttachment,
  type ChannelDialogReactionGroup,
  type ChannelDialogReplyPreview,
  type ChannelDialogSuggestionReviewStatus,
} from '@maxim/contracts';
import type {
  ChannelDialogAttachmentAsset,
  ChannelSuggestionActor,
  ChannelSuggestionImageAsset,
  ChannelSuggestionTextMarkup,
} from './admin.service.support';
import { isMaxTextMarkupType, normalizeMaxUserMentionLink } from '../common/max-text-markup.util';
import {
  readObjectPayloadOrNull,
  readLowerString,
  readRawString,
  readTrimmedString,
  readObjectPayload,
} from './admin-value-readers';
import { toSafeInteger } from './admin-statistics-values';
export {
  readObjectPayloadOrNull,
  readLowerString,
  readRawString,
  readTrimmedString,
  readObjectPayload,
  toSafeInteger,
};

export function buildChannelDialogCommentAttachments(
  attachments: ChannelDialogAttachmentAsset[],
): ChannelDialogAttachment[] {
  return attachments
    .map((attachment) => mapChannelDialogAttachmentAsset(attachment))
    .filter((attachment): attachment is ChannelDialogAttachment => attachment !== null);
}

export function mapChannelDialogAttachmentAsset(
  attachment: ChannelDialogAttachmentAsset,
): ChannelDialogAttachment | null {
  if (!attachment.payload || Object.keys(attachment.payload).length === 0) {
    return null;
  }

  const payload = attachment.payload;
  const fileName =
    readTrimmedString(
      attachment.fileName ??
        payload.file_name ??
        payload.fileName ??
        payload.filename ??
        payload.name,
    ) ?? null;
  const mimeType =
    readTrimmedString(attachment.mimeType ?? payload.mime_type ?? payload.mimeType) ?? null;
  const kind = resolveChannelDialogAttachmentKind(attachment.kind, mimeType, fileName);
  if (!kind) {
    return null;
  }
  const width = toSafeInteger(attachment.width ?? payload.width ?? payload.w);
  const height = toSafeInteger(attachment.height ?? payload.height ?? payload.h);
  const size = toSafeInteger(payload.size);
  const url = readTrimmedString(payload.url) ?? null;
  const previewBase64 = readTrimmedString(attachment.previewBase64 ?? payload.previewBase64);
  const previewUrl =
    url ||
    (kind === 'image' && previewBase64 && canBuildChannelDialogImagePreview(mimeType)
      ? `data:${mimeType};base64,${previewBase64}`
      : null);

  return {
    kind,
    url,
    previewUrl,
    fileName,
    mimeType,
    size: size > 0 ? size : null,
    width: width > 0 ? width : null,
    height: height > 0 ? height : null,
  };
}

export function normalizeChannelSuggestionImages(params: {
  images?: ChannelSuggestionImageAsset[] | null;
  imageBase64?: string | null;
  imageMimeType?: string | null;
  imageFileName?: string | null;
  mediaType?: 'image' | 'video' | null;
  mediaPayload?: Record<string, unknown> | null;
  mediaMimeType?: string | null;
  mediaFileName?: string | null;
}): ChannelSuggestionImageAsset[] {
  const normalizedImages: ChannelSuggestionImageAsset[] = [];

  for (const image of params.images ?? []) {
    if (image.payload && Object.keys(image.payload).length > 0) {
      normalizedImages.push({
        ...(image.type === 'video' ? { type: 'video' as const } : {}),
        payload: image.payload,
        mimeType: image.mimeType?.trim() || null,
        fileName: image.fileName?.trim() || null,
      });
    } else {
      const base64 = image.base64?.trim() ?? '';
      if (!base64) {
        continue;
      }

      normalizedImages.push({
        ...(image.type === 'video' ? { type: 'video' as const } : {}),
        base64,
        mimeType: image.mimeType?.trim() || null,
        fileName: image.fileName?.trim() || null,
      });
    }

    if (normalizedImages.length >= MAX_CHANNEL_DIALOG_SUGGEST_IMAGES) {
      break;
    }
  }

  if (normalizedImages.length > 0) {
    return normalizedImages;
  }

  if (params.mediaType === 'image' && params.mediaPayload) {
    return [
      {
        payload: params.mediaPayload,
        mimeType: params.mediaMimeType?.trim() || null,
        fileName: params.mediaFileName?.trim() || null,
      },
    ];
  }

  const imageBase64 = params.imageBase64?.trim() ?? '';
  if (!imageBase64) {
    return [];
  }

  return [
    {
      base64: imageBase64,
      mimeType: params.imageMimeType?.trim() || null,
      fileName: params.imageFileName?.trim() || null,
    },
  ];
}

export function readChannelDialogAttachmentAssets(value: unknown): ChannelDialogAttachmentAsset[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => readChannelDialogAttachmentAsset(item))
    .filter((attachment): attachment is ChannelDialogAttachmentAsset => attachment !== null)
    .slice(0, MAX_CHANNEL_DIALOG_ATTACHMENTS);
}

export function readChannelDialogAttachmentAsset(
  value: unknown,
): ChannelDialogAttachmentAsset | null {
  const row = readObjectPayloadOrNull(value);
  if (!row) {
    return null;
  }

  const mimeType = readTrimmedString(row.mimeType ?? row.mime_type);
  const fileName = readTrimmedString(row.fileName ?? row.file_name ?? row.filename);
  const kind = resolveChannelDialogAttachmentKind(row.kind ?? row.type, mimeType, fileName);
  if (!kind) {
    return null;
  }

  const payload = readObjectPayloadOrNull(row.payload);
  if (payload && Object.keys(payload).length > 0) {
    return {
      kind,
      payload,
      mimeType,
      fileName,
      previewBase64: readTrimmedString(row.previewBase64 ?? row.preview_base64),
      width: toSafeInteger(row.width ?? row.w),
      height: toSafeInteger(row.height ?? row.h),
    };
  }

  const base64 = readTrimmedString(row.base64);
  if (!base64) {
    return null;
  }

  return {
    kind,
    base64,
    mimeType,
    fileName,
    previewBase64: readTrimmedString(row.previewBase64 ?? row.preview_base64),
    width: toSafeInteger(row.width ?? row.w),
    height: toSafeInteger(row.height ?? row.h),
  };
}

export function readChannelSuggestionImageAssets(value: unknown): ChannelSuggestionImageAsset[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => readChannelSuggestionImageAsset(item))
    .filter((image): image is ChannelSuggestionImageAsset => image !== null)
    .slice(0, MAX_CHANNEL_DIALOG_SUGGEST_IMAGES);
}

export function readChannelSuggestionImageAsset(
  value: unknown,
): ChannelSuggestionImageAsset | null {
  const row = readObjectPayloadOrNull(value);
  if (!row) {
    return null;
  }

  const payload = readObjectPayloadOrNull(row.payload);
  if (payload && Object.keys(payload).length > 0) {
    return {
      payload,
      mimeType: readTrimmedString(row.mimeType),
      fileName: readTrimmedString(row.fileName),
    };
  }

  const base64 = readTrimmedString(row.base64);
  if (!base64) {
    return null;
  }

  return {
    base64,
    mimeType: readTrimmedString(row.mimeType),
    fileName: readTrimmedString(row.fileName),
  };
}

export function readChannelDialogSuggestionReviewStatus(
  value: unknown,
): ChannelDialogSuggestionReviewStatus | null {
  const normalized = readLowerString(value);
  if (normalized === 'pending' || normalized === 'published' || normalized === 'cancelled') {
    return normalized;
  }

  return null;
}

export function readChannelSuggestionMediaType(value: unknown): 'image' | 'video' | null {
  const normalized = readLowerString(value);
  if (normalized === 'image' || normalized === 'video') {
    return normalized;
  }

  return null;
}

export function readDialogReactionGroups(
  value: unknown,
  currentUserId?: string | null,
): ChannelDialogReactionGroup[] {
  const normalizedCurrentUserId = readTrimmedString(currentUserId);
  return readDialogReactionEntries(value).map((entry) => ({
    emoji: entry.emoji,
    count: entry.userIds.length,
    reactedByMe: normalizedCurrentUserId ? entry.userIds.includes(normalizedCurrentUserId) : false,
  }));
}

export function readDialogReactionEntries(
  value: unknown,
): Array<{ emoji: string; userIds: string[] }> {
  if (!Array.isArray(value)) {
    return [];
  }

  const grouped = new Map<string, Set<string>>();
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      continue;
    }

    const row = item as Record<string, unknown>;
    const emoji = readTrimmedString(row.emoji);
    if (!emoji) {
      continue;
    }

    const userIds = Array.isArray(row.userIds)
      ? row.userIds
          .map((userId) => readTrimmedString(userId))
          .filter((userId): userId is string => Boolean(userId))
      : [];
    if (userIds.length === 0) {
      continue;
    }

    const bucket = grouped.get(emoji) ?? new Set<string>();
    for (const userId of userIds) {
      bucket.add(userId);
    }
    grouped.set(emoji, bucket);
  }

  return Array.from(grouped.entries())
    .map(([emoji, userIds]) => ({
      emoji,
      userIds: Array.from(userIds),
    }))
    .sort(
      (left, right) =>
        right.userIds.length - left.userIds.length || left.emoji.localeCompare(right.emoji),
    );
}

export function readDialogReplyPreview(value: unknown): ChannelDialogReplyPreview | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const row = value as Record<string, unknown>;
  const messageId = readTrimmedString(row.messageId);
  const text = readTrimmedString(row.text);
  if (!messageId || !text) {
    return null;
  }

  return {
    messageId,
    authorDisplayName: readTrimmedString(row.authorDisplayName),
    text,
  };
}

export function readChannelSuggestionTextMarkup(value: unknown): ChannelSuggestionTextMarkup[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => readChannelSuggestionTextMarkupItem(item))
    .filter((item): item is ChannelSuggestionTextMarkup => item !== null);
}

export function readChannelSuggestionTextMarkupItem(
  value: unknown,
): ChannelSuggestionTextMarkup | null {
  const row = readObjectPayloadOrNull(value);
  if (!row) {
    return null;
  }

  const type = readLowerString(row.type);
  const from = toSafeInteger(row.from);
  const length = toSafeInteger(row.length);
  if (!type || from < 0 || length <= 0 || !isMaxTextMarkupType(type)) {
    return null;
  }

  return {
    from,
    length,
    type,
    url: readTrimmedString(row.url),
    userLink: normalizeMaxUserMentionLink(row.userLink ?? row.user_link, row.userId ?? row.user_id),
  };
}

export function readStoredChannelSuggestionActor(
  actorUserId: string,
  payload: Record<string, unknown>,
): ChannelSuggestionActor {
  const payloadActorUserId = readTrimmedString(payload.actorUserId);
  const canUseStoredIdentity = !payloadActorUserId || payloadActorUserId === actorUserId;

  return {
    userId: actorUserId,
    username: canUseStoredIdentity ? readTrimmedString(payload.authorUsername) : null,
    displayName: canUseStoredIdentity ? readTrimmedString(payload.authorDisplayName) : null,
    avatarUrl: canUseStoredIdentity ? readTrimmedString(payload.authorAvatarUrl) : null,
    profileUrl: canUseStoredIdentity ? readTrimmedString(payload.authorProfileUrl) : null,
  };
}

export function resolveChannelDialogAttachmentKind(
  kind: unknown,
  mimeType?: string | null,
  fileName?: string | null,
): 'image' | 'file' | null {
  const normalizedKind = readLowerString(kind);
  if (
    normalizedKind === 'image' ||
    normalizedKind === 'photo' ||
    normalizedKind === 'picture' ||
    isChannelDialogImageLikeAttachment(mimeType, fileName)
  ) {
    return 'image';
  }

  if (normalizedKind === 'file' || normalizedKind === 'document' || normalizedKind === 'doc') {
    return 'file';
  }

  return null;
}

export function canBuildChannelDialogImagePreview(mimeType: string | null | undefined): boolean {
  const normalized = mimeType?.trim().toLowerCase() ?? '';
  return (
    normalized === 'image/bmp' ||
    normalized === 'image/gif' ||
    normalized === 'image/jpeg' ||
    normalized === 'image/png' ||
    normalized === 'image/webp'
  );
}

export function isChannelDialogImageLikeAttachment(
  mimeType?: string | null,
  fileName?: string | null,
): boolean {
  return isChannelDialogImageMimeType(mimeType) || isLikelyImageFileName(fileName);
}

export function isChannelDialogImageMimeType(value?: string | null): boolean {
  const normalized = readLowerString(value);
  return Boolean(normalized && normalized.startsWith('image/') && normalized !== 'image/svg+xml');
}

export function isLikelyImageFileName(value?: string | null): boolean {
  return Boolean(value && /\.(avif|bmp|gif|heic|heif|jpe?g|png|tiff?|webp)$/i.test(value));
}

export function normalizeBroadcastTextFormat(value: string): 'markdown' | 'plain' {
  return value === 'markdown' ? 'markdown' : 'plain';
}
