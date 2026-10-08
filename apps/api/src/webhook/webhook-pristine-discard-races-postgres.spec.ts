import { randomUUID } from 'node:crypto';
import type { MaxUpdate } from '@maxim/contracts';
import { createPrismaClient, type PrismaClient, type Prisma } from '../prisma/prisma-client';
import { DORMANT_BOT_OBSERVATION_MARKER } from './webhook-dormant-observation';
import { WebhookOutboxService } from './webhook-outbox.service';
import { WebhookParser } from './webhook.parser';
import { settlePristineOperatorDiscard } from './webhook-pristine-discard';
import { buildWebhookSemanticEventKey } from './webhook-semantic-event-key';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
const native = databaseUrl ? describe : describe.skip;
const migrationName = '20261005020000_add_multibot_order_fences';

native('pristine discard lock races and retained proof', () => {
  jest.setTimeout(30_000);
  let db: PrismaClient;
  let originalCutoff: Date;
  const eventIds: string[] = [];
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
    expect(process.env.TZ).toBe('UTC');
    const [migration] = await db.$queryRaw<Array<{ at: Date }>>`
      SELECT finished_at AS at FROM _prisma_migrations WHERE migration_name = ${migrationName}`;
    originalCutoff = migration!.at;
    // FLAG: This fixture changes and restores only its disposable database's clock.
    await db.$executeRaw`UPDATE _prisma_migrations SET finished_at = ${new Date(Date.now() - 3_600_000)}
      WHERE migration_name = ${migrationName}`;
  });

  afterEach(async () => {
    await db.webhookExecutionClaim.deleteMany({ where: { id: { in: claimIds.splice(0) } } });
    await db.webhookEvent.deleteMany({ where: { id: { in: eventIds.splice(0) } } });
  });

  afterAll(async () => {
    if (originalCutoff)
      await db.$executeRaw`UPDATE _prisma_migrations SET finished_at = ${originalCutoff}
      WHERE migration_name = ${migrationName}`;
    await db?.$disconnect();
  });

  async function fixture() {
    const at = Date.now() - 600_000;
    const raw = {
      update_type: 'message_created',
      update_id: randomUUID(),
      timestamp: at,
      message: {
        sender: { user_id: 'fixture-person', is_bot: false, name: 'Fixture' },
        recipient: { chat_id: `-${randomUUID()}`, chat_type: 'chat' },
        timestamp: at,
        body: { mid: randomUUID(), text: 'ordinary pristine source' },
      },
    };
    const update = new WebhookParser().parse(raw, { botId: 'fixture-major' });
    const semanticKey = buildWebhookSemanticEventKey(update)!;
    const create = async (
      offset: number,
      data: Partial<Prisma.WebhookEventUncheckedCreateInput>,
    ) => {
      const event = await db.webhookEvent.create({
        data: {
          botId: update.botId,
          dedupKey: randomUUID(),
          semanticKey,
          rawPayload: raw,
          normalizedPayload: JSON.parse(JSON.stringify(update)),
          createdAt: new Date(at + offset),
          executionDeadlineAt: new Date(at + 300_000),
          ...data,
        },
      });
      eventIds.push(event.id);
      return event;
    };
    const observation = await create(10, {
      status: 'PROCESSED',
      processedAt: new Date(at + 20),
      errorMessage: DORMANT_BOT_OBSERVATION_MARKER,
    });
    const owner = await create(100, {
      status: 'QUEUED',
      queueName: 'moderation-default-0',
      queuedAt: new Date(at + 150),
    });
    const claim = await db.webhookExecutionClaim.create({
      data: {
        kind: 'EXECUTION',
        semanticKey,
        webhookEventId: owner.id,
        enforced: true,
        status: 'READY',
        executionBotId: 'fixture-major',
        createdAt: new Date(at + 110),
        preparedAt: new Date(at + 120),
      },
    });
    claimIds.push(claim.id);
    const discarded = await create(200, {
      status: 'FAILED',
      rawPayload: {},
      normalizedPayload: {},
      errorMessage: `WEBHOOK_HOT_PATH_TIMEOUT_TERMINAL_QUARANTINED:OPERATOR_DISCARDED:${randomUUID()}`,
    });
    return { owner, observation, discarded, claim, update: update as MaxUpdate };
  }

  async function snapshot() {
    return {
      events: await db.webhookEvent.findMany({
        where: { id: { in: eventIds } },
        orderBy: { id: 'asc' },
      }),
      claims: await db.webhookExecutionClaim.findMany({
        where: { id: { in: claimIds } },
        orderBy: { id: 'asc' },
      }),
    };
  }

  it.each(['receipt', 'direct_claim', 'claim_start'] as const)(
    'refuses changed %s evidence after waiting on receipt locks',
    async (change) => {
      const f = await fixture();
      const applicationName = `pristine-racer-${randomUUID()}`;
      const racer = createPrismaClient(databaseUrl, { max: 2, application_name: applicationName });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let locked!: () => void;
      const ready = new Promise<void>((resolve) => {
        locked = resolve;
      });
      const blocker = db.$transaction(
        async (tx) => {
          if (change === 'receipt') {
            await tx.webhookEvent.update({
              where: { id: f.owner.id },
              data: { errorMessage: 'Unknown action outcome ambiguous' },
            });
          } else if (change === 'claim_start') {
            await tx.webhookExecutionClaim.update({
              where: { id: f.claim.id },
              data: {
                businessStartedAt: new Date(),
                leaseToken: randomUUID(),
                leaseExpiresAt: new Date(Date.now() + 60_000),
              },
            });
          } else {
            const direct = await tx.webhookExecutionClaim.create({
              data: {
                kind: 'UNKNOWN_DIRECT_EFFECT',
                semanticKey: randomUUID(),
                webhookEventId: f.observation.id,
              },
            });
            claimIds.push(direct.id);
          }
          locked();
          await gate;
        },
        { timeout: 15_000 },
      );
      let pending: Promise<boolean> | undefined;
      try {
        await ready;
        pending = settlePristineOperatorDiscard(racer as never, {
          webhookEventId: f.owner.id,
          update: f.update,
        });
        void pending.catch(() => undefined);
        let blocked = false;
        const deadline = Date.now() + 3_000;
        while (Date.now() < deadline) {
          const [state] = await db.$queryRaw<Array<{ blocked: boolean }>>`
            SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name = ${applicationName}
              AND wait_event_type = 'Lock') AS blocked`;
          if (state?.blocked) {
            blocked = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(blocked).toBe(true);
        release();
        await blocker;
        const before = await snapshot();
        expect(await pending).toBe(false);
        expect(await snapshot()).toEqual(before);
      } finally {
        release();
        await blocker;
        await pending?.catch(() => undefined);
        await racer.$disconnect();
      }
    },
  );

  it('retains the typed owner, pristine claim, dormant anchor and scrubbed witness', async () => {
    const f = await fixture();
    expect(
      await settlePristineOperatorDiscard(db as never, {
        webhookEventId: f.owner.id,
        update: f.update,
      }),
    ).toBe(true);
    const before = await snapshot();
    const retention = Object.create(WebhookOutboxService.prototype) as {
      deleteCompletedWebhookBatch: (cutoff: Date) => Promise<unknown>;
      deleteTerminalFailedWebhookBatch: (cutoff: Date) => Promise<unknown>;
    };
    Object.assign(retention, { prisma: db, webhookRetentionCursors: new Map() });
    await retention.deleteCompletedWebhookBatch(new Date());
    await retention.deleteTerminalFailedWebhookBatch(new Date());
    expect(await snapshot()).toEqual(before);
  });
});
