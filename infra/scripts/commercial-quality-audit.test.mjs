import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import {
  COMMERCIAL_QUALITY_AUDIT_COLUMNS,
  buildCommercialQualityAuditSql,
  buildCommercialQualityIndexReadinessSql,
  buildCommercialQualityPrivilegesSql,
} from './commercial-quality-audit.mjs';

const fixture = `CREATE TABLE commercial_review_samples (
  id text PRIMARY KEY, observed_at timestamp(3) NOT NULL DEFAULT now(),
  expires_at timestamp(3) NOT NULL DEFAULT now() + interval '14 days', source text NOT NULL,
  independent_label text, independent_review_count integer NOT NULL DEFAULT 0,
  review_state text NOT NULL DEFAULT 'UNREVIEWED', quality_metadata jsonb,
  evidence jsonb, user_id text, chat_id text, message_id text, label text
);
CREATE INDEX commercial_review_samples_blind_queue_idx
  ON commercial_review_samples (observed_at DESC, id DESC);`;
const readinessQuery = (sql) => sql.slice(0, sql.indexOf('\\gset'));
const query = buildCommercialQualityAuditSql();
const nativePostgresUrl = process.env.MAXIM_TEST_POSTGRES_URL?.trim() ?? '';
const localNativePostgres = (() => {
  try {
    return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(nativePostgresUrl).hostname);
  } catch {
    return false;
  }
})();

