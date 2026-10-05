import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  rmdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import {
  createMultibotPrepareEnvironment,
  createMultibotMigrationPrefix,
  MULTIBOT_ONLINE_PREFIX_NAME,
  runMultibotOnlinePrepare,
} from '../../scripts/agent/multibot-online-prepare.mjs';

const root = resolve(import.meta.dirname, '../..');
const migrations = resolve(root, 'apps/api/prisma/migrations');
const prepareWorkspace = resolve(root, 'apps/api/.migration-prepare');
const prepareWorkspaceExisted = existsSync(prepareWorkspace);
const cutoffNames = [
  '20261005020000_add_multibot_order_fences',
  '20261005020200_preserve_semantic_execution_tombstones',
];
const fakeEnv = {
  DATABASE_URL: 'postgresql://fixture:fixture-secret@localhost/race_test_online_prepare',
  MAX_BOT_TOKEN: 'fixture-only-token',
};
const applicationTag = 'maxim-online-aceb2e88-5369-4e3e-bdf5-1b232c3a16af';
const nativePostgresUrl = process.env.MAXIM_TEST_POSTGRES_URL?.trim();

function snapshotTree(directory) {
  const files = new Map();
  function visit(current, relative = '') {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) visit(resolve(current, entry.name), path);
      else if (entry.isFile()) files.set(path, readFileSync(resolve(current, entry.name)));
    }
  }
  visit(directory);
  return files;
}

function assertSourceUnchanged(snapshot) {
  assert.deepEqual(snapshotTree(migrations), snapshot, 'Immutable migration source changed');
}

function assertPrefix(configPath) {
  const tempRoot = dirname(configPath);
  const copiedMigrations = resolve(tempRoot, 'migrations');
  for (const name of cutoffNames) {
    assert.equal(existsSync(resolve(copiedMigrations, name)), false, `Exposed cutoff ${name}`);
  }
  const config = readFileSync(configPath, 'utf8');
  assert.match(config, /import \{ defineConfig, env \} from 'prisma\/config'/u);
  assert.ok(
    config.includes(`schema: ${JSON.stringify(resolve(root, 'apps/api/prisma/schema.prisma'))}`),
  );
  assert.ok(config.includes(`migrations: { path: ${JSON.stringify(copiedMigrations)} }`));
  assert.match(config, /datasource: \{ url: env\('DATABASE_URL'\) \}/u);
  for (const value of Object.values(fakeEnv)) {
    assert.equal(config.includes(value), false, 'Generated config embedded a credential');
  }
  assert.equal(statSync(tempRoot).mode & 0o777, 0o700);
  assert.equal(statSync(configPath).mode & 0o777, 0o600);
  return tempRoot;
}

test.after(() => {
  if (
    !prepareWorkspaceExisted &&
    existsSync(prepareWorkspace) &&
    readdirSync(prepareWorkspace).length === 0
  )
    rmdirSync(prepareWorkspace);
});

test('online preparation copies the full immutable prefix and excludes the effects cutoff and FK cutover', () => {
  assert.equal(MULTIBOT_ONLINE_PREFIX_NAME, '20261005016100_index_multibot_retention_cursor');
  const original = snapshotTree(migrations);
  const prefix = createMultibotMigrationPrefix(root);
  try {
    const expectedNames = readdirSync(migrations, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^\d{14}_[a-z0-9_]+$/u.test(entry.name))
      .map((entry) => entry.name)
      .filter((name) => name <= MULTIBOT_ONLINE_PREFIX_NAME)
      .sort();
    assert.deepEqual(prefix.migrationNames, expectedNames);
    assert.equal(prefix.migrationNames.at(-1), MULTIBOT_ONLINE_PREFIX_NAME);
    assert.ok(prefix.migrationNames.includes('20261005015900_prepare_multibot_webhook_columns'));
    assert.ok(prefix.migrationNames.includes('20261005016000_add_multibot_semantic_order_index'));
    const copied = snapshotTree(resolve(prefix.tempRoot, 'migrations'));
    const expected = new Map(
      [...original].filter(
        ([path]) => path === 'migration_lock.toml' || expectedNames.includes(path.split('/')[0]),
      ),
    );
    assert.deepEqual(copied, expected, 'Copied migration bytes or support files differ');
    assert.equal(assertPrefix(prefix.configPath), prefix.tempRoot);
    assertSourceUnchanged(original);
  } finally {
    rmSync(prefix.tempRoot, { recursive: true, force: true });
  }
});

