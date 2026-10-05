import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import {
  MULTIBOT_PSQL_CLIENT_METADATA_SQL,
  writeOnlineClientCiCompose,
} from './multibot-online-client-ci-fixture.mjs';
import { verifyMultibotOnlineClientConfiguration } from './multibot-online-client.mjs';
import { multibotRecoveryPsqlArgs } from './multibot-preparation-recovery.mjs';

const root = resolve(import.meta.dirname, '../..');
const sha = 'a'.repeat(40);
const image = `maxim-api:${sha}`;
const smoke = resolve(root, 'infra/scripts/smoke-multibot-online-client-ci.sh');
const nativePostgresUrl = process.env.MAXIM_TEST_POSTGRES_URL?.trim();

test(
  'native psql CI metadata observes the actual recovery backend limits in a readonly transaction',
  { skip: !nativePostgresUrl, timeout: 15_000 },
  async () => {
    const address = new URL(nativePostgresUrl);
    assert(
      ['127.0.0.1', 'localhost', '[::1]'].includes(address.hostname) &&
        address.pathname.includes('race_test'),
      'Requires disposable local PostgreSQL race_test',
    );
    const tag = `maxim-online-${randomUUID()}`;
    const command = multibotRecoveryPsqlArgs(tag, {
      imageId: `sha256:${'a'.repeat(64)}`,
      networkName: 'infra_default',
      networkId: 'b'.repeat(64),
    });
    const { default: pg } = await import('pg');
    const client = new pg.Client({
      connectionString: nativePostgresUrl,
      application_name: tag,
      connectionTimeoutMillis: 5000,
      query_timeout: 5000,
      options: command.find((option) => option.startsWith('PGOPTIONS=')).slice('PGOPTIONS='.length),
    });
    try {
      await client.connect();
      assert.match(
        (await client.query('SELECT version() AS version')).rows[0].version,
        /^PostgreSQL /u,
      );
      await client.query('BEGIN READ ONLY');
      const result = (await client.query(MULTIBOT_PSQL_CLIENT_METADATA_SQL)).rows[0]
        .json_build_object;
      assert.deepEqual(result, {
        read_only: true,
        application_name: tag,
        database_matches: false,
        maintenance_bytes: 512 * 1024 ** 2,
        temp_limit_bytes: 6 * 1024 ** 3,
        parallel_maintenance_workers: 0,
        parallel_query_workers: 0,
        default_tablespace: '',
        temp_tablespaces: '',
      });
      await client.query('ROLLBACK');
    } finally {
      await client.end();
    }
  },
);

