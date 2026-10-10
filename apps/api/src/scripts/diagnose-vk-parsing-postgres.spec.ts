import { Prisma, createPrismaClient, type PrismaClient } from '../prisma/prisma-client';
import { loadPublishBacklog } from './diagnose-vk-parsing';
import { buildVkMediaDiagnosticQuery, loadMediaDiagnostics } from './vk-media-diagnostics';

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

  it.each([4, 20_000])(
    'bounds media diagnostics before grouping %i retained rows',
    async (size) => {
      await prisma.$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe(`CREATE TEMP TABLE vk_parsing_media_cache (
        id text PRIMARY KEY, url text NOT NULL, media_identity text, status text NOT NULL,
        last_checked_at timestamp, updated_at timestamp NOT NULL, last_error text
      ) ON COMMIT DROP`);
          await tx.$executeRaw`INSERT INTO vk_parsing_media_cache
        SELECT lpad(n::text, 8, '0'), 'https://fixture.invalid/' || n, 'identity-' || n,
          CASE WHEN n % 2 = 0 THEN 'READY' ELSE 'FAILED' END,
          timestamp '2026-10-10 20:00:00', timestamp '2026-10-10 20:00:00',
          CASE WHEN n % 2 = 0 THEN NULL ELSE 'fixture failure' END
        FROM generate_series(1, ${size}::int) n`;
          if (size === 4) {
            await tx.$executeRaw`UPDATE vk_parsing_media_cache
          SET media_identity = 'identity-2', last_checked_at = NULL,
            last_error = repeat('x', 301) || 'P2002'
          WHERE id = '00000004'`;
          }
          if (size > 1000) {
            await tx.$executeRawUnsafe('ANALYZE vk_parsing_media_cache');
            const plan = await tx.$queryRaw<Array<{ 'QUERY PLAN': unknown }>>(
              Prisma.sql`EXPLAIN (FORMAT JSON) ${buildVkMediaDiagnosticQuery()}`,
            );
            const nodes: Array<Record<string, unknown>> = [];
            const walk = (node: any) => {
              nodes.push(node);
              (node.Plans ?? []).forEach(walk);
            };
            walk((plan[0]!['QUERY PLAN'] as any)[0].Plan);
            expect(
              nodes.filter((node) => node['Relation Name'] === 'vk_parsing_media_cache'),
            ).toEqual([
              expect.objectContaining({
                'Node Type': 'Index Scan',
                'Scan Direction': 'Backward',
                'Index Name': 'vk_parsing_media_cache_pkey',
              }),
            ]);
            expect(nodes.find((node) => node['Subplan Name'] === 'CTE bounded')).toMatchObject({
              'Node Type': 'Limit',
              'Plan Rows': 1001,
            });
          }
          const report = await loadMediaDiagnostics(
            tx as PrismaClient,
            new Date('2026-10-10T19:00:00Z'),
            5,
          );
          expect(report.mediaStatus).toEqual([
            expect.objectContaining({ status: 'FAILED', count: Math.min(size, 1000) / 2 }),
            expect.objectContaining({ status: 'READY', count: Math.min(size, 1000) / 2 }),
          ]);
          expect(report.mediaCoverage).toEqual({
            complete: size <= 1000,
            sampleCap: 1000,
            scannedRows: Math.min(size, 1000),
            sourceTruncated: size > 1000,
            sampleBasis: 'id_desc',
          });
          expect(report.recentMediaFailures).toHaveLength(size === 4 ? 3 : 5);
          expect(report.mediaIdentityConflicts).toEqual(
            size === 4
              ? [
                  expect.objectContaining({
                    mediaIdentity: 'identity-2',
                    rowCount: 2,
                    urls: expect.arrayContaining([
                      'https://fixture.invalid/2',
                      'https://fixture.invalid/4',
                    ]),
                  }),
                ]
              : [],
          );
        },
        { timeout: 20_000 },
      );
    },
  );

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
