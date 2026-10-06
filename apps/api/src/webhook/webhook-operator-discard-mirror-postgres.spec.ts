import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import type { MaxUpdate } from '@maxim/contracts';
import { WebhookCanonicalExecutionService } from '../moderation/webhook-canonical-execution.service';
import { createPrismaClient, type PrismaClient, Prisma } from '../prisma/prisma-client';
import { WebhookParser } from './webhook.parser';
import { buildWebhookSemanticEventKey } from './webhook-semantic-event-key';
import { WebhookService } from './webhook.service';
import {
  operatorDiscardedMirrorSourceSql,
  settleOperatorDiscardedMirror,
} from './webhook-operator-discard-mirror';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
const native = databaseUrl ? describe : describe.skip;

// FLAG: Only a newly owned loopback PostgreSQL fixture is accepted. The real preparation
// path must stop before business preparation or MAX transport for an abandoned mirror.
native('operator-discard mirror native PostgreSQL regression', () => {
  jest.setTimeout(30_000);
  let prisma: PrismaClient;
  let ingress: WebhookService;
  const ids: string[] = [];
  const forbiddenBusinessPreparation = jest.fn(async () => {
    throw new Error('An abandoned mirror must not enter business preparation');
  });

  beforeAll(async () => {
    const url = new URL(databaseUrl);
    if (
      !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      !url.pathname.includes('race_test')
    )
      throw new Error('Only disposable loopback PostgreSQL is permitted');
    prisma = createPrismaClient(databaseUrl, { max: 8, statement_timeout: 10_000 });
    const [identity] = await prisma.$queryRaw<Array<{ version: string; timezone: string }>>`
      SELECT version(), current_setting('TimeZone') AS timezone`;
    expect(identity?.version).toMatch(/^PostgreSQL 16\./u);
    expect(identity?.timezone).toBe('UTC');
    expect(process.env.TZ).toBe('UTC');
  });

  beforeEach(() => {
    ingress = new WebhookService(
      prisma as never,
      new ConfigService({
        WEBHOOK_CANONICAL_EXECUTION_MODE: 'on',
      }),
      {} as never,
    );
    Object.assign(ingress, { prepareWebhookEventCore: forbiddenBusinessPreparation });
  });

  afterEach(async () => {
    await ingress?.onModuleDestroy();
    const businessCallCount = forbiddenBusinessPreparation.mock.calls.length;
    forbiddenBusinessPreparation.mockClear();
    const owned = ids.splice(0);
    await prisma.webhookExecutionClaim.deleteMany({ where: { webhookEventId: { in: owned } } });
    await prisma.webhookEvent.deleteMany({ where: { id: { in: owned } } });
    expect(businessCallCount).toBe(0);
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  async function fixture(withClaim: boolean) {
    const now = Date.now();
    const update = new WebhookParser().parse(
      {
        update_type: 'message_created',
        update_id: randomUUID(),
        timestamp: now,
        message: {
          sender: { user_id: 'fixture-user', name: 'Fixture', is_bot: false },
          recipient: { chat_id: `-${randomUUID()}`, chat_type: 'chat' },
          timestamp: now,
          body: { mid: randomUUID(), text: 'fixture content' },
        },
      },
      { botId: 'major-2' },
    );
    const semanticKey = buildWebhookSemanticEventKey(update)!;
    const marker = `WEBHOOK_HOT_PATH_TIMEOUT_TERMINAL_QUARANTINED:OPERATOR_DISCARDED:${randomUUID()}`;
    const owner = await prisma.webhookEvent.create({
      data: {
        botId: 'major-1',
        dedupKey: `operator-owner:${randomUUID()}`,
        semanticKey,
        normalizedPayload: {},
        rawPayload: {},
        status: 'FAILED',
        errorMessage: marker,
        createdAt: new Date(now - 1000),
      },
    });
    ids.push(owner.id);
    const claim = withClaim
      ? await prisma.webhookExecutionClaim.create({
          data: {
            kind: 'EXECUTION',
            semanticKey,
            webhookEventId: owner.id,
            enforced: true,
            createdAt: owner.createdAt,
          },
        })
      : null;
    const mirror = await prisma.webhookEvent.create({
      data: {
        botId: update.botId,
        dedupKey: `operator-mirror:${randomUUID()}`,
        semanticKey,
        normalizedPayload: JSON.parse(JSON.stringify(update)),
        rawPayload: update.raw!,
        createdAt: new Date(now),
        executionDeadlineAt: new Date(now + 300_000),
        nextEnqueueAt: new Date(now + 5000),
        queueName: 'webhook-critical',
        queuedAt: new Date(now),
      },
    });
    ids.push(mirror.id);
    return { owner, claim, mirror, marker, update: update as MaxUpdate };
  }

  async function snapshot(f: Awaited<ReturnType<typeof fixture>>) {
    return {
      receipts: await prisma.webhookEvent.findMany({
        where: { id: { in: [f.owner.id, f.mirror.id] } },
        orderBy: { id: 'asc' },
      }),
      claims: await prisma.webhookExecutionClaim.findMany({
        where: { webhookEventId: { in: [f.owner.id, f.mirror.id] } },
        orderBy: { id: 'asc' },
      }),
    };
  }

  async function settle(f: Awaited<ReturnType<typeof fixture>>, client = prisma) {
    return settleOperatorDiscardedMirror(client as never, {
      webhookEventId: f.mirror.id,
      update: f.update,
    });
  }

  it.each([true, false])(
    'retires exact scrubbed-owner mirror before preparation (claim=%s)',
    async (withClaim) => {
      const f = await fixture(withClaim);
      await expect(
        ingress.preparePersistedWebhookEvent(f.mirror.id, f.update),
      ).resolves.toMatchObject({
        canonical: false,
        prepared: false,
        enforced: true,
      });
      expect(
        await prisma.webhookEvent.findUniqueOrThrow({ where: { id: f.mirror.id } }),
      ).toMatchObject({
        status: 'FAILED',
        processedAt: null,
        errorMessage: f.marker,
        queueName: null,
        queuedAt: null,
        nextEnqueueAt: null,
        timeoutQuarantineExpiresAt: null,
      });
      expect(await prisma.webhookEvent.findUniqueOrThrow({ where: { id: f.owner.id } })).toEqual(
        f.owner,
      );
      expect(
        await prisma.webhookExecutionClaim.findMany({
          where: { semanticKey: f.mirror.semanticKey! },
        }),
      ).toEqual(f.claim ? [f.claim] : []);
    },
  );

  it.each([true, false])(
    'retires a queued mirror at the worker boundary (claim=%s)',
    async (withClaim) => {
      const f = await fixture(withClaim);
      await prisma.webhookEvent.update({ where: { id: f.mirror.id }, data: { status: 'QUEUED' } });
      const canonical = new WebhookCanonicalExecutionService(prisma as never);
      await expect(canonical.prepareExecution(f.mirror.id, 'major-2')).resolves.toBeNull();
      expect(
        await prisma.webhookEvent.findUniqueOrThrow({ where: { id: f.mirror.id } }),
      ).toMatchObject({
        status: 'FAILED',
        errorMessage: f.marker,
        processedAt: null,
        queueName: null,
        queuedAt: null,
        nextEnqueueAt: null,
      });
      expect(await prisma.webhookEvent.findUniqueOrThrow({ where: { id: f.owner.id } })).toEqual(
        f.owner,
      );
      expect(
        await prisma.webhookExecutionClaim.findMany({
          where: { semanticKey: f.mirror.semanticKey! },
        }),
      ).toEqual(f.claim ? [f.claim] : []);
    },
  );

  it.each(['started', 'completed'] as const)(
    'preserves %s original claim evidence without executing the mirror',
    async (state) => {
      const f = await fixture(true);
      const claim = await prisma.webhookExecutionClaim.update({
        where: { id: f.claim!.id },
        data: {
          status: state === 'completed' ? 'COMPLETED' : 'READY',
          preparedAt: f.owner.createdAt,
          businessStartedAt: f.owner.createdAt,
          completedAt: state === 'completed' ? f.owner.createdAt : null,
          commandResult: { fixtureProof: 'untouched' },
        },
      });
      expect(await settle(f)).toBe(true);
      expect(
        await prisma.webhookExecutionClaim.findUniqueOrThrow({ where: { id: claim.id } }),
      ).toEqual(claim);
      expect(await prisma.webhookEvent.findUniqueOrThrow({ where: { id: f.owner.id } })).toEqual(
        f.owner,
      );
      expect(
        await prisma.webhookEvent.findUniqueOrThrow({ where: { id: f.mirror.id } }),
      ).toMatchObject({ status: 'FAILED', processedAt: null });
    },
  );

  it('keeps an existing untouched mirror claim unchanged when the earlier anchor was discarded', async () => {
    const f = await fixture(false);
    const ownClaim = await prisma.webhookExecutionClaim.create({
      data: {
        kind: 'EXECUTION',
        semanticKey: f.mirror.semanticKey!,
        webhookEventId: f.mirror.id,
        enforced: true,
      },
    });
    expect(await settle(f)).toBe(true);
    expect(
      await prisma.webhookExecutionClaim.findUniqueOrThrow({ where: { id: ownClaim.id } }),
    ).toEqual(ownClaim);
  });

  it.each([
    [
      'generic terminal error',
      { errorMessage: 'WEBHOOK_HOT_PATH_TIMEOUT_TERMINAL_QUARANTINED: other failure' },
    ],
    [
      'partial marker',
      { errorMessage: 'WEBHOOK_HOT_PATH_TIMEOUT_TERMINAL_QUARANTINED:OPERATOR_DISCARDED:' },
    ],
    [
      'pending quarantine marker',
      { errorMessage: `WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINED:OPERATOR_DISCARDED:${randomUUID()}` },
    ],
    [
      'marker with trailing text',
      {
        errorMessage: `WEBHOOK_HOT_PATH_TIMEOUT_TERMINAL_QUARANTINED:OPERATOR_DISCARDED:${randomUUID()}:extra`,
      },
    ],
    ['unrelated semantic key', { semanticKey: `other:${randomUUID()}` }],
    ['unscrubbed source', { normalizedPayload: { type: 'message_created' } }],
    ['source retry scheduled', { nextEnqueueAt: new Date(Date.now() + 60_000) }],
    ['source queued', { queueName: 'webhook-critical' }],
  ] satisfies Array<[string, Prisma.WebhookEventUpdateInput]>)(
    'does not broaden source authority for %s',
    async (_name, data) => {
      const f = await fixture(true);
      await prisma.webhookEvent.update({ where: { id: f.owner.id }, data });
      const before = await snapshot(f);
      expect(await settle(f)).toBe(false);
      expect(await snapshot(f)).toEqual(before);
    },
  );

  it('does not apply a valid tombstone to a different incoming message', async () => {
    const f = await fixture(true);
    const before = await snapshot(f);
    const update = { ...f.update, message: { ...f.update.message!, messageId: randomUUID() } };
    expect(
      await settleOperatorDiscardedMirror(prisma as never, { webhookEventId: f.mirror.id, update }),
    ).toBe(false);
    expect(await snapshot(f)).toEqual(before);
  });

  it.each([
    ['ambiguous outcome', { errorMessage: 'Remote action outcome ambiguous' }],
    ['timeout lease', { timeoutQuarantineExpiresAt: new Date(Date.now() + 60_000) }],
  ] satisfies Array<[string, Prisma.WebhookEventUpdateInput]>)(
    'preserves the mirror with its own %s',
    async (_name, data) => {
      const f = await fixture(true);
      await prisma.webhookEvent.update({ where: { id: f.mirror.id }, data });
      const before = await snapshot(f);
      expect(await settle(f)).toBe(false);
      expect(await snapshot(f)).toEqual(before);
    },
  );

  it('uses a discarded exact claim owner even when a different receipt is the first semantic anchor', async () => {
    const f = await fixture(true);
    const anchor = await prisma.webhookEvent.create({
      data: {
        dedupKey: randomUUID(),
        semanticKey: f.mirror.semanticKey,
        normalizedPayload: JSON.parse(JSON.stringify(f.update)),
        rawPayload: f.update.raw!,
        createdAt: new Date(f.owner.createdAt.getTime() - 1000),
      },
    });
    ids.push(anchor.id);
    expect(await settle(f)).toBe(true);
    expect(await prisma.webhookEvent.findUniqueOrThrow({ where: { id: anchor.id } })).toEqual(
      anchor,
    );
    expect(
      await prisma.webhookExecutionClaim.findUniqueOrThrow({ where: { id: f.claim!.id } }),
    ).toEqual(f.claim);
  });

  it('does not search later generic mirrors for an abandonment authority', async () => {
    const f = await fixture(false);
    const anchor = await prisma.webhookEvent.create({
      data: {
        dedupKey: randomUUID(),
        semanticKey: f.mirror.semanticKey,
        normalizedPayload: JSON.parse(JSON.stringify(f.update)),
        rawPayload: f.update.raw!,
        createdAt: new Date(f.owner.createdAt.getTime() - 1000),
      },
    });
    ids.push(anchor.id);
    const before = await snapshot(f);
    expect(await settle(f)).toBe(false);
    expect(await snapshot(f)).toEqual(before);
    expect(await prisma.webhookEvent.findUniqueOrThrow({ where: { id: anchor.id } })).toEqual(
      anchor,
    );
  });

  it.each([
    [
      'started execution',
      { kind: 'EXECUTION', status: 'READY', businessStartedAt: new Date(), preparedAt: new Date() },
    ],
    [
      'live lease',
      {
        kind: 'EXECUTION',
        leaseToken: randomUUID(),
        leaseExpiresAt: new Date(Date.now() + 60_000),
      },
    ],
    ['command proof', { kind: 'COMMAND', commandResult: { sent: 'fixture-message' } }],
    ['unknown direct authority', { kind: 'HISTORICAL_EFFECT' }],
  ] satisfies Array<[string, Partial<Prisma.WebhookExecutionClaimCreateManyInput>]>)(
    'preserves own mirror %s',
    async (_name, data) => {
      const f = await fixture(false);
      await prisma.webhookExecutionClaim.create({
        data: {
          semanticKey: f.mirror.semanticKey!,
          webhookEventId: f.mirror.id,
          enforced: true,
          ...data,
        },
      });
      const before = await snapshot(f);
      expect(await settle(f)).toBe(false);
      expect(await snapshot(f)).toEqual(before);
    },
  );

  it('allows exactly one concurrent terminal transition without changing original authority', async () => {
    const f = await fixture(true);
    const results = await Promise.all([settle(f), settle(f)]);
    expect(results.sort()).toEqual([false, true]);
    expect(await prisma.webhookEvent.findUniqueOrThrow({ where: { id: f.owner.id } })).toEqual(
      f.owner,
    );
    expect(
      await prisma.webhookExecutionClaim.findUniqueOrThrow({ where: { id: f.claim!.id } }),
    ).toEqual(f.claim);
    expect(
      await prisma.webhookEvent.findUniqueOrThrow({ where: { id: f.mirror.id } }),
    ).toMatchObject({ status: 'FAILED', processedAt: null, errorMessage: f.marker });
  });

  it.each(['receipt', 'claim'] as const)(
    'rechecks a concurrent %s change after waiting for its SQL lock',
    async (target) => {
      const f = await fixture(target === 'receipt');
      const ownClaim =
        target === 'claim'
          ? await prisma.webhookExecutionClaim.create({
              data: {
                kind: 'EXECUTION',
                semanticKey: f.mirror.semanticKey!,
                webhookEventId: f.mirror.id,
                enforced: true,
              },
            })
          : null;
      const applicationName = `operator-discard-racer-${randomUUID()}`;
      const racer = createPrismaClient(databaseUrl, {
        max: 2,
        application_name: applicationName,
        statement_timeout: 10_000,
      });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let locked!: () => void;
      const ready = new Promise<void>((resolve) => {
        locked = resolve;
      });
      const blocker = prisma.$transaction(
        async (tx) => {
          if (target === 'receipt') {
            await tx.webhookEvent.update({
              where: { id: f.mirror.id },
              data: { status: 'PROCESSED', processedAt: new Date() },
            });
          } else {
            await tx.webhookExecutionClaim.update({
              where: { id: ownClaim!.id },
              data: { leaseToken: randomUUID(), leaseExpiresAt: new Date(Date.now() + 60_000) },
            });
          }
          locked();
          await gate;
        },
        { timeout: 15_000 },
      );
      let pending: Promise<boolean> | undefined;
      try {
        await ready;
        pending = settle(f, racer);
        void pending.catch(() => undefined);
        let blocked = false;
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
          const rows = await prisma.$queryRaw<Array<{ blocked: boolean }>>`
          SELECT EXISTS(SELECT 1 FROM pg_stat_activity
            WHERE application_name = ${applicationName} AND wait_event_type = 'Lock') AS blocked`;
          if (rows[0]?.blocked) {
            blocked = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(blocked).toBe(true);
        release();
        await blocker;
        const before = await snapshot(f);
        expect(await pending).toBe(false);
        expect(await snapshot(f)).toEqual(before);
      } finally {
        release();
        await blocker;
        await pending?.catch(() => undefined);
        await racer.$disconnect();
      }
    },
  );

  it('bounds the source proof to indexed probes over retained history and same-key skew', async () => {
    const f = await fixture(true);
    const healthy = await fixture(true);
    await prisma.webhookEvent.update({
      where: { id: healthy.owner.id },
      data: {
        status: 'RECEIVED',
        errorMessage: null,
        normalizedPayload: JSON.parse(JSON.stringify({ ...healthy.update, botId: 'major-1' })),
        rawPayload: healthy.update.raw!,
      },
    });
    const prefix = `operator-plan-${randomUUID()}`;
    ids.push(...Array.from({ length: 20_000 }, (_, index) => `${prefix}-${index + 1}`));
    await prisma.$executeRaw(Prisma.sql`
      INSERT INTO webhook_events (id, dedup_key, semantic_key, status, raw_payload, normalized_payload, created_at)
      SELECT ${prefix} || '-' || g, ${prefix} || ':dedup:' || g,
        CASE WHEN g <= 12000 THEN ${f.mirror.semanticKey} ELSE ${prefix} || ':key:' || g END,
        'FAILED'::"WebhookStatus", '{}'::jsonb, '{}'::jsonb, ${new Date(Date.now() + 1000)}
      FROM generate_series(1, 20000) g
    `);
    await prisma.$executeRaw(Prisma.sql`
      INSERT INTO webhook_execution_claims (id, kind, semantic_key, webhook_event_id, updated_at)
      SELECT ${prefix} || ':claim:' || g, 'EXECUTION', ${prefix} || ':claim-key:' || g,
        ${prefix} || '-' || g, CURRENT_TIMESTAMP
      FROM generate_series(1, 10000) g
    `);
    await prisma.$executeRaw`ANALYZE webhook_events`;
    await prisma.$executeRaw`ANALYZE webhook_execution_claims`;
    type Plan = {
      'Node Type': string;
      'Relation Name'?: string;
      'Index Name'?: string;
      'Actual Rows': number;
      'Actual Loops': number;
      'Rows Removed by Filter'?: number;
      'Shared Hit Blocks': number;
      'Shared Read Blocks': number;
      Plans?: Plan[];
    };
    const probes: Array<{
      scenario: string;
      rows: number;
      buffers: number;
      relationProbes: number;
    }> = [];
    for (const [scenario, semanticKey, receiptId, expectedRows] of [
      ['discarded-mirror', f.mirror.semanticKey!, f.mirror.id, 1],
      ['absent-key', `${prefix}:absent`, f.mirror.id, 0],
      ['healthy-owner-with-claim', healthy.owner.semanticKey!, healthy.owner.id, 0],
    ] as const) {
      const result = await prisma.$queryRaw<Array<{ 'QUERY PLAN': Array<{ Plan: Plan }> }>>(
        Prisma.sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${operatorDiscardedMirrorSourceSql(semanticKey, receiptId)}`,
      );
      const plan = result[0]!['QUERY PLAN'][0]!.Plan;
      const nodes: Plan[] = [];
      const visit = (node: Plan) => {
        nodes.push(node);
        node.Plans?.forEach(visit);
      };
      visit(plan);
      const relations = nodes.filter((node) => node['Relation Name']);
      expect(relations.length).toBeGreaterThanOrEqual(3);
      for (const node of relations) {
        expect(node['Node Type']).toMatch(/Index/);
        expect(
          (node['Actual Rows'] + (node['Rows Removed by Filter'] ?? 0)) * node['Actual Loops'],
        ).toBeLessThanOrEqual(2);
      }
      expect(nodes.some((node) => node['Index Name'] === 'webhook_events_semantic_order_idx')).toBe(
        true,
      );
      const buffers = plan['Shared Hit Blocks'] + plan['Shared Read Blocks'];
      expect(buffers).toBeLessThan(128);
      expect(plan['Actual Rows']).toBe(expectedRows);
      probes.push({
        scenario,
        rows: plan['Actual Rows'],
        buffers,
        relationProbes: relations.length,
      });
    }
    process.stdout.write(
      `OPERATOR_DISCARD_NATIVE_EXPLAIN ${JSON.stringify({ receipts: 20000, sameKey: 12000, claims: 10000, probes })}\n`,
    );
  });
});
