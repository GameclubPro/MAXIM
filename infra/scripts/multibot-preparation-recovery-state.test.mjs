import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { runMultibotSupervisorCommand } from './multibot-online-supervisor.mjs';
import {
  multibotPreparationChecksums,
  MULTIBOT_PREPARATION_MIGRATIONS,
  multibotPreparationDiagnosticsSql,
} from './multibot-prepare-diagnostics.mjs';
import {
  MULTIBOT_PREPARATION_RECOVERY_MIGRATION,
  multibotPreparationRecoveryDdl,
  planMultibotPreparationRecovery,
  recoverMultibotPreparation,
} from './multibot-preparation-recovery-state.mjs';

const nowMs = Date.parse('2026-10-05T15:00:00.000Z');
const indexes = [
  [
    'webhook_events_semantic_order_idx',
    ['semantic_key', 'created_at', 'id'],
    '(semantic_key IS NOT NULL)',
  ],
  ['webhook_events_status_created_at_id_idx', ['status', 'created_at', 'id'], null],
  [
    'webhook_events_semantic_replay_fence_idx',
    ['semantic_key', 'id'],
    "((semantic_key IS NOT NULL) AND ((status = ANY (ARRAY['RECEIVED'::\"WebhookStatus\", 'QUEUED'::\"WebhookStatus\"])) OR ((status = 'FAILED'::\"WebhookStatus\") AND (next_enqueue_at IS NOT NULL)) OR (timeout_quarantine_expires_at IS NOT NULL) OR (COALESCE(error_message, ''::text) ~~* '%ambiguous%'::text) OR (COALESCE(error_message, ''::text) ~~ 'WEBHOOK_HOT_PATH_TIMEOUT%QUARANTINED%'::text)))",
  ],
];

function context() {
  const value = {
    sourceSha: 'a'.repeat(40),
    cancelledSourceSha: 'b'.repeat(40),
    expectedTransitionSourceSha: 'c'.repeat(40),
    expectedTransitionJournalHash: 'd'.repeat(64),
    expectedReceiptIdentityHash: 'e'.repeat(64),
    attemptStartedAt: '2026-10-05T13:00:00.000Z',
    attemptAbortedAt: '2026-10-05T14:00:00.000Z',
    nowMs,
  };
  value.cancellationProof = {
    sourceSha: value.cancelledSourceSha,
    transitionSourceSha: value.expectedTransitionSourceSha,
    transitionJournalHash: value.expectedTransitionJournalHash,
    receiptIdentityHash: value.expectedReceiptIdentityHash,
    attemptStartedAt: value.attemptStartedAt,
    attemptAbortedAt: value.attemptAbortedAt,
    cleanupVerifiedAt: '2026-10-05T14:59:55.000Z',
    taggedSessionsAbsent: true,
    ownedContainerStopped: true,
    baselineRuntimeAttested: true,
  };
  return value;
}

function report() {
  return {
    schema_version: 1,
    audit: 'multibot_preparation',
    read_only: true,
    authority: 'DIAGNOSTICS_ONLY',
    parent_kind: 'r',
    storage_layout_matches: true,
    metadata_limit_exceeded: false,
    columns: [
      ['semantic_key', 'text'],
      ['execution_deadline_at', 'timestamp(3) without time zone'],
    ].map(([name, type]) => ({
      name,
      type,
      present: true,
      not_null: false,
      default_present: false,
      identity: '',
      generated: '',
      default_collation: true,
    })),
    indexes: indexes.map(([name, keys, predicate]) => ({
      name,
      present: true,
      kind: 'i',
      parent_matches: true,
      valid: true,
      ready: true,
      live: true,
      unique: false,
      primary: false,
      exclusion: false,
      method: 'btree',
      key_count: keys.length,
      attribute_count: keys.length,
      expected_keys: keys,
      expected_predicate: predicate,
      definition_matches: true,
      state: 'READY',
    })),
    repair_artifacts: { present: false, sampled_count: 0, limited: false },
    builders: {
      statistics_visible: true,
      absent: true,
      limited: false,
      tagged_sessions: 0,
      active_tagged_sessions: 0,
      active_index_sessions: 0,
      progress_sessions: 0,
      prepared_transactions: 0,
      prepared_webhook_relation_locks: 0,
    },
    metadata: {
      other_failed: false,
      migrations: MULTIBOT_PREPARATION_MIGRATIONS.map((name, position) => ({
        name,
        expected_checksum: multibotPreparationChecksums[name],
        limited: false,
        records:
          position > 2
            ? []
            : [
                {
                  identity_hash: position === 2 ? 'e'.repeat(64) : `${position}`.repeat(64),
                  checksum: multibotPreparationChecksums[name],
                  checksum_matches: true,
                  started_at: '2026-10-05T13:05:00.000Z',
                  finished_at: position === 2 ? null : '2026-10-05T13:10:00.000Z',
                  rolled_back_at: null,
                  state: position === 2 ? 'UNFINISHED' : 'APPLIED',
                  failure_code: 'NO_ERROR_RECORDED',
                  applied_steps_count: position === 2 ? 0 : 1,
                },
              ],
      })),
    },
  };
}

