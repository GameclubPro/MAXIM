import { describe, expect, it } from 'vitest';

import {
  publishVkParsingPostRequestSchema as rootPublishVkParsingPostRequestSchema,
  publishVkParsingPostResultSchema as rootPublishVkParsingPostResultSchema,
  vkParsingFeedSchema as rootVkParsingFeedSchema,
} from '@maxim/contracts';
import {
  VK_PARSING_DEFAULT_CHANNEL_LINK_TEXT,
  publishVkParsingPostRequestSchema,
  publishVkParsingPostResultSchema,
  rollbackVkParsingResultSchema,
  vkParsingFeedSchema,
} from '@maxim/contracts/vk-parsing';

describe('VK parsing contracts', () => {
  it('keeps root and subpath schema identity aligned', () => {
    expect(rootPublishVkParsingPostRequestSchema).toBe(publishVkParsingPostRequestSchema);
    expect(rootPublishVkParsingPostResultSchema).toBe(publishVkParsingPostResultSchema);
    expect(rootVkParsingFeedSchema).toBe(vkParsingFeedSchema);
  });

  it('models manual publish and publisher rollback as asynchronous work', () => {
    expect(publishVkParsingPostResultSchema.shape.queued.parse(undefined)).toBe(0);
    expect(publishVkParsingPostResultSchema.shape.messageId.safeParse(undefined).success).toBe(
      true,
    );
    expect(rollbackVkParsingResultSchema.shape.queued.parse(undefined)).toBe(0);
  });

  it('preserves fail-safe feed defaults', () => {
    const parsed = vkParsingFeedSchema.parse({});

    expect(parsed.capabilities).toEqual({
      enabled: false,
      canUse: false,
      reasonCode: null,
      reason: null,
    });
    expect(parsed.settings).toEqual(
      expect.objectContaining({
        chatId: '',
        autoPublishEnabled: false,
        autoPublishKillSwitchEnabled: false,
        channelLinkText: VK_PARSING_DEFAULT_CHANNEL_LINK_TEXT,
        schedulerTimezone: 'Europe/Moscow',
      }),
    );
    expect(parsed.sources).toEqual([]);
    expect(parsed.posts).toEqual([]);
    expect(parsed.queue).toEqual([]);
  });

  it('keeps publish payload media rules intact', () => {
    expect(
      publishVkParsingPostRequestSchema.safeParse({
        photoUrls: ['https://example.com/photo.jpg'],
        videoUrls: ['https://example.com/video.mp4'],
      }).success,
    ).toBe(false);
    expect(publishVkParsingPostRequestSchema.safeParse({}).success).toBe(false);
    expect(
      publishVkParsingPostRequestSchema.safeParse({
        text: 'Новая запись',
        textFormat: 'markdown',
      }).success,
    ).toBe(true);
  });
});
