import type { Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

import { createPrismaClient, Prisma, type PrismaClient } from '../prisma/prisma-client';
import { NightModeTransitionReconcileService } from './night-mode-transition-reconcile.service';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
const describePostgres = databaseUrl ? describe : describe.skip;

function assertDisposableDatabaseUrl(value: string): void {
  const parsed = new URL(value);
  const databaseName = parsed.pathname.replace(/^\//u, '');
  if (
    !['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname) ||
    !databaseName.includes('race_test')
  ) {
    throw new Error(
      'CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL must target a local database containing race_test',
    );
  }
}

describePostgres('PostgreSQL night mode transition recovery SQL', () => {
  let prisma: PrismaClient;
  const createdRequestChatIds: string[] = [];

  beforeAll(async () => {
    assertDisposableDatabaseUrl(databaseUrl);
    prisma = createPrismaClient(databaseUrl, { max: 2 });
    await prisma.$connect();
  });

  afterEach(async () => {
    if (createdRequestChatIds.length > 0) {
      await prisma.nightModeTransitionReconcileRequest.deleteMany({
        where: { chatId: { in: createdRequestChatIds.splice(0) } },
      });
    }
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('acquires an advisory transaction lock without deserializing its void result', async () => {
    await expect(
      prisma.$transaction((tx) =>
        tx.$executeRaw(Prisma.sql`
          SELECT pg_advisory_xact_lock(hashtextextended(${'night-mode-event-race-test'}, 0::BIGINT))
        `),
      ),
    ).resolves.toEqual(expect.any(Number));
  });

  it('executes the void durable-reconcile function without decoding a result column', async () => {
    const chatId = `night-mode-void-${randomUUID()}`;
    createdRequestChatIds.push(chatId);

    await expect(
      prisma.$executeRaw(Prisma.sql`
        SELECT enqueue_night_mode_transition_reconcile_request(${chatId})
      `),
    ).resolves.toEqual(expect.any(Number));
    await expect(
      prisma.nightModeTransitionReconcileRequest.findUnique({ where: { chatId } }),
    ).resolves.toMatchObject({ chatId, generation: 1n });
  });

  it('renews bigint generation leases through an explicitly typed VALUES relation', async () => {
    const chatId = `night-mode-lease-${randomUUID()}`;
    const leaseToken = randomUUID();
    const initialLeaseExpiresAt = new Date(Date.now() + 15_000);
    createdRequestChatIds.push(chatId);
    await prisma.nightModeTransitionReconcileRequest.create({
      data: {
        chatId,
        generation: 7n,
        leaseToken,
        leaseExpiresAt: initialLeaseExpiresAt,
      },
    });
    const service = new NightModeTransitionReconcileService(prisma as never, {} as never);

    await expect(
      (
        service as unknown as {
          renewBatchLeases(
            requests: Array<{ chat_id: string; generation: bigint }>,
            token: string,
          ): Promise<void>;
        }
      ).renewBatchLeases([{ chat_id: chatId, generation: 7n }], leaseToken),
    ).resolves.toBeUndefined();

    const renewed = await prisma.nightModeTransitionReconcileRequest.findUniqueOrThrow({
      where: { chatId },
      select: { leaseExpiresAt: true },
    });
    expect(renewed.leaseExpiresAt?.getTime()).toBeGreaterThan(initialLeaseExpiresAt.getTime());
  });

  it('preserves a new generation when ownership is revoked after the final retry check', async () => {
    const chatId = `night-mode-retry-cas-${randomUUID()}`;
    const leaseToken = randomUUID();
    createdRequestChatIds.push(chatId);
    await prisma.nightModeTransitionReconcileRequest.create({
      data: {
        chatId,
        generation: 7n,
        leaseToken,
        leaseExpiresAt: new Date(Date.now() + 30_000),
        attemptCount: 3,
        lastErrorCode: 'prior_error',
        lastErrorAt: new Date('2026-05-30T20:00:00.000Z'),
        lastError: 'prior retained error',
        manualBlockedAt: new Date('2026-05-30T19:00:00.000Z'),
        manualBlockedGeneration: 6n,
        manualBlockedCategory: 'unsafe_prior_dispatch',
        manualBlockedReason: 'prior retained manual fence',
        manualBlockedJobId: 'prior-job',
        manualBlockedSessionKey: 'prior-session',
        manualBlockedFingerprint: 'prior-fingerprint',
      },
    });

    let signalRequeue: () => void = () => undefined;
    let releaseRequeue: () => void = () => undefined;
    const requeueStarted = new Promise<void>((resolve) => {
      signalRequeue = resolve;
    });
    const requeueReleased = new Promise<void>((resolve) => {
      releaseRequeue = resolve;
    });
    let affectedRows: number | null = null;
    const database = {
      $queryRaw: (query: Prisma.Sql) => prisma.$queryRaw(query),
      $executeRaw: async (query: Prisma.Sql) => {
        const statement = query.strings.join(' ');
        if (
          statement.includes('UPDATE "night_mode_transition_reconcile_requests"') &&
          statement.includes('"requested_at" =') &&
          statement.includes('"last_error_code" =')
        ) {
          signalRequeue();
          await requeueReleased;
          affectedRows = await prisma.$executeRaw(query);
          return affectedRows;
        }
        return prisma.$executeRaw(query);
      },
    };
    const scheduler = {
      repairAccessSchedule: jest
        .fn()
        .mockRejectedValue(
          new Error('Night mode transition catch-up is still active during durable repair (job-1)'),
        ),
    };
    const service = new NightModeTransitionReconcileService(database as never, scheduler as never);
    const logger = (service as unknown as { logger: Logger }).logger;
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const error = jest.spyOn(logger, 'error').mockImplementation(() => undefined);
    const pending = (
      service as unknown as {
        reconcileRequest(
          request: { chat_id: string; generation: bigint },
          token: string,
        ): Promise<void>;
      }
    ).reconcileRequest({ chat_id: chatId, generation: 7n }, leaseToken);

    try {
      await Promise.race([
        requeueStarted,
        pending.then(() => {
          throw new Error('Reconciliation returned before the retry barrier');
        }),
      ]);
      await prisma.$executeRaw(Prisma.sql`
        SELECT enqueue_night_mode_transition_reconcile_request(${chatId})
      `);
      const superseding = await prisma.nightModeTransitionReconcileRequest.findUniqueOrThrow({
        where: { chatId },
      });
      expect(superseding).toMatchObject({ generation: 8n, leaseToken: null, leaseExpiresAt: null });

      releaseRequeue();
      await pending;

      expect(affectedRows).toBe(0);
      await expect(
        prisma.nightModeTransitionReconcileRequest.findUniqueOrThrow({ where: { chatId } }),
      ).resolves.toEqual(superseding);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        { chatId, generation: '7', phase: 'while persisting retry' },
        'Skipped night mode reconcile work after losing lease ownership',
      );
      expect(error).not.toHaveBeenCalled();
    } finally {
      releaseRequeue();
      try {
        await pending;
      } finally {
        warn.mockRestore();
        error.mockRestore();
      }
    }
  });
});
