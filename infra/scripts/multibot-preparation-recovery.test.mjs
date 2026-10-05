import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseMultibotRecoveryArgs,
  verifyMultibotBaselineContainers,
  multibotRecoveryPsqlArgs,
  verifyMultibotRecoveryClient,
  multibotRecoveryResolverArgs,
  verifyMultibotRecoveryDatabaseUrl,
  awaitMultibotRecoveryAdmission,
  assertMultibotRecoveryMemory,
  verifyMultibotRecoveryOriginalContainerAbsence,
} from './multibot-preparation-recovery.mjs';
import { PRODUCTION_API_SERVICES } from './release-rollback-plan.mjs';

const tag = 'maxim-online-61bfd8a3-9d75-4ec2-9b1c-89f325387e53';

test('memory admission rejects exhausted, missing and invalid evidence at each fresh check', () => {
  assertMultibotRecoveryMemory({ read: () => 'MemAvailable: 2097152 kB\n' });
  for (const value of [
    'MemAvailable: 2097151 kB\n',
    'MemFree: 2097152 kB\n',
    'MemAvailable: 999999999999999999999 kB\n',
  ])
    assert.throws(
      () => assertMultibotRecoveryMemory({ read: () => value }),
      /MEMORY_HEADROOM_INSUFFICIENT/u,
    );
});
const args = [
  '--cancelled-source',
  'a'.repeat(40),
  '--baseline-source',
  'b'.repeat(40),
  '--attempt-name',
  tag,
  '--attempt-start',
  '2026-10-05T12:28:00.000Z',
  '--attempt-abort',
  '2026-10-05T13:11:00.000Z',
];
const image = `sha256:${'c'.repeat(64)}`;
const networkId = 'f'.repeat(64);
const containers = () =>
  PRODUCTION_API_SERVICES.map((service) => ({
    Image: image,
    Name: `/infra-${service}-1`,
    State: { Status: 'running', Running: true, Paused: false, Restarting: false, Dead: false },
    Config: {
      Labels: { 'com.docker.compose.project': 'infra', 'com.docker.compose.service': service },
      Env: [
        `APP_SERVICE_NAME=${service}`,
        `APP_ROLE=${service.startsWith('api-moderation') || service === 'api-media-analysis' ? 'moderation' : service.slice(4)}`,
      ],
    },
  }));

test('apply requires exact reviewed hashes and rejects arbitrary SQL, paths, selectors and identities', () => {
  assert.equal(parseMultibotRecoveryArgs(args).apply, false);
  assert.equal(
    parseMultibotRecoveryArgs([
      ...args,
      '--receipt-sha',
      'd'.repeat(64),
      '--journal-sha',
      'e'.repeat(64),
      '--apply',
    ]).apply,
    true,
  );
  for (const suffix of [
    ['--apply'],
    ['--sql', 'SELECT 1'],
    ['/tmp/operator.sql'],
    ['--attempt-name', tag],
    ['--journal-sha', 'not-a-digest'],
    ['--apply', '--apply'],
  ]) {
    assert.throws(() => parseMultibotRecoveryArgs([...args, ...suffix]), /ARGUMENTS_INVALID/u);
  }
  for (const name of ['api-ingress', 'maxim-online-unknown', `${tag};stop`, `${tag}\n`])
    assert.throws(
      () => parseMultibotRecoveryArgs(args.map((value) => (value === tag ? name : value))),
      /ARGUMENTS_INVALID/u,
    );
  assert.throws(
    () =>
      parseMultibotRecoveryArgs(
        args.map((value) =>
          value === '2026-10-05T13:11:00.000Z' ? '2026-10-05T15:11:00.000Z' : value,
        ),
      ),
    /ARGUMENTS_INVALID/u,
  );
});

test('baseline accepts all fourteen singleton running exact-image API roles without Docker healthchecks', () => {
  assert.equal(verifyMultibotBaselineContainers(containers(), image), true);
  for (const mutate of [
    (rows) => rows.pop(),
    (rows) => rows.push(structuredClone(rows[0])),
    (rows) => {
      rows[0].Image = `sha256:${'f'.repeat(64)}`;
    },
    (rows) => {
      rows[0].State.Status = 'dead';
    },
    (rows) => {
      rows[0].State.Dead = true;
    },
    (rows) => {
      rows[0].State.Running = false;
    },
    (rows) => {
      rows[0].State.Restarting = true;
    },
    (rows) => {
      rows[0].State.Paused = true;
    },
    (rows) => {
      rows[0].Config.Env[0] = 'APP_SERVICE_NAME=api-admin';
    },
    (rows) => {
      rows[0].Config.Env.push(rows[0].Config.Env[0]);
    },
    (rows) => {
      rows[0].Config.Env.push(rows[0].Config.Env[1]);
    },
    (rows) => {
      rows[0].Name = '/manual-api-ingress';
    },
    (rows) => {
      rows.push({
        Name: '/manual-maxim-api',
        Config: { Labels: { 'com.maxim.release-protected': 'true' }, Env: ['APP_ROLE=ingress'] },
      });
    },
  ]) {
    const rows = containers();
    mutate(rows);
    assert.throws(() => verifyMultibotBaselineContainers(rows, image), /BASELINE_RUNTIME_INVALID/u);
  }
});

