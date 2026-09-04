import { VkParsingOwnerProfile } from '../prisma/prisma-client';
import { VkParsingPostImportRepository } from './vk-parsing-post-import.repository';
import {
  VK_MAX_SEND_AMBIGUOUS_ERROR_PREFIX,
  VK_MAX_SEND_CONFIRMED_PERSISTENCE_ERROR_PREFIX,
} from './vk-publish-quarantine';

describe('VkParsingPostImportRepository', () => {
  it('fences missing-post finalization from active and MAX-quarantined publications', async () => {
    const vkParsingPost = {
      findMany: jest.fn().mockResolvedValue([
        { id: 'eligible', vkOwnerId: -36819802, vkPostId: 201, missingSeenCount: 0 },
        { id: 'active-lock', vkOwnerId: -36819802, vkPostId: 202, missingSeenCount: 0 },
        { id: 'ambiguous', vkOwnerId: -36819802, vkPostId: 203, missingSeenCount: 0 },
        { id: 'confirmed', vkOwnerId: -36819802, vkPostId: 204, missingSeenCount: 0 },
        {
          id: 'changed-after-publish',
          vkOwnerId: -36819802,
          vkPostId: 205,
          missingSeenCount: 0,
        },
        { id: 'rollback-armed', vkOwnerId: -36819802, vkPostId: 206, missingSeenCount: 0 },
        { id: 'rollback-active', vkOwnerId: -36819802, vkPostId: 207, missingSeenCount: 0 },
      ]),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    };
    const repository = new VkParsingPostImportRepository({ vkParsingPost } as never);
    const seenAt = new Date('2026-09-04T12:00:00.000Z');

    await repository.markMissingPostsUnavailable(
      {
        id: 'source-1',
        chatId: 'channel-1',
        wallOwnerId: -36819802,
        ownerProfile: VkParsingOwnerProfile.PUBLISHER,
        ownerBotId: 'publisher-bot',
      },
      [
        {
          vkOwnerId: -36819802,
          vkPostId: 208,
          vkPublishedAt: new Date('2026-09-04T10:00:00.000Z'),
          text: 'Fetched post',
          textFormat: 'plain',
          url: 'https://vk.ru/wall-36819802_208',
          photoUrls: [],
          videoUrls: [],
          linkUrls: [],
          attachments: [],
          attachmentTypes: [],
          unsupportedAttachments: [],
          hasUnsupportedAttachments: false,
          isAdvertising: false,
          advertisingMarkers: [],
          raw: {},
          contentHash: 'fetched-content-hash',
        },
      ],
      seenAt,
      {
        missingConfirmationThreshold: 1,
        spotCheckMissingPosts: jest.fn().mockResolvedValue(new Set()),
      },
    );

    expect(vkParsingPost.updateMany).toHaveBeenCalledTimes(1);
    expect(vkParsingPost.updateMany).toHaveBeenCalledWith({
      where: {
        id: {
          in: [
            'eligible',
            'active-lock',
            'ambiguous',
            'confirmed',
            'changed-after-publish',
            'rollback-armed',
            'rollback-active',
          ],
        },
        ownerProfile: VkParsingOwnerProfile.PUBLISHER,
        ownerBotId: 'publisher-bot',
        status: { in: ['NEW', 'FAILED', 'CHANGED_AFTER_PUBLISH'] },
        publishLockedAt: null,
        rollbackQueuedAt: null,
        rollbackLockedAt: null,
        rollbackIdempotencyKey: null,
        AND: [
          {
            OR: [
              { lastError: null },
              {
                AND: [
                  {
                    NOT: {
                      lastError: { startsWith: VK_MAX_SEND_AMBIGUOUS_ERROR_PREFIX },
                    },
                  },
                  {
                    NOT: {
                      lastError: {
                        startsWith: VK_MAX_SEND_CONFIRMED_PERSISTENCE_ERROR_PREFIX,
                      },
                    },
                  },
                ],
              },
            ],
          },
          {
            NOT: {
              publishIdempotencyKey: { not: null },
              publishAttemptCount: { gt: 0 },
            },
          },
        ],
      },
      data: {
        status: 'UNAVAILABLE',
        missingSeenCount: { increment: 1 },
        missingSinceAt: seenAt,
        lastAvailabilityCheckedAt: seenAt,
        unavailableAt: seenAt,
        publishQueuedAt: null,
        publishLockedAt: null,
        publishIdempotencyKey: null,
        publishReason: null,
        publishScheduleFingerprint: null,
      },
    });
  });
});