test('CI migration Compose uses its effective private overlay, isolated non-infra project and internal network', () => {
  const directory = mkdtempSync(join(tmpdir(), 'maxim-online-client-ci-'));
  try {
    const project = `multibot_ci_${'b'.repeat(32)}`;
    const args = writeOnlineClientCiCompose(directory, project, image, 'fixture-owner');
    const result = spawnSync('docker', ['compose', ...args, 'config', '--format', 'json'], {
      encoding: 'utf8',
      timeout: 10_000,
    });
    assert.equal(result.status, 0, result.stderr);
    const config = JSON.parse(result.stdout);
    const identity = verifyMultibotOnlineClientConfiguration(config, args, sha);
    assert.equal(identity.project, project);
    assert.equal(identity.networkName, `${project}_default`);
    assert.equal(config.networks.default.internal, true);
    assert.equal(
      config.services.postgres.environment.POSTGRES_PASSWORD,
      new URL(identity.databaseUrl).password,
    );
    assert.notEqual(new URL(identity.databaseUrl).password, 'invalid');
    assert.deepEqual(Object.keys(config.services).sort(), ['api-ingress', 'postgres']);
    assert.equal(config.services.postgres.ports, undefined);
    assert.equal(statSync(resolve(directory, 'ci.env')).mode & 0o777, 0o600);
    assert.equal(statSync(resolve(directory, 'compose.json')).mode & 0o777, 0o600);
    assert.equal(statSync(resolve(directory, 'overlay.json')).mode & 0o777, 0o600);
    const wrongContext = [
      '--env-file',
      resolve(directory, 'ci.env'),
      '-p',
      'infra',
      '-f',
      resolve(directory, 'compose.json'),
      '-f',
      resolve(directory, 'overlay.json'),
    ];
    assert.throws(
      () => verifyMultibotOnlineClientConfiguration(config, wrongContext, sha),
      /CONFIGURATION_INVALID/u,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('CI migration smoke rejects non-CI, wrong image SHA and remote Docker selectors before Docker', () => {
  const directory = mkdtempSync(join(tmpdir(), 'maxim-online-client-scope-'));
  try {
    const binary = resolve(directory, 'docker');
    writeFileSync(binary, '#!/usr/bin/env bash\necho UNEXPECTED_DOCKER_ACCESS >&2\nexit 99\n');
    chmodSync(binary, 0o755);
    for (const scope of [
      { GITHUB_ACTIONS: 'false', GITHUB_SHA: sha, DOCKER_HOST: '', DOCKER_CONTEXT: '' },
      { GITHUB_ACTIONS: 'true', GITHUB_SHA: 'b'.repeat(40), DOCKER_HOST: '', DOCKER_CONTEXT: '' },
      {
        GITHUB_ACTIONS: 'true',
        GITHUB_SHA: sha,
        DOCKER_HOST: 'tcp://remote.example:2375',
        DOCKER_CONTEXT: '',
      },
      { GITHUB_ACTIONS: 'true', GITHUB_SHA: sha, DOCKER_HOST: '', DOCKER_CONTEXT: 'remote' },
    ]) {
      const result = spawnSync('bash', [smoke, '--bounded', image], {
        encoding: 'utf8',
        timeout: 5000,
        env: { ...process.env, ...scope, PATH: `${directory}:${process.env.PATH}` },
      });
      assert.equal(result.status, 2);
      assert.doesNotMatch(result.stderr, /UNEXPECTED_DOCKER_ACCESS/u);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('API image CI runs bounded migration client verification before image publication with Node24', () => {
  const workflow = readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8');
  const dockerLane = workflow.slice(workflow.indexOf('  docker:'));
  assert.match(dockerLane, /timeout-minutes: 25/u);
  assert.match(
    dockerLane,
    /actions\/setup-node@[a-f0-9]{40}[^]*if: matrix\.component == 'api'[^]*node-version-file: \.nvmrc/u,
  );
  const smokePosition = dockerLane.indexOf(
    'run: bash infra/scripts/smoke-multibot-online-client-ci.sh "$IMAGE_REF"',
  );
  assert(smokePosition > dockerLane.indexOf('docker buildx build --load'));
  assert(smokePosition < dockerLane.indexOf('name: Package immutable production image'));
  assert.match(readFileSync(smoke, 'utf8'), /timeout --kill-after=8s 180s/u);
});

test('CI readiness rejects Unix-only bootstrap, missing SQL proof and failed authenticated probes', () => {
  const source = readFileSync(smoke, 'utf8');
  const start = source.indexOf('ready=0\n');
  const finish = source.indexOf('[[ "$ready" -eq 1 ]] || exit 1', start);
  assert(start >= 0 && finish > start);
  const readiness = source.slice(start, finish + '[[ "$ready" -eq 1 ]] || exit 1'.length);
  const directory = mkdtempSync(join(tmpdir(), 'maxim-online-client-readiness-'));
  try {
    const binary = resolve(directory, 'docker');
    const counter = resolve(directory, 'attempts');
    const argumentsPath = resolve(directory, 'arguments');
    writeFileSync(
      binary,
      `#!/usr/bin/env bash
set -euo pipefail
attempt=0
[[ ! -f "$MAXIM_CI_READINESS_COUNTER" ]] || read -r attempt < "$MAXIM_CI_READINESS_COUNTER"
attempt=$((attempt + 1))
printf '%s\\n' "$attempt" > "$MAXIM_CI_READINESS_COUNTER"
printf '%s\\n' "$@" > "$MAXIM_CI_READINESS_ARGUMENTS"
if [[ "$MAXIM_CI_READINESS_MODE" == failed ]]; then
  printf '1\\n'
  exit 1
fi
if [[ "$attempt" -eq 1 ]]; then
  # The bootstrap server accepts Unix readiness while TCP is still unavailable.
  if [[ "$MAXIM_CI_READINESS_MODE" == bootstrap && "$*" == *'-h postgres'* ]]; then
    exit 1
  fi
  # Exit zero without SQL output does not prove authenticated target readiness.
  exit 0
fi
printf '1\\n'
`,
    );
    chmodSync(binary, 0o755);
    const sleep = resolve(directory, 'sleep');
    writeFileSync(sleep, '#!/usr/bin/env bash\nexit 0\n');
    chmodSync(sleep, 0o755);
    for (const mode of ['bootstrap', 'empty', 'failed']) {
      rmSync(counter, { force: true });
      const result = spawnSync(
        'bash',
        [
          '-c',
          `set -euo pipefail\ncompose=(--env-file /private/ci.env -p multibot_ci_fixture)\n${readiness}`,
        ],
        {
          encoding: 'utf8',
          timeout: 5000,
          env: {
            ...process.env,
            PATH: `${directory}:${process.env.PATH}`,
            MAXIM_CI_READINESS_COUNTER: counter,
            MAXIM_CI_READINESS_ARGUMENTS: argumentsPath,
            MAXIM_CI_READINESS_MODE: mode,
          },
        },
      );
      assert.equal(result.status, mode === 'failed' ? 1 : 0);
      assert.equal(Number(readFileSync(counter, 'utf8').trim()), mode === 'failed' ? 30 : 2);
      const argumentsSeen = readFileSync(argumentsPath, 'utf8');
      assert.match(argumentsSeen, /PGPASSWORD="\$POSTGRES_PASSWORD" psql -h postgres/u);
      assert.match(argumentsSeen, /-X -v ON_ERROR_STOP=1 -U maxim -d maxim -Atq -c "SELECT 1"/u);
      assert.doesNotMatch(argumentsSeen, /pg_isready/u);
      assert.equal(result.stdout, '');
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
