import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { ConfigService } from '@nestjs/config';
import { Client } from 'pg';
import { Queue, Worker } from 'bullmq';
import Redis from 'ioredis';
import {
  ChatEntityType,
  ModerationDeleteIntentStatus,
  createPrismaAdapter,
  PrismaClient,
  type MessageRetentionCandidate,
} from '../src/prisma/prisma-client';
import { PrismaService } from '../src/prisma/prisma.service';
import { MessageRetentionStore } from '../src/message-retention/message-retention-store.service';
import {
  MessageRetentionRuntime,
  type MessageRetentionJob,
} from '../src/message-retention/message-retention-runtime.service';
import type { ModerationDeleteIntentService } from '../src/moderation/moderation-delete-intent.service';
import { MESSAGE_RETENTION_QUEUE } from '../src/message-retention/message-retention.policy';

const postgresUrl = process.env.MAXIM_TEST_POSTGRES_URL;
const redisUrl = process.env.MAXIM_TEST_REDIS_URL;
if (redisUrl) {
  const url = new URL(redisUrl);
  if (
    url.protocol !== 'redis:' ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.search ||
    url.hash
  )
    throw new Error(
      'Retention lifecycle queue tests require an explicit local Redis URL without options',
    );
}
let localUrl: URL | null = null;
if (postgresUrl) {
  localUrl = new URL(postgresUrl);
  if (
    !['postgres:', 'postgresql:'].includes(localUrl.protocol) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(localUrl.hostname) ||
    (localUrl.search !== '' && localUrl.search !== '?schema=public') ||
    localUrl.hash ||
    !/^\/[^/]+$/.test(localUrl.pathname)
  )
    throw new Error(
      'Retention lifecycle races require an explicit localhost URL with no options except schema=public',
    );
  // FLAG: This suite never uses DATABASE_URL; all writes target a new private schema on loopback.
  // The CI public-schema hint is discarded before opening the raw PostgreSQL connection.
  localUrl.search = '';
  localUrl.hostname = localUrl.hostname === '[::1]' ? '[::1]' : '127.0.0.1';
}

