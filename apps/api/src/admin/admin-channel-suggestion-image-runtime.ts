import type { ChannelSuggestionImageAsset } from './admin.service.support';
import type { AdminChannelSuggestionImageRuntimeContext } from './admin-channel-suggestion-image-runtime-context';
import { loadStoredChannelSuggestionImages } from './admin-channel-suggestion-image-storage';

export class AdminChannelSuggestionImageRuntime {
  constructor(private readonly context: AdminChannelSuggestionImageRuntimeContext) {}

  async loadStoredImages(
    auditLogId: string,
    payload: Record<string, unknown>,
  ): Promise<ChannelSuggestionImageAsset[]> {
    const legacyImages = this.context.normalizeChannelSuggestionImages({
      images: this.context.readChannelSuggestionImageAssets(payload.images),
      imageBase64: this.context.readTrimmedString(payload.imageBase64),
      imageMimeType: this.context.readTrimmedString(payload.imageMimeType),
      imageFileName: this.context.readTrimmedString(payload.imageFileName),
      mediaType: this.context.readChannelSuggestionMediaType(payload.mediaType),
      mediaPayload: this.context.readObjectPayloadOrNull(payload.mediaPayload),
      mediaMimeType: this.context.readTrimmedString(payload.mediaMimeType),
      mediaFileName: this.context.readTrimmedString(payload.mediaFileName),
    });
    return loadStoredChannelSuggestionImages({
      auditLogId,
      payload,
      legacyImages,
      repository: this.context.prisma.channelSuggestionImageAsset,
      logger: this.context.logger,
    });
  }
}
