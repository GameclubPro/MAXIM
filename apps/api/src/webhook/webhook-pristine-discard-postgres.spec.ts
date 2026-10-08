import { randomUUID } from 'node:crypto';
import type { MaxUpdate } from '@maxim/contracts';
import { ConfigService } from '@nestjs/config';
import { createPrismaClient, type PrismaClient, Prisma } from '../prisma/prisma-client';
import { WebhookCanonicalExecutionService } from '../moderation/webhook-canonical-execution.service';
import { WebhookParser } from './webhook.parser';
import { WebhookService } from './webhook.service';
import { DORMANT_BOT_OBSERVATION_MARKER } from './webhook-dormant-observation';
import { buildWebhookSemanticEventKey } from './webhook-semantic-event-key';
import {
  pristineDiscardCandidateSql,
  settlePristineOperatorDiscard,
} from './webhook-pristine-discard';
import { hasWebhookReplayFence } from './webhook-execution-deadline';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
const native = databaseUrl ? describe : describe.skip;
const migration = '20261005020000_add_multibot_order_fences';

native('pristine operator-discard owner native PostgreSQL', () => {
  jest.setTimeout(30_000);
  let db: PrismaClient;
  let cutoff: Date;
  const receiptIds: string[] = [];
  const claimIds: string[] = [];
  beforeAll(async () => {
    const url = new URL(databaseUrl);
    if (
      !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      !url.pathname.includes('race_test')
    )
      throw new Error('Disposable loopback PostgreSQL required');
    db = createPrismaClient(databaseUrl, { max: 8, statement_timeout: 10_000 });
    const [identity] = await db.$queryRaw<Array<{ version: string; zone: string }>>`
      SELECT version(), current_setting('TimeZone') AS zone`;
    expect(identity?.version).toMatch(/^PostgreSQL 16\./u);
    expect(identity?.zone).toBe('UTC');
    const [row] = await db.$queryRaw<Array<{ at: Date }>>`SELECT finished_at AS at
      FROM _prisma_migrations WHERE migration_name = ${migration}`;
    cutoff = row!.at;
    // FLAG: Change only this owned disposable fixture's migration clock, never production.
    await db.$executeRaw`UPDATE _prisma_migrations SET finished_at = ${new Date(Date.now() - 3_600_000)}
      WHERE migration_name = ${migration}`;
  });
  afterEach(async () => {
    await db.webhookExecutionClaim.deleteMany({ where: { id: { in: claimIds.splice(0) } } });
    await db.webhookEvent.deleteMany({ where: { id: { in: receiptIds.splice(0) } } });
  });
  afterAll(async () => {
    if (cutoff)
      await db.$executeRaw`UPDATE _prisma_migrations SET finished_at = ${cutoff}
      WHERE migration_name = ${migration}`;
    await db?.$disconnect();
  });
  async function fixture() {
    const at = Date.now() - 600_000;
    const raw = {
      update_type: 'message_created',
      update_id: randomUUID(),
      timestamp: at,
      message: {
        sender: { user_id: 'fixture-human', is_bot: false, name: 'Fixture' },
        recipient: { chat_id: `-${randomUUID()}`, chat_type: 'chat' },
        timestamp: at,
        body: { mid: randomUUID(), text: 'ordinary untouched source' },
      },
    };
    const update = new WebhookParser().parse(raw, { botId: 'fixture-bot' });
    const semanticKey = buildWebhookSemanticEventKey(update)!;
    const create = async (
      offset: number,
      fields: Partial<Prisma.WebhookEventUncheckedCreateInput> = {},
    ) => {
      const row = await db.webhookEvent.create({
        data: {
          botId: update.botId,
          dedupKey: randomUUID(),
          semanticKey,
          rawPayload: raw,
          normalizedPayload: JSON.parse(JSON.stringify(update)),
          createdAt: new Date(at + offset),
          executionDeadlineAt: new Date(at + 300_000),
          ...fields,
        },
      });
      receiptIds.push(row.id);
      return row;
    };
    const observation = await create(10, {
      status: 'PROCESSED',
      processedAt: new Date(at + 20),
      errorMessage: DORMANT_BOT_OBSERVATION_MARKER,
    } as never);
    const owner = await create(100, {
      status: 'QUEUED',
      queueName: 'moderation-default-0',
      queuedAt: new Date(at + 150),
    } as never);
    const claim = await db.webhookExecutionClaim.create({
      data: {
        kind: 'EXECUTION',
        semanticKey,
        webhookEventId: owner.id,
        enforced: true,
        status: 'READY',
        executionBotId: 'fixture-bot',
        createdAt: new Date(at + 120),
        preparedAt: new Date(at + 130),
      },
    });
    claimIds.push(claim.id);
    const marker = `WEBHOOK_HOT_PATH_TIMEOUT_TERMINAL_QUARANTINED:OPERATOR_DISCARDED:${randomUUID()}`;
    const discards = [];
    for (let i = 0; i < 3; i++)
      discards.push(
        await create(200 + i, {
          status: 'FAILED',
          rawPayload: {},
          normalizedPayload: {},
          errorMessage: marker,
        } as never),
      );
    return {
      at,
      raw,
      update: update as MaxUpdate,
      semanticKey,
      observation,
      owner,
      claim,
      marker,
      discards,
      create,
    };
  }
  const settle = (f: Awaited<ReturnType<typeof fixture>>, id = f.owner.id) =>
    settlePristineOperatorDiscard(db as never, { webhookEventId: id, update: f.update });

  it.each(['worker', 'preparation'] as const)(
    'settles via %s without preparation/effects or claim/body changes',
    async (entry) => {
      const f = await fixture();
      const before = await db.webhookEvent.findMany({
        where: { id: { in: receiptIds } },
        orderBy: { id: 'asc' },
      });
      if (entry === 'worker') {
        const worker = new WebhookCanonicalExecutionService(db as never);
        await expect(worker.prepareExecution(f.owner.id, 'fixture-bot')).resolves.toBeNull();
      } else {
        const ingress = new WebhookService(db as never, new ConfigService(), {} as never);
        const prepare = jest.fn(async () => {
          throw new Error('must never prepare discarded source');
        });
        Object.assign(ingress, { prepareWebhookEventCore: prepare });
        await expect(
          ingress.preparePersistedWebhookEvent(f.owner.id, f.update),
        ).resolves.toMatchObject({ canonical: false });
        expect(prepare).not.toHaveBeenCalled();
        await ingress.onModuleDestroy();
      }
      const owner = await db.webhookEvent.findUniqueOrThrow({ where: { id: f.owner.id } });
      expect(owner).toEqual({
        ...f.owner,
        status: 'FAILED',
        queueName: null,
        queuedAt: null,
        errorMessage: f.marker.replace(':OPERATOR_DISCARDED:', ':PRISTINE_OPERATOR_DISCARD_V1:'),
      });
      expect(hasWebhookReplayFence(owner)).toBe(true);
      expect(
        await db.webhookExecutionClaim.findUniqueOrThrow({ where: { id: f.claim.id } }),
      ).toEqual(f.claim);
      expect(
        await db.webhookEvent.findMany({
          where: { id: { in: receiptIds.filter((id) => id !== owner.id) } },
          orderBy: { id: 'asc' },
        }),
      ).toEqual(before.filter((row) => row.id !== owner.id));
      expect(await settle(f)).toBe(true);
      const late = await f.create(500);
      expect(await settle(f, late.id)).toBe(true);
      expect(await db.webhookEvent.findUniqueOrThrow({ where: { id: late.id } })).toMatchObject({
        status: 'FAILED',
        processedAt: null,
        errorMessage: owner.errorMessage,
        normalizedPayload: late.normalizedPayload,
        rawPayload: late.rawPayload,
      });
    },
  );

  it.each([
    { businessStartedAt: new Date() },
    { completedAt: new Date() },
    { enforced: false },
    { commandResult: { kind: 'unknown' } },
    { leaseToken: randomUUID(), leaseExpiresAt: new Date(Date.now() + 60_000) },
    { leaseToken: randomUUID(), leaseExpiresAt: new Date(Date.now() - 60_000) },
    { createdAt: new Date(0) },
    { preparedAt: null },
    { status: 'COMPLETED' as const },
  ])('refuses non-pristine claim %j', async (change) => {
    const f = await fixture();
    const claim = await db.webhookExecutionClaim.update({
      where: { id: f.claim.id },
      data: change,
    });
    expect(await settle(f)).toBe(false);
    expect(await db.webhookEvent.findUniqueOrThrow({ where: { id: f.owner.id } })).toEqual(f.owner);
    expect(await db.webhookExecutionClaim.findUniqueOrThrow({ where: { id: claim.id } })).toEqual(
      claim,
    );
  });

  it.each([
    'unknown_authority',
    'extra_receipt',
    'bad_marker',
    'unscrubbed',
    'old_source',
    'wrong_sender',
    'command',
    'media',
    'future_deadline',
    'oversized',
    'saturated',
  ] as const)('refuses incomplete family/source proof: %s', async (change) => {
    const f = await fixture();
    if (change === 'unknown_authority') {
      const claim = await db.webhookExecutionClaim.create({
        data: { kind: 'UNKNOWN_EFFECT', semanticKey: f.semanticKey },
      });
      claimIds.push(claim.id);
    }
    if (change === 'extra_receipt') await f.create(300);
    if (change === 'saturated') for (let i = 0; i < 60; i++) await f.create(300 + i);
    if (change === 'bad_marker' || change === 'unscrubbed')
      for (const row of f.discards)
        await db.webhookEvent.update({
          where: { id: row.id },
          data:
            change === 'bad_marker'
              ? { errorMessage: `${f.marker}:unknown` }
              : { rawPayload: f.raw },
        });
    if (change === 'future_deadline')
      await db.webhookEvent.update({
        where: { id: f.owner.id },
        data: { executionDeadlineAt: new Date(Date.now() + 60_000) },
      });
    if (['old_source', 'wrong_sender', 'command', 'media', 'oversized'].includes(change)) {
      const raw = structuredClone(f.raw);
      if (change === 'old_source') raw.message.timestamp = 1;
      if (change === 'wrong_sender') raw.message.sender.user_id = 'different-person';
      if (change === 'command') raw.message.body.text = 'Старт';
      if (change === 'oversized') raw.message.body.text = 'x'.repeat(300_000);
      if (change === 'media')
        Object.assign(raw.message.body, {
          attachments: [{ type: 'image', payload: { url: 'https://example.org/image.jpg' } }],
        });
      const update = new WebhookParser().parse(raw, { botId: 'fixture-bot' });
      const target = change === 'wrong_sender' ? f.observation : f.owner;
      await db.webhookEvent.update({
        where: { id: target.id },
        data: { rawPayload: raw, normalizedPayload: JSON.parse(JSON.stringify(update)) },
      });
    }
    const before = await db.webhookEvent.findMany({
      where: { id: { in: receiptIds } },
      orderBy: { id: 'asc' },
    });
    expect(await settle(f)).toBe(false);
    expect(
      await db.webhookEvent.findMany({ where: { id: { in: receiptIds } }, orderBy: { id: 'asc' } }),
    ).toEqual(before);
    expect(await db.webhookExecutionClaim.findUniqueOrThrow({ where: { id: f.claim.id } })).toEqual(
      f.claim,
    );
  });

  it('has one terminal writer in a concurrent double settlement', async () => {
    const f = await fixture();
    expect(await Promise.all([settle(f), settle(f)])).toEqual([true, true]);
    expect(await db.webhookExecutionClaim.findUniqueOrThrow({ where: { id: f.claim.id } })).toEqual(
      f.claim,
    );
  });

  it('settles concurrent late fanout without mirrors blocking one another', async () => {
    const f = await fixture();
    expect(await settle(f)).toBe(true);
    const first = await f.create(500);
    const second = await f.create(501);
    expect(await Promise.all([settle(f, first.id), settle(f, second.id)])).toEqual([true, true]);
    for (const id of [first.id, second.id])
      expect(
        hasWebhookReplayFence(await db.webhookEvent.findUniqueOrThrow({ where: { id } })),
      ).toBe(true);
    expect(await db.webhookExecutionClaim.findUniqueOrThrow({ where: { id: f.claim.id } })).toEqual(
      f.claim,
    );
  });

  it('releases the next independent same-chat event while denying a stale start of the old owner', async () => {
    const f = await fixture();
    const raw = structuredClone(f.raw);
    raw.update_id = randomUUID();
    raw.message.body.mid = randomUUID();
    raw.timestamp = Date.now();
    raw.message.timestamp = raw.timestamp;
    const update = new WebhookParser().parse(raw, { botId: 'fixture-bot' }) as MaxUpdate;
    const next = await f.create(700_000, {
      rawPayload: raw,
      normalizedPayload: JSON.parse(JSON.stringify(update)),
      semanticKey: buildWebhookSemanticEventKey(update),
      executionDeadlineAt: new Date(Date.now() + 300_000),
    } as never);
    const worker = new WebhookCanonicalExecutionService(db as never) as unknown as {
      assertNoOutstandingOrderedPredecessor: (
        event: typeof next,
        input: MaxUpdate,
      ) => Promise<void>;
    };
    await expect(worker.assertNoOutstandingOrderedPredecessor(next, update)).rejects.toThrow();
    expect(await settle(f)).toBe(true);
    await expect(
      worker.assertNoOutstandingOrderedPredecessor(next, update),
    ).resolves.toBeUndefined();
    const leaseToken = randomUUID();
    // FLAG: Simulate a stale worker acquiring its lease after settlement. The final
    // canonical start CAS must still honor the committed terminal receipt fence.
    const claimed = await db.webhookExecutionClaim.update({
      where: { id: f.claim.id },
      data: { leaseToken, leaseExpiresAt: new Date(Date.now() + 60_000) },
    });
    const before = await db.webhookEvent.findUniqueOrThrow({ where: { id: f.owner.id } });
    expect(
      await db.$transaction((tx) =>
        WebhookCanonicalExecutionService.transitionLiveUnstartedOwnerWithClient(tx, {
          claimId: f.claim.id,
          webhookEventId: f.owner.id,
          semanticKey: f.semanticKey,
          leaseToken,
          executionBotId: 'fixture-bot',
          executionDeadlineAt: f.owner.executionDeadlineAt,
          enforced: true,
          phase: 'start',
        }),
      ),
    ).toBe('deferred');
    expect(await db.webhookEvent.findUniqueOrThrow({ where: { id: f.owner.id } })).toEqual(before);
    expect(await db.webhookExecutionClaim.findUniqueOrThrow({ where: { id: f.claim.id } })).toEqual(
      claimed,
    );
  });

  it('bounds exact claim and witness probes over retained history and same-key skew', async () => {
    const f = await fixture();
    const healthy = await fixture();
    await db.webhookEvent.updateMany({
      where: { id: { in: healthy.discards.map((row) => row.id) } },
      data: { errorMessage: null },
    });
    const prefix = `pristine-plan-${randomUUID()}`;
    receiptIds.push(...Array.from({ length: 20_000 }, (_, index) => `${prefix}-${index + 1}`));
    claimIds.push(...Array.from({ length: 10_000 }, (_, index) => `${prefix}:claim:${index + 1}`));
    await db.$executeRaw(Prisma.sql`
      INSERT INTO webhook_events (id, dedup_key, semantic_key, status, raw_payload, normalized_payload, created_at)
      SELECT ${prefix} || '-' || g, ${prefix} || ':dedup:' || g,
        CASE WHEN g <= 12000 THEN ${healthy.semanticKey} ELSE ${prefix} || ':key:' || g END,
        'FAILED'::"WebhookStatus", '{}'::jsonb, '{}'::jsonb, ${new Date()}
      FROM generate_series(1, 20000) g`);
    await db.$executeRaw(Prisma.sql`
      INSERT INTO webhook_execution_claims (id, kind, semantic_key, webhook_event_id, updated_at, status, enforced, prepared_at)
      SELECT ${prefix} || ':claim:' || g, 'EXECUTION', ${prefix} || ':claim-key:' || g,
        ${prefix} || '-' || g, CURRENT_TIMESTAMP, 'READY'::"WebhookExecutionClaimStatus", true, CURRENT_TIMESTAMP
      FROM generate_series(1, 10000) g`);
    await db.$executeRaw`ANALYZE webhook_events`;
    await db.$executeRaw`ANALYZE webhook_execution_claims`;
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
    const probes = [];
    for (const [scenario, key, expected] of [
      ['pristine-owner', f.semanticKey, 1],
      ['absent-key', `${prefix}:absent`, 0],
      ['healthy-owner-skew', healthy.semanticKey, 0],
    ] as const) {
      const result = await db.$queryRaw<Array<{ 'QUERY PLAN': Array<{ Plan: Plan }> }>>(Prisma.sql`
        EXPLAIN (ANALYZE, FORMAT JSON, BUFFERS) ${pristineDiscardCandidateSql(key)}`);
      const plan = result[0]!['QUERY PLAN'][0]!.Plan;
      const nodes: Plan[] = [];
      const visit = (node: Plan) => {
        nodes.push(node);
        node.Plans?.forEach(visit);
      };
      visit(plan);
      for (const node of nodes.filter((item) => item['Relation Name'])) {
        expect(node['Node Type']).toMatch(/Index/u);
        expect(
          (node['Actual Rows'] + (node['Rows Removed by Filter'] ?? 0)) * node['Actual Loops'],
        ).toBeLessThanOrEqual(65);
      }
      expect(
        nodes.some((node) =>
          node['Index Name']?.startsWith('webhook_execution_claims_kind_semantic_key'),
        ),
      ).toBe(true);
      const buffers = plan['Shared Hit Blocks'] + plan['Shared Read Blocks'];
      expect(buffers).toBeLessThan(512);
      expect(plan['Actual Rows']).toBe(expected);
      probes.push({ scenario, rows: plan['Actual Rows'], buffers });
    }
    process.stdout.write(
      `PRISTINE_DISCARD_NATIVE_EXPLAIN ${JSON.stringify({ receipts: 20000, sameKey: 12000, claims: 10000, probes })}\n`,
    );
  });
});
