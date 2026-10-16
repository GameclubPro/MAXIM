import {
  safetyDeskWebhookCohortResponseSchema,
  type SafetyDeskWebhookCohortResponse,
} from '@maxim/contracts/safety-desk';
import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { type Prisma } from '../prisma/prisma-client';
import {
  buildSafetyDeskWebhookCohortIndexQuery,
  buildSafetyDeskWebhookCohortQuery,
} from './safety-desk-webhook-cohort.query';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
const describePostgres = databaseUrl ? describe : describe.skip;

function planNodes(value: unknown): Record<string, unknown>[] {
  if (!value || typeof value !== 'object') return [];
  return [
    ...('Node Type' in value ? [value as Record<string, unknown>] : []),
    ...Object.values(value).flatMap(planNodes),
  ];
}

describePostgres('Safety Desk closed webhook cohort on native PostgreSQL', () => {
  let pool: Pool;
  let client: PoolClient;
  jest.setTimeout(30_000);

  beforeAll(() => {
    const url = new URL(databaseUrl);
    if (
      !['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname) ||
      !url.pathname.includes('race_test')
    ) {
      throw new Error('Disposable local race_test PostgreSQL required');
    }
    pool = new Pool({ connectionString: databaseUrl, max: 2, statement_timeout: 5_000 });
  });

  beforeEach(async () => {
    client = await pool.connect();
    const schema = `cohort_${randomUUID().replaceAll('-', '')}`;
    await client.query('BEGIN');
    await client.query(`CREATE SCHEMA ${schema}; SET LOCAL search_path TO ${schema}, public`);
    await client.query(`SET LOCAL TIME ZONE 'UTC';
      CREATE TYPE "WebhookStatus" AS ENUM (
        'RECEIVED', 'QUEUED', 'PROCESSED', 'DUPLICATE', 'FAILED', 'NO_REPLAY_HELD', 'CANCELLED', 'QUARANTINED');
      CREATE TABLE webhook_events (
        id text PRIMARY KEY, status "WebhookStatus" NOT NULL, created_at timestamp(3) NOT NULL,
        processed_at timestamp(3), queued_at timestamp(3), execution_deadline_at timestamp(3),
        timeout_quarantine_expires_at timestamp(3), raw_payload jsonb, normalized_payload jsonb);
      CREATE INDEX webhook_events_status_created_at_id_idx ON webhook_events(status, created_at, id);`);
  });

  afterEach(async () => {
    if (client) {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  afterAll(async () => {
    await pool?.end();
  });

  async function execute(query: Prisma.Sql) {
    return client.query(query.text, query.values);
  }

  async function snapshot(): Promise<SafetyDeskWebhookCohortResponse> {
    const result = await execute(buildSafetyDeskWebhookCohortQuery());
    return safetyDeskWebhookCohortResponseSchema.parse(result.rows[0].snapshot);
  }

  it('includes all accepted statuses while keeping completion, expiry and uncertainty separate', async () => {
    await client.query(`INSERT INTO webhook_events
      (id, status, created_at, processed_at, queued_at, execution_deadline_at,
        timeout_quarantine_expires_at, raw_payload, normalized_payload)
      SELECT 'private-' || status, status, now()-interval '45 seconds', now()-interval '43 seconds',
        now()-interval '44 seconds', now()-interval '1 second', now()+interval '5 minutes',
        '{"privateContent":"secret"}', '{"privateContent":"secret"}'
      FROM unnest(enum_range(NULL::"WebhookStatus")) status;
      INSERT INTO webhook_events(id, status, created_at, processed_at, queued_at) VALUES
        ('invalid-clock', 'PROCESSED', now()-interval '45 seconds', now()-interval '46 seconds', now()+interval '1 second'),
        ('new-receipt', 'RECEIVED', now()-interval '10 seconds', NULL, NULL),
        ('old-receipt', 'RECEIVED', now()-interval '70 seconds', NULL, NULL);`);
    const result = await snapshot();
    expect(result).toMatchObject({
      sampleComplete: true,
      totalCountLowerBound: 9,
      effectsEvidence: 'not_linked',
    });
    expect(result.rows).toHaveLength(8);
    expect(Date.parse(result.windowEndedAt) - Date.parse(result.windowStartedAt)).toBe(30_000);
    expect(Date.parse(result.observedAt) - Date.parse(result.windowEndedAt)).toBe(30_000);
    for (const row of result.rows) {
      expect(row.expiredAtObservation).toBe(1);
      expect(row.quarantineTimestampPresent).toBe(1);
      expect(row.enqueueLatency).toEqual({ sampleCount: 1, p95Ms: 1_000, p99Ms: 1_000 });
      if (row.status === 'PROCESSED') {
        expect(row).toMatchObject({
          countLowerBound: 2,
          invalidProcessedClocks: 1,
          invalidQueuedClocks: 1,
        });
        expect(row.processedLatency).toEqual({ sampleCount: 1, p95Ms: 2_000, p99Ms: 2_000 });
      } else {
        expect(row.countLowerBound).toBe(1);
        expect(row.processedLatency).toEqual({ sampleCount: 0, p95Ms: null, p99Ms: null });
      }
    }
    expect(JSON.stringify(result)).not.toMatch(/private-|privateContent|secret|payload/);
  });

  it('returns every empty status and marks per-status saturation without losing failures', async () => {
    const empty = await snapshot();
    expect(empty).toMatchObject({ sampleComplete: true, totalCountLowerBound: 0 });
    expect(empty.rows.every((row) => row.countLowerBound === 0)).toBe(true);
    await client.query(`INSERT INTO webhook_events(id, status, created_at)
      SELECT 'same-clock-' || n, 'PROCESSED', now()-interval '45 seconds' FROM generate_series(1, 513) n;
      INSERT INTO webhook_events(id, status, created_at)
      VALUES ('failed', 'FAILED', now()-interval '45 seconds');`);
    const result = await snapshot();
    expect(result).toMatchObject({ sampleComplete: false, totalCountLowerBound: 513 });
    expect(result.rows.find((row) => row.status === 'PROCESSED')).toMatchObject({
      countLowerBound: 512,
      truncated: true,
      invalidProcessedClocks: 512,
    });
    expect(result.rows.find((row) => row.status === 'FAILED')).toMatchObject({
      countLowerBound: 1,
      truncated: false,
    });
  });

  it('requires the exact covering index rather than accepting a similarly named index', async () => {
    expect((await execute(buildSafetyDeskWebhookCohortIndexQuery())).rows).toEqual([
      { ready: true },
    ]);
    await client.query(`DROP INDEX webhook_events_status_created_at_id_idx;
      CREATE INDEX webhook_events_status_created_at_id_idx ON webhook_events(status, id, created_at);`);
    expect((await execute(buildSafetyDeskWebhookCohortIndexQuery())).rows).toEqual([
      { ready: false },
    ]);
  });

  it('rejects a same-name BRIN index even when its columns match', async () => {
    await client.query(`DROP INDEX webhook_events_status_created_at_id_idx;
      ALTER TABLE webhook_events ALTER COLUMN status TYPE text USING status::text;
      CREATE INDEX webhook_events_status_created_at_id_idx
      ON webhook_events USING brin(status, created_at, id);`);
    expect((await execute(buildSafetyDeskWebhookCohortIndexQuery())).rows).toEqual([
      { ready: false },
    ]);
  });

  it('bounds index heads and metadata reads despite retained history, ties and an empty window', async () => {
    await client.query(`INSERT INTO webhook_events(id, status, created_at)
      SELECT 'history-' || n, 'PROCESSED', now()-interval '2 days' FROM generate_series(1, 60_000) n;
      INSERT INTO webhook_events(id, status, created_at)
      SELECT 'recent-' || n, 'PROCESSED', now()-interval '45 seconds' FROM generate_series(1, 1_200) n;
      INSERT INTO webhook_events(id, status, created_at)
      SELECT 'failed-' || n, 'FAILED', now()-interval '45 seconds' FROM generate_series(1, 1_200) n;
      ANALYZE webhook_events;`);
    for (const empty of [false, true]) {
      if (empty) {
        await client.query(`DELETE FROM webhook_events WHERE created_at > now()-interval '1 minute';
          ANALYZE webhook_events;`);
      }
      const query = buildSafetyDeskWebhookCohortQuery();
      // FLAG: EXPLAIN ANALYZE is restricted to this disposable local fixture.
      const plan = await client.query(
        `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query.text}`,
        query.values,
      );
      const scans = planNodes(plan.rows).filter(
        (node) => node['Relation Name'] === 'webhook_events',
      );
      expect(scans).toHaveLength(2);
      expect(scans.map((node) => node['Index Name']).sort()).toEqual([
        'webhook_events_pkey',
        'webhook_events_status_created_at_id_idx',
      ]);
      const heads = scans.find(
        (node) => node['Index Name'] === 'webhook_events_status_created_at_id_idx',
      );
      const details = scans.find((node) => node['Index Name'] === 'webhook_events_pkey');
      expect(heads?.['Actual Loops']).toBeLessThanOrEqual(8);
      expect(heads?.['Actual Rows']).toBeLessThanOrEqual(513);
      expect(heads?.['Index Cond']).toMatch(/status.*created_at.*created_at/);
      expect(details?.['Actual Loops']).toBeLessThanOrEqual(8 * 512);
      expect(details?.['Actual Rows']).toBeLessThanOrEqual(1);
      expect((await snapshot()).totalCountLowerBound).toBe(empty ? 0 : 1_024);
    }
  });
});
