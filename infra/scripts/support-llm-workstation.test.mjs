import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  attestSupportModel,
  createSupportController,
  supportFileHash,
  supportMatchesProcess,
  supportPrivateFile,
  supportProcessIdentity,
  supportVerifyArtifact,
  supportVerifyBundle,
} from './support-llm-workstation.mjs';
import { SUPPORT_MODEL, supportModelArgs } from './support-llm-profile.mjs';

const digest = (value) => createHash('sha256').update(value).digest('hex');
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'maxim-support-controller-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('artifact checks refuse symlinks, partial downloads and equal-length corrupt weights', async (t) => {
  const root = fixture(t),
    path = join(root, 'weights.gguf');
  const expected = { bytes: 6, sha256: digest('pinned') };
  writeFileSync(path, 'pinned');
  await supportVerifyArtifact(path, expected);
  assert.equal(await supportFileHash(path), expected.sha256);
  writeFileSync(path, 'pin');
  await assert.rejects(supportVerifyArtifact(path, expected), /support_artifact_identity/u);
  writeFileSync(path, 'drift!');
  await assert.rejects(supportVerifyArtifact(path, expected), /support_artifact_identity/u);
  symlinkSync(path, join(root, 'link.gguf'));
  await assert.rejects(
    supportVerifyArtifact(join(root, 'link.gguf'), expected),
    /support_artifact_identity/u,
  );
});

test('immutable bundle verification binds the manifest, complete file set and link targets', async (t) => {
  const root = fixture(t),
    bundle = join(root, 'bundle');
  mkdirSync(bundle);
  writeFileSync(join(bundle, 'client.mjs'), 'export const safe = true;');
  const files = { 'client.mjs': { sha256: await supportFileHash(join(bundle, 'client.mjs')) } };
  writeFileSync(join(bundle, 'files.json'), JSON.stringify(files));
  const manifestHash = await supportFileHash(join(bundle, 'files.json'));
  await supportVerifyBundle(bundle, manifestHash);
  writeFileSync(join(bundle, 'client.mjs'), 'export const safe = false;');
  await assert.rejects(supportVerifyBundle(bundle, manifestHash), /support_bundle_file_changed/u);
  writeFileSync(join(bundle, 'client.mjs'), 'export const safe = true;');
  writeFileSync(join(bundle, 'unrecorded'), 'x');
  await assert.rejects(supportVerifyBundle(bundle, manifestHash), /support_bundle_files_changed/u);
  rmSync(join(bundle, 'unrecorded'));
  symlinkSync('../outside', join(bundle, 'escape'));
  files.escape = { target: '../outside' };
  writeFileSync(join(bundle, 'files.json'), JSON.stringify(files));
  await assert.rejects(
    supportVerifyBundle(bundle, manifestHash),
    /support_bundle_manifest_changed/u,
  );
  await assert.rejects(supportVerifyBundle(bundle), /support_bundle_link_changed/u);
});

test('private state refuses group-readable files and symbolic links', (t) => {
  const root = fixture(t),
    path = join(root, 'key');
  writeFileSync(path, 'not-a-real-key', { mode: 0o600 });
  supportPrivateFile(path);
  chmodSync(path, 0o640);
  assert.throws(() => supportPrivateFile(path), /support_private_file_required/u);
  chmodSync(path, 0o600);
  symlinkSync(path, join(root, 'key-link'));
  assert.throws(() => supportPrivateFile(join(root, 'key-link')), /support_private_file_required/u);
});

test('process ownership requires exact PID, start ticks and complete command line', () => {
  const observed = supportProcessIdentity(process.pid);
  assert.ok(observed);
  const record = { pid: process.pid, startTicks: observed.startTicks };
  assert.equal(supportMatchesProcess(record, observed.argv), true);
  assert.equal(
    supportMatchesProcess(
      { ...record, startTicks: String(BigInt(record.startTicks) + 1n) },
      observed.argv,
    ),
    false,
  );
  assert.equal(supportMatchesProcess(record, [...observed.argv, 'run']), false);
  assert.equal(supportMatchesProcess(record, observed.argv.slice(1)), false);
  assert.equal(supportMatchesProcess({ ...record, pid: 1 }, observed.argv, observed), false);
  assert.equal(supportProcessIdentity(-1), null);
});

