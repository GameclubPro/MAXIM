import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import {
  recoverMultibotIndexes,
  superviseMultibotIndexRepair,
  multibotRecoverySqlArgs,
  multibotRecoveryResolveArgs,
  summarizeMultibotRecoveryCatalog,
} from './multibot-index-migration-recovery.mjs';
import { resolveMultibotIndexReceipt } from './multibot-index-resolve.mjs';
import {
  MIGRATION,
  ADDITIVE_MIGRATION,
  SEMANTIC_ORDER_MIGRATION,
  migrationChecksums,
  indexes,
  recoveryIndexSql,
} from './multibot-index-recovery-schema.mjs';
import { withMultibotRecoveryCatalog } from './multibot-index-recovery.test-support.mjs';
import { MULTIBOT_PREPARE_MINIMUM_FREE_BYTES } from './multibot-prepare-capacity.mjs';

const appName = 'maxim-online-12345678-1234-4234-8234-123456789abc';
const compose = ['--env-file', '.env', '-p', 'infra', '-f', 'infra/docker-compose.yml'];
const names = Object.keys(indexes);
const checksumOptions = {
  checksum: migrationChecksums[MIGRATION],
  additiveChecksum: migrationChecksums[ADDITIVE_MIGRATION],
  semanticOrderChecksum: migrationChecksums[SEMANTIC_ORDER_MIGRATION],
};

async function fixture(run) {
  return withMultibotRecoveryCatalog(async (db, read) => {
    const calls = [];
    const operations = {
      ...checksumOptions,
      read,
      assertHealthy: async () => {
        calls.push('health');
      },
      repair: async (name, action) => {
        calls.push(`${action}:${name}`);
        await db.exec(recoveryIndexSql(name, action).replace(' CONCURRENTLY', ''));
      },
      resolve: async () => {
        calls.push('resolve');
        await db.query(
          'UPDATE _prisma_migrations SET finished_at=CURRENT_TIMESTAMP WHERE migration_name=$1',
          [MIGRATION],
        );
      },
    };
    await run({ db, calls, read, operations });
  });
}

test('preview is read-only; apply serializes both repairs, verifies catalog, then resolves once', async () => {
  await fixture(async ({ calls, operations }) => {
    const before = await recoverMultibotIndexes(operations, false);
    assert.equal(before.applied, false);
    assert.deepEqual(calls, []);
    assert.deepEqual(
      before.actions,
      names.map((name) => ({ name, action: 'create' })),
    );
    const result = await recoverMultibotIndexes(operations, true);
    assert.equal(result.applied, true);
    assert.deepEqual(calls, [
      'health',
      `create:${names[0]}`,
      'health',
      `create:${names[1]}`,
      'health',
      'resolve',
    ]);
    calls.length = 0;
    assert.equal((await recoverMultibotIndexes(operations, true)).recordState, 'applied');
    assert.deepEqual(calls, [], 'A known applied receipt must not run another repair or resolve');
  });
});

test('repair failure, changed receipt, stale index or unhealthy runtime never resolves', async () => {
  await fixture(async ({ db, operations, calls }) => {
    await assert.rejects(
      recoverMultibotIndexes(
        {
          ...operations,
          assertHealthy: async () => {
            throw new Error('unhealthy');
          },
        },
        true,
      ),
      /unhealthy/u,
    );
    await assert.rejects(
      recoverMultibotIndexes(
        {
          ...operations,
          repair: async () => {
            throw new Error('repair failed');
          },
        },
        true,
      ),
      /repair failed/u,
    );
    await assert.rejects(
      recoverMultibotIndexes({ ...operations, repair: async () => {} }, true),
      /INDEX_NOT_READY/u,
    );
    const repair = operations.repair;
    await assert.rejects(
      recoverMultibotIndexes(
        {
          ...operations,
          repair: async (...args) => {
            await repair(...args);
            await db.query('UPDATE _prisma_migrations SET id=$1 WHERE migration_name=$2', [
              'replaced-private-target',
              MIGRATION,
            ]);
          },
        },
        true,
      ),
      /RECEIPT_CHANGED/u,
    );
    assert.equal(calls.includes('resolve'), false);
  });
});

