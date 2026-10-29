import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  linkSync,
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
  normalizeCancellationRequest,
  readPrivateCancellationJson,
  selectedTargetCancellationRunner,
  validateCancellationPreview,
} from './publisher-cancel-selected-targets.mjs';
import {
  captureSelectedCancellationRuntime,
  parseSelectedCancellationHostArgs,
} from './publisher-cancel-selected-targets-host.mjs';

const request = {
  version: 1,
  operationId: randomUUID(),
  expectedRuntimeSha: 'a'.repeat(40),
  cutoff: '2026-10-29T06:00:00.000Z',
  reason: 'Explicit test authorization',
  targets: [{ name: 'Group', link: 'https://max.ru/join/' + 'a'.repeat(40) }],
};
const seal = (body) => ({
  ...body,
  digest: createHash('sha256').update(JSON.stringify(body)).digest('hex'),
});
const preview = () =>
  seal({
    version: 1,
    requestHash: createHash('sha256')
      .update(JSON.stringify(normalizeCancellationRequest(request)))
      .digest('hex'),
    publisherBotId: 'publisher',
    observedAt: new Date().toISOString(),
    groups: [{ ...request.targets[0], chatId: '-100', botId: 'publisher', title: 'Group' }],
    plans: [{ publicationId: 'p1', version: 1, targets: [{ id: 't1', chatId: '-100' }] }],
  });

test('scope accepts exact invite links and refuses duplicate, oversized and alternate URLs', () => {
  assert.deepEqual(normalizeCancellationRequest(request), request);
  for (const link of [
    'https://evil.test/join/' + 'a'.repeat(40),
    request.targets[0].link + '?x=1',
    'http://max.ru/join/' + 'a'.repeat(40),
    'https://max.ru/public-slug',
  ])
    assert.throws(() =>
      normalizeCancellationRequest({ ...request, targets: [{ name: 'Group', link }] }),
    );
  assert.throws(() =>
    normalizeCancellationRequest({ ...request, targets: [request.targets[0], request.targets[0]] }),
  );
  assert.throws(() =>
    normalizeCancellationRequest({ ...request, targets: Array(15).fill(request.targets[0]) }),
  );
  assert.throws(() => normalizeCancellationRequest({ ...request, operationId: '-'.repeat(36) }));
});

test('preview integrity, request binding, expiry and recipient scope reject before any database call', () => {
  const original = preview();
  assert.deepEqual(validateCancellationPreview(request, original, 'publisher'), request);
  const altered = structuredClone(original);
  altered.plans[0].targets[0].chatId = '-200';
  assert.throws(
    () => validateCancellationPreview(request, altered, 'publisher'),
    /digest changed/u,
  );
  const body = structuredClone(altered);
  delete body.digest;
  assert.throws(() => validateCancellationPreview(request, seal(body), 'publisher'));
  assert.throws(
    () =>
      validateCancellationPreview({ ...request, operationId: randomUUID() }, original, 'publisher'),
    /different request/u,
  );
  assert.throws(() => validateCancellationPreview(request, original, 'another-bot'));
  const old = structuredClone(original);
  delete old.digest;
  old.observedAt = new Date(Date.now() - 16 * 60_000).toISOString();
  assert.throws(() => validateCancellationPreview(request, seal(old), 'publisher'), /expired/u);
  assert.deepEqual(
    validateCancellationPreview(request, seal(old), 'publisher', { allowExpired: true }),
    request,
  );
  old.plans.push({ ...old.plans[0], publicationId: 'p2' });
  assert.throws(() =>
    validateCancellationPreview(request, seal(old), 'publisher', { allowExpired: true }),
  );
});

