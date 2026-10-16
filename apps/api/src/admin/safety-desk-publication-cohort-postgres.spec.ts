import {
  safetyDeskPublicationCohortResponseSchema,
  type SafetyDeskPublicationCohortResponse,
} from '@maxim/contracts/safety-desk';
import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { type Prisma } from '../prisma/prisma-client';
import {
  buildSafetyDeskPublicationCohortIndexQuery,
  buildSafetyDeskPublicationCohortQuery,
} from './safety-desk-publication-cohort.query';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
const describePostgres = databaseUrl ? describe : describe.skip;

function planNodes(value: unknown): Record<string, unknown>[] {
  if (!value || typeof value !== 'object') return [];
  return [
    ...('Node Type' in value ? [value as Record<string, unknown>] : []),
    ...Object.values(value).flatMap(planNodes),
  ];
}

describePostgres('Safety Desk accepted publication cohort on native PostgreSQL', () => {
  let pool: Pool;
  let client: PoolClient;
  let schema: string;
  jest.setTimeout(60_000);

  beforeAll(() => {
    const url = new URL(databaseUrl);
    if (
      !['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname) ||
      !url.pathname.includes('race_test')
    ) {
      throw new Error('Disposable local race_test PostgreSQL required');
    }
    pool = new Pool({ connectionString: databaseUrl, max: 3, statement_timeout: 10_000 });
  });

  beforeEach(async () => {
    client = await pool.connect();
    schema = `publication_cohort_${randomUUID().replaceAll('-', '')}`;
    await client.query(`CREATE SCHEMA ${schema}; SET search_path TO ${schema}, public;
      SET TIME ZONE 'UTC';
      CREATE TYPE "PublicationOccurrenceStatus" AS ENUM (
        'SCHEDULED', 'IN_PROGRESS', 'SENT', 'PARTIAL', 'FAILED', 'AMBIGUOUS', 'CANCELED');
      CREATE TYPE "PublicationDispatchProfile" AS ENUM ('LEGACY_ROUTED', 'PUBLIK_V1');
      CREATE TYPE "PublicationScheduleMode" AS ENUM ('NOW', 'ONCE', 'SLOTS', 'RECURRENCE');
      CREATE TABLE publication_occurrences (
        id text PRIMARY KEY, publication_id text NOT NULL DEFAULT 'publication',
        schedule_id text NOT NULL DEFAULT 'schedule', content_revision_id text NOT NULL DEFAULT 'content',
        schedule_revision integer NOT NULL DEFAULT 1,
        dispatch_profile "PublicationDispatchProfile" NOT NULL DEFAULT 'PUBLIK_V1',
        status "PublicationOccurrenceStatus" NOT NULL DEFAULT 'SCHEDULED',
        created_at timestamp(3) NOT NULL DEFAULT (now()-interval '60 seconds'),
        scheduled_at timestamp(3) NOT NULL DEFAULT (now()-interval '60 seconds'),
        delivery_deadline_at timestamp(3) DEFAULT (now()+interval '1 hour'),
        retry_authorized_at timestamp(3), retry_expires_at timestamp(3),
        dispatch_blocker_code text, dispatch_blocked_at timestamp(3),
        updated_at timestamp(3) NOT NULL DEFAULT now());
      CREATE INDEX publication_occurrences_dispatch_status_created_id_idx
        ON publication_occurrences(dispatch_profile, status, created_at, id);
      CREATE TABLE publication_schedules (
        id text PRIMARY KEY, publication_id text NOT NULL DEFAULT 'publication',
        revision integer NOT NULL DEFAULT 1, mode "PublicationScheduleMode" NOT NULL DEFAULT 'NOW',
        created_at timestamp(3) NOT NULL DEFAULT (now()-interval '2 days'), rule jsonb);
      CREATE TABLE publication_content_revisions (
        id text PRIMARY KEY, publication_id text NOT NULL DEFAULT 'publication',
        created_at timestamp(3) NOT NULL DEFAULT (now()-interval '2 days'), text text, buttons jsonb);
      CREATE TABLE publication_content_assets (
        content_revision_id text NOT NULL, asset_id text NOT NULL, position integer NOT NULL,
        PRIMARY KEY (content_revision_id, asset_id));
      CREATE UNIQUE INDEX publication_content_assets_revision_position_key
        ON publication_content_assets(content_revision_id, position);
      CREATE TABLE publication_assets (id text PRIMARY KEY, mime_type text NOT NULL, bytes bytea,
        durable_payload jsonb, file_name text);
      CREATE TABLE managed_broadcast_deliveries (
        id text PRIMARY KEY, publication_occurrence_id text NOT NULL, private_payload jsonb);
      CREATE INDEX managed_broadcast_deliveries_occurrence_idx
        ON managed_broadcast_deliveries(publication_occurrence_id);
      INSERT INTO publication_schedules(id, rule) VALUES ('schedule', '{"secret":"rule"}');
      INSERT INTO publication_content_revisions(id, text, buttons)
        VALUES ('content', 'private-content', '[{"private":"button"}]');`);
  });

  afterEach(async () => {
    if (client) {
      await client.query(`SET statement_timeout = '10000ms'; DROP SCHEMA ${schema} CASCADE;
        RESET search_path; RESET lock_timeout`);
      client.release();
    }
  });

  afterAll(async () => {
    await pool?.end();
  });

  async function execute(query: Prisma.Sql) {
    return client.query(query.text, query.values);
  }

  async function snapshot(): Promise<SafetyDeskPublicationCohortResponse> {
    await client.query(`SET statement_timeout = '2000ms'; SET lock_timeout = '250ms'`);
    try {
      const result = await execute(buildSafetyDeskPublicationCohortQuery());
      return safetyDeskPublicationCohortResponseSchema.parse(result.rows[0].snapshot);
    } finally {
      await client.query(`SET statement_timeout = '10000ms'`);
    }
  }

  it('includes every accepted status, future slots and unmaterialized work without claiming completion', async () => {
    await client.query(`INSERT INTO publication_occurrences(id, status)
      SELECT 'private-' || status, status FROM unnest(enum_range(NULL::"PublicationOccurrenceStatus")) status;
      INSERT INTO publication_occurrences(id, created_at) VALUES
        ('too-new', now()-interval '10 seconds'), ('history', now()-interval '20 minutes');
      INSERT INTO publication_occurrences(id, dispatch_profile) VALUES ('legacy', 'LEGACY_ROUTED');
      INSERT INTO publication_occurrences(id, scheduled_at, delivery_deadline_at) VALUES
        ('future', now()+interval '1 day', now()+interval '2 days'),
        ('expired', now()-interval '60 seconds', now()-interval '1 second'),
        ('missing-clock', now()-interval '60 seconds', NULL),
        ('inverted-deadline', now()-interval '60 seconds', now()-interval '70 seconds');
      UPDATE publication_occurrences SET dispatch_blocker_code='PUBLISHER_ACTOR_ACCESS_REQUIRED'
        WHERE id='private-IN_PROGRESS';`);
    const result = await snapshot();
    expect(result).toMatchObject({
      basis: 'occurrence_created_at',
      dispatchProfile: 'PUBLIK_V1',
      windowSeconds: 900,
      graceSeconds: 30,
      sampleComplete: true,
      totalCountLowerBound: 11,
      completionTimingEvidence: 'not_recorded',
      effectsEvidence: 'occurrence_status_only',
    });
    expect(result.rows).toHaveLength(7);
    expect(Date.parse(result.windowEndedAt) - Date.parse(result.windowStartedAt)).toBe(900_000);
    expect(Date.parse(result.observedAt) - Date.parse(result.windowEndedAt)).toBe(30_000);
    expect(result.rows.find((row) => row.status === 'SCHEDULED')).toMatchObject({
      countLowerBound: 5,
      pendingNotDue: 1,
      pendingDue: 1,
      pendingExpired: 1,
      pendingTimingUnknown: 2,
      modeCounts: { NOW: 5, UNKNOWN: 0 },
      mediaCounts: { TEXT: 5, UNKNOWN: 0 },
    });
    expect(result.rows.find((row) => row.status === 'IN_PROGRESS')).toMatchObject({
      pendingDue: 1,
      blockedPending: 1,
    });
    for (const row of result.rows.filter(
      (row) => !['SCHEDULED', 'IN_PROGRESS'].includes(row.status),
    )) {
      expect(row).toMatchObject({
        countLowerBound: 1,
        pendingNotDue: 0,
        pendingDue: 0,
        pendingExpired: 0,
        pendingTimingUnknown: 0,
        oldestDueAgeSec: null,
      });
    }
    expect(JSON.stringify(result)).not.toMatch(
      /private-|private-content|secret|button|payload|completedAt/,
    );
  });

  it('preserves explicit retry deadlines and reports unsupported old retry clocks as unknown', async () => {
    await client.query(`INSERT INTO publication_occurrences
      (id, delivery_deadline_at, retry_authorized_at, retry_expires_at, dispatch_blocker_code) VALUES
      ('active-retry', now()-interval '1 second', now()-interval '30 seconds', now()+interval '1 hour', 'PUBLISHER_EXPLICIT_RETRY'),
      ('original-later', now()+interval '1 hour', now()-interval '30 seconds', now()-interval '1 second', NULL),
      ('expired-retry', now()-interval '20 seconds', now()-interval '30 seconds', now()-interval '1 second', NULL),
      ('active-no-original', NULL, now()-interval '30 seconds', now()+interval '1 hour', NULL),
      ('expired-no-original', NULL, now()-interval '30 seconds', now()-interval '1 second', NULL),
      ('future-auth', now()-interval '1 second', now()+interval '1 second', now()+interval '1 hour', NULL),
      ('inverted-retry', now()-interval '1 second', now()-interval '10 seconds', now()-interval '20 seconds', NULL),
      ('missing-retry-expiry', now()-interval '1 second', now()-interval '30 seconds', NULL, NULL);
      INSERT INTO publication_occurrences(id, delivery_deadline_at, dispatch_blocker_code, dispatch_blocked_at)
        VALUES ('legacy-retry', now()-interval '1 second', 'PUBLISHER_EXPLICIT_RETRY', now()-interval '30 seconds');`);
    const row = (await snapshot()).rows.find((item) => item.status === 'SCHEDULED');
    expect(row).toMatchObject({
      countLowerBound: 9,
      pendingDue: 3,
      pendingExpired: 1,
      pendingTimingUnknown: 5,
      retryAuthorizedCount: 9,
      blockedPending: 0,
      mediaCounts: { UNKNOWN: 9, TEXT: 0 },
    });
  });

  it('uses only proven schedule/content revisions and bounded asset metadata for dimensions', async () => {
    await client.query(`INSERT INTO publication_schedules(id, mode) VALUES
        ('once', 'ONCE'), ('slots', 'SLOTS'), ('recurrence', 'RECURRENCE');
      INSERT INTO publication_schedules(id, publication_id) VALUES ('wrong-owner', 'another-publication');
      INSERT INTO publication_content_revisions(id) VALUES ('images'), ('video'), ('mixed'), ('overflow'),
        ('missing-asset'), ('negative-position'), ('position-gap'), ('large-position');
      INSERT INTO publication_content_revisions(id, created_at) VALUES ('later-content', now());
      INSERT INTO publication_content_revisions(id, publication_id) VALUES ('wrong-content-owner', 'other');
      INSERT INTO publication_assets(id, mime_type, bytes, durable_payload, file_name) VALUES
        ('image', 'image/png', '\\x736563726574', '{"secret":"payload"}', 'private-file'),
        ('video', 'video/mp4', NULL, '{"secret":"token"}', 'private-video');
      INSERT INTO publication_content_assets(content_revision_id, asset_id, position) VALUES
        ('images', 'image', 0), ('video', 'video', 0), ('mixed', 'image', 0), ('mixed', 'video', 1),
        ('missing-asset', 'not-saved', 0), ('negative-position', 'image', -1),
        ('position-gap', 'image', 0), ('position-gap', 'video', 2), ('large-position', 'image', 100);
      INSERT INTO publication_content_assets(content_revision_id, asset_id, position)
        SELECT 'overflow', 'not-loaded-' || n, n FROM generate_series(0, 10) n;
      INSERT INTO publication_occurrences(id, schedule_id, content_revision_id) VALUES
        ('images', 'once', 'images'), ('video', 'slots', 'video'), ('mixed', 'recurrence', 'mixed'),
        ('overflow', 'schedule', 'overflow'), ('missing-asset', 'schedule', 'missing-asset'),
        ('negative-position', 'schedule', 'negative-position'), ('position-gap', 'schedule', 'position-gap'),
        ('large-position', 'schedule', 'large-position'),
        ('later-content', 'schedule', 'later-content'), ('wrong-content-owner', 'schedule', 'wrong-content-owner'),
        ('missing-content', 'schedule', 'absent-content'), ('wrong-schedule-owner', 'wrong-owner', 'content'),
        ('missing-schedule', 'absent-schedule', 'content');
      INSERT INTO publication_occurrences(id, schedule_revision) VALUES ('old-schedule-revision', 2);`);
    const result = await snapshot();
    const row = result.rows.find((item) => item.status === 'SCHEDULED');
    expect(row).toMatchObject({
      countLowerBound: 14,
      modeCounts: { NOW: 8, ONCE: 1, SLOTS: 1, RECURRENCE: 1, UNKNOWN: 3 },
      mediaCounts: { TEXT: 3, IMAGE: 1, VIDEO: 1, UNKNOWN: 9 },
    });
    expect(JSON.stringify(result)).not.toMatch(/secret|token|private|not-loaded/);
  });

  it('keeps empty statuses and marks saturated status counts as lower bounds', async () => {
    expect(await snapshot()).toMatchObject({ sampleComplete: true, totalCountLowerBound: 0 });
    await client.query(`INSERT INTO publication_occurrences(id, status)
      SELECT 'same-time-' || n, 'SENT' FROM generate_series(1, 513) n;
      INSERT INTO publication_occurrences(id, status) VALUES ('failed', 'FAILED'), ('ambiguous', 'AMBIGUOUS');`);
    const result = await snapshot();
    expect(result).toMatchObject({ sampleComplete: false, totalCountLowerBound: 514 });
    expect(result.rows.find((row) => row.status === 'SENT')).toMatchObject({
      countLowerBound: 512,
      truncated: true,
    });
    expect(result.rows.find((row) => row.status === 'FAILED')).toMatchObject({
      countLowerBound: 1,
    });
    expect(result.rows.find((row) => row.status === 'AMBIGUOUS')).toMatchObject({
      countLowerBound: 1,
    });
  });

  it('accepts quoted columns and rejects incompatible key definitions or missing bounded metadata indexes', async () => {
    expect((await execute(buildSafetyDeskPublicationCohortIndexQuery())).rows).toEqual([
      { ready: true },
    ]);
    for (const definition of [
      '(dispatch_profile, status, id, created_at)',
      '(dispatch_profile, status, created_at DESC, id)',
      '(dispatch_profile, status, created_at NULLS FIRST, id)',
      '(dispatch_profile, status, created_at, lower(id))',
      '(dispatch_profile, status, created_at, id) INCLUDE (scheduled_at)',
      "(dispatch_profile, status, created_at, id) WHERE status = 'SENT'",
    ]) {
      await client.query(`DROP INDEX publication_occurrences_dispatch_status_created_id_idx;
        CREATE INDEX publication_occurrences_dispatch_status_created_id_idx
          ON publication_occurrences${definition};`);
      expect((await execute(buildSafetyDeskPublicationCohortIndexQuery())).rows).toEqual([
        { ready: false },
      ]);
    }
    await client.query(`DROP INDEX publication_occurrences_dispatch_status_created_id_idx;
      ALTER TABLE publication_occurrences ALTER COLUMN dispatch_profile DROP DEFAULT;
      ALTER TABLE publication_occurrences ALTER COLUMN status DROP DEFAULT;
      ALTER TABLE publication_occurrences ALTER COLUMN dispatch_profile TYPE text USING dispatch_profile::text;
      ALTER TABLE publication_occurrences ALTER COLUMN status TYPE text USING status::text;
      CREATE INDEX publication_occurrences_dispatch_status_created_id_idx
        ON publication_occurrences USING brin(dispatch_profile, status, created_at, id);`);
    expect((await execute(buildSafetyDeskPublicationCohortIndexQuery())).rows).toEqual([
      { ready: false },
    ]);
    await client.query(`DROP INDEX publication_occurrences_dispatch_status_created_id_idx;
      CREATE INDEX publication_occurrences_dispatch_status_created_id_idx
        ON publication_occurrences(dispatch_profile, status, created_at, id);
      DROP INDEX publication_content_assets_revision_position_key;`);
    expect((await execute(buildSafetyDeskPublicationCohortIndexQuery())).rows).toEqual([
      { ready: false },
    ]);
    await client.query(`CREATE INDEX publication_content_assets_revision_position_key
      ON publication_content_assets(content_revision_id, position);`);
    expect((await execute(buildSafetyDeskPublicationCohortIndexQuery())).rows).toEqual([
      { ready: false },
    ]);
    await client.query(`DROP INDEX publication_content_assets_revision_position_key;
      CREATE UNIQUE INDEX publication_content_assets_revision_position_key
        ON publication_content_assets(content_revision_id, "position");`);
    expect((await execute(buildSafetyDeskPublicationCohortIndexQuery())).rows).toEqual([
      { ready: true },
    ]);
  });

  it('bounds plans with 100k history, 10k/50k audiences and every status capped under the 2s budget', async () => {
    await client.query(`INSERT INTO publication_occurrences(id, status, created_at)
      SELECT 'history-' || n, (enum_range(NULL::"PublicationOccurrenceStatus"))[1 + n % 7],
        now()-interval '2 days' FROM generate_series(1, 100000) n;
      INSERT INTO publication_schedules(id) SELECT 'hot-schedule-' || n FROM generate_series(1, 3591) n;
      INSERT INTO publication_content_revisions(id) SELECT 'hot-content-' || n FROM generate_series(1, 3591) n;
      INSERT INTO publication_occurrences(id, status, schedule_id, content_revision_id)
      SELECT 'hot-' || n, (enum_range(NULL::"PublicationOccurrenceStatus"))[1 + (n - 1) / 513],
        'hot-schedule-' || n, 'hot-content-' || n FROM generate_series(1, 3591) n;
      INSERT INTO publication_assets(id, mime_type)
      SELECT 'hot-asset-' || n, 'image/png' FROM generate_series(1, 35910) n;
      INSERT INTO publication_content_assets(content_revision_id, asset_id, position)
      SELECT 'hot-content-' || n, 'hot-asset-' || ((n - 1) * 10 + p + 1), p
        FROM generate_series(1, 3591) n CROSS JOIN generate_series(0, 9) p;
      INSERT INTO managed_broadcast_deliveries(id, publication_occurrence_id, private_payload)
      SELECT 'ten-thousand-' || n, 'hot-1', '{"private":"recipient"}' FROM generate_series(1, 10000) n;
      INSERT INTO managed_broadcast_deliveries(id, publication_occurrence_id, private_payload)
      SELECT 'fifty-thousand-' || n, 'hot-2', '{"private":"recipient"}' FROM generate_series(1, 50000) n;
      ANALYZE publication_occurrences; ANALYZE publication_schedules;
      ANALYZE publication_content_revisions; ANALYZE publication_content_assets;
      ANALYZE publication_assets; ANALYZE managed_broadcast_deliveries;`);
    expect(
      (
        await client.query(`SELECT id FROM publication_occurrences
          WHERE dispatch_profile='PUBLIK_V1' AND status='SCHEDULED'
            AND created_at >= now()-interval '930 seconds' AND created_at < now()-interval '30 seconds'
          ORDER BY created_at, id LIMIT 1`)
      ).rows,
    ).toEqual([{ id: 'hot-1' }]);
    for (const overflow of [false, true]) {
      if (overflow) {
        await client.query(`INSERT INTO publication_content_assets(content_revision_id, asset_id, position)
          SELECT 'hot-content-' || n, 'overflow-not-loaded-' || n, 10 FROM generate_series(1, 3591) n;
          INSERT INTO publication_content_assets(content_revision_id, asset_id, position)
          SELECT 'hot-content-1', 'oversized-history-' || n, n FROM generate_series(11, 50010) n;
          ANALYZE publication_content_assets;`);
      }
      const query = buildSafetyDeskPublicationCohortQuery();
      await client.query(`SET statement_timeout = '2000ms'`);
      // FLAG: This actual plan is restricted to the isolated local fixture, never production.
      const plan = await client.query(
        `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query.text}`,
        query.values,
      );
      await client.query(`SET statement_timeout = '10000ms'`);
      const scans = planNodes(plan.rows).filter((node) => node['Relation Name']);
      expect(scans.some((node) => node['Relation Name'] === 'managed_broadcast_deliveries')).toBe(
        false,
      );
      const occurrences = scans.filter(
        (node) => node['Relation Name'] === 'publication_occurrences',
      );
      expect(occurrences.map((node) => node['Index Name']).sort()).toEqual([
        'publication_occurrences_dispatch_status_created_id_idx',
        'publication_occurrences_pkey',
      ]);
      const heads = occurrences.find(
        (node) => node['Index Name'] === 'publication_occurrences_dispatch_status_created_id_idx',
      );
      expect(heads?.['Actual Loops']).toBe(7);
      expect(heads?.['Actual Rows']).toBeLessThanOrEqual(513);
      expect(heads?.['Index Cond']).toMatch(/dispatch_profile.*status.*created_at.*created_at/);
      const metadata = occurrences.find(
        (node) => node['Index Name'] === 'publication_occurrences_pkey',
      );
      expect(metadata?.['Actual Loops']).toBe(3584);
      expect(metadata?.['Actual Rows']).toBeLessThanOrEqual(1);
      const links = scans.filter((node) => node['Relation Name'] === 'publication_content_assets');
      expect(links).toHaveLength(3);
      const indexProbe = (node: Record<string, unknown> | undefined) =>
        planNodes(node).find((child) => child['Index Name']);
      const linkBounds = links.filter((node) => {
        const index = indexProbe(node);
        return (
          index?.['Index Name'] === 'publication_content_assets_revision_position_key' &&
          !/\bposition"?\s*=/.test(String(index['Index Cond']))
        );
      });
      expect(linkBounds).toHaveLength(2);
      expect(linkBounds.map((node) => node['Scan Direction']).sort()).toEqual([
        'Backward',
        'Forward',
      ]);
      for (const bound of linkBounds) {
        expect(bound['Index Name']).toBe('publication_content_assets_revision_position_key');
        expect(['Index Scan', 'Index Only Scan']).toContain(bound['Node Type']);
        expect(bound['Index Cond']).toMatch(/\bcontent_revision_id"?\s*=/);
        expect(bound['Actual Loops']).toBeLessThanOrEqual(3584);
        expect(bound['Actual Rows']).toBeLessThanOrEqual(1);
      }
      const linkDetails = links.find((node) => !linkBounds.includes(node));
      const detailIndex = indexProbe(linkDetails);
      expect(detailIndex?.['Index Name']).toBe('publication_content_assets_revision_position_key');
      expect(detailIndex?.['Index Cond']).toMatch(/\bcontent_revision_id"?\s*=/);
      expect(detailIndex?.['Index Cond']).toMatch(/\bposition"?\s*=/);
      expect(linkDetails?.['Actual Loops']).toBeLessThanOrEqual(35840);
      expect(linkDetails?.['Actual Rows']).toBeLessThanOrEqual(1);
      expect(['Index Scan', 'Index Only Scan', 'Bitmap Heap Scan']).toContain(
        linkDetails?.['Node Type'],
      );
      for (const table of [
        'publication_schedules',
        'publication_content_revisions',
        'publication_assets',
      ]) {
        const probes = scans.filter((node) => node['Relation Name'] === table);
        expect(probes).toHaveLength(1);
        expect(probes[0]?.['Index Name']).toBe(`${table}_pkey`);
        expect(probes[0]?.['Actual Rows']).toBeLessThanOrEqual(1);
        expect(probes[0]?.['Actual Loops']).toBeLessThanOrEqual(
          table === 'publication_assets' ? 35840 : 3584,
        );
      }
      const result = await snapshot();
      expect(result).toMatchObject({ sampleComplete: false, totalCountLowerBound: 3584 });
      expect(
        result.rows.every((row) => row.mediaCounts[overflow ? 'UNKNOWN' : 'IMAGE'] === 512),
      ).toBe(true);
    }
    await client.query(
      `DELETE FROM publication_occurrences WHERE id LIKE 'hot-%'; ANALYZE publication_occurrences;`,
    );
    expect(await snapshot()).toMatchObject({ sampleComplete: true, totalCountLowerBound: 0 });
  });

  it('observes committed state without blocking on or disturbing a foreign row lock', async () => {
    await client.query(`INSERT INTO publication_occurrences(id) VALUES ('locked-occurrence')`);
    const locker = await pool.connect();
    try {
      await locker.query(`BEGIN; SET LOCAL search_path TO ${schema}, public;
        UPDATE publication_occurrences SET status='SENT' WHERE id='locked-occurrence';`);
      const result = await snapshot();
      expect(result.rows.find((row) => row.status === 'SCHEDULED')?.countLowerBound).toBe(1);
      expect(result.rows.find((row) => row.status === 'SENT')?.countLowerBound).toBe(0);
      await locker.query('COMMIT');
      expect((await snapshot()).rows.find((row) => row.status === 'SENT')?.countLowerBound).toBe(1);
    } finally {
      await locker.query('ROLLBACK');
      locker.release();
    }
  });
});
