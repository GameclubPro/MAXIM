import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import inspector from './photo-native-runtime-boundary.cjs';

const { isReviewedPhotoNativeSandboxConfig, isReviewedPhotoNativeSandboxRuntime } = inspector;
const command = [
  'node',
  'apps/api/dist/apps/api/src/moderation/photo-duplicate/native-photo-sandbox.entrypoint.js',
];
const environment = {
  NODE_ENV: 'production',
  PHOTO_NATIVE_SANDBOX_SOCKET_PATH: '/run/maxim-photo/native-photo.sock',
  PHOTO_DUPLICATE_MAX_BYTES: '16777216',
  PHOTO_DUPLICATE_MAX_PIXELS: '40000000',
  VIPS_CONCURRENCY: '1',
};
const image = `sha256:${'a'.repeat(64)}`;
function config() {
  return {
    services: {
      'photo-native-sandbox': {
        labels: { 'com.maxim.photo-native-sandbox': 'true' },
        network_mode: 'none',
        user: '1000:1000',
        init: true,
        read_only: true,
        cpus: 1,
        mem_limit: '1073741824',
        pids_limit: 64,
        deploy: { replicas: 1 },
        restart: 'unless-stopped',
        cap_drop: ['ALL'],
        security_opt: ['no-new-privileges:true'],
        tmpfs: ['/tmp:size=64m,mode=1777,uid=1000,gid=1000'],
        command,
        healthcheck: {
          test: ['CMD', ...command, '--probe'],
          timeout: '8s',
          interval: '10s',
          retries: 3,
          start_period: '20s',
        },
        environment: { ...environment },
        volumes: [{ type: 'volume', source: 'photo_native_ipc', target: '/run/maxim-photo' }],
      },
      'api-moderation-background': {
        environment: {
          PHOTO_NATIVE_SANDBOX_SOCKET_PATH: environment.PHOTO_NATIVE_SANDBOX_SOCKET_PATH,
        },
        depends_on: { 'photo-native-sandbox': { condition: 'service_healthy' } },
        volumes: [
          {
            type: 'volume',
            source: 'photo_native_ipc',
            target: '/run/maxim-photo',
            read_only: true,
          },
        ],
      },
    },
  };
}
function runtime(project = 'infra') {
  return {
    Name: `/${project}-photo-native-sandbox-1`,
    Image: image,
    State: { Running: true, Status: 'running', Health: { Status: 'healthy' } },
    Config: {
      User: '1000:1000',
      Cmd: command,
      Entrypoint: ['docker-entrypoint.sh'],
      Env: [
        ...Object.entries(environment).map(([key, value]) => `${key}=${value}`),
        'NODE_VERSION=24.16.0',
        'YARN_VERSION=1.22.22',
        'HOME=/home/node',
        'NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/russian-trusted-ca-bundle.crt',
      ],
      Labels: {
        'com.docker.compose.project': project,
        'com.docker.compose.service': 'photo-native-sandbox',
        'com.maxim.photo-native-sandbox': 'true',
        'com.maxim.photo-native-sandbox-capable': 'true',
        ...(project === 'infra' ? { 'com.maxim.release-protected': 'true' } : {}),
      },
      Healthcheck: {
        Test: ['CMD', ...command, '--probe'],
        Interval: 10e9,
        Timeout: 8e9,
        StartPeriod: 20e9,
        Retries: 3,
      },
    },
    HostConfig: {
      NetworkMode: 'none',
      ReadonlyRootfs: true,
      Privileged: false,
      Init: true,
      RestartPolicy: { Name: 'unless-stopped' },
      PidsLimit: 64,
      Memory: 1073741824,
      NanoCpus: 1e9,
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges:true'],
      Tmpfs: { '/tmp': 'size=64m,mode=1777,uid=1000,gid=1000' },
      IpcMode: 'private',
    },
    Mounts: [
      {
        Type: 'volume',
        Name: `${project}_photo_native_ipc`,
        Destination: '/run/maxim-photo',
        RW: true,
      },
    ],
    NetworkSettings: { Networks: { none: {} } },
  };
}

test('attests main and scale singleton runtime metadata and exact Compose boundary', () => {
  assert.equal(isReviewedPhotoNativeSandboxConfig(config()), true);
  assert.equal(isReviewedPhotoNativeSandboxRuntime(runtime(), 'infra', image), true);
  assert.equal(
    isReviewedPhotoNativeSandboxRuntime(runtime('infra-scale'), 'infra-scale', image),
    true,
  );
  assert.equal(
    isReviewedPhotoNativeSandboxRuntime(runtime(), 'infra', `sha256:${'b'.repeat(64)}`),
    false,
  );
});