function incomplete(value, position = 1, ready = false) {
  Object.assign(value.indexes[position], { valid: false, ready, state: 'INCOMPLETE' });
  return value;
}

function absent(value, position = 2) {
  Object.assign(value.indexes[position], {
    present: false,
    definition_matches: false,
    state: 'ABSENT',
  });
  return value;
}

function record(value) {
  return value.metadata.migrations[2].records[0];
}

function resolveReceipt(value) {
  const original = record(value);
  Object.assign(original, { state: 'ROLLED_BACK', rolled_back_at: '2026-10-05T15:00:00.000Z' });
  value.metadata.migrations[2].records.push({
    ...original,
    identity_hash: 'f'.repeat(64),
    state: 'APPLIED',
    rolled_back_at: null,
    started_at: '2026-10-05T15:00:00.000Z',
    finished_at: '2026-10-05T15:00:00.000Z',
    failure_code: 'NO_ERROR_RECORDED',
  });
}

test('preview selects only the exact interrupted indexes and independently attested empty-log receipt', () => {
  const value = absent(incomplete(report()));
  const plan = planMultibotPreparationRecovery(value, context());
  assert.deepEqual(plan.actions, [
    { index: indexes[1][0], action: 'reindex' },
    { index: indexes[2][0], action: 'create' },
  ]);
  assert.equal(plan.state, 'RECOVERY_REQUIRED');
  assert.equal(plan.migration, MULTIBOT_PREPARATION_RECOVERY_MIGRATION);
  assert.equal(JSON.stringify(plan).includes('e'.repeat(64)), false);
  assert.deepEqual(planMultibotPreparationRecovery(report(), context()).actions, []);
});

test('successful preparation parents require exactly one applied step each', () => {
  for (const position of [0, 1]) {
    for (const count of [0, 2, -1, 0.5, '1', null, undefined, NaN]) {
      const value = report();
      value.metadata.migrations[position].records[0].applied_steps_count = count;
      assert.throws(() => planMultibotPreparationRecovery(value, context()), /RECEIPT_INVALID/u);
    }
  }
});

test('unknown or external storage layout never admits preview or repair', async () => {
  for (const storageLayout of [false, null, undefined, 'true']) {
    const value = absent(incomplete(report()));
    value.storage_layout_matches = storageLayout;
    assert.throws(
      () => planMultibotPreparationRecovery(value, context()),
      /ADMISSION_METADATA_INVALID/u,
    );
    const ops = operations(value);
    await assert.rejects(
      recoverMultibotPreparation(ops, context(), { apply: true }),
      /ADMISSION_METADATA_INVALID/u,
    );
    assert.deepEqual(ops.calls, ['attest', 'read']);
  }
});

test('cancelled original and new Prisma resolution receipts require exact zero-step evidence', () => {
  for (const phase of ['unfinished', 'rolled-back', 'new-applied']) {
    for (const count of [1, 2, -1, 0.5, '0', null, undefined, NaN]) {
      const value = report();
      if (phase !== 'unfinished') resolveReceipt(value);
      const changed =
        phase === 'new-applied' ? value.metadata.migrations[2].records[1] : record(value);
      changed.applied_steps_count = count;
      assert.throws(() => planMultibotPreparationRecovery(value, context()), /RECEIPT_INVALID/u);
    }
  }
  const resolved = report();
  resolveReceipt(resolved);
  assert.equal(planMultibotPreparationRecovery(resolved, context()).state, 'ALREADY_APPLIED');
});