test('unknown resolver result requires a new preview and never retries within the attempt', async () => {
  await fixture(async ({ operations, calls, db }) => {
    await assert.rejects(
      recoverMultibotIndexes(
        {
          ...operations,
          resolve: async () => {
            calls.push('resolve');
            await db.query(
              'UPDATE _prisma_migrations SET finished_at=CURRENT_TIMESTAMP WHERE migration_name=$1',
              [MIGRATION],
            );
            throw new Error('unknown after commit');
          },
        },
        true,
      ),
      /unknown after commit/u,
    );
    assert.equal(calls.filter((value) => value === 'resolve').length, 1);
    assert.equal((await recoverMultibotIndexes(operations, false)).recordState, 'applied');
  });
});

function supervisedFixture(mode = 'success') {
  const child = new EventEmitter();
  child.stdin = new EventEmitter();
  child.stdin.end = (value) => {
    calls.push(['stdin', value]);
  };
  const signals = new EventEmitter();
  const calls = [];
  let ticks = 0;
  let wallTime = 0;
  const capacity = {
    devices: [{ availableBytes: MULTIBOT_PREPARE_MINIMUM_FREE_BYTES + 1024 }],
    monitorPaths: {},
  };
  const dependencies = {
    signals,
    now: () => wallTime,
    checkCapacity: async () => {
      calls.push(['capacity']);
      return capacity;
    },
    readFilesystems: async () => {
      calls.push(['sample']);
      if (mode === 'lost_sample') throw new Error('MULTIBOT_PREPARE_MONITOR_UNAVAILABLE');
      return [
        { availableBytes: mode === 'low_disk' ? 0 : MULTIBOT_PREPARE_MINIMUM_FREE_BYTES + 1024 },
      ];
    },
    start: (...args) => {
      calls.push(['start', ...args]);
      return child;
    },
    stop: async (...args) => {
      calls.push(['stop', ...args]);
      if (mode === 'cleanup_failed') throw new Error('MULTIBOT_PREPARE_CLEANUP_UNCONFIRMED');
    },
    waitForTick: async () => {
      ticks++;
      if (mode === 'interrupted') signals.emit('SIGTERM');
      if (mode === 'deadline') wallTime = 1_840_000;
      if (ticks === 2 || mode === 'failed' || mode === 'cleanup_failed')
        child.emit('exit', mode === 'failed' || mode === 'cleanup_failed' ? 1 : 0, null);
    },
  };
  return { dependencies, calls, signals };
}

test('supervision rejects injected SQL/arguments before any probe or launcher', async () => {
  const { dependencies, calls } = supervisedFixture();
  for (const [args, query] of [
    [multibotRecoverySqlArgs(compose, appName, true), 'SELECT 1'],
    [['compose', ...compose, 'exec', 'postgres'], recoveryIndexSql(names[0], 'create')],
  ])
    await assert.rejects(
      superviseMultibotIndexRepair(compose, appName, args, query, dependencies),
      /OPERATION_INVALID/u,
    );
  assert.deepEqual(calls, []);
});

test('successful fixed operation has fresh reserve/device samples and closes its input', async () => {
  const { dependencies, calls, signals } = supervisedFixture();
  const query = recoveryIndexSql(names[0], 'create');
  await superviseMultibotIndexRepair(
    compose,
    appName,
    multibotRecoverySqlArgs(compose, appName, true),
    query,
    dependencies,
  );
  assert.equal(calls.filter(([name]) => name === 'sample').length, 2);
  assert.equal(calls.filter(([name]) => name === 'start').length, 1);
  assert.deepEqual(
    calls.find(([name]) => name === 'stdin'),
    ['stdin', query],
  );
  assert.equal(
    calls.some(([name]) => name === 'stop'),
    false,
  );
  assert.equal(signals.listenerCount('SIGTERM'), 0);
});

