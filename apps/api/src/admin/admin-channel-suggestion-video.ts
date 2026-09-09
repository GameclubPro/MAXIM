import { BadRequestException } from '@nestjs/common';
import { MAX_CHANNEL_SUGGESTION_VIDEO_BYTES } from '@maxim/contracts/channel-dialog';
import {
  MAX_API_SOURCE_TAGS,
  type MaxClientService,
  type MaxAttachmentPayload,
} from '../max/max-client.service';
import type { ChannelSuggestionImageAsset } from './admin.service.support';

export async function uploadChannelSuggestionVideo(
  video: ChannelSuggestionImageAsset,
  maxClient: Pick<MaxClientService, 'uploadVideo'>,
  botId?: string,
): Promise<{ attachments: MaxAttachmentPayload[] }> {
  if (
    !botId?.trim() ||
    video.type !== 'video' ||
    !video.base64 ||
    !video.mimeType?.startsWith('video/')
  ) {
    throw new BadRequestException('Не удалось определить видео или бота предложки.');
  }
  const bytes = Buffer.from(video.base64, 'base64');
  if (!bytes.length || bytes.length > MAX_CHANNEL_SUGGESTION_VIDEO_BYTES) {
    throw new BadRequestException('Видео пустое или превышает 24 МБ.');
  }
  const payload = await maxClient.uploadVideo(
    bytes,
    video.fileName ?? 'suggestion.mp4',
    video.mimeType,
    {
      botId,
      trafficClass: 'background',
      sourceTag: MAX_API_SOURCE_TAGS.SUGGESTION_DELIVERY,
      timeoutMs: 120_000,
    },
  );
  return { attachments: [{ type: 'video', payload }] };
}