test('fixed DDL preserves all immutable161 index predicates and rejects arbitrary targets/actions', () => {
  const migration = readFileSync(
    resolve(
      import.meta.dirname,
      '../../apps/api/prisma/migrations',
      MULTIBOT_PREPARATION_RECOVERY_MIGRATION,
      'migration.sql',
    ),
    'utf8',
  );
  for (const [name] of indexes.slice(1)) {
    const sql = multibotPreparationRecoveryDdl(name, 'create');
    assert.ok(migration.includes(sql.replaceAll('public.', '')));
    assert.equal(
      multibotPreparationRecoveryDdl(name, 'reindex'),
      `REINDEX INDEX CONCURRENTLY public."${name}";`,
    );
  }
  for (const name of [
    indexes[0][0],
    `${indexes[1][0]}_ccnew`,
    'arbitrary;DROP TABLE anything',
    '__proto__',
    'constructor',
    'toString',
  ])
    assert.throws(() => multibotPreparationRecoveryDdl(name, 'reindex'), /DDL_OUTSIDE_SCOPE/u);
  assert.throws(() => multibotPreparationRecoveryDdl(indexes[1][0], 'drop'), /DDL_OUTSIDE_SCOPE/u);
});

test('absence, drift, unfinished parents, duplicate/foreign receipts and cutoff initiation fail closed', () => {
  const cases = [
    (v) => incomplete(v, 0),
    (v) => absent(v, 0),
    (v) => {
      v.indexes[1].definition_matches = false;
    },
    (v) => {
      v.indexes[1].expected_keys = ['created_at', 'status', 'id'];
    },
    (v) => {
      v.indexes[2].expected_predicate = '(semantic_key IS NOT NULL)';
    },
    (v) => {
      v.indexes[1].live = false;
    },
    (v) => {
      v.indexes[1].valid = true;
      v.indexes[1].ready = false;
    },
    (v) => {
      v.indexes[1].method = 'hash';
    },
    (v) => {
      v.indexes[1].unique = true;
    },
    (v) => {
      v.indexes.push(v.indexes[1]);
    },
    (v) => {
      v.columns[0].type = 'character varying';
    },
    (v) => {
      v.columns[1].default_present = true;
    },
    (v) => {
      v.metadata.migrations[0].records[0].state = 'UNFINISHED';
    },
    (v) => {
      v.metadata.migrations[1].records[0].checksum = 'f'.repeat(64);
    },
    (v) => {
      v.metadata.migrations[2].records.push({ ...record(v) });
    },
    (v) => {
      record(v).rolled_back_at = '2026-10-05T13:07:00.000Z';
    },
    (v) => {
      v.metadata.migrations[3].records.push({});
    },
    (v) => {
      v.metadata.migrations[4].limited = true;
    },
    (v) => {
      v.metadata.other_failed = true;
    },
    (v) => {
      v.metadata_limit_exceeded = true;
    },
    (v) => {
      v.repair_artifacts.present = true;
    },
    (v) => {
      v.repair_artifacts.sampled_count = 1;
    },
    (v) => {
      v.builders.statistics_visible = false;
    },
    (v) => {
      v.builders.absent = false;
    },
    ...[
      'tagged_sessions',
      'active_index_sessions',
      'progress_sessions',
      'prepared_transactions',
      'prepared_webhook_relation_locks',
    ].map((name) => (v) => {
      v.builders[name] = 1;
    }),
  ];
  for (const mutate of cases) {
    const value = report();
    mutate(value);
    assert.throws(() => planMultibotPreparationRecovery(value, context()), /MULTIBOT_RECOVERY_/u);
  }
});

