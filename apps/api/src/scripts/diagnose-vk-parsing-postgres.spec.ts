import { createPrismaClient, type PrismaClient } from '../prisma/prisma-client';
import { loadPublishBacklog } from './diagnose-vk-parsing';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
const describePostgres = databaseUrl ? describe : describe.skip;

jest.setTimeout(30_000);

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

describePostgres('PostgreSQL VK parsing diagnostics', () => {
  let prisma: PrismaClient;

  beforeAll(async () => {
    assertDisposableDatabaseUrl(databaseUrl);
    prisma = createPrismaClient(databaseUrl, { max: 1, statement_timeout: 10_000 });
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  it('executes the Publisher backlog aggregate', async () => {
    await expect(
      loadPublishBacklog(prisma, 'diagnostic-postgres-test-nonexistent-bot'),
    ).resolves.toEqual({
      queuedPosts: 0,
      dueQueuedPosts: 0,
      futureScheduledPosts: 0,
      unstampedSchedulePosts: 0,
      staleLockedPosts: 0,
      oldestDueQueuedAgeSec: null,
      oldestDueQueuedAt: null,
      nextScheduledAt: null,
      secondsToNext: null,
    });
  });
});
