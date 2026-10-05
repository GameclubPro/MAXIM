import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import {
  createMultibotOnlineClientLauncher,
  multibotOnlineClientCreateArgs,
  verifyMultibotOnlineClientConfiguration,
  verifyMultibotOnlineClientImage,
  verifyMultibotOnlineClientNetwork,
  verifyMultibotOnlineDatabaseUrl,
} from './multibot-online-client.mjs';

const project = 'isolated-ci-project';
const compose = [
  '--env-file',
  '/private/fixture.env',
  '-p',
  project,
  '-f',
  'infra/docker-compose.yml',
  '-f',
  'infra/docker-compose.runtime-no-build.yml',
];
const sha = 'a'.repeat(40);
const imageId = `sha256:${'b'.repeat(64)}`;
const networkId = 'c'.repeat(64);
const tag = 'maxim-online-61bfd8a3-9d75-4ec2-9b1c-89f325387e53';
const databaseUrl = 'postgresql://maxim:fixture-private-password@postgres/maxim?schema=public';
const env = Object.freeze({ MAXIM_EXPECTED_DEPLOY_SHA: sha, MAX_BOT_TOKEN: 'host-private-token' });
const config = () => ({
  name: project,
  services: {
    'api-ingress': {
      image: `maxim-api:${sha}`,
      environment: { DATABASE_URL: databaseUrl, MAX_BOT_TOKEN: 'service-private-token' },
      networks: { default: null },
      volumes: [{ source: '/private/bot-key' }],
    },
  },
  networks: { default: { name: `${project}_default` } },
});
const image = () => ({
  Id: imageId,
  Config: {
    User: 'node',
    Labels: {
      'com.maxim.release-protected': 'true',
      'org.opencontainers.image.revision': sha,
    },
  },
});
const network = () => ({
  Id: networkId,
  Name: `${project}_default`,
  Driver: 'bridge',
  Scope: 'local',
  Labels: { 'com.docker.compose.project': project, 'com.docker.compose.network': 'default' },
});

function fixture(overrides = {}) {
  const calls = [];
  const child = new EventEmitter();
  return {
    calls,
    child,
    options: {
      env,
      run: async (command, args, options) => {
        assert.equal(command, 'docker');
        calls.push({ args, options });
        if (args[0] === 'compose') {
          assert.deepEqual(args, ['compose', ...compose, 'config', '--format', 'json']);
          return { stdout: JSON.stringify(config()) };
        }
        if (args[0] === 'image') return { stdout: JSON.stringify([image()]) };
        if (args[0] === 'network') return { stdout: JSON.stringify([network()]) };
        assert.equal(args[0], 'create');
        return { stdout: 'd'.repeat(64) };
      },
      start: (...args) => {
        calls.push({ start: args });
        return child;
      },
      ...overrides,
    },
  };
}

test('configuration preserves complete Compose selectors and non-production project while rejecting foreign scope', () => {
  const expected = verifyMultibotOnlineClientConfiguration(config(), compose, sha);
  assert.equal(expected.project, project);
  assert.equal(expected.networkName, `${project}_default`);
  assert.equal(expected.databaseUrl, databaseUrl);
  for (const mutate of [
    (v) => {
      v.name = 'infra';
    },
    (v) => {
      v.services['api-ingress'].image = 'maxim-api:latest';
    },
    (v) => {
      v.networks.default.external = true;
    },
    (v) => {
      v.networks.default.name = 'infra_default';
    },
    (v) => {
      v.services['api-ingress'].networks = { default: null, other: null };
    },
    (v) => {
      v.services['api-ingress'].environment.DATABASE_URL = 'postgresql://maxim:secret@remote/maxim';
    },
  ]) {
    const value = config();
    mutate(value);
    assert.throws(
      () => verifyMultibotOnlineClientConfiguration(value, compose, sha),
      /MULTIBOT_PREPARE_CLIENT_/u,
    );
  }
  assert.throws(
    () => verifyMultibotOnlineClientConfiguration(config(), compose, ''),
    /SOURCE_SHA_INVALID/u,
  );
});

test('image and network attestation rejects mutable, foreign or privileged runtime identities', () => {
  assert.equal(verifyMultibotOnlineClientImage(image(), sha), imageId);
  const configuration = verifyMultibotOnlineClientConfiguration(config(), compose, sha);
  assert.equal(verifyMultibotOnlineClientNetwork(network(), configuration), networkId);
  for (const mutate of [
    (v) => {
      v.Id = 'postgres:16';
    },
    (v) => {
      v.Config.User = 'root';
    },
    (v) => {
      v.Config.Labels['org.opencontainers.image.revision'] = 'f'.repeat(40);
    },
    (v) => {
      v.Config.Labels['com.maxim.release-protected'] = 'false';
    },
  ]) {
    const value = image();
    mutate(value);
    assert.throws(() => verifyMultibotOnlineClientImage(value, sha), /IMAGE_INVALID/u);
  }
  for (const mutate of [
    (v) => {
      v.Name = 'infra_default';
    },
    (v) => {
      v.Driver = 'host';
    },
    (v) => {
      v.Labels['com.docker.compose.project'] = 'infra';
    },
  ]) {
    const value = network();
    mutate(value);
    assert.throws(
      () => verifyMultibotOnlineClientNetwork(value, configuration),
      /NETWORK_INVALID/u,
    );
  }
});