test('unfinished cancellation requires exact sources, journal, receipt, observed bounds and fresh cleanup', () => {
  const cases = [
    (c) => {
      delete c.cancellationProof;
    },
    (c) => {
      c.cancellationProof.sourceSha = c.sourceSha;
    },
    (c) => {
      c.cancellationProof.transitionSourceSha = c.cancelledSourceSha;
    },
    (c) => {
      c.cancellationProof.transitionJournalHash = 'f'.repeat(64);
    },
    (c) => {
      c.cancellationProof.receiptIdentityHash = 'f'.repeat(64);
    },
    (c) => {
      c.cancellationProof.attemptStartedAt = '2026-10-05T12:59:00.000Z';
    },
    (c) => {
      c.cancellationProof.attemptAbortedAt = '2026-10-05T14:01:00.000Z';
    },
    (c) => {
      c.cancellationProof.taggedSessionsAbsent = false;
    },
    (c) => {
      c.cancellationProof.ownedContainerStopped = false;
    },
    (c) => {
      c.cancellationProof.baselineRuntimeAttested = false;
    },
    (c) => {
      c.cancellationProof.cleanupVerifiedAt = '2026-10-05T14:58:59.999Z';
    },
    (c) => {
      c.cancellationProof.cleanupVerifiedAt = '2026-10-05T15:00:00.001Z';
    },
    (c) => {
      c.attemptStartedAt = c.cancellationProof.attemptStartedAt = '2026-10-05T13:06:00.000Z';
    },
    (c) => {
      c.attemptAbortedAt = c.cancellationProof.attemptAbortedAt = '2026-10-05T13:04:00.000Z';
    },
    (c) => {
      c.attemptStartedAt = c.cancellationProof.attemptStartedAt = '2026-02-30T13:00:00.000Z';
    },
  ];
  for (const mutate of cases) {
    const input = context();
    mutate(input);
    assert.throws(() => planMultibotPreparationRecovery(report(), input), /MULTIBOT_RECOVERY_/u);
  }
});

function operations(value, input = context()) {
  const calls = [];
  return {
    calls,
    now: () => nowMs,
    attestCancellation: async () => {
      calls.push('attest');
      return input.cancellationProof;
    },
    readDiagnostic: async () => {
      calls.push('read');
      return structuredClone(value);
    },
    assertAdmission: async () => {
      calls.push('admit');
    },
    repairIndex: async ({ index, action, sql }) => {
      calls.push(action);
      assert.equal(sql, multibotPreparationRecoveryDdl(index, action));
      Object.assign(
        value.indexes.find((entry) => entry.name === index),
        {
          present: true,
          definition_matches: true,
          valid: true,
          ready: true,
          live: true,
          state: 'READY',
        },
      );
    },
    resolveMigration: async (name) => {
      calls.push('resolve');
      assert.equal(name, MULTIBOT_PREPARATION_RECOVERY_MIGRATION);
      resolveReceipt(value);
    },
  };
}

test('invalid original step counts block apply before admission, DDL or resolution', async () => {
  for (const count of [1, -1, '0', null]) {
    const value = absent(incomplete(report()));
    record(value).applied_steps_count = count;
    const original = structuredClone(value);
    const ops = operations(value);
    await assert.rejects(
      recoverMultibotPreparation(ops, context(), { apply: true }),
      /RECEIPT_INVALID/u,
    );
    assert.deepEqual(ops.calls, ['attest', 'read']);
    assert.deepEqual(value, original);
  }
});

test('a changed allowed cancellation family blocks later work while preserving the original receipt', async () => {
  for (const phase of ['before-repair', 'after-repair', 'before-resolve']) {
    const value = phase === 'before-resolve' ? report() : absent(incomplete(report()));
    const ops = operations(value);
    if (phase === 'after-repair') {
      const repair = ops.repairIndex;
      ops.repairIndex = async (action) => {
        await repair(action);
        record(value).failure_code = 'QUERY_CANCELLED';
      };
    } else {
      const admit = ops.assertAdmission;
      ops.assertAdmission = async () => {
        await admit();
        record(value).failure_code = 'CONNECTION_TERMINATED';
      };
    }
    await assert.rejects(
      recoverMultibotPreparation(ops, context(), { apply: true }),
      /RECEIPT_CHANGED/u,
    );
    assert.equal(ops.calls.includes('resolve'), false);
    assert.equal(
      ops.calls.filter((call) => ['create', 'reindex'].includes(call)).length,
      phase === 'after-repair' ? 1 : 0,
    );
    assert.equal(record(value).state, 'UNFINISHED');
    assert.equal(record(value).rolled_back_at, null);
    assert.equal(record(value).applied_steps_count, 0);
  }
});