test(
  'native PostgreSQL bounds the only base-table walk to the sentinel under representative old history',
  { skip: !localNativePostgres, timeout: 30_000 },
  async (t) => {
    const client = new pg.Client({
      connectionString: nativePostgresUrl,
      statement_timeout: 5000,
      query_timeout: 8000,
    });
    await client.connect();
    t.after(async () => {
      await client.query('ROLLBACK').catch(() => undefined);
      await client.end();
    });
    // FLAG: This fixture and execution plan are local-only and rolled back in the disposable store.
    // The production --explain catalog always uses plain EXPLAIN without execution.
    await client.query('BEGIN');
    await client.query(
      'CREATE SCHEMA commercial_quality_audit_fixture; SET LOCAL search_path TO commercial_quality_audit_fixture, public',
    );
    await client.query(fixture);
    await client.query(`INSERT INTO commercial_review_samples (id, observed_at, source, quality_metadata)
      SELECT 'private-native-' || i, now() - interval '2 days' - i * interval '1 second', 'TEXT', NULL
      FROM generate_series(1, 100000) i;
      INSERT INTO commercial_review_samples (id, observed_at, source, quality_metadata)
      SELECT 'private-recent-' || i, now() - i * interval '1 second', 'OCR',
        '{"schemaVersion":2,"samplingProbability":1,"samplingStratum":"HIT","sourceExcerptComplete":true}'
      FROM generate_series(1, 6000) i;
      ANALYZE commercial_review_samples;
      SET LOCAL enable_seqscan = off; SET LOCAL enable_bitmapscan = off;
      SET LOCAL max_parallel_workers_per_gather = 0;`);
    const report = (await client.query(query)).rows[0].json_build_object;
    assert.equal(report.captured_samples, 5000);
    assert.equal(report.truncated, true);
    const plan = (await client.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query}`)).rows[0][
      'QUERY PLAN'
    ][0].Plan;
    const nodes = [];
    const walk = (node) => {
      nodes.push(node);
      for (const child of node.Plans ?? []) walk(child);
    };
    walk(plan);
    const tableWalks = nodes.filter(
      (node) => node['Relation Name'] === 'commercial_review_samples',
    );
    assert.equal(tableWalks.length, 1);
    assert.equal(tableWalks[0]['Index Name'], 'commercial_review_samples_blind_queue_idx');
    assert.equal(tableWalks[0]['Actual Rows'], 5001);
    assert.equal(tableWalks[0]['Actual Loops'], 1);
    assert.equal(
      (
        await client.query(
          readinessQuery(buildCommercialQualityIndexReadinessSql()).replaceAll(
            'public.commercial_review_samples',
            'commercial_quality_audit_fixture.commercial_review_samples',
          ),
        )
      ).rows[0].commercial_quality_index_ready,
      true,
    );
    assert.doesNotMatch(JSON.stringify(report), /private-/u);
  },
);

test('reports sampled policy, independent labels and technical outcomes without leaking arbitrary values', async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(fixture);
  await db.query(
    `INSERT INTO commercial_review_samples
    (id, source, independent_label, independent_review_count, review_state, quality_metadata, evidence, user_id)
    VALUES ('private-1', 'OCR', 'COMMERCIAL', 2, 'RESOLVED', $1::jsonb, '{"excerpt":"private-secret"}', 'private-user'),
      ('private-2', 'TEXT', 'private-label', 1, 'private-state', $2::jsonb, NULL, NULL)`,
    [
      JSON.stringify({
        schemaVersion: 2,
        samplingProbability: 0.1,
        samplingStratum: 'NO_HIT',
        randomEvaluationIncluded: true,
        evaluationSamplingProbability: 0.1,
        pseudonymizationKeyId: 'private-key-identity',
        decisionOutcome: 'KEEP',
        deleteEligible: false,
        executionOutcome: 'NOT_REQUESTED',
        analysisOutcome: 'TECHNICAL_INCOMPLETE',
        sourceExcerptComplete: true,
        reasons: ['private-reason'],
        candidateDecision: { score: 100, detectorVersion: 'private-detector' },
      }),
      JSON.stringify({
        schemaVersion: 2,
        samplingProbability: 'private-number',
        samplingStratum: 'private-stratum',
        randomEvaluationIncluded: 'true',
        evaluationSamplingProbability: '0.1',
        pseudonymizationKeyId: 123,
        decisionOutcome: 'private-policy',
        deleteEligible: 'private-boolean',
        executionOutcome: 'private-execution',
        analysisOutcome: 'private-analysis',
        sourceExcerptComplete: 'private-boolean',
      }),
    ],
  );
  const report = (await db.query(query)).rows[0].json_build_object;
  assert.equal(report.captured_samples, 2);
  assert.equal(report.probability_unknown, 1);
  assert.equal(report.uniform_evaluation_samples, 1);
  assert.equal(report.evaluation_membership_unknown, 1);
  assert.equal(report.evaluation_probability_known, 1);
  assert.equal(report.evaluation_probability_unknown, 1);
  assert.equal(report.key_identity_unknown, 1);
  assert.equal(report.complete, false);
  assert.equal(report.accuracy_measured, false);
  assert.equal(report.population_basis, 'captured_review_samples_not_all_messages');
  assert.equal(
    report.source_strata.find((row) => row.source === 'OCR').weighted_captured_population_estimate,
    10,
  );
  assert.deepEqual(
    report.decisions.find((row) => row.source === 'OCR'),
    {
      source: 'OCR',
      decision: 'KEEP',
      delete_eligible: 'NO',
      execution: 'NOT_REQUESTED',
      captured_samples: 1,
    },
  );
  assert.equal(
    report.independent_reviews.find((row) => row.source === 'TEXT').independent_label,
    'UNKNOWN',
  );
  assert.equal(
    report.independent_reviews.find((row) => row.source === 'OCR').review_count,
    'TWO_OR_MORE',
  );
  assert.equal(
    report.analysis_outcomes.find((row) => row.source === 'OCR').analysis,
    'TECHNICAL_INCOMPLETE',
  );
  assert.doesNotMatch(
    JSON.stringify(report),
    /private-|score|candidateDecision|user_id|chat_id|message_id/u,
  );
});

test('caps the indexed recent window before classification and exposes the saturation sentinel', async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(fixture);
  await db.exec(`INSERT INTO commercial_review_samples (id, observed_at, source, quality_metadata)
    SELECT 'private-' || i, now() - i * interval '1 second', 'TEXT',
      '{"schemaVersion":2,"samplingProbability":1,"samplingStratum":"HIT","sourceExcerptComplete":true}'
    FROM generate_series(1, 6000) i;
    INSERT INTO commercial_review_samples (id, observed_at, source)
    SELECT 'private-old-' || i, now() - interval '2 days' - i * interval '1 second', 'TEXT'
    FROM generate_series(1, 10000) i;
    ANALYZE; SET enable_seqscan = off; SET enable_bitmapscan = off;`);
  const report = (await db.query(query)).rows[0].json_build_object;
  assert.equal(report.captured_samples, 5000);
  assert.equal(report.truncated, true);
  assert.equal(report.complete, false);
  assert.equal(report.source_strata[0].captured_samples, 5000);
  assert.doesNotMatch(JSON.stringify(report), /private-/u);
  const plan = JSON.stringify((await db.query(buildCommercialQualityAuditSql(true))).rows);
  assert.match(plan, /commercial_review_samples_blind_queue_idx/u);
  assert.doesNotMatch(plan, /"Node Type":"Seq Scan"/u);
  const ready = readinessQuery(buildCommercialQualityIndexReadinessSql());
  assert.equal((await db.query(ready)).rows[0].commercial_quality_index_ready, true);
  await db.exec('DROP INDEX commercial_review_samples_blind_queue_idx;');
  assert.equal((await db.query(ready)).rows[0].commercial_quality_index_ready, false);
  await db.exec(
    'CREATE INDEX commercial_review_samples_blind_queue_idx ON commercial_review_samples (observed_at ASC, id DESC);',
  );
  assert.equal((await db.query(ready)).rows[0].commercial_quality_index_ready, false);
});

test('handles legacy/missing metadata, invalid probabilities and expired samples explicitly', async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(fixture);
  await db.query(
    `INSERT INTO commercial_review_samples (id, source, expires_at, quality_metadata)
    VALUES ('private-legacy', 'TEXT', now() - interval '1 minute', $1::jsonb),
      ('private-zero', 'private-source', now() + interval '1 day', $2::jsonb),
      ('private-missing', 'OCR', now() + interval '1 day', NULL)`,
    [
      JSON.stringify({ schemaVersion: 1, samplingProbability: 1, decisionOutcome: 'DELETE' }),
      JSON.stringify({ schemaVersion: 2, samplingProbability: 0, sourceExcerptComplete: false }),
    ],
  );
  const report = (await db.query(query)).rows[0].json_build_object;
  assert.equal(report.metadata_missing_or_legacy, 2);
  assert.equal(report.probability_unknown, 3);
  assert.equal(report.expired_samples, 1);
  assert.equal(report.uniform_evaluation_samples, 0);
  assert.equal(report.evaluation_membership_unknown, 3);
  assert.equal(report.evaluation_probability_unknown, 3);
  assert.equal(report.key_identity_unknown, 3);
  assert.equal(
    report.decisions.every((row) => row.decision === 'UNKNOWN'),
    true,
  );
  assert.doesNotMatch(JSON.stringify(report), /private-/u);
});

test('counts uniform-frame metadata using boolean and bounded probability types without emitting key identities', async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(fixture);
  const values = [
    {
      randomEvaluationIncluded: true,
      evaluationSamplingProbability: 0.1,
      pseudonymizationKeyId: 'private-key-a',
    },
    {
      randomEvaluationIncluded: false,
      evaluationSamplingProbability: 1,
      pseudonymizationKeyId: 'private-key-b',
    },
    {
      randomEvaluationIncluded: 'true',
      evaluationSamplingProbability: '0.1',
      pseudonymizationKeyId: 12,
    },
    {
      randomEvaluationIncluded: null,
      evaluationSamplingProbability: 0,
      pseudonymizationKeyId: null,
    },
    { evaluationSamplingProbability: 1.1, pseudonymizationKeyId: '' },
    { randomEvaluationIncluded: true, evaluationSamplingProbability: -0.1 },
  ];
  for (const [index, metadata] of values.entries()) {
    await db.query(
      'INSERT INTO commercial_review_samples (id, source, quality_metadata) VALUES ($1, $2, $3::jsonb)',
      [
        `private-${index}`,
        'TEXT',
        JSON.stringify({ schemaVersion: 2, samplingProbability: 1, ...metadata }),
      ],
    );
  }
  const report = (await db.query(query)).rows[0].json_build_object;
  assert.equal(report.uniform_evaluation_samples, 2);
  assert.equal(report.evaluation_membership_unknown, 3);
  assert.equal(report.evaluation_probability_known, 2);
  assert.equal(report.evaluation_probability_unknown, 4);
  assert.equal(report.key_identity_unknown, 4);
  assert.doesNotMatch(JSON.stringify(report), /private-|pseudonymizationKeyId/u);
});

test('requires only eight metadata grants, denies evidence and rejects inherited excess grants', async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(fixture);
  await db.exec('CREATE ROLE maxim_audit; GRANT USAGE ON SCHEMA public TO maxim_audit;');
  const optional = readinessQuery(buildCommercialQualityPrivilegesSql(false));
  const required = readinessQuery(buildCommercialQualityPrivilegesSql(true));
  assert.equal((await db.query(optional)).rows[0].commercial_quality_privileges_ready, true);
  assert.equal((await db.query(required)).rows[0].commercial_quality_privileges_ready, false);
  await db.exec(`GRANT SELECT (${COMMERCIAL_QUALITY_AUDIT_COLUMNS.join(', ')})
    ON commercial_review_samples TO maxim_audit; SET SESSION AUTHORIZATION maxim_audit;`);
  assert.equal((await db.query(required)).rows[0].commercial_quality_privileges_ready, true);
  assert.equal((await db.query(query)).rows[0].json_build_object.audit, 'commercial_quality');
  for (const column of ['evidence', 'user_id', 'chat_id', 'message_id', 'label']) {
    await assert.rejects(
      db.query(`SELECT ${column} FROM commercial_review_samples`),
      /permission denied/u,
    );
  }
  await db.exec(
    'SET SESSION AUTHORIZATION postgres; GRANT SELECT (evidence) ON commercial_review_samples TO PUBLIC;',
  );
  assert.equal((await db.query(optional)).rows[0].commercial_quality_privileges_ready, false);
});

test('reviewed provision/reset blocks grant exactly metadata and stay compatible before the additive migration', async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(fixture);
  await db.exec('CREATE ROLE maxim_audit; GRANT USAGE ON SCHEMA public TO maxim_audit;');
  const provision = readFileSync(
    resolve(import.meta.dirname, 'vps-provision-postgres-audit-role.sh'),
    'utf8',
  );
  const block = (marker) => {
    const start = provision.indexOf(`DO $${marker}$`);
    const end = provision.indexOf(`$${marker}$;`, start) + marker.length + 3;
    assert.ok(start >= 0 && end > start);
    return provision.slice(start, end);
  };
  const grant = block('commercial_quality_grants');
  const reset = block('revoke_audit_columns');
  await db.exec(grant);
  const ready = readinessQuery(buildCommercialQualityPrivilegesSql(true));
  assert.equal((await db.query(ready)).rows[0].commercial_quality_privileges_ready, true);
  assert.equal(
    (
      await db.query(`SELECT count(*)::int AS count FROM information_schema.role_column_grants
    WHERE grantee = 'maxim_audit' AND table_name = 'commercial_review_samples' AND privilege_type = 'SELECT'`)
    ).rows[0].count,
    8,
  );
  await db.exec('GRANT SELECT (evidence) ON commercial_review_samples TO maxim_audit;');
  assert.equal((await db.query(ready)).rows[0].commercial_quality_privileges_ready, false);
  await db.exec(reset + grant);
  assert.equal((await db.query(ready)).rows[0].commercial_quality_privileges_ready, true);
  await db.exec('ALTER TABLE commercial_review_samples DROP COLUMN quality_metadata;');
  await db.exec(reset + grant);
  assert.equal((await db.query(ready)).rows[0].commercial_quality_privileges_ready, false);
  assert.equal(
    (await db.query(readinessQuery(buildCommercialQualityPrivilegesSql(false)))).rows[0]
      .commercial_quality_privileges_ready,
    true,
  );
});

test('CLI accepts only a fixed report or plain EXPLAIN and no operator SQL/path/identity', () => {
  const script = resolve(import.meta.dirname, 'commercial-quality-audit.mjs');
  for (const args of [
    ['SELECT 1'],
    ['--file', '/tmp/private'],
    ['private-chat'],
    ['--explain', 'extra'],
  ]) {
    const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, '');
  }
  assert.match(buildCommercialQualityAuditSql(true), /^EXPLAIN \(FORMAT JSON\)/u);
  assert.doesNotMatch(buildCommercialQualityAuditSql(true), /EXPLAIN\s+ANALYZE/iu);
});