test('baseline rejects incomplete running flags and malformed inspection rows with a fixed code', () => {
  for (const flag of ['Running', 'Paused', 'Restarting', 'Dead']) {
    for (const value of [undefined, null, 'false', 0]) {
      const rows = containers();
      if (value === undefined) delete rows[0].State[flag];
      else rows[0].State[flag] = value;
      assert.throws(() => verifyMultibotBaselineContainers(rows, image), {
        message: 'MULTIBOT_RECOVERY_BASELINE_RUNTIME_INVALID',
      });
    }
  }
  for (const malformedRow of [null, undefined, false, 'container', []]) {
    const rows = [...containers(), malformedRow];
    assert.throws(() => verifyMultibotBaselineContainers(rows, image), {
      message: 'MULTIBOT_RECOVERY_BASELINE_RUNTIME_INVALID',
    });
  }
  for (const malformedEnvironment of ['APP_ROLE=ingress', {}, [null], [42]]) {
    const rows = containers();
    rows[0].Config.Env = malformedEnvironment;
    assert.throws(() => verifyMultibotBaselineContainers(rows, image), {
      message: 'MULTIBOT_RECOVERY_BASELINE_RUNTIME_INVALID',
    });
    const foreignRows = [...containers(), { Config: { Env: malformedEnvironment } }];
    assert.throws(() => verifyMultibotBaselineContainers(foreignRows, image), {
      message: 'MULTIBOT_RECOVERY_BASELINE_RUNTIME_INVALID',
    });
  }
});

test('baseline honors effective Docker healthchecks and rejects contradictory inspection state', () => {
  for (const healthcheck of [undefined, null, { Test: [] }, { Test: ['NONE'] }]) {
    const rows = containers();
    rows[0].Config.Healthcheck = healthcheck;
    assert.equal(verifyMultibotBaselineContainers(rows, image), true);
    rows[0].State.Health = { Status: 'healthy' };
    assert.throws(() => verifyMultibotBaselineContainers(rows, image), /BASELINE_RUNTIME_INVALID/u);
  }
  for (const test of [
    ['CMD', 'node', '-e', 'process.exit(0)'],
    ['CMD-SHELL', 'true'],
  ]) {
    const rows = containers();
    for (const row of rows) {
      row.Config.Healthcheck = { Test: test };
      row.State.Health = { Status: 'healthy' };
    }
    assert.equal(verifyMultibotBaselineContainers(rows, image), true);
    for (const health of [
      undefined,
      null,
      {},
      [],
      { Status: 'unhealthy' },
      { Status: 'starting' },
    ]) {
      rows[0].State.Health = health;
      assert.throws(
        () => verifyMultibotBaselineContainers(rows, image),
        /BASELINE_RUNTIME_INVALID/u,
      );
    }
  }
  for (const healthcheck of [
    false,
    [],
    {},
    { Test: null },
    { Test: 'CMD true' },
    { Test: ['UNKNOWN', 'true'] },
    { Test: ['NONE', 'true'] },
    { Test: ['CMD'] },
    { Test: ['CMD', ''] },
    { Test: ['CMD', '   '] },
    { Test: ['CMD', 1] },
    { Test: ['CMD-SHELL'] },
    { Test: ['CMD-SHELL', ''] },
    { Test: ['CMD-SHELL', 'true', 'unexpected'] },
  ]) {
    const rows = containers();
    rows[0].Config.Healthcheck = healthcheck;
    assert.throws(() => verifyMultibotBaselineContainers(rows, image), /BASELINE_RUNTIME_INVALID/u);
    rows[0].State.Health = { Status: 'healthy' };
    assert.throws(() => verifyMultibotBaselineContainers(rows, image), /BASELINE_RUNTIME_INVALID/u);
  }
});

