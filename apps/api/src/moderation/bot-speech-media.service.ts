import { Injectable, Logger } from '@nestjs/common';
import type { BotSpeechMediaFieldKey } from '@maxim/contracts/bot-speech';
import {
  MAX_API_SOURCE_TAGS,
  MaxClientService,
  type MaxSendMessageOptions,
} from '../max/max-client.service';

export type BotSpeechResolvedMedia = {
  base64: string;
  mimeType: string;
  fileName: string;
  fieldKey: BotSpeechMediaFieldKey;
};

export type BotSpeechMediaUploadOptions = {
  trafficClass?: 'interactive' | 'background';
  actionHealthLane?: 'interactive' | 'background';
  sourceTag?: string;
  botId?: string | null;
};

@Injectable()
export class BotSpeechMediaService {
  private readonly logger = new Logger(BotSpeechMediaService.name);

  constructor(private readonly maxClient: MaxClientService) {}

  resolveMedia(
    settings: { botSpeechMedia?: unknown },
    fieldKey?: BotSpeechMediaFieldKey,
  ): BotSpeechResolvedMedia | null {
    if (!fieldKey) {
      return null;
    }

    const media = this.asRecord(settings.botSpeechMedia);
    const image = media ? this.asRecord(media[fieldKey]) : null;
    const base64 = this.readString(image?.base64);
    const mimeType = this.readString(image?.mimeType);
    if (!base64 || !mimeType?.toLowerCase().startsWith('image/')) {
      return null;
    }

    return {
      base64,
      mimeType,
      fileName: this.readString(image?.fileName) ?? 'bot-message-image.jpg',
      fieldKey,
    };
  }

  async withMediaOptions(
    options: MaxSendMessageOptions | undefined,
    media?: BotSpeechResolvedMedia | null,
    uploadOptions: BotSpeechMediaUploadOptions = {},
  ): Promise<MaxSendMessageOptions | undefined> {
    if (!media) {
      return options;
    }

    let imagePayload: Record<string, unknown>;
    try {
      imagePayload = await this.uploadImage(media, uploadOptions);
    } catch (error: unknown) {
      this.logger.warn(
        {
          fieldKey: media.fieldKey,
          error: error instanceof Error ? error.message : String(error),
        },
        'Failed to upload bot speech image; sending text-only notice',
      );
      return options;
    }

    return {
      ...(options ?? {}),
      imagePayload,
    };
  }

  async uploadImage(
    media: BotSpeechResolvedMedia,
    options: BotSpeechMediaUploadOptions = {},
  ): Promise<Record<string, unknown>> {
    const imageBuffer = Buffer.from(media.base64, 'base64');
    return this.maxClient.uploadImage(imageBuffer, media.fileName, media.mimeType, {
      trafficClass: options.trafficClass ?? 'background',
      actionHealthLane: options.actionHealthLane ?? 'background',
      sourceTag: options.sourceTag ?? MAX_API_SOURCE_TAGS.MODERATION_NOTICE,
      ...(options.botId ? { botId: options.botId } : {}),
    });
  }

  private asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  }

  private readString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
  }
}
