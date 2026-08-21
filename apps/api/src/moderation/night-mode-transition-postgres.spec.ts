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
});
