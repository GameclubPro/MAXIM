import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { ConfigService } from '@nestjs/config';
import { Client } from 'pg';
import {
  ChatEntityType,
  ModerationDeleteIntentStatus,
  createPrismaAdapter,
  PrismaClient,
  type MessageRetentionCandidate,
} from '../src/prisma/prisma-client';
import { PrismaService } from '../src/prisma/prisma.service';
import { MessageRetentionStore } from '../src/message-retention/message-retention-store.service';
import { AdminMessageRetentionService } from '../src/admin/admin-message-retention.service';

const postgresUrl = process.env.MAXIM_TEST_POSTGRES_URL;
let localUrl: URL | null = null;
if (postgresUrl) {
  localUrl = new URL(postgresUrl);
  if (
    !['postgres:', 'postgresql:'].includes(localUrl.protocol) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(localUrl.hostname) ||
    localUrl.search ||
    localUrl.hash ||
    !/^\/[^/]+$/.test(localUrl.pathname)
  )
    throw new Error(
      'Retention lifecycle races require an explicit localhost database URL without options',
    );
  // FLAG: This suite never uses DATABASE_URL; all writes target a new private schema on loopback.
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
    } = {},
  ): Promise<MessageRetentionCandidate> {
    const status = options.status ?? 'pending';
    const active = status === 'pending' || status === 'retry';
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
    const candidate = await prisma.messageRetentionCandidate.create({
      data: {
        chatId: '-1',
        messageId: 'm',
        authorId: 'u',
        originBotId: 'bot',
        sourceAt: new Date(Date.now() - 25 * 3_600_000),
        activationId: options.activationId ?? 'current',
        status,
        intentId: options.attached === false ? null : 'i',
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

  async function reviewedInput() {
    const intent = await prisma.moderationDeleteIntent.findUniqueOrThrow({ where: { id: 'i' } });
    return {
      chatId: '-1',
      messageId: 'm',
      activationId: 'current',
      expectedRevision: 1,
      intentId: 'i',
      expectedIntentUpdatedAt: intent.updatedAt,
      expectedAttemptCount: intent.attemptCount,
      actorUserId: 'operator',
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

  it('settles six duplicate finish calls once under a real quota-lock race', async () => {
    const candidate = await seed();
    const settled = await race('quota', () =>
      Promise.all(Array.from({ length: 6 }, () => store.finish(candidate, 'deleted'))),
    );
    assert.equal(settled.filter(Boolean).length, 1);
    assert.deepEqual(await counts(), { pending: 0, quota: 0, deleted: 1, skipped: 0 });
  });

  it('reconciles cancellation racing with a successful worker without releasing credit twice', async () => {
    const candidate = await seed({ activationId: 'previous', intentStatus: 'SUCCEEDED' });
    await race('quota', () =>
      Promise.all([store.cancelInactive([candidate]), store.finish(candidate, 'deleted')]),
    );
    const current = await prisma.messageRetentionCandidate.findUniqueOrThrow({
      where: { chatId_messageId: { chatId: '-1', messageId: 'm' } },
    });
    if (current.reconcileAfter) await store.settleReconciliation(current, 'deleted');
    assert.deepEqual(await counts(), { pending: 0, quota: 0, deleted: 1, skipped: 0 });
  });

  it('refuses stale cancellation of the current activation', async () => {
    const candidate = await seed();
    assert.equal(await store.finish(candidate, 'cancelled'), false);
    await store.cancelInactive([candidate]);
    assert.deepEqual(await counts(), { pending: 1, quota: 1, deleted: 0, skipped: 0 });
  });

  it('keeps a producer-cancelled receipt schedulable with DELETE off', async () => {
    const candidate = await seed({ activationId: 'previous', intentStatus: 'AMBIGUOUS' });
    assert.equal(
      await store.finish(candidate, 'cancelled', { outcomeCode: 'cancelled', reconcile: true }),
      true,
    );
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
  it('keeps future ended receipts schedulable after the administrator disables a zero-credit policy', async () => {
    await seed({
      status: 'skipped',
      outcomeCode: 'reconciliation',
      reconcile: true,
      intentStatus: 'AMBIGUOUS',
    });
    await prisma.messageRetentionCandidate.update({
      where: { chatId_messageId: { chatId: '-1', messageId: 'm' } },
      data: { reconcileAfter: new Date(Date.now() + 60_000) },
    });
    await store.scheduleNext('-1');
    const service = new AdminMessageRetentionService(
      prisma as PrismaService,
      { assertChatAdminAccess: async () => undefined } as never,
      {
        assertChatSettingsBotCapabilities: async () => {
          throw new Error('Disabling must not perform a capability probe');
        },
      } as never,
      store,
      new ConfigService({ MAX_PUBLISHER_BOT_ID: 'publisher' }),
    );
    await service.update(
      '-1',
      { userId: 'operator', username: null, displayName: null, launchBotId: 'major' },
      { enabled: false, hours: 24, expectedRevision: 1 },
    );
    const policy = await prisma.messageRetentionPolicy.findUniqueOrThrow({
      where: { chatId: '-1' },
    });
    assert.equal(policy.enabled, false);
    assert.equal(policy.pendingCount, 0);
    assert.ok(policy.nextRunAt);
    // Advance only the receipt's deadline to demonstrate scheduler selection once it is due.
    await prisma.messageRetentionCandidate.update({
      where: { chatId_messageId: { chatId: '-1', messageId: 'm' } },
      data: { reconcileAfter: new Date(Date.now() - 1000) },
    });
    const offStore = new MessageRetentionStore(
      prisma as PrismaService,
      new ConfigService({ MESSAGE_RETENTION_MODE: 'off' }),
    );
    assert.equal(
      await prisma.messageRetentionPolicy.count({
        where: { nextRunAt: { lte: new Date() }, AND: [offStore.workSchedulingFilter()] },
      }),
      1,
    );
    assert.deepEqual(await counts(), { pending: 0, quota: 0, deleted: 0, skipped: 1 });
  });

  it('admits only one concurrent operator reopen with one atomic audit and credit', async () => {
    await seed({ status: 'skipped', outcomeCode: 'terminal_review' });
    const input = await reviewedInput();
    const changed = await race('intent', () =>
      Promise.all(Array.from({ length: 6 }, () => store.reopenTerminalCandidate(input))),
    );
    assert.equal(changed.filter(Boolean).length, 1);
    assert.deepEqual(await counts(), { pending: 1, quota: 1, deleted: 0, skipped: 0 });
    assert.equal(
      await prisma.auditLog.count({ where: { action: 'SAFETY_DESK_RETRY_MESSAGE_RETENTION' } }),
      1,
    );
    assert.equal(
      (await prisma.moderationDeleteIntent.findUniqueOrThrow({ where: { id: 'i' } })).status,
      'PENDING',
    );
  });

  it('rejects changed intent versions, dispatch evidence and exhausted admission capacity', async () => {
    await seed({ status: 'skipped', outcomeCode: 'terminal_review' });
    const input = await reviewedInput();
    assert.equal(
      await store.reopenTerminalCandidate({
        ...input,
        expectedAttemptCount: input.expectedAttemptCount + 1,
      }),
      false,
    );
    assert.equal(
      await store.reopenTerminalCandidate({ ...input, expectedIntentUpdatedAt: new Date(0) }),
      false,
    );
    await prisma.moderationDeleteIntent.update({
      where: { id: 'i' },
      data: { deleteDispatchStartedAt: new Date() },
    });
    assert.equal(await store.reopenTerminalCandidate(await reviewedInput()), false);
    await prisma.moderationDeleteIntent.update({
      where: { id: 'i' },
      data: { deleteDispatchStartedAt: null },
    });
    await prisma.messageRetentionQuota.update({
      where: { shard: 0 },
      data: { pendingCount: 50_000 },
    });
    assert.equal(await store.reopenTerminalCandidate(await reviewedInput()), false);
    assert.equal(await prisma.auditLog.count(), 0);
    assert.equal((await counts()).pending, 0);
  });

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

  it('keeps reopen and removal racing on the same receipt consistent', async () => {
    await seed({ status: 'skipped', outcomeCode: 'terminal_review' });
    const input = await reviewedInput();
    await race('intent', () =>
      Promise.all([
        store.reopenTerminalCandidate(input),
        prisma.$transaction((tx) =>
          store.settleRemovedMessage(tx, { chatId: '-1', messageId: 'm' }),
        ),
      ]),
    );
    assert.deepEqual(await counts(), { pending: 0, quota: 0, deleted: 1, skipped: 0 });
    assert.equal(
      (await prisma.moderationDeleteIntent.findUniqueOrThrow({ where: { id: 'i' } })).status,
      'ALREADY_ABSENT',
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

  it('resumes a healthy capacity-paused policy once during simultaneous visits', async () => {
    await prisma.messageRetentionPolicy.update({
      where: { chatId: '-1' },
      data: {
        pausedAt: new Date(Date.now() - 700_000),
        healthySince: new Date(Date.now() - 601_000),
      },
    });
    await race('quota', () =>
      Promise.all(Array.from({ length: 4 }, () => store.resumeAdmission('-1'))),
    );
    const policy = await prisma.messageRetentionPolicy.findUniqueOrThrow({
      where: { chatId: '-1' },
    });
    assert.equal(policy.pausedAt, null);
    assert.ok(policy.captureAfter);
    assert.equal(
      await prisma.auditLog.count({ where: { action: 'MESSAGE_RETENTION_INTAKE_RESUMED' } }),
      1,
    );
  });

  it('keeps current and old generations separately selectable and schedules recovery with the mode off', async () => {
    const candidate = await seed({ activationId: 'previous', intentStatus: 'AMBIGUOUS' });
    const policy = await prisma.messageRetentionPolicy.findUniqueOrThrow({
      where: { chatId: '-1' },
    });
    assert.deepEqual(
      (await store.dueCandidates(policy)).map((row) => row.messageId),
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
