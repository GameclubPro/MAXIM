import { execFileSync } from 'node:child_process';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const RECOVERY_FINALIZER_SPLIT_RUNTIME_SHA = 'a8044f45716a64f305b54a88048de1d6960a086c';

const fullSha = /^[0-9a-f]{40}$/u;
const permittedControllerChanges = new Set([
  'docs/operations/runbooks/webhook-source-abandonment.md',
  'infra/AGENTS.md',
  'infra/scripts/legacy-cold-client.mjs',
  'infra/scripts/legacy-cold-client.test.mjs',
  'infra/scripts/source-abandonment-session-cli.mjs',
  'infra/scripts/source-abandonment-session-cli.test.mjs',
  'infra/scripts/source-abandonment-session-host.mjs',
  'infra/scripts/source-abandonment-session-host.test.mjs',
  'infra/scripts/source-abandonment-session-inventory.mjs',
  'infra/scripts/source-abandonment-session-inventory.test.mjs',
  'infra/scripts/source-abandonment-session-journal.mjs',
  'infra/scripts/source-abandonment-session-journal.test.mjs',
  'infra/scripts/webhook-frozen-ordered-anchor-inventory-postgres.test.mjs',
  'infra/scripts/webhook-frozen-ordered-anchor-inventory-reader.mjs',
  'infra/scripts/webhook-frozen-ordered-anchor-inventory.mjs',
  'infra/scripts/webhook-frozen-ordered-anchor-inventory.test.mjs',
  'infra/scripts/recovery-finalizer-identity.mjs',
  'infra/scripts/recovery-finalizer-identity.test.mjs',
  'infra/scripts/recovery-finalizer-guards.test.mjs',
  'infra/scripts/vps-finalize-release-recovery.sh',
  'infra/scripts/vps-connect.sh',
]);

function requireFact(value, code) {
  if (!value) throw new Error(code);
}

// FLAG: A newer host reader may finalize only this reviewed unchanged runtime.
// Image identity, CI, terminal journals and strict smokes remain separate checks;
// this allowance never changes an image revision or a recorded runtime source.
export function assertRecoveryFinalizerIdentity({
  controllerSha,
  runtimeSha,
  repositoryRoot,
  run = execFileSync,
}) {
  requireFact(
    typeof controllerSha === 'string' &&
      fullSha.test(controllerSha) &&
      typeof runtimeSha === 'string' &&
      fullSha.test(runtimeSha),
    'recovery_finalizer_full_shas_required',
  );
  requireFact(
    typeof repositoryRoot === 'string' &&
      isAbsolute(repositoryRoot) &&
      !repositoryRoot.includes('\0') &&
      typeof run === 'function',
    'recovery_finalizer_repository_required',
  );
  requireFact(
    controllerSha === runtimeSha || runtimeSha === RECOVERY_FINALIZER_SPLIT_RUNTIME_SHA,
    'recovery_finalizer_split_runtime_refused',
  );
  const gitEnvironment = { ...process.env };
  for (const key of [
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_COMMON_DIR',
    'GIT_INDEX_FILE',
    'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  ])
    delete gitEnvironment[key];
  const git = (args) => {
    let output;
    try {
      output = run('git', ['--no-optional-locks', '--no-replace-objects', ...args], {
        cwd: repositoryRoot,
        env: gitEnvironment,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
      });
    } catch {
      throw new Error('recovery_finalizer_git_failed');
    }
    requireFact(typeof output === 'string', 'recovery_finalizer_git_output_refused');
    return output;
  };
  requireFact(
    resolve(git(['rev-parse', '--show-toplevel']).trim()) === resolve(repositoryRoot),
    'recovery_finalizer_repository_changed',
  );
  requireFact(
    git(['rev-parse', '--verify', 'HEAD^{commit}']).trim() === controllerSha,
    'recovery_finalizer_controller_changed',
  );
  requireFact(
    git(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none']) ===
      '',
    'recovery_finalizer_dirty_checkout',
  );
  if (controllerSha === runtimeSha) return true;
  git(['merge-base', '--is-ancestor', runtimeSha, controllerSha]);
  const changed = git([
    'diff',
    '--no-ext-diff',
    '--no-textconv',
    '--name-only',
    '--no-renames',
    '-z',
    runtimeSha,
    controllerSha,
    '--',
  ]);
  requireFact(
    changed === '' ||
      (changed.endsWith('\0') &&
        changed
          .slice(0, -1)
          .split('\0')
          .every((path) => permittedControllerChanges.has(path))),
    'recovery_finalizer_runtime_dependency_changed',
  );
  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    requireFact(process.argv.length === 5, 'recovery_finalizer_identity_arguments_refused');
    assertRecoveryFinalizerIdentity({
      controllerSha: process.argv[2],
      runtimeSha: process.argv[3],
      repositoryRoot: process.argv[4],
    });
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
