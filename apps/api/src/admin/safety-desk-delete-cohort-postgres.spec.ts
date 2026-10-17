import { randomUUID } from 'node:crypto';
import { ServiceUnavailableException } from '@nestjs/common';
import { Pool, type PoolClient } from 'pg';
import { createPrismaClient, type Prisma, type PrismaClient } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import {
  projectSafetyDeskDeleteCohort,
  type SafetyDeskDeleteCohortQueryRow,
} from './safety-desk-delete-cohort.model';
import {
  buildSafetyDeskDeleteCohortIndexQuery,
  buildSafetyDeskDeleteCohortQuery,
} from './safety-desk-delete-cohort.query';
import { SafetyDeskDeleteCohortService } from './safety-desk-delete-cohort.service';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
const describePostgres = databaseUrl ? describe : describe.skip;

function planNodes(value: unknown): Record<string, unknown>[] {
  if (!value || typeof value !== 'object') return [];
  return [
    ...('Node Type' in value ? [value as Record<string, unknown>] : []),
    ...Object.values(value).flatMap(planNodes),
  ];
}

describePostgres('recorded DELETE cohort on native PostgreSQL', () => {
  let pool: Pool;
  let client: PoolClient;
  let prisma: PrismaClient;
  let schema: string;
  jest.setTimeout(60_000);

  beforeAll(() => {
    const url = new URL(databaseUrl);
    if (
      !['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname) ||
      !url.pathname.includes('race_test')
    )
      throw new Error('Disposable local race_test PostgreSQL required');
    pool = new Pool({ connectionString: databaseUrl, max: 3, statement_timeout: 10_000 });
  });

  beforeEach(async () => {
    client = await pool.connect();
    schema = `delete_cohort_${randomUUID().replaceAll('-', '')}`;
    await client.query(`CREATE SCHEMA ${schema}; SET search_path TO ${schema}, public;
      SET TIME ZONE 'UTC';
      CREATE TYPE "ModerationDeleteIntentStatus" AS ENUM (
        'OBSERVED', 'PENDING', 'IN_PROGRESS', 'RETRYABLE', 'WAITING_CAPABILITY',
        'AMBIGUOUS', 'SUCCEEDED', 'ALREADY_ABSENT', 'EXPIRED', 'FAILED_TERMINAL');
      CREATE TABLE moderation_delete_intents (
        id text PRIMARY KEY, status "ModerationDeleteIntentStatus" NOT NULL DEFAULT 'PENDING',
        created_at timestamp(3) NOT NULL DEFAULT (now()-interval '60 seconds'),
        execute_at timestamp(3) NOT NULL DEFAULT (now()-interval '60 seconds'),
        next_attempt_at timestamp(3) NOT NULL DEFAULT (now()-interval '60 seconds'),
        retry_until_at timestamp(3) NOT NULL DEFAULT (now()+interval '5 minutes'),
        delete_dispatch_started_at timestamp(3), remote_delete_succeeded_at timestamp(3),
        remote_delete_succeeded_bot_id text, succeeded_bot_id text, completed_at timestamp(3),
        absence_verified_at timestamp(3), absence_verified_bot_id text, absence_verification_code text,
        lease_token text, lease_expires_at timestamp(3), private_payload jsonb);
      CREATE INDEX moderation_delete_intents_status_created_id_idx
        ON moderation_delete_intents(status, created_at, id);`);
    prisma = createPrismaClient(databaseUrl, {
      max: 2,
      options: `-c search_path=${schema},public -c timezone=UTC`,
    });
    await prisma.$connect();
  });

  afterEach(async () => {
    await prisma?.$disconnect();
    if (client) {
      await client.query(`ROLLBACK; SET statement_timeout = '10000ms'; DROP SCHEMA ${schema} CASCADE;
        RESET search_path; RESET lock_timeout;`);
      client.release();
    }
  });
  afterAll(async () => pool?.end());

  async function execute(query: Prisma.Sql) {
    return client.query(query.text, query.values);
  }
  async function snapshot() {
    await client.query(`SET statement_timeout = '2000ms'; SET lock_timeout = '250ms'`);
    try {
      const query = buildSafetyDeskDeleteCohortQuery();
      const result = await client.query<SafetyDeskDeleteCohortQueryRow>(query.text, query.values);
      return projectSafetyDeskDeleteCohort(result.rows);
    } finally {
      await client.query(`SET statement_timeout = '10000ms'`);
    }
  }
  function service() {
    return new SafetyDeskDeleteCohortService(prisma as unknown as PrismaService);
  }

  it('includes every immutable recorded status and exposes neither private identities nor payloads', async () => {
    await client.query(`INSERT INTO moderation_delete_intents(id, status, private_payload)
      SELECT 'private-' || status, status, '{"secret":"do-not-return"}'
      FROM unnest(enum_range(NULL::"ModerationDeleteIntentStatus")) status;
      INSERT INTO moderation_delete_intents(id, created_at) VALUES
        ('too-new', now()-interval '10 seconds'), ('history', now()-interval '20 minutes');
      UPDATE moderation_delete_intents SET delete_dispatch_started_at=created_at,
        retry_until_at=now()-interval '1 second' WHERE status='EXPIRED';`);
    const result = await service().getSnapshot();
    expect(result).toMatchObject({
      totalCountLowerBound: 10,
      sampleComplete: true,
      includesObservedOnly: true,
    });
    expect(result.rows.every((row) => row.countLowerBound === 1)).toBe(true);
    expect(result.rows.find((row) => row.status === 'OBSERVED')?.outcomeCounts.observed).toBe(1);
    expect(result.rows.find((row) => row.status === 'EXPIRED')).toMatchObject({
      outcomeCounts: { unknown: 1, stopped: 0 },
      deadlineCounts: { elapsed: 1 },
    });
    expect(JSON.stringify(result)).not.toMatch(/private-|secret|do-not-return/);
  });

  it('includes the opening boundary and excludes the grace and ending boundaries', async () => {
    const observedAt = new Date('2035-01-01T00:15:30.000Z');
    await client.query(`INSERT INTO moderation_delete_intents(id, created_at, execute_at, retry_until_at)
      VALUES ('opening', '2035-01-01T00:00:00Z', '2035-01-01T00:00:00Z', '2035-01-01T00:20:00Z'),
        ('before-opening', '2034-12-31T23:59:59.999Z', '2034-12-31T23:59:59Z', '2035-01-01T00:20:00Z'),
        ('before-end', '2035-01-01T00:14:59.999Z', '2035-01-01T00:14:59Z', '2035-01-01T00:20:00Z'),
        ('ending', '2035-01-01T00:15:00Z', '2035-01-01T00:15:00Z', '2035-01-01T00:20:00Z'),
        ('grace', '2035-01-01T00:15:10Z', '2035-01-01T00:15:10Z', '2035-01-01T00:20:00Z');`);
    const query = buildSafetyDeskDeleteCohortQuery();
    // FLAG: Only the isolated fixture substitutes the DB clock to test exact inclusive/exclusive edges.
    const result = await client.query<SafetyDeskDeleteCohortQueryRow>(
      query.text.replaceAll('statement_timestamp()', '$1::timestamptz'),
      [observedAt],
    );
    expect(result.rows.filter((row) => row.id).map((row) => row.id)).toEqual([
      'opening',
      'before-end',
    ]);
    expect(projectSafetyDeskDeleteCohort(result.rows).totalCountLowerBound).toBe(2);
  });

  it('uses the same millisecond clock for SQL boundaries and JavaScript projection', async () => {
    await client.query(`INSERT INTO moderation_delete_intents(id, created_at) VALUES
      ('millisecond-zero', '2035-01-01T00:00:00.000Z'),
      ('millisecond-one', '2035-01-01T00:00:00.001Z');`);
    const query = buildSafetyDeskDeleteCohortQuery();
    for (const [clock, expectedCount, observedAt] of [
      ['2035-01-01T00:15:30.000400Z', 2, '2035-01-01T00:15:30.000Z'],
      ['2035-01-01T00:15:30.000600Z', 1, '2035-01-01T00:15:30.001Z'],
    ] as const) {
      const result = await client.query<SafetyDeskDeleteCohortQueryRow>(
        query.text.replaceAll('statement_timestamp()', '$1::timestamptz'),
        [clock],
      );
      expect(projectSafetyDeskDeleteCohort(result.rows)).toMatchObject({
        totalCountLowerBound: expectedCount,
        observedAt,
      });
    }
  });

  it('retains receipt provenance and excludes acknowledgement-only and invalid clocks from finalized latency', async () => {
    await client.query(`INSERT INTO moderation_delete_intents(id, status, created_at, execute_at,
        remote_delete_succeeded_at, remote_delete_succeeded_bot_id, succeeded_bot_id, completed_at)
      VALUES ('confirmed', 'SUCCEEDED', now()-interval '70 seconds', now()-interval '70 seconds',
        now()-interval '60 seconds', 'bot', 'bot', now()-interval '58 seconds'),
        ('wrong-bot', 'SUCCEEDED', now()-interval '70 seconds', now()-interval '70 seconds',
        now()-interval '60 seconds', 'bot', 'other', now()-interval '58 seconds'),
        ('bad-clock', 'SUCCEEDED', now()-interval '70 seconds', now()-interval '70 seconds',
        now()-interval '60 seconds', 'bot', 'bot', now()-interval '61 seconds'),
        ('future-clock', 'SUCCEEDED', now()-interval '70 seconds', now()-interval '70 seconds',
        now()+interval '10 minutes', 'bot', 'bot', now()+interval '10 minutes'),
        ('unsettled', 'AMBIGUOUS', now()-interval '70 seconds', now()-interval '70 seconds',
        now()-interval '60 seconds', 'bot', NULL, NULL);
      INSERT INTO moderation_delete_intents(id, status, created_at, execute_at,
        absence_verified_at, absence_verified_bot_id, absence_verification_code, completed_at)
      VALUES ('absence', 'ALREADY_ABSENT', now()-interval '70 seconds', now()-interval '70 seconds',
        now()-interval '60 seconds', 'bot', 'postdelete_exact_presence', now()-interval '58 seconds'),
        ('generic-404', 'ALREADY_ABSENT', now()-interval '70 seconds', now()-interval '70 seconds',
        now()-interval '60 seconds', 'bot', 'http_404', now()-interval '58 seconds');`);
    const result = await snapshot();
    expect(result.rows.find((row) => row.status === 'SUCCEEDED')).toMatchObject({
      countLowerBound: 4,
      outcomeCounts: { confirmed: 1, acknowledged: 2, unknown: 1 },
      finalizedLatency: { sampleCount: 1, invalidClockCount: 2, p95Ms: 12000, p99Ms: 12000 },
    });
    expect(result.rows.find((row) => row.status === 'ALREADY_ABSENT')).toMatchObject({
      outcomeCounts: { already_absent: 1, unknown: 1 },
      finalizedLatency: { sampleCount: 1, invalidClockCount: 0, p95Ms: 12000 },
    });
    expect(result.rows.find((row) => row.status === 'AMBIGUOUS')).toMatchObject({
      outcomeCounts: { acknowledged: 1 },
      finalizedLatency: { sampleCount: 0, invalidClockCount: 0 },
    });
  });

  it('bounds malformed receipt strings without erasing evidence of an unknown effect', async () => {
    await client.query(`INSERT INTO moderation_delete_intents(id, status, remote_delete_succeeded_bot_id)
      VALUES ('oversized-receipt', 'EXPIRED', repeat('x',10000));`);
    const query = buildSafetyDeskDeleteCohortQuery();
    const raw = await client.query<SafetyDeskDeleteCohortQueryRow>(query.text, query.values);
    expect(
      raw.rows.find((row) => row.id === 'oversized-receipt')?.remoteDeleteSucceededBotId,
    ).toHaveLength(513);
    expect(
      projectSafetyDeskDeleteCohort(raw.rows).rows.find((row) => row.status === 'EXPIRED'),
    ).toMatchObject({ outcomeCounts: { unknown: 1, stopped: 0 } });
  });

  it('attests exact default B-tree keys and refuses drift before cohort access', async () => {
    expect((await execute(buildSafetyDeskDeleteCohortIndexQuery())).rows).toEqual([
      { ready: true },
    ]);
    for (const definition of [
      '(status, id, created_at)',
      '(status, created_at DESC, id)',
      '(status, created_at NULLS FIRST, id)',
      '(status, created_at, lower(id))',
      '(status, created_at, id) INCLUDE (execute_at)',
      "(status, created_at, id) WHERE status='PENDING'",
      '(status, created_at, id text_pattern_ops)',
      '(status, created_at, id COLLATE "C")',
      '(status, created_at, id) WITH (fillfactor=90)',
    ]) {
      await client.query(`DROP INDEX moderation_delete_intents_status_created_id_idx;
        CREATE INDEX moderation_delete_intents_status_created_id_idx ON moderation_delete_intents${definition};`);
      expect((await execute(buildSafetyDeskDeleteCohortIndexQuery())).rows).toEqual([
        { ready: false },
      ]);
      await expect(service().getSnapshot()).rejects.toThrow(ServiceUnavailableException);
    }
    await client.query(`DROP INDEX moderation_delete_intents_status_created_id_idx;
      CREATE UNIQUE INDEX moderation_delete_intents_status_created_id_idx ON moderation_delete_intents(status, created_at, id);`);
    expect((await execute(buildSafetyDeskDeleteCohortIndexQuery())).rows).toEqual([
      { ready: false },
    ]);
    await client.query(`DROP INDEX moderation_delete_intents_status_created_id_idx;
      CREATE INDEX moderation_delete_intents_status_created_id_idx ON moderation_delete_intents(status, created_at, id);
      ALTER TABLE moderation_delete_intents DROP CONSTRAINT moderation_delete_intents_pkey;
      CREATE UNIQUE INDEX moderation_delete_intents_pkey ON moderation_delete_intents(id);`);
    expect((await execute(buildSafetyDeskDeleteCohortIndexQuery())).rows).toEqual([
      { ready: false },
    ]);
    await client.query(`DROP INDEX moderation_delete_intents_pkey;
      ALTER TABLE moderation_delete_intents ADD PRIMARY KEY (id);`);
    expect((await execute(buildSafetyDeskDeleteCohortIndexQuery())).rows).toEqual([
      { ready: true },
    ]);
    await client.query(`DROP INDEX moderation_delete_intents_status_created_id_idx`);
    await expect(service().getSnapshot()).rejects.toThrow(ServiceUnavailableException);
  });

  it('does not attest a same-named fallback-schema index or an unlogged table', async () => {
    const fallback = `${schema}_fallback`;
    await client.query(`CREATE SCHEMA ${fallback};
      CREATE TABLE ${fallback}.moderation_delete_intents (LIKE moderation_delete_intents INCLUDING ALL);
      CREATE INDEX moderation_delete_intents_status_created_id_idx
        ON ${fallback}.moderation_delete_intents(status, created_at, id);
      DROP INDEX moderation_delete_intents_status_created_id_idx;
      SET search_path TO ${schema}, ${fallback}, public;`);
    try {
      expect((await execute(buildSafetyDeskDeleteCohortIndexQuery())).rows).toEqual([
        { ready: false },
      ]);
    } finally {
      await client.query(`SET search_path TO ${schema}, public; DROP SCHEMA ${fallback} CASCADE;`);
    }
    await client.query(`CREATE INDEX moderation_delete_intents_status_created_id_idx
        ON moderation_delete_intents(status, created_at, id);
      ALTER TABLE moderation_delete_intents SET UNLOGGED;`);
    expect((await execute(buildSafetyDeskDeleteCohortIndexQuery())).rows).toEqual([
      { ready: false },
    ]);
  });

  it('rejects ordinary inherited children and parents despite their matching local indexes', async () => {
    await client.query(`CREATE TABLE inheritance_parent ();
      ALTER TABLE moderation_delete_intents INHERIT inheritance_parent;`);
    expect((await execute(buildSafetyDeskDeleteCohortIndexQuery())).rows).toEqual([
      { ready: false },
    ]);
    await client.query(`ALTER TABLE moderation_delete_intents NO INHERIT inheritance_parent;`);
    expect((await execute(buildSafetyDeskDeleteCohortIndexQuery())).rows).toEqual([
      { ready: true },
    ]);
    await client.query(`CREATE TABLE inheritance_child () INHERITS (moderation_delete_intents);`);
    expect((await execute(buildSafetyDeskDeleteCohortIndexQuery())).rows).toEqual([
      { ready: false },
    ]);
  });

  it('bounds 100k history and 50k current matches with stale and fresh statistics, including stable ties', async () => {
    // FLAG: Disable auto-analyze only on this disposable fixture so the stale-statistics
    // phase cannot silently receive a background refresh before its plan is observed.
    await client.query(`ALTER TABLE moderation_delete_intents SET (autovacuum_enabled=false);
      INSERT INTO moderation_delete_intents(id, status, created_at, private_payload)
      SELECT 'history-' || n, (enum_range(NULL::"ModerationDeleteIntentStatus"))[1+n%10],
        now()-interval '2 days', '{"private":"retained"}' FROM generate_series(1,100000) n;
      ANALYZE moderation_delete_intents;
      INSERT INTO moderation_delete_intents(id, status, private_payload)
      SELECT 'hot-' || status || '-' || lpad(n::text,4,'0'), status, '{"private":"current"}'
      FROM unnest(enum_range(NULL::"ModerationDeleteIntentStatus")) status CROSS JOIN generate_series(1,5000) n;
      UPDATE moderation_delete_intents SET remote_delete_succeeded_at=created_at,
        remote_delete_succeeded_bot_id='sentinel-bot', succeeded_bot_id='sentinel-bot', completed_at=created_at
        WHERE id='hot-SUCCEEDED-0513';`);
    const query = buildSafetyDeskDeleteCohortQuery();
    for (const statistics of ['retained_history_only', 'current'] as const) {
      if (statistics === 'current') await client.query('ANALYZE moderation_delete_intents');
      await client.query(`SET statement_timeout = '2000ms'`);
      // FLAG: EXPLAIN ANALYZE is restricted to the disposable local history fixture.
      const plan = await client.query(
        `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query.text}`,
        query.values,
      );
      await client.query(`SET statement_timeout = '10000ms'`);
      const nodes = planNodes(plan.rows);
      const scans = nodes.filter((node) => node['Relation Name'] === 'moderation_delete_intents');
      if (
        !scans.some(
          (node) => node['Index Name'] === 'moderation_delete_intents_status_created_id_idx',
        )
      )
        throw new Error(
          `Deletion cohort head did not retain an ordered index bound (${statistics}): ${JSON.stringify(plan.rows[0]['QUERY PLAN'])}`,
        );
      expect(
        scans.map((node) => ({
          index: node['Index Name'],
          type: node['Node Type'],
          rows: node['Actual Rows'],
          loops: node['Actual Loops'],
        })),
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ index: 'moderation_delete_intents_pkey' }),
          expect.objectContaining({ index: 'moderation_delete_intents_status_created_id_idx' }),
        ]),
      );
      expect(scans).toHaveLength(2);
      const heads = scans.find(
        (node) => node['Index Name'] === 'moderation_delete_intents_status_created_id_idx',
      );
      expect(heads?.['Actual Loops']).toBe(10);
      expect(heads?.['Actual Rows']).toBeLessThanOrEqual(513);
      expect(heads?.['Index Cond']).toMatch(/status.*created_at.*created_at/);
      const details = scans.find((node) => node['Index Name'] === 'moderation_delete_intents_pkey');
      expect(details?.['Actual Loops']).toBe(5120);
      expect(details?.['Actual Rows']).toBeLessThanOrEqual(1);
      expect(nodes.some((node) => String(node['Sort Space Type']).toLowerCase() === 'disk')).toBe(
        false,
      );
      const raw = await client.query<SafetyDeskDeleteCohortQueryRow>(query.text, query.values);
      expect(raw.rows).toHaveLength(5120);
      expect(JSON.stringify(raw.rows).length).toBeLessThan(5_000_000);
      expect(raw.rows.some((row) => row.id?.endsWith('-0513'))).toBe(false);
      const result = projectSafetyDeskDeleteCohort(raw.rows);
      expect(result).toMatchObject({ sampleComplete: false, totalCountLowerBound: 5120 });
      expect(result.rows.every((row) => row.truncated && row.countLowerBound === 512)).toBe(true);
      expect(result.rows.find((row) => row.status === 'SUCCEEDED')?.outcomeCounts.confirmed).toBe(
        0,
      );
    }
    await client.query(
      `DELETE FROM moderation_delete_intents WHERE id LIKE 'hot-%'; ANALYZE moderation_delete_intents;`,
    );
    expect(await snapshot()).toMatchObject({ sampleComplete: true, totalCountLowerBound: 0 });
  });

  it('observes committed state under a foreign row lock without changing or acquiring ownership', async () => {
    await client.query(`INSERT INTO moderation_delete_intents(id) VALUES ('locked-intent')`);
    const locker = await pool.connect();
    try {
      await locker.query(`BEGIN; SET LOCAL search_path TO ${schema}, public;
        UPDATE moderation_delete_intents SET status='EXPIRED' WHERE id='locked-intent';`);
      expect(
        (await service().getSnapshot()).rows.find((row) => row.status === 'PENDING')
          ?.countLowerBound,
      ).toBe(1);
      await locker.query('COMMIT');
      expect(
        (await service().getSnapshot()).rows.find((row) => row.status === 'EXPIRED')
          ?.countLowerBound,
      ).toBe(1);
    } finally {
      await locker.query('ROLLBACK');
      locker.release();
    }
  });

  it('keeps attestation and reads on one repeatable snapshot while another writer commits', async () => {
    await client.query(`INSERT INTO moderation_delete_intents(id) VALUES ('snapshot-intent')`);
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const writer = await pool.connect();
    try {
      expect((await execute(buildSafetyDeskDeleteCohortIndexQuery())).rows).toEqual([
        { ready: true },
      ]);
      await writer.query(
        `UPDATE ${schema}.moderation_delete_intents SET status='EXPIRED' WHERE id='snapshot-intent'`,
      );
      expect((await snapshot()).rows.find((row) => row.status === 'PENDING')?.countLowerBound).toBe(
        1,
      );
      await client.query('COMMIT');
      expect((await snapshot()).rows.find((row) => row.status === 'EXPIRED')?.countLowerBound).toBe(
        1,
      );
    } finally {
      await client.query('ROLLBACK');
      writer.release();
    }
  });

  it('fails within the lock budget and preserves the foreign owner of an exclusive table lock', async () => {
    const locker = await pool.connect();
    try {
      await locker.query(
        `BEGIN; LOCK TABLE ${schema}.moderation_delete_intents IN ACCESS EXCLUSIVE MODE;`,
      );
      const started = Date.now();
      await expect(service().getSnapshot()).rejects.toThrow(ServiceUnavailableException);
      expect(Date.now() - started).toBeLessThan(2000);
      const held = await locker.query(
        `SELECT count(*)::integer AS count FROM pg_locks
        WHERE pid=pg_backend_pid() AND relation=$1::regclass AND mode='AccessExclusiveLock' AND granted`,
        [`${schema}.moderation_delete_intents`],
      );
      expect(held.rows[0].count).toBe(1);
    } finally {
      await locker.query('ROLLBACK');
      locker.release();
    }
    expect(await service().getSnapshot()).toHaveProperty('totalCountLowerBound', 0);
  });
});