describe('retention production-store PostgreSQL lifecycle races', { skip: !localUrl }, () => {
  const schema = `retention_lifecycle_${randomUUID().replaceAll('-', '')}`;
  const applicationName = `retention-lifecycle-${randomUUID()}`;
  let db: Client;
  let prisma: PrismaClient;
  let store: MessageRetentionStore;

  before(async () => {
    db = new Client({
      connectionString: localUrl!.href,
      connectionTimeoutMillis: 3000,
      statement_timeout: 5000,
    });
    await db.connect();
    await db.query(
      `CREATE SCHEMA "${schema}"; SET search_path TO "${schema}"; SET TIME ZONE 'UTC'`,
    );
    // The surrounding fixture supplies only the intent/chat/audit dependencies.
    // Retention tables, constraints and indexes come from the production migrations.
    await db.query(`
      CREATE TYPE "ChatEntityType" AS ENUM (${Object.values(ChatEntityType)
        .map((value) => `'${value}'`)
        .join(',')});
      CREATE TYPE "ModerationDeleteIntentStatus" AS ENUM (${Object.values(
        ModerationDeleteIntentStatus,
      )
        .map((value) => `'${value}'`)
        .join(',')});
      CREATE TABLE chats (id TEXT PRIMARY KEY, entity_type "ChatEntityType" NOT NULL DEFAULT 'CHAT');
      CREATE TABLE audit_logs (id TEXT PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES chats(id),
        actor_user_id TEXT NOT NULL, action TEXT NOT NULL, payload JSONB NOT NULL, created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE moderation_delete_intents (
        id TEXT PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES chats(id), message_id TEXT NOT NULL,
        subject_user_id TEXT, source_message_at TIMESTAMP(3), entity_type "ChatEntityType", message_author_kind TEXT,
        origin_bot_id TEXT, routing_policy TEXT NOT NULL DEFAULT 'origin_only', suggestion_subscription_id TEXT,
        commercial_ocr_guard_required BOOLEAN NOT NULL DEFAULT FALSE, commercial_ocr_deadline_at TIMESTAMP(3),
        status "ModerationDeleteIntentStatus" NOT NULL DEFAULT 'PENDING', execute_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        next_attempt_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, retry_until_at TIMESTAMP(3) NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0, last_bot_id TEXT, succeeded_bot_id TEXT,
        delete_dispatch_started_at TIMESTAMP(3), delete_dispatch_started_bot_id TEXT,
        remote_delete_succeeded_at TIMESTAMP(3), remote_delete_succeeded_bot_id TEXT,
        candidate_failures JSONB NOT NULL DEFAULT '{}', last_status_code INTEGER, last_error_code TEXT, last_error TEXT,
        first_attempt_at TIMESTAMP(3), last_attempt_at TIMESTAMP(3), completed_at TIMESTAMP(3), absence_verified_at TIMESTAMP(3),
        absence_verified_bot_id TEXT, absence_verification_code TEXT, lease_token TEXT, lease_expires_at TIMESTAMP(3),
        leased_from_status "ModerationDeleteIntentStatus", created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT moderation_delete_intents_chat_message_key UNIQUE(chat_id,message_id));
      CREATE TABLE moderation_delete_intent_reasons (id TEXT PRIMARY KEY, intent_id TEXT NOT NULL REFERENCES moderation_delete_intents(id) ON DELETE CASCADE,
        rule_code TEXT NOT NULL);
    `);
    for (const name of [
      '20260920190000_add_message_retention',
      '20261002020000_add_retention_reconciliation',
      '20261002020100_index_retention_reconciliation',
    ]) {
      const sql = readFileSync(
        resolve(__dirname, '../prisma/migrations', name, 'migration.sql'),
        'utf8',
      );
      for (const statement of sql.replace(/^\s*--[^\n]*/gmu, '').split(';'))
        if (statement.trim()) await db.query(statement);
    }
    const scopedUrl = new URL(localUrl!.href);
    scopedUrl.searchParams.set('schema', schema);
    prisma = new PrismaClient({
      adapter: createPrismaAdapter(scopedUrl.href, {
        max: 8,
        statement_timeout: 5000,
        connectionTimeoutMillis: 3000,
        options: `-c search_path=${schema} -c lock_timeout=3000 -c timezone=UTC`,
        application_name: applicationName,
      }),
    });
    await prisma.$connect();
    store = new MessageRetentionStore(
      prisma as PrismaService,
      new ConfigService({ MESSAGE_RETENTION_MODE: 'on' }),
    );
  });

  beforeEach(async () => {
    await db.query(`TRUNCATE message_retention_candidates, message_retention_policies, moderation_delete_intent_reasons,
      moderation_delete_intents, audit_logs, chats CASCADE;
      UPDATE message_retention_quotas SET pending_count=0,paused_at=NULL,healthy_since=NULL;
      INSERT INTO chats(id) VALUES ('-1');
      INSERT INTO message_retention_policies(chat_id,enabled,hours,revision,activation_id,quota_shard)
      VALUES ('-1',TRUE,24,1,'current',0);`);
  });

  after(async () => {
    await prisma?.$disconnect();
    if (db) {
      try {
        await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      } finally {
        await db.end();
      }
    }
  });

  async function seed(
    options: {
      status?: 'pending' | 'retry' | 'skipped' | 'cancelled';
      activationId?: string;
      outcomeCode?: string | null;
      reconcile?: boolean;
      intentStatus?: ModerationDeleteIntentStatus;
      retentionOwned?: boolean;
      attached?: boolean;
      createIntent?: boolean;
      shadowOnly?: boolean;
    } = {},
  ): Promise<MessageRetentionCandidate> {
    const status = options.status ?? 'pending';
    const active = status === 'pending' || status === 'retry';
    const createIntent = options.createIntent !== false;
    if (createIntent) {
      await prisma.moderationDeleteIntent.create({
        data: {
          id: 'i',
          chatId: '-1',
          messageId: 'm',
          subjectUserId: 'u',
          entityType: 'CHAT',
          messageAuthorKind: 'user',
          originBotId: 'bot',
          retentionOwned: options.retentionOwned ?? true,
          status: options.intentStatus ?? 'FAILED_TERMINAL',
          retryUntilAt: new Date('9999-01-01T00:00:00.000Z'),
          attemptCount: 1,
        },
      });
      await db.query(
        "INSERT INTO moderation_delete_intent_reasons(id,intent_id,rule_code) VALUES ('reason','i','MESSAGE_RETENTION_DELETE')",
      );
    }
    const candidate = await prisma.messageRetentionCandidate.create({
      data: {
        chatId: '-1',
        messageId: 'm',
        authorId: 'u',
        originBotId: 'bot',
        sourceAt: new Date(Date.now() - 25 * 3_600_000),
        activationId: options.activationId ?? 'current',
        status,
        shadowOnly: options.shadowOnly ?? false,
        intentId: !createIntent || options.attached === false ? null : 'i',
        outcomeCode: options.outcomeCode ?? null,
        completedAt: active ? null : new Date(),
        reconcileAfter: options.reconcile ? new Date() : null,
      },
    });
    await prisma.messageRetentionPolicy.update({
      where: { chatId: '-1' },
      data: { pendingCount: active ? 1 : 0, skippedCount: active ? 0 : 1 },
    });
    await prisma.messageRetentionQuota.update({
      where: { shard: 0 },
      data: { pendingCount: active ? 1 : 0 },
    });
    return candidate;
  }

  async function counts() {
    const [policy, quota] = await Promise.all([
      prisma.messageRetentionPolicy.findUniqueOrThrow({ where: { chatId: '-1' } }),
      prisma.messageRetentionQuota.findUniqueOrThrow({ where: { shard: 0 } }),
    ]);
    return {
      pending: policy.pendingCount,
      quota: quota.pendingCount,
      deleted: policy.deletedCount,
      skipped: policy.skippedCount,
    };
  }

  function runtimeWithoutEffects(currentStore = store, queue = {} as Queue<MessageRetentionJob>) {
    let receiptCalls = 0;
    const deletes = {
      reconcileRetentionIntent: async () => {
        receiptCalls++;
        throw new Error('A stale current-generation job must not acquire any effect authority');
      },
    } satisfies Pick<ModerationDeleteIntentService, 'reconcileRetentionIntent'>;
    return {
      runtime: new MessageRetentionRuntime(
        prisma as PrismaService,
        currentStore,
        deletes as unknown as ModerationDeleteIntentService,
        {} as never,
        queue,
      ),
      receiptCalls: () => receiptCalls,
    };
  }

  async function waitForBlockedClient() {
    const deadline = Date.now() + 1500;
    while (Date.now() < deadline) {
      await db.query('SELECT pg_stat_clear_snapshot()');
      const result = await db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_locks lock
        JOIN pg_stat_activity backend ON backend.pid=lock.pid
        WHERE lock.granted=FALSE AND backend.application_name=$1`,
        [applicationName],
      );
      if (result.rows[0]!.n > 0) return;
      await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    }
    throw new Error('Concurrent store calls never reached the PostgreSQL row-lock barrier');
  }

  async function race<T>(
    lock: 'quota' | 'intent',
    work: () => Promise<T>,
    whileBlocked?: () => Promise<void>,
  ): Promise<T> {
    await db.query('BEGIN');
    await db.query(
      lock === 'quota'
        ? 'SELECT shard FROM message_retention_quotas WHERE shard=0 FOR UPDATE'
        : "SELECT id FROM moderation_delete_intents WHERE id='i' FOR UPDATE",
    );
    const pending = work();
    // Attach a handler while the deliberate SQL barrier is held, including a failing assertion.
    void pending.catch(() => undefined);
    try {
      await waitForBlockedClient();
      await whileBlocked?.();
      await db.query('COMMIT');
      return await pending;
    } catch (error) {
      await db.query('ROLLBACK');
      await Promise.allSettled([pending]);
      throw error;
    }
  }

  it('settles six duplicate authenticated receipts once under a real quota-lock race', async () => {
    await seed({ intentStatus: 'PENDING' });
    const settled = await race('quota', () =>
      Promise.all(
        Array.from({ length: 6 }, () =>
          prisma.$transaction((tx) =>
            store.settleRemovedMessage(tx, { chatId: '-1', messageId: 'm' }),
          ),
        ),
      ),
    );
    assert.equal(settled.filter(Boolean).length, 1);
    assert.deepEqual(await counts(), { pending: 0, quota: 0, deleted: 1, skipped: 0 });
  });

  it('reconciles cancellation racing with a saved successful receipt without releasing credit twice', async () => {
    const candidate = await seed({
      activationId: 'previous',
      intentStatus: 'SUCCEEDED',
      reconcile: true,
      outcomeCode: 'reconciliation',
    });
    await race('quota', () =>
      Promise.all([
        store.cancelInactive([candidate]),
        store.settleReconciliation(candidate, 'deleted'),
      ]),
    );
    const current = await prisma.messageRetentionCandidate.findUniqueOrThrow({
      where: { chatId_messageId: { chatId: '-1', messageId: 'm' } },
    });
    if (current.reconcileAfter) await store.settleReconciliation(current, 'deleted');
    assert.deepEqual(await counts(), { pending: 0, quota: 0, deleted: 1, skipped: 0 });
  });

  it('refuses stale cancellation and reconciliation of the current activation', async () => {
    const candidate = await seed({
      intentStatus: 'PENDING',
      reconcile: true,
      outcomeCode: 'reconciliation',
    });
    await store.settleReconciliation(candidate, 'cancelled');
    await store.cancelInactive([candidate]);
    const current = await prisma.messageRetentionCandidate.findUniqueOrThrow({
      where: { chatId_messageId: { chatId: '-1', messageId: 'm' } },
    });
    assert.equal(current.status, 'pending');
    assert.ok(current.reconcileAfter && current.reconcileAfter > candidate.reconcileAfter!);
    assert.deepEqual(await counts(), { pending: 1, quota: 1, deleted: 0, skipped: 0 });
  });

  it('keeps a producer-cancelled receipt schedulable with DELETE off', async () => {
    const candidate = await seed({ activationId: 'previous', intentStatus: 'AMBIGUOUS' });
    await store.cancelInactive([candidate]);
    await store.scheduleNext('-1');
    const offStore = new MessageRetentionStore(
      prisma as PrismaService,
      new ConfigService({ MESSAGE_RETENTION_MODE: 'off' }),
    );
    assert.equal((await offStore.diagnostics('-1')).hasUnresolvedReceipt, true);
    assert.equal(
      await prisma.messageRetentionPolicy.count({ where: offStore.workSchedulingFilter() }),
      1,
    );
    assert.deepEqual(await counts(), { pending: 0, quota: 0, deleted: 0, skipped: 1 });
  });
  it('admits only DB maintenance and selects completed generations without age-based execution', async () => {
    await seed({ createIntent: false });
    assert.equal(
      await prisma.messageRetentionPolicy.count({ where: store.workSchedulingFilter() }),
      1,
    );
    const policy = await prisma.messageRetentionPolicy.findUniqueOrThrow({
      where: { chatId: '-1' },
    });
    assert.deepEqual(await store.dueInactiveCandidates(policy), []);
    await prisma.messageRetentionPolicy.update({
      where: { chatId: '-1' },
      data: { enabled: false },
    });
    assert.equal(
      await prisma.messageRetentionPolicy.count({ where: store.workSchedulingFilter() }),
      1,
    );
    await store.cancelInactive(await store.dueInactiveCandidates({ ...policy, enabled: false }));
    await prisma.messageRetentionPolicy.update({
      where: { chatId: '-1' },
      data: { enabled: true },
    });
    await prisma.messageRetentionCandidate.update({
      where: { chatId_messageId: { chatId: '-1', messageId: 'm' } },
      data: { outcomeCode: 'reconciliation', reconcileAfter: new Date(Date.now() + 60_000) },
    });
    assert.equal(
      await prisma.messageRetentionPolicy.count({ where: store.workSchedulingFilter() }),
      0,
    );
    await prisma.messageRetentionCandidate.update({
      where: { chatId_messageId: { chatId: '-1', messageId: 'm' } },
      data: { reconcileAfter: new Date(Date.now() - 1_000) },
    });
    assert.equal(
      await prisma.messageRetentionPolicy.count({ where: store.workSchedulingFilter() }),
      1,
    );
    assert.deepEqual(await counts(), { pending: 0, quota: 0, deleted: 0, skipped: 1 });
  });
  it('keeps future ended receipts scheduled after a zero-credit policy is disabled', async () => {
    await seed({
      status: 'skipped',
      outcomeCode: 'reconciliation',
      reconcile: true,
      intentStatus: 'AMBIGUOUS',
    });
    const future = new Date(Date.now() + 60_000);
    await prisma.messageRetentionCandidate.update({
      where: { chatId_messageId: { chatId: '-1', messageId: 'm' } },
      data: { reconcileAfter: future },
    });
    await prisma.messageRetentionPolicy.update({
      where: { chatId: '-1' },
      data: { enabled: false },
    });
    await store.scheduleNext('-1');
    const policy = await prisma.messageRetentionPolicy.findUniqueOrThrow({
      where: { chatId: '-1' },
    });
    assert.equal(policy.nextRunAt?.getTime(), future.getTime());
    assert.deepEqual(await counts(), { pending: 0, quota: 0, deleted: 0, skipped: 1 });
    await prisma.messageRetentionCandidate.update({
      where: { chatId_messageId: { chatId: '-1', messageId: 'm' } },
      data: { reconcileAfter: new Date(Date.now() - 1000) },
    });
    await store.scheduleNext('-1');
    assert.equal(
      await prisma.messageRetentionPolicy.count({
        where: { nextRunAt: { lte: new Date() }, AND: [store.workSchedulingFilter()] },
      }),
      1,
    );
  });

  for (const mode of ['off', 'shadow', 'canary', 'on']) {
    for (const eraserEnabled of [false, true]) {
      it(`never creates or attempts history DELETE from a current legacy job with mode=${mode} and Lastik=${eraserEnabled}`, async () => {
        await seed({ createIntent: false, shadowOnly: mode === 'shadow' });
        const retired = new MessageRetentionStore(
          prisma as PrismaService,
          new ConfigService({
            MESSAGE_RETENTION_MODE: mode,
            MESSAGE_RETENTION_CANARY_CHAT_IDS: '-1',
            ERASER_ENABLED: eraserEnabled,
          }),
        );
        const visit = runtimeWithoutEffects(retired);
        await visit.runtime.process('-1');
        assert.equal(retired.allows('-1', true), false);
        assert.equal(visit.receiptCalls(), 0);
        assert.equal(await prisma.moderationDeleteIntent.count(), 0);
        assert.equal(await prisma.moderationDeleteIntentReason.count(), 0);
        assert.equal(await prisma.auditLog.count(), 0);
        assert.deepEqual(await counts(), { pending: 1, quota: 1, deleted: 0, skipped: 0 });
        assert.equal(
          (await prisma.messageRetentionPolicy.findUniqueOrThrow({ where: { chatId: '-1' } }))
            .nextRunAt,
          null,
        );
        assert.equal(
          (
            await prisma.messageRetentionCandidate.findUniqueOrThrow({
              where: { chatId_messageId: { chatId: '-1', messageId: 'm' } },
            })
          ).intentId,
          null,
        );
      });
    }
  }

  it(
    'executes a persisted stale BullMQ job against PostgreSQL without creating an intent or DELETE',
    { skip: !redisUrl, timeout: 15_000 },
    async () => {
      await seed({ createIntent: false });
      const prefix = `retired-retention-${randomUUID()}`;
      const redis = new Redis(redisUrl!, { maxRetriesPerRequest: null, connectTimeout: 3000 });
      const connection = {
        host: redis.options.host,
        port: redis.options.port,
        db: redis.options.db,
        username: redis.options.username,
        password: redis.options.password,
        tls: redis.options.tls,
        maxRetriesPerRequest: null,
      };
      const queue = new Queue<MessageRetentionJob>(MESSAGE_RETENTION_QUEUE, { connection, prefix });
      const retired = new MessageRetentionStore(
        prisma as PrismaService,
        new ConfigService({ MESSAGE_RETENTION_MODE: 'on', ERASER_ENABLED: false }),
      );
      const visit = runtimeWithoutEffects(retired, queue);
      let completed!: () => void;
      let failed!: (error: Error) => void;
      const completion = new Promise<void>((resolveDone, rejectDone) => {
        completed = resolveDone;
        failed = rejectDone;
      });
      void completion.catch(() => undefined);
      let worker: Worker<MessageRetentionJob> | undefined;
      const deadline = setTimeout(
        () => failed(new Error('Stale BullMQ job was not completed')),
        10_000,
      );
      try {
        await queue.waitUntilReady();
        await queue.add(
          'chat',
          { chatId: '-1' },
          { jobId: 'stale-major-history', attempts: 1, removeOnComplete: true, removeOnFail: true },
        );
        assert.equal(await queue.getWaitingCount(), 1);
        // FLAG: Start the retired executor only after an old-shaped job is durable in Redis.
        worker = new Worker<MessageRetentionJob>(
          MESSAGE_RETENTION_QUEUE,
          async (job) => visit.runtime.process(job.data.chatId),
          { connection, prefix },
        );
        worker.on('completed', () => completed());
        worker.on('failed', (_job, error) => failed(error));
        worker.on('error', failed);
        await completion;
        assert.equal(visit.receiptCalls(), 0);
        assert.equal(await prisma.moderationDeleteIntent.count(), 0);
        assert.equal(await prisma.moderationDeleteIntentReason.count(), 0);
        assert.deepEqual(await counts(), { pending: 1, quota: 1, deleted: 0, skipped: 0 });
      } finally {
        clearTimeout(deadline);
        await worker?.close();
        await visit.runtime.onModuleDestroy();
        // FLAG: Only this fixture's random BullMQ namespace may be removed.
        await queue.obliterate({ force: true });
        await queue.close();
        await redis.quit();
      }
    },
  );

  for (const disabled of [false, true]) {
    it(`cancels inactive SQL credit once during concurrent maintenance with disabled=${disabled}`, async () => {
      await seed({ createIntent: false, activationId: disabled ? 'current' : 'previous' });
      if (disabled)
        await prisma.messageRetentionPolicy.update({
          where: { chatId: '-1' },
          data: { enabled: false },
        });
      const visit = runtimeWithoutEffects();
      await race('quota', () =>
        Promise.all(Array.from({ length: 4 }, () => visit.runtime.process('-1'))),
      );
      await visit.runtime.process('-1');
      assert.equal(visit.receiptCalls(), 0);
      assert.equal(await prisma.moderationDeleteIntent.count(), 0);
      assert.deepEqual(await counts(), { pending: 0, quota: 0, deleted: 0, skipped: 1 });
      const candidate = await prisma.messageRetentionCandidate.findUniqueOrThrow({
        where: { chatId_messageId: { chatId: '-1', messageId: 'm' } },
      });
      assert.equal(candidate.status, 'cancelled');
      assert.equal(candidate.reconcileAfter, null);
      assert.equal(
        (await prisma.messageRetentionPolicy.findUniqueOrThrow({ where: { chatId: '-1' } }))
          .nextRunAt,
        null,
      );
    });
  }

  it('settles duplicate authenticated removal events once while preserving an independent intent', async () => {
    await seed({ intentStatus: 'PENDING', retentionOwned: false });
    const changed = await race('intent', () =>
      Promise.all(
        Array.from({ length: 4 }, () =>
          prisma.$transaction((tx) =>
            store.settleRemovedMessage(tx, { chatId: '-1', messageId: 'm' }),
          ),
        ),
      ),
    );
    assert.equal(changed.filter(Boolean).length, 1);
    assert.deepEqual(await counts(), { pending: 0, quota: 0, deleted: 1, skipped: 0 });
    assert.equal(
      (await prisma.moderationDeleteIntent.findUniqueOrThrow({ where: { id: 'i' } })).status,
      'PENDING',
    );
  });

  it('corrects two simultaneous ended success receipts once with zero active credit', async () => {
    const candidate = await seed({
      status: 'cancelled',
      reconcile: true,
      outcomeCode: 'reconciliation',
      intentStatus: 'SUCCEEDED',
    });
    await Promise.all(
      Array.from({ length: 4 }, () => store.settleReconciliation(candidate, 'deleted')),
    );
    assert.deepEqual(await counts(), { pending: 0, quota: 0, deleted: 1, skipped: 0 });
  });

  for (const status of ['pending', 'retry', 'cancelled'] as const) {
    it(`preserves ${status} accounting when an execution claim precedes stale marker-free cancellation`, async () => {
      const candidate = await seed({ status, reconcile: true, outcomeCode: 'reconciliation' });
      const before = await counts();
      await race(
        'intent',
        () => store.settleReconciliation(candidate, 'cancelled'),
        async () => {
          await db.query(`UPDATE moderation_delete_intents SET status='IN_PROGRESS',
            lease_token='execution',lease_expires_at=CURRENT_TIMESTAMP+INTERVAL '1 minute' WHERE id='i'`);
        },
      );
      const current = await prisma.messageRetentionCandidate.findUniqueOrThrow({
        where: { chatId_messageId: { chatId: '-1', messageId: 'm' } },
      });
      assert.equal(current.status, status);
      assert.equal(current.outcomeCode, 'reconciliation');
      assert.ok(current.reconcileAfter && current.reconcileAfter > candidate.reconcileAfter!);
      assert.deepEqual(await counts(), before);
    });
  }

  for (const marker of [
    'delete_dispatch_started_at',
    'delete_dispatch_started_bot_id',
    'remote_delete_succeeded_at',
    'remote_delete_succeeded_bot_id',
  ]) {
    it(`retains recovery when ${marker} appears before stale cancellation gets its intent lock`, async () => {
      const candidate = await seed({
        status: 'cancelled',
        reconcile: true,
        outcomeCode: 'reconciliation',
      });
      await race(
        'intent',
        () => store.settleReconciliation(candidate, 'cancelled'),
        async () => {
          const value = marker.endsWith('_at') ? 'CURRENT_TIMESTAMP' : "'bot'";
          await db.query(`UPDATE moderation_delete_intents SET ${marker}=${value} WHERE id='i'`);
        },
      );
      const current = await prisma.messageRetentionCandidate.findUniqueOrThrow({
        where: { chatId_messageId: { chatId: '-1', messageId: 'm' } },
      });
      assert.equal(current.status, 'cancelled');
      assert.equal(current.outcomeCode, 'reconciliation');
      assert.ok(current.reconcileAfter && current.reconcileAfter > candidate.reconcileAfter!);
      assert.deepEqual(await counts(), { pending: 0, quota: 0, deleted: 0, skipped: 1 });
    });
  }

  for (const status of ['pending', 'cancelled'] as const) {
    it(`corrects stale terminal settlement once when a success precedes the ${status} receipt lock`, async () => {
      const candidate = await seed({ status, reconcile: true, outcomeCode: 'reconciliation' });
      await race(
        'intent',
        () =>
          Promise.all([
            store.settleReconciliation(candidate, 'cancelled'),
            store.settleReconciliation(candidate, 'terminal_review'),
          ]),
        async () => {
          await db.query(`UPDATE moderation_delete_intents SET status='SUCCEEDED',
            remote_delete_succeeded_at=CURRENT_TIMESTAMP,remote_delete_succeeded_bot_id='bot' WHERE id='i'`);
        },
      );
      await store.settleReconciliation(candidate, 'cancelled');
      const current = await prisma.messageRetentionCandidate.findUniqueOrThrow({
        where: { chatId_messageId: { chatId: '-1', messageId: 'm' } },
      });
      assert.equal(current.status, 'deleted');
      assert.equal(current.outcomeCode, 'deleted');
      assert.equal(current.reconcileAfter, null);
      assert.deepEqual(await counts(), { pending: 0, quota: 0, deleted: 1, skipped: 0 });
    });
  }

  it('keeps cancellation reconciliation racing with a removal event consistent', async () => {
    const candidate = await seed({
      status: 'cancelled',
      reconcile: true,
      outcomeCode: 'reconciliation',
      intentStatus: 'SUCCEEDED',
    });
    await race('quota', () =>
      Promise.all([
        store.settleReconciliation(candidate, 'deleted'),
        prisma.$transaction((tx) =>
          store.settleRemovedMessage(tx, { chatId: '-1', messageId: 'm' }),
        ),
      ]),
    );
    assert.deepEqual(await counts(), { pending: 0, quota: 0, deleted: 1, skipped: 0 });
    assert.equal(
      (
        await prisma.messageRetentionCandidate.findUniqueOrThrow({
          where: { chatId_messageId: { chatId: '-1', messageId: 'm' } },
        })
      ).reconcileAfter,
      null,
    );
  });

  it('rolls back an authenticated receipt when its intent binding changes before the quota lock', async () => {
    await seed({ attached: false, intentStatus: 'PENDING' });
    await db.query('BEGIN');
    await db.query('SELECT shard FROM message_retention_quotas WHERE shard=0 FOR UPDATE');
    const pending = prisma.$transaction((tx) =>
      store.settleRemovedMessage(tx, { chatId: '-1', messageId: 'm' }),
    );
    void pending.catch(() => undefined);
    try {
      await waitForBlockedClient();
      await db.query(
        "UPDATE message_retention_candidates SET intent_id='i' WHERE chat_id='-1' AND message_id='m'",
      );
      await db.query('COMMIT');
      await assert.rejects(pending, /Retention receipt binding changed/);
    } finally {
      await db.query('ROLLBACK');
      await Promise.allSettled([pending]);
    }
    assert.deepEqual(await counts(), { pending: 1, quota: 1, deleted: 0, skipped: 0 });
    assert.equal(
      (await prisma.moderationDeleteIntent.findUniqueOrThrow({ where: { id: 'i' } })).status,
      'PENDING',
    );
  });

  it('never resumes legacy intake or clears its saved pause during concurrent maintenance', async () => {
    await seed({ createIntent: false });
    const pausedAt = new Date(Date.now() - 700_000);
    const healthySince = new Date(Date.now() - 601_000);
    await prisma.messageRetentionPolicy.update({
      where: { chatId: '-1' },
      data: { pausedAt, healthySince },
    });
    const visit = runtimeWithoutEffects();
    await Promise.all(Array.from({ length: 4 }, () => visit.runtime.process('-1')));
    const policy = await prisma.messageRetentionPolicy.findUniqueOrThrow({
      where: { chatId: '-1' },
    });
    assert.equal(policy.pausedAt?.getTime(), pausedAt.getTime());
    assert.equal(policy.healthySince?.getTime(), healthySince.getTime());
    assert.equal(policy.captureAfter, null);
    assert.equal(await prisma.auditLog.count(), 0);
    assert.equal(await prisma.moderationDeleteIntent.count(), 0);
    assert.equal(visit.receiptCalls(), 0);
    assert.deepEqual(await counts(), { pending: 1, quota: 1, deleted: 0, skipped: 0 });
  });

  it('keeps current and old generations separately selectable and schedules recovery with the mode off', async () => {
    const candidate = await seed({ activationId: 'previous', intentStatus: 'AMBIGUOUS' });
    const policy = await prisma.messageRetentionPolicy.findUniqueOrThrow({
      where: { chatId: '-1' },
    });
    assert.deepEqual(
      (await store.dueInactiveCandidates(policy)).map((row) => row.messageId),
      ['m'],
    );
    await store.cancelInactive([candidate]);
    await store.scheduleNext('-1');
    const offStore = new MessageRetentionStore(
      prisma as PrismaService,
      new ConfigService({ MESSAGE_RETENTION_MODE: 'off' }),
    );
    const policies = await prisma.messageRetentionPolicy.findMany({
      where: { nextRunAt: { lte: new Date() }, AND: [offStore.workSchedulingFilter()] },
    });
    assert.deepEqual(
      policies.map((row) => row.chatId),
      ['-1'],
    );
    assert.equal((await offStore.diagnostics('-1')).hasUnresolvedReceipt, true);
    assert.deepEqual(await counts(), { pending: 0, quota: 0, deleted: 0, skipped: 1 });
  });
});
