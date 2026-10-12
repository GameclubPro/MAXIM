import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { createPrismaClient, Prisma, type PrismaClient } from '../prisma/prisma-client';
import { WebhookParser } from './webhook.parser';
import { WebhookService } from './webhook.service';
import { buildWebhookSemanticEventKey } from './webhook-semantic-event-key';
import { quarantineLegacyRemovalMirror } from './webhook-legacy-removal-mirror';
import { writeWebhookEnqueueState } from './webhook-receipt-write';
import { QueueMetricsService } from '../system/queue-metrics.service';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
const native = databaseUrl ? describe : describe.skip;
const marker =
  'WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINED:LEGACY_EXECUTION_UNVERIFIED; exact effects proof required';
const deferred =
  'Webhook preparation deferred: Legacy semantic execution requires exact proof recovery';

native.each(['user_removed', 'message_removed'] as const)(
  'quarantined %s mirror on native PostgreSQL',
  (eventType) => {
    jest.setTimeout(30000);
    let prisma: PrismaClient;
    const ids: string[] = [];
    beforeAll(async () => {
      const url = new URL(databaseUrl);
      if (
        !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
        !url.pathname.includes('race_test')
      )
        throw new Error('Disposable loopback PostgreSQL required');
      prisma = createPrismaClient(databaseUrl, { max: 4, statement_timeout: 10000 });
    });
    afterEach(async () => {
      await prisma.webhookExecutionClaim.deleteMany({ where: { webhookEventId: { in: ids } } });
      await prisma.webhookEvent.deleteMany({ where: { id: { in: ids.splice(0) } } });
    });
    afterAll(async () => {
      await prisma?.$disconnect();
    });
    async function fixture() {
      const at = new Date(Date.now() - 600000);
      const payload = new WebhookParser().parse(
        {
          update_type: eventType,
          message_id: eventType === 'message_removed' ? randomUUID() : undefined,
          update_id: randomUUID(),
          chat_id: '-fixture-' + randomUUID(),
          user: { user_id: randomUUID() },
          timestamp: at.getTime(),
        },
        { botId: 'major-1' },
      );
      const semanticKey = buildWebhookSemanticEventKey(payload)!;
      expect(semanticKey).toBeTruthy();
      const owner = await prisma.webhookEvent.create({
        data: {
          dedupKey: randomUUID(),
          semanticKey,
          normalizedPayload: payload as unknown as Prisma.InputJsonValue,
          rawPayload: payload.raw as Prisma.InputJsonValue,
          createdAt: at,
          status: 'FAILED',
          errorMessage: marker,
        },
      });
      ids.push(owner.id);
      const mirrorPayload = { ...payload, botId: 'major-2', updateId: randomUUID() };
      const mirror = await prisma.webhookEvent.create({
        data: {
          dedupKey: randomUUID(),
          semanticKey,
          normalizedPayload: mirrorPayload as unknown as Prisma.InputJsonValue,
          rawPayload: mirrorPayload.raw as Prisma.InputJsonValue,
          createdAt: new Date(at.getTime() + 5),
          errorMessage: deferred,
          nextEnqueueAt: new Date(),
        },
      });
      ids.push(mirror.id);
      const claim = await prisma.webhookExecutionClaim.create({
        data: {
          kind: 'EXECUTION',
          semanticKey,
          webhookEventId: owner.id,
          enforced: true,
          status: 'PENDING',
          // FLAG: Match a modern claim whose source was already quarantined. The new
          // source-clock tolerance must not release an installed no-replay hold.
          createdAt: new Date(),
        },
      });
      const input = { mirrorId: mirror.id, ownerId: owner.id, claimId: claim.id, semanticKey };
      return { owner, mirror, claim, input, mirrorPayload };
    }
    it('propagates only quarantine through actual preparation, retaining every source and claim field', async () => {
      const { owner, mirror, claim, mirrorPayload } = await fixture();
      const metrics = new QueueMetricsService(
        prisma as never,
        {} as never,
        { get: () => undefined } as never,
        {} as never,
      );
      expect((await metrics.getLagSnapshot({ maxAgeMs: 0 })).effectiveLagSec).toBeGreaterThan(590);
      const ingress = new WebhookService(
        prisma as never,
        new ConfigService({ WEBHOOK_CANONICAL_EXECUTION_MODE: 'on' }),
        {} as never,
      );
      const forbidden = jest.fn(() => {
        throw new Error('No business preparation or MAX effects allowed');
      });
      Object.assign(ingress, {
        prepareWebhookEventCore: forbidden,
        maxClient: new Proxy({}, { get: () => forbidden }),
      });
      try {
        await expect(
          ingress.preparePersistedWebhookEvent(mirror.id, undefined, mirrorPayload),
        ).rejects.toThrow('Legacy semantic execution requires exact proof recovery');
        expect(forbidden).not.toHaveBeenCalled();
        expect(await prisma.webhookEvent.findUnique({ where: { id: owner.id } })).toEqual(owner);
        expect(await prisma.webhookExecutionClaim.findUnique({ where: { id: claim.id } })).toEqual(
          claim,
        );
        expect(await prisma.webhookEvent.findUnique({ where: { id: mirror.id } })).toEqual({
          ...mirror,
          status: 'FAILED',
          nextEnqueueAt: null,
          errorMessage: marker,
        });
        // A deferral scheduled from the stale outbox snapshot cannot revive the mirror.
        expect(
          await writeWebhookEnqueueState(prisma, mirror, {
            status: 'RECEIVED',
            errorMessage: deferred,
            nextEnqueueAt: new Date(),
            timeoutQuarantineExpiresAt: null,
          }),
        ).toEqual({ count: 0 });
        expect(await metrics.getLagSnapshot({ maxAgeMs: 0 })).toMatchObject({
          effectiveLagSec: 0,
          operationalLagSec: 0,
        });
      } finally {
        await ingress.onModuleDestroy();
      }
    });
    it.each([
      'prepared',
      'started',
      'leased',
      'result',
      'queued',
      'attempted',
      'ambiguous',
      'wrong-source',
      'independent',
      'wrong-marker',
    ])('refuses %s evidence without rewriting the receipt', async (variant) => {
      const { mirror, claim, owner, input } = await fixture();
      if (variant === 'prepared')
        await prisma.webhookExecutionClaim.update({
          where: { id: claim.id },
          data: { preparedAt: new Date() },
        });
      if (variant === 'started')
        await prisma.webhookExecutionClaim.update({
          where: { id: claim.id },
          data: { businessStartedAt: new Date() },
        });
      if (variant === 'leased')
        await prisma.webhookExecutionClaim.update({
          where: { id: claim.id },
          data: { leaseToken: randomUUID(), leaseExpiresAt: new Date() },
        });
      if (variant === 'result')
        await prisma.webhookExecutionClaim.update({
          where: { id: claim.id },
          data: { commandResult: { kind: 'unknown' } },
        });
      if (variant === 'queued')
        await prisma.webhookEvent.update({
          where: { id: mirror.id },
          data: { queuedAt: new Date() },
        });
      if (variant === 'attempted')
        await prisma.webhookEvent.update({
          where: { id: mirror.id },
          data: { enqueueAttempts: 1 },
        });
      if (variant === 'ambiguous')
        await prisma.webhookEvent.update({
          where: { id: mirror.id },
          data: { errorMessage: 'ambiguous' },
        });
      if (variant === 'wrong-source')
        await prisma.webhookEvent.update({
          where: { id: mirror.id },
          data: { normalizedPayload: { type: 'message_created' } },
        });
      if (variant === 'independent')
        await prisma.webhookExecutionClaim.create({
          data: { kind: 'OTHER', semanticKey: randomUUID(), webhookEventId: mirror.id },
        });
      if (variant === 'wrong-marker')
        await prisma.webhookEvent.update({
          where: { id: owner.id },
          data: { errorMessage: 'other failure' },
        });
      const before = await prisma.webhookEvent.findUnique({ where: { id: mirror.id } });
      expect(await quarantineLegacyRemovalMirror(prisma as never, input)).toBe(false);
      expect(await prisma.webhookEvent.findUnique({ where: { id: mirror.id } })).toEqual(before);
    });
    it('has one winner under competing propagation and never completes the claim', async () => {
      const { input, claim } = await fixture();
      const result = await Promise.all([
        quarantineLegacyRemovalMirror(prisma as never, input),
        quarantineLegacyRemovalMirror(prisma as never, input),
      ]);
      expect(result.sort()).toEqual([false, true]);
      expect(await prisma.webhookExecutionClaim.findUnique({ where: { id: claim.id } })).toEqual(
        claim,
      );
    });
  },
);