const runtimeMutations = {
  'unknown secret': (value) => value.Config.Env.push('MAX_BOT_TOKEN=secret'),
  'NODE_OPTIONS injection': (value) => value.Config.Env.push('NODE_OPTIONS=--require=evil'),
  'duplicate env': (value) => value.Config.Env.push('NODE_ENV=production'),
  'different PATH': (value) => value.Config.Env.push('PATH=/evil'),
  'wrong socket env': (value) => {
    value.Config.Env[1] = 'PHOTO_NATIVE_SANDBOX_SOCKET_PATH=/run/maxim-ocr/native-ocr.sock';
  },
  'host network': (value) => {
    value.HostConfig.NetworkMode = 'host';
  },
  'extra network': (value) => {
    value.NetworkSettings.Networks.bridge = {};
  },
  'writable root': (value) => {
    value.HostConfig.ReadonlyRootfs = false;
  },
  'unbounded memory': (value) => {
    value.HostConfig.Memory = 0;
  },
  'unbounded pids': (value) => {
    value.HostConfig.PidsLimit = -1;
  },
  'extra capability': (value) => {
    value.HostConfig.CapAdd = ['SYS_ADMIN'];
  },
  privileged: (value) => {
    value.HostConfig.Privileged = true;
  },
  'extra mount': (value) => {
    value.Mounts.push({ Type: 'bind', Source: '/secret', Destination: '/secret' });
  },
  'OCR shared volume': (value) => {
    value.Mounts[0].Name = 'infra_ocr_native_ipc';
  },
  'host PID': (value) => {
    value.HostConfig.PidMode = 'host';
  },
  'extra security option': (value) => {
    value.HostConfig.SecurityOpt.push('seccomp=unconfined');
  },
  'extra tmpfs': (value) => {
    value.HostConfig.Tmpfs['/other'] = 'size=1g';
  },
  unhealthy: (value) => {
    value.State.Health.Status = 'unhealthy';
  },
  'wrong probe': (value) => {
    value.Config.Healthcheck.Test = ['CMD', 'true'];
  },
  'wrong command': (value) => {
    value.Config.Cmd = ['sh'];
  },
  'custom entrypoint': (value) => {
    value.Config.Entrypoint = ['sh'];
  },
  'manual container': (value) => {
    value.Name = '/manual-photo';
  },
  'unprotected main': (value) => {
    delete value.Config.Labels['com.maxim.release-protected'];
  },
  'missing capability': (value) => {
    delete value.Config.Labels['com.maxim.photo-native-sandbox-capable'];
  },
};
for (const [label, mutate] of Object.entries(runtimeMutations))
  test(`rejects runtime ${label}`, () => {
    const value = runtime();
    mutate(value);
    assert.equal(isReviewedPhotoNativeSandboxRuntime(value), false);
  });

const configMutations = {
  'secret env': (value) => {
    value.services['photo-native-sandbox'].environment.DATABASE_URL = 'secret';
  },
  'env file': (value) => {
    value.services['photo-native-sandbox'].env_file = ['/secret'];
  },
  'external network': (value) => {
    value.services['photo-native-sandbox'].networks = ['default'];
  },
  'extra consumer': (value) => {
    value.services.extra = { volumes: [{ source: 'photo_native_ipc' }] };
  },
  'consumer write access': (value) => {
    value.services['api-moderation-background'].volumes[0].read_only = false;
  },
  'consumer wrong socket': (value) => {
    value.services['api-moderation-background'].environment.PHOTO_NATIVE_SANDBOX_SOCKET_PATH =
      '/other.sock';
  },
  'non-healthy dependency': (value) => {
    value.services['api-moderation-background'].depends_on['photo-native-sandbox'].condition =
      'service_started';
  },
  'too many replicas': (value) => {
    value.services['photo-native-sandbox'].deploy.replicas = 2;
  },
  'raised memory': (value) => {
    value.services['photo-native-sandbox'].mem_limit = '2147483648';
  },
  device: (value) => {
    value.services['photo-native-sandbox'].devices = ['/dev/mem'];
  },
  'disabled health': (value) => {
    value.services['photo-native-sandbox'].healthcheck.disable = true;
  },
};
for (const [label, mutate] of Object.entries(configMutations))
  test(`rejects Compose ${label}`, () => {
    const value = config();
    mutate(value);
    assert.equal(isReviewedPhotoNativeSandboxConfig(value), false);
  });

test('CLI returns status only and fails closed for malformed or excess input', () => {
  const script = fileURLToPath(new URL('./photo-native-runtime-boundary.cjs', import.meta.url));
  for (const [args, input, expected] of [
    [['config'], JSON.stringify(config()), 0],
    [['runtime', 'infra', image], JSON.stringify(runtime()), 0],
    [['runtime', 'infra', image], JSON.stringify([runtime()]), 1],
    [['config'], '{"SECRET":"private",', 1],
    [['config'], 'x'.repeat(4 * 1024 * 1024 + 1), 1],
  ]) {
    const result = spawnSync(process.execPath, [script, ...args], {
      input,
      encoding: 'utf8',
      timeout: 5000,
    });
    assert.equal(result.status, expected);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
  }
});
