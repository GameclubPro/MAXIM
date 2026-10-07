import { assertLegacyDispositionSource } from './assert-legacy-disposition-source.mjs';

export const CORRECTIVE_RUNTIME_SHA = '9f06dff5d32d6f1bd61ee8fa92f103b043475452';
export const CORRECTIVE_RUNTIME_IMAGE =
  'sha256:39fd36dfc4cd49dd30bceb7cfaf0bd2ad068b96392762afc4c9fe413191dd306';
const source = /^[0-9a-f]{40}$/u;
const permittedControllerChanges = new Set([
  'infra/AGENTS.md',
  'infra/scripts/legacy-cold-host.mjs',
  'infra/scripts/legacy-cold-store-adapter.mjs',
  'infra/scripts/legacy-cold-store-adapter.test.mjs',
  'infra/scripts/legacy-cold-journal.mjs',
  'infra/scripts/legacy-cold-journal.test.mjs',
  'infra/scripts/source-abandonment-refreeze.mjs',
  'infra/scripts/source-abandonment-refreeze.test.mjs',
  'infra/scripts/source-abandonment-corrective-host.mjs',
  'infra/scripts/source-abandonment-corrective-host.test.mjs',
  'infra/scripts/source-abandonment-corrective-identity.mjs',
  'infra/scripts/source-abandonment-corrective-identity.test.mjs',
  'infra/scripts/source-abandonment-corrective-wrapper.test.mjs',
  'infra/scripts/vps-source-abandonment-corrective.sh',
  'infra/scripts/vps-connect.sh',
  'docs/operations/runbooks/webhook-source-abandonment.md',
  // Reviewed companion runtime changes may share the corrective source commit.
  // The disposable client and captured fleet still use only the frozen old image.
  'apps/api/src/scripts/source-abandonment-live-redis.ts',
  'apps/api/src/scripts/source-abandonment-redis.native.spec.ts',
  'apps/api/src/moderation/moderation.service.legacy.ts',
  'apps/api/src/moderation/webhook-execution-diagnostic.ts',
  'apps/api/src/moderation/webhook-execution-diagnostic.spec.ts',
]);

// FLAG: A corrected controller has its own exact source identity. It may only
// continue this already admitted runtime; the original image, journal, queue
// fence, writer and complete runtime dependency tree remain independently bound.
export function readSourceAbandonmentCorrectiveIdentity(
  { controllerSha, targetSha, protocol, operation },
  run,
  assertSource = assertLegacyDispositionSource,
) {
  if (
    !source.test(controllerSha ?? '') ||
    controllerSha === targetSha ||
    targetSha !== CORRECTIVE_RUNTIME_SHA ||
    protocol !== 'source-abandonment-v1' ||
    !['apply', 'reconcile', 'retry-preview', 'refreeze-preview'].includes(operation)
  )
    throw new Error('corrective_context_required');
  if (
    run('git', ['rev-parse', 'HEAD']) !== controllerSha ||
    run('git', ['status', '--porcelain', '--untracked-files=no'])
  )
    throw new Error('clean_exact_controller_source_required');
  run('git', ['merge-base', '--is-ancestor', targetSha, controllerSha]);
  const paths = run('git', ['diff', '--name-only', '--no-renames', targetSha, controllerSha, '--']);
  if (
    paths
      .split('\n')
      .filter(Boolean)
      .some((path) => !permittedControllerChanges.has(path))
  )
    throw new Error('corrective_dependency_changed');
  for (const sha of [targetSha, controllerSha])
    assertSource(sha, (path) => run('git', ['show', `${sha}:${path}`]));
  const images = JSON.parse(run('docker', ['image', 'inspect', `maxim-api:${targetSha}`]));
  if (
    !Array.isArray(images) ||
    images.length !== 1 ||
    images[0].Id !== CORRECTIVE_RUNTIME_IMAGE ||
    images[0].Config?.Labels?.['org.opencontainers.image.revision'] !== targetSha
  )
    throw new Error('immutable_corrective_runtime_image_required');
  return {
    controllerSha,
    sourceSha: targetSha,
    imageId: CORRECTIVE_RUNTIME_IMAGE,
  };
}
