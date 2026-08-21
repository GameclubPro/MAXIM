import type { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';

import { createPrismaClient, Prisma, type PrismaClient } from '../prisma/prisma-client';
import { SystemDashboardService } from './system-dashboard.service';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
const describePostgres = databaseUrl ? describe : describe.skip;

jest.setTimeout(60_000);

type ExplainRow = { 'QUERY PLAN': unknown };
type ExplainNode = Record<string, unknown>;
type SeededFixture = {
  auditPrefix: string;
  chatId: string;
  ledgerPrefix: string;
  targetLedgerId: string;
};
type LedgerPageRow = { ledgerId: string; updatedAt: Date };
type LedgerAuditSnapshot = {
  missingAudit: number;
  pendingAudit: number;
  publishedAudit: number;
  mismatchedAudit: number;
  linkedPublishing: number;
  audited: number;
  capped: boolean;
};

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

function createService(prisma: PrismaClient): SystemDashboardService {
  const config = {
    get: (_key: string, fallback: unknown) => fallback,
  } as ConfigService;
  return new SystemDashboardService(
    {} as never,
    {} as never,
    config,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    prisma as never,
  );
}

function collectExplainNodes(value: unknown, nodes: ExplainNode[] = []): ExplainNode[] {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectExplainNodes(item, nodes);
    }
    return nodes;
  }
  if (!value || typeof value !== 'object') {
    return nodes;
  }
  const record = value as Record<string, unknown>;
  if (typeof record['Node Type'] === 'string') {
    nodes.push(record);
  }
  for (const child of Object.values(record)) {
    collectExplainNodes(child, nodes);
  }
  return nodes;
}

