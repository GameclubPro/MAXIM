import { assertLegacyDispositionSource } from './assert-legacy-disposition-source.mjs';

export const ABORT_RUNTIME_SHA = 'e7e0066ac724726b42c5cba00bfd8f930673b645';
export const ABORT_RUNTIME_IMAGE =
  'sha256:c3e6540fa88d5695fb5c875a2baf7a7b7bf0b6c7c2a6907288f5217755727c45';
const reviewedBase = '8b48a9702de516022bc22a8e195f983dbf116cc9';
const permitted = new Set([
  'infra/AGENTS.md',
  'docs/operations/runbooks/webhook-source-abandonment.md',
  'infra/scripts/legacy-cold-journal.mjs',
  'infra/scripts/legacy-cold-journal.test.mjs',
  'infra/scripts/legacy-cold-host.mjs',
  'infra/scripts/legacy-cold-host.test.mjs',
  'infra/scripts/source-abandonment-abort-identity.mjs',
  'infra/scripts/source-abandonment-abort-identity.test.mjs',
  'infra/scripts/source-abandonment-abort.mjs',
  'infra/scripts/source-abandonment-abort.test.mjs',
]);

// FLAG: The reviewed base includes only previously reviewed companion changes.
// This continuation always uses the frozen e7 runtime and only aborts an
// operation that never reached its writer boundary; no inventory is installed.
export function readSourceAbandonmentAbortIdentity(
  { controllerSha, targetSha, protocol, operation },
  run,
  assertSource = assertLegacyDispositionSource,
) {
  if (
    !/^[0-9a-f]{40}$/u.test(controllerSha ?? '') ||
    controllerSha === targetSha ||
    targetSha !== ABORT_RUNTIME_SHA ||
    protocol !== 'source-abandonment-v1' ||
    operation !== 'abort-before-install'
  )
    throw new Error('abort_context_required');
  if (
    run('git', ['rev-parse', 'HEAD']) !== controllerSha ||
    run('git', ['status', '--porcelain', '--untracked-files=no'])
  )
    throw new Error('clean_exact_controller_source_required');
  run('git', ['merge-base', '--is-ancestor', targetSha, reviewedBase]);
  run('git', ['merge-base', '--is-ancestor', reviewedBase, controllerSha]);
  if (
    run('git', ['diff', '--name-only', '--no-renames', reviewedBase, controllerSha, '--'])
      .split('\n')
      .filter(Boolean)
      .some((path) => !permitted.has(path))
  )
    throw new Error('abort_dependency_changed');
  // FLAG: Both reviewed e7 runtime and descendant controller retain the source
  // floor. Abort installs no holds and restores only the exact captured image.
  for (const sha of [targetSha, controllerSha])
    assertSource(sha, (path) => run('git', ['show', `${sha}:${path}`]));
  const images = JSON.parse(run('docker', ['image', 'inspect', `maxim-api:${targetSha}`]));
  if (
    images.length !== 1 ||
    images[0].Id !== ABORT_RUNTIME_IMAGE ||
    images[0].Config?.Labels?.['org.opencontainers.image.revision'] !== targetSha
  )
    throw new Error('immutable_abort_runtime_required');
  return { controllerSha, sourceSha: targetSha, imageId: ABORT_RUNTIME_IMAGE };
}