function modelFetch(patches = {}, calls = []) {
  const bodies = {
    '/health': { status: 'ok' },
    '/v1/models': { data: [{ id: SUPPORT_MODEL.alias }] },
    '/props': {
      total_slots: 1,
      chat_template: 'embedded pinned template',
      default_generation_settings: { n_ctx: SUPPORT_MODEL.context },
    },
    ...patches,
  };
  return async (url, options) => {
    calls.push({ path: url.pathname, options });
    const value = bodies[url.pathname];
    return value instanceof Response ? value : Response.json(value);
  };
}

test('readiness needs loaded health, exact model alias and bounded single-slot context', async () => {
  const calls = [];
  await attestSupportModel('private-test-key', AbortSignal.timeout(1000), modelFetch({}, calls));
  assert.deepEqual(
    calls.map((item) => item.path),
    ['/health', '/v1/models', '/props'],
  );
  assert.ok(
    calls.every(
      (item) =>
        item.options.headers.Authorization === 'Bearer private-test-key' &&
        item.options.redirect === 'error',
    ),
  );
  for (const patch of [
    { '/health': { status: 'loading model' } },
    { '/health': new Response('{}', { status: 503 }) },
    { '/v1/models': { data: [{ id: 'foreign-model' }] } },
    { '/props': { total_slots: 2, chat_template: 'template' } },
    {
      '/props': {
        total_slots: 1,
        chat_template: 'template',
        default_generation_settings: { n_ctx: 65536 },
      },
    },
    { '/props': Response.json({ chat_template: 'x'.repeat(132000) }) },
  ])
    await assert.rejects(
      attestSupportModel('key', AbortSignal.timeout(1000), modelFetch(patch)),
      /support_model_/u,
    );
});

test('CPU-only profile isolates GPU and caps context, concurrency, threads and output', () => {
  const args = supportModelArgs('/model-root', '/private/key');
  for (const [flag, value] of [
    ['--device', 'none'],
    ['--n-gpu-layers', '0'],
    ['--host', '127.0.0.1'],
    ['--port', '18085'],
    ['--threads', '8'],
    ['--threads-batch', '8'],
    ['--parallel', '1'],
    ['--ctx-size', '4096'],
    ['--n-predict', '384'],
    ['--api-key-file', '/private/key'],
  ])
    assert.equal(args[args.indexOf(flag) + 1], value);
  assert.ok(args.includes('--log-disable'));
  assert.ok(args.includes('--no-context-shift'));
  assert.ok(!args.includes('18084'));
});

test('status and stop are inert for a fresh independent support directory', async (t) => {
  const root = fixture(t),
    gpuRoot = join(root, 'existing-gpu');
  mkdirSync(gpuRoot);
  writeFileSync(join(gpuRoot, 'sentinel'), 'existing GPU state');
  const controller = createSupportController({
    root: join(root, 'support'),
    gpuRoot,
    bin: join(root, 'bin'),
  });
  assert.deepEqual(await controller.status(), { installed: false, running: false, ready: false });
  assert.deepEqual(await controller.stop(), { stopped: true });
  assert.equal(readFileSync(join(gpuRoot, 'sentinel'), 'utf8'), 'existing GPU state');
});

test('stop refuses a live unrelated process even with its correct PID and start ticks in state', async (t) => {
  const root = fixture(t),
    state = join(root, 'service'),
    bundle = join(state, 'bundles', 'a'.repeat(64));
  mkdirSync(bundle, { recursive: true });
  writeFileSync(
    join(state, 'installation.json'),
    JSON.stringify({
      version: 1,
      bundle,
      node: process.execPath,
      manifestSha256: 'b'.repeat(64),
      modelSha256: SUPPORT_MODEL.sha256,
    }),
    { mode: 0o600 },
  );
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  await once(child, 'spawn');
  t.after(async () => {
    child.kill('SIGTERM');
    await once(child, 'close');
  });
  const identity = supportProcessIdentity(child.pid);
  assert.ok(identity);
  const record = {
    pid: child.pid,
    startTicks: identity.startTicks,
    bundle,
    phase: 'ready',
    heartbeatAt: new Date().toISOString(),
  };
  for (const name of ['status.json', 'chat-status.json'])
    writeFileSync(join(state, name), JSON.stringify(record), { mode: 0o600 });
  const controller = createSupportController({ root });
  assert.equal((await controller.status()).running, false);
  assert.equal((await controller.status(true)).running, false);
  await controller.stop();
  await controller.stop(true);
  assert.equal(child.exitCode, null);
  assert.equal(child.signalCode, null);
  assert.equal(supportProcessIdentity(child.pid)?.startTicks, identity.startTicks);
});
