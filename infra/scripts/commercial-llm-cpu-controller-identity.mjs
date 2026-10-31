import { execFileSync } from 'node:child_process';
import { isAbsolute, resolve } from 'node:path';
import { assertCpuRecoveryJournal } from './commercial-llm-cpu-recovery.mjs';

export const COMMERCIAL_LLM_CPU_ORIGINAL_CONTROLLER_SHA =
  '895cc0cbe10bae80a3379348fc98a355699d20d2';

const fullSha = /^[0-9a-f]{40}$/u;
const continuationPhases = new Set(['starting_dispatcher', 'dispatcher_ready', 'complete']);
const permittedControllerChanges = new Set([
  'infra/scripts/commercial-llm-runtime.mjs',
  'infra/scripts/commercial-llm-cpu-host.test.mjs',
  'infra/scripts/commercial-llm-cpu-controller-identity.mjs',
  'infra/scripts/commercial-llm-cpu-controller-identity.test.mjs',
  'docs/operations/runbooks/commercial-ai-pool.md',
]);

function requireFact(value, code) {
  if (!value) throw new Error(`commercial_llm_cpu_controller_${code}`);
}

// FLAG: Only the reviewed 895cc journal tail may use a corrected descendant controller.
// Its original plan/digest and all core, lease, model and runtime protocols stay unchanged.
// This identity check neither establishes CI nor permits another stop or lease release.
export function assertCommercialLlmCpuControllerIdentity({
  controllerSha,
  journal,
  repositoryRoot,
  run = execFileSync,
}) {
  requireFact(typeof controllerSha === 'string' && fullSha.test(controllerSha), 'sha_required');
  requireFact(
    typeof repositoryRoot === 'string' &&
      isAbsolute(repositoryRoot) &&
      !repositoryRoot.includes('\0') &&
      typeof run === 'function',
    'repository_required',
  );
  if (journal !== undefined) assertCpuRecoveryJournal(journal);
  const planSourceSha = journal?.plan.sourceSha ?? controllerSha;
  const continuation = planSourceSha !== controllerSha;
  if (continuation) {
    requireFact(
      planSourceSha === COMMERCIAL_LLM_CPU_ORIGINAL_CONTROLLER_SHA &&
        continuationPhases.has(journal.phase),
      'continuation_refused',
    );
  }

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
      throw new Error('commercial_llm_cpu_controller_git_failed');
    }
    requireFact(typeof output === 'string', 'git_output_refused');
    return output;
  };
  requireFact(
    resolve(git(['rev-parse', '--show-toplevel']).trim()) === resolve(repositoryRoot),
    'repository_changed',
  );
  requireFact(
    git(['rev-parse', '--verify', 'HEAD^{commit}']).trim() === controllerSha,
    'head_changed',
  );
  requireFact(
    git(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none']) ===
      '',
    'dirty_checkout',
  );
  if (!continuation) return planSourceSha;

  git(['merge-base', '--is-ancestor', planSourceSha, controllerSha]);
  const changes = git([
    'diff',
    '--no-ext-diff',
    '--no-textconv',
    '--name-only',
    '--no-renames',
    '-z',
    planSourceSha,
    controllerSha,
    '--',
  ]);
  requireFact(
    changes === '' ||
      (changes.endsWith('\0') &&
        changes
          .slice(0, -1)
          .split('\0')
          .every((path) => permittedControllerChanges.has(path))),
    'dependency_changed',
  );
  return planSourceSha;
}