test('one PostgreSQL backend owns the bounded recovery budget and exact UUID tag', () => {
  const command = multibotRecoveryPsqlArgs(tag, {
    imageId: image,
    networkId,
    networkName: 'infra_default',
  });
  assert(command.includes(`PGAPPNAME=${tag}`));
  const options = command.find((value) => value.startsWith('PGOPTIONS='));
  assert.match(options, /max_parallel_maintenance_workers=0/u);
  assert.match(options, /maintenance_work_mem=512MB/u);
  assert.match(options, /temp_file_limit=6GB/u);
  assert.match(options, /(?:^| )-c default_tablespace=(?: |$)/u);
  assert.match(options, /(?:^| )-c temp_tablespaces=(?: |$)/u);
  assert.match(options, /statement_timeout=3600s/u);
  assert(command.includes('/var/lib/postgresql/data:ro,noexec,nosuid,size=64k'));
  assert.throws(() => multibotRecoveryPsqlArgs('api-ingress'), /OWNED_IDENTITY_INVALID/u);
  assert.equal(command[0], 'create');
  assert.ok(command.includes('--interactive'));
  assert.ok(command.includes('--rm') && command.includes('--read-only'));
  assert.equal(command.includes('exec'), false);
  assert.equal(command.includes('run'), false);
  assert.equal(command.includes('--volume'), false);
  assert.equal(command.includes('--env-file'), false);
  assert.equal(command[command.indexOf('--name') + 1], tag);
  assert.equal(command[command.indexOf('--network') + 1], networkId);
  assert.equal(command[command.indexOf('--entrypoint') + 1], 'psql');
  assert.ok(command.includes('PGPASSWORD'));
  assert.ok(command.includes(image));
  for (const client of [
    { imageId: 'postgres:16-alpine', networkId, networkName: 'infra_default' },
    { imageId: image, networkId, networkName: 'other_project' },
    { imageId: image, networkId: 'infra_default', networkName: 'infra_default' },
    { imageId: image, networkName: 'infra_default' },
  ])
    assert.throws(() => multibotRecoveryPsqlArgs(tag, client), /CLIENT_IDENTITY_INVALID/u);
});

test('disposable client attestation binds the live PostgreSQL16 image and exact Compose network without exposing its password', () => {
  const fixture = () => ({
    server: {
      Name: '/infra-postgres-1',
      Image: image,
      State: { Status: 'running' },
      Config: {
        Image: 'postgres:16-alpine',
        Env: [
          'POSTGRES_USER=maxim',
          'POSTGRES_DB=maxim',
          'POSTGRES_PASSWORD=fixture-private-password',
        ],
        Labels: { 'com.docker.compose.project': 'infra', 'com.docker.compose.service': 'postgres' },
      },
      NetworkSettings: {
        Networks: {
          infra_default: { NetworkID: 'f'.repeat(64), Aliases: ['postgres', 'infra-postgres-1'] },
        },
      },
    },
    image: { Id: image },
    network: {
      Id: 'f'.repeat(64),
      Name: 'infra_default',
      Driver: 'bridge',
      Scope: 'local',
      Labels: { 'com.docker.compose.project': 'infra', 'com.docker.compose.network': 'default' },
    },
  });
  const valid = fixture();
  const client = verifyMultibotRecoveryClient(valid.server, valid.image, valid.network);
  assert.equal(client.password, 'fixture-private-password');
  assert.equal(
    multibotRecoveryPsqlArgs(tag, client).some((part) => part.includes(client.password)),
    false,
  );
  for (const mutate of [
    (v) => {
      v.server.State.Status = 'exited';
    },
    (v) => {
      v.server.Config.Image = 'postgres:latest';
    },
    (v) => {
      v.image.Id = `sha256:${'d'.repeat(64)}`;
    },
    (v) => {
      v.server.NetworkSettings.Networks.infra_default.NetworkID = 'd'.repeat(64);
    },
    (v) => {
      v.server.NetworkSettings.Networks.infra_default.Aliases = [];
    },
    (v) => {
      v.network.Name = 'different';
    },
    (v) => {
      v.network.Labels['com.docker.compose.project'] = 'different';
    },
    (v) => {
      v.network.Driver = 'host';
    },
    (v) => {
      v.server.Config.Env.push('POSTGRES_PASSWORD=other');
    },
    (v) => {
      v.server.Config.Env[0] = 'POSTGRES_USER=different';
    },
    (v) => {
      v.server.Config.Env[2] = 'POSTGRES_PASSWORD=';
    },
  ]) {
    const value = fixture();
    mutate(value);
    assert.throws(
      () => verifyMultibotRecoveryClient(value.server, value.image, value.network),
      (error) => error.message === 'MULTIBOT_RECOVERY_CLIENT_IDENTITY_INVALID',
    );
  }
});

