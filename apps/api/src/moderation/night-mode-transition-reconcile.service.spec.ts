import { NightModeTransitionReconcileService } from './night-mode-transition-reconcile.service';
import {
  NightModeTransitionSchedulerService,
  type NightModeTransitionReconcileFence,
} from './night-mode-transition-scheduler.service';

function extractSqlText(query: unknown): string {
  const strings = (query as { strings?: readonly string[] } | null)?.strings;
  return Array.isArray(strings) ? strings.join(' ') : String(query);
}

function extractSqlValues(query: unknown): readonly unknown[] {
  const values = (query as { values?: readonly unknown[] } | null)?.values;
  return Array.isArray(values) ? values : [];
}

describe('NightModeTransitionReconcileService', () => {
  const originalAppRole = process.env.APP_ROLE;
  const originalAppServiceName = process.env.APP_SERVICE_NAME;

  beforeEach(() => {
    process.env.APP_ROLE = 'enqueue';
    delete process.env.APP_SERVICE_NAME;
  });

  afterEach(() => {
    if (originalAppRole === undefined) {
      delete process.env.APP_ROLE;
    } else {
      process.env.APP_ROLE = originalAppRole;
    }
    if (originalAppServiceName === undefined) {
      delete process.env.APP_SERVICE_NAME;
    } else {
      process.env.APP_SERVICE_NAME = originalAppServiceName;
    }
    jest.clearAllMocks();
  });

  function createService(params?: {
    requests?: Array<{ chat_id: string; generation: bigint }>;
    repair?: jest.Mock;
    queryRaw?: jest.Mock;
    executeRaw?: jest.Mock;
    redisCounter?: {
      acquireLock: jest.Mock;
      renewLock: jest.Mock;
      releaseLock: jest.Mock;
    };
  }) {
    const requests = params?.requests ?? [];
    const prisma = {
      $queryRaw:
        params?.queryRaw ??
        jest.fn(async (query: unknown) => {
          const statement = extractSqlText(query);
          if (statement.includes('WITH candidates AS')) {
            return requests;
          }
          return [{ chat_id: String(extractSqlValues(query)[1] ?? '') }];
        }),
      $executeRaw: params?.executeRaw ?? jest.fn().mockResolvedValue(1),
    };
    const scheduler = {
      repairAccessSchedule:
        params?.repair ??
        jest.fn().mockResolvedValue({
          queueAvailable: true,
          scheduleEnabled: true,
          passes: 1,
        }),
    };
    const service = new NightModeTransitionReconcileService(
      prisma as never,
      scheduler as never,
      params?.redisCounter as never,
    );
    return { prisma, scheduler, service };
  }

  it('owns the reconcile loop only on the dedicated background moderation service', () => {
    process.env.APP_ROLE = 'moderation';
    process.env.APP_SERVICE_NAME = 'api-moderation-background';
    const background = createService().service;
    expect(
      (background as unknown as { runsInBackgroundModerationService: boolean })
        .runsInBackgroundModerationService,
    ).toBe(true);

    process.env.APP_ROLE = 'enqueue';
    process.env.APP_SERVICE_NAME = 'api-enqueue';
    const enqueue = createService().service;
    expect(
      (enqueue as unknown as { runsInBackgroundModerationService: boolean })
        .runsInBackgroundModerationService,
    ).toBe(false);
  });

  it('skips duplicate reconcile providers while another instance owns the leader lock', async () => {
    process.env.APP_ROLE = 'moderation';
    process.env.APP_SERVICE_NAME = 'api-moderation-background';
    const redisCounter = {
      acquireLock: jest.fn().mockResolvedValue(null),
      renewLock: jest.fn(),
      releaseLock: jest.fn(),
    };
    const { prisma, service } = createService({ redisCounter });

    await (service as unknown as { tick: () => Promise<void> }).tick();

    expect(redisCounter.acquireLock).toHaveBeenCalledWith(
      'night-mode:transition-reconcile:leader:v1',
      120_000,
    );
    expect(redisCounter.renewLock).not.toHaveBeenCalled();
    expect(redisCounter.releaseLock).not.toHaveBeenCalled();
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  function buildLegacyRecoveryRow(
    chatId: string,
    id: string,
    completedAt = new Date('2026-05-30T20:00:01.000Z'),
  ) {
    const sessionKey = 'v1:Europe/Moscow:23:00:08:00:2026-05-30';
    return {
      id,
      jobId: `night-mode:close:${chatId}:session:${sessionKey}`,
      chatId,
      completedAt,
      remoteMessageId: `close-${id}`,
      dispatchBotId: 'bot-1',
      eventExists: false,
    };
  }

  it('uses an exact bounded SQL anti-join and stops after existing events exhaust discovery', async () => {
    const queryRaw = jest
      .fn()
      .mockResolvedValue([
        { ...buildLegacyRecoveryRow('chat-event-exists', 'event-exists'), eventExists: true },
      ]);
    const { service } = createService({ queryRaw });
    const discover = () =>
      (
        service as unknown as {
          discoverLegacyCloseRecoveriesPage(): Promise<number>;
        }
      ).discoverLegacyCloseRecoveriesPage();

    await expect(discover()).resolves.toBe(0);
    await expect(discover()).resolves.toBe(0);

    expect(queryRaw).toHaveBeenCalledTimes(1);
    const statement = extractSqlText(queryRaw.mock.calls[0]?.[0]);
    expect(statement).toContain('WITH ledger_page AS MATERIALIZED');
    expect(statement).toContain('FROM "max_action_ledger" ledger');
    expect(statement).toContain('ledger."terminal" = true');
    expect(statement).toContain('ledger."completed_at" IS NOT NULL');
    expect(statement).toContain('ledger."status" = \'SUCCEEDED\'');
    expect(statement).toContain('ledger."ambiguous" = false');
    expect(statement).toContain('ledger."action_type" = \'SEND_MESSAGE\'');
    expect(statement).toContain('ledger."source_tag" = \'night_mode_transition\'');
    expect(statement).toContain('ledger."job_id" LIKE \'night-mode:close:%\'');
    expect(statement).toContain('EXISTS');
    expect(statement).toContain('event."rule_code" = \'NIGHT_MODE_CLOSE_NOTICE\'');
    expect(statement).toContain('event."metadata" ->> \'sessionKey\'');
    expect(statement).toContain('ORDER BY ledger."completed_at" DESC, ledger."id" DESC');
    expect(statement).toContain('LIMIT');
  });

  it('retries the same legacy discovery page when durable request persistence fails', async () => {
    const row = buildLegacyRecoveryRow('chat-retry-page', 'ledger-retry-page');
    let scanCalls = 0;
    let persistCalls = 0;
    const queryRaw = jest.fn(async (query: unknown) => {
      const statement = extractSqlText(query);
      if (statement.includes('FROM "max_action_ledger" ledger')) {
        scanCalls += 1;
        return [row];
      }
      return [];
    });
    const executeRaw = jest.fn(async () => {
      persistCalls += 1;
      if (persistCalls === 1) {
        throw new Error('request persistence unavailable');
      }
      return 1;
    });
    const { service } = createService({ queryRaw, executeRaw });
    const discover = () =>
      (
        service as unknown as {
          discoverLegacyCloseRecoveriesPage(): Promise<number>;
        }
      ).discoverLegacyCloseRecoveriesPage();

    await expect(discover()).rejects.toThrow('request persistence unavailable');
    expect(
      (service as unknown as { legacyRecoveryCursor: unknown }).legacyRecoveryCursor,
    ).toBeNull();
    await expect(discover()).resolves.toBe(1);
    await expect(discover()).resolves.toBe(0);

    expect(scanCalls).toBe(2);
    expect(persistCalls).toBe(2);
  });

  it('advances through more than one bounded page with durable generation dedupe predicates', async () => {
    const pageOne = Array.from({ length: 100 }, (_, index) =>
      buildLegacyRecoveryRow(
        'chat-page-a',
        `ledger-page-a-${String(index).padStart(3, '0')}`,
        new Date(1_800_000_000_000 - index),
      ),
    );
    const pageTwo = [
      buildLegacyRecoveryRow('chat-page-a', 'ledger-page-a-older', new Date(1_799_999_000_000)),
      buildLegacyRecoveryRow('chat-page-b', 'ledger-page-b', new Date(1_799_998_000_000)),
    ];
    let scanCalls = 0;
    const queryRaw = jest.fn(async (query: unknown) => {
      const statement = extractSqlText(query);
      if (statement.includes('FROM "max_action_ledger" ledger')) {
        scanCalls += 1;
        return scanCalls === 1 ? pageOne : pageTwo;
      }
      return [];
    });
    const { prisma, service } = createService({ queryRaw });
    const discover = () =>
      (
        service as unknown as {
          discoverLegacyCloseRecoveriesPage(): Promise<number>;
        }
      ).discoverLegacyCloseRecoveriesPage();

    await expect(discover()).resolves.toBe(1);
    await expect(discover()).resolves.toBe(0);
    expect(
      (service as unknown as { legacyRecoveryDiscoveryNextAttemptAt: number })
        .legacyRecoveryDiscoveryNextAttemptAt,
    ).toBeGreaterThan(Date.now());
    (
      service as unknown as { legacyRecoveryDiscoveryNextAttemptAt: number }
    ).legacyRecoveryDiscoveryNextAttemptAt = Date.now();
    await expect(discover()).resolves.toBe(2);
    await expect(discover()).resolves.toBe(0);

    const scanQueries = queryRaw.mock.calls
      .map((call) => call[0])
      .filter((query) => extractSqlText(query).includes('FROM "max_action_ledger" ledger'));
    const requestQueries = prisma.$executeRaw.mock.calls
      .map((call) => call[0])
      .filter((query) =>
        extractSqlText(query).includes('enqueue_night_mode_transition_reconcile_request'),
      );
    expect(scanQueries).toHaveLength(2);
    expect(extractSqlText(scanQueries[1])).toContain('(ledger."completed_at", ledger."id") <');
    expect(requestQueries).toHaveLength(2);
    const firstRequestStatement = extractSqlText(requestQueries[0]);
    expect(firstRequestStatement).toContain('WITH recovery_candidates');
    expect(firstRequestStatement).toContain('request."manual_blocked_at" IS NULL');
    expect(firstRequestStatement).toContain(
      'request."generation" > request."manual_blocked_generation"',
    );
    expect(firstRequestStatement).toContain(
      'request."manual_blocked_session_key" = candidate."session_key"',
    );
    expect(firstRequestStatement).toContain(
      'request."manual_blocked_ledger_job_id" = candidate."ledger_job_id"',
    );
    expect(firstRequestStatement).toContain('registry."session_key" = candidate."session_key"');
    expect(firstRequestStatement).toContain('POSITION(\'__recovery__\' IN registry."job_id") > 0');
    expect(extractSqlValues(requestQueries[0])).toEqual([
      'chat-page-a',
      'v1:Europe/Moscow:23:00:08:00:2026-05-30',
      'night-mode:close:chat-page-a:session:v1:Europe/Moscow:23:00:08:00:2026-05-30',
    ]);
    expect(extractSqlValues(requestQueries[1])).toEqual([
      'chat-page-a',
      'v1:Europe/Moscow:23:00:08:00:2026-05-30',
      'night-mode:close:chat-page-a:session:v1:Europe/Moscow:23:00:08:00:2026-05-30',
      'chat-page-b',
      'v1:Europe/Moscow:23:00:08:00:2026-05-30',
      'night-mode:close:chat-page-b:session:v1:Europe/Moscow:23:00:08:00:2026-05-30',
    ]);
  });

  it('finds a concurrently completed row in the incremental head pass', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-31T06:00:00.000Z'));
    try {
      const initialPage = Array.from({ length: 100 }, (_, index) =>
        buildLegacyRecoveryRow(
          'chat-initial-head',
          `initial-${String(index).padStart(3, '0')}`,
          new Date('2026-05-31T05:00:00.000Z'),
        ),
      );
      const concurrentRow = buildLegacyRecoveryRow(
        'chat-concurrent-head',
        'concurrent-newer',
        new Date('2026-05-31T04:59:00.000Z'),
      );
      let scanCalls = 0;
      const queryRaw = jest.fn(async (query: unknown) => {
        if (!extractSqlText(query).includes('FROM "max_action_ledger" ledger')) {
          return [];
        }
        scanCalls += 1;
        if (scanCalls === 1) {
          return initialPage;
        }
        if (scanCalls === 2) {
          return [];
        }
        return [concurrentRow];
      });
      const { service } = createService({ queryRaw });
      const discover = () =>
        (
          service as unknown as {
            discoverLegacyCloseRecoveriesPage(): Promise<number>;
          }
        ).discoverLegacyCloseRecoveriesPage();

      await expect(discover()).resolves.toBe(1);
      await expect(discover()).resolves.toBe(0);
      jest.advanceTimersByTime(1_000);
      await expect(discover()).resolves.toBe(0);
      jest.advanceTimersByTime(60_001);
      await expect(discover()).resolves.toBe(1);

      const scanQueries = queryRaw.mock.calls
        .map((call) => call[0])
        .filter((query) => extractSqlText(query).includes('FROM "max_action_ledger" ledger'));
      expect(scanQueries).toHaveLength(3);
      expect(extractSqlText(scanQueries[2])).toContain('(ledger."completed_at", ledger."id") >');
      expect(extractSqlText(scanQueries[2])).toContain(
        'ORDER BY ledger."completed_at" ASC, ledger."id" ASC',
      );
      expect(extractSqlValues(scanQueries[2])).toEqual(
        expect.arrayContaining([new Date('2026-05-31T04:55:00.000Z'), '']),
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('claims due future generations while excluding the exact settled tombstone registry row', async () => {
    const { prisma, service } = createService();

    await expect(
      (
        service as unknown as {
          reconcileBatch: () => Promise<number>;
        }
      ).reconcileBatch(),
    ).resolves.toBe(0);

    const statement = extractSqlText(prisma.$queryRaw.mock.calls[0]?.[0]);
    expect(statement).toContain('request."generation" > request."manual_blocked_generation"');
    expect(statement).toContain('registry."updated_at" <=');
    expect(statement).toContain('registry."job_id" = existing."manual_blocked_job_id"');
    expect(statement).toContain(
      'registry."schedule_fingerprint" = existing."manual_blocked_fingerprint"',
    );
    expect(statement).toContain('existing."generation" = existing."manual_blocked_generation"');
    expect(statement).toContain('FOR UPDATE SKIP LOCKED');
    expect(statement).toContain('request."generation" = candidates."generation"');
    expect(statement).toContain('"lease_expires_at"');
    expect(statement).toContain('"attempt_count" = request."attempt_count" + 1');
    expect(statement).toContain('"last_attempt_at" =');
  });

  it('renews an expired lease while its exact generation and token are still owned', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-31T06:00:00.000Z'));
    try {
      const request = { chat_id: 'chat-lost-lease', generation: 3n };
      let leaseToken: string | null = null;
      let leaseExpiresAt: Date | null = null;
      const queryRaw = jest.fn(async (query: unknown) => {
        const statement = extractSqlText(query);
        const values = extractSqlValues(query);
        if (statement.includes('WITH candidates AS')) {
          leaseToken = values[3] as string;
          leaseExpiresAt = values[4] as Date;
          jest.setSystemTime(new Date(leaseExpiresAt.getTime() + 1));
          return [request];
        }

        const exactOwner =
          values[1] === request.chat_id &&
          values[2] === request.generation &&
          values[3] === leaseToken;
        if (exactOwner) {
          leaseExpiresAt = values[0] as Date;
          return [{ chat_id: request.chat_id }];
        }
        return [];
      });
      const { prisma, scheduler, service } = createService({ requests: [request], queryRaw });

      await expect(
        (
          service as unknown as {
            reconcileBatch: () => Promise<number>;
          }
        ).reconcileBatch(),
      ).resolves.toBe(1);

      const ownershipStatement = extractSqlText(prisma.$queryRaw.mock.calls[1]?.[0]);
      expect(ownershipStatement).toContain('UPDATE "night_mode_transition_reconcile_requests"');
      expect(ownershipStatement).toContain('"generation" =');
      expect(ownershipStatement).toContain('"lease_token" =');
      expect(ownershipStatement).not.toContain('"lease_expires_at" > CURRENT_TIMESTAMP');
      expect(ownershipStatement).toContain('RETURNING "chat_id"');
      expect(scheduler.repairAccessSchedule).toHaveBeenCalledTimes(1);
      expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not renew an expired lease after another claim replaces its token', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-31T06:00:00.000Z'));
    try {
      const request = { chat_id: 'chat-reclaimed-lease', generation: 8n };
      let currentToken: string | null = null;
      const queryRaw = jest.fn(async (query: unknown) => {
        const statement = extractSqlText(query);
        const values = extractSqlValues(query);
        if (statement.includes('WITH candidates AS')) {
          currentToken = 'replacement-owner-token';
          const leaseExpiresAt = values[4] as Date;
          jest.setSystemTime(new Date(leaseExpiresAt.getTime() + 1));
          return [request];
        }
        return values[3] === currentToken ? [{ chat_id: request.chat_id }] : [];
      });
      const { prisma, scheduler, service } = createService({ requests: [request], queryRaw });

      await expect(
        (
          service as unknown as {
            reconcileBatch: () => Promise<number>;
          }
        ).reconcileBatch(),
      ).resolves.toBe(1);

      const ownershipStatement = extractSqlText(prisma.$queryRaw.mock.calls[1]?.[0]);
      expect(ownershipStatement).toContain('"generation" =');
      expect(ownershipStatement).toContain('"lease_token" =');
      expect(ownershipStatement).not.toContain('"lease_expires_at" > CURRENT_TIMESTAMP');
      expect(scheduler.repairAccessSchedule).not.toHaveBeenCalled();
      expect(prisma.$executeRaw).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not complete or requeue when ownership is lost after scheduler mutation', async () => {
    const request = { chat_id: 'chat-lost-after-repair', generation: 4n };
    const queryRaw = jest
      .fn()
      .mockResolvedValueOnce([request])
      .mockResolvedValueOnce([{ chat_id: request.chat_id }])
      .mockResolvedValueOnce([]);
    const { prisma, scheduler, service } = createService({ requests: [request], queryRaw });

    await expect(
      (
        service as unknown as {
          reconcileBatch: () => Promise<number>;
        }
      ).reconcileBatch(),
    ).resolves.toBe(1);

    expect(scheduler.repairAccessSchedule).toHaveBeenCalledTimes(1);
    expect(scheduler.repairAccessSchedule).toHaveBeenCalledWith(request.chat_id, {
      generation: request.generation,
      leaseToken: expect.any(String),
    });
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });

  it('heartbeats an expired batch lease only by its exact generation and token', async () => {
    const queryRaw = jest
      .fn()
      .mockResolvedValue([{ chat_id: 'chat-heartbeat-expired', generation: 9n }]);
    const { service } = createService({ queryRaw });

    await (
      service as unknown as {
        renewBatchLeases(
          requests: Array<{ chat_id: string; generation: bigint }>,
          leaseToken: string,
        ): Promise<void>;
      }
    ).renewBatchLeases(
      [{ chat_id: 'chat-heartbeat-expired', generation: 9n }],
      'lease-heartbeat-expired',
    );

    const statement = extractSqlText(queryRaw.mock.calls[0]?.[0]);
    expect(statement).toContain('request."generation" = expected."generation"');
    expect(statement).toContain('request."lease_token" =');
    expect(statement).not.toContain('request."lease_expires_at" > CURRENT_TIMESTAMP');
    expect(extractSqlValues(queryRaw.mock.calls[0]?.[0])).toEqual([
      'chat-heartbeat-expired',
      9n,
      expect.any(Date),
      'lease-heartbeat-expired',
    ]);
  });

  it('settles a preserved tombstone at the exact repaired generation instead of deleting it', async () => {
    const { prisma, service } = createService();

    await (
      service as unknown as {
        completeRequest(
          request: { chat_id: string; generation: bigint },
          leaseToken: string,
        ): Promise<void>;
      }
    ).completeRequest({ chat_id: 'chat-tombstone', generation: 12n }, 'lease-12');

    const statement = extractSqlText(prisma.$executeRaw.mock.calls[0]?.[0]);
    expect(statement).toContain('WITH preserved_manual AS');
    expect(statement).toContain('"manual_blocked_generation" = "generation"');
    expect(statement).toContain('"last_error_code" = NULL');
    expect(statement).toContain('AND "manual_blocked_at" IS NOT NULL');
    expect(statement).toContain('AND "manual_blocked_at" IS NULL');
    expect(statement).toContain('AND "lease_token" =');
  });

  it('replaces an older tombstone identity when a different future occurrence becomes unsafe', async () => {
    const { prisma, service } = createService();
    const review = {
      category: 'unsafe_prior_provenance' as const,
      reason: 'new future occurrence is unsafe',
      jobId: 'future-job-2',
      ledgerJobId: 'future-ledger-2',
      sessionKey: 'future-session-2',
      fingerprint: `sha256:${'b'.repeat(64)}`,
    };

    await (
      service as unknown as {
        markManualReview(
          request: { chat_id: string; generation: bigint },
          leaseToken: string,
          manualReview: typeof review,
        ): Promise<void>;
      }
    ).markManualReview({ chat_id: 'chat-tombstone', generation: 13n }, 'lease-13', review);

    const statement = extractSqlText(prisma.$executeRaw.mock.calls[0]?.[0]);
    const values = extractSqlValues(prisma.$executeRaw.mock.calls[0]?.[0]);
    expect(statement).toContain('WITH incoming AS');
    expect(statement).toContain('request."manual_blocked_job_id" = incoming."job_id"');
    expect(statement).toContain('"manual_blocked_job_id" = incoming."job_id"');
    expect(statement).toMatch(
      /"manual_acknowledged_at" = CASE\s+WHEN request\."manual_blocked_job_id" = incoming\."job_id"[\s\S]+THEN request\."manual_acknowledged_at"\s+ELSE NULL\s+END/u,
    );
    expect(statement).toContain('"manual_blocked_generation" =');
    expect(values).toEqual(
      expect.arrayContaining([
        review.category,
        review.jobId,
        review.sessionKey,
        review.fingerprint,
      ]),
    );
  });

  it('preserves an external crashed registry intent after the fenced repair unlocks', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-31T06:00:00.000Z'));
    try {
      const chatId = 'chat-registry-interleave';
      const request = { chat_id: chatId, generation: 5n };
      const durableRow = {
        generation: request.generation,
        leaseToken: null as string | null,
        leaseExpiresAt: null as Date | null,
        deleted: false,
      };
      let releaseFinalOwnershipCheck: () => void = () => undefined;
      const finalOwnershipCheckGate = new Promise<void>((resolve) => {
        releaseFinalOwnershipCheck = resolve;
      });
      let markFinalOwnershipCheckStarted: () => void = () => undefined;
      const finalOwnershipCheckStarted = new Promise<void>((resolve) => {
        markFinalOwnershipCheckStarted = resolve;
      });
      let ownershipChecks = 0;
      const reconcilePrisma = {
        $queryRaw: jest.fn(async (query: unknown) => {
          const statement = extractSqlText(query);
          const values = extractSqlValues(query);
          if (statement.includes('WITH candidates AS')) {
            durableRow.leaseToken = values[3] as string;
            durableRow.leaseExpiresAt = values[4] as Date;
            return [request];
          }

          ownershipChecks += 1;
          if (ownershipChecks === 2) {
            markFinalOwnershipCheckStarted();
            await finalOwnershipCheckGate;
          }
          const leaseExpiresAt = values[0] as Date;
          const exactLiveOwner =
            values[1] === chatId &&
            values[2] === durableRow.generation &&
            values[3] === durableRow.leaseToken &&
            durableRow.leaseExpiresAt !== null &&
            durableRow.leaseExpiresAt.getTime() > Date.now();
          if (!exactLiveOwner) {
            return [];
          }
          durableRow.leaseExpiresAt = leaseExpiresAt;
          return [{ chat_id: chatId }];
        }),
        $executeRaw: jest.fn().mockResolvedValue(0),
      };
      const registryStatements: string[] = [];
      const registryPrisma = {
        $executeRaw: jest.fn(async (query: unknown) => {
          const statement = extractSqlText(query);
          const values = extractSqlValues(query);
          registryStatements.push(statement);
          const ownerGeneration = values[0] as bigint | null;
          const ownerLeaseToken = values[1] as string | null;
          const exactLiveOwner =
            ownerGeneration === durableRow.generation &&
            ownerLeaseToken === durableRow.leaseToken &&
            durableRow.leaseExpiresAt !== null &&
            durableRow.leaseExpiresAt.getTime() > Date.now();
          if (!exactLiveOwner) {
            durableRow.generation += 1n;
            durableRow.leaseToken = null;
            durableRow.leaseExpiresAt = null;
          }
          return 1;
        }),
      };
      const queueError = new Error('queue add crashed after registry intent');
      const queue = { add: jest.fn().mockRejectedValue(queueError) };
      const registryScheduler = new NightModeTransitionSchedulerService(
        registryPrisma as never,
        queue as never,
      );
      const registryWriter = registryScheduler as unknown as {
        upsertScheduledJobRegistryIntent(
          row: {
            chat_id: string;
            job_id: string;
            transition: 'open' | 'close';
            session_key: string;
            scheduled_for: Date;
            schedule_fingerprint: string;
          },
          reconcileFence?: NightModeTransitionReconcileFence,
        ): Promise<void>;
        enqueueChatSettingsOccurrences(
          targetChatId: string,
          settings: {
            nightModeEnabled: boolean;
            nightModeStartTimeMinutes: number;
            nightModeEndTimeMinutes: number;
            nightModeTimezone: string;
          },
        ): Promise<unknown>;
      };
      const buildRegistryRow = (jobId: string) => ({
        chat_id: chatId,
        job_id: jobId,
        transition: 'close' as const,
        session_key: 'v1:Europe/Moscow:23:00:08:00:2026-05-31',
        scheduled_for: new Date('2026-05-31T20:00:00.000Z'),
        schedule_fingerprint: `sha256:${'a'.repeat(64)}`,
      });
      const repair = jest.fn(
        async (_targetChatId: string, reconcileFence: NightModeTransitionReconcileFence) => {
          await registryWriter.upsertScheduledJobRegistryIntent(
            buildRegistryRow('owner-job-1'),
            reconcileFence,
          );
          await registryWriter.upsertScheduledJobRegistryIntent(
            buildRegistryRow('owner-job-2'),
            reconcileFence,
          );
          return { queueAvailable: true, scheduleEnabled: true, passes: 1 };
        },
      );
      const reconcileService = new NightModeTransitionReconcileService(
        reconcilePrisma as never,
        { repairAccessSchedule: repair } as never,
      );

      const batch = (
        reconcileService as unknown as { reconcileBatch: () => Promise<number> }
      ).reconcileBatch();
      await finalOwnershipCheckStarted;

      expect(registryPrisma.$executeRaw).toHaveBeenCalledTimes(2);
      expect(durableRow.generation).toBe(request.generation);
      expect(durableRow.leaseToken).not.toBeNull();
      await expect(
        registryWriter.enqueueChatSettingsOccurrences(chatId, {
          nightModeEnabled: true,
          nightModeStartTimeMinutes: 23 * 60,
          nightModeEndTimeMinutes: 8 * 60,
          nightModeTimezone: 'Europe/Moscow',
        }),
      ).rejects.toBe(queueError);

      expect(queue.add).toHaveBeenCalledTimes(1);
      expect(durableRow.generation).toBe(6n);
      expect(durableRow.leaseToken).toBeNull();
      expect(extractSqlValues(registryPrisma.$executeRaw.mock.calls[2]?.[0]).slice(0, 2)).toEqual([
        null,
        null,
      ]);
      releaseFinalOwnershipCheck();
      await expect(batch).resolves.toBe(1);

      expect(repair).toHaveBeenCalledWith(chatId, {
        generation: request.generation,
        leaseToken: expect.any(String),
      });
      expect(reconcilePrisma.$executeRaw).not.toHaveBeenCalled();
      expect(durableRow.deleted).toBe(false);
      expect(durableRow.generation).toBe(6n);
      expect(registryStatements[0]).toContain('WHERE NOT EXISTS');
    } finally {
      jest.useRealTimers();
    }
  });

  it('heartbeats a bounded batch so a second instance cannot churn its waiting tail', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-31T06:00:00.000Z'));
    try {
      type FakeRequestRow = {
        chat_id: string;
        generation: bigint;
        requestedAt: Date;
        leaseToken: string | null;
        leaseExpiresAt: Date | null;
        deleted: boolean;
      };
      const rows: FakeRequestRow[] = Array.from({ length: 4 }, (_, index) => ({
        chat_id: `chat-tail-${index + 1}`,
        generation: BigInt(index + 1),
        requestedAt: new Date(),
        leaseToken: null,
        leaseExpiresAt: null,
        deleted: false,
      }));
      const createPrisma = () => ({
        $queryRaw: jest.fn(async (query: unknown) => {
          const statement = extractSqlText(query);
          const values = extractSqlValues(query);
          if (statement.includes('WITH candidates AS')) {
            const now = values[0] as Date;
            const leaseToken = values[3] as string;
            const leaseExpiresAt = values[4] as Date;
            const candidates = rows.filter(
              (row) =>
                !row.deleted &&
                row.requestedAt <= now &&
                (row.leaseExpiresAt === null || row.leaseExpiresAt < now),
            );
            for (const row of candidates) {
              row.leaseToken = leaseToken;
              row.leaseExpiresAt = leaseExpiresAt;
            }
            return candidates.map(({ chat_id, generation }) => ({ chat_id, generation }));
          }
          if (statement.includes('WITH expected("chat_id", "generation") AS')) {
            const leaseExpiresAt = values[values.length - 2] as Date;
            const leaseToken = values[values.length - 1] as string;
            const renewed: Array<{ chat_id: string; generation: bigint }> = [];
            for (let index = 0; index < values.length - 2; index += 2) {
              const chatId = values[index] as string;
              const generation = values[index + 1] as bigint;
              const row = rows.find(
                (candidate) =>
                  !candidate.deleted &&
                  candidate.chat_id === chatId &&
                  candidate.generation === generation &&
                  candidate.leaseToken === leaseToken,
              );
              if (row) {
                row.leaseExpiresAt = leaseExpiresAt;
                renewed.push({ chat_id: row.chat_id, generation: row.generation });
              }
            }
            return renewed;
          }

          const leaseExpiresAt = values[0] as Date;
          const chatId = values[1] as string;
          const generation = values[2] as bigint;
          const leaseToken = values[3] as string;
          const row = rows.find(
            (candidate) =>
              !candidate.deleted &&
              candidate.chat_id === chatId &&
              candidate.generation === generation &&
              candidate.leaseToken === leaseToken,
          );
          if (!row) {
            return [];
          }
          row.leaseExpiresAt = leaseExpiresAt;
          return [{ chat_id: row.chat_id }];
        }),
        $executeRaw: jest.fn(async (query: unknown) => {
          const statement = extractSqlText(query);
          const values = extractSqlValues(query);
          if (!statement.includes('DELETE FROM "night_mode_transition_reconcile_requests"')) {
            throw new Error(`Unexpected fake SQL mutation: ${statement}`);
          }
          const chatId = values[0] as string;
          const generation = values[1] as bigint;
          const leaseToken = values[2] as string;
          const row = rows.find(
            (candidate) =>
              !candidate.deleted &&
              candidate.chat_id === chatId &&
              candidate.generation === generation &&
              candidate.leaseToken === leaseToken,
          );
          if (row) {
            row.deleted = true;
          }
          return row ? 1 : 0;
        }),
      });

      let releaseFirstWave: () => void = () => undefined;
      const firstWaveGate = new Promise<void>((resolve) => {
        releaseFirstWave = resolve;
      });
      let markFirstWaveStarted: () => void = () => undefined;
      const firstWaveStarted = new Promise<void>((resolve) => {
        markFirstWaveStarted = resolve;
      });
      let firstStartedCount = 0;
      let activeRepairCount = 0;
      let maxActiveRepairCount = 0;
      const firstScheduler = {
        repairAccessSchedule: jest.fn(async () => {
          firstStartedCount += 1;
          activeRepairCount += 1;
          maxActiveRepairCount = Math.max(maxActiveRepairCount, activeRepairCount);
          if (firstStartedCount === 1) {
            markFirstWaveStarted();
          }
          try {
            await firstWaveGate;
            return { queueAvailable: true, scheduleEnabled: true, passes: 1 };
          } finally {
            activeRepairCount -= 1;
          }
        }),
      };
      const secondScheduler = {
        repairAccessSchedule: jest.fn().mockResolvedValue({
          queueAvailable: true,
          scheduleEnabled: true,
          passes: 1,
        }),
      };
      const firstPrisma = createPrisma();
      const secondPrisma = createPrisma();
      const firstService = new NightModeTransitionReconcileService(
        firstPrisma as never,
        firstScheduler as never,
      );
      const secondService = new NightModeTransitionReconcileService(
        secondPrisma as never,
        secondScheduler as never,
      );

      const firstBatch = (
        firstService as unknown as { reconcileBatch: () => Promise<number> }
      ).reconcileBatch();
      await firstWaveStarted;
      await jest.advanceTimersByTimeAsync(31_000);

      const heartbeatStatements = firstPrisma.$queryRaw.mock.calls
        .map(([query]) => extractSqlText(query))
        .filter((statement) => statement.includes('WITH expected("chat_id", "generation") AS'));
      expect(heartbeatStatements).toHaveLength(3);
      expect(heartbeatStatements[0]).toContain('::TEXT');
      expect(heartbeatStatements[0]).toContain('::BIGINT');
      expect(heartbeatStatements[0]).toContain('request."generation" = expected."generation"');
      expect(heartbeatStatements[0]).toContain('request."lease_token" =');
      expect(heartbeatStatements[0]).not.toContain(
        'request."lease_expires_at" > CURRENT_TIMESTAMP',
      );
      const claimValues = extractSqlValues(firstPrisma.$queryRaw.mock.calls[0]?.[0]);
      expect(claimValues.filter((value) => value === 4)).toHaveLength(2);

      await expect(
        (secondService as unknown as { reconcileBatch: () => Promise<number> }).reconcileBatch(),
      ).resolves.toBe(0);
      expect(secondScheduler.repairAccessSchedule).not.toHaveBeenCalled();

      releaseFirstWave();
      await expect(firstBatch).resolves.toBe(4);

      expect(firstScheduler.repairAccessSchedule).toHaveBeenCalledTimes(4);
      expect(maxActiveRepairCount).toBe(1);
      expect(firstScheduler.repairAccessSchedule).toHaveBeenCalledWith('chat-tail-4', {
        generation: 4n,
        leaseToken: expect.any(String),
      });
      expect(
        firstPrisma.$executeRaw.mock.calls.some(([query]) =>
          extractSqlText(query).includes('"requested_at" ='),
        ),
      ).toBe(false);
      expect(rows.every((row) => row.deleted)).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  it('continues through the claimed batch after an unexpected settlement failure', async () => {
    const requests = Array.from({ length: 4 }, (_, index) => ({
      chat_id: `chat-settle-${index + 1}`,
      generation: BigInt(index + 1),
    }));
    const settlementError = new Error('settlement connection unavailable');
    const executeRaw = jest.fn(async (query: unknown) => {
      const values = extractSqlValues(query);
      if (values[0] === requests[0]!.chat_id) {
        throw settlementError;
      }
      return 1;
    });
    const { scheduler, service } = createService({ requests, executeRaw });

    await expect(
      (
        service as unknown as {
          reconcileBatch: () => Promise<number>;
        }
      ).reconcileBatch(),
    ).rejects.toBe(settlementError);

    expect(scheduler.repairAccessSchedule).toHaveBeenCalledTimes(requests.length);
    expect(executeRaw).toHaveBeenCalledTimes(requests.length);
    expect(executeRaw.mock.calls.map(([query]) => extractSqlValues(query)[0])).toEqual(
      requests.map((request) => request.chat_id),
    );
  });

  it('continues beyond the former lock batch when one chat needs a durable retry', async () => {
    const requests = Array.from({ length: 12 }, (_, index) => ({
      chat_id: `chat-${index + 1}`,
      generation: BigInt(index + 1),
    }));
    const repair = jest.fn(async (chatId: string) => {
      if (chatId === 'chat-3') {
        throw new Error('night mode queue mutation lock is busy');
      }
      return {
        queueAvailable: true,
        scheduleEnabled: true,
        passes: 1,
      };
    });
    const { prisma, scheduler, service } = createService({ requests, repair });

    await expect(
      (
        service as unknown as {
          reconcileBatch: () => Promise<number>;
        }
      ).reconcileBatch(),
    ).resolves.toBe(12);

    expect(scheduler.repairAccessSchedule).toHaveBeenCalledTimes(12);
    const statements = prisma.$executeRaw.mock.calls.map(([query]) => extractSqlText(query));
    expect(statements.filter((statement) => statement.includes('DELETE FROM'))).toHaveLength(11);
    expect(
      statements.filter(
        (statement) =>
          statement.includes('"requested_at" =') && statement.includes('"lease_token" = NULL'),
      ),
    ).toHaveLength(1);
  });

  it('retains an unsafe catch-up as manual diagnostic without retrying it', async () => {
    const reason =
      'Night mode catch-up is blocked by an unsafe prior failure (night-mode-transition-job-1)';
    const { prisma, scheduler, service } = createService({
      requests: [{ chat_id: 'chat-manual', generation: 7n }],
      repair: jest.fn().mockResolvedValue({
        queueAvailable: true,
        scheduleEnabled: true,
        passes: 1,
        manualReview: {
          category: 'unsafe_prior_dispatch',
          reason,
          jobId: 'night-mode-transition-job-1',
          ledgerJobId: null,
          sessionKey: 'session-1',
          fingerprint: `sha256:${'a'.repeat(64)}`,
        },
      }),
    });

    await expect(
      (
        service as unknown as {
          reconcileBatch: () => Promise<number>;
        }
      ).reconcileBatch(),
    ).resolves.toBe(1);

    expect(scheduler.repairAccessSchedule).toHaveBeenCalledWith('chat-manual', {
      generation: 7n,
      leaseToken: expect.any(String),
    });
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    const statement = extractSqlText(prisma.$executeRaw.mock.calls[0]?.[0]);
    expect(statement).toContain('"manual_blocked_at" =');
    expect(statement).toContain('"manual_blocked_reason" =');
    expect(statement).toContain('"manual_blocked_category" =');
    expect(statement).toContain('"manual_blocked_job_id" =');
    expect(statement).toContain('"manual_blocked_session_key" =');
    expect(statement).toContain('"manual_blocked_fingerprint" =');
    expect(statement).toContain('"manual_blocked_generation" =');
    expect(statement).toContain('"generation" =');
    expect(statement).toContain('"lease_token" =');
    expect(statement).not.toContain('DELETE FROM');
  });

  it('requeues an unavailable queue without converting it into manual review', async () => {
    const { prisma, service } = createService({
      requests: [{ chat_id: 'chat-retry', generation: 2n }],
      repair: jest.fn().mockResolvedValue({
        queueAvailable: false,
        scheduleEnabled: null,
        passes: 0,
      }),
    });

    await expect(
      (
        service as unknown as {
          reconcileBatch: () => Promise<number>;
        }
      ).reconcileBatch(),
    ).resolves.toBe(1);

    const statement = extractSqlText(prisma.$executeRaw.mock.calls[0]?.[0]);
    expect(statement).toContain('"requested_at" =');
    expect(statement).toContain('"lease_token" = NULL');
    expect(statement).toContain('"last_error_code" =');
    expect(statement).toContain('"last_error_at" =');
    expect(statement).toContain('"last_error" =');
    expect(statement).not.toContain('"manual_blocked_at" =');
  });
});
