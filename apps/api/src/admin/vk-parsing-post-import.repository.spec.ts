import { VkParsingOwnerProfile } from '../prisma/prisma-client';
import type { StorageRuntimeMetricsService } from '../system/storage-runtime-metrics.service';
import {
  VkParsingPostImportRepository,
  type PreparedVkPostImport,
} from './vk-parsing-post-import.repository';
import {
  VK_MAX_SEND_AMBIGUOUS_ERROR_PREFIX,
  VK_MAX_SEND_CONFIRMED_PERSISTENCE_ERROR_PREFIX,
} from './vk-publish-quarantine';

describe('VkParsingPostImportRepository', () => {
  const source = {
    id: 'source-1',
    chatId: 'channel-1',
    wallOwnerId: -36819802,
    ownerProfile: VkParsingOwnerProfile.PUBLISHER,
    ownerBotId: 'publisher-bot',
  };

  function importedPosts(count: number): PreparedVkPostImport[] {
    return Array.from({ length: count }, (_, index) => ({
      status: 'NEW',
      publishScheduleFingerprint: null,
      post: {
        vkOwnerId: source.wallOwnerId,
        vkPostId: index + 1,
        vkPublishedAt: null,
        text: 'private post content',
        textFormat: 'plain',
        url: 'https://example.test/private-post',
        photoUrls: [],
        videoUrls: [],
        linkUrls: [],
        attachments: [],
        attachmentTypes: [],
        unsupportedAttachments: [],
        hasUnsupportedAttachments: false,
        isAdvertising: false,
        advertisingMarkers: [],
        raw: { privateContent: 'must not reach counters' },
        contentHash: 'private-content-hash',
      },
    }));
  }

  afterEach(() => jest.restoreAllMocks());

  it('records bounded aggregate statement outcomes without source or post content', async () => {
    const $executeRaw = jest
      .fn()
      .mockResolvedValueOnce(50)
      .mockResolvedValueOnce(35)
      .mockResolvedValueOnce(0);
    const repository = new VkParsingPostImportRepository({ $executeRaw } as never);
    jest
      .spyOn(Date, 'now')
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(50)
      .mockReturnValueOnce(50)
      .mockReturnValueOnce(300)
      .mockReturnValueOnce(300)
      .mockReturnValueOnce(2300);

    await repository.persistImportedPosts(source, importedPosts(120), new Date(0));

    expect($executeRaw).toHaveBeenCalledTimes(3);
    expect(repository.getPersistenceSnapshot()).toEqual({
      batches: 3,
      postsAttempted: 120,
      rowsWritten: 85,
      rowsSkippedOrFenced: 35,
      failedBatches: 0,
      durationBuckets: {
        under100Ms: 1,
        under500Ms: 1,
        under2000Ms: 0,
        atLeast2000Ms: 1,
      },
    });
    const snapshot = repository.getPersistenceSnapshot();
    snapshot.postsAttempted = 0;
    snapshot.durationBuckets.under100Ms = 0;
    expect(repository.getPersistenceSnapshot().postsAttempted).toBe(120);
    expect(repository.getPersistenceSnapshot().durationBuckets.under100Ms).toBe(1);
  });

  it('propagates a failed batch without treating unexecuted posts as skips', async () => {
    const failure = new Error('database unavailable');
    const $executeRaw = jest.fn().mockResolvedValueOnce(50).mockRejectedValueOnce(failure);
    const repository = new VkParsingPostImportRepository({ $executeRaw } as never);

    await expect(
      repository.persistImportedPosts(source, importedPosts(120), new Date(0)),
    ).rejects.toBe(failure);

    expect($executeRaw).toHaveBeenCalledTimes(2);
    expect(repository.getPersistenceSnapshot()).toEqual({
      batches: 2,
      postsAttempted: 100,
      rowsWritten: 50,
      rowsSkippedOrFenced: 0,
      failedBatches: 1,
      durationBuckets: expect.any(Object),
    });
    expect(
      Object.values(repository.getPersistenceSnapshot().durationBuckets).reduce(
        (total, count) => total + count,
        0,
      ),
    ).toBe(2);
  });

  it('does not execute SQL or count batches for an empty import', async () => {
    const $executeRaw = jest.fn();
    const repository = new VkParsingPostImportRepository({ $executeRaw } as never);

    await repository.persistImportedPosts(source, [], new Date(0));

    expect($executeRaw).not.toHaveBeenCalled();
    expect(repository.getPersistenceSnapshot().batches).toBe(0);
    expect(repository.getPersistenceSnapshot().postsAttempted).toBe(0);
  });

  it('exposes current aggregate counts through the optional runtime metrics provider', async () => {
    const registerVkPersistenceSnapshot = jest.fn();
    const $executeRaw = jest.fn().mockResolvedValue(1);
    const repository = new VkParsingPostImportRepository(
      { $executeRaw } as never,
      { registerVkPersistenceSnapshot } as unknown as StorageRuntimeMetricsService,
    );
    expect(registerVkPersistenceSnapshot).toHaveBeenCalledTimes(1);
    const provider = registerVkPersistenceSnapshot.mock.calls[0]?.[0] as () => unknown;
    expect(provider()).toEqual(expect.objectContaining({ batches: 0, rowsWritten: 0 }));
    await repository.persistImportedPosts(source, importedPosts(1), new Date(0));
    expect(provider()).toEqual(expect.objectContaining({ batches: 1, rowsWritten: 1 }));
  });

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

    expect(vkParsingPost.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 100,
        orderBy: [{ lastAvailabilityCheckedAt: { sort: 'asc', nulls: 'first' } }, { id: 'asc' }],
      }),
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
