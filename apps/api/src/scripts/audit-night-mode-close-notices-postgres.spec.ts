import { randomUUID } from 'node:crypto';
import { Prisma, PrismaClient, createPrismaAdapter } from '../prisma/prisma-client';
import { loadChatClosureRecoveryRegistryRows } from '../admin/chat-closure-notice-diagnostics';
import {
  buildNightModeAuditCursorQuery,
  loadExactNightModeCloseNoticeRegistryRows,
} from './audit-night-mode-close-notices';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
const describePostgres = databaseUrl ? describe : describe.skip;
const createClient = () =>
  new PrismaClient({
    adapter: createPrismaAdapter(databaseUrl, { max: 1, statement_timeout: 10_000 }),
    log: [{ emit: 'event', level: 'query' }],
  });
type PlanNode = {
  'Node Type': string;
  'Relation Name'?: string;
  'Actual Rows': number;
  'Actual Loops': number;
  'Rows Removed by Filter'?: number;
  Plans?: PlanNode[];
};
type ExplainRow = { 'QUERY PLAN': Array<{ Plan: PlanNode }> };
function nodes(node: PlanNode): PlanNode[] {
  return [node, ...(node.Plans ?? []).flatMap(nodes)];
}

jest.setTimeout(30_000);

describePostgres('night-mode audit bounded PostgreSQL reads', () => {
  let prisma: ReturnType<typeof createClient>;
  const queries: Prisma.QueryEvent[] = [];
  beforeAll(async () => {
    const url = new URL(databaseUrl);
    if (
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
      !url.pathname.includes('race_test')
    )
      throw new Error('Night-mode audit test requires an isolated local race_test database');
    prisma = createClient();
    prisma.$on('query', (event) => queries.push(event));
    await prisma.$connect();
  });
  afterAll(async () => {
    await prisma?.$disconnect();
  });

  it('visits at most one raw page despite a disabled prefix and sparse enabled tail', async () => {
    await prisma.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(`CREATE TEMP TABLE chat_settings (
        chat_id text PRIMARY KEY, night_mode_enabled boolean NOT NULL
      ) ON COMMIT DROP`);
        await tx.$executeRaw`INSERT INTO chat_settings
        SELECT lpad(n::text, 8, '0'), n > 39990 FROM generate_series(1, 40000) n`;
        await tx.$executeRawUnsafe('ANALYZE chat_settings');
        for (const after of [null, '00020000', '00039900']) {
          const query = buildNightModeAuditCursorQuery(after, 100);
          const plan = await tx.$queryRaw<ExplainRow[]>(
            Prisma.sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query}`,
          );
          const scans = nodes(plan[0]!['QUERY PLAN'][0]!.Plan).filter(
            (node) => node['Relation Name'] === 'chat_settings',
          );
          expect(scans).toHaveLength(1);
          expect(scans[0]).toMatchObject({ 'Node Type': 'Index Scan', 'Actual Rows': 100 });
          expect(scans[0]!['Rows Removed by Filter'] ?? 0).toBe(0);
          const rows =
            await tx.$queryRaw<Array<{ chatId: string; nightModeEnabled: boolean }>>(query);
          expect(rows).toHaveLength(100);
          expect(rows.at(-1)?.chatId).toBe(
            after === null ? '00000100' : after === '00020000' ? '00020100' : '00040000',
          );
          expect(rows.filter((row) => row.nightModeEnabled)).toHaveLength(
            after === '00039900' ? 10 : 0,
          );
        }
      },
      { timeout: 20_000 },
    );
  });

  it('uses exact registry identities against retained history without scanning other jobs', async () => {
    await prisma.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(`CREATE TEMP TABLE night_mode_transition_scheduled_jobs (
        chat_id text NOT NULL, job_id text NOT NULL, transition text NOT NULL,
        session_key text NOT NULL, scheduled_for timestamp NOT NULL,
        schedule_fingerprint text NOT NULL, runtime_version int NOT NULL, recovery_payload jsonb,
        PRIMARY KEY(chat_id, job_id)
      ) ON COMMIT DROP`);
        await tx.$executeRaw`INSERT INTO night_mode_transition_scheduled_jobs
        SELECT 'chat-' || (n % 7), 'job-' || n, 'close', 'session-' || n,
          timestamp '2026-10-01', 'fingerprint', 4, NULL FROM generate_series(1, 40000) n`;
        await tx.$executeRawUnsafe('ANALYZE night_mode_transition_scheduled_jobs');
        let captured: Prisma.Sql | undefined;
        const store = {
          $queryRaw: <T>(query: TemplateStringsArray | Prisma.Sql) => {
            if (!('sql' in query)) throw new Error('Expected a parameterized query');
            captured = query;
            return tx.$queryRaw<T>(query);
          },
        };
        type Occurrence = Parameters<typeof loadExactNightModeCloseNoticeRegistryRows>[1][number];
        const occurrence = (n: number): Occurrence => ({
          scope: 'latest',
          transition: 'close',
          enabledNow: true,
          catchUp: { state: 'expired', endsAt: '2026-10-02T00:00:00.000Z' },
          chatId: `chat-${n % 7}`,
          sessionKey: `session-${n}`,
          dueAt: new Date('2026-10-01T00:00:00Z'),
          registryJobId: `job-${n}`,
          ledgerJobId: `ledger-${n}`,
          scheduleFingerprint: 'fingerprint',
          scheduleExpected: true,
        });
        const rows = await loadExactNightModeCloseNoticeRegistryRows(store, [
          occurrence(1),
          occurrence(39999),
          occurrence(1),
        ]);
        expect(rows).toHaveLength(2);
        expect(captured!.values).toHaveLength(4);
        const plan = await tx.$queryRaw<ExplainRow[]>(
          Prisma.sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${captured!}`,
        );
        const scans = nodes(plan[0]!['QUERY PLAN'][0]!.Plan).filter(
          (node) => node['Relation Name'] === 'night_mode_transition_scheduled_jobs',
        );
        expect(
          scans.every(
            (node) =>
              node['Node Type'].includes('Index') || node['Node Type'] === 'Bitmap Heap Scan',
          ),
        ).toBe(true);
        expect(
          scans.reduce((sum, node) => sum + node['Actual Rows'] * node['Actual Loops'], 0),
        ).toBeLessThanOrEqual(2);
        expect(scans.reduce((sum, node) => sum + (node['Rows Removed by Filter'] ?? 0), 0)).toBe(0);
      },
      { timeout: 20_000 },
    );
  });

  it('bounds the actual API recovery query before inspecting sparse recovery payloads', async () => {
    const chatId = `audit-recovery-${randomUUID()}`;
    const rollback = new Error('roll back disposable diagnostic history');
    await expect(
      prisma.$transaction(
        async (tx) => {
          await tx.$executeRaw`INSERT INTO night_mode_transition_scheduled_jobs
        (chat_id, job_id, transition, session_key, scheduled_for, schedule_fingerprint, runtime_version, updated_at)
        SELECT ${chatId}, 'job-' || lpad(n::text, 8, '0'), 'close', 'session-' || n,
          timestamp '2026-10-01' + n * interval '1 second', 'fingerprint', 4, now()
        FROM generate_series(1, 40000) n`;
          await tx.$executeRawUnsafe('ANALYZE night_mode_transition_scheduled_jobs');
          queries.length = 0;
          const rows = await loadChatClosureRecoveryRegistryRows(tx, chatId);
          expect(rows).toHaveLength(33);
          expect(rows[0]!.jobId).toBe('job-00040000');
          expect(rows[32]!.jobId).toBe('job-00039968');
          const actual = queries.find((event) => event.query.startsWith('SELECT'))!;
          expect(actual).toBeDefined();
          const plan = await tx.$queryRawUnsafe<ExplainRow[]>(
            `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${actual.query}`,
            ...JSON.parse(actual.params),
          );
          const scans = nodes(plan[0]!['QUERY PLAN'][0]!.Plan).filter(
            (node) => node['Relation Name'] === 'night_mode_transition_scheduled_jobs',
          );
          expect(scans).toHaveLength(1);
          expect(scans[0]).toMatchObject({ 'Node Type': 'Index Scan', 'Actual Rows': 33 });
          expect(scans[0]!['Rows Removed by Filter'] ?? 0).toBe(0);
          throw rollback;
        },
        { timeout: 20_000 },
      ),
    ).rejects.toBe(rollback);
  });
});
