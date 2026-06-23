import type { ChannelDialogMessage, ChannelDialogType } from '@maxim/contracts';
import type { Prisma } from '../prisma/prisma-client';
import type {
  ChannelDialogAttachmentAsset,
  ChannelSuggestionImageAsset,
} from './admin.service.support';
import type {
  AdminChannelDialogMappingRuntimeContext,
  NormalizeChannelSuggestionImagesParams,
} from './admin-channel-dialog-mapping-runtime-context';

type ChannelDialogAuditLogRow = {
  id: string;
  actorUserId: string;
  payload: Prisma.JsonValue;
  createdAt: Date;
};

export class AdminChannelDialogMappingRuntime {
  constructor(private readonly context: AdminChannelDialogMappingRuntimeContext) {}

  private readObjectPayload(value: Prisma.JsonValue): Record<string, unknown> {
    return this.context.readObjectPayload(value);
  }

  private readObjectPayloadOrNull(value: unknown): Record<string, unknown> | null {
    return this.context.readObjectPayloadOrNull(value);
  }

  private readTrimmedString(value: unknown): string | null {
    return this.context.readTrimmedString(value);
  }

  private readLowerString(value: unknown): string | null {
    return this.context.readLowerString(value);
  }

  private normalizeBroadcastTextFormat(value: string) {
    return this.context.normalizeBroadcastTextFormat(value);
  }

  private readDialogReplyPreview(value: unknown) {
    return this.context.readDialogReplyPreview(value);
  }

  private readDialogReactionGroups(value: unknown, currentUserId?: string | null) {
    return this.context.readDialogReactionGroups(value, currentUserId);
  }

  private readChannelDialogAttachmentAssets(value: unknown): ChannelDialogAttachmentAsset[] {
    return this.context.readChannelDialogAttachmentAssets(value);
  }

  private buildChannelDialogCommentAttachments(attachments: ChannelDialogAttachmentAsset[]) {
    return this.context.buildChannelDialogCommentAttachments(attachments);
  }

  private readChannelSuggestionImageAssets(value: unknown): ChannelSuggestionImageAsset[] {
    return this.context.readChannelSuggestionImageAssets(value);
  }

  private normalizeChannelSuggestionImages(
    params: NormalizeChannelSuggestionImagesParams,
  ): ChannelSuggestionImageAsset[] {
    return this.context.normalizeChannelSuggestionImages(params);
  }

  private readChannelSuggestionMediaType(value: unknown): 'image' | 'video' | null {
    return this.context.readChannelSuggestionMediaType(value);
  }

  private readChannelDialogSuggestionReviewStatus(value: unknown) {
    return this.context.readChannelDialogSuggestionReviewStatus(value);
  }

  private toSafeInteger(value: unknown): number {
    return this.context.toSafeInteger(value);
  }

  mapChannelDialogAuditLog(
    row: ChannelDialogAuditLogRow,
    fallbackType: ChannelDialogType,
    currentUserId?: string | null,
    adminUserIds?: ReadonlySet<string>,
  ): ChannelDialogMessage {
    const payload = this.readObjectPayload(row.payload);
    const normalizedCurrentUserId = this.readTrimmedString(currentUserId);
    const rawType = this.readLowerString(payload.type);
    const type: ChannelDialogType =
      rawType === 'suggest' || rawType === 'comments' ? rawType : fallbackType;
    const authorDisplayName = this.readTrimmedString(payload.authorDisplayName);
    const avatarUrl = this.readTrimmedString(payload.authorAvatarUrl);
    const text = this.readTrimmedString(payload.text) ?? '';
    const textFormat = this.normalizeBroadcastTextFormat(
      this.readTrimmedString(payload.textFormat) ?? 'plain',
    );
    const editedAt = this.readTrimmedString(payload.editedAt);
    const replyTo = this.readDialogReplyPreview(payload.replyTo);
    const attachments = this.buildChannelDialogCommentAttachments(
      this.readChannelDialogAttachmentAssets(payload.attachments),
    );
    const delivered = payload.delivered === true;
    const deliveredToUserId = this.readTrimmedString(payload.deliveredToUserId);
    const reviewStatus = this.readChannelDialogSuggestionReviewStatus(payload.reviewStatus);
    const publishedUrl = this.readTrimmedString(payload.publishedUrl);
    const suggestionImages = this.normalizeChannelSuggestionImages({
      images: this.readChannelSuggestionImageAssets(payload.images),
      imageBase64: this.readTrimmedString(payload.imageBase64),
      imageMimeType: this.readTrimmedString(payload.imageMimeType),
      imageFileName: this.readTrimmedString(payload.imageFileName),
      mediaType: this.readChannelSuggestionMediaType(payload.mediaType),
      mediaPayload: this.readObjectPayloadOrNull(payload.mediaPayload),
      mediaMimeType: this.readTrimmedString(payload.mediaMimeType),
      mediaFileName: this.readTrimmedString(payload.mediaFileName),
    }) as ChannelSuggestionImageAsset[];
    const hasImage =
      payload.hasImage === true ||
      suggestionImages.length > 0 ||
      Boolean(this.readTrimmedString(payload.imageBase64));
    const imageFileNames = Array.from(
      new Set(
        suggestionImages
          .map((image) => image.fileName?.trim() ?? '')
          .filter((fileName): fileName is string => fileName.length > 0),
      ),
    );
    const legacyImageFileName = this.readTrimmedString(payload.imageFileName);
    const resolvedImageFileNames =
      imageFileNames.length > 0 ? imageFileNames : legacyImageFileName ? [legacyImageFileName] : [];
    const imageFileName = resolvedImageFileNames[0] ?? null;
    const imageCount = hasImage
      ? Math.max(
          suggestionImages.length,
          resolvedImageFileNames.length,
          this.toSafeInteger(payload.imageCount),
          this.readChannelSuggestionMediaType(payload.mediaType) === 'image' ? 1 : 0,
        )
      : 0;
    const hasVideo =
      payload.hasVideo === true ||
      this.readChannelSuggestionMediaType(payload.mediaType) === 'video';
    const videoFileName =
      this.readTrimmedString(payload.videoFileName) ??
      this.readTrimmedString(payload.mediaFileName);
    const isOwnMessage = normalizedCurrentUserId === row.actorUserId;
    const canDeleteAsAdmin =
      type === 'comments' &&
      !isOwnMessage &&
      Boolean(normalizedCurrentUserId && adminUserIds?.has(normalizedCurrentUserId));

    return {
      id: row.id,
      type,
      text,
      authorUserId: row.actorUserId,
      authorDisplayName,
      isAdmin: adminUserIds?.has(row.actorUserId) ?? false,
      avatarUrl: avatarUrl ?? null,
      createdAt: row.createdAt.toISOString(),
      editedAt: editedAt ?? null,
      replyToMessageId: replyTo?.messageId ?? null,
      replyTo: replyTo ?? null,
      attachments,
      reactionGroups: this.readDialogReactionGroups(payload.reactions, currentUserId),
      canEdit: type === 'comments' && isOwnMessage,
      canDelete: type === 'comments' && isOwnMessage,
      canDeleteAsAdmin,
      ...(type === 'suggest'
        ? {
            delivered,
            deliveredToUserId: deliveredToUserId ?? null,
            reviewStatus: reviewStatus ?? 'pending',
            publishedUrl: publishedUrl ?? null,
            textFormat,
            hasImage,
            imageCount,
            imageFileName,
            imageFileNames: resolvedImageFileNames,
            hasVideo,
            videoFileName: videoFileName ?? null,
          }
        : {}),
    };
  }
}
