import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertInheritedDeployLock } from './legacy-cold-journal.mjs';
import { readCurrentManifest, validateCompleteReleaseManifest } from './release-manifest.mjs';
import {
  captureRetirementRuntime,
  executeRetirementCommand,
} from './publisher-obsolete-retirement-host.mjs';
import {
  normalizeCancellationRequest,
  readPrivateCancellationJson,
  selectedTargetCancellationRunner,
} from './publisher-cancel-selected-targets.mjs';

const root = resolve(import.meta.dirname, '../..');

export function captureSelectedCancellationRuntime(
  request,
  services,
  run = executeRetirementCommand,
  manifest = readCurrentManifest('/var/lib/maxim-deploy'),
) {
  validateCompleteReleaseManifest(manifest);
  const api = manifest.components['api-shared'];
  assert.equal(
    api.sourceSha,
    request.expectedRuntimeSha,
    'Active release differs from the request',
  );
  const identity = captureRetirementRuntime(run);
  assert.equal(
    identity.runtimeSha,
    request.expectedRuntimeSha,
    'Image reader differs from the request',
  );
  assert.ok(identity.generations.every((row) => row.imageId === api.imageId));
  assert.equal(services.length, 16);
  assert.equal(new Set(services).size, 16);
  assert.ok(
    ['api-admin', 'api-publisher', 'ocr-native-sandbox', 'photo-native-sandbox'].every((service) =>
      services.includes(service),
    ),
  );
  assert.ok(services.every((service) => /^[a-z-]{3,50}$/u.test(service)));
  const ids = run('docker', [
    'compose',
    '--env-file',
    '.env',
    '-p',
    'infra',
    '-f',
    'infra/docker-compose.yml',
    'ps',
    '--all',
    '-q',
    ...services,
  ]).split(/\s+/u);
  assert.equal(ids.length, services.length, 'Shared image fleet is incomplete');
  assert.ok(ids.every((id) => /^[a-f0-9]{64}$/u.test(id)));
  const rows = JSON.parse(run('docker', ['inspect', ...ids]));
  assert.equal(rows.length, services.length);
  const fleet = rows
    .map((row) => {
      const service = row.Config?.Labels?.['com.docker.compose.service'];
      assert.ok(
        services.includes(service) && row.Config.Labels['com.docker.compose.project'] === 'infra',
      );
      assert.equal(row.Image, api.imageId, 'Mixed shared API images');
      assert.ok(
        row.State?.Running === true &&
          row.State.Status === 'running' &&
          (!row.State.Health || row.State.Health.Status === 'healthy'),
      );
      assert.ok(
        Number.isSafeInteger(row.RestartCount) &&
          row.RestartCount >= 0 &&
          Number.isFinite(Date.parse(row.State.StartedAt)),
      );
      return {
        service,
        id: row.Id,
        imageId: row.Image,
        startedAt: row.State.StartedAt,
        restartCount: row.RestartCount,
      };
    })
    .sort((a, b) => a.service.localeCompare(b.service));
  assert.equal(new Set(fleet.map((row) => row.service)).size, services.length);
  assert.ok(fleet.every((row) => ids.includes(row.id)));
  // FLAG: The reviewed stop marker needs compatible materialization and final-SEND
  // readers. Exact image/manifest and unchanged fleet fence both preview and apply.
  for (const file of [
    'publication-publisher-routing.service.ts',
    'publisher-managed-broadcast-dispatch.ts',
  ]) {
    const source = run('git', ['show', request.expectedRuntimeSha + ':apps/api/src/admin/' + file]);
    assert.ok(source.includes('canceledAt'), 'Target-cancellation reader is missing');
  }
  return { ...identity, releaseId: manifest.releaseId, imageId: api.imageId, fleet };
}

export function parseSelectedCancellationHostArgs(args) {
  const separator = args.indexOf('--');
  assert.ok(separator === 2 || separator === 3);
  const [action, requestPath, previewPath] = args.slice(0, separator);
  assert.ok(['preview', 'apply', 'verify'].includes(action));
  assert.equal(Boolean(previewPath), action !== 'preview');
  return { action, requestPath, previewPath, services: args.slice(separator + 1) };
}

export async function runSelectedCancellationHost(args) {
  assertInheritedDeployLock();
  const request = normalizeCancellationRequest(readPrivateCancellationJson(args.requestPath));
  const saved = args.previewPath ? readPrivateCancellationJson(args.previewPath) : null;
  const sourceDigest = createHash('sha256')
    .update(readFileSync(resolve(root, 'infra/scripts/publisher-cancel-selected-targets.mjs')))
    .digest('hex');
  if (saved)
    assert.equal(saved.sourceDigest, sourceDigest, 'Operator helper changed after preview');
  const before = captureSelectedCancellationRuntime(request, args.services);
  if (saved) assert.deepEqual(saved.binding, before, 'Source or runtime changed after preview');
  const source = selectedTargetCancellationRunner(
    request,
    saved?.preview ?? null,
    args.action === 'verify',
  );
  const publisher = before.generations.find((row) => row.service === 'api-publisher');
  // FLAG: One stdin execution; this starts no Nest worker and never automatically retries
  // an unknown acknowledgement. Retain the same request/preview for bounded readback.
  const result = JSON.parse(
    executeRetirementCommand(
      'docker',
      ['exec', '-i', publisher.id, 'node', '--input-type=module', '-'],
      { input: source, timeout: 45_000, maxBuffer: 256 * 1024 },
    ),
  );
  const after = captureSelectedCancellationRuntime(request, args.services);
  assert.deepEqual(after, before, 'Runtime changed; result needs investigation');
  return args.action === 'preview'
    ? { binding: before, sourceDigest, preview: result }
    : { binding: after, sourceDigest, result };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    console.log(
      JSON.stringify(
        await runSelectedCancellationHost(parseSelectedCancellationHostArgs(process.argv.slice(2))),
      ),
    );
  } catch (error) {
    // FLAG: Container diagnostics contain only allowlisted assertion text. Never relay
    // Docker inspect, environment, connection URLs or raw PostgreSQL exceptions.
    const detail =
      error instanceof assert.AssertionError
        ? error.message.slice(0, 250)
        : typeof error.stderr === 'string' &&
            error.stderr.startsWith('{"code":"selected_target_cancellation_refused"')
          ? error.stderr.slice(0, 1000)
          : 'Host check or command failed; preserve evidence and inspect the committed outcome before retrying';
    console.error(JSON.stringify({ code: 'selected_target_host_refused', detail }));
    process.exitCode = 1;
  }
}
