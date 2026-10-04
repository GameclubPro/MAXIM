import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import inspector from './photo-native-runtime-boundary.cjs';

const { isReviewedPhotoNativeSandboxConfig, isReviewedPhotoNativeSandboxRuntime } = inspector;
import { config, runtime, image } from './test-fixtures/photo-native-fixtures.mjs';

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