describePostgres('PostgreSQL system dashboard suggestion ledger audit', () => {
  let pool: Pool;
  let prisma: PrismaClient;
  const fixtures: SeededFixture[] = [];

  beforeAll(async () => {
    assertDisposableDatabaseUrl(databaseUrl);
    pool = new Pool({
      connectionString: databaseUrl,
      max: 4,
      connectionTimeoutMillis: 5_000,
      statement_timeout: 15_000,
    });
    prisma = createPrismaClient(databaseUrl, { max: 3, statement_timeout: 15_000 });
    await prisma.$connect();
    const index = await pool.query<{ present: boolean }>(
      `SELECT to_regclass(
        'public.max_action_ledger_suggestion_publish_updated_id_idx'
      ) IS NOT NULL AS present`,
    );
    expect(index.rows[0]?.present).toBe(true);
  });

  afterEach(async () => {
    for (const fixture of fixtures.splice(0)) {
      await pool.query('DELETE FROM max_action_ledger WHERE left(id, length($1)) = $1', [
        fixture.ledgerPrefix,
      ]);
      await pool.query('DELETE FROM audit_logs WHERE left(id, length($1)) = $1', [
        fixture.auditPrefix,
      ]);
      await pool.query('DELETE FROM chats WHERE id = $1', [fixture.chatId]);
    }
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await pool?.end();
  });

  async function seedOrphanLedgerRows(count: number): Promise<SeededFixture> {
    const suffix = randomUUID();
    const fixture: SeededFixture = {
      auditPrefix: `dashboard-suggestion-${suffix}-`,
      chatId: `dashboard-suggestion-chat-${suffix}`,
      ledgerPrefix: `ledger-dashboard-suggestion-${suffix}-`,
      targetLedgerId: `ledger-dashboard-suggestion-${suffix}-0000`,
    };
    fixtures.push(fixture);
    await pool.query(
      `INSERT INTO chats (
        id, title, entity_type, catalog_kind, routing_state, routing_version, updated_at
      ) VALUES ($1, 'Dashboard suggestion audit', 'CHANNEL', 'MANAGED', 'READY', 0, CURRENT_TIMESTAMP)`,
      [fixture.chatId],
    );
    await pool.query(
      `WITH slots AS (
        SELECT generate_series(0, $3::integer - 1) AS slot
      )
      INSERT INTO audit_logs (id, chat_id, actor_user_id, action, payload, created_at)
      SELECT
        $1 || lpad(slot::text, 4, '0'),
        $2,
        'dashboard-native-author',
        'CHANNEL_DIALOG_SUGGESTION',
        jsonb_build_object(
          'type', 'suggest',
          'reviewStatus', 'publishing',
          'reviewAction', 'publish',
          'reviewPublicationProtocol', 'max_action_ledger_v1',
          'reviewPublicationLedgerJobId',
            'channel-suggestion:publish:v1:' || $1 || lpad(slot::text, 4, '0'),
          'reviewClaimToken', 'claim-' || lpad(slot::text, 4, '0'),
          'reviewClaimedAt', '2099-01-01T00:00:00.000Z',
          'reviewClaimedByUserId', 'dashboard-native-admin'
        ),
        timestamp '2099-01-01 00:00:00'
      FROM slots`,
      [fixture.auditPrefix, fixture.chatId, count],
    );
    await pool.query(
      `WITH slots AS (
        SELECT generate_series(0, $4::integer - 1) AS slot
      )
      INSERT INTO max_action_ledger (
        id, job_id, action_type, chat_id, source_tag, metadata, updated_at
      )
      SELECT
        $1 || lpad(slot::text, 4, '0'),
        'channel-suggestion:publish:v1:' || $2 || lpad(slot::text, 4, '0'),
        'SEND_MESSAGE',
        $3,
        'suggestion_delivery',
        NULL,
        timestamp '2099-01-01 00:00:00' + slot * interval '1 millisecond'
      FROM slots`,
      [fixture.ledgerPrefix, fixture.auditPrefix, fixture.chatId, count],
    );
    await pool.query('DELETE FROM audit_logs WHERE left(id, length($1)) = $1', [
      fixture.auditPrefix,
    ]);
    return fixture;
  }

  it('uses the exact partial composite index condition for the newest-first page', async () => {
    await seedOrphanLedgerRows(2);
    const service = createService(prisma);
    const subject = service as unknown as {
      buildSuggestionLedgerAuditPageQuery(params: {
        checkedAt: Date;
        cursor: { ledgerId: string; updatedAt: Date };
        take: number;
      }): Prisma.Sql;
    };
    const query = subject.buildSuggestionLedgerAuditPageQuery({
      checkedAt: new Date('2099-01-02T00:00:00.000Z'),
      cursor: {
        ledgerId: 'ledger-dashboard-cursor',
        updatedAt: new Date('2099-01-01T12:00:00.000Z'),
      },
      take: 251,
    });

    const rows = await prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SET LOCAL enable_seqscan = off`;
        await tx.$executeRaw`SET LOCAL enable_bitmapscan = off`;
        return tx.$queryRaw<ExplainRow[]>(Prisma.sql`EXPLAIN (FORMAT JSON, COSTS FALSE) ${query}`);
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
    const indexNode = collectExplainNodes(rows[0]?.['QUERY PLAN']).find(
      (node) => node['Index Name'] === 'max_action_ledger_suggestion_publish_updated_id_idx',
    );

    expect(indexNode).toBeDefined();
    expect(indexNode?.['Scan Direction']).toBe('Backward');
    const indexCondition = String(indexNode?.['Index Cond'] ?? '').replaceAll('"', '');
    expect(indexCondition).toContain('updated_at <=');
    expect(indexCondition).toMatch(/ROW\(updated_at, id\) < ROW\(/u);
  });

  it('keeps an unprocessed row visible when its updated_at moves between pages', async () => {
    const fixture = await seedOrphanLedgerRows(300);
    const service = createService(prisma);
    const subject = service as unknown as {
      loadSuggestionLedgerAudit(checkedAt: Date): Promise<LedgerAuditSnapshot>;
      loadSuggestionLedgerAuditPage(
        tx: Prisma.TransactionClient,
        params: {
          checkedAt: Date;
          cursor: { ledgerId: string; updatedAt: Date } | null;
          take: number;
        },
      ): Promise<LedgerPageRow[]>;
    };
    const originalPage = subject.loadSuggestionLedgerAuditPage.bind(service);
    const pageLedgerIds: string[][] = [];
    let pageCalls = 0;
    let firstPageReady!: () => void;
    let resumeScan!: () => void;
    const firstPage = new Promise<void>((resolve) => {
      firstPageReady = resolve;
    });
    const scanGate = new Promise<void>((resolve) => {
      resumeScan = resolve;
    });
    let observedIsolationLevel: string | null = null;
    subject.loadSuggestionLedgerAuditPage = async (tx, params) => {
      const rows = await originalPage(tx, params);
      pageCalls += 1;
      pageLedgerIds.push(rows.map((row) => row.ledgerId));
      if (pageCalls === 1) {
        const isolation = await tx.$queryRawUnsafe<Array<{ transaction_isolation: string }>>(
          'SHOW transaction_isolation',
        );
        observedIsolationLevel = isolation[0]?.transaction_isolation ?? null;
        firstPageReady();
        await scanGate;
      }
      return rows;
    };

    const scan = subject.loadSuggestionLedgerAudit(new Date('2099-01-02T00:00:00.000Z'));
    await firstPage;
    let updateError: unknown = null;
    try {
      await pool.query(
        `UPDATE max_action_ledger
        SET updated_at = $2::timestamp(3)
        WHERE id = $1`,
        [fixture.targetLedgerId, new Date('2099-01-01T23:00:00.000Z')],
      );
    } catch (error: unknown) {
      updateError = error;
    } finally {
      resumeScan();
    }
    const snapshot = await scan;
    if (updateError) {
      throw updateError;
    }

    expect(observedIsolationLevel).toBe('repeatable read');
    expect(pageCalls).toBeGreaterThanOrEqual(2);
    expect(pageLedgerIds[0]).not.toContain(fixture.targetLedgerId);
    expect(pageLedgerIds.slice(1).flat()).toContain(fixture.targetLedgerId);
    expect(snapshot).toMatchObject({
      missingAudit: expect.any(Number),
      audited: expect.any(Number),
      capped: false,
    });
    expect(snapshot.missingAudit).toBeGreaterThanOrEqual(300);
    expect(
      snapshot.missingAudit +
        snapshot.pendingAudit +
        snapshot.publishedAudit +
        snapshot.mismatchedAudit +
        snapshot.linkedPublishing,
    ).toBe(snapshot.audited);
  });
});