test('operator files refuse symlinks, hardlinks and broad permissions', () => {
  const directory = mkdtempSync(join(tmpdir(), 'selected-target-input-'));
  try {
    const file = join(directory, 'request.json');
    writeFileSync(file, JSON.stringify(request), { mode: 0o600 });
    assert.deepEqual(readPrivateCancellationJson(file), request);
    symlinkSync(file, join(directory, 'symlink'));
    assert.throws(() => readPrivateCancellationJson(join(directory, 'symlink')));
    chmodSync(file, 0o644);
    assert.throws(() => readPrivateCancellationJson(file));
    chmodSync(file, 0o600);
    linkSync(file, join(directory, 'hardlink'));
    assert.throws(() => readPrivateCancellationJson(file));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('container runner serializes hostile text as data, with no shell interpolation', () => {
  const hostile = { ...request, reason: '`$(echo unsafe)`\n"; throw new Error("unsafe") //' };
  const runner = selectedTargetCancellationRunner(hostile);
  assert.ok(
    runner.includes('await runCancellationContainer(' + JSON.stringify(hostile) + ',null,false)'),
  );
});

test('host modes require the matching preview and receive topology separately', () => {
  assert.equal(
    parseSelectedCancellationHostArgs(['preview', '/request', '--', 'api-publisher']).action,
    'preview',
  );
  assert.equal(
    parseSelectedCancellationHostArgs(['verify', '/request', '/preview', '--', 'api-publisher'])
      .previewPath,
    '/preview',
  );
  for (const args of [
    ['apply', '/request', '--'],
    ['preview', '/request', '/preview', '--'],
    ['unknown', '/request', '--'],
  ])
    assert.throws(() => parseSelectedCancellationHostArgs(args));
});

test('host fences the manifest, immutable image, complete fleet and reader source', (t) => {
  const topology = readFileSync(new URL('./lib/deploy-topology.sh', import.meta.url), 'utf8');
  const roles = [
    ...topology.match(/MAXIM_PRODUCTION_API_SERVICES=\(([\s\S]*?)\)/u)[1].matchAll(/"([a-z-]+)"/gu),
  ].map((m) => m[1]);
  const services = [...roles, 'ocr-native-sandbox', 'photo-native-sandbox'];
  const toolingSha = 'c'.repeat(40),
    image = 'sha256:' + 'd'.repeat(64);
  const old = process.env.MAXIM_EXPECTED_DEPLOY_SHA;
  process.env.MAXIM_EXPECTED_DEPLOY_SHA = toolingSha;
  t.after(() => {
    if (old === undefined) delete process.env.MAXIM_EXPECTED_DEPLOY_SHA;
    else process.env.MAXIM_EXPECTED_DEPLOY_SHA = old;
  });
  const manifest = {
    schemaVersion: 1,
    releaseId: 'fixture',
    targetSha: request.expectedRuntimeSha,
    components: Object.fromEntries(
      ['api-shared', 'miniapp-major-static', 'admin-static'].map((id) => [
        id,
        { sourceSha: request.expectedRuntimeSha, imageId: image, imageRef: 'fixture:' + id },
      ]),
    ),
  };
  const rows = services.map((service, index) => ({
    Id: index.toString(16).padStart(64, '0'),
    Image: image,
    RestartCount: 0,
    State: { Running: true, Status: 'running', StartedAt: '2026-10-29T05:00:00Z' },
    Config: {
      Labels: { 'com.docker.compose.service': service, 'com.docker.compose.project': 'infra' },
      Env: [
        `APP_ROLE=${service === 'api-admin' ? 'admin' : 'publisher'}`,
        'MAX_PUBLISHER_BOT_ID=publisher',
        `MAX_BOT_ID=${service === 'api-admin' ? 'major' : 'publisher'}`,
      ],
    },
  }));
  let reader = 'canceledAt';
  const run = (command, args) => {
    if (command === 'git')
      return args[0] === 'rev-parse' ? toolingSha : args[0] === 'show' ? reader : '';
    assert.equal(command, 'docker');
    if (args[0] === 'compose')
      return args.includes('--all')
        ? rows.map((row) => row.Id).join('\n')
        : rows.find((row) => row.Config.Labels['com.docker.compose.service'] === args.at(-1)).Id;
    if (args[0] === 'image')
      return JSON.stringify([
        {
          Id: image,
          Config: { Labels: { 'org.opencontainers.image.revision': request.expectedRuntimeSha } },
        },
      ]);
    if (args[0] === 'exec') return '{"live":true,"ready":true}';
    assert.equal(args[0], 'inspect');
    return JSON.stringify(rows.filter((row) => args.includes(row.Id)));
  };
  assert.equal(
    captureSelectedCancellationRuntime(request, services, run, manifest).fleet.length,
    16,
  );
  assert.throws(
    () =>
      captureSelectedCancellationRuntime(
        { ...request, expectedRuntimeSha: 'b'.repeat(40) },
        services,
        run,
        manifest,
      ),
    /release differs/u,
  );
  rows[5].Image = 'sha256:' + 'e'.repeat(64);
  assert.throws(
    () => captureSelectedCancellationRuntime(request, services, run, manifest),
    /Mixed shared/u,
  );
  rows[5].Image = image;
  rows[5].State.Running = false;
  assert.throws(() => captureSelectedCancellationRuntime(request, services, run, manifest));
  rows[5].State.Running = true;
  reader = 'incompatible';
  assert.throws(
    () => captureSelectedCancellationRuntime(request, services, run, manifest),
    /reader is missing/u,
  );
});
