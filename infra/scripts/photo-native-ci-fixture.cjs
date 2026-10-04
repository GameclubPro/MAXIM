'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const runtime = '/app/apps/api/dist/apps/api/src/moderation/photo-duplicate';
const socketPath = '/run/maxim-photo/native-photo.sock';
const canonicalPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAYAAAC56t6BAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWPgCbjTAMIMGAwAhZsKUeANHEMAAAAASUVORK5CYII=',
  'base64',
);
const canonicalHash = '44dcf8dcd218b35c9df6fc969e35ee46f36b984e2cc26e109a7addfff4155377';

function isolatedCompose(source, image, owner) {
  assert.match(image, /^maxim-api:[a-f0-9]{40}$/u);
  assert.match(owner, /^[a-zA-Z0-9-]+$/u);
  const lines = source.split('\n');
  const start = lines.indexOf('  photo-native-sandbox:');
  assert.ok(start >= 0, 'Production photo sandbox service is missing');
  const end = lines.findIndex((line, index) => index > start && /^\S|^ {2}\S/u.test(line));
  const service = lines.slice(start, end < 0 ? undefined : end).join('\n');
  assert.equal((service.match(/^ {4}labels:$/gmu) ?? []).length, 1);
  // FLAG: Copy the actual production service unchanged except an ownership label.
  // The consumer is never started; it exists only for the strict Compose inspector.
  return `x-default-logging: &default-logging
  driver: json-file
  options: {max-size: '1m', max-file: '1'}
services:
${service.replace('    labels:\n', `    labels:\n      com.maxim.photo-native-ci: '${owner}'\n`)}
  api-moderation-background:
    image: '${image}'
    network_mode: none
    environment:
      PHOTO_NATIVE_SANDBOX_SOCKET_PATH: ${socketPath}
    volumes:
      - photo_native_ipc:/run/maxim-photo:ro
    depends_on:
      photo-native-sandbox: {condition: service_healthy}
volumes:
  photo_native_ipc: {external: true, name: infra_photo_native_ipc}
`;
}

function assertCgroupLimits(read = (file) => fs.readFileSync(file, 'utf8').trim()) {
  assert.equal(read('/sys/fs/cgroup/memory.max'), '1073741824');
  assert.equal(read('/sys/fs/cgroup/pids.max'), '64');
  const [quota, period] = read('/sys/fs/cgroup/cpu.max').split(/\s+/u).map(Number);
  assert.ok(Number.isSafeInteger(quota) && quota > 0 && quota === period);
  const status = read('/proc/self/status');
  assert.match(status, /^NoNewPrivs:\s+1$/mu);
  assert.match(status, /^CapEff:\s+0+$/mu);
  assert.match(status, /^Uid:\s+1000\s+1000\s+1000\s+1000$/mu);
}

function request(deadlineMs = 5000) {
  return {
    operation: 'fingerprint',
    deadlineAtMs: Date.now() + deadlineMs,
    maxInputBytes: 16777216,
    maxInputPixels: 40000000,
    remainingEncodedBytes: canonicalPng.length,
    remainingPixels: 6,
    expectedFormat: 'png',
  };
}

async function main(mode, args) {
  if (mode === 'compose') {
    const [source, destination, image, owner] = args;
    fs.writeFileSync(destination, isolatedCompose(fs.readFileSync(source, 'utf8'), image, owner));
    return;
  }
  if (mode === 'attest') {
    const [helper, inspection, imageId] = args;
    const containers = JSON.parse(fs.readFileSync(inspection, 'utf8'));
    assert.equal(containers.length, 1);
    assert.equal(
      require(path.resolve(helper)).isReviewedPhotoNativeSandboxRuntime(
        containers[0],
        'infra',
        imageId,
      ),
      true,
    );
    return;
  }
  if (mode === 'limits') {
    assertCgroupLimits();
    assert.equal(process.getuid(), 1000);
    assert.ok(
      Object.values(require('node:os').networkInterfaces()).every((entries) =>
        entries.every((entry) => entry.internal),
      ),
    );
    return;
  }
  const { runNativePhotoWorker } = require(`${runtime}/native-photo-runner.js`);
  const { NativePhotoSandboxClient } = require(`${runtime}/native-photo-sandbox.client.js`);
  if (mode === 'runner') {
    const rejected = await runNativePhotoWorker(
      request(1500),
      canonicalPng,
      new AbortController().signal,
      { workerPath: '/ci/photo-native-ci-hang.cjs' },
    );
    assert.deepEqual(rejected, { kind: 'rejected', reason: 'decode_deadline_exceeded' });
    const pid = Number(fs.readFileSync('/tmp/maxim-photo-ci-child.pid', 'utf8'));
    assert.ok(Number.isSafeInteger(pid) && pid > 1);
    for (const target of [pid, -pid]) {
      assert.throws(() => process.kill(target, 0), { code: 'ESRCH' });
    }
    const result = await runNativePhotoWorker(
      request(),
      canonicalPng,
      new AbortController().signal,
    );
    assert.equal(result.kind, 'complete');
    assert.equal(result.fingerprint.canonicalHash, canonicalHash);
    return;
  }
  if (mode === 'fatal-server') {
    const { startNativePhotoSandbox } = require(`${runtime}/native-photo-sandbox.server.js`);
    // FLAG: A controlled child hang exercises the unchanged supervisor and its real
    // fatal exit. This fixture is never an image entrypoint or a production option.
    await startNativePhotoSandbox(process.env, {
      runWorker: async (input, payload, signal) => {
        let first = false;
        try {
          fs.writeFileSync('/run/maxim-photo/ci-fault-used', 'once', { flag: 'wx' });
          first = true;
        } catch (error) {
          if (error.code !== 'EEXIST') throw error;
        }
        return runNativePhotoWorker(
          input,
          payload,
          signal,
          first ? { workerPath: '/ci/photo-native-ci-hang.cjs' } : {},
        );
      },
    });
    return;
  }
  const client = new NativePhotoSandboxClient(socketPath);
  if (mode === 'instance') {
    process.stdout.write(String((await client.probe()).instanceId));
    return;
  }
  if (mode === 'fault-request') {
    try {
      assert.deepEqual(await client.fingerprint(canonicalPng, request(2500)), {
        kind: 'rejected',
        reason: 'decode_deadline_exceeded',
      });
    } catch (error) {
      if (!/Photo sandbox transport/u.test(String(error.message))) throw error;
    }
    return;
  }
  throw new Error('Unknown photo CI fixture operation');
}

module.exports = { isolatedCompose, assertCgroupLimits };
if (require.main === module || process.argv[1] === '-') {
  main(process.argv[2], process.argv.slice(3)).catch(() => {
    process.stderr.write('Photo native CI fixture failed.\n');
    process.exitCode = 1;
  });
}