test('resolver has only an immutable API image, a read-only migration bind, bounded temporary storage and inherited database URL', () => {
  const client = {
    imageId: image,
    networkId,
    networkName: 'infra_default',
    databaseUrl: 'fixture-secret',
  };
  const command = multibotRecoveryResolverArgs(tag, client, '/reviewed/checkout');
  assert.equal(command[0], 'create');
  assert.ok(
    command.includes(image) && command.includes('--read-only') && command.includes('DATABASE_URL'),
  );
  assert.equal(command.includes('fixture-secret'), false);
  assert.equal(command.includes('--env-file'), false);
  assert.equal(command.includes('run'), false);
  assert.equal(command[command.indexOf('--name') + 1], tag);
  assert.equal(command[command.indexOf('--network') + 1], networkId);
  assert.equal(
    command[command.indexOf('--mount') + 1],
    'type=bind,source=/reviewed/checkout/apps/api/prisma/migrations,target=/app/apps/api/prisma/migrations,readonly',
  );
  assert.equal(command[command.indexOf('--tmpfs') + 1], '/tmp:rw,noexec,nosuid,size=64m');
  assert.equal(command[command.indexOf('--entrypoint') + 1], 'node');
  assert.equal(command.filter((part) => part === '--mount').length, 1);
  for (const path of ['relative', '/injected,path', '/injected:path', '/injected\npath'])
    assert.throws(
      () => multibotRecoveryResolverArgs(tag, client, path),
      /CLIENT_IDENTITY_INVALID/u,
    );
});

test('cancellation attestation requires exact object absence rather than an exited or created client', () => {
  assert.equal(verifyMultibotRecoveryOriginalContainerAbsence(''), true);
  assert.equal(verifyMultibotRecoveryOriginalContainerAbsence('\n'), true);
  for (const output of [
    undefined,
    null,
    `${tag} exited`,
    `${tag} created`,
    `${tag} running`,
    `${tag} paused`,
    'unparseable state',
  ])
    assert.throws(
      () => verifyMultibotRecoveryOriginalContainerAbsence(output),
      /CANCELLATION_CONTAINER_PRESENT/u,
    );
});

test('resolver URL must address the same reviewed local database and public schema as catalog and exact-session cleanup', () => {
  for (const value of [
    'postgresql://maxim:fixture-password@postgres/maxim?schema=public',
    'postgres://maxim:p%40ss@infra-postgres-1:5432/maxim?connect_timeout=5',
  ])
    assert.equal(verifyMultibotRecoveryDatabaseUrl(value), value);
  for (const value of [
    'postgresql://maxim:private-secret@remote/maxim',
    'postgresql://other:private-secret@postgres/maxim',
    'postgresql://maxim:private-secret@postgres/other',
    'postgresql://maxim:private-secret@postgres/maxim?schema=other',
    'postgresql://maxim:private-secret@postgres:5433/maxim',
    'postgresql://maxim:private-secret@postgres/maxim?host=remote',
    'postgresql://maxim:private-secret@postgres/maxim?application_name=old',
    'postgresql://maxim:private-secret@postgres/maxim?options=-c%20search_path%3Dother',
    'postgresql://maxim:private-secret@postgres/maxim#fragment',
    'private-secret',
  ])
    assert.throws(
      () => verifyMultibotRecoveryDatabaseUrl(value),
      (error) => error.message === 'MULTIBOT_RECOVERY_CLIENT_DATABASE_SCOPE_INVALID',
    );
});

const snapshot = (now, lag = 0) => ({
  checkedAtMs: now,
  ingress: {
    status: 200,
    body: {
      ok: true,
      timestamp: new Date(now).toISOString(),
      checks: {
        database: true,
        redis: true,
        queueLag: {
          ok: true,
          rawOk: lag <= 10,
          effectiveLagSec: lag,
          sampleGeneratedAt: new Date(now).toISOString(),
          softWarning: false,
          softWarningCode: null,
        },
      },
    },
  },
  admin: {
    status: 200,
    body: {
      ok: true,
      timestamp: new Date(now).toISOString(),
      checks: {
        database: true,
        redis: true,
        queueLag: {
          ok: true,
          rawOk: lag <= 10,
          effectiveLagSec: lag,
          sampleGeneratedAt: new Date(now).toISOString(),
          softWarning: false,
          softWarningCode: null,
        },
      },
    },
  },
});

test('recovery requires two fresh minutes of low lag and stops before any work on renewed pressure', async () => {
  let now = Date.now(),
    reads = 0;
  await awaitMultibotRecoveryAdmission({
    now: () => now,
    read: async () => {
      reads += 1;
      return snapshot(now);
    },
    wait: async (ms) => {
      now += ms;
    },
  });
  assert.equal(reads, 13);
  reads = 0;
  await assert.rejects(
    awaitMultibotRecoveryAdmission({
      now: () => now,
      read: async () => snapshot(now, ++reads === 3 ? 11 : 0),
      wait: async (ms) => {
        now += ms;
      },
    }),
    /RUNTIME_/u,
  );
  assert.equal(reads, 3);
  await assert.rejects(
    awaitMultibotRecoveryAdmission({
      requireActive: () => {
        throw new Error('interrupted');
      },
      read: async () => {
        throw new Error('must not probe');
      },
    }),
    /interrupted/u,
  );
});
