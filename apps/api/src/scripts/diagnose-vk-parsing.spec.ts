import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PublicationDispatchProfile, VkParsingOwnerProfile } from '../prisma/prisma-client';
import {
  loadOwnedPublishDatabaseSnapshot,
  loadPublishBacklog,
  loadRecentPublishSuccess,
  loadSchedulePolicyDiagnostics,
  readCliOptions,
  reconcilePublishQueueSnapshots,
  renderTextDiagnostics,
  summarizeDispatchBlockers,
  summarizeSchedulePolicies,
} from './diagnose-vk-parsing';

const PUBLISHER_BOT_ID = 'publisher-bot';
const PUBLISHER_JOB_ROUTE = {
  kind: 'publish',
  dispatchProfile: PublicationDispatchProfile.PUBLIK_V1,
  requiredBotId: PUBLISHER_BOT_ID,
} as const;
const diagnoseSource = readFileSync(resolve(__dirname, 'diagnose-vk-parsing.ts'), 'utf8');

function createStableQueueSnapshots(counts: Record<string, number> = {}, paused = true) {
  return {
    queueBefore: { paused, counts },
    queueAfter: { paused, counts },
  };
}

function createEmptyPublishQueueReconciliation() {
  return reconcilePublishQueueSnapshots({
    available: true,
    error: null,
    generatedAt: new Date('2026-05-27T22:55:03.204Z'),
    database: { totalRows: 0, rows: [], cap: 5_000, truncated: false, consistent: true },
    queueCap: 5_000,
    ...createStableQueueSnapshots(),
    scannedQueueJobs: [],
    queueJobsTruncated: false,
    ownedJobs: [],
    sampleLimit: 20,
  });
}

function createEmptyOperationalAggregates() {
  return {
    recentPublishSuccess: {
      scope: 'autopublish' as const,
      count: 0,
      latestAt: null,
      complete: true,
      sourceCap: 1_000,
      scannedSourceCount: 0,
      sourcesTruncated: false,
    },
    dispatchBlockers: { totalBlockedPosts: 0, complete: true, codes: [] },
    schedulePolicies: {
      sourceCap: 1_000,
      totalSourceCount: 0,
      scannedSourceCount: 0,
      truncated: false,
      sourceSnapshotConsistent: true,
      queuedCountsComplete: true,
      runtimeStates: {
        runnableSourceCount: 0,
        globalAutoDisabledSourceCount: 0,
        globalAutoIncompleteSourceCount: 0,
        killSwitchPausedSourceCount: 0,
        settingsMissingSourceCount: 0,
      },
      groupCap: 200,
      groupsTruncated: false,
      groups: [],
    },
  };
}

