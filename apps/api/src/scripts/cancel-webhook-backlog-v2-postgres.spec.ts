import { randomUUID } from 'node:crypto';
import { Queue, type ConnectionOptions } from 'bullmq';
import { Redis } from 'ioredis';
import { Prisma, createPrismaClient } from '../prisma/prisma-client';
import type { MaxActionJob } from '../max/max-client.service';
import { buildWebhookSemanticEventKey } from '../webhook/webhook-semantic-event-key';
import { materializeBacklogCancellation } from '../webhook/webhook-backlog-cancellation';
import { backlogJobSnapshot } from './cancel-webhook-backlog';
import {
  previewTargetedBacklogCancellation,
  preflightTargetedBacklogCancellation,
  proveTargetedBacklogCancellationAbsent,
  applyTargetedBacklogCancellation,
} from './cancel-webhook-backlog-v2';
import {
  backlogCancellationDigestV2,
  type BacklogCancellationNominationV2,
  type BacklogCancellationPreviewV2,
} from './cancel-webhook-backlog-v2.contract';

function recordNativeEvidence(value: unknown): void {
  process.stdout.write(`${typeof value === 'string' ? value : JSON.stringify(value)}\n`);
}

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL ?? '';
const redisUrl = process.env.MAXIM_TEST_REDIS_URL ?? '';
const native = databaseUrl && redisUrl ? describe : describe.skip;
const bindings = { runtimeDigest: 'c'.repeat(64), clientSha256: 'd'.repeat(64) };
jest.setTimeout(240_000);

type RootFixture = Awaited<
  ReturnType<ReturnType<typeof createPrismaClient>['webhookEvent']['create']>
>;

