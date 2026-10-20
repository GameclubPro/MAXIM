import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  buildRetirementBlockerQuery,
  buildStopRetirementSourceQuery,
  inspectRetirementReadPlan,
  retirementFailureDiagnostic,
  sanitizeRetirementFailureDiagnostic,
} from './publisher-obsolete-retirement.mjs';
import {
  buildRetirementHelperSource,
  executeRetirementHelper,
} from './publisher-obsolete-retirement-host.mjs';

const secret = 'private-query-parameters-and-credentials';
const shapeDigest = 'a'.repeat(64);
const genericFailure = 'retirement_failed_or_acknowledgement_unknown_fresh_preview_required';
const knownDiagnostic = {
  code: 'unbounded_retirement_read_plan',
  shapeDigest,
  observed: {
    node: 'Index Scan',
    index: 'publication_occurrences_ready_dispatch_idx',
    relation: 'publication_occurrences',
    hasFilter: true,
  },
};
const options = { timeout: 3000, maxBuffer: 8192 };

function childFailure(source, expectedCode, overrides = {}) {
  let caught;
  assert.throws(
    () =>
      executeRetirementHelper(process.execPath, ['--input-type=module', '-e', source], {
        ...options,
        ...overrides,
      }),
    (error) => {
      caught = error;
      assert.equal(error.message, genericFailure);
      assert.equal(error.diagnostic?.code, expectedCode);
      assert.ok(!JSON.stringify(error).includes(secret));
      return true;
    },
  );
  return caught;
}

test('a refused read plan exposes its shape digest without SQL or parameters', async () => {
  const sql = `SELECT id FROM public.publication_occurrences WHERE id=$1 /* ${secret} */`;
  const client = {
    query: async (text, values) => {
      assert.equal(text, `EXPLAIN (FORMAT JSON) ${sql}`);
      assert.deepEqual(values, [secret]);
      return {
        rows: [
          {
            'QUERY PLAN': [
              {
                Plan: {
                  'Node Type': 'Limit',
                  'Plan Rows': 1,
                  Plans: [{ 'Node Type': 'Sort', 'Sort Key': [secret] }],
                },
              },
            ],
          },
        ],
      };
    },
  };
  await assert.rejects(inspectRetirementReadPlan(client, sql, [secret]), (error) => {
    const diagnostic = retirementFailureDiagnostic(error);
    assert.deepEqual(diagnostic, {
      code: 'unbounded_retirement_read_plan',
      shapeDigest: createHash('sha256').update(JSON.stringify(sql)).digest('hex'),
      observed: { node: 'Sort', hasFilter: false },
    });
    assert.ok(!JSON.stringify(diagnostic).includes(secret));
    return true;
  });
});

test('diagnostics whitelist fixed codes, SQLSTATEs and observed plan fields', () => {
  const known = Object.assign(new Error(knownDiagnostic.code), {
    shapeDigest,
    observed: { ...knownDiagnostic.observed, detail: secret },
    detail: secret,
    query: secret,
    params: [secret],
  });
  assert.deepEqual(retirementFailureDiagnostic(known), knownDiagnostic);
  assert.deepEqual(
    sanitizeRetirementFailureDiagnostic({
      ...knownDiagnostic,
      detail: secret,
      query: secret,
      params: [secret],
    }),
    knownDiagnostic,
  );

  for (const pgcode of [
    '57014',
    '55P03',
    '40P01',
    '40001',
    '08000',
    '08001',
    '08003',
    '08004',
    '08006',
    '08P01',
    '53300',
    '57P01',
  ]) {
    assert.deepEqual(
      retirementFailureDiagnostic(
        Object.assign(new Error(secret), {
          code: pgcode,
          detail: secret,
        }),
      ),
      { code: 'retirement_database_error', pgcode },
    );
  }
  assert.deepEqual(
    retirementFailureDiagnostic(
      Object.assign(new Error(secret), {
        code: 'ZZ999',
        detail: secret,
        query: secret,
        params: [secret],
        observed: { node: secret, index: secret, relation: secret, hasFilter: secret },
      }),
    ),
    { code: 'unknown_retirement_failure' },
  );
  for (const value of [
    null,
    secret,
    {},
    {
      code: secret,
      pgcode: secret,
      shapeDigest: secret,
      observed: { node: secret, index: secret, relation: secret, hasFilter: secret },
    },
    {
      code: knownDiagnostic.code,
      pgcode: 'ZZ999',
      shapeDigest: 'g'.repeat(64),
      observed: { node: secret, index: secret, relation: secret, hasFilter: secret },
    },
  ]) {
    const sanitized = sanitizeRetirementFailureDiagnostic(value);
    assert.ok(!JSON.stringify(sanitized).includes(secret));
    assert.ok(!JSON.stringify(sanitized).includes('ZZ999'));
    assert.notEqual(sanitized?.shapeDigest, 'g'.repeat(64));
    assert.ok(
      Object.keys(sanitized ?? {}).every((key) =>
        ['code', 'pgcode', 'shapeDigest', 'observed'].includes(key),
      ),
    );
  }
});

