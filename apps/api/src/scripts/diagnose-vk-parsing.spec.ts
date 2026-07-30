import {
  readCliOptions,
  reconcilePublishQueueSnapshots,
  renderTextDiagnostics,
} from './diagnose-vk-parsing';

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

describe('diagnose-vk-parsing script helpers', () => {
  it('parses CLI options with environment fallback', () => {
    expect(
      readCliOptions(['--json', '--limit', '5', '--window-hours', '12'], {
        REDIS_URL: 'redis://localhost:6379/0',
      } as NodeJS.ProcessEnv),
    ).toEqual({
      json: true,
      limit: 5,
      reconcileCap: 5_000,
      windowHours: 12,
      redisUrl: 'redis://localhost:6379/0',
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
        staleLockedPosts: 0,
        oldestDueQueuedAgeSec: 45,
      },
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
        publish: { name: 'vk-parsing-publish', counts: { waiting: 2 }, jobs: [] },
      },
    });

    expect(rendered).toContain('Sources: 59/59 healthy');
    expect(rendered).toContain('1 stale locks');
    expect(rendered).toContain('Publish backlog: 1 due / 2 queued');
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
          name: 'vk-parsing-publish',
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
    expect(result.payloadMismatches.samples[0]?.mismatchedFields).toEqual(['chatId', 'reason']);
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
