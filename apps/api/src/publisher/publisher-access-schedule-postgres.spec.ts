import { PublisherActorAccessExecutor } from './publisher-actor-access-executor';
import { PublisherBotProofSupersededError } from './publisher-fresh-bot-proof';
import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { PrismaClient, createPrismaAdapter } from '../prisma/prisma-client';
import { PublisherAccessRefreshPolicy } from './publisher-access-refresh-policy';
import { PublisherBindingRefreshSchedulerService } from './publisher-binding-refresh-scheduler.service';
import { syncPublisherAdminRoster } from './publisher-admin-roster';
import { PublisherAccessRefreshEvidenceService } from './publisher-access-refresh-evidence.service';
import { PublisherBotAccessExecutor } from './publisher-bot-access-executor';
import { Logger } from '@nestjs/common';
const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL ?? '';
const integration = databaseUrl ? describe : describe.skip;

integration('Publisher durable access schedule on PostgreSQL', () => {
  let db: PrismaClient;
  let chatId: string;
  const botId = `schedule-${randomUUID()}`;
  const policy = new PublisherAccessRefreshPolicy(
    new ConfigService({ MAX_PUBLISHER_ACCESS_REFRESH_MODE: 'on' }),
  );
  const enqueue = jest.fn().mockResolvedValue('nomination');
  function scheduler() {
    return new PublisherBindingRefreshSchedulerService(
      db as never,
      { enqueue, compactScheduledBacklog: jest.fn() } as never,
      { getBotId: () => botId, getRequiredActionToken: jest.fn() } as never,
      { isGloballyPaused: async () => false } as never,
      { assertAttested: jest.fn() } as never,
      { dispatchEnabled: true } as never,
      { runExclusive: async (_key: string, work: () => Promise<void>) => work() } as never,
      { recoverHistoricalActorCandidates: jest.fn() } as never,
      policy,
    );
  }
  beforeAll(async () => {
    const url = new URL(databaseUrl);
    if (!['localhost', '127.0.0.1'].includes(url.hostname) || !url.pathname.includes('race_test'))
      throw new Error('Disposable local race_test database required');
    db = new PrismaClient({
      adapter: createPrismaAdapter(databaseUrl, { max: 4, statement_timeout: 10000 }),
    });
    await db.$connect();
  });
  beforeEach(async () => {
    enqueue.mockClear();
    chatId = `schedule-${randomUUID()}`;
    await db.chat.create({
      data: {
        id: chatId,
        title: 'Schedule fixture',
        publisherBinding: {
          create: {
            publisherBotId: botId,
            status: 'ACTIVE',
            botAccessState: 'CONFIRMED_ADMIN',
            botAccessCheckedAt: new Date(),
            botAccessExpiresAt: new Date(Date.now() + 900000),
            rosterRefreshAfter: new Date(0),
          },
        },
      },
    });
  });
  afterEach(async () => {
    await db.chat.deleteMany({ where: { publisherBinding: { is: { publisherBotId: botId } } } });
    await db.publisherAccessRefreshObligation.deleteMany({ where: { publisherBotId: botId } });
  });
  afterAll(async () => {
    await db?.$disconnect();
  });

  async function proof() {
    const binding = (await db.publisherEntityBinding.findUnique({ where: { chatId } }))!;
    return {
      prisma: db as never,
      maxClient: {} as never,
      chatId,
      publisherBotId: botId,
      entityType: 'CHAT' as const,
      probeStartedAt: new Date(),
      botAccessCheckedAt: binding.botAccessCheckedAt!,
      botAccessState: 'CONFIRMED_ADMIN' as const,
    };
  }
  const roster = (p: Awaited<ReturnType<typeof proof>>) => ({
    chatId,
    publisherBotId: botId,
    probeStartedAtMs: p.probeStartedAt.getTime(),
    members: [{ userId: 'admin', isBot: false, isAdmin: true, isOwner: false, permissions: [] }],
  });

  const adminAccess = {
    isAdmin: true,
    isOwner: false,
    permissions: ['write'],
    permissionsKnown: true,
  };
  function evidence() {
    return new PublisherAccessRefreshEvidenceService(db as never, policy);
  }
  async function expiringProof(deadline = new Date(Date.now() + 30_000)) {
    return db.publisherEntityBinding.update({
      where: { chatId },
      data: {
        botAccessCheckedAt: new Date(deadline.getTime() - 15 * 60_000),
        botAccessExpiresAt: deadline,
      },
    });
  }

  it.each(['renewed', 'expired', 'revoked', 'actor_version'])(
    'fences SQL proof reuse when %s during the actor probe',
    async (race) => {
      const binding = (await db.publisherEntityBinding.findUnique({ where: { chatId } }))!;
      const actor = new PublisherActorAccessExecutor(
        db as never,
        {
          getChatMemberAccess: async () => {
            if (race === 'actor_version') {
              await db.managedEntityAccessEdge.create({
                data: {
                  chatId,
                  userId: 'actor',
                  botId,
                  entityType: 'CHAT',
                  state: 'USER_DENIED',
                  userRole: 'UNKNOWN',
                  botRole: 'ADMIN',
                  checkedAt: new Date(),
                  source: 'test',
                  sourceVersion: 'v2',
                },
              });
            } else {
              await db.publisherEntityBinding.update({
                where: { chatId },
                data:
                  race === 'revoked'
                    ? {
                        status: 'REMOVED',
                        lifecycleEventAt: new Date(),
                        lifecycleEventType: 'bot_removed',
                      }
                    : race === 'expired'
                      ? { botAccessExpiresAt: new Date(0) }
                      : { botAccessCheckedAt: new Date(binding.botAccessCheckedAt!.getTime() + 1) },
              });
            }
            return { ...adminAccess, userId: 'actor', isBot: false };
          },
        } as never,
        botId,
      );
      const running = actor.execute({
        chatId,
        entityType: 'CHAT',
        userId: 'actor',
        candidateVersion: 'v1',
        botAccess: { ...adminAccess, userId: null },
        probeStartedAt: new Date(),
        committedBotAccessCheckedAt: binding.botAccessCheckedAt!,
        committedBotAccessState: 'CONFIRMED_ADMIN',
        interactive: false,
      });
      if (race === 'renewed' || race === 'expired')
        await expect(running).rejects.toBeInstanceOf(PublisherBotProofSupersededError);
      else expect((await running).committed).toBe(false);
      expect(await db.managedEntityAccessEdge.count({ where: { chatId, state: 'GRANTED' } })).toBe(
        0,
      );
    },
  );

  it('keeps one exact obligation across repeated scans, retries and observer restart', async () => {
    const previous = await expiringProof();
    await Promise.all([
      evidence().observeDue(botId, [previous], new Date()),
      evidence().observeDue(botId, [previous], new Date()),
    ]);
    const executor = new PublisherBotAccessExecutor(
      db as never,
      { getCurrentChatMemberAccess: async () => adminAccess } as never,
      botId,
      evidence(),
    );
    const result = await executor.execute({
      chatId,
      previous,
      probeStartedAt: new Date(),
      reason: 'scheduled_bot_access',
      materializeForwarded: false,
    });
    expect(result.outcome).toBe('confirmed');
    const first = await db.publisherAccessRefreshObligation.findMany({
      where: { publisherBotId: botId },
    });
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ resolution: 'confirmed', committedAt: result.committedAt });
    expect(first[0].committedAt!.getTime()).toBeLessThanOrEqual(first[0].requiredBefore.getTime());
    await evidence().observeDue(botId, [previous], new Date());
    await evidence().recordCommittedProof({
      chatId,
      previous,
      probeStartedAt: new Date(),
      committedAt: new Date(previous.botAccessExpiresAt!.getTime() + 1),
      outcome: 'denied',
    });
    expect(
      await db.publisherAccessRefreshObligation.findMany({ where: { publisherBotId: botId } }),
    ).toEqual(first);
  });

  it('registers an overdue obligation even when a proof was never enqueued by the scanner', async () => {
    const previous = await expiringProof(new Date(Date.now() - 10_000));
    const result = await new PublisherBotAccessExecutor(
      db as never,
      { getCurrentChatMemberAccess: async () => adminAccess } as never,
      botId,
      evidence(),
    ).execute({
      chatId,
      previous,
      probeStartedAt: new Date(),
      reason: 'scheduled_bot_access',
      materializeForwarded: false,
    });
    const row = await db.publisherAccessRefreshObligation.findFirstOrThrow({
      where: { publisherBotId: botId },
    });
    expect(row.resolution).toBe('confirmed');
    expect(row.committedAt).toEqual(result.committedAt);
    expect(row.committedAt!.getTime()).toBeGreaterThan(row.requiredBefore.getTime());
  });

  it('leaves a failed probe pending and includes it after its deadline and binding deletion', async () => {
    const to = new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000);
    const previous = await expiringProof(new Date(to.getTime() - 10_000));
    await evidence().observeDue(botId, [previous], new Date());
    const executor = new PublisherBotAccessExecutor(
      db as never,
      {
        getCurrentChatMemberAccess: async () => {
          throw new Error('probe timeout');
        },
      } as never,
      botId,
      evidence(),
    );
    await expect(
      executor.execute({
        chatId,
        previous,
        probeStartedAt: new Date(),
        reason: 'scheduled_bot_access',
        materializeForwarded: false,
      }),
    ).rejects.toThrow('probe timeout');
    await db.chat.delete({ where: { id: chatId } });
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    try {
      await evidence().reportCompletedHour(botId, new Date());
      expect(log).toHaveBeenCalledWith(
        expect.objectContaining({
          metric: 'publisher_access_obligations_v1',
          cohorts: [
            {
              cohort: 'separated',
              obligations: 1,
              confirmedInTime: 0,
              confirmedLate: 0,
              denied: 0,
              unresolved: 1,
              registeredAfterDeadline: 1,
              sourceTruncated: false,
            },
          ],
        }),
        'Publisher access obligation hour',
      );
      expect(JSON.stringify(log.mock.calls)).not.toContain(botId);
      expect(JSON.stringify(log.mock.calls)).not.toContain(chatId);
    } finally {
      log.mockRestore();
    }
  });

  it('does not settle a replaced proof after a concurrent revoke during the MAX probe', async () => {
    const previous = await expiringProof();
    await evidence().observeDue(botId, [previous], new Date());
    const probeStartedAt = new Date();
    const executor = new PublisherBotAccessExecutor(
      db as never,
      {
        getCurrentChatMemberAccess: async () => {
          await db.publisherEntityBinding.update({
            where: { chatId },
            data: {
              status: 'REMOVED',
              lifecycleEventType: 'bot_removed',
              lifecycleEventAt: new Date(probeStartedAt.getTime() + 1),
            },
          });
          return adminAccess;
        },
      } as never,
      botId,
      evidence(),
    );
    const result = await executor.execute({
      chatId,
      previous,
      probeStartedAt,
      reason: 'scheduled_bot_access',
      materializeForwarded: false,
    });
    expect(result.outcome).toBe('superseded');
    expect(result.committedAt).toBeNull();
    expect(
      await db.publisherAccessRefreshObligation.findFirstOrThrow({
        where: { publisherBotId: botId },
      }),
    ).toMatchObject({ resolution: 'pending', committedAt: null });
  });

  it('retains a committed grant when diagnostic persistence is unavailable', async () => {
    const previous = await expiringProof();
    const failedEvidence = new PublisherAccessRefreshEvidenceService(
      {
        publisherAccessRefreshObligation: {
          upsert: async () => {
            throw new Error('evidence unavailable');
          },
        },
      } as never,
      policy,
    );
    const warning = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      const result = await new PublisherBotAccessExecutor(
        db as never,
        { getCurrentChatMemberAccess: async () => adminAccess } as never,
        botId,
        failedEvidence,
      ).execute({
        chatId,
        previous,
        probeStartedAt: new Date(),
        reason: 'scheduled_bot_access',
        materializeForwarded: false,
      });
      expect(result.outcome).toBe('confirmed');
      expect(
        (await db.publisherEntityBinding.findUniqueOrThrow({ where: { chatId } }))
          .botAccessCheckedAt,
      ).toEqual(result.checkedAt);
      expect(warning).toHaveBeenCalledWith(
        expect.objectContaining({
          metric: 'publisher_access_evidence_gap_v1',
          reason: 'resolution_write_failed',
        }),
        expect.any(String),
      );
    } finally {
      warning.mockRestore();
    }
  });

  it('bounds diagnostic retention and preserves recent unresolved evidence', async () => {
    const now = new Date();
    const old = new Date(now.getTime() - 8 * 24 * 3_600_000);
    await db.publisherAccessRefreshObligation.createMany({
      data: Array.from({ length: 510 }, (_, i) => ({
        publisherBotId: botId,
        chatId: `old-${i}`,
        proofCheckedAt: new Date(old.getTime() - 900_000),
        requiredBefore: old,
        cohort: 'separated',
      })),
    });
    const previous = await expiringProof(new Date(now.getTime() - 10_000));
    await evidence().observeDue(botId, [previous], now);
    await evidence().maintain(now);
    expect(
      await db.publisherAccessRefreshObligation.count({ where: { publisherBotId: botId } }),
    ).toBe(11);
    expect(
      await db.publisherAccessRefreshObligation.findFirst({
        where: { publisherBotId: botId, chatId },
      }),
    ).not.toBeNull();
  });

  it('does not inflate the denominator with early refreshes of a still-fresh proof', async () => {
    const previous = await db.publisherEntityBinding.findUniqueOrThrow({ where: { chatId } });
    await evidence().observeDue(botId, [previous], new Date());
    await evidence().recordCommittedProof({
      chatId,
      previous,
      probeStartedAt: new Date(),
      committedAt: new Date(),
      outcome: 'confirmed',
    });
    expect(
      await db.publisherAccessRefreshObligation.count({ where: { publisherBotId: botId } }),
    ).toBe(0);
  });

  it('keeps a confirmed remote denial out of the renewal numerator', async () => {
    const previous = await expiringProof();
    const result = await new PublisherBotAccessExecutor(
      db as never,
      {
        getCurrentChatMemberAccess: async () => ({
          ...adminAccess,
          isAdmin: false,
          permissions: [],
        }),
      } as never,
      botId,
      evidence(),
    ).execute({
      chatId,
      previous,
      probeStartedAt: new Date(),
      reason: 'scheduled_bot_access',
      materializeForwarded: false,
    });
    expect(result.outcome).toBe('denied');
    expect(
      await db.publisherAccessRefreshObligation.findFirstOrThrow({
        where: { publisherBotId: botId },
      }),
    ).toMatchObject({ resolution: 'denied', committedAt: result.committedAt });
  });

  it('reports truncated evidence explicitly under bounded PostgreSQL memory', async () => {
    const to = new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000);
    const deadline = new Date(to.getTime() - 10_000);
    await db.$executeRaw`
      INSERT INTO publisher_access_refresh_obligations
        (publisher_bot_id, chat_id, proof_checked_at, required_before, cohort)
      SELECT ${botId}, 'cap-' || value, ${new Date(deadline.getTime() - 900_000)}::timestamp,
        ${deadline}::timestamp, 'separated' FROM generate_series(1, 50001) AS value
    `;
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const warning = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      await db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe("SET LOCAL work_mem = '1MB'");
        await tx.$executeRawUnsafe("SET LOCAL temp_file_limit = '8MB'");
        await new PublisherAccessRefreshEvidenceService(tx as never, policy).reportCompletedHour(
          botId,
          new Date(),
        );
      });
      expect(warning).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledWith(
        expect.objectContaining({
          cohorts: [
            expect.objectContaining({
              obligations: 50000,
              unresolved: 50000,
              sourceTruncated: true,
            }),
          ],
        }),
        'Publisher access obligation hour',
      );
    } finally {
      log.mockRestore();
      warning.mockRestore();
    }
  });

  it('recovers a lost queue nomination after restart and stops scheduling after atomic success', async () => {
    await scheduler().scan('startup');
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ chatId, reason: 'binding_maintenance' }),
    );
    enqueue.mockClear();
    await scheduler().scan('startup');
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ chatId, reason: 'binding_maintenance' }),
    );
    const p = await proof();
    expect(await syncPublisherAdminRoster(p, roster(p))).toBe(true);
    const saved = (await db.publisherEntityBinding.findUnique({ where: { chatId } }))!;
    expect(saved.rosterCheckedAt).toEqual(p.probeStartedAt);
    expect(saved.rosterRefreshAfter!.getTime() - saved.rosterCheckedAt!.getTime()).toBe(1800000);
    enqueue.mockClear();
    await scheduler().scan('startup');
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('rejects an old roster after a lifecycle revocation and leaves all grants absent', async () => {
    const p = await proof();
    await db.publisherEntityBinding.update({
      where: { chatId },
      data: {
        status: 'REMOVED',
        lifecycleEventAt: new Date(p.probeStartedAt.getTime() + 1),
        lifecycleEventType: 'bot_removed',
      },
    });
    expect(await syncPublisherAdminRoster(p, roster(p))).toBe(false);
    expect(await db.managedEntityAccessEdge.count({ where: { chatId } })).toBe(0);
    expect(
      (await db.publisherEntityBinding.findUnique({ where: { chatId } }))!.rosterCheckedAt,
    ).toBeNull();
  });

  it('rolls back schedule metadata when an edge write fails inside the transaction', async () => {
    const p = await proof();
    const failing = {
      $transaction: (fn: (tx: unknown) => Promise<unknown>) =>
        db.$transaction((tx) =>
          fn({
            $queryRaw: tx.$queryRaw.bind(tx),
            publisherEntityBinding: tx.publisherEntityBinding,
            managedEntityAccessEdge: {
              updateMany: async () => {
                throw new Error('injected edge write failure');
              },
            },
          }),
        ),
    };
    await expect(
      syncPublisherAdminRoster({ ...p, prisma: failing as never }, roster(p)),
    ).rejects.toThrow('injected edge write failure');
    expect(
      (await db.publisherEntityBinding.findUnique({ where: { chatId } }))!.rosterCheckedAt,
    ).toBeNull();
    expect(await db.managedEntityAccessEdge.count({ where: { chatId } })).toBe(0);
  });

  it('loses a bot-proof race between the roster read and its SQL CAS without granting edges', async () => {
    const p = await proof();
    let signal!: () => void;
    let resume!: () => void;
    const read = new Promise<void>((resolve) => {
      signal = resolve;
    });
    const changed = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const racing = {
      $transaction: (fn: (tx: unknown) => Promise<unknown>) =>
        db.$transaction((tx) =>
          fn({
            $queryRaw: tx.$queryRaw.bind(tx),
            managedEntityAccessEdge: tx.managedEntityAccessEdge,
            publisherEntityBinding: {
              updateMany: tx.publisherEntityBinding.updateMany.bind(tx.publisherEntityBinding),
              findUnique: async () => {
                const original = await tx.publisherEntityBinding.findUnique({ where: { chatId } });
                signal();
                await changed;
                return original;
              },
            },
          }),
        ),
    };
    const result = syncPublisherAdminRoster({ ...p, prisma: racing as never }, roster(p));
    await read;
    try {
      await db.publisherEntityBinding.update({
        where: { chatId },
        data: {
          botAccessState: 'DENIED',
          botAccessCheckedAt: new Date(p.probeStartedAt.getTime() + 1),
        },
      });
    } finally {
      resume();
    }
    expect(await result).toBe(false);
    expect(await db.managedEntityAccessEdge.count({ where: { chatId } })).toBe(0);
    expect(
      (await db.publisherEntityBinding.findUnique({ where: { chatId } }))!.rosterCheckedAt,
    ).toBeNull();
  });

  it('orders by expiry and advances past a full page of still-pending bot checks', async () => {
    const prefix = `deadline-${randomUUID()}`;
    const due = Array.from({ length: 205 }, (_, index) => ({
      id: `${prefix}-${String(205 - index).padStart(3, '0')}`,
      title: 'Deadline fixture',
    }));
    await db.chat.createMany({ data: due });
    await db.publisherEntityBinding.createMany({
      data: due.map((chat, index) => ({
        chatId: chat.id,
        publisherBotId: botId,
        status: 'ACTIVE',
        botAccessState: 'CONFIRMED_ADMIN',
        botAccessCheckedAt: new Date(Date.now() - 1000000),
        botAccessExpiresAt: new Date(Date.now() - 500000 + index * 100),
        rosterRefreshAfter: new Date(Date.now() + 1800000),
      })),
    });
    const runner = scheduler();
    await runner.scan('startup');
    const first = enqueue.mock.calls
      .map(([job]) => job)
      .filter((job) => job.reason === 'scheduled_bot_access');
    expect(first.map((job) => job.chatId)).toEqual(due.slice(0, 200).map((chat) => chat.id));
    expect(first.every((job) => job.requiredBefore instanceof Date)).toBe(true);
    enqueue.mockClear();
    await runner.scan('scheduled');
    const next = enqueue.mock.calls
      .map(([job]) => job)
      .filter((job) => job.reason === 'scheduled_bot_access');
    expect(next.map((job) => job.chatId)).toEqual(due.slice(200).map((chat) => chat.id));
  });

  it('uses the reviewed expiry and roster index access paths', async () => {
    const plans = await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL enable_seqscan = off');
      await tx.$executeRawUnsafe('SET LOCAL enable_sort = off');
      return Promise.all([
        tx.$queryRawUnsafe(
          `EXPLAIN SELECT chat_id FROM publisher_entity_bindings WHERE publisher_bot_id = $1 AND status = 'ACTIVE' AND bot_access_expires_at <= NOW() ORDER BY bot_access_expires_at, chat_id LIMIT 200`,
          botId,
        ),
        tx.$queryRawUnsafe(
          `EXPLAIN SELECT chat_id FROM publisher_entity_bindings WHERE publisher_bot_id = $1 AND status = 'ACTIVE' AND roster_refresh_after <= NOW() ORDER BY roster_refresh_after, chat_id LIMIT 25`,
          botId,
        ),
      ]);
    });
    expect(JSON.stringify(plans[0])).toContain('publisher_bindings_expiry_idx');
    expect(JSON.stringify(plans[1])).toContain('publisher_bindings_roster_due_idx');
  });
});