test('generated helper source emits a structured, sanitized failure in a real child', () => {
  const helperUrl = new URL('./publisher-obsolete-retirement.mjs', import.meta.url).href;
  const helper = `
    import { retirementFailureDiagnostic } from ${JSON.stringify(helperUrl)};
    async function runContainerRetirement(request) {
      throw Object.assign(new Error('unbounded_retirement_read_plan'), {
        shapeDigest: ${JSON.stringify(shapeDigest)},
        observed: ${JSON.stringify(knownDiagnostic.observed)},
        detail: request.privateDetail,
        query: request.privateDetail,
      });
    }
  `;
  const generated = buildRetirementHelperSource(helper, { privateDetail: secret });
  const result = spawnSync(process.execPath, ['--input-type=module', '-'], {
    input: generated,
    encoding: 'utf8',
    ...options,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.deepEqual(JSON.parse(result.stderr), {
    kind: 'publisher_obsolete_retirement_failure',
    diagnostic: knownDiagnostic,
  });
  assert.ok(!result.stderr.includes(secret));
});

test('helper transport parses success and preserves only the safe failure envelope', () => {
  assert.deepEqual(
    executeRetirementHelper(
      process.execPath,
      ['-e', 'process.stdout.write(JSON.stringify({report:{sampled:32},readPlans:[]}))'],
      options,
    ),
    {
      report: { sampled: 32 },
      readPlans: [],
    },
  );
  const envelope = {
    kind: 'publisher_obsolete_retirement_failure',
    diagnostic: { ...knownDiagnostic, detail: secret },
    detail: secret,
  };
  const error = childFailure(
    `process.stderr.write(${JSON.stringify(JSON.stringify(envelope))});process.exitCode=1`,
    knownDiagnostic.code,
  );
  assert.deepEqual(error.diagnostic, knownDiagnostic);
  assert.equal(error.stderr, undefined);
  assert.equal(error.stdout, undefined);
});

test('helper transport redacts unknown stderr and distinguishes output and time limits', () => {
  for (const stderr of [
    secret,
    '{broken-json',
    JSON.stringify({
      kind: 'wrong_envelope',
      diagnostic: knownDiagnostic,
      detail: secret,
    }),
  ]) {
    childFailure(
      `process.stderr.write(${JSON.stringify(stderr)});process.exitCode=1`,
      'helper_process_failed',
    );
  }
  childFailure(`process.stdout.write(${JSON.stringify(secret)})`, 'helper_invalid_output');
  childFailure(
    `process.stderr.write(${JSON.stringify(secret)}.repeat(100000))`,
    'helper_output_limit',
    { maxBuffer: 1024 },
  );
  childFailure('setTimeout(() => {}, 10000)', 'helper_timeout', { timeout: 100 });
});

const nativeUrl = process.env.MAXIM_TEST_POSTGRES_URL?.trim();
test(
  'native PostgreSQL 16 bounds rare-status NULL-blocker continuations with competing production indexes',
  { skip: !nativeUrl, timeout: 90_000 },
  async (t) => {
    const address = new URL(nativeUrl);
    assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(address.hostname));
    assert.match(address.pathname, /^\/(?:race_test|maxim_race_test_[a-f0-9]+)$/u);
    const { default: pg } = await import('pg');
    const database = 'race_test_publik_diagnostics_' + randomUUID().replaceAll('-', '');
    const child = new URL(address);
    child.pathname = '/' + database;
    const helper = readFileSync(
      new URL('./publisher-obsolete-retirement.mjs', import.meta.url),
      'utf8',
    );
    const runtimeOptions = helper.match(/options:\s*'([^']*statement_timeout=2000[^']*)'/u)?.[1];
    assert.ok(runtimeOptions, 'use the actual production helper connection options');
    assert.match(runtimeOptions, /(?:^| )-c enable_sort=off(?: |$)/u);
    const admin = new pg.Client({ connectionString: address.href });
    const db = new pg.Client({ connectionString: child.href, options: runtimeOptions });
    await admin.connect();
    try {
      await admin.query('CREATE DATABASE "' + database + '" TEMPLATE template0');
    } catch (error) {
      await admin.end();
      throw error;
    }
    t.after(async () => {
      try {
        await db.end();
      } finally {
        try {
          await admin.query('DROP DATABASE "' + database + '" WITH (FORCE)');
        } finally {
          await admin.end();
        }
      }
    });
    await db.connect();
    const version = Number((await db.query('SHOW server_version_num')).rows[0].server_version_num);
    assert.ok(
      version >= 160000 && version < 170000,
      'exercise the production PostgreSQL 16 planner',
    );
    await db.query(
      readFileSync(
        new URL('./test-fixtures/publisher-obsolete-retirement.sql', import.meta.url),
        'utf8',
      ),
    );
    await db.query(`
      CREATE INDEX publication_occurrences_status_scheduled_idx
        ON publication_occurrences(status,scheduled_at);
      CREATE INDEX publication_occurrences_dispatch_status_scheduled_idx
        ON publication_occurrences(dispatch_profile,status,scheduled_at);
      CREATE INDEX publication_occurrences_blocked_dispatch_idx
        ON publication_occurrences(dispatch_profile,status,dispatch_blocked_at,scheduled_at,id);
      CREATE INDEX publication_occurrences_dispatch_status_created_id_idx
        ON publication_occurrences(dispatch_profile,status,created_at,id);
      INSERT INTO publications(id) VALUES ('planner-parent');
      INSERT INTO publication_schedules(id,publication_id) VALUES ('planner-schedule','planner-parent');
      INSERT INTO publication_occurrences(id,publication_id,schedule_id)
        SELECT 'common-'||n,'planner-parent','planner-schedule' FROM generate_series(1,20000) n;
      INSERT INTO publication_occurrences(id,publication_id,schedule_id,status,dispatch_blocker_code)
        SELECT 'rare-'||lpad(n::text,5,'0'),'planner-parent','planner-schedule','IN_PROGRESS',
          CASE WHEN n<=80 THEN NULL ELSE 'bot_not_admin' END
        FROM generate_series(1,120) n;
      ANALYZE publication_occurrences;
    `);
    const evidence = [];
    for (const [blocker, afterId, expectedRows] of [
      [null, 'rare-00030', 33],
      [null, 'rare-00079', 1],
      [null, 'rare-99999', 0],
      ['bot_not_admin', 'rare-00080', 33],
    ]) {
      const query = buildStopRetirementSourceQuery('IN_PROGRESS', {
        blocker,
        after: { scheduledAt: '2026-10-19T22:00:00.000Z', id: afterId },
      });
      const bounded = await inspectRetirementReadPlan(db, query);
      assert.deepEqual(bounded.indexes, ['publication_occurrences_ready_dispatch_idx']);
      const plan = (
        await db.query('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ' + query.text, query.values)
      ).rows[0]['QUERY PLAN'][0].Plan;
      assert.equal(plan['Node Type'], 'Limit');
      assert.equal(plan['Actual Rows'], expectedRows);
      const scan = plan.Plans[0];
      assert.ok(['Index Scan', 'Index Only Scan'].includes(scan['Node Type']));
      assert.equal(scan['Index Name'], 'publication_occurrences_ready_dispatch_idx');
      assert.equal(scan.Filter, undefined);
      assert.equal(scan['Rows Removed by Filter'] ?? 0, 0);
      assert.equal(scan['Actual Rows'], expectedRows);
      assert.ok(scan['Actual Rows'] <= 33);
      for (const name of [
        'dispatch_profile',
        'status',
        'dispatch_blocker_code',
        'scheduled_at',
        'id',
      ])
        assert.ok(scan['Index Cond'].includes(name));
      evidence.push({ blocker, rows: scan['Actual Rows'], index: scan['Index Name'] });
    }
    for (const previous of [null, 'bot_not_admin']) {
      const bounded = await inspectRetirementReadPlan(
        db,
        buildRetirementBlockerQuery('IN_PROGRESS', previous),
      );
      assert.deepEqual(bounded.indexes, ['publication_occurrences_ready_dispatch_idx']);
      assert.ok(bounded.estimatedRows <= 1);
    }
    t.diagnostic(JSON.stringify({ version, rareNullContinuation: evidence }));
  },
);