for (const [mode, expected] of [
  ['low_disk', /RESERVE_EXHAUSTED/u],
  ['lost_sample', /MONITOR_UNAVAILABLE/u],
  ['interrupted', /INTERRUPTED/u],
  ['deadline', /DEADLINE_EXHAUSTED/u],
  ['failed', /INDEX_COMMAND_FAILED/u],
  ['cleanup_failed', /CLEANUP_UNCONFIRMED/u],
])
  test(`supervised ${mode} preserves failure and stops only the exact owned attempt`, async () => {
    const { dependencies, calls, signals } = supervisedFixture(mode);
    await assert.rejects(
      superviseMultibotIndexRepair(
        compose,
        appName,
        multibotRecoverySqlArgs(compose, appName, true),
        recoveryIndexSql(names[1], 'reindex'),
        dependencies,
      ),
      expected,
    );
    const stop = calls.find(([name]) => name === 'stop');
    assert.ok(stop);
    assert.equal(stop[3], appName);
    assert.equal(stop[4], appName);
    assert.equal(calls.filter(([name]) => name === 'start').length, 1);
    assert.equal(signals.listenerCount('SIGTERM'), 0);
  });

test('fixed command options preserve scope, native deadlines and readonly resolver mounts', () => {
  const args = multibotRecoverySqlArgs(compose, appName, true);
  assert.deepEqual(args.slice(1, 1 + compose.length), compose);
  const options = args.find((value) => value.startsWith('PGOPTIONS='));
  assert.match(options, /statement_timeout=1800s/u);
  assert.match(options, /lock_timeout=5s/u);
  assert.match(options, /max_parallel_maintenance_workers=0/u);
  assert.match(options, /temp_file_limit=10GB/u);
  const resolver = multibotRecoveryResolveArgs(compose, appName, '/reviewed source');
  assert.ok(
    resolver.includes(
      '/reviewed source/apps/api/prisma/migrations:/app/apps/api/prisma/migrations:ro',
    ),
  );
  assert.ok(resolver.includes(`MAXIM_MULTIBOT_PREPARE_APPLICATION_NAME=${appName}`));
  assert.equal(resolver.includes('--build'), false);
});

test('resolver tags URL credentials in memory and permits only the fixed applied receipt', () => {
  const env = {
    DATABASE_URL: 'postgresql://private-user:private-secret@localhost/maxim?schema=public',
    MAXIM_MULTIBOT_PREPARE_APPLICATION_NAME: appName,
  };
  let captured;
  resolveMultibotIndexReceipt(env, (binary, args, options) => {
    captured = { binary, args, options };
    return { status: 0, stdout: 'private output', stderr: '' };
  });
  assert.equal(
    new URL(captured.options.env.DATABASE_URL).searchParams.get('application_name'),
    appName,
  );
  assert.equal(new URL(env.DATABASE_URL).searchParams.has('application_name'), false);
  assert.equal(captured.args[captured.args.indexOf('--applied') + 1], MIGRATION);
  assert.equal(
    captured.args.some((value) => value.includes('private-secret')),
    false,
  );
  assert.throws(
    () => resolveMultibotIndexReceipt(env, () => ({ status: 1, stderr: 'private-secret' })),
    /RESOLVE_COMMAND_FAILED/u,
  );
});

test('preview output excludes receipt identity, raw logs, predicates, content and unknown families', async () => {
  await fixture(async ({ read }) => {
    const report = await read();
    report.metadata.records[0].failure = 'private-error';
    report.metadata.records[0].logs = 'private-secret';
    const summary = summarizeMultibotRecoveryCatalog(report);
    assert.equal(summary.failureFamily, 'unknown');
    assert.equal(summary.targetChecksumMatches, true);
    assert.equal(JSON.stringify(summary).includes('private-'), false);
    assert.equal(JSON.stringify(summary).includes('predicate'), false);
  });
});