test('changed original evidence or nonzero new receipt cannot report successful Prisma resolution', async () => {
  for (const corruption of ['original-family', 'original-steps', 'applied-steps']) {
    const value = report();
    const ops = operations(value);
    const resolveMigration = ops.resolveMigration;
    ops.resolveMigration = async (name) => {
      await resolveMigration(name);
      if (corruption === 'original-family') record(value).failure_code = 'QUERY_CANCELLED';
      if (corruption === 'original-steps') record(value).applied_steps_count = 1;
      if (corruption === 'applied-steps')
        value.metadata.migrations[2].records[1].applied_steps_count = 1;
    };
    await assert.rejects(
      recoverMultibotPreparation(ops, context(), { apply: true }),
      corruption === 'original-family' ? /RESOLVE_POSTCONDITION_FAILED/u : /RECEIPT_INVALID/u,
    );
    assert.equal(ops.calls.filter((call) => call === 'resolve').length, 1);
    assert.equal(value.metadata.migrations[2].records.length, 2);
  }
});

test('an independently attested cancellation family remains valid when unchanged through resolution', async () => {
  for (const failure of ['NO_ERROR_RECORDED', 'QUERY_CANCELLED', 'CONNECTION_TERMINATED']) {
    const value = absent(incomplete(report()));
    record(value).failure_code = failure;
    const ops = operations(value);
    assert.equal((await recoverMultibotPreparation(ops, context(), { apply: true })).applied, true);
    assert.equal(record(value).failure_code, failure);
    assert.deepEqual(
      value.metadata.migrations[2].records.map((entry) => entry.applied_steps_count),
      [0, 0],
    );
  }
});

test('apply reattests cancellation and catalog/admission before each repair and resolves only complete proof', async () => {
  const value = absent(incomplete(report()));
  const ops = operations(value);
  const preview = await recoverMultibotPreparation(ops, context());
  assert.equal(preview.applied, false);
  assert.deepEqual(ops.calls, ['attest', 'read']);
  ops.calls.length = 0;
  const result = await recoverMultibotPreparation(ops, context(), { apply: true });
  assert.equal(result.applied, true);
  assert.equal(result.state, 'ALREADY_APPLIED');
  assert.deepEqual(ops.calls, [
    'attest',
    'read',
    'admit',
    'attest',
    'read',
    'reindex',
    'attest',
    'read',
    'admit',
    'attest',
    'read',
    'create',
    'attest',
    'read',
    'admit',
    'attest',
    'read',
    'resolve',
    'attest',
    'read',
  ]);
  ops.calls.length = 0;
  assert.equal((await recoverMultibotPreparation(ops, context(), { apply: true })).applied, false);
  assert.deepEqual(ops.calls, ['attest', 'read']);
});

test('repair rejection or missing postcondition never resolves or retries and retains unfinished receipt', async () => {
  for (const repair of ['throw', 'noop', 'artifact', 'receipt-change']) {
    const value = absent(incomplete(report()));
    const ops = operations(value);
    let attempts = 0;
    const original = ops.repairIndex;
    ops.repairIndex = async (action) => {
      attempts += 1;
      if (repair === 'throw') throw new Error('CONTROLLED_BUILD_ABORT');
      if (repair === 'noop') return;
      await original(action);
      if (repair === 'artifact') value.repair_artifacts.present = true;
      if (repair === 'receipt-change') record(value).identity_hash = 'f'.repeat(64);
    };
    await assert.rejects(recoverMultibotPreparation(ops, context(), { apply: true }));
    assert.equal(attempts, 1);
    assert.equal(ops.calls.includes('resolve'), false);
    assert.equal(record(value).state, 'UNFINISHED');
  }
});

test('admission failures, cancellation proof changes and resolution failures cannot record success', async () => {
  for (const stage of ['admission', 'proof', 'resolve-noop', 'resolve-replaced']) {
    const value = report();
    const ops = operations(value);
    if (stage === 'admission')
      ops.assertAdmission = async () => {
        throw new Error('RUNTIME_LAG_ABORT');
      };
    if (stage === 'proof') {
      let reads = 0;
      ops.attestCancellation = async () => (++reads > 1 ? {} : context().cancellationProof);
    }
    if (stage === 'resolve-noop') ops.resolveMigration = async () => {};
    if (stage === 'resolve-replaced')
      ops.resolveMigration = async () => {
        Object.assign(record(value), {
          state: 'APPLIED',
          finished_at: '2026-10-05T15:00:00.000Z',
          identity_hash: 'f'.repeat(64),
        });
      };
    await assert.rejects(recoverMultibotPreparation(ops, context(), { apply: true }));
  }
});

