import { Client } from 'pg';
import { type Prisma } from '../prisma/prisma-client';
import {
  buildPrivateImageReceiptPageSql,
  buildPrivateImageSamplePageSql,
  type PrivateImagePageCursor,
} from './export-commercial-private-images';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
const describePostgres = databaseUrl ? describe : describe.skip;
const since = '2026-10-05T10:00:00.000Z';
const until = '2026-10-05T11:00:00.000Z';
const paddingAt = '2026-10-05T09:51:00.000Z';

type SampleRow = { id: string; observedAt: Date; source: string; qualityMetadata: unknown };
type ReceiptRow = { id: string; createdAt: Date; normalizedPayload: { type: string } };
type PlanNode = Record<string, unknown>;

function collectPlanNodes(value: unknown): PlanNode[] {
  if (Array.isArray(value)) return value.flatMap(collectPlanNodes);
  if (!value || typeof value !== 'object') return [];
  const node = value as PlanNode;
  return [
    ...(typeof node['Node Type'] === 'string' ? [node] : []),
    ...Object.values(node).flatMap(collectPlanNodes),
  ];
}

jest.setTimeout(30_000);

describePostgres('private commercial image export PostgreSQL pages', () => {
  let client: Client;
  let sampleIndex: string;
  let receiptIndexes: string[];

  async function query<Row extends Record<string, unknown>>(sql: Prisma.Sql): Promise<Row[]> {
    return (await client.query<Row>(sql.text, sql.values)).rows;
  }

  async function expectBoundedIndexPage(
    sql: Prisma.Sql,
    relation: string,
    indexes: string[],
    materialized = false,
  ) {
    const explain = await client.query(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql.text}`,
      sql.values,
    );
    const nodes = collectPlanNodes(explain.rows);
    const scans = nodes.filter(
      (node) => node['Relation Name'] === relation && Number(node['Actual Loops']) > 0,
    );
    expect(scans).toHaveLength(1);
    expect(indexes).toContain(scans[0]!['Index Name']);
    expect(scans[0]!['Node Type']).not.toBe('Seq Scan');
    // FLAG: LIMIT output alone is not a work bound; include rows discarded inside the scan.
    const work =
      Number(scans[0]!['Actual Loops']) *
      (Number(scans[0]!['Actual Rows']) +
        Number(scans[0]!['Rows Removed by Filter'] ?? 0) +
        Number(scans[0]!['Rows Removed by Index Recheck'] ?? 0));
    expect(work).toBeGreaterThan(0);
    expect(work).toBeLessThanOrEqual(500);
    if (materialized) expect(nodes.some((node) => node['Node Type'] === 'CTE Scan')).toBe(true);
  }

  beforeAll(async () => {
    const url = new URL(databaseUrl);
    if (
      !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      !url.pathname.includes('race_test')
    )
      throw new Error('Private export tests require a disposable local race_test database');
    client = new Client({
      connectionString: databaseUrl,
      statement_timeout: 10_000,
      query_timeout: 15_000,
    });
    await client.connect();
    await client.query("SET TIME ZONE 'UTC'");
    // Clone migrated tables and their actual indexes; fixtures never touch shared table rows.
    await client.query(
      'CREATE TEMP TABLE commercial_review_samples (LIKE public.commercial_review_samples INCLUDING DEFAULTS INCLUDING INDEXES)',
    );
    await client.query(
      'CREATE TEMP TABLE webhook_events (LIKE public.webhook_events INCLUDING DEFAULTS INCLUDING INDEXES)',
    );
    const indexes = (
      await client.query<{ name: string; definition: string; relation: string }>(`
      SELECT index_relation.relname AS name, pg_get_indexdef(index_relation.oid) AS definition,
        table_relation.relname AS relation
      FROM pg_index i
      JOIN pg_class index_relation ON index_relation.oid = i.indexrelid
      JOIN pg_class table_relation ON table_relation.oid = i.indrelid
      WHERE i.indrelid IN ('pg_temp.commercial_review_samples'::regclass, 'pg_temp.webhook_events'::regclass)
    `)
    ).rows;
    const sample = indexes.find(
      (index) =>
        index.relation === 'commercial_review_samples' &&
        /USING btree \(observed_at DESC, id DESC\)/u.test(index.definition),
    );
    if (!sample) throw new Error('Migrated blind sample cursor index is required');
    sampleIndex = sample.name;
    receiptIndexes = indexes
      .filter(
        (index) =>
          index.relation === 'webhook_events' &&
          (/USING btree \(status, created_at\)/u.test(index.definition) ||
            /USING btree \(created_at, id\).*WHERE.*PROCESSED.*DUPLICATE/u.test(index.definition)),
      )
      .map((index) => index.name);
    expect(receiptIndexes.length).toBeGreaterThan(0);
  });

  afterAll(async () => {
    await client?.end();
  });

  beforeEach(async () => {
    await client.query('TRUNCATE pg_temp.commercial_review_samples, pg_temp.webhook_events');
    await client.query(`
      INSERT INTO commercial_review_samples
        (id, chat_id, user_id, message_id, source, evidence_hash, score, evidence, observed_at, expires_at, updated_at)
      SELECT 'history-sample-' || n, 'test-chat', 'test-user', 'history-message-' || n,
        'TEXT', 'history-evidence-' || n, 0, '{}'::jsonb,
        '2026-10-01T00:00:00Z'::timestamp, '2026-10-20T00:00:00Z'::timestamp, '2026-10-01T00:00:00Z'::timestamp
      FROM generate_series(1, 20000) n
    `);
    await client.query(`
      INSERT INTO webhook_events (id, dedup_key, status, raw_payload, normalized_payload, created_at)
      SELECT 'history-receipt-' || n, 'history-dedup-' || n, 'PROCESSED', '{}'::jsonb,
        '{"type":"message_callback"}'::jsonb, '2026-10-01T00:00:00Z'::timestamp
      FROM generate_series(1, 20000) n
    `);
  });

  it('advances from raw TEXT-only pages and seeks within tied sample timestamps', async () => {
    await client.query(
      `
      INSERT INTO commercial_review_samples
        (id, chat_id, user_id, message_id, source, evidence_hash, score, evidence, quality_metadata, observed_at, expires_at, updated_at)
      SELECT 'sample-' || lpad(n::text, 4, '0'), 'test-chat', 'test-user', 'message-' || n,
        CASE WHEN n <= 1000 THEN 'TEXT' ELSE 'OCR' END, 'evidence-' || n, 0, '{}'::jsonb,
        jsonb_build_object('fixture', n), $1::timestamp, $2::timestamp, $1::timestamp
      FROM generate_series(1, 1005) n
    `,
      [since, until],
    );
    await client.query(
      `
      INSERT INTO commercial_review_samples
        (id, chat_id, user_id, message_id, source, evidence_hash, score, evidence, observed_at, expires_at, updated_at)
      VALUES ('until-sample', 'test-chat', 'test-user', 'until-message', 'OCR', 'until-evidence', 0, '{}'::jsonb, $1, $1, $1)
    `,
      [until],
    );
    await client.query('ANALYZE pg_temp.commercial_review_samples');
    const pages: SampleRow[][] = [];
    let cursor: PrivateImagePageCursor | undefined;
    for (let page = 0; page < 4; page++) {
      const sql = buildPrivateImageSamplePageSql({ since, until, cursor, pageSize: 500 });
      const rows = await query<SampleRow>(sql);
      pages.push(rows);
      if (!rows.length) break;
      await expectBoundedIndexPage(sql, 'commercial_review_samples', [sampleIndex]);
      const last = rows.at(-1)!;
      cursor = { createdAt: last.observedAt, id: last.id };
    }
    expect(pages.map((rows) => rows.length)).toEqual([500, 500, 5, 0]);
    expect(
      pages
        .slice(0, 2)
        .flat()
        .every((row) => row.source === 'TEXT'),
    ).toBe(true);
    expect(pages[2]!.every((row) => row.source === 'OCR')).toBe(true);
    const ids = pages.flat().map((row) => row.id);
    expect(new Set(ids).size).toBe(1005);
    expect(ids).toEqual(
      Array.from({ length: 1005 }, (_, n) => `sample-${String(n + 1).padStart(4, '0')}`),
    );
    expect(ids).not.toContain('until-sample');
  });

  it('passes noisy padding receipts and continues exactly across tied source timestamps', async () => {
    await client.query(
      `
      INSERT INTO webhook_events (id, dedup_key, status, raw_payload, normalized_payload, created_at)
      SELECT 'noise-' || lpad(n::text, 4, '0'), 'noise-dedup-' || n, 'PROCESSED', '{}'::jsonb,
        '{"type":"message_callback"}'::jsonb, $1::timestamp
      FROM generate_series(1, 1000) n
    `,
      [paddingAt],
    );
    await client.query(
      `
      INSERT INTO webhook_events (id, dedup_key, status, raw_payload, normalized_payload, created_at)
      SELECT 'source-' || lpad(n::text, 4, '0'), 'source-dedup-' || n, 'PROCESSED', '{}'::jsonb,
        jsonb_build_object('type', CASE WHEN n % 2 = 0 THEN 'message_edited' ELSE 'message_created' END), $1::timestamp
      FROM generate_series(1, 5) n
    `,
      [since],
    );
    await client.query(
      `
      INSERT INTO webhook_events (id, dedup_key, status, raw_payload, normalized_payload, created_at)
      VALUES ('not-processed', 'not-processed-dedup', 'QUEUED', '{}'::jsonb, '{"type":"message_created"}'::jsonb, $1)
    `,
      [paddingAt],
    );
    await client.query('ANALYZE pg_temp.webhook_events');
    let cursor: PrivateImagePageCursor | undefined;
    const ids: string[] = [];
    for (let page = 0; page < 2; page++) {
      const sql = buildPrivateImageReceiptPageSql({ since, until, cursor, pageSize: 500 });
      const rows = await query<ReceiptRow>(sql);
      expect(rows).toHaveLength(500);
      expect(rows.every((row) => row.normalizedPayload.type === 'message_callback')).toBe(true);
      await expectBoundedIndexPage(sql, 'webhook_events', receiptIndexes, true);
      ids.push(...rows.map((row) => row.id));
      const last = rows.at(-1)!;
      cursor = { createdAt: last.createdAt, id: last.id };
    }
    const sourceIds: string[] = [];
    for (let page = 0; page < 4; page++) {
      const sql = buildPrivateImageReceiptPageSql({ since, until, cursor, pageSize: 2 });
      const rows = await query<ReceiptRow>(sql);
      if (!rows.length) break;
      expect(
        rows.every((row) =>
          ['message_created', 'message_edited'].includes(row.normalizedPayload.type),
        ),
      ).toBe(true);
      await expectBoundedIndexPage(sql, 'webhook_events', receiptIndexes, true);
      sourceIds.push(...rows.map((row) => row.id));
      const last = rows.at(-1)!;
      cursor = { createdAt: last.createdAt, id: last.id };
    }
    expect(sourceIds).toEqual([
      'source-0001',
      'source-0002',
      'source-0003',
      'source-0004',
      'source-0005',
    ]);
    expect(new Set([...ids, ...sourceIds]).size).toBe(1005);
    expect(ids).not.toContain('not-processed');
  });
});
