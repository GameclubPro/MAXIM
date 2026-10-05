import assert from 'node:assert/strict';
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
import {
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
