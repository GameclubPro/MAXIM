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

export function createAdminChannelDialogMappingRuntimeContext(
  dependencies: AdminChannelDialogMappingRuntimeContext,
): AdminChannelDialogMappingRuntimeContext {
  return dependencies;
}
