import { fork, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { Queue, QueueEvents } from 'bullmq';
import { createPrismaClient, Prisma } from '../prisma/prisma-client';
import type { MaxActionJob } from './max-client.service';
import { WebhookLegacyHoldService } from '../webhook/webhook-legacy-hold.service';
import type { MaxLegacyHoldCrashInput } from '../../test/fixtures/max-legacy-hold-crash-worker';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
const redisUrl = process.env.MAXIM_TEST_REDIS_URL?.trim() ?? '';
const stores = databaseUrl && redisUrl ? describe : describe.skip;
const fixture = resolve(__dirname, '../../test/fixtures/max-legacy-hold-crash-worker.ts');
jest.setTimeout(60_000);

type Checkpoint = { name: string; jobId?: string; error?: string; code?: string; pid?: number };
function startChild(input: MaxLegacyHoldCrashInput) {
  const child = fork(fixture, [], {
    cwd: resolve(__dirname, '../..'),
    execArgv: ['--import', require.resolve('tsx')],
    env: { ...process.env, TZ: 'UTC', NODE_ENV: 'test' },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const messages: Checkpoint[] = [];
  let output = '';
  const pending: Checkpoint[] = [];
  const listeners = new Set<() => void>();
  for (const stream of [child.stdout, child.stderr])
    stream?.on('data', (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-3000);
    });
  child.on('message', (message: Checkpoint) => {
    messages.push(message);
    pending.push(message);
    for (const listener of listeners) listener();
  });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done) => {
    child.once('error', (error) => {
      output += error.message;
      done({ code: 1, signal: null });
    });
    child.once('close', (code, signal) => {
      done({ code, signal });
      for (const listener of listeners) listener();
    });
  });
  child.send(input);
  return {
    child,
    closed,
    messages,
    async checkpoint(name: string, jobId?: string): Promise<Checkpoint> {
      return new Promise<Checkpoint>((done, reject) => {
        const finish = (error?: Error, message?: Checkpoint) => {
          clearTimeout(timer);
          listeners.delete(inspect);
          if (error) reject(error);
          else done(message!);
        };
        const inspect = () => {
          const failure = pending.find(
            (message) => message.name === 'failure' || message.name === 'worker-error',
          );
          if (failure) return finish(new Error(failure.error));
          const index = pending.findIndex(
            (message) => message.name === name && (!jobId || message.jobId === jobId),
          );
          if (index >= 0) return finish(undefined, pending.splice(index, 1)[0]);
          if (child.exitCode !== null || child.signalCode !== null)
            finish(new Error(`Fixture worker stopped before ${name}: ${output}`));
        };
        const timer = setTimeout(
          () => finish(new Error(`Fixture checkpoint ${name} timed out: ${output}`)),
          15_000,
        );
        listeners.add(inspect);
        inspect();
      });
    },
    async kill() {
      // FLAG: Signal only this fixture's private child, never another worker or Redis server.
      if (child.pid && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      return closed;
    },
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return closed;
      child.send('stop');
      const timer = setTimeout(() => child.kill('SIGKILL'), 5_000);
      try {
        return await closed;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

stores('permanent legacy holds after OS worker SIGKILL and real BullMQ restart', () => {
  let prisma: ReturnType<typeof createPrismaClient>;
  let queue: Queue<MaxActionJob>;
  let events: QueueEvents;
  let certificateId: string;
  let chatId: string;
  let otherChatId: string;
  let userId: string;
  let children: Array<ReturnType<typeof startChild>>;

  beforeEach(async () => {
    const database = new URL(databaseUrl);
    const cache = new URL(redisUrl);
    if (
      !['localhost', '127.0.0.1', '[::1]'].includes(database.hostname) ||
      !database.pathname.includes('race_test') ||
      !['localhost', '127.0.0.1', '[::1]'].includes(cache.hostname)
    )
      throw new Error('Legacy crash tests require disposable local stores');
    prisma = createPrismaClient(databaseUrl, { max: 4 });
    await prisma.$connect();
    const [native] = await prisma.$queryRaw<Array<{ version: string; timezone: string }>>`
      SELECT version(), current_setting('TimeZone') AS timezone
    `;
    expect(native?.version).toMatch(/^PostgreSQL /u);
    expect(native?.timezone).toBe('UTC');
    expect(process.env.TZ).toBe('UTC');
    certificateId = `fixture-certificate-${randomUUID()}`;
    chatId = `fixture-legacy-chat-${randomUUID()}`;
    otherChatId = `fixture-other-chat-${randomUUID()}`;
    userId = `fixture-legacy-user-${randomUUID()}`;
    children = [];
    queue = new Queue<MaxActionJob>(`legacy-crash-${randomUUID()}`, {
      connection: { url: redisUrl },
    });
    events = new QueueEvents(queue.name, { connection: { url: redisUrl } });
    await Promise.all([queue.waitUntilReady(), events.waitUntilReady()]);
  });

  afterEach(async () => {
    for (const child of children ?? []) await child.kill();
    if (queue) {
      await queue.obliterate({ force: true });
      await queue.close();
    }
    await events?.close();
    if (prisma) {
      // FLAG: Delete only rows named by this disposable fixture; production holds never expire.
      await prisma.$executeRaw(
        Prisma.sql`DELETE FROM "webhook_legacy_child_holds" WHERE "certificate_id" = ${certificateId}`,
      );
      await prisma.$executeRaw(
        Prisma.sql`DELETE FROM "webhook_legacy_recoveries" WHERE "certificate_id" = ${certificateId}`,
      );
      await prisma.$executeRaw(
        Prisma.sql`DELETE FROM "webhook_legacy_quiescence_certificates" WHERE "id" = ${certificateId}`,
      );
      await prisma.maxActionLedgerEntry.deleteMany({
        where: { chatId: { in: [chatId, otherChatId] } },
      });
      await prisma.$disconnect();
    }
  });

  async function installFixtureHolds(job: MaxActionJob, stopped: ChildProcess) {
    expect(stopped.signalCode).toBe('SIGKILL');
    const quiescedAt = new Date();
    const attestation = {
      fixture: true,
      stoppedPid: stopped.pid,
      stoppedSignal: stopped.signalCode,
    };
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO "webhook_legacy_quiescence_certificates"
          ("id", "source_sha", "image_id", "attestation", "attestation_digest", "preview_sha256", "quiesced_at", "sealed_at", "recovery_count", "child_count")
        VALUES (${certificateId}, ${'a'.repeat(40)}, ${`sha256:${'b'.repeat(64)}`}, ${JSON.stringify(attestation)}::jsonb,
          ${digest(attestation)}, ${digest(job)}, ${quiescedAt}, ${quiescedAt}, 1, 1)
      `);
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO "webhook_legacy_recoveries"
          ("id", "semantic_key", "owner_webhook_event_id", "claim_id", "chat_id", "message_id", "user_id", "source_at",
            "raw_payload_digest", "normalized_payload_digest", "owner_snapshot", "claim_snapshot", "settings_snapshot", "certificate_id")
        VALUES (${`${certificateId}-recovery`}, ${`${certificateId}-semantic`}, ${`${certificateId}-owner`}, ${`${certificateId}-claim`},
          ${chatId}, 'source-message', ${userId}, ${quiescedAt}, ${digest(job)}, ${digest(job)},
          ${JSON.stringify({ fixture: true, oldJournalMissing: true })}::jsonb, '{}'::jsonb, '{}'::jsonb, ${certificateId})
      `);
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO "webhook_legacy_child_holds"
          ("job_key", "queue_name", "job_payload_digest", "chat_id", "message_id", "user_id", "certificate_id")
        VALUES (${job.idempotencyKey}, ${queue.name}, ${digest(job)}, ${chatId}, 'source-message', ${userId}, ${certificateId})
      `);
    });
    return quiescedAt;
  }

  it.each(
    [1, 4, 9].flatMap((bots) =>
      (['DELETE_MESSAGE', 'SEND_MESSAGE', 'BAN_MEMBER', 'KICK_MEMBER'] as const).map(
        (actionType) => ({ bots, actionType }),
      ),
    ),
  )(
    'keeps unknown $actionType effects held across SIGKILL with $bots bots',
    async ({ bots, actionType }) => {
      const input = { databaseUrl, redisUrl, queueName: queue.name };
      const first = startChild({ ...input, mode: 'legacy' });
      children.push(first);
      await first.checkpoint('ready');
      const job: MaxActionJob = {
        actionType,
        chatId,
        userId,
        messageId: 'source-message',
        botId: 'fixture-bot-1',
        text: 'Fixture old moderation notice',
        attempt: 1,
        idempotencyKey: `old-action-${randomUUID()}`,
        // FLAG: Exact child holds must work even when an old envelope has a future-created clock.
        createdAt: new Date(Date.now() + 3_600_000).toISOString(),
      };
      const original = await queue.add('old-inline-action', job, {
        jobId: job.idempotencyKey,
        attempts: 2,
      });
      await first.checkpoint('intent', job.idempotencyKey);
      await first.checkpoint('effect', job.idempotencyKey);
      expect(first.messages.filter((message) => message.name === 'effect')).toHaveLength(1);
      expect(await original.getState()).toBe('active');
      expect(await prisma.maxActionLedgerEntry.count({ where: { chatId } })).toBe(0);
      expect((await first.kill()).signal).toBe('SIGKILL');
      const quiescedAt = await installFixtureHolds(job, first.child);
      // Close producer/event clients and construct fresh ones. BullMQ retains the interrupted job.
      await queue.close();
      await events.close();
      queue = new Queue<MaxActionJob>(input.queueName, { connection: { url: redisUrl } });
      events = new QueueEvents(input.queueName, { connection: { url: redisUrl } });
      await Promise.all([queue.waitUntilReady(), events.waitUntilReady()]);
      const second = startChild({ ...input, mode: 'guarded' });
      children.push(second);
      await second.checkpoint('ready');
      const retained = await queue.getJob(original.id!);
      await expect(retained!.waitUntilFinished(events, 15_000)).rejects.toThrow(
        'Unverified legacy effect',
      );
      await second.checkpoint('failed', job.idempotencyKey);
      const source = { version: 1, chatId, messageId: 'source-message', userId };
      const laterAt = new Date(quiescedAt.getTime() + 7_200_000).toISOString();
      const blockedJobs: MaxActionJob[] = [
        {
          ...job,
          botId: `fixture-bot-${bots}`,
          idempotencyKey: `${job.idempotencyKey}-new-key`,
          createdAt: laterAt,
          ledgerContext: { moderationSource: source },
        },
        {
          ...job,
          actionType: 'SEND_MESSAGE',
          messageId: undefined,
          userId: undefined,
          botId: `fixture-bot-${bots}`,
          idempotencyKey: `${job.idempotencyKey}-other-rule`,
          createdAt: laterAt,
          ledgerContext: { moderationSource: { ...source, messageId: 'later-message' } },
        },
        {
          ...job,
          actionType: 'KICK_MEMBER',
          chatId: otherChatId,
          messageId: undefined,
          botId: `fixture-bot-${bots}`,
          idempotencyKey: `${job.idempotencyKey}-other-chat`,
          createdAt: laterAt,
        },
      ];
      for (const blocked of blockedJobs) {
        const replay = await queue.add('guarded-replay', blocked, {
          jobId: blocked.idempotencyKey,
          attempts: 1,
        });
        await expect(replay.waitUntilFinished(events, 15_000)).rejects.toThrow(
          'Unverified legacy effect',
        );
        await second.checkpoint('failed', blocked.idempotencyKey);
      }
      expect(second.messages.filter((message) => message.name === 'effect')).toHaveLength(0);
      expect(
        await prisma.maxActionLedgerEntry.count({
          where: { chatId: { in: [chatId, otherChatId] } },
        }),
      ).toBe(0);
      const holds = new WebhookLegacyHoldService(prisma as never);
      expect(await holds.isMessageHeld(chatId, 'source-message')).toBe(true);
      expect(await holds.isMemberHeld(chatId, userId)).toBe(true);
      expect(await holds.isGlobalUserHeld(userId)).toBe(true);
      expect(await holds.isOutboundJobHeld(job.idempotencyKey)).toBe(true);
      const independent: MaxActionJob = {
        ...job,
        actionType: 'SEND_MESSAGE',
        userId: undefined,
        messageId: undefined,
        idempotencyKey: `${job.idempotencyKey}-independent`,
        createdAt: laterAt,
      };
      const permitted = await queue.add('independent-publication', independent, {
        jobId: independent.idempotencyKey,
        attempts: 1,
      });
      await permitted.waitUntilFinished(events, 15_000);
      await second.checkpoint('effect', independent.idempotencyKey);
      await second.checkpoint('completed', independent.idempotencyKey);
      expect(second.messages.filter((message) => message.name === 'effect')).toHaveLength(1);
      expect(await holds.isGlobalUserHeld(userId)).toBe(true);
      expect((await second.stop()).code).toBe(0);
    },
  );
});