test('successful preparation uses one structured bounded Prisma deploy and removes its temporary copy', () => {
  const original = snapshotTree(migrations);
  const calls = [];
  let tempRoot;
  const result = runMultibotOnlinePrepare({
    root,
    env: fakeEnv,
    runPrisma: (command, args, options) => {
      calls.push({ command, args, options });
      assert.equal(command, process.execPath);
      assert.deepEqual(args.slice(0, 4), [
        resolve(root, 'node_modules/prisma/build/index.js'),
        'migrate',
        'deploy',
        '--config',
      ]);
      assert.equal(args.length, 5);
      assert.deepEqual(options, { cwd: root, env: fakeEnv, stdio: 'inherit', timeout: 5_700_000 });
      assert.equal(options.env, fakeEnv);
      tempRoot = assertPrefix(args[4]);
      return { status: 0 };
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(result.migrationNames.at(-1), MULTIBOT_ONLINE_PREFIX_NAME);
  assert.equal(existsSync(tempRoot), false);
  assertSourceUnchanged(original);
});

test('supervised preparation preserves URL settings and credentials and clones the immutable caller environment', () => {
  for (const databaseUrl of [
    'postgresql://fixture:p%40ss%2Bword@localhost:5433/race_test?schema=tenant%20schema&sslmode=require&connect_timeout=9&options=-c%20timezone%3DUTC',
    'postgres://fixture:fixture-secret@localhost/race_test',
    'postgresql://fixture:fixture-secret@localhost/race_test?',
    `postgresql://fixture:fixture-secret@localhost/race_test?schema=public&application_name=${applicationTag}`,
  ]) {
    const env = Object.freeze({
      ...fakeEnv,
      DATABASE_URL: databaseUrl,
      MAXIM_MULTIBOT_PREPARE_APPLICATION_NAME: applicationTag,
      PGOPTIONS: '-c timezone=UTC',
    });
    const before = { ...env };
    const prepared = createMultibotPrepareEnvironment(env);
    assert.notEqual(prepared, env);
    assert.deepEqual(env, before);
    assert.equal(prepared.MAX_BOT_TOKEN, env.MAX_BOT_TOKEN);
    assert.equal(prepared.PGOPTIONS, env.PGOPTIONS);
    const originalAddress = new URL(databaseUrl);
    const preparedAddress = new URL(prepared.DATABASE_URL);
    assert.equal(preparedAddress.searchParams.get('application_name'), applicationTag);
    assert.equal(preparedAddress.searchParams.getAll('application_name').length, 1);
    for (const part of ['protocol', 'username', 'password', 'hostname', 'port', 'pathname'])
      assert.equal(preparedAddress[part], originalAddress[part]);
    originalAddress.searchParams.delete('application_name');
    preparedAddress.searchParams.delete('application_name');
    assert.deepEqual([...preparedAddress.searchParams], [...originalAddress.searchParams]);
    assert.ok(prepared.DATABASE_URL.startsWith(databaseUrl));
    let calls = 0;
    runMultibotOnlinePrepare({
      root,
      env,
      runPrisma: (_command, args, options) => {
        calls += 1;
        assert.deepEqual(options.env, prepared);
        assert.notEqual(options.env, env);
        assertPrefix(args[4]);
        assert.equal(
          args.some((arg) => arg.includes('fixture-secret')),
          false,
        );
        return { status: 0 };
      },
    });
    assert.equal(calls, 1);
    assert.deepEqual(env, before);
  }
});

test('invalid session tags or conflicting database settings refuse preparation without files, commands or secret errors', () => {
  const fixture = mkdtempSync(resolve(tmpdir(), 'maxim-online-invalid-tag-'));
  const invalidTags = [
    '',
    ' ',
    'maxim-online-',
    applicationTag.toUpperCase(),
    applicationTag.replace('-4e3e-', '-1e3e-'),
    applicationTag.replace('-bdf5-', '-7df5-'),
    `${applicationTag}\n`,
    5,
  ];
  const invalidAddresses = [
    'https://fixture:fixture-secret@localhost/race_test',
    'not-a-url-fixture-secret',
    'postgresql://fixture:fixture-secret@localhost/',
    'postgresql://fixture:fixture-secret@localhost/race_test#fixture-secret',
    'postgresql://fixture:fixture-secret@localhost/race_test ',
    'postgresql://fixture:fixture-secret@local\nhost/race_test',
    'postgresql://fixture:fixture-secret@local\thost/race_test',
    'postgresql://fixture:fixture-secret@localhost/race_test\0',
    'postgresql://fixture:fixture-secret@localhost/race_test?application_name=other',
    `postgresql://fixture:fixture-secret@localhost/race_test?application_name=${applicationTag}&application_name=${applicationTag}`,
    'postgresql://fixture:fixture-secret@localhost/race_test?options=-c%20application_name%3Dother',
  ];
  let calls = 0;
  try {
    for (const [DATABASE_URL, tag] of [
      ...invalidTags.map((tag) => [fakeEnv.DATABASE_URL, tag]),
      ...invalidAddresses.map((address) => [address, applicationTag]),
    ]) {
      const env = Object.freeze({
        ...fakeEnv,
        DATABASE_URL,
        MAXIM_MULTIBOT_PREPARE_APPLICATION_NAME: tag,
      });
      assert.throws(
        () =>
          runMultibotOnlinePrepare({
            root: fixture,
            env,
            runPrisma: () => {
              calls += 1;
              return { status: 0 };
            },
          }),
        (error) => {
          assert.match(
            error.message,
            /^MULTIBOT_PREPARE_(APPLICATION_NAME_(?:INVALID|CONFLICT)|TAGGED_DATABASE_URL_INVALID)$/u,
          );
          assert.equal(error.message.includes('fixture-secret'), false);
          assert.equal(error.message.includes(DATABASE_URL), false);
          return true;
        },
      );
      assert.deepEqual(readdirSync(fixture), []);
    }
    assert.equal(calls, 0);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('CLI failure logs a fixed code without tagged connection URLs, credentials or tokens', () => {
  const result = spawnSync(
    process.execPath,
    [resolve(root, 'scripts/agent/multibot-online-prepare.mjs')],
    {
      cwd: root,
      env: {
        ...process.env,
        ...fakeEnv,
        MAXIM_MULTIBOT_PREPARE_APPLICATION_NAME: 'bad-fixture-tag',
      },
      encoding: 'utf8',
      timeout: 5_000,
    },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /MULTIBOT_PREPARE_APPLICATION_NAME_INVALID/u);
  for (const secret of Object.values(fakeEnv))
    assert.equal(`${result.stdout}${result.stderr}`.includes(secret), false);
});

for (const [name, result] of [
  ['nonzero exit', { status: 1 }],
  ['spawn error', { status: 0, error: new Error('fixture-spawn-error') }],
  ['signal interruption', { status: 0, signal: 'SIGTERM' }],
  ['missing exit status', {}],
]) {
  test(`preparation preserves failed receipts and immutable SQL after ${name}, without repair or retry`, () => {
    const original = snapshotTree(migrations);
    const receiptRoot = mkdtempSync(resolve(tmpdir(), 'maxim-online-receipt-'));
    const receiptPath = resolve(receiptRoot, 'failed-receipt.json');
    const failedReceipt = JSON.stringify({
      migration_name: '20261005016000_add_multibot_semantic_order_index',
      finished_at: null,
      rolled_back_at: null,
      logs: 'fixture interrupted concurrent build',
    });
    let tempRoot;
    const calls = [];
    try {
      assert.throws(
        () =>
          runMultibotOnlinePrepare({
            root,
            env: fakeEnv,
            runPrisma: (command, args) => {
              calls.push({ command, args });
              tempRoot = assertPrefix(args[4]);
              writeFileSync(receiptPath, failedReceipt);
              return result;
            },
          }),
        /MULTIBOT_PREPARE_PRISMA_DEPLOY_FAILED/u,
      );
      assert.equal(calls.length, 1, 'Failed migration was automatically retried or repaired');
      assert.deepEqual(calls[0].args.slice(1, 4), ['migrate', 'deploy', '--config']);
      assert.equal(readFileSync(receiptPath, 'utf8'), failedReceipt, 'Failed receipt was changed');
      assert.equal(existsSync(tempRoot), false);
      assertSourceUnchanged(original);
    } finally {
      rmSync(receiptRoot, { recursive: true, force: true });
    }
  });
}

test('a thrown runner error still cleans only the temporary prefix', () => {
  const original = snapshotTree(migrations);
  let tempRoot;
  let calls = 0;
  assert.throws(
    () =>
      runMultibotOnlinePrepare({
        root,
        env: fakeEnv,
        runPrisma: (_command, args) => {
          calls += 1;
          tempRoot = assertPrefix(args[4]);
          throw new Error('fixture-runner-error');
        },
      }),
    /fixture-runner-error/u,
  );
  assert.equal(calls, 1);
  assert.equal(existsSync(tempRoot), false);
  assertSourceUnchanged(original);
});

test('missing or blank database configuration refuses preparation before any filesystem mutation', () => {
  const fixture = mkdtempSync(resolve(tmpdir(), 'maxim-online-no-env-'));
  let calls = 0;
  try {
    for (const env of [{}, { DATABASE_URL: '' }, { DATABASE_URL: '   ' }]) {
      assert.throws(
        () =>
          runMultibotOnlinePrepare({
            root: fixture,
            env,
            runPrisma: () => {
              calls += 1;
              return { status: 0 };
            },
          }),
        /MULTIBOT_PREPARE_DATABASE_URL_REQUIRED/u,
      );
      assert.deepEqual(readdirSync(fixture), []);
    }
    assert.equal(calls, 0);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('an incomplete reviewed prefix refuses preparation before creating a temporary workspace', () => {
  const fixture = mkdtempSync(resolve(tmpdir(), 'maxim-online-incomplete-'));
  try {
    const fixtureMigrations = resolve(fixture, 'apps/api/prisma/migrations');
    mkdirSync(resolve(fixtureMigrations, MULTIBOT_ONLINE_PREFIX_NAME), { recursive: true });
    writeFileSync(
      resolve(fixtureMigrations, MULTIBOT_ONLINE_PREFIX_NAME, 'migration.sql'),
      '-- fixture',
    );
    writeFileSync(resolve(fixtureMigrations, 'migration_lock.toml'), 'provider = "postgresql"');
    const original = snapshotTree(fixture);
    assert.throws(
      () => createMultibotMigrationPrefix(fixture),
      /MULTIBOT_PREPARE_PREFIX_INCOMPLETE/u,
    );
    assert.equal(existsSync(resolve(fixture, 'apps/api/.migration-prepare')), false);
    assert.deepEqual(snapshotTree(fixture), original);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test(
  'native Prisma migration engine retains the exact supervised tag and only its blocked session is canceled',
  { skip: !nativePostgresUrl, timeout: 30_000 },
  async () => {
    const address = new URL(nativePostgresUrl);
    assert.ok(
      ['127.0.0.1', 'localhost', '[::1]'].includes(address.hostname) &&
        address.pathname.includes('race_test'),
      'Requires the disposable local PostgreSQL race_test database',
    );
    const { default: pg } = await import('pg');
    const client = new pg.Client({
      connectionString: nativePostgresUrl,
      connectionTimeoutMillis: 5_000,
      query_timeout: 5_000,
      options: '-c statement_timeout=5000 -c lock_timeout=3000 -c timezone=UTC',
      application_name: 'maxim-online-fixture-observer',
    });
    const tag = `maxim-online-${randomUUID()}`;
    let connected = false;
    let locked = false;
    let child;
    let childDone;
    let childResult;
    let output = '';
    try {
      await client.connect();
      connected = true;
      const identity = await client.query('SELECT version() AS version, pg_backend_pid() AS pid');
      assert.match(identity.rows[0].version, /^PostgreSQL /u);
      assert.doesNotMatch(identity.rows[0].version, /pglite|wasm/iu);
      // FLAG: This disposable database fixture holds Prisma's own advisory lock, so
      // observation/cancellation happens before the migration engine can perform DDL.
      await client.query('SELECT pg_advisory_lock(72707369)');
      locked = true;
      child = spawn(
        process.execPath,
        [resolve(root, 'scripts/agent/multibot-online-prepare.mjs')],
        {
          cwd: root,
          detached: true,
          env: {
            ...process.env,
            ...fakeEnv,
            DATABASE_URL: nativePostgresUrl,
            MAXIM_MULTIBOT_PREPARE_APPLICATION_NAME: tag,
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      for (const stream of [child.stdout, child.stderr])
        stream.on('data', (chunk) => {
          output = (output + chunk).slice(-16_384);
        });
      childDone = new Promise((done) => {
        child.once('error', () => {
          childResult = { code: 1, error: true };
          done(childResult);
        });
        child.once('close', (code, signal) => {
          childResult = { code, signal };
          done(childResult);
        });
      });
      const deadline = Date.now() + 8_000;
      let engine;
      while (Date.now() < deadline && !childResult) {
        const sessions = await client.query(
          `SELECT pid, application_name FROM pg_stat_activity
           WHERE datname = current_database() AND pid <> pg_backend_pid()
             AND wait_event = 'advisory' AND query LIKE '%pg_advisory_lock(72707369)%'
           LIMIT 10`,
        );
        if (sessions.rows.length) {
          assert.equal(sessions.rows.length, 1, 'Expected only the owned migration engine waiter');
          engine = sessions.rows[0];
          assert.equal(engine.application_name, tag, 'Prisma must preserve the exact session tag');
          break;
        }
        await delay(50);
      }
      assert.ok(
        engine,
        'Prisma must expose its tagged advisory-lock waiter before its own timeout',
      );
      const canceled = await client.query(
        `SELECT pg_cancel_backend(pid) AS canceled FROM pg_stat_activity
         WHERE datname = current_database() AND application_name = $1 AND pid = $2`,
        [tag, engine.pid],
      );
      assert.deepEqual(canceled.rows, [{ canceled: true }]);
      let finishTimeout;
      let result;
      try {
        result = await Promise.race([
          childDone,
          new Promise((done) => {
            finishTimeout = setTimeout(() => done({ timeout: true }), 5_000);
          }),
        ]);
      } finally {
        clearTimeout(finishTimeout);
      }
      assert.equal(result.timeout, undefined, 'Canceled migration engine must stop promptly');
      assert.equal(result.code, 1);
      assert.match(output, /MULTIBOT_PREPARE_PRISMA_DEPLOY_FAILED/u);
      assert.equal(output.includes(nativePostgresUrl), false);
      assert.equal(output.includes(decodeURIComponent(address.password)), false);
      const remaining = await client.query(
        `SELECT pid FROM pg_stat_activity
         WHERE datname = current_database() AND application_name = $1`,
        [tag],
      );
      assert.deepEqual(remaining.rows, []);
      const observer = await client.query('SELECT pg_backend_pid() AS pid');
      assert.equal(observer.rows[0].pid, identity.rows[0].pid);
    } finally {
      if (child && !childResult) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch (error) {
          assert.equal(error.code, 'ESRCH', 'Only an already-exited owned group may be absent');
        }
        await childDone;
      }
      try {
        if (connected && locked) await client.query('SELECT pg_advisory_unlock(72707369)');
      } finally {
        await client.end();
      }
    }
  },
);