native('exact cancellation v2 with native PostgreSQL and Redis', () => {
  let db: ReturnType<typeof createPrismaClient>, redis: Redis;
  const ownedJobs: Array<{ queue: string; id: string }> = [];
  const ownedReceiptIds = new Set<string>();
  const queueHandles = new Map<string, Queue>();
  beforeAll(async () => {
    if (
      !['localhost', '127.0.0.1'].includes(new URL(databaseUrl).hostname) ||
      !new URL(databaseUrl).pathname.includes('race_test') ||
      !['localhost', '127.0.0.1'].includes(new URL(redisUrl).hostname)
    )
      throw new Error('Disposable stores required');
    db = createPrismaClient(databaseUrl, {
      max: 2,
      options: '-c timezone=UTC -c statement_timeout=5000',
    });
    redis = new Redis(redisUrl, { maxRetriesPerRequest: 1 });
    await redis.ping();
  });
  afterEach(async () => {
    // These are exact fixture jobs in disposable stores, never a queue-wide cleanup.
    for (const { queue, id } of ownedJobs.splice(0)) {
      await redis.lrem(`bull:${queue}:wait`, 0, id);
      await redis.lrem(`bull:${queue}:active`, 0, id);
      await redis.lrem(`bull:${queue}:paused`, 0, id);
      for (const state of ['delayed', 'prioritized', 'failed'])
        await redis.zrem(`bull:${queue}:${state}`, id);
      await redis.del(
        `bull:${queue}:${id}`,
        `bull:${queue}:${id}:lock`,
        `bull:${queue}:${id}:logs`,
      );
    }
    await cleanupOwnedReceipts();
  });
  afterAll(async () => {
    await Promise.all([...queueHandles.values()].map((queue) => queue.close()));
    await redis?.quit();
    await db?.$disconnect();
  });

  function ownReceiptId(id: string = randomUUID()): string {
    ownedReceiptIds.add(id);
    return id;
  }

  async function cleanupOwnedReceipts(): Promise<void> {
    const ids = [...ownedReceiptIds];
    if (!ids.length) return;
    await db.$transaction(async (tx) => {
      const rows = await tx.webhookEvent.findMany({
        where: { id: { in: ids } },
        orderBy: { id: 'asc' },
      });
      const claims = await tx.webhookExecutionClaim.findMany({
        where: { webhookEventId: { in: ids } },
        orderBy: { id: 'asc' },
      });
      const semanticKeys = [
        ...new Set([
          ...rows.flatMap((row) => (row.semanticKey ? [row.semanticKey] : [])),
          ...claims.map((claim) => claim.semanticKey),
        ]),
      ];
      const proofWhere = {
        OR: [{ receiptId: { in: ids } }, { semanticKey: { in: semanticKeys } }],
      };
      const proofs = await tx.webhookBacklogReceipt.findMany({
        where: proofWhere,
        orderBy: { receiptId: 'asc' },
      });
      const pinnedIds = new Set(proofs.map((proof) => proof.receiptId));
      const pinnedKeys = new Set(proofs.map((proof) => proof.semanticKey));
      for (const claim of claims)
        if (claim.webhookEventId && pinnedKeys.has(claim.semanticKey))
          pinnedIds.add(claim.webhookEventId);
      for (const row of rows)
        if (
          (row.semanticKey && pinnedKeys.has(row.semanticKey)) ||
          row.status === 'CANCELLED' ||
          row.sourceDispositionId ||
          row.legacyDispositionId
        )
          pinnedIds.add(row.id);
      const removableIds = rows.filter((row) => !pinnedIds.has(row.id)).map((row) => row.id);
      // FLAG: Only ordinary exact-owned fixtures may be removed. Captured, semantic-peer,
      // cancelled and projected evidence survives until the disposable database is dropped.
      await tx.webhookExecutionClaim.deleteMany({
        where: { webhookEventId: { in: removableIds } },
      });
      await tx.webhookEvent.deleteMany({ where: { id: { in: removableIds } } });
      expect(
        await tx.webhookEvent.findMany({
          where: { id: { in: ids } },
          orderBy: { id: 'asc' },
        }),
      ).toEqual(rows.filter((row) => pinnedIds.has(row.id)));
      expect(
        await tx.webhookExecutionClaim.findMany({
          where: { webhookEventId: { in: ids } },
          orderBy: { id: 'asc' },
        }),
      ).toEqual(
        claims.filter((claim) => claim.webhookEventId && pinnedIds.has(claim.webhookEventId)),
      );
      expect(
        await tx.webhookBacklogReceipt.findMany({
          where: proofWhere,
          orderBy: { receiptId: 'asc' },
        }),
      ).toEqual(proofs);
    });
    ownedReceiptIds.clear();
  }

  async function root(count = 1): Promise<RootFixture[]> {
    const at = new Date(Date.now() - 600_000);
    const prefix = randomUUID();
    const rows = Array.from({ length: count }, (_, i) => {
      const id = ownReceiptId(`${prefix}-${String(i).padStart(3, '0')}`);
      const update = {
        type: 'message_created' as const,
        updateId: id,
        timestamp: at.toISOString(),
        botId: 'fixture',
        message: {
          chatId: `-${id}`,
          messageId: id,
          senderId: 'fixture-user',
          text: 'fixture only',
        },
      };
      return {
        id,
        dedupKey: id,
        createdAt: at,
        status: 'FAILED' as const,
        errorMessage: 'WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINED:uncertain',
        semanticKey: buildWebhookSemanticEventKey(update),
        rawPayload: update,
        normalizedPayload: update,
      };
    });
    await db.webhookEvent.createMany({ data: rows });
    await db.webhookExecutionClaim.createMany({
      data: rows.map((row) => ({
        kind: 'EXECUTION',
        semanticKey: row.semanticKey!,
        webhookEventId: row.id,
        status: 'READY',
        enforced: true,
        preparedAt: at,
        businessStartedAt: at,
      })),
    });
    return db.webhookEvent.findMany({
      where: { id: { in: rows.map((row) => row.id) } },
      orderBy: { id: 'asc' },
    });
  }
  function nomination(rows: RootFixture[]): BacklogCancellationNominationV2 {
    return {
      version: 2,
      id: randomUUID(),
      cutoff: new Date(Date.now() - 60_000).toISOString(),
      sourceSha: 'a'.repeat(40),
      imageId: `sha256:${'b'.repeat(64)}`,
      rootIds: rows.map((row) => row.id).sort(),
    };
  }
  function applyRequest(n: BacklogCancellationNominationV2, preview: BacklogCancellationPreviewV2) {
    return {
      version: 2 as const,
      id: n.id,
      cutoff: n.cutoff,
      sourceSha: n.sourceSha,
      imageId: n.imageId,
      previewSha256: backlogCancellationDigestV2(preview),
    };
  }
  function source(row: RootFixture) {
    const update = row.normalizedPayload as { message: { chatId: string; messageId: string } };
    return { chatId: update.message.chatId, messageId: update.message.messageId };
  }
  function action(row: RootFixture, patch: Partial<MaxActionJob> = {}): MaxActionJob {
    const identity = source(row);
    return {
      actionType: 'SEND_MESSAGE',
      chatId: identity.chatId,
      text: 'fixture',
      attempt: 0,
      idempotencyKey: randomUUID(),
      createdAt: row.createdAt.toISOString(),
      ledgerContext: { moderationSource: { version: 1, ...identity, userId: 'fixture-user' } },
      ...patch,
    };
  }
  async function job(
    queueName: string,
    data: Record<string, unknown> | MaxActionJob,
    id: string = randomUUID(),
    opts: Record<string, unknown> = {},
  ) {
    let queue = queueHandles.get(queueName);
    if (!queue) {
      queue = new Queue(queueName, {
        connection: redis as unknown as ConnectionOptions,
        skipMetasUpdate: true,
      });
      queueHandles.set(queueName, queue);
    }
    await queue.add('fixture', data, { ...opts, jobId: id });
    ownedJobs.push({ queue: queueName, id });
    return id;
  }
  async function preview(n: BacklogCancellationNominationV2) {
    const result = await previewTargetedBacklogCancellation(db, redis, n, bindings);
    expect(result.issues).toEqual([]);
    expect(result.decision).toBe('READY');
    expect(result.complete).toBe(true);
    return result;
  }
  async function redisSnapshot() {
    const keys = (await redis.keys('bull:*')).sort();
    return Promise.all(
      keys.map(async (key) => {
        const type = await redis.type(key);
        if (type === 'hash')
          return [
            key,
            type,
            Object.entries(await redis.hgetall(key)).sort(([a], [b]) =>
              a < b ? -1 : a > b ? 1 : 0,
            ),
          ];
        if (type === 'list') return [key, type, await redis.lrange(key, 0, -1)];
        if (type === 'zset') return [key, type, await redis.zrange(key, 0, -1, 'WITHSCORES')];
        if (type === 'stream') return [key, type, await redis.xrange(key, '-', '+')];
        if (type === 'string') return [key, type, await redis.get(key)];
        if (type === 'set') return [key, type, (await redis.smembers(key)).sort()];
        throw new Error('Unsupported fixture Redis type');
      }),
    );
  }
  async function rawHashSnapshot(key: string) {
    const values: unknown = await redis.callBuffer(
      'EVAL',
      "return redis.call('HGETALL',KEYS[1])",
      1,
      key,
    );
    if (!Array.isArray(values) || values.length % 2 || !values.every(Buffer.isBuffer))
      throw new Error('Invalid fixture hash response');
    const pairs: Array<[string, string]> = [];
    for (let at = 0; at < values.length; at += 2)
      pairs.push([
        (values[at] as Buffer).toString('hex'),
        (values[at + 1] as Buffer).toString('hex'),
      ]);
    return pairs.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  }

  it('removes only ordinary owned fixtures and retains captured and semantic-pinned evidence', async () => {
    const [ordinary, received, cancelled, captured] = await root(4);
    await db.webhookEvent.update({
      where: { id: received!.id },
      data: { status: 'RECEIVED' },
    });
    await db.webhookExecutionClaim.create({
      data: {
        kind: 'METADATA',
        semanticKey: received!.semanticKey!,
        webhookEventId: received!.id,
      },
    });
    const sealed = nomination([cancelled!]),
      sealedJob = await job('moderation-actions', action(cancelled!)),
      sealedPreview = await preview(sealed);
    expect(
      (
        await applyTargetedBacklogCancellation(
          db,
          redis,
          sealed,
          applyRequest(sealed, sealedPreview),
          sealedPreview,
          bindings,
        )
      ).outcome,
    ).toBe('APPLIED');
    expect(await redis.exists(`bull:moderation-actions:${sealedJob}`)).toBe(0);
    const unsealed = nomination([captured!]),
      unsealedPreview = await preview(unsealed);
    const interrupted = await applyTargetedBacklogCancellation(
      db,
      redis,
      unsealed,
      applyRequest(unsealed, unsealedPreview),
      unsealedPreview,
      bindings,
      (value) => {
        if (value.phase === 'RECEIPTS_CAPTURED') throw new Error('fixture interruption');
      },
    );
    expect(interrupted.outcome).toBe('INCOMPLETE_WRITTEN');
    expect(interrupted.sealed).toBe(false);
    const peer = await db.webhookEvent.create({
      data: {
        id: ownReceiptId(),
        dedupKey: randomUUID(),
        semanticKey: cancelled!.semanticKey,
        rawPayload: cancelled!.rawPayload as Prisma.InputJsonValue,
        normalizedPayload: cancelled!.normalizedPayload as Prisma.InputJsonValue,
        status: 'PROCESSED',
        processedAt: new Date(),
      },
    });
    await db.webhookExecutionClaim.create({
      data: {
        kind: 'METADATA',
        semanticKey: cancelled!.semanticKey!,
        webhookEventId: peer.id,
      },
    });
    const sentinel = await db.webhookEvent.create({
      data: {
        dedupKey: randomUUID(),
        rawPayload: { type: 'fixture_unowned' },
        normalizedPayload: { type: 'fixture_unowned' },
      },
    });
    try {
      const sentinelClaim = await db.webhookExecutionClaim.create({
        data: {
          kind: 'METADATA',
          semanticKey: randomUUID(),
          webhookEventId: sentinel.id,
        },
      });
      const pinnedIds = [cancelled!.id, captured!.id, peer.id];
      const pinnedRows = await db.webhookEvent.findMany({
        where: { id: { in: pinnedIds } },
        orderBy: { id: 'asc' },
      });
      const pinnedClaims = await db.webhookExecutionClaim.findMany({
        where: { webhookEventId: { in: pinnedIds } },
        orderBy: { id: 'asc' },
      });
      const proofState = async () => ({
        operations: await db.webhookBacklogCancellation.findMany({
          where: { id: { in: [sealed.id, unsealed.id] } },
          orderBy: { id: 'asc' },
        }),
        receipts: await db.webhookBacklogReceipt.findMany({
          where: { cancellationId: { in: [sealed.id, unsealed.id] } },
          orderBy: { receiptId: 'asc' },
        }),
        children: await db.webhookBacklogChild.findMany({
          where: { cancellationId: { in: [sealed.id, unsealed.id] } },
          orderBy: [{ kind: 'asc' }, { childKey: 'asc' }],
        }),
      });
      const proofBefore = await proofState();
      expect(pinnedRows.find((row) => row.id === cancelled!.id)?.status).toBe('CANCELLED');
      expect(pinnedRows.find((row) => row.id === captured!.id)?.status).toBe('FAILED');
      expect(proofBefore.receipts.map((proof) => proof.receiptId).sort()).toEqual(
        [cancelled!.id, captured!.id].sort(),
      );
      await cleanupOwnedReceipts();
      expect(
        await db.webhookEvent.findMany({ where: { id: { in: [ordinary!.id, received!.id] } } }),
      ).toEqual([]);
      expect(
        await db.webhookExecutionClaim.findMany({
          where: { webhookEventId: { in: [ordinary!.id, received!.id] } },
        }),
      ).toEqual([]);
      expect(
        await db.webhookEvent.findMany({
          where: { id: { in: pinnedIds } },
          orderBy: { id: 'asc' },
        }),
      ).toEqual(pinnedRows);
      expect(
        await db.webhookExecutionClaim.findMany({
          where: { webhookEventId: { in: pinnedIds } },
          orderBy: { id: 'asc' },
        }),
      ).toEqual(pinnedClaims);
      expect(await proofState()).toEqual(proofBefore);
      expect(await db.webhookEvent.findUniqueOrThrow({ where: { id: sentinel.id } })).toEqual(
        sentinel,
      );
      expect(
        await db.webhookExecutionClaim.findUniqueOrThrow({ where: { id: sentinelClaim.id } }),
      ).toEqual(sentinelClaim);
    } finally {
      await db.webhookExecutionClaim.deleteMany({ where: { webhookEventId: sentinel.id } });
      await db.webhookEvent.deleteMany({ where: { id: sentinel.id } });
    }
  });

  it('previews mixed queues read-only and preserves unselected, reply-only, publication and timed work', async () => {
    const [selected, other] = await root(2);
    const n = nomination([selected!]);
    const send = action(selected!);
    const selectedWebhook = await job('moderation', { webhookEventId: selected!.id }, 'Root.Z');
    const selectedSend = await job('moderation-actions', send, 'Action-a');
    const reply = await job(
      'moderation-actions',
      action(selected!, {
        idempotencyKey: randomUUID(),
        ledgerContext: undefined,
        options: { messageLink: { type: 'reply', mid: source(selected!).messageId } },
      }),
    );
    const publication = await job(
      'moderation-actions',
      action(selected!, { sourceTag: 'managed_broadcast' }),
    );
    const timed = await job('moderation-actions', action(selected!), randomUUID(), {
      delay: 60_000,
    });
    const unrelated = await job('moderation', { webhookEventId: other!.id });
    const old = await db.webhookEvent.findMany({ where: { id: { in: n.rootIds } } });
    const claims = await db.webhookExecutionClaim.findMany({
      where: { webhookEventId: { in: n.rootIds } },
    });
    const before = await redisSnapshot();
    const commands: string[] = [];
    const healthcheck = redis.duplicate();
    let monitor: Redis | undefined;
    let p: BacklogCancellationPreviewV2;
    try {
      await healthcheck.ping();
      monitor = await redis.monitor();
      monitor.on('monitor', (_time, args: string[]) => commands.push(args[0]!.toLowerCase()));
      // FLAG: MONITOR includes independent clients, including the CI Redis healthcheck.
      await healthcheck.ping();
      p = await preview(n);
    } finally {
      monitor?.removeAllListeners('monitor');
      monitor?.disconnect();
      await healthcheck.quit();
    }
    expect(commands.length).toBeGreaterThan(0);
    expect(commands).toContain('ping');
    expect(commands).toContain('eval');
    expect(
      commands.filter(
        (command) =>
          ![
            'ping',
            'eval',
            'type',
            'lrange',
            'zrange',
            'hlen',
            'hkeys',
            'hstrlen',
            'hgetall',
            'exists',
          ].includes(command),
      ),
    ).toEqual([]);
    expect(p.children.map((row) => row.jobId).sort()).toEqual(
      [selectedWebhook, selectedSend].sort(),
    );
    expect(p.children.map((row) => row.queue)).toEqual(['moderation', 'moderation-actions']);
    expect(p.retained.protectedJobs).toBeGreaterThanOrEqual(2);
    expect(await redisSnapshot()).toEqual(before);
    expect(await db.webhookBacklogCancellation.findUnique({ where: { id: n.id } })).toBeNull();
    expect(await db.webhookEvent.findMany({ where: { id: { in: n.rootIds } } })).toEqual(old);
    expect(
      await db.webhookExecutionClaim.findMany({ where: { webhookEventId: { in: n.rootIds } } }),
    ).toEqual(claims);
    const req = applyRequest(n, p);
    expect((await preflightTargetedBacklogCancellation(db, n, req, p, bindings)).valid).toBe(true);
    const result = await applyTargetedBacklogCancellation(db, redis, n, req, p, bindings);
    expect(result.issues).toEqual([]);
    expect(result.outcome).toBe('APPLIED');
    expect(result.counts.removed).toBe(2);
    expect(
      await db.webhookExecutionClaim.findMany({ where: { webhookEventId: { in: n.rootIds } } }),
    ).toEqual(claims);
    expect((await db.webhookEvent.findUniqueOrThrow({ where: { id: selected!.id } })).status).toBe(
      'CANCELLED',
    );
    expect((await db.webhookEvent.findUniqueOrThrow({ where: { id: other!.id } })).status).toBe(
      'FAILED',
    );
    for (const id of [reply, publication, timed])
      expect(await redis.exists(`bull:moderation-actions:${id}`)).toBe(1);
    expect(await redis.exists(`bull:moderation:${unrelated}`)).toBe(1);
  });

  it.each(['root', 'claim', 'new-family', 'job', 'binding', 'preview'] as const)(
    'refuses %s drift before writing and proves the operation absent',
    async (kind) => {
      const [row] = await root();
      const n = nomination([row!]);
      const id = await job('moderation-actions', action(row!));
      const p = await preview(n),
        req = applyRequest(n, p);
      let useBindings = bindings;
      if (kind === 'root')
        await db.webhookEvent.update({
          where: { id: row!.id },
          data: { errorMessage: 'changed authority' },
        });
      if (kind === 'claim')
        await db.webhookExecutionClaim.update({
          where: { kind_semanticKey: { kind: 'EXECUTION', semanticKey: row!.semanticKey! } },
          data: { businessStartedAt: new Date() },
        });
      if (kind === 'new-family')
        await db.webhookEvent.create({
          data: {
            id: ownReceiptId(),
            dedupKey: randomUUID(),
            createdAt: new Date(),
            status: 'RECEIVED',
            rawPayload: row!.rawPayload as Prisma.InputJsonValue,
            normalizedPayload: row!.normalizedPayload as Prisma.InputJsonValue,
            semanticKey: row!.semanticKey,
          },
        });
      if (kind === 'job')
        await redis.hset(
          `bull:moderation-actions:${id}`,
          'data',
          JSON.stringify(
            action(row!, {
              text: 'different',
              idempotencyKey: JSON.parse(
                (await redis.hget(`bull:moderation-actions:${id}`, 'data'))!,
              ).idempotencyKey,
            }),
          ),
        );
      if (kind === 'binding') useBindings = { ...bindings, runtimeDigest: 'e'.repeat(64) };
      if (kind === 'preview') p.completedAt = new Date(Date.now() + 1000).toISOString();
      const result = await applyTargetedBacklogCancellation(db, redis, n, req, p, useBindings);
      expect(result.outcome).toBe('REFUSED_UNWRITTEN');
      expect(result.operationExists).toBe(false);
      expect(result.issues).not.toEqual([]);
      expect((await proveTargetedBacklogCancellationAbsent(db, req)).operationAbsent).toBe(true);
      expect(await redis.exists(`bull:moderation-actions:${id}`)).toBe(1);
    },
  );

  it.each([
    'OPERATION_CREATED',
    'RECEIPTS_CAPTURED',
    'CHILDREN_CAPTURED',
    'SEALED',
    'PROJECTING',
    'JOB_RETIRED',
  ])(
    'resumes exactly after interruption at %s without replay or lost SEND descendants',
    async (phase) => {
      const [row] = await root();
      const n = nomination([row!]);
      const send = action(row!);
      const sendId = await job('moderation-actions', send);
      const auto = action(row!, {
        actionType: 'DELETE_MESSAGE',
        messageId: 'remote-fixture',
        ledgerContext: undefined,
        idempotencyKey: randomUUID(),
        sendAutoDelete: {
          version: 2,
          sourceSendCompletedAt: row!.createdAt.toISOString(),
          requestedDelayMs: 60000,
          originBotId: 'fixture',
          sourceSendJobId: send.idempotencyKey,
          sourceChatId: source(row!).chatId,
          sourceMessageId: source(row!).messageId,
          sourceUserId: 'fixture-user',
          sourceCreatedAt: send.createdAt,
        },
      });
      const autoId = await job('max-actions-background', auto, randomUUID(), { delay: 60_000 });
      const p = await preview(n),
        req = applyRequest(n, p);
      expect(p.children).toHaveLength(2);
      const claims = await db.webhookExecutionClaim.findMany({
        where: { webhookEventId: row!.id },
      });
      let injected = false;
      const first = await applyTargetedBacklogCancellation(
        db,
        redis,
        n,
        req,
        p,
        bindings,
        (value) => {
          if (value.phase === phase && !injected) {
            injected = true;
            throw new Error('fixture interruption');
          }
        },
      );
      expect(injected).toBe(true);
      expect(first.outcome).toBe('INCOMPLETE_WRITTEN');
      if (phase === 'JOB_RETIRED') {
        expect(await redis.exists(`bull:moderation-actions:${sendId}`)).toBe(0);
        expect(await redis.exists(`bull:max-actions-background:${autoId}`)).toBe(1);
      }
      const resumed = await applyTargetedBacklogCancellation(db, redis, n, req, p, bindings);
      expect(resumed.issues).toEqual([]);
      expect(resumed.outcome).toBe('APPLIED');
      expect(await redis.exists(`bull:moderation-actions:${sendId}`)).toBe(0);
      expect(await redis.exists(`bull:max-actions-background:${autoId}`)).toBe(0);
      expect(
        await db.webhookExecutionClaim.findMany({ where: { webhookEventId: row!.id } }),
      ).toEqual(claims);
      const again = await applyTargetedBacklogCancellation(db, redis, n, req, p, bindings);
      expect(again.outcome).toBe('APPLIED');
      expect(again.counts.removed).toBe(0);
    },
  );

  it('retains locked jobs explicitly and freezes an exact 128-root native scope', async () => {
    const rows = await root(128),
      n = nomination(rows);
    const id = await job('moderation', { webhookEventId: rows[0]!.id });
    await redis.set(`bull:moderation:${id}:lock`, 'fixture-owner', 'PX', 120000);
    const p = await preview(n);
    expect(p.roots).toHaveLength(128);
    expect(p.retained.lockedJobs).toBe(1);
    const result = await applyTargetedBacklogCancellation(
      db,
      redis,
      n,
      applyRequest(n, p),
      p,
      bindings,
    );
    expect(result.issues).toEqual([]);
    expect(result.outcome).toBe('APPLIED');
    expect(result.counts.receipts).toBe(128);
    expect(result.counts.retainedLocked).toBe(1);
    expect(result.counts.removed).toBe(0);
    expect(await redis.exists(`bull:moderation:${id}`)).toBe(1);
  });

  it('preserves post-seal family tombstones but not a distinct removal observation', async () => {
    const [row] = await root(),
      n = nomination([row!]),
      p = await preview(n);
    expect(
      (await applyTargetedBacklogCancellation(db, redis, n, applyRequest(n, p), p, bindings))
        .outcome,
    ).toBe('APPLIED');
    const copy = await db.webhookEvent.create({
      data: {
        id: ownReceiptId(),
        dedupKey: randomUUID(),
        rawPayload: row!.rawPayload as Prisma.InputJsonValue,
        normalizedPayload: row!.normalizedPayload as Prisma.InputJsonValue,
        semanticKey: row!.semanticKey,
      },
    });
    expect(await db.$transaction((tx) => materializeBacklogCancellation(tx, copy.id))).toBe(
      'APPLIED_WITH_PROOF',
    );
    const removal = {
      ...(row!.normalizedPayload as Record<string, Prisma.JsonValue>),
      type: 'message_removed',
    };
    const distinct = await db.webhookEvent.create({
      data: {
        id: ownReceiptId(),
        dedupKey: randomUUID(),
        rawPayload: removal,
        normalizedPayload: removal,
        semanticKey: buildWebhookSemanticEventKey(removal),
      },
    });
    expect(await db.$transaction((tx) => materializeBacklogCancellation(tx, distinct.id))).toBe(
      'NOT_HELD',
    );
  });

  it('rejects foreign child ownership before sealing and refuses a substituted saved tuple on exact resume', async () => {
    const [row] = await root(),
      n = nomination([row!]);
    const send = action(row!),
      id = await job('moderation-actions', send),
      p = await preview(n),
      req = applyRequest(n, p);
    const first = await applyTargetedBacklogCancellation(
      db,
      redis,
      n,
      req,
      p,
      bindings,
      (value) => {
        if (value.phase === 'RECEIPTS_CAPTURED') throw new Error('fixture interruption');
      },
    );
    expect(first.outcome).toBe('INCOMPLETE_WRITTEN');
    const proof = p.children[0]!;
    const hash = await redis.hgetall(`bull:moderation-actions:${id}`);
    await db.webhookBacklogChild.create({
      data: {
        kind: 'MAX_ACTION',
        childKey: send.idempotencyKey,
        cancellationId: n.id,
        originalSnapshot: JSON.parse(
          backlogJobSnapshot({
            version: 2,
            queue: proof.queue,
            jobId: 'different-job',
            authoritySha256: proof.authoritySha256,
            hash,
          }),
        ),
      },
    });
    const resumed = await applyTargetedBacklogCancellation(db, redis, n, req, p, bindings);
    expect(resumed.outcome).toBe('INCOMPLETE_WRITTEN');
    expect(resumed.sealed).toBe(false);
    expect(resumed.issues).toContainEqual({ code: 'EVIDENCE_MISMATCH' });
    expect(await redis.exists(`bull:moderation-actions:${id}`)).toBe(1);
  });

  it('rejects foreign selected child ownership online and after a successful preview without creating its own operation', async () => {
    const [row] = await root(),
      n = nomination([row!]),
      send = action(row!);
    const id = await job('moderation-actions', send),
      p = await preview(n),
      req = applyRequest(n, p);
    const foreign = nomination([row!]);
    await db.webhookBacklogCancellation.create({
      data: {
        id: foreign.id,
        cutoff: new Date(foreign.cutoff),
        sourceSha: foreign.sourceSha,
        imageId: foreign.imageId,
      },
    });
    await db.webhookBacklogChild.create({
      data: {
        kind: 'MAX_ACTION',
        childKey: send.idempotencyKey,
        cancellationId: foreign.id,
        originalSnapshot: { foreign: true },
      },
    });
    const denied = await previewTargetedBacklogCancellation(
      db,
      redis,
      nomination([row!]),
      bindings,
    );
    expect(denied.decision).toBe('DENY');
    expect(denied.issues).toContainEqual({
      code: 'FOREIGN_HOLD',
      queue: 'moderation-actions',
      jobId: id,
    });
    const result = await applyTargetedBacklogCancellation(db, redis, n, req, p, bindings);
    expect(result.outcome).toBe('REFUSED_UNWRITTEN');
    expect((await proveTargetedBacklogCancellationAbsent(db, req)).operationAbsent).toBe(true);
  });

  it('refuses raw surrogate bytes and round-trips valid JSON escapes, quotes and backslashes on resume', async () => {
    const [row] = await root(),
      n = nomination([row!]);
    const send = action(row!, { text: `${'"\\'.repeat(35000)}\ud800` });
    const id = await job('moderation-actions', send, randomUUID(), { label: '\ud800' });
    // FLAG: BullMQ MessagePack emits invalid UTF-8 for a raw lone-surrogate option.
    // Keep that refusal, then test valid JSON-escaped bytes in this exact fixture job.
    const invalid = await previewTargetedBacklogCancellation(db, redis, n, bindings);
    expect(invalid.decision).toBe('DENY');
    expect(invalid.issues).toContainEqual({ code: 'REDIS_SHAPE' });
    expect(await db.webhookBacklogCancellation.findUnique({ where: { id: n.id } })).toBeNull();
    await redis.hset(
      `bull:moderation-actions:${id}`,
      'opts',
      JSON.stringify({ jobId: id, label: '\ud800', attempts: 0 }),
    );
    const p = await preview(n),
      req = applyRequest(n, p);
    expect(
      (
        await applyTargetedBacklogCancellation(db, redis, n, req, p, bindings, (value) => {
          if (value.phase === 'CHILDREN_CAPTURED') throw new Error('fixture interruption');
        })
      ).outcome,
    ).toBe('INCOMPLETE_WRITTEN');
    const result = await applyTargetedBacklogCancellation(db, redis, n, req, p, bindings);
    expect(result.issues).toEqual([]);
    expect(result.outcome).toBe('APPLIED');
    expect(await redis.exists(`bull:moderation-actions:${id}`)).toBe(0);
  });

  it('accepts matching complete causal envelopes and refuses malformed or cross-root parent envelopes', async () => {
    const [a, b] = await root(2),
      n = nomination([a!, b!]);
    const send = action(a!, {
      ledgerContext: {
        moderationSource: { version: 1, ...source(a!), userId: 'fixture-user' },
        moderationRuleNotice: {
          version: 1,
          ...source(a!),
          userId: 'fixture-user',
          reasonKey: 'fixture',
          ruleCode: 'fixture',
          policySha256: 'a'.repeat(64),
          deadlineAtMs: Date.now() - 1000,
        },
      },
    });
    await job('moderation-actions', send);
    const valid = await preview(n);
    expect(valid.children).toHaveLength(1);
    await job(
      'max-actions-background',
      action(b!, {
        actionType: 'DELETE_MESSAGE',
        messageId: 'remote-child',
        ledgerContext: undefined,
        sendAutoDelete: {
          version: 2,
          sourceSendJobId: send.idempotencyKey,
          sourceSendCompletedAt: a!.createdAt.toISOString(),
          requestedDelayMs: 60000,
          originBotId: 'fixture',
          sourceChatId: source(b!).chatId,
          sourceMessageId: source(b!).messageId,
          sourceUserId: 'fixture-user',
          sourceCreatedAt: send.createdAt,
        },
      }),
    );
    const denied = await previewTargetedBacklogCancellation(
      db,
      redis,
      nomination([a!, b!]),
      bindings,
    );
    expect(denied.decision).toBe('DENY');
    expect(denied.issues).toContainEqual({ code: 'UNSUPPORTED_CHILD' });
    const [c] = await root();
    await job(
      'moderation-actions',
      action(c!, {
        ledgerContext: { moderationRuleNotice: { ...source(c!), userId: 'fixture-user' } },
      }),
    );
    const malformed = await previewTargetedBacklogCancellation(
      db,
      redis,
      nomination([c!]),
      bindings,
    );
    expect(malformed.decision).toBe('DENY');
    expect(malformed.issues).toContainEqual({ code: 'UNSUPPORTED_CHILD' });
  });

  it('refuses a direct DELETE whose different original message makes its ownership ambiguous', async () => {
    const [row] = await root(),
      n = nomination([row!]);
    await job(
      'moderation-actions',
      action(row!, {
        actionType: 'DELETE_MESSAGE',
        messageId: source(row!).messageId,
        ledgerContext: {
          moderationSource: {
            version: 1,
            chatId: source(row!).chatId,
            messageId: 'another-original-message',
            userId: 'fixture-user',
          },
        },
      }),
    );
    const p = await previewTargetedBacklogCancellation(db, redis, n, bindings);
    expect(p.decision).toBe('DENY');
    expect(p.issues).toContainEqual({ code: 'UNSUPPORTED_CHILD' });
    expect(await db.webhookBacklogCancellation.findUnique({ where: { id: n.id } })).toBeNull();
  });

  it('requires the exact valid operation index during preview and preflight', async () => {
    const [row] = await root(),
      n = nomination([row!]),
      p = await preview(n),
      req = applyRequest(n, p);
    await db.$executeRaw`ALTER INDEX webhook_backlog_children_operation_idx RENAME TO webhook_backlog_children_operation_fixture_saved`;
    try {
      const denied = await previewTargetedBacklogCancellation(
        db,
        redis,
        nomination([row!]),
        bindings,
      );
      expect(denied.decision).toBe('DENY');
      expect(denied.issues).toContainEqual({ code: 'SQL_PLAN' });
      await expect(preflightTargetedBacklogCancellation(db, n, req, p, bindings)).rejects.toThrow(
        'SQL_PLAN',
      );
      await db.$executeRaw`CREATE INDEX webhook_backlog_children_operation_idx ON webhook_backlog_children(kind,child_key)`;
      const wrong = await previewTargetedBacklogCancellation(
        db,
        redis,
        nomination([row!]),
        bindings,
      );
      expect(wrong.decision).toBe('DENY');
      expect(wrong.issues).toContainEqual({ code: 'SQL_PLAN' });
    } finally {
      await db.$executeRaw`DROP INDEX IF EXISTS webhook_backlog_children_operation_idx`;
      await db.$executeRaw`ALTER INDEX webhook_backlog_children_operation_fixture_saved RENAME TO webhook_backlog_children_operation_idx`;
    }
    expect((await preflightTargetedBacklogCancellation(db, n, req, p, bindings)).valid).toBe(true);
  });

  it('completes all 4096 selected children within fixed budgets and less than 64KiB progress', async () => {
    const [row] = await root(),
      n = nomination([row!]),
      queue = 'max-actions-critical',
      prefix = `max-children-${randomUUID()}`;
    const ids = Array.from({ length: 4096 }, (_, i) => `${prefix}-${i}`);
    const batch = redis.pipeline();
    for (const id of ids) {
      batch.hset(
        `bull:${queue}:${id}`,
        'name',
        'fixture',
        'data',
        JSON.stringify(action(row!, { idempotencyKey: id, text: 'fixture' })),
        'opts',
        '{}',
        'timestamp',
        String(Date.now() - 600000),
        'delay',
        '0',
        'priority',
        '0',
      );
      ownedJobs.push({ queue, id });
    }
    batch.rpush(`bull:${queue}:wait`, ...ids);
    expect((await batch.exec())?.some(([error]) => error)).toBe(false);
    const started = Date.now(),
      p = await preview(n),
      req = applyRequest(n, p),
      progress: Array<{ phase: string; count?: number }> = [];
    expect(p.children).toHaveLength(4096);
    const result = await applyTargetedBacklogCancellation(db, redis, n, req, p, bindings, (value) =>
      progress.push(value),
    );
    expect(result.issues).toEqual([]);
    expect(result.outcome).toBe('APPLIED');
    expect(result.counts.children).toBe(4096);
    expect(result.counts.removed).toBe(4096);
    expect(
      Buffer.byteLength(progress.map((value) => JSON.stringify(value) + '\n').join('')),
    ).toBeLessThan(64 * 1024);
    recordNativeEvidence(
      JSON.stringify({
        kind: 'V2_NATIVE_4096_TIMING',
        children: 4096,
        totalMs: Date.now() - started,
        progressBytes: Buffer.byteLength(JSON.stringify(progress)),
        previewCost: p.cost,
      }),
    );
  });

  it('refuses an oversized queue ID before returning it or reading its hash', async () => {
    const [row] = await root(),
      n = nomination([row!]);
    const huge = 'x'.repeat(2 * 1024 * 1024);
    await redis.rpush('bull:moderation:wait', huge);
    try {
      const calls: Array<{ command: string; args: unknown[] }> = [];
      const original = redis.callBuffer.bind(redis);
      const spy = jest.spyOn(redis, 'callBuffer').mockImplementation(((
        ...args: Parameters<Redis['callBuffer']>
      ) => {
        calls.push({ command: String(args[1]), args: args.slice(2) });
        return original(...args);
      }) as Redis['callBuffer']);
      try {
        const p = await previewTargetedBacklogCancellation(db, redis, n, bindings);
        expect(p.decision).toBe('DENY');
        expect(p.issues).toContainEqual({ code: 'REDIS_OVERSIZE' });
        expect(p.cost.queueBytes).toBeLessThan(1024);
        expect(calls.some((call) => call.command.includes('HGETALL'))).toBe(false);
      } finally {
        spy.mockRestore();
      }
    } finally {
      await redis.lrem('bull:moderation:wait', 0, huge);
    }
  });

  it('splits legal large hashes without losing selected offsets, locks or unrelated evidence', async () => {
    const [row] = await root(),
      n = nomination([row!]),
      queue = 'moderation-actions',
      prefix = `aggregate-${randomUUID()}`,
      ids = Array.from({ length: 101 }, (_, index) => `${prefix}-${index}`),
      selectedIndexes = new Set([0, 51, 99, 100]),
      failedReason = 'retained-error:'.padEnd(105 * 1024, 'e'),
      before = new Map<string, Record<string, string>>();
    for (const [index, id] of ids.entries()) {
      await job(
        queue,
        action(row!, {
          idempotencyKey: id,
          ...(selectedIndexes.has(index)
            ? {}
            : { chatId: '-unrelated-fixture', ledgerContext: undefined }),
        }),
        id,
      );
      await redis.hset(`bull:${queue}:${id}`, 'failedReason', failedReason);
      before.set(id, await redis.hgetall(`bull:${queue}:${id}`));
    }
    const lockedId = ids[51]!;
    await redis.set(`bull:${queue}:${lockedId}:lock`, 'fixture-owner', 'PX', 120000);
    const waitBefore = await redis.lrange(`bull:${queue}:wait`, 0, -1),
      selectedIds = new Set([...selectedIndexes].map((index) => ids[index]!)),
      payloadSizes: number[] = [],
      splitKeyCounts: number[] = [],
      original = redis.callBuffer.bind(redis),
      spy = jest.spyOn(redis, 'callBuffer').mockImplementation((async (
        ...args: Parameters<Redis['callBuffer']>
      ) => {
        const reply: unknown = await original(...args);
        if (String(args[1]).includes('HGETALL') && Array.isArray(reply)) {
          if (reply[0] === 2) splitKeyCounts.push(Number(args[2]));
          if (reply[0] === 1) {
            const bytes = (value: unknown): number =>
              Buffer.isBuffer(value)
                ? value.length
                : Array.isArray(value)
                  ? value.reduce((sum: number, part: unknown) => sum + bytes(part), 0)
                  : 0;
            payloadSizes.push(bytes(reply));
          }
        }
        return reply;
      }) as Redis['callBuffer']);
    try {
      const p = await preview(n);
      expect(p.cost.queueJobs).toBe(101);
      expect(p.children.map((child) => child.childKey).sort()).toEqual(
        [...selectedIndexes].map((index) => ids[index]!).sort(),
      );
      expect(p.retained.unattributedJobs).toBe(97);
      expect(p.retained.lockedJobs).toBe(1);
      const result = await applyTargetedBacklogCancellation(
        db,
        redis,
        n,
        applyRequest(n, p),
        p,
        bindings,
      );
      expect(result.issues).toEqual([]);
      expect(result.outcome).toBe('APPLIED');
      expect(result.counts.children).toBe(4);
      expect(result.counts.removed).toBe(3);
      expect(result.counts.retainedLocked).toBe(1);
      const retainedIds = waitBefore.filter((id) => !selectedIds.has(id) || id === lockedId);
      expect(await redis.lrange(`bull:${queue}:wait`, 0, -1)).toEqual(retainedIds);
      for (const id of retainedIds)
        expect(await redis.hgetall(`bull:${queue}:${id}`)).toEqual(before.get(id));
      expect(await redis.get(`bull:${queue}:${lockedId}:lock`)).toBe('fixture-owner');
      const saved = await db.webhookBacklogChild.findMany({
        where: { cancellationId: n.id, kind: 'MAX_ACTION' },
      });
      expect(saved).toHaveLength(4);
      for (const child of saved) {
        const envelope = child.originalSnapshot as { jsonUtf8Base64: string },
          captured = JSON.parse(
            Buffer.from(envelope.jsonUtf8Base64, 'base64').toString('utf8'),
          ) as {
            hash: Record<string, string>;
          };
        expect(captured.hash).toEqual(before.get(child.childKey));
      }
      expect(splitKeyCounts).toContain(100);
      expect(payloadSizes.length).toBeGreaterThan(1);
      expect(Math.max(...payloadSizes)).toBeLessThanOrEqual(1024 * 1024);
      recordNativeEvidence({
        kind: 'V2_NATIVE_ADAPTIVE_HASH_REPLY',
        jobs: ids.length,
        selected: saved.length,
        retained: retainedIds.length,
        splitReplies: splitKeyCounts.length,
        maxPayloadBytes: Math.max(...payloadSizes),
        previewCost: p.cost,
      });
    } finally {
      spy.mockRestore();
    }
  });

  it.each([0, 1])(
    'keeps the individual 256KiB hash boundary with %i excess bytes',
    async (excess) => {
      const [row] = await root(),
        n = nomination([row!]),
        id = await job('moderation-actions', action(row!)),
        key = `bull:moderation-actions:${id}`,
        hash = await redis.hgetall(key),
        size = Object.entries(hash).reduce(
          (sum, [field, value]) => sum + Buffer.byteLength(field) + Buffer.byteLength(value) + 16,
          0,
        ),
        field = 'failedReason',
        value = 'x'.repeat(256 * 1024 - size - Buffer.byteLength(field) - 16 + excess);
      await redis.hset(key, field, value);
      const original = redis.callBuffer.bind(redis),
        payloadReplies: unknown[] = [],
        spy = jest.spyOn(redis, 'callBuffer').mockImplementation((async (
          ...args: Parameters<Redis['callBuffer']>
        ) => {
          const reply: unknown = await original(...args);
          if (String(args[1]).includes('HGETALL')) payloadReplies.push(reply);
          return reply;
        }) as Redis['callBuffer']);
      try {
        const p = await previewTargetedBacklogCancellation(db, redis, n, bindings);
        expect(p.decision).toBe(excess ? 'DENY' : 'READY');
        expect(p.issues).toEqual(excess ? [{ code: 'REDIS_OVERSIZE' }] : []);
        if (excess) {
          expect(payloadReplies).toEqual([[0, Buffer.from('REDIS_OVERSIZE')]]);
          expect(p.cost.queueBytes).toBeLessThan(1024);
          expect(
            (await proveTargetedBacklogCancellationAbsent(db, applyRequest(n, p))).operationAbsent,
          ).toBe(true);
        }
        expect(await redis.hgetall(key)).toEqual({ ...hash, [field]: value });
        expect((await db.webhookEvent.findUniqueOrThrow({ where: { id: row!.id } })).status).toBe(
          'FAILED',
        );
      } finally {
        spy.mockRestore();
      }
    },
  );

  it('checks a whole oversized aggregate before fetching any individually invalid hash payload', async () => {
    const [row] = await root(),
      n = nomination([row!]),
      queue = 'moderation',
      oversizedId = await job(queue, { webhookEventId: row!.id });
    await redis.hset(`bull:${queue}:${oversizedId}`, 'failedReason', 'x'.repeat(256 * 1024));
    for (let index = 0; index < 12; index++) {
      const id = await job(queue, { webhookEventId: row!.id });
      await redis.hset(`bull:${queue}:${id}`, 'failedReason', 'x'.repeat(100 * 1024));
    }
    expect((await redis.lrange(`bull:${queue}:wait`, 0, -1)).at(-1)).toBe(oversizedId);
    const original = redis.callBuffer.bind(redis),
      payloadReplies: unknown[] = [],
      spy = jest.spyOn(redis, 'callBuffer').mockImplementation((async (
        ...args: Parameters<Redis['callBuffer']>
      ) => {
        const reply: unknown = await original(...args);
        if (String(args[1]).includes('HGETALL')) payloadReplies.push(reply);
        return reply;
      }) as Redis['callBuffer']);
    try {
      const p = await previewTargetedBacklogCancellation(db, redis, n, bindings);
      expect(p.decision).toBe('DENY');
      expect(p.issues).toEqual([{ code: 'REDIS_OVERSIZE' }]);
      expect(p.cost.queueJobs).toBe(13);
      expect(p.cost.queueBytes).toBeLessThan(2048);
      expect(payloadReplies).toEqual([[0, Buffer.from('REDIS_OVERSIZE')]]);
      expect(await redis.llen(`bull:${queue}:wait`)).toBe(13);
    } finally {
      spy.mockRestore();
    }
  });

  it('refuses an invalid UTF-8 queue ID without reading or removing its replacement-character shadow', async () => {
    const [row] = await root(),
      n = nomination([row!]),
      queue = 'moderation-actions',
      shadowId = '\ufffd',
      rawId = Buffer.from([0xff]);
    await job(queue, action(row!), shadowId);
    const p = await preview(n),
      req = applyRequest(n, p),
      shadowKey = `bull:${queue}:${shadowId}`,
      beforeHash = await rawHashSnapshot(shadowKey);
    await redis.lrem(`bull:${queue}:wait`, 0, shadowId);
    await redis.rpush(`bull:${queue}:wait`, rawId);
    try {
      const scripts: string[] = [],
        original = redis.callBuffer.bind(redis),
        spy = jest.spyOn(redis, 'callBuffer').mockImplementation(((
          ...args: Parameters<Redis['callBuffer']>
        ) => {
          scripts.push(String(args[1]));
          return original(...args);
        }) as Redis['callBuffer']);
      try {
        const denied = await previewTargetedBacklogCancellation(db, redis, n, bindings);
        expect(denied.decision).toBe('DENY');
        expect(denied.issues).toContainEqual({ code: 'REDIS_SHAPE' });
        const result = await applyTargetedBacklogCancellation(db, redis, n, req, p, bindings);
        expect(result.outcome).toBe('REFUSED_UNWRITTEN');
        expect(result.issues).toContainEqual({ code: 'REDIS_SHAPE' });
        expect(result.operationExists).toBe(false);
        expect(scripts.some((script) => script.includes('HGETALL'))).toBe(false);
      } finally {
        spy.mockRestore();
      }
      expect((await proveTargetedBacklogCancellationAbsent(db, req)).operationAbsent).toBe(true);
      expect(await rawHashSnapshot(shadowKey)).toEqual(beforeHash);
      expect(await redis.lrangeBuffer(`bull:${queue}:wait`, 0, -1)).toEqual([rawId]);
      expect((await db.webhookEvent.findUniqueOrThrow({ where: { id: row!.id } })).status).toBe(
        'FAILED',
      );
    } finally {
      await redis.lrem(`bull:${queue}:wait`, 0, rawId);
    }
  });

  it.each(['field', 'value'] as const)(
    'refuses invalid UTF-8 hash %s bytes before writing or deleting anything',
    async (kind) => {
      const [row] = await root(),
        n = nomination([row!]),
        id = await job('moderation-actions', action(row!)),
        key = `bull:moderation-actions:${id}`,
        p = await preview(n),
        req = applyRequest(n, p);
      await redis.hset(
        key,
        kind === 'field' ? Buffer.from([0xff]) : 'binary-fixture',
        kind === 'value' ? Buffer.from([0xff]) : 'fixture',
      );
      const beforeHash = await rawHashSnapshot(key);
      const denied = await previewTargetedBacklogCancellation(db, redis, n, bindings);
      expect(denied.decision).toBe('DENY');
      expect(denied.issues).toContainEqual({ code: 'REDIS_SHAPE' });
      const result = await applyTargetedBacklogCancellation(db, redis, n, req, p, bindings);
      expect(result.outcome).toBe('REFUSED_UNWRITTEN');
      expect(result.issues).toContainEqual({ code: 'REDIS_SHAPE' });
      expect((await proveTargetedBacklogCancellationAbsent(db, req)).operationAbsent).toBe(true);
      expect(await rawHashSnapshot(key)).toEqual(beforeHash);
      expect(await redis.lrange('bull:moderation-actions:wait', 0, -1)).toContain(id);
      expect((await db.webhookEvent.findUniqueOrThrow({ where: { id: row!.id } })).status).toBe(
        'FAILED',
      );
    },
  );

  it('preserves an own __proto__ hash field and valid Unicode bytes through capture and resume', async () => {
    const [row] = await root(),
      n = nomination([row!]),
      send = action(row!),
      id = await job('moderation-actions', send, `unicode-\ufffd-🧪-${randomUUID()}`),
      key = `bull:moderation-actions:${id}`;
    await redis.hset(
      key,
      '__proto__',
      '{"fixture":"preserved"}',
      'unicode-fixture',
      '\ufeffПоле 🧪',
    );
    const beforeHash = await rawHashSnapshot(key),
      p = await preview(n),
      req = applyRequest(n, p);
    const interrupted = await applyTargetedBacklogCancellation(
      db,
      redis,
      n,
      req,
      p,
      bindings,
      (value) => {
        if (value.phase === 'CHILDREN_CAPTURED') throw new Error('fixture interruption');
      },
    );
    expect(interrupted.outcome).toBe('INCOMPLETE_WRITTEN');
    expect(await rawHashSnapshot(key)).toEqual(beforeHash);
    const saved = await db.webhookBacklogChild.findUniqueOrThrow({
      where: { kind_childKey: { kind: 'MAX_ACTION', childKey: send.idempotencyKey } },
    });
    const envelope = saved.originalSnapshot as { jsonUtf8Base64: string };
    const snapshot = JSON.parse(
      Buffer.from(envelope.jsonUtf8Base64, 'base64').toString('utf8'),
    ) as {
      hash: Record<string, string>;
    };
    expect(Object.hasOwn(snapshot.hash, '__proto__')).toBe(true);
    expect(snapshot.hash.__proto__).toBe('{"fixture":"preserved"}');
    expect(snapshot.hash['unicode-fixture']).toBe('\ufeffПоле 🧪');
    const result = await applyTargetedBacklogCancellation(db, redis, n, req, p, bindings);
    expect(result.issues).toEqual([]);
    expect(result.outcome).toBe('APPLIED');
    expect(await redis.exists(key)).toBe(0);
  });

  it('walks 98 roots and 120000 real unrelated Redis job hashes in whole-scope bounded passes', async () => {
    const rows = await root(98),
      n = nomination(rows),
      queue = 'max-actions-interactive',
      prefix = `load-${randomUUID()}`;
    const ids = Array.from({ length: 120000 }, (_, i) => `${prefix}-${i}`);
    const unrelated = {
      actionType: 'SEND_MESSAGE',
      chatId: '-unrelated-fixture',
      text: `fixture ${'p'.repeat(700)}`,
      attempt: 0,
      idempotencyKey: 'unrelated',
      createdAt: new Date(Date.now() - 600000).toISOString(),
    };
    const start = Date.now(),
      rssBefore = process.memoryUsage().rss;
    try {
      for (let offset = 0; offset < ids.length; offset += 1000) {
        const page = ids.slice(offset, offset + 1000),
          batch = redis.pipeline();
        for (const id of page)
          batch.hset(
            `bull:${queue}:${id}`,
            'name',
            'fixture',
            'data',
            JSON.stringify(unrelated),
            'opts',
            '{}',
            'timestamp',
            String(Date.now() - 600000),
            'delay',
            '0',
            'priority',
            '0',
          );
        batch.rpush(`bull:${queue}:wait`, ...page);
        const replies = await batch.exec();
        expect(replies?.some(([error]) => error)).toBe(false);
      }
      const seedMs = Date.now() - start,
        walkStart = Date.now();
      const p = await preview(n);
      const previewMs = Date.now() - walkStart;
      expect(p.roots).toHaveLength(98);
      expect(p.cost.queueJobs).toBe(120000);
      expect(p.cost.queueBytes).toBeLessThan(256 * 1024 * 1024);
      const applyStart = Date.now();
      const result = await applyTargetedBacklogCancellation(
        db,
        redis,
        n,
        applyRequest(n, p),
        p,
        bindings,
      );
      const applyMs = Date.now() - applyStart;
      expect(result.issues).toEqual([]);
      expect(result.outcome).toBe('APPLIED');
      expect(result.counts.receipts).toBe(98);
      expect(result.counts.children).toBe(0);
      expect(await redis.llen(`bull:${queue}:wait`)).toBe(120000);
      expect(await redis.exists(`bull:${queue}:${ids[0]}`)).toBe(1);
      expect(await redis.exists(`bull:${queue}:${ids.at(-1)}`)).toBe(1);
      recordNativeEvidence(
        JSON.stringify({
          kind: 'V2_NATIVE_120K_TIMING',
          roots: 98,
          queueJobs: 120000,
          seedMs,
          previewMs,
          applyMs,
          queueBytes: p.cost.queueBytes,
          sqlRows: p.cost.sqlRows,
          sqlCalls: p.cost.sqlCalls,
          rssBefore,
          rssAfter: process.memoryUsage().rss,
        }),
      );
    } finally {
      // Exact fixture namespace is unique; no FLUSHDB, queue obliterate or unscoped DEL.
      expect(await redis.lrange(`bull:${queue}:wait`, 0, -1)).toEqual(ids);
      await redis.del(`bull:${queue}:wait`);
      for (let offset = 0; offset < ids.length; offset += 1000) {
        const page = ids.slice(offset, offset + 1000),
          batch = redis.pipeline();
        for (const id of page) batch.lrem(`bull:${queue}:wait`, 0, id).del(`bull:${queue}:${id}`);
        await batch.exec();
      }
    }
  });
});
