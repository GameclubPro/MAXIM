import { assertLegacyDispositionSource } from './assert-legacy-disposition-source.mjs';

export const ABORT_RUNTIME_SHA = 'd241e50a8b688bdc32380b20d40c2505413c50f1';
export const ABORT_RUNTIME_IMAGE =
  'sha256:7fd007511ab23b897e87fb015d63dd9b005df2be437f5cf4deb9c1d3022b440b';
const reviewedBase = 'bbdaf91aa8008985c11f35895baca1ff52e7a3ba';
const permitted = new Set([
  'infra/AGENTS.md',
  'docs/operations/runbooks/webhook-source-abandonment.md',
  'infra/scripts/legacy-cold-journal.mjs',
  'infra/scripts/legacy-cold-journal.test.mjs',
  'infra/scripts/legacy-cold-host.mjs',
  'infra/scripts/legacy-cold-host.test.mjs',
  'infra/scripts/legacy-cold-client.mjs',
  'infra/scripts/legacy-cold-client.test.mjs',
  'infra/scripts/source-abandonment-corrective-host.mjs',
  'infra/scripts/source-abandonment-corrective-host.test.mjs',
  'infra/scripts/source-abandonment-abort-identity.mjs',
  'infra/scripts/source-abandonment-abort-identity.test.mjs',
  'infra/scripts/source-abandonment-abort.mjs',
  'infra/scripts/source-abandonment-abort.test.mjs',
  'infra/scripts/source-abandonment-absence.cjs',
  'infra/scripts/source-abandonment-absence.test.mjs',
]);

// FLAG: The reviewed base includes only previously reviewed companion changes.
// This continuation always uses the frozen d241 runtime and only aborts an
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
  // FLAG: Abort restores the pinned captured image and installs no new holds.
  // A newer recovery-content floor is not a rollback requirement for that image.
  // Attest the current controller; the original runtime stays bound by its exact
  // reviewed source SHA, immutable image ID, journal and captured generations.
  assertSource(controllerSha, (path) => run('git', ['show', `${controllerSha}:${path}`]));
  const images = JSON.parse(run('docker', ['image', 'inspect', `maxim-api:${targetSha}`]));
  if (
    images.length !== 1 ||
    images[0].Id !== ABORT_RUNTIME_IMAGE ||
    images[0].Config?.Labels?.['org.opencontainers.image.revision'] !== targetSha
  )
    throw new Error('immutable_abort_runtime_required');
  return { controllerSha, sourceSha: targetSha, imageId: ABORT_RUNTIME_IMAGE };
}
