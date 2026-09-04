import { VkParsingOwnerProfile } from '../prisma/prisma-client';
import { VK_AUTOPUBLISH_PENDING_SCHEDULE_FINGERPRINT } from './vk-autopublish-policy';
import {
  type ExistingVkPostImportState,
  type PreparedVkPostImport,
  VkParsingPostImportRepository,
} from './vk-parsing-post-import.repository';
import { VkSyncService } from './vk-sync.service';

type TestPost = {
  vkOwnerId: number;
  vkPostId: number;
  vkPublishedAt: Date | null;
  text: string;
  textFormat: 'plain';
  url: string;
  photoUrls: string[];
  videoUrls: string[];
  linkUrls: string[];
  attachments: unknown[];
  attachmentTypes: string[];
  unsupportedAttachments: unknown[];
  hasUnsupportedAttachments: boolean;
  isAdvertising: boolean;
  advertisingMarkers: string[];
  photoMedia: unknown[];
  videoMedia: unknown[];
  copyHistoryText: string[];
  raw: Record<string, unknown>;
  contentHash: string;
};

type UpsertResult = {
  imported: number;
  publishCandidates: Array<{ id: string }>;
};

describe('VkSyncService pending autopublish imports', () => {
  function createSource(overrides: Record<string, unknown> = {}) {
    return {
      id: 'source-1',
      chatId: 'channel-1',
      ownerProfile: VkParsingOwnerProfile.PUBLISHER,
      ownerBotId: 'publisher-bot',
      wallOwnerId: -36819802,
      status: 'ACTIVE',
      importEnabled: true,
      autoPublishEnabled: true,
      autoPublishEnabledAt: new Date('2026-09-04T09:00:00.000Z'),
      autoPublishPausedAt: null,
      publishMode: 'QUEUE',
      lastSuccessAt: new Date('2026-09-04T09:30:00.000Z'),
      ...overrides,
    };
  }

  function createPost(overrides: Partial<TestPost> = {}): TestPost {
    return {
      vkOwnerId: -36819802,
      vkPostId: 101,
      vkPublishedAt: new Date('2026-09-04T10:00:00.000Z'),
      text: 'Новый пост',
      textFormat: 'plain',
      url: 'https://vk.ru/wall-36819802_101',
      photoUrls: [],
      videoUrls: [],
      linkUrls: [],
      attachments: [],
      attachmentTypes: [],
      unsupportedAttachments: [],
      hasUnsupportedAttachments: false,
      isAdvertising: false,
      advertisingMarkers: [],
      photoMedia: [],
      videoMedia: [],
      copyHistoryText: [],
      raw: {},
      contentHash: 'content-hash',
      ...overrides,
    };
  }

  function createExistingPost(
    post: TestPost,
    overrides: Partial<ExistingVkPostImportState> = {},
  ): ExistingVkPostImportState {
    return {
      id: `post-${post.vkPostId}`,
      vkOwnerId: post.vkOwnerId,
      vkPostId: post.vkPostId,
      status: 'NEW',
      contentHash: post.contentHash,
      publishedContentHash: null,
      publishQueuedAt: null,
      publishIdempotencyKey: null,
      publishReason: null,
      publishCancelledAt: null,
      publishScheduleFingerprint: null,
      ...overrides,
    };
  }

  function createFixture() {
    const vkParsingSettings = {
      findUnique: jest.fn(),
    };
    const vkParsingPost = {
      findMany: jest.fn().mockResolvedValue([]),
    };
    const transaction = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      $queryRaw: jest.fn().mockResolvedValue([{ id: 'channel-1' }]),
      vkParsingPost,
      vkParsingSettings,
      vkParsingSource: {
        findFirst: jest.fn().mockResolvedValue(createSource()),
      },
    };
    const prisma = {
      vkParsingSettings,
      vkParsingPost,
      $transaction: jest.fn((callback: (tx: typeof transaction) => Promise<unknown>) =>
        callback(transaction),
      ),
    };
    const postImportRepository = {
      findExistingPosts: jest.fn().mockResolvedValue([]),
      persistImportedPosts: jest.fn().mockResolvedValue(undefined),
      markMissingPostsUnavailable: jest.fn().mockResolvedValue(undefined),
    };
    const configService = {
      get: jest.fn().mockReturnValue(undefined),
    };
    const service = new VkSyncService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      postImportRepository as never,
      configService as never,
      {} as never,
    );
    const internals = service as unknown as {
      resolveAutoPublishImportBaseline: (
        source: ReturnType<typeof createSource>,
        reason: 'scheduled' | 'source-added',
      ) => Promise<Date | null>;
      upsertPostsBatch: (
        source: ReturnType<typeof createSource>,
        posts: TestPost[],
        seenAt: Date,
        baseline: Date | null,
      ) => Promise<UpsertResult>;
      importPostsWithPolicyFence: (
        source: ReturnType<typeof createSource>,
        posts: TestPost[],
        seenAt: Date,
        reason: 'scheduled' | 'source-added',
      ) => Promise<UpsertResult>;
    };

    return { internals, postImportRepository, prisma, transaction };
  }

  it('inserts the pending marker without overwriting an existing marker on conflict', async () => {
    const prisma = {
      $executeRaw: jest.fn().mockResolvedValue(1),
    };
    const repository = new VkParsingPostImportRepository(prisma as never);

    await repository.persistImportedPosts(
      createSource() as never,
      [
        {
          post: createPost(),
          status: 'NEW',
          publishScheduleFingerprint: VK_AUTOPUBLISH_PENDING_SCHEDULE_FINGERPRINT,
        } as never,
      ],
      new Date('2026-09-04T10:05:00.000Z'),
    );

    const query = prisma.$executeRaw.mock.calls[0]?.[0] as
      | { strings?: readonly string[]; values?: unknown[] }
      | undefined;
    const sql = query?.strings?.join('?') ?? '';
    const conflictSql = sql.split('DO UPDATE SET')[1] ?? '';
    expect(query?.values).toContain(VK_AUTOPUBLISH_PENDING_SCHEDULE_FINGERPRINT);
    expect(conflictSql).not.toContain('publish_schedule_fingerprint');
  });

  it('marks only a new post inside an enabled Auto baseline as pending', async () => {
    const { internals, postImportRepository } = createFixture();
    const source = createSource();
    const baseline = new Date('2026-09-04T09:00:00.000Z');

    await internals.upsertPostsBatch(
      source,
      [createPost()],
      new Date('2026-09-04T10:05:00.000Z'),
      baseline,
    );

    const prepared = postImportRepository.persistImportedPosts.mock.calls[0]?.[1] as
      | PreparedVkPostImport[]
      | undefined;
    expect(prepared?.[0]?.publishScheduleFingerprint).toBe(
      VK_AUTOPUBLISH_PENDING_SCHEDULE_FINGERPRINT,
    );
  });

  it('re-reads disabled source policy under the chat lock before persisting', async () => {
    const { internals, postImportRepository, transaction } = createFixture();
    const staleSource = createSource();
    const disabledSource = createSource({
      autoPublishEnabled: false,
      autoPublishEnabledAt: null,
      autoPublishPausedAt: new Date('2026-09-04T10:04:00.000Z'),
    });
    transaction.vkParsingSource.findFirst.mockResolvedValue(disabledSource);

    await internals.importPostsWithPolicyFence(
      staleSource,
      [createPost()],
      new Date('2026-09-04T10:05:00.000Z'),
      'scheduled',
    );

    const prepared = postImportRepository.persistImportedPosts.mock.calls[0]?.[1] as
      | PreparedVkPostImport[]
      | undefined;
    expect(prepared?.[0]?.publishScheduleFingerprint).toBeNull();
    expect(postImportRepository.persistImportedPosts).toHaveBeenCalledWith(
      disabledSource,
      expect.any(Array),
      expect.any(Date),
      transaction,
    );
    expect(transaction.vkParsingSettings.findUnique).not.toHaveBeenCalled();
    expect(transaction.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      transaction.vkParsingSource.findFirst.mock.invocationCallOrder[0]!,
    );
    expect(transaction.vkParsingSource.findFirst.mock.invocationCallOrder[0]).toBeLessThan(
      postImportRepository.persistImportedPosts.mock.invocationCallOrder[0]!,
    );
  });

  it('keeps ordinary-sync imports unmarked while global Auto is disabled', async () => {
    const { internals, postImportRepository, prisma } = createFixture();
    const source = createSource();
    prisma.vkParsingSettings.findUnique.mockResolvedValue({
      autoPublishEnabled: false,
      autoPublishEnabledAt: null,
    });

    const baseline = await internals.resolveAutoPublishImportBaseline(source, 'scheduled');
    await internals.upsertPostsBatch(
      source,
      [createPost()],
      new Date('2026-09-04T10:05:00.000Z'),
      baseline,
    );

    expect(baseline).toBeNull();
    const prepared = postImportRepository.persistImportedPosts.mock.calls[0]?.[1] as
      | PreparedVkPostImport[]
      | undefined;
    expect(prepared?.[0]?.publishScheduleFingerprint).toBeNull();
    expect(prisma.vkParsingPost.findMany).not.toHaveBeenCalled();
  });

  it('keeps source-added and first-success backfills unmarked', async () => {
    const { internals, postImportRepository, prisma } = createFixture();
    const sourceAddedPost = createPost({ vkPostId: 101 });
    const firstSuccessPost = createPost({ vkPostId: 102 });

    const sourceAddedBaseline = await internals.resolveAutoPublishImportBaseline(
      createSource(),
      'source-added',
    );
    const firstSuccessBaseline = await internals.resolveAutoPublishImportBaseline(
      createSource({ lastSuccessAt: null }),
      'scheduled',
    );
    await internals.upsertPostsBatch(
      createSource(),
      [sourceAddedPost],
      new Date('2026-09-04T10:05:00.000Z'),
      sourceAddedBaseline,
    );
    await internals.upsertPostsBatch(
      createSource({ lastSuccessAt: null }),
      [firstSuccessPost],
      new Date('2026-09-04T10:05:00.000Z'),
      firstSuccessBaseline,
    );

    expect(sourceAddedBaseline).toBeNull();
    expect(firstSuccessBaseline).toBeNull();
    const preparedBatches = postImportRepository.persistImportedPosts.mock.calls.map(
      (call) => call[1] as PreparedVkPostImport[],
    );
    expect(preparedBatches.map((batch) => batch[0]?.publishScheduleFingerprint)).toEqual([
      null,
      null,
    ]);
    expect(prisma.vkParsingSettings.findUnique).not.toHaveBeenCalled();
    expect(prisma.vkParsingPost.findMany).not.toHaveBeenCalled();
  });

  it('does not turn unmarked history into pending work after Auto is enabled', async () => {
    const { internals, postImportRepository, prisma } = createFixture();
    const source = createSource();
    const post = createPost({ vkPublishedAt: new Date('2026-09-04T08:59:00.000Z') });
    postImportRepository.findExistingPosts.mockResolvedValue([createExistingPost(post)]);
    prisma.vkParsingSettings.findUnique.mockResolvedValue({
      autoPublishEnabled: true,
      autoPublishEnabledAt: new Date('2026-09-04T10:30:00.000Z'),
    });

    const baseline = await internals.resolveAutoPublishImportBaseline(source, 'scheduled');
    await internals.upsertPostsBatch(
      source,
      [post],
      new Date('2026-09-04T11:00:00.000Z'),
      baseline,
    );

    const prepared = postImportRepository.persistImportedPosts.mock.calls[0]?.[1] as
      | PreparedVkPostImport[]
      | undefined;
    expect(prepared?.[0]?.publishScheduleFingerprint).toBeNull();
    expect(prisma.vkParsingPost.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          publishScheduleFingerprint: { not: null },
          vkPublishedAt: { gte: baseline },
        }),
      }),
    );
  });

  it('filters stale markers by VK baseline before the limit without dropping an older createdAt', async () => {
    const { internals, prisma } = createFixture();
    const source = createSource();
    const baseline = new Date('2026-09-04T09:00:00.000Z');
    const staleRows = Array.from({ length: 101 }, (_, index) => ({
      id: `stale-${index}`,
      createdAt: new Date('2026-09-04T08:00:00.000Z'),
      vkPublishedAt: new Date('2026-09-04T08:00:00.000Z'),
    }));
    const freshRow = {
      id: 'fresh-post',
      createdAt: new Date('2026-09-04T08:30:00.000Z'),
      vkPublishedAt: new Date('2026-09-04T10:00:00.000Z'),
    };
    prisma.vkParsingPost.findMany.mockImplementation(async (query) => {
      const publishedAfter = query.where.vkPublishedAt.gte as Date;
      return [...staleRows, freshRow]
        .filter((row) => row.vkPublishedAt >= publishedAfter)
        .slice(0, query.take);
    });

    const result = await internals.upsertPostsBatch(
      source,
      [],
      new Date('2026-09-04T10:05:00.000Z'),
      baseline,
    );

    expect(result.publishCandidates).toEqual([freshRow]);
    expect(prisma.vkParsingPost.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          vkPublishedAt: { gte: baseline },
        }),
        take: 100,
      }),
    );
    expect(prisma.vkParsingPost.findMany.mock.calls[0]?.[0]?.where).not.toHaveProperty('createdAt');
  });
});