test('a string apply flag never turns a preview request into a mutation', async () => {
  const ops = operations(report());
  await assert.rejects(
    recoverMultibotPreparation(ops, context(), { apply: 'false' }),
    /APPLY_MODE_INVALID/u,
  );
  assert.deepEqual(ops.calls, []);
});

const nativePostgresUrl = process.env.MAXIM_TEST_POSTGRES_URL?.trim();
test(
  'native PostgreSQL repairs a genuinely cancelled concurrent index and preserves exact replay predicate',
  { skip: !nativePostgresUrl, timeout: 30_000 },
  async () => {
    const address = new URL(nativePostgresUrl);
    assert.ok(
      ['127.0.0.1', 'localhost', '[::1]'].includes(address.hostname) &&
        address.pathname.includes('race_test'),
    );
    const { default: pg } = await import('pg');
    const admin = new pg.Client({
      connectionString: nativePostgresUrl,
      connectionTimeoutMillis: 5_000,
    });
    const database = `race_test_mb_recovery_${randomUUID().replaceAll('-', '')}`;
    const localAddress = new URL(nativePostgresUrl);
    localAddress.pathname = `/${database}`;
    const clients = [];
    let created = false;
    let pending;
    await admin.connect();
    try {
      await admin.query(`CREATE DATABASE "${database}" TEMPLATE template0`);
      created = true;
      const connect = async () => {
        const client = new pg.Client({
          connectionString: localAddress.href,
          connectionTimeoutMillis: 5_000,
          query_timeout: 15_000,
          options: '-c statement_timeout=15000 -c timezone=UTC',
        });
        clients.push(client);
        await client.connect();
        return client;
      };
      const reader = await connect();
      const writer = await connect();
      const builder = await connect();
      const fixtureNow = Date.now();
      const nativeContext = context();
      nativeContext.nowMs = fixtureNow;
      nativeContext.attemptStartedAt = new Date(fixtureNow - 120_000).toISOString();
      nativeContext.attemptAbortedAt = new Date(fixtureNow - 60_000).toISOString();
      Object.assign(nativeContext.cancellationProof, {
        attemptStartedAt: nativeContext.attemptStartedAt,
        attemptAbortedAt: nativeContext.attemptAbortedAt,
        cleanupVerifiedAt: new Date(fixtureNow).toISOString(),
      });
      await reader.query(`CREATE TYPE public."WebhookStatus" AS ENUM ('RECEIVED','QUEUED','FAILED','PROCESSED');
        CREATE TABLE public.webhook_events (id text NOT NULL, status public."WebhookStatus" NOT NULL,
          created_at timestamp(3) NOT NULL, semantic_key text, execution_deadline_at timestamp(3),
          next_enqueue_at timestamp(3), timeout_quarantine_expires_at timestamp(3), error_message text);
        CREATE TABLE public._prisma_migrations (id text NOT NULL, migration_name text NOT NULL, checksum text NOT NULL,
          started_at timestamptz NOT NULL, finished_at timestamptz, rolled_back_at timestamptz,
          applied_steps_count integer NOT NULL DEFAULT 0, logs text);
        INSERT INTO public.webhook_events(id,status,created_at)
          SELECT n::text,'RECEIVED',clock_timestamp() FROM generate_series(1,1000) n;`);
      await reader.query(
        'CREATE INDEX CONCURRENTLY webhook_events_semantic_order_idx ON public.webhook_events(semantic_key,created_at,id) WHERE semantic_key IS NOT NULL',
      );
      for (const entry of report().metadata.migrations.slice(0, 3)) {
        const row = entry.records[0];
        await reader.query(
          `INSERT INTO public._prisma_migrations
          (id,migration_name,checksum,started_at,finished_at,applied_steps_count,logs)
          VALUES($1,$2,$3,$4,$5,$6,NULL)`,
          [
            entry.name,
            entry.name,
            row.checksum,
            new Date(fixtureNow - 110_000).toISOString(),
            row.finished_at === null ? null : new Date(fixtureNow - 105_000).toISOString(),
            row.applied_steps_count,
          ],
        );
      }
      await writer.query('BEGIN');
      await writer.query("UPDATE public.webhook_events SET status='QUEUED' WHERE id='1'");
      const builderPid = (await builder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      pending = builder.query(multibotPreparationRecoveryDdl(indexes[1][0], 'create')).then(
        () => ({ unexpectedSuccess: true }),
        (error) => ({ code: error.code }),
      );
      const deadline = Date.now() + 5_000;
      let waiting = false;
      while (Date.now() < deadline) {
        const progress = await reader.query(
          'SELECT phase FROM pg_stat_progress_create_index WHERE pid=$1',
          [builderPid],
        );
        if (progress.rows.some((row) => row.phase === 'waiting for writers before build')) {
          waiting = true;
          break;
        }
        await delay(20);
      }
      assert.equal(
        waiting,
        true,
        'Actual concurrent build must create an invalid catalog entry while blocked by the writer',
      );
      await reader.query('SELECT pg_cancel_backend($1)', [builderPid]);
      assert.deepEqual(await pending, { code: '57014' });
      pending = undefined;
      await writer.query('ROLLBACK');
      const readDiagnostic = async () => {
        await reader.query('BEGIN READ ONLY');
        try {
          return (await reader.query(multibotPreparationDiagnosticsSql)).rows[0].json_build_object;
        } finally {
          await reader.query('ROLLBACK');
        }
      };
      const before = await readDiagnostic();
      const nativeReceipt = before.metadata.migrations[2].records[0];
      nativeContext.expectedReceiptIdentityHash = nativeReceipt.identity_hash;
      nativeContext.cancellationProof.receiptIdentityHash = nativeReceipt.identity_hash;
      assert.equal(before.indexes[1].valid, false);
      assert.equal(before.indexes[1].live, true);
      assert.deepEqual(planMultibotPreparationRecovery(before, nativeContext).actions, [
        { index: indexes[1][0], action: 'reindex' },
        { index: indexes[2][0], action: 'create' },
      ]);
      let resolves = 0;
      const result = await recoverMultibotPreparation(
        {
          now: Date.now,
          readDiagnostic,
          attestCancellation: async () => ({
            ...nativeContext.cancellationProof,
            cleanupVerifiedAt: new Date().toISOString(),
          }),
          assertAdmission: async () => {},
          repairIndex: async ({ sql }) => {
            await builder.query('SET max_parallel_maintenance_workers=0');
            await builder.query("SET maintenance_work_mem='32MB'");
            await builder.query(sql);
          },
          resolveMigration: async (name) => {
            resolves += 1;
            const root = resolve(import.meta.dirname, '../..');
            const output = await runMultibotSupervisorCommand(
              process.execPath,
              [
                resolve(root, 'node_modules/prisma/build/index.js'),
                'migrate',
                'resolve',
                '--applied',
                name,
                '--config',
                resolve(root, 'apps/api/prisma.config.ts'),
              ],
              {
                cwd: root,
                timeout: 15_000,
                env: { ...process.env, DATABASE_URL: localAddress.href },
              },
            );
            assert.ok(output.stdout.includes('marked as applied'));
            assert.equal(output.stdout.includes(localAddress.href), false);
          },
        },
        nativeContext,
        { apply: true },
      );
      assert.equal(result.applied, true);
      assert.equal(resolves, 1);
      const final = await readDiagnostic();
      assert.ok(
        final.indexes.every(
          (index) => index.valid && index.ready && index.live && index.definition_matches,
        ),
      );
      assert.equal(final.repair_artifacts.present, false);
      assert.equal(final.indexes[2].expected_predicate, indexes[2][2]);
      assert.equal(final.metadata.migrations[2].records.length, 2);
      assert.deepEqual(final.metadata.migrations[2].records.map((entry) => entry.state).sort(), [
        'APPLIED',
        'ROLLED_BACK',
      ]);
      assert.equal(
        final.metadata.migrations[2].records.find((entry) => entry.state === 'ROLLED_BACK')
          .identity_hash,
        nativeReceipt.identity_hash,
      );
    } finally {
      if (pending) {
        await admin.query(
          'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1',
          [database],
        );
        await pending;
      }
      await Promise.allSettled(clients.map((client) => client.end()));
      if (created) await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);
      await admin.end();
    }
  },
);