describe('diagnose-vk-parsing script helpers', () => {
  it('parses CLI options with environment fallback', () => {
    expect(
      readCliOptions(['--json', '--limit', '5', '--window-hours', '12'], {
        REDIS_URL: 'redis://localhost:6379/0',
        MAX_PUBLISHER_BOT_ID: ` ${PUBLISHER_BOT_ID} `,
      } as NodeJS.ProcessEnv),
    ).toEqual({
      json: true,
      limit: 5,
      reconcileCap: 5_000,
      windowHours: 12,
      redisUrl: 'redis://localhost:6379/0',
      publisherBotId: PUBLISHER_BOT_ID,
    });
  });

  it('uses read-only handles for only the active Publisher queues', () => {
    expect(diagnoseSource).toContain("const VK_PUBLISHER_QUEUE = 'vk-parsing-publisher'");
    expect(diagnoseSource).not.toMatch(/['"]vk-parsing-publish['"]/u);
    expect(diagnoseSource).toContain('skipMetasUpdate: true');
    expect([...diagnoseSource.matchAll(/new Queue\(/gu)]).toHaveLength(3);
    expect([
      ...diagnoseSource.matchAll(/new Queue\([^,\n]+, diagnosticQueueOptions\)/gu),
    ]).toHaveLength(3);
  });

  it('loads only exact Publisher-owned Publik rows for the configured bot', async () => {
    const count = jest.fn().mockResolvedValue(0);
    const findMany = jest.fn().mockResolvedValue([]);
    const prisma = { vkParsingPost: { count, findMany } };
    const ownershipWhere = {
      ownerProfile: VkParsingOwnerProfile.PUBLISHER,
      ownerBotId: PUBLISHER_BOT_ID,
      dispatchProfile: PublicationDispatchProfile.PUBLIK_V1,
      requiredBotId: PUBLISHER_BOT_ID,
      publishQueuedAt: { not: null },
      source: {
        ownerProfile: VkParsingOwnerProfile.PUBLISHER,
        ownerBotId: PUBLISHER_BOT_ID,
      },
    };

    await loadOwnedPublishDatabaseSnapshot(prisma as never, 100, PUBLISHER_BOT_ID);

    expect(count).toHaveBeenCalledTimes(2);
    expect(count).toHaveBeenNthCalledWith(1, { where: ownershipWhere });
    expect(count).toHaveBeenNthCalledWith(2, { where: ownershipWhere });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: ownershipWhere,
        select: expect.objectContaining({ requiredBotId: true }),
      }),
    );
  });

  it('builds syntactically balanced publish backlog SQL', async () => {
    const row = { queuedPosts: 3, dueQueuedPosts: 0, secondsToNext: 120 };
    const queryRaw = jest.fn().mockResolvedValue([row]);

    await expect(
      loadPublishBacklog({ $queryRaw: queryRaw } as never, PUBLISHER_BOT_ID),
    ).resolves.toEqual(row);

    const queryText = (queryRaw.mock.calls[0]?.[0] as TemplateStringsArray).join('?');
    const openingParentheses = queryText.match(/\(/gu)?.length ?? 0;
    const closingParentheses = queryText.match(/\)/gu)?.length ?? 0;

    expect(openingParentheses).toBe(closingParentheses);
    expect(queryText).toContain('end as "secondsToNext"');
  });

  it('groups only allowlisted dispatch blocker codes without exposing row identifiers', () => {
    const summary = summarizeDispatchBlockers({
      totalRows: 4,
      cap: 100,
      truncated: false,
      consistent: true,
      rows: [
        {
          id: 'post-secret-1',
          chatId: 'chat-secret',
          sourceId: 'source-secret',
          status: 'FAILED',
          publishReason: 'autopublish',
          publishQueuedAt: new Date('2026-09-04T09:00:00.000Z'),
          publishScheduledAt: new Date('2026-09-04T10:00:00.000Z'),
          publishLockedAt: null,
          publishIdempotencyKey: 'key-secret-1',
          requiredBotId: PUBLISHER_BOT_ID,
          dispatchBlockerCode: 'publisher_runtime_unavailable',
          dispatchBlockedAt: new Date('2026-09-04T10:00:00.000Z'),
        },
        {
          id: 'post-secret-2',
          chatId: 'chat-secret',
          sourceId: 'source-secret',
          status: 'FAILED',
          publishReason: 'autopublish',
          publishQueuedAt: new Date('2026-09-04T09:00:00.000Z'),
          publishScheduledAt: new Date('2026-09-04T10:00:00.000Z'),
          publishLockedAt: null,
          publishIdempotencyKey: 'key-secret-2',
          requiredBotId: PUBLISHER_BOT_ID,
          dispatchBlockerCode: 'publisher_runtime_unavailable',
          dispatchBlockedAt: new Date('2026-09-04T10:05:00.000Z'),
        },
        {
          id: 'post-secret-3',
          chatId: 'chat-secret',
          sourceId: 'source-secret',
          status: 'FAILED',
          publishReason: 'manual-retry',
          publishQueuedAt: new Date('2026-09-04T09:00:00.000Z'),
          publishScheduledAt: null,
          publishLockedAt: null,
          publishIdempotencyKey: 'key-secret-3',
          requiredBotId: PUBLISHER_BOT_ID,
          dispatchBlockerCode: 'unexpected_internal_detail',
          dispatchBlockedAt: new Date('2026-09-04T10:04:00.000Z'),
        },
        {
          id: 'post-secret-4',
          chatId: 'chat-secret',
          sourceId: 'source-secret',
          status: 'FAILED',
          publishReason: 'manual-retry',
          publishQueuedAt: new Date('2026-09-04T09:00:00.000Z'),
          publishScheduledAt: null,
          publishLockedAt: null,
          publishIdempotencyKey: 'key-secret-4',
          requiredBotId: PUBLISHER_BOT_ID,
          dispatchBlockerCode: 'dialog_context_unavailable',
          dispatchBlockedAt: new Date('2026-09-04T10:03:00.000Z'),
        },
      ],
    });

    expect(summary).toEqual({
      totalBlockedPosts: 4,
      complete: true,
      codes: [
        {
          code: 'publisher_runtime_unavailable',
          count: 2,
          latestAt: '2026-09-04T10:05:00.000Z',
        },
        {
          code: 'dialog_context_unavailable',
          count: 1,
          latestAt: '2026-09-04T10:03:00.000Z',
        },
        { code: 'other', count: 1, latestAt: '2026-09-04T10:04:00.000Z' },
      ],
    });
    expect(JSON.stringify(summary)).not.toMatch(
      /post-secret|chat-secret|source-secret|key-secret/u,
    );
  });

  it('loads recent autopublish success through a capped source and indexed time range', async () => {
    const queryRaw = jest.fn().mockResolvedValue([
      {
        count: 17,
        latestAt: new Date('2026-09-04T11:59:00.000Z'),
        scannedSourceCount: 1_000,
        sourcesTruncated: true,
      },
    ]);

    const result = await loadRecentPublishSuccess(
      { $queryRaw: queryRaw } as never,
      new Date('2026-09-04T06:00:00.000Z'),
      PUBLISHER_BOT_ID,
    );

    expect(result).toEqual({
      scope: 'autopublish',
      count: 17,
      latestAt: '2026-09-04T11:59:00.000Z',
      complete: false,
      sourceCap: 1_000,
      scannedSourceCount: 1_000,
      sourcesTruncated: true,
    });
    const queryText = (queryRaw.mock.calls[0]?.[0] as TemplateStringsArray).join('?');
    expect(queryText).toContain('limit ?');
    expect(queryText).toContain('post.chat_id = source.chat_id');
    expect(queryText).toContain('post.source_id = source.id');
    expect(queryText).toContain('post.auto_published_at >= ?');
    expect(queryText).toContain('count(*)::int as source_count');
    expect(queryText).toContain('coalesce(sum(source_count), 0)::int');
    expect(queryText).toContain('offset 0');
    expect(queryText).not.toContain('published_at_max');
  });

  it('summarizes schedule policies, queue depth, and daily-cap saturation without IDs', () => {
    const generatedAt = new Date('2026-09-04T12:00:00.000Z');
    const baseQueuedPost = {
      chatId: 'chat-secret',
      status: 'NEW',
      publishReason: 'autopublish',
      publishQueuedAt: generatedAt,
      publishLockedAt: null,
      publishIdempotencyKey: 'key-secret',
      requiredBotId: PUBLISHER_BOT_ID,
    } as const;
    const summary = summarizeSchedulePolicies({
      generatedAt,
      sources: [
        {
          id: 'source-secret-1',
          chatId: 'chat-secret',
          publishIntervalMinutes: 30,
          minPublishIntervalMinutes: 10,
          dailyLimit: 3,
          publishMode: 'QUEUE',
        },
        {
          id: 'source-secret-2',
          chatId: 'chat-secret',
          publishIntervalMinutes: 30,
          minPublishIntervalMinutes: 10,
          dailyLimit: 3,
          publishMode: 'queue',
        },
        {
          id: 'source-secret-without-queue',
          chatId: 'chat-secret',
          publishIntervalMinutes: 30,
          minPublishIntervalMinutes: 10,
          dailyLimit: 3,
          publishMode: 'QUEUE',
        },
        {
          id: 'source-secret-paused',
          chatId: 'chat-secret',
          publishIntervalMinutes: 30,
          minPublishIntervalMinutes: 10,
          dailyLimit: 3,
          publishMode: 'QUEUE',
          runtimeState: 'kill_switch_paused',
        },
      ],
      queuedPosts: [
        {
          ...baseQueuedPost,
          id: 'post-secret-1',
          sourceId: 'source-secret-1',
          publishScheduledAt: new Date('2026-09-04T12:30:00.000Z'),
        },
        {
          ...baseQueuedPost,
          id: 'post-secret-2',
          sourceId: 'source-secret-1',
          publishScheduledAt: new Date('2026-09-04T13:00:00.000Z'),
        },
        {
          ...baseQueuedPost,
          id: 'post-secret-3',
          sourceId: 'source-secret-2',
          publishScheduledAt: new Date('2026-09-04T12:45:00.000Z'),
        },
        {
          ...baseQueuedPost,
          id: 'post-secret-paused',
          sourceId: 'source-secret-paused',
          publishScheduledAt: new Date('2026-09-04T13:30:00.000Z'),
        },
      ],
      dailyPublishedCounts: new Map([
        ['source-secret-1', 3],
        ['source-secret-2', 2],
        ['source-secret-without-queue', 3],
        ['source-secret-paused', 3],
      ]),
      sourceCap: 100,
      totalSourceCount: 4,
      sourceSnapshotConsistent: true,
      queuedCountsComplete: true,
    });

    expect(summary).toEqual({
      sourceCap: 100,
      totalSourceCount: 4,
      scannedSourceCount: 4,
      truncated: false,
      sourceSnapshotConsistent: true,
      queuedCountsComplete: true,
      runtimeStates: {
        runnableSourceCount: 3,
        globalAutoDisabledSourceCount: 0,
        globalAutoIncompleteSourceCount: 0,
        killSwitchPausedSourceCount: 1,
        settingsMissingSourceCount: 0,
      },
      groupCap: 200,
      groupsTruncated: false,
      groups: [
        {
          publishIntervalMinutes: 30,
          minPublishIntervalMinutes: 10,
          dailyLimit: 3,
          publishMode: 'QUEUE',
          sourceCount: 4,
          queuedCount: 4,
          dailyCapReachedSourceCount: 1,
          earliestNextScheduledAt: '2026-09-04T12:30:00.000Z',
          secondsToEarliestNext: 1_800,
        },
      ],
    });
    expect(JSON.stringify(summary)).not.toMatch(
      /post-secret|chat-secret|source-secret|key-secret/u,
    );
  });

  it('uses DST-aware local-day bounds and clamps the schedule source scan cap', async () => {
    const sourceCount = jest.fn().mockResolvedValue(2);
    const sourceFindMany = jest.fn().mockResolvedValue([
      {
        id: 'source-secret',
        chatId: 'chat-secret',
        publishIntervalMinutes: 30,
        minPublishIntervalMinutes: 10,
        dailyLimit: 1,
        publishMode: 'IMMEDIATE',
      },
      {
        id: 'source-incomplete',
        chatId: 'chat-incomplete',
        publishIntervalMinutes: 30,
        minPublishIntervalMinutes: 10,
        dailyLimit: 1,
        publishMode: 'IMMEDIATE',
      },
    ]);
    const settingsFindMany = jest.fn().mockResolvedValue([
      {
        chatId: 'chat-secret',
        schedulerTimezone: 'America/New_York',
        autoPublishEnabled: true,
        autoPublishEnabledAt: new Date('2026-03-01T12:00:00.000Z'),
        autoPublishKillSwitchEnabled: false,
      },
      {
        chatId: 'chat-incomplete',
        schedulerTimezone: 'America/New_York',
        autoPublishEnabled: true,
        autoPublishEnabledAt: null,
        autoPublishKillSwitchEnabled: false,
      },
    ]);
    const groupBy = jest
      .fn()
      .mockResolvedValue([{ sourceId: 'source-secret', _count: { _all: 1 } }]);
    const prisma = {
      vkParsingSource: { count: sourceCount, findMany: sourceFindMany },
      vkParsingSettings: { findMany: settingsFindMany },
      vkParsingPost: { groupBy },
    };
    const ownedSnapshot = {
      totalRows: 1,
      rows: [
        {
          id: 'post-secret',
          chatId: 'chat-secret',
          sourceId: 'source-secret',
          status: 'NEW',
          publishReason: 'autopublish',
          publishQueuedAt: new Date('2026-03-08T11:00:00.000Z'),
          publishScheduledAt: new Date('2026-03-08T13:00:00.000Z'),
          publishLockedAt: null,
          publishIdempotencyKey: 'key-secret',
          requiredBotId: PUBLISHER_BOT_ID,
        },
      ],
      cap: 5_000,
      truncated: false,
      consistent: true,
    };

    const summary = await loadSchedulePolicyDiagnostics(
      prisma as never,
      PUBLISHER_BOT_ID,
      new Date('2026-03-08T12:00:00.000Z'),
      ownedSnapshot,
      50_000,
    );

    expect(sourceFindMany).toHaveBeenCalledWith(expect.objectContaining({ take: 1_000 }));
    expect(groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          chatId: { in: ['chat-secret', 'chat-incomplete'] },
          autoPublishedAt: {
            gte: new Date('2026-03-08T05:00:00.000Z'),
            lt: new Date('2026-03-09T04:00:00.000Z'),
          },
        }),
      }),
    );
    expect(summary.groups[0]).toMatchObject({
      publishMode: 'IMMEDIATE',
      dailyCapReachedSourceCount: 1,
    });
    expect(summary.runtimeStates).toEqual({
      runnableSourceCount: 1,
      globalAutoDisabledSourceCount: 0,
      globalAutoIncompleteSourceCount: 1,
      killSwitchPausedSourceCount: 0,
      settingsMissingSourceCount: 0,
    });
  });

  it('renders a compact operational summary', () => {
    const rendered = renderTextDiagnostics({
      generatedAt: '2026-05-27T22:55:03.204Z',
      windowHours: 6,
      sourceStatus: [{ syncStatus: 'IDLE', lastErrorCode: '', count: 59 }],
      sourceHealth: {
        sourceCount: 59,
        healthySources: 59,
        errorSources: 0,
        inFlightSources: 0,
        staleSyncLocks: 1,
      },
      noisySources: [],
      syncPerformance: {
        fetchedPosts: 300,
        importedPosts: 12,
        p95SyncDurationMs: 1250,
      },
      publishBacklog: {
        queuedPosts: 2,
        dueQueuedPosts: 1,
        futureScheduledPosts: 1,
        unstampedSchedulePosts: 0,
        staleLockedPosts: 0,
        oldestDueQueuedAgeSec: 45,
        nextScheduledAt: new Date('2026-05-27T23:00:03.204Z'),
        secondsToNext: 300,
      },
      ...createEmptyOperationalAggregates(),
      stuckPublishPosts: [],
      recentPublishFailures: [],
      mediaStatus: [{ status: 'READY', count: 100, withIdentity: 80 }],
      mediaIdentityConflicts: [],
      recentMediaFailures: [],
      publishQueueReconciliation: createEmptyPublishQueueReconciliation(),
      queues: {
        available: true,
        error: null,
        sync: { name: 'vk-parsing-sync', counts: { waiting: 0 }, jobs: [] },
        publish: { name: 'vk-parsing-publisher', counts: { waiting: 2 }, jobs: [] },
      },
    });

    expect(rendered).toContain('Sources: 59/59 healthy');
    expect(rendered).toContain('1 stale locks');
    expect(rendered).toContain('Publish backlog: 1 due / 2 queued');
    expect(rendered).toContain('0 pending schedule reconciliation');
    expect(rendered).toContain('Next canonical publish: 2026-05-27T23:00:03.204Z, countdown 300s');
    expect(rendered).toContain(
      'Recent successful VK autopublishes: 0, latest none, complete=true, sources=0/1000, truncated=false',
    );
    expect(rendered).toContain('Active dispatch blockers: 0, complete=true, codes=[]');
    expect(rendered).toContain('Schedule policies: 0/0 sources scanned (cap 1000)');
    expect(rendered).toContain('sync={"waiting":0}');
    expect(rendered).toContain('Publish reconciliation: 0/0 DB-owned scanned');
  });

  it('surfaces orphaned BullMQ jobs referenced by stuck database rows', () => {
    const rendered = renderTextDiagnostics({
      generatedAt: '2026-07-27T17:40:00.000Z',
      windowHours: 6,
      sourceStatus: [],
      sourceHealth: {},
      noisySources: [],
      syncPerformance: {},
      publishBacklog: { dueQueuedPosts: 2, queuedPosts: 2 },
      ...createEmptyOperationalAggregates(),
      stuckPublishPosts: [],
      recentPublishFailures: [],
      mediaStatus: [],
      mediaIdentityConflicts: [],
      recentMediaFailures: [],
      publishQueueReconciliation: createEmptyPublishQueueReconciliation(),
      queues: {
        available: true,
        error: null,
        sync: { name: 'vk-parsing-sync', counts: {}, jobs: [] },
        publish: {
          name: 'vk-parsing-publisher',
          counts: { waiting: 0, active: 0, delayed: 0 },
          jobs: [],
          referencedJobs: [
            { id: 'job-1', state: 'unknown' },
            { id: 'job-2', state: 'missing' },
          ],
        },
      },
    });

    expect(rendered).toContain('Stuck publish job states: {"unknown":1,"missing":1}');
  });

  it('reconciles all scanned DB owners with queue jobs and reports bounded samples', () => {
    const generatedAt = new Date('2026-07-30T12:00:00.000Z');
    const firstJobId = 'vk-parsing-publish__post-1__key-1';
    const secondJobId = 'vk-parsing-publish__post-2__key-2';
    const thirdJobId = 'vk-parsing-publish__post-3__key-3';
    const rows = [
      {
        id: 'post-1',
        chatId: 'chat-1',
        sourceId: 'source-1',
        status: 'NEW',
        publishReason: 'autopublish',
        publishQueuedAt: new Date('2026-07-30T11:50:00.000Z'),
        publishScheduledAt: new Date('2026-07-30T13:00:00.000Z'),
        publishLockedAt: null,
        publishIdempotencyKey: 'key-1',
        requiredBotId: PUBLISHER_BOT_ID,
      },
      {
        id: 'post-2',
        chatId: 'chat-1',
        sourceId: 'source-2',
        status: 'NEW',
        publishReason: 'autopublish',
        publishQueuedAt: new Date('2026-07-30T11:51:00.000Z'),
        publishScheduledAt: new Date('2026-07-30T14:00:00.000Z'),
        publishLockedAt: null,
        publishIdempotencyKey: 'key-2',
        requiredBotId: PUBLISHER_BOT_ID,
      },
      {
        id: 'post-3',
        chatId: 'chat-2',
        sourceId: 'source-3',
        status: 'FAILED',
        publishReason: 'manual-schedule',
        publishQueuedAt: new Date('2026-07-30T11:52:00.000Z'),
        publishScheduledAt: new Date('2026-08-04T12:00:00.000Z'),
        publishLockedAt: null,
        publishIdempotencyKey: 'key-3',
        requiredBotId: PUBLISHER_BOT_ID,
      },
    ];
    const firstJob = {
      id: firstJobId,
      name: 'publish-vk-post',
      state: 'delayed',
      timestamp: new Date('2026-07-30T12:00:00.000Z').getTime(),
      delay: 60 * 60_000,
      attemptsMade: 0,
      attemptsStarted: 0,
      processedOn: null,
      finishedOn: null,
      data: {
        ...PUBLISHER_JOB_ROUTE,
        postId: 'post-1',
        chatId: 'chat-1',
        reason: 'autopublish',
        idempotencyKey: 'key-1',
      },
    };
    const mismatchedJob = {
      id: thirdJobId,
      name: 'publish-vk-post',
      state: 'delayed',
      timestamp: new Date('2026-07-30T12:00:00.000Z').getTime(),
      delay: 3 * 60 * 60_000,
      attemptsMade: 0,
      attemptsStarted: 0,
      processedOn: null,
      finishedOn: null,
      data: {
        ...PUBLISHER_JOB_ROUTE,
        requiredBotId: 'other-publisher-bot',
        postId: 'post-3',
        chatId: 'wrong-chat',
        reason: 'autopublish',
        idempotencyKey: 'key-3',
      },
    };
    const orphanJob = {
      id: 'vk-parsing-publish__orphan__orphan-key',
      name: 'publish-vk-post',
      state: 'delayed',
      timestamp: generatedAt.getTime(),
      delay: 30 * 60_000,
      attemptsMade: 0,
      attemptsStarted: 0,
      processedOn: null,
      finishedOn: null,
      data: {
        ...PUBLISHER_JOB_ROUTE,
        postId: 'orphan',
        chatId: 'chat-orphan',
        reason: 'autopublish',
        idempotencyKey: 'orphan-key',
      },
    };

    const result = reconcilePublishQueueSnapshots({
      available: true,
      error: null,
      generatedAt,
      database: { totalRows: 3, rows, cap: 100, truncated: false, consistent: true },
      queueCap: 100,
      ...createStableQueueSnapshots({ delayed: 3 }),
      scannedQueueJobs: [firstJob, mismatchedJob, orphanJob],
      queueJobsTruncated: false,
      ownedJobs: [
        { expectedJobId: firstJobId, job: firstJob },
        { expectedJobId: secondJobId, job: null },
        { expectedJobId: thirdJobId, job: mismatchedJob },
      ],
      sampleLimit: 2,
    });

    expect(result.database).toEqual({
      totalOwnedRows: 3,
      scannedOwnedRows: 3,
      cap: 100,
      truncated: false,
      consistent: true,
      futureScheduledRows: 3,
      maxScheduledAt: '2026-08-04T12:00:00.000Z',
      maxFutureHorizonSec: 5 * 24 * 60 * 60,
    });
    expect(result.queue.totalJobs).toBe(3);
    expect(result.queue.scannedJobs).toBe(3);
    expect(result.queue.stateDistribution).toEqual({
      waiting: 0,
      active: 0,
      delayed: 3,
      failed: 0,
      completed: 0,
      paused: 0,
      prioritized: 0,
      'waiting-children': 0,
    });
    expect(result.queue.ownedStateDistribution).toMatchObject({
      delayed: 2,
      missing: 1,
    });
    expect(result.missingJobs).toEqual({
      count: 1,
      complete: true,
      samples: [
        {
          postId: 'post-2',
          chatId: 'chat-1',
          publishReason: 'autopublish',
          publishScheduledAt: '2026-07-30T14:00:00.000Z',
          expectedJobId: secondJobId,
        },
      ],
    });
    expect(result.orphanJobs.count).toBe(1);
    expect(result.orphanJobs.actionableCount).toBe(1);
    expect(result.orphanJobs.complete).toBe(true);
    expect(result.orphanJobs.samples[0]).toMatchObject({
      jobId: orphanJob.id,
      postId: 'orphan',
      state: 'delayed',
    });
    expect(result.payloadMismatches.count).toBe(1);
    expect(result.payloadMismatches.samples[0]?.mismatchedFields).toEqual([
      'chatId',
      'reason',
      'requiredBotId',
    ]);
    expect(result.scheduleDrift.count).toBe(1);
    expect(result.scheduleDrift.comparableJobs).toBe(2);
    expect(result.scheduleDrift.complete).toBe(false);
    expect(result.scheduleDrift.nonComparableFutureJobs).toBe(1);
    expect(result.scheduleDrift.nonComparableFutureSamples[0]).toMatchObject({
      postId: 'post-2',
      state: null,
      reason: 'missing_job',
    });
    expect(result.scheduleDrift.maxAbsDriftMs).toBe(117 * 60 * 60_000);
    expect(result.scheduleDrift.samples[0]).toMatchObject({
      postId: 'post-3',
      databaseScheduledAt: '2026-08-04T12:00:00.000Z',
      queueScheduledAt: '2026-07-30T15:00:00.000Z',
      driftMs: -117 * 60 * 60_000,
    });
  });

  it('reports queued ownership without an idempotency key as a missing job', () => {
    const result = reconcilePublishQueueSnapshots({
      available: true,
      error: null,
      generatedAt: new Date('2026-07-30T12:00:00.000Z'),
      database: {
        totalRows: 1,
        cap: 100,
        truncated: false,
        consistent: true,
        rows: [
          {
            id: 'post-without-key',
            chatId: 'chat-1',
            sourceId: 'source-1',
            status: 'NEW',
            publishReason: 'autopublish',
            publishQueuedAt: new Date('2026-07-30T11:00:00.000Z'),
            publishScheduledAt: new Date('2026-07-30T13:00:00.000Z'),
            publishLockedAt: null,
            publishIdempotencyKey: null,
            requiredBotId: PUBLISHER_BOT_ID,
          },
        ],
      },
      queueCap: 100,
      ...createStableQueueSnapshots(),
      scannedQueueJobs: [],
      queueJobsTruncated: false,
      ownedJobs: [{ expectedJobId: null, job: null }],
      sampleLimit: 20,
    });

    expect(result.missingJobs).toEqual({
      count: 1,
      complete: true,
      samples: [
        {
          postId: 'post-without-key',
          chatId: 'chat-1',
          publishReason: 'autopublish',
          publishScheduledAt: '2026-07-30T13:00:00.000Z',
          expectedJobId: null,
        },
      ],
    });
  });

  it('marks capped reconciliation incomplete without false orphan findings', () => {
    const result = reconcilePublishQueueSnapshots({
      available: true,
      error: null,
      generatedAt: new Date('2026-07-30T12:00:00.000Z'),
      database: {
        totalRows: 2,
        cap: 1,
        truncated: true,
        consistent: true,
        rows: [
          {
            id: 'post-1',
            chatId: 'chat-1',
            sourceId: 'source-1',
            status: 'NEW',
            publishReason: 'autopublish',
            publishQueuedAt: new Date('2026-07-30T11:00:00.000Z'),
            publishScheduledAt: new Date('2026-07-30T13:00:00.000Z'),
            publishLockedAt: null,
            publishIdempotencyKey: 'key-1',
            requiredBotId: PUBLISHER_BOT_ID,
          },
        ],
      },
      queueCap: 1,
      ...createStableQueueSnapshots({ delayed: 2 }),
      scannedQueueJobs: [
        {
          id: 'vk-parsing-publish__post-2__key-2',
          name: 'publish-vk-post',
          state: 'delayed',
          timestamp: new Date('2026-07-30T12:00:00.000Z').getTime(),
          delay: 60_000,
          attemptsMade: 0,
          attemptsStarted: 0,
          processedOn: null,
          finishedOn: null,
          data: {
            ...PUBLISHER_JOB_ROUTE,
            postId: 'post-2',
            chatId: 'chat-2',
            reason: 'autopublish',
            idempotencyKey: 'key-2',
          },
        },
      ],
      queueJobsTruncated: true,
      ownedJobs: [{ expectedJobId: 'vk-parsing-publish__post-1__key-1', job: null }],
      sampleLimit: 20,
    });

    expect(result.database.truncated).toBe(true);
    expect(result.queue.truncated).toBe(true);
    expect(result.missingJobs).toMatchObject({ count: 1, complete: false });
    expect(result.orphanJobs).toMatchObject({ count: 0, complete: false, samples: [] });
    expect(result.payloadMismatches.complete).toBe(false);
    expect(result.scheduleDrift.complete).toBe(false);
  });

  it('reports promoted or retry-delayed future timing as non-comparable', () => {
    const generatedAt = new Date('2026-07-30T12:00:00.000Z');
    const rows = ['promoted', 'retry'].map((id) => ({
      id,
      chatId: 'chat-1',
      sourceId: 'source-1',
      status: 'NEW',
      publishReason: 'autopublish',
      publishQueuedAt: new Date('2026-07-30T10:00:00.000Z'),
      publishScheduledAt: new Date('2026-07-30T13:00:00.000Z'),
      publishLockedAt: null,
      publishIdempotencyKey: `key-${id}`,
      requiredBotId: PUBLISHER_BOT_ID,
    }));
    const jobs = [
      {
        id: 'vk-parsing-publish__promoted__key-promoted',
        name: 'publish-vk-post',
        state: 'waiting',
        timestamp: generatedAt.getTime() - 60 * 60_000,
        delay: 0,
        attemptsMade: 0,
        attemptsStarted: 0,
        processedOn: null,
        finishedOn: null,
        data: {
          ...PUBLISHER_JOB_ROUTE,
          postId: 'promoted',
          chatId: 'chat-1',
          reason: 'autopublish',
          idempotencyKey: 'key-promoted',
        },
      },
      {
        id: 'vk-parsing-publish__retry__key-retry',
        name: 'publish-vk-post',
        state: 'delayed',
        timestamp: generatedAt.getTime() - 60 * 60_000,
        delay: 60_000,
        attemptsMade: 1,
        attemptsStarted: 1,
        processedOn: generatedAt.getTime() - 30_000,
        finishedOn: null,
        data: {
          ...PUBLISHER_JOB_ROUTE,
          postId: 'retry',
          chatId: 'chat-1',
          reason: 'autopublish',
          idempotencyKey: 'key-retry',
        },
      },
    ];
    const result = reconcilePublishQueueSnapshots({
      available: true,
      error: null,
      generatedAt,
      database: { totalRows: 2, rows, cap: 100, truncated: false, consistent: true },
      queueCap: 100,
      ...createStableQueueSnapshots({ waiting: 1, delayed: 1 }),
      scannedQueueJobs: jobs,
      queueJobsTruncated: false,
      ownedJobs: jobs.map((job) => ({ expectedJobId: job.id, job })),
      sampleLimit: 20,
    });

    expect(result.scheduleDrift).toMatchObject({
      count: 0,
      comparableJobs: 0,
      complete: false,
      nonComparableFutureJobs: 2,
    });
    expect(result.scheduleDrift.nonComparableFutureSamples).toEqual([
      {
        postId: 'promoted',
        expectedJobId: 'vk-parsing-publish__promoted__key-promoted',
        state: 'waiting',
        reason: 'non_canonical_timing',
      },
      {
        postId: 'retry',
        expectedJobId: 'vk-parsing-publish__retry__key-retry',
        state: 'delayed',
        reason: 'non_canonical_timing',
      },
    ]);
    expect(result.queue.maxOwnedJobScheduledAt).toBeNull();
  });

  it('requires zero active jobs and stable queue/database snapshots for repair-grade output', () => {
    const common = {
      available: true,
      error: null,
      generatedAt: new Date('2026-07-30T12:00:00.000Z'),
      queueCap: 100,
      scannedQueueJobs: [],
      queueJobsTruncated: false,
      ownedJobs: [],
      sampleLimit: 20,
    };
    const active = reconcilePublishQueueSnapshots({
      ...common,
      database: { totalRows: 0, rows: [], cap: 100, truncated: false, consistent: true },
      queueBefore: { paused: true, counts: { active: 1 } },
      queueAfter: { paused: true, counts: { active: 1 } },
    });
    const changed = reconcilePublishQueueSnapshots({
      ...common,
      database: { totalRows: 0, rows: [], cap: 100, truncated: false, consistent: true },
      queueBefore: { paused: true, counts: { delayed: 1 } },
      queueAfter: { paused: true, counts: { delayed: 2 } },
    });
    const inconsistentDatabase = reconcilePublishQueueSnapshots({
      ...common,
      database: { totalRows: 1, rows: [], cap: 100, truncated: false, consistent: false },
      ...createStableQueueSnapshots(),
    });

    expect(active.queue).toMatchObject({
      paused: true,
      activeJobs: 1,
      snapshotConsistent: true,
      liveSnapshot: true,
      repairGrade: false,
    });
    expect(active.missingJobs.complete).toBe(false);
    expect(changed.queue).toMatchObject({
      paused: true,
      activeJobs: 0,
      snapshotConsistent: false,
      liveSnapshot: true,
      repairGrade: false,
    });
    expect(changed.orphanJobs.complete).toBe(false);
    expect(inconsistentDatabase.database.consistent).toBe(false);
    expect(inconsistentDatabase.queue.repairGrade).toBe(false);
    expect(inconsistentDatabase.payloadMismatches.complete).toBe(false);
  });

  it('marks an unpaused live reconciliation as non-authoritative', () => {
    const result = reconcilePublishQueueSnapshots({
      available: true,
      error: null,
      generatedAt: new Date('2026-07-30T12:00:00.000Z'),
      database: { totalRows: 0, rows: [], cap: 100, truncated: false, consistent: true },
      queueCap: 100,
      ...createStableQueueSnapshots({}, false),
      scannedQueueJobs: [],
      queueJobsTruncated: false,
      ownedJobs: [],
      sampleLimit: 20,
    });

    expect(result.queue).toMatchObject({ paused: false, liveSnapshot: true });
    expect(result.missingJobs.complete).toBe(false);
    expect(result.orphanJobs.complete).toBe(false);
  });

  it('rejects permissive or oversized numeric CLI values', () => {
    expect(() => readCliOptions(['--limit', '20junk'], {} as NodeJS.ProcessEnv)).toThrow(
      '--limit must be a positive integer',
    );
    expect(() => readCliOptions(['--limit', '201'], {} as NodeJS.ProcessEnv)).toThrow(
      '--limit must be at most 200',
    );
    expect(() => readCliOptions(['--window-hours', '169'], {} as NodeJS.ProcessEnv)).toThrow(
      '--window-hours must be at most 168',
    );
  });

  it('rejects an unbounded reconciliation cap', () => {
    expect(() => readCliOptions(['--reconcile-cap', '20001'], {} as NodeJS.ProcessEnv)).toThrow(
      '--reconcile-cap must be at most 20000',
    );
  });
});
