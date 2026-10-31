import { randomUUID } from 'node:crypto';
import { MaxApiInternalRateLimitError } from '../max/max-client.service';
import {
  createMultibotHarness,
  type MultibotHarness,
} from '../webhook/webhook-multibot-fullpath.spec-support';
import {
  AUTOMATIC_MUTE_HISTORY_MS,
  automaticMuteHistoryPage,
  persistAutomaticMuteCleanup,
} from './automatic-mute-cleanup';
import { AutomaticMuteCleanupService } from './automatic-mute-cleanup.service';
import { Prisma } from '../prisma/prisma-client';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
const redisUrl = process.env.MAXIM_TEST_REDIS_URL?.trim() ?? '';
const describeStores = databaseUrl && redisUrl ? describe : describe.skip;
jest.setTimeout(60_000);

describeStores('native automatic mute history cleanup', () => {
  let h: MultibotHarness;
  beforeEach(async () => {
    h = await createMultibotHarness({
      databaseUrl,
      redisUrl,
      bots: 2,
      mode: 'off',
    });
  });
  afterEach(async () => {
    await h.dispose();
  });

  async function enableDueDeleteRecovery() {
    // FLAG: Positive completion tests include the production SQL retry sweeper.
    // Negative/ambiguous fixtures keep their original observation-only drain.
    await h.dispose();
    h = await createMultibotHarness({
      databaseUrl,
      redisUrl,
      bots: 2,
      mode: 'off',
      recoverDueDeletes: true,
    });
  }

  async function seedMessage(
    chatId: string,
    at: number,
    senderId = 'fixture-user',
    media?: string,
  ) {
    const messageId = `history-${randomUUID()}`;
    for (const bot of h.bots) {
      const id = await h.ingest({
        chatId,
        messageId,
        at,
        text: media ? '' : 'text',
        botId: bot.id,
        attachments: media
          ? [{ type: media, payload: { code: 'fixture', url: 'https://fixture.invalid/media' } }]
          : [],
      });
      const receipt = await h.prisma.webhookEvent.findUniqueOrThrow({ where: { id } });
      const payload = receipt.normalizedPayload as Prisma.JsonObject;
      const message = payload.message as Prisma.JsonObject;
      await h.prisma.webhookEvent.update({
        where: { id },
        data: {
          status: 'PROCESSED',
          createdAt: new Date(at),
          processedAt: new Date(),
          normalizedPayload: {
            ...payload,
            message: { ...message, senderId },
          } as Prisma.InputJsonObject,
        },
      });
    }
    const remote = h.messages.get(messageId) as { sender: { user_id: string } };
    remote.sender.user_id = senderId;
    return messageId;
  }
  async function mute(chatId: string, at: number) {
    return h.prisma.$transaction(async (tx) => {
      const event = await tx.moderationEvent.create({
        data: {
          chatId,
          userId: 'fixture-user',
          messageId: `source-${randomUUID()}`,
          botId: h.bots[0]!.id,
          action: 'MUTE',
          eventType: 'MESSAGE',
          ruleCode: 'STICKER_RATE_LIMIT',
          operator: 'BOT',
          createdAt: new Date(at),
          metadata: {
            sanctionApplied: true,
            muteDurationHours: 1,
            muteExpiresAt: new Date(at + 3_600_000).toISOString(),
          },
        },
      });
      await persistAutomaticMuteCleanup(tx, event);
      return event;
    });
  }
  async function scan() {
    for (let i = 0; i < 20; i++) {
      await h.prisma.automaticMuteCleanup.updateMany({
        where: { chatId: { in: h.chatIds }, status: 'PENDING', leaseToken: null },
        data: { nextAttemptAt: new Date(0) },
      });
      await h.automaticMuteCleanup.sweep();
      if (
        !(await h.prisma.automaticMuteCleanup.count({
          where: { chatId: { in: h.chatIds }, status: 'PENDING' },
        }))
      )
        return;
    }
    throw new Error('History scan did not terminate');
  }

  it('deletes text, voice and stickers only inside the same participant/chat 30-minute window, deduplicating mirrors and pages', async () => {
    await enableDueDeleteRecovery();
    const [chat, other] = await h.seedCatalog(2, { maxMessageLengthEnabled: false });
    const at = Date.now() - 100;
    const inside = [];
    // FLAG: Six deletes fit the real actor burst; mirrored receipts still require two pages.
    for (let i = 0; i < 5; i++)
      inside.push(
        await seedMessage(
          chat!,
          at - 10_000 - i,
          'fixture-user',
          ['sticker', 'voice', undefined][i % 3],
        ),
      );
    inside.push(await seedMessage(chat!, at - AUTOMATIC_MUTE_HISTORY_MS));
    const outside = [
      await seedMessage(chat!, at - AUTOMATIC_MUTE_HISTORY_MS - 1),
      await seedMessage(chat!, at - 1_000, 'someone-else'),
      await seedMessage(other!, at - 1_000),
      await seedMessage(chat!, at + 1),
    ];
    const event = await mute(chat!, at);
    await scan();
    await h.drain();
    if (inside.some((id) => h.messages.has(id))) {
      console.error(
        'NATIVE_MUTE_CLEANUP_RETAINED',
        JSON.stringify({
          messages: inside.map((id, index) => ({ index, retained: h.messages.has(id) })),
          intents: await h.prisma.moderationDeleteIntent.findMany({
            where: { chatId: chat!, messageId: { in: inside } },
            select: { status: true, attemptCount: true, nextAttemptAt: true, lastErrorCode: true },
          }),
          queue: await h.deleteQueue.getJobCounts('active', 'waiting', 'delayed', 'prioritized'),
        }),
      );
    }
    for (const id of inside) expect(h.messages.has(id)).toBe(false);
    for (const id of outside) expect(h.messages.has(id)).toBe(true);
    const deletes = h.effects.filter((e) => e.method === 'delete');
    expect(deletes.map((e) => e.messageId).sort()).toEqual(inside.sort());
    expect(
      await h.prisma.automaticMuteCleanup.findUnique({ where: { eventId: event.id } }),
    ).toMatchObject({ status: 'SCANNED', scannedReceipts: 14, attemptCount: 2 });
    await scan();
    await h.drain();
    expect(h.effects.filter((e) => e.method === 'delete')).toEqual(deletes);
  });

  it('keeps a SQL-owned retry pending after the Redis job finishes and performs it once', async () => {
    await enableDueDeleteRecovery();
    const [chat] = await h.seedCatalog(1, { maxMessageLengthEnabled: false });
    const at = Date.now() - 100;
    const messageId = await seedMessage(chat!, at - 1_000);
    jest
      .spyOn(h.max, 'getChatMemberAccess')
      .mockRejectedValueOnce(
        new MaxApiInternalRateLimitError('Fixture automatic cleanup quota', 7),
      );
    await mute(chat!, at);
    await scan();
    const deadline = Date.now() + 5_000;
    let deferred = false;
    while (Date.now() < deadline) {
      const intent = await h.prisma.moderationDeleteIntent.findUniqueOrThrow({
        where: { chatId_messageId: { chatId: chat!, messageId } },
      });
      const queued = await h.deleteQueue.getJobCounts(
        'active',
        'waiting',
        'delayed',
        'prioritized',
      );
      if (intent.status === 'RETRYABLE' && Object.values(queued).every((count) => count === 0)) {
        expect(intent.lastErrorCode).toBe('MAX_API_INTERNAL_RATE_LIMIT');
        deferred = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(deferred).toBe(true);
    expect(h.messages.has(messageId)).toBe(true);
    expect(h.effects).toEqual([]);
    expect(await h.pumpOnce()).toBeGreaterThan(0);
    await h.drain();
    expect(h.messages.has(messageId)).toBe(false);
    expect(h.effects.filter((effect) => effect.method === 'delete')).toHaveLength(1);
    expect(
      await h.prisma.moderationDeleteIntent.findUniqueOrThrow({
        where: { chatId_messageId: { chatId: chat!, messageId } },
      }),
    ).toMatchObject({ status: 'SUCCEEDED' });
  });

  it('does not report drained while a prioritized deletion is still waiting', async () => {
    const [chat] = await h.seedCatalog(1, { maxMessageLengthEnabled: false });
    const at = Date.now() - 100;
    const messageId = await seedMessage(chat!, at - 1_000);
    await h.deleteQueue.pause();
    try {
      await mute(chat!, at);
      await scan();
      const queued = await h.deleteQueue.getJobCounts('active', 'waiting', 'prioritized');
      expect(queued).toMatchObject({ active: 0, waiting: 0, prioritized: 1 });
      expect(await h.pumpOnce()).toBeGreaterThan(0);
      expect(h.messages.has(messageId)).toBe(true);
    } finally {
      await h.deleteQueue.resume();
    }
    await h.drain();
    expect(h.messages.has(messageId)).toBe(false);
    expect(h.effects.filter((effect) => effect.method === 'delete')).toHaveLength(1);
  });

  it('does not enroll historical events, manual mutes or failed sanction decisions', async () => {
    const [chat] = await h.seedCatalog(1);
    for (const kind of ['historical', 'manual', 'failed'] as const) {
      await h.prisma.$transaction(async (tx) => {
        const event = await tx.moderationEvent.create({
          data: {
            chatId: chat!,
            userId: 'fixture-user',
            messageId: `source-${kind}`,
            action: 'MUTE',
            eventType: 'MESSAGE',
            ruleCode: kind === 'manual' ? 'MANUAL_MUTE' : 'STICKER_RATE_LIMIT',
            operator: kind === 'manual' ? 'ADMIN' : 'BOT',
            metadata: { sanctionApplied: kind !== 'failed' },
          },
        });
        if (kind !== 'historical') await persistAutomaticMuteCleanup(tx, event);
      });
    }
    await h.automaticMuteCleanup.sweep();
    expect(await h.prisma.automaticMuteCleanup.count({ where: { chatId: chat } })).toBe(0);
    expect(h.effects).toEqual([]);
  });

  it('rolls the applied mute back when its durable cleanup cannot commit', async () => {
    const [chat] = await h.seedCatalog(1);
    const id = `rollback-${randomUUID()}`;
    await expect(
      h.prisma.$transaction(async (tx) => {
        const event = await tx.moderationEvent.create({
          data: {
            id,
            chatId: chat!,
            userId: 'fixture-user',
            messageId: 'source',
            action: 'MUTE',
            eventType: 'MESSAGE',
            ruleCode: 'STICKER_RATE_LIMIT',
            metadata: { sanctionApplied: true },
          },
        });
        await persistAutomaticMuteCleanup(tx, event);
        throw new Error('commit failed');
      }),
    ).rejects.toThrow('commit failed');
    expect(await h.prisma.moderationEvent.findUnique({ where: { id } })).toBeNull();
    expect(await h.prisma.automaticMuteCleanup.findUnique({ where: { eventId: id } })).toBeNull();
  });

  it('resumes the same page after materialization failure and a new service instance without duplicating deletes', async () => {
    const [chat] = await h.seedCatalog(1);
    const at = Date.now() - 100;
    const first = await seedMessage(chat!, at - 2000);
    const second = await seedMessage(chat!, at - 1000);
    const event = await mute(chat!, at);
    const original = h.intents.ensureAutomaticMuteHistoryIntent.bind(h.intents);
    let calls = 0;
    const spy = jest
      .spyOn(h.intents, 'ensureAutomaticMuteHistoryIntent')
      .mockImplementation(async (input) => {
        if (++calls === 2) throw new Error('storage unavailable');
        return original(input);
      });
    await h.automaticMuteCleanup.sweep();
    expect(
      await h.prisma.automaticMuteCleanup.findUnique({ where: { eventId: event.id } }),
    ).toMatchObject({ status: 'PENDING', cursorId: null, lastErrorCode: 'PAGE_RETRY' });
    spy.mockRestore();
    await h.prisma.automaticMuteCleanup.update({
      where: { eventId: event.id },
      data: { nextAttemptAt: new Date(0) },
    });
    const restarted = new AutomaticMuteCleanupService(h.prisma as never, h.intents, h.legacyHolds);
    await restarted.sweep();
    await h.drain();
    expect(
      h.effects
        .filter((e) => e.method === 'delete')
        .map((e) => e.messageId)
        .sort(),
    ).toEqual([first, second].sort());
  });

  it.each(['release', 'admin', 'expired', 'wrong-author', 'bot-access'])(
    'refuses historical deletion after %s',
    async (change) => {
      const [chat] = await h.seedCatalog(1);
      const at = Date.now() - 100;
      const id = await seedMessage(chat!, at - 10 * 60_000);
      const event = await mute(chat!, at);
      if (change === 'release')
        await h.prisma.moderationEvent.create({
          data: {
            chatId: chat!,
            userId: 'fixture-user',
            action: 'NONE',
            eventType: 'MEMBER_ACTION',
            ruleCode: 'MANUAL_UNMUTE',
            operator: 'ADMIN',
          },
        });
      if (change === 'admin') h.allowAdminUser('fixture-user');
      if (change === 'expired')
        await h.prisma.moderationEvent.update({
          where: { id: event.id },
          data: {
            metadata: { sanctionApplied: true, muteExpiresAt: new Date(at - 1).toISOString() },
          },
        });
      if (change === 'wrong-author')
        (h.messages.get(id) as { sender: { user_id: string } }).sender.user_id = 'someone-else';
      if (change === 'bot-access') for (const bot of h.bots) h.denyBot(bot.id);
      await scan();
      await h.drain();
      expect(h.messages.has(id)).toBe(true);
      expect(h.effects.filter((e) => e.method === 'delete')).toEqual([]);
    },
  );

  it('preserves unknown DELETE evidence instead of replaying the scan as a new deletion', async () => {
    const [chat] = await h.seedCatalog(1);
    const at = Date.now() - 100;
    const id = await seedMessage(chat!, at - 10 * 60_000);
    await mute(chat!, at);
    h.ambiguousNextDelete();
    await scan();
    await h.drain();
    const intent = await h.prisma.moderationDeleteIntent.findUniqueOrThrow({
      where: { chatId_messageId: { chatId: chat!, messageId: id } },
    });
    expect(intent.status).toBe('AMBIGUOUS');
    const requests = h.requests.filter((e) => e.method === 'delete').length;
    await scan();
    expect(h.requests.filter((e) => e.method === 'delete')).toHaveLength(requests);
  });

  it('recovers a lost Redis wakeup from the committed delete intent', async () => {
    const [chat] = await h.seedCatalog(1);
    const at = Date.now() - 100;
    const id = await seedMessage(chat!, at - 10 * 60_000);
    await mute(chat!, at);
    const enqueue = jest
      .spyOn(h.deleteQueue, 'add')
      .mockRejectedValue(new Error('Redis unavailable'));
    await scan();
    enqueue.mockRestore();
    expect(h.messages.has(id)).toBe(true);
    const intent = await h.prisma.moderationDeleteIntent.findUniqueOrThrow({
      where: { chatId_messageId: { chatId: chat!, messageId: id } },
    });
    expect(intent.status).toBe('PENDING');
    await h.intents.sweepDueIntents();
    await h.drain();
    expect(h.messages.has(id)).toBe(false);
  });

  it('rechecks release and source holds after the final awaited executor check', async () => {
    const [chat] = await h.seedCatalog(1);
    const at = Date.now() - 100;
    const id = await seedMessage(chat!, at - 10 * 60_000);
    const event = await mute(chat!, at);
    await h.deleteQueue.pause();
    await scan();
    const params = {
      chatId: chat!,
      messageId: id,
      subjectUserId: 'fixture-user',
      botId: h.bots[0]!.id,
      sourceMessageAt: new Date(at - 10 * 60_000),
      reasons: [
        {
          ruleCode: 'MUTE_ACTIVE_DELETE',
          reasonKey: `automatic-mute-history:${event.id}`,
          metadata: { muteEventId: event.id, automaticMuteCleanupId: event.id },
        },
      ],
    };
    let held = false;
    const original = h.legacyHolds.isMessageHeld.bind(h.legacyHolds);
    const spy = jest
      .spyOn(h.legacyHolds, 'isMessageHeld')
      .mockImplementation(
        async (chatId, messageId, tx) =>
          (held && messageId === event.messageId) || original(chatId, messageId, tx),
      );
    await expect(
      h.stateGuard.authorize({
        ...params,
        beforeFinalAuthority: async () => {
          held = true;
        },
      }),
    ).rejects.toMatchObject({ code: 'moderation_state_delete_no_longer_authorized' });
    spy.mockRestore();
    await expect(
      h.stateGuard.authorize({
        ...params,
        beforeFinalAuthority: async () => {
          await h.prisma.moderationEvent.create({
            data: {
              chatId: chat!,
              userId: 'fixture-user',
              action: 'NONE',
              eventType: 'MEMBER_ACTION',
              ruleCode: 'MANUAL_UNMUTE',
              operator: 'ADMIN',
            },
          });
        },
      }),
    ).rejects.toMatchObject({ code: 'moderation_state_delete_no_longer_authorized' });
    await h.deleteQueue.resume();
    await h.drain();
    expect(h.messages.has(id)).toBe(true);
  });

  it('preserves one slow page while another chat progresses and drains owned work before shutdown', async () => {
    const chats = await h.seedCatalog(3);
    const at = Date.now() - 100;
    for (const chat of chats) {
      await seedMessage(chat, at - 1000);
      await mute(chat, at);
    }
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const entering = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const original = h.intents.ensureAutomaticMuteHistoryIntent.bind(h.intents);
    const spy = jest
      .spyOn(h.intents, 'ensureAutomaticMuteHistoryIntent')
      .mockImplementation(async (input) => {
        if (input.chatId === chats[0]) {
          entered();
          await blocked;
        }
        return original(input);
      });
    const first = h.automaticMuteCleanup.sweep();
    await entering;
    for (let i = 0; i < 100; i++) {
      const done = await h.prisma.automaticMuteCleanup.findFirst({
        where: { chatId: chats[1], status: 'SCANNED' },
      });
      if (done) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await h.automaticMuteCleanup.sweep();
    expect(
      await h.prisma.automaticMuteCleanup.count({
        where: { chatId: { in: chats.slice(1) }, status: 'SCANNED' },
      }),
    ).toBe(2);
    const workers = h.automaticMuteCleanup.stopWorkerAdmission();
    let drained = false;
    const draining = workers[0]!.pause().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    release();
    await first;
    await draining;
    spy.mockRestore();
    expect(drained).toBe(true);
    expect(await h.automaticMuteCleanup.sweep()).toBe(0);
  });

  it('bounds history reads with retained history, timestamp ties, deep and empty cursors under the real planner', async () => {
    const [chat] = await h.seedCatalog(1);
    const event = await mute(chat!, Date.now());
    const row = await h.prisma.automaticMuteCleanup.findUniqueOrThrow({
      where: { eventId: event.id },
    });
    const prefix = `mute-plan-${randomUUID()}-`;
    try {
      await h.prisma.$executeRaw(Prisma.sql`
        INSERT INTO webhook_events (id, dedup_key, status, raw_payload, normalized_payload, created_at)
        SELECT ${prefix} || n::text, ${prefix} || n::text, 'PROCESSED', '{}'::jsonb,
          jsonb_build_object('type','message_created', 'message', jsonb_build_object(
            'chatId', ${chat}::text, 'senderId', 'fixture-user', 'messageId', 'source-' || n::text,
            'createdAt', '2026-01-01T00:00:00Z')),
          CASE WHEN n <= 12000 THEN ${row.windowStart}::timestamp - INTERVAL '1 day' ELSE ${row.windowEnd}::timestamp - INTERVAL '1 second' END
        FROM generate_series(1, 12100) n
      `);
      await h.prisma.$executeRaw`ANALYZE webhook_events`;
      for (const cursor of [
        row,
        {
          ...row,
          cursorCreatedAt: new Date(row.windowEnd.getTime() - 1000),
          cursorId: prefix + '12050',
        },
        { ...row, cursorCreatedAt: row.windowEnd, cursorId: 'last' },
      ]) {
        // FLAG: Execution plans are allowed only on these disposable localhost stores.
        const plan = await h.prisma.$queryRaw(
          Prisma.sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${automaticMuteHistoryPage(cursor, 8)}`,
        );
        const nodes: Record<string, unknown>[] = [];
        const walk = (value: unknown): void => {
          if (Array.isArray(value)) {
            value.forEach(walk);
            return;
          }
          if (value && typeof value === 'object') {
            const node = value as Record<string, unknown>;
            nodes.push(node);
            Object.values(node).forEach(walk);
          }
        };
        walk(plan);
        const scans = nodes.filter((node) => node['Relation Name'] === 'webhook_events');
        expect(scans).toHaveLength(1);
        expect(scans[0]!['Index Name']).toBe('webhook_events_report_history_idx');
        expect(scans[0]!['Actual Rows']).toBeLessThanOrEqual(8);
        expect(Number(scans[0]!['Rows Removed by Filter'] ?? 0)).toBe(0);
        expect(nodes.some((node) => node['Node Type'] === 'Sort')).toBe(false);
      }
    } finally {
      await h.prisma.webhookEvent.deleteMany({ where: { id: { startsWith: prefix } } });
    }
  });
});