test('database scope retains URL settings but rejects a different owner/schema/server and cleanup tag override', () => {
  for (const value of [
    databaseUrl,
    `postgres://maxim:p%40ss@${project}-postgres-1:5432/maxim?connect_timeout=5&options=-c%20timezone%3DUTC`,
  ])
    assert.equal(verifyMultibotOnlineDatabaseUrl(value, project), value);
  for (const value of [
    databaseUrl.replace('maxim:', 'other:'),
    databaseUrl.replace('/maxim?', '/other?'),
    databaseUrl.replace('schema=public', 'schema=other'),
    `${databaseUrl}&application_name=old`,
    `${databaseUrl}&options=-c%20search_path%3Dother`,
    `${databaseUrl}&host=other`,
    databaseUrl.replace('@postgres/', '@postgres:5433/'),
    `${databaseUrl}\n`,
  ])
    assert.throws(() => verifyMultibotOnlineDatabaseUrl(value, project), /DATABASE_SCOPE_INVALID/u);
});

test('minimal read-only client has only bounded writable tmpfs and no service secrets or service volumes', () => {
  const args = multibotOnlineClientCreateArgs(tag, {
    imageId,
    networkId,
    networkName: `${project}_default`,
  });
  assert.equal(args[0], 'create');
  assert.equal(args[args.indexOf('--name') + 1], tag);
  assert.equal(args[args.indexOf('--user') + 1], '1000:1000');
  assert.equal(args[args.indexOf('--network') + 1], networkId);
  assert.ok(args.includes('--read-only') && args.includes('--rm') && args.includes('DATABASE_URL'));
  assert.ok(
    args.includes(
      '/app/apps/api/.migration-prepare:rw,noexec,nosuid,uid=1000,gid=1000,mode=0700,size=256m',
    ),
  );
  assert.equal(args.filter((part) => part === '--tmpfs').length, 2);
  assert.deepEqual(args.slice(-3), ['node', imageId, 'scripts/agent/multibot-online-prepare.mjs']);
  assert.equal(
    args.includes('--mount') || args.includes('--volume') || args.includes('--env-file'),
    false,
  );
  assert.equal(JSON.stringify(args).includes('private'), false);
  assert.throws(
    () =>
      multibotOnlineClientCreateArgs('api-ingress', {
        imageId,
        networkId,
        networkName: `${project}_default`,
      }),
    /IDENTITY_INVALID/u,
  );
  for (const invalidNetworkId of [undefined, `${project}_default`, 'd'.repeat(63)])
    assert.throws(
      () =>
        multibotOnlineClientCreateArgs(tag, {
          imageId,
          networkId: invalidNetworkId,
          networkName: `${project}_default`,
        }),
      /IDENTITY_INVALID/u,
    );
});

test('factory awaits named creation before start and forwards only the database URL to the container', async () => {
  const value = fixture();
  const launcher = await createMultibotOnlineClientLauncher(compose, value.options);
  assert.throws(() => launcher.start(tag), /START_WITHOUT_PREPARATION/u);
  await launcher.prepare(tag);
  const create = value.calls.find((entry) => entry.args?.[0] === 'create');
  assert.equal(create.options.env.DATABASE_URL, databaseUrl);
  assert.equal(create.args[create.args.indexOf('--network') + 1], networkId);
  assert.equal(env.DATABASE_URL, undefined);
  assert.equal(
    create.args.includes('service-private-token') || create.args.includes('host-private-token'),
    false,
  );
  assert.equal(launcher.start(tag), value.child);
  assert.deepEqual(value.calls.at(-1).start, [
    'docker',
    ['start', '--attach', tag],
    { stdio: 'inherit' },
  ]);
  assert.throws(() => launcher.start(tag), /START_WITHOUT_PREPARATION/u);
  await assert.rejects(launcher.prepare(tag), /ALREADY_PREPARED/u);
});

test('uncertain creation, changed network and malformed metadata never send start or retry', async () => {
  for (const scenario of [
    'create timeout',
    'created identity missing',
    'network changed',
    'malformed metadata',
  ]) {
    const value = fixture();
    const original = value.options.run;
    let networkReads = 0;
    value.options.run = async (command, args, options) => {
      if (args[0] === 'network' && ++networkReads > 1 && scenario === 'network changed')
        return { stdout: JSON.stringify([{ ...network(), Id: 'e'.repeat(64) }]) };
      if (args[0] === 'create') {
        if (scenario === 'create timeout') throw new Error('private-password');
        if (scenario === 'created identity missing') return { stdout: '' };
      }
      if (args[0] === 'compose' && scenario === 'malformed metadata')
        return { stdout: 'private-password' };
      return original(command, args, options);
    };
    if (scenario === 'malformed metadata')
      await assert.rejects(
        createMultibotOnlineClientLauncher(compose, value.options),
        /METADATA_INVALID/u,
      );
    else {
      const launcher = await createMultibotOnlineClientLauncher(compose, value.options);
      await assert.rejects(launcher.prepare(tag), /MULTIBOT_PREPARE_CLIENT_/u);
      assert.throws(() => launcher.start(tag), /START_WITHOUT_PREPARATION/u);
      await assert.rejects(launcher.prepare(tag), /ALREADY_PREPARED/u);
    }
    assert.equal(
      value.calls.some((entry) => entry.start),
      false,
    );
  }
});
