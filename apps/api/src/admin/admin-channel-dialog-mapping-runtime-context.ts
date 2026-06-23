import type {
  BroadcastTextFormat,
  ChannelDialogAttachment,
  ChannelDialogReactionGroup,
  ChannelDialogReplyPreview,
  ChannelDialogSuggestionReviewStatus,
} from '@maxim/contracts';
import type { Prisma } from '../prisma/prisma-client';
import type {
  ChannelDialogAttachmentAsset,
  ChannelSuggestionImageAsset,
} from './admin.service.support';

export type NormalizeChannelSuggestionImagesParams = {
  images?: ChannelSuggestionImageAsset[] | null;
  imageBase64?: string | null;
  imageMimeType?: string | null;
  imageFileName?: string | null;
  mediaType?: 'image' | 'video' | null;
  mediaPayload?: Record<string, unknown> | null;
  mediaMimeType?: string | null;
  mediaFileName?: string | null;
};

export type AdminChannelDialogMappingRuntimeContext = {
  buildChannelDialogCommentAttachments(
    attachments: ChannelDialogAttachmentAsset[],
  ): ChannelDialogAttachment[];
  normalizeBroadcastTextFormat(value: string): BroadcastTextFormat;
  normalizeChannelSuggestionImages(
    params: NormalizeChannelSuggestionImagesParams,
  ): ChannelSuggestionImageAsset[];
  readChannelDialogAttachmentAssets(value: unknown): ChannelDialogAttachmentAsset[];
  readChannelDialogSuggestionReviewStatus(
    value: unknown,
  ): ChannelDialogSuggestionReviewStatus | null;
  readChannelSuggestionImageAssets(value: unknown): ChannelSuggestionImageAsset[];
  readChannelSuggestionMediaType(value: unknown): 'image' | 'video' | null;
  readDialogReactionGroups(
    value: unknown,
    currentUserId?: string | null,
  ): ChannelDialogReactionGroup[];
  readDialogReplyPreview(value: unknown): ChannelDialogReplyPreview | null;
  readLowerString(value: unknown): string | null;
  readObjectPayload(value: Prisma.JsonValue): Record<string, unknown>;
  readObjectPayloadOrNull(value: unknown): Record<string, unknown> | null;
  readTrimmedString(value: unknown): string | null;
  toSafeInteger(value: unknown): number;
};

type AdminChannelDialogMappingRuntimeContextTarget = AdminChannelDialogMappingRuntimeContext;

export function createAdminChannelDialogMappingRuntimeContext(
  target: object,
): AdminChannelDialogMappingRuntimeContext {
  const typedTarget = target as AdminChannelDialogMappingRuntimeContextTarget;

  return {
    buildChannelDialogCommentAttachments(
      attachments: ChannelDialogAttachmentAsset[],
    ): ChannelDialogAttachment[] {
      return typedTarget.buildChannelDialogCommentAttachments(attachments);
    },
    normalizeBroadcastTextFormat(value: string): BroadcastTextFormat {
      return typedTarget.normalizeBroadcastTextFormat(value);
    },
    normalizeChannelSuggestionImages(
      params: NormalizeChannelSuggestionImagesParams,
    ): ChannelSuggestionImageAsset[] {
      return typedTarget.normalizeChannelSuggestionImages(params);
    },
    readChannelDialogAttachmentAssets(value: unknown): ChannelDialogAttachmentAsset[] {
      return typedTarget.readChannelDialogAttachmentAssets(value);
    },
    readChannelDialogSuggestionReviewStatus(
      value: unknown,
    ): ChannelDialogSuggestionReviewStatus | null {
      return typedTarget.readChannelDialogSuggestionReviewStatus(value);
    },
    readChannelSuggestionImageAssets(value: unknown): ChannelSuggestionImageAsset[] {
      return typedTarget.readChannelSuggestionImageAssets(value);
    },
    readChannelSuggestionMediaType(value: unknown): 'image' | 'video' | null {
      return typedTarget.readChannelSuggestionMediaType(value);
    },
    readDialogReactionGroups(
      value: unknown,
      currentUserId?: string | null,
    ): ChannelDialogReactionGroup[] {
      return typedTarget.readDialogReactionGroups(value, currentUserId);
    },
    readDialogReplyPreview(value: unknown): ChannelDialogReplyPreview | null {
      return typedTarget.readDialogReplyPreview(value);
    },
    readLowerString(value: unknown): string | null {
      return typedTarget.readLowerString(value);
    },
    readObjectPayload(value: Prisma.JsonValue): Record<string, unknown> {
      return typedTarget.readObjectPayload(value);
    },
    readObjectPayloadOrNull(value: unknown): Record<string, unknown> | null {
      return typedTarget.readObjectPayloadOrNull(value);
    },
    readTrimmedString(value: unknown): string | null {
      return typedTarget.readTrimmedString(value);
    },
    toSafeInteger(value: unknown): number {
      return typedTarget.toSafeInteger(value);
    },
  };
}
