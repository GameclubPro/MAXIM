import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import {
  assertRecoveryFinalizerIdentity,
  RECOVERY_FINALIZER_SPLIT_RUNTIME_SHA,
} from './recovery-finalizer-identity.mjs';

const controllerSha = 'c'.repeat(40);
const repositoryRoot = '/reviewed/maxim';
const cli = resolve(import.meta.dirname, 'recovery-finalizer-identity.mjs');

function fixture(overrides = {}) {
  const state = {
    root: repositoryRoot,
    head: controllerSha,
    status: '',
    changes:
      'infra/scripts/source-abandonment-session-journal.mjs\0' +
      'infra/scripts/recovery-finalizer-identity.mjs\0' +
      'infra/scripts/vps-finalize-release-recovery.sh\0' +
      'docs/operations/runbooks/webhook-source-abandonment.md\0',
    failAt: null,
    calls: [],
  };
  const input = {
    controllerSha,
    runtimeSha: RECOVERY_FINALIZER_SPLIT_RUNTIME_SHA,
    repositoryRoot,
    ...overrides,
  };
  input.run = (command, args, options) => {
    assert.equal(command, 'git');
    assert.deepEqual(args.slice(0, 2), ['--no-optional-locks', '--no-replace-objects']);
    args = args.slice(2);
    state.calls.push(args);
    assert.equal(options.cwd, input.repositoryRoot);
    assert.equal(options.encoding, 'utf8');
    assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe']);
    assert.equal(options.timeout, 30_000);
    assert.equal(options.maxBuffer, 1024 * 1024);
    for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE'])
      assert.equal(Object.hasOwn(options.env, key), false);
    if (args[0] === state.failAt) throw new Error('secret stderr and private path');
    if (args[0] === 'rev-parse')
      return args[1] === '--show-toplevel' ? `${state.root}\n` : `${state.head}\n`;
    if (args[0] === 'status') {
      assert.deepEqual(args, [
        'status',
        '--porcelain=v1',
        '-z',
        '--untracked-files=all',
        '--ignore-submodules=none',
      ]);
      return state.status;
    }
    if (args[0] === 'merge-base') {
      assert.deepEqual(args, [
        'merge-base',
        '--is-ancestor',
        input.runtimeSha,
        input.controllerSha,
      ]);
      return '';
    }
    assert.deepEqual(args, [
      'diff',
      '--no-ext-diff',
      '--no-textconv',
      '--name-only',
      '--no-renames',
      '-z',
      input.runtimeSha,
      input.controllerSha,
      '--',
    ]);
    return state.changes;
  };
  return { input, state, check: () => assertRecoveryFinalizerIdentity(input) };
}

test('a reviewed descendant controller accepts only the fixed a804 runtime and finite tooling paths', () => {
  assert.equal(RECOVERY_FINALIZER_SPLIT_RUNTIME_SHA, 'a8044f45716a64f305b54a88048de1d6960a086c');
  const h = fixture();
  assert.equal(h.check(), true);
  assert.equal(h.input.runtimeSha, RECOVERY_FINALIZER_SPLIT_RUNTIME_SHA);
  assert.equal(h.state.calls.filter((args) => args[0] === 'merge-base').length, 1);
});

test('ordinary same-SHA finalization still permits any clean exact release without split checks', () => {
  const h = fixture({ runtimeSha: controllerSha });
  h.state.failAt = 'merge-base';
  assert.equal(h.check(), true);
  assert.equal(
    h.state.calls.some((args) => ['merge-base', 'diff'].includes(args[0])),
    false,
  );
});

for (const value of [
  'main',
  'a'.repeat(39),
  'A'.repeat(40),
  null,
  123,
  { toString: () => controllerSha },
]) {
  for (const field of ['controllerSha', 'runtimeSha']) {
    test(`rejects noncanonical ${field} ${String(value)} before Git`, () => {
      const h = fixture({ [field]: value });
      assert.throws(h.check, /recovery_finalizer_full_shas_required/u);
      assert.deepEqual(h.state.calls, []);
    });
  }
}

test('a different runtime is refused even when it could be an ancestor', () => {
  const h = fixture({ runtimeSha: 'b'.repeat(40) });
  assert.throws(h.check, /recovery_finalizer_split_runtime_refused/u);
  assert.deepEqual(h.state.calls, []);
});

for (const root of ['relative/path', '', null, '/bad\0root']) {
  test(`rejects invalid repository selection ${JSON.stringify(root)}`, () => {
    const h = fixture({ repositoryRoot: root });
    assert.throws(h.check, /recovery_finalizer_repository_required/u);
    assert.deepEqual(h.state.calls, []);
  });
}

test('another Git root or controller HEAD cannot satisfy the selected checkout', () => {
  const h = fixture();
  h.state.root = '/another/checkout';
  assert.throws(h.check, /recovery_finalizer_repository_changed/u);
  h.state.root = repositoryRoot;
  h.state.head = 'b'.repeat(40);
  assert.throws(h.check, /recovery_finalizer_controller_changed/u);
  assert.equal(
    h.state.calls.some((args) => args[0] === 'merge-base'),
    false,
  );
});

for (const status of [' M tracked\0', 'M  staged\0', '?? untracked\0', ' m submodule\0']) {
  test(`refuses a dirty checkout before proving ancestry: ${JSON.stringify(status)}`, () => {
    const h = fixture();
    h.state.status = status;
    assert.throws(h.check, /recovery_finalizer_dirty_checkout/u);
    assert.equal(
      h.state.calls.some((args) => args[0] === 'merge-base'),
      false,
    );
  });
}

for (const path of [
  'apps/api/src/main.ts',
  'apps/api/Dockerfile',
  'apps/miniapp/src/main.tsx',
  'packages/contracts/src/index.ts',
  'package.json',
  'package-lock.json',
  'config/change-impact.json',
  'infra/docker-compose.yml',
  'infra/scripts/lib/deploy-topology.sh',
  'infra/scripts/lib/legacy-cold-maintenance.sh',
  'infra/scripts/legacy-cold-journal.mjs',
  'infra/scripts/release-manifest.mjs',
  'infra/scripts/another-new-tool.mjs',
  'docs/arbitrary.md',
  'infra/scripts/source-abandonment-session-journal.mjs\ninfra/AGENTS.md',
]) {
  test(`refuses a runtime or unreviewed dependency path: ${JSON.stringify(path)}`, () => {
    const h = fixture();
    h.state.changes = `${path}\0`;
    assert.throws(h.check, /recovery_finalizer_runtime_dependency_changed/u);
  });
}

test('renames cannot hide either a forbidden source or a forbidden destination', () => {
  const h = fixture();
  const allowed = 'infra/scripts/recovery-finalizer-identity.mjs';
  const forbidden = 'apps/api/src/main.ts';
  for (const paths of [
    [allowed, forbidden],
    [forbidden, allowed],
  ]) {
    h.state.changes = `${paths.join('\0')}\0`;
    assert.throws(h.check, /recovery_finalizer_runtime_dependency_changed/u);
  }
});

for (const changes of [
  'infra/AGENTS.md',
  'infra/AGENTS.md\0\0',
  Buffer.from('infra/AGENTS.md\0'),
]) {
  test(`malformed Git output fails closed: ${JSON.stringify(changes)}`, () => {
    const h = fixture();
    h.state.changes = changes;
    assert.throws(h.check, /recovery_finalizer_(runtime_dependency_changed|git_output_refused)/u);
  });
}

for (const command of ['rev-parse', 'status', 'merge-base', 'diff']) {
  test(`failed or timed-out ${command} never forwards private Git diagnostics`, () => {
    const h = fixture();
    h.state.failAt = command;
    assert.throws(h.check, { message: 'recovery_finalizer_git_failed' });
  });
}

test('real Git and CLI preserve same-SHA behavior, ignored env files, and refuse local changes', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'maxim-finalizer-identity-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync('git', args, {
      cwd: directory,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Identity Test',
        GIT_AUTHOR_EMAIL: 'identity-test@example.invalid',
        GIT_COMMITTER_NAME: 'Identity Test',
        GIT_COMMITTER_EMAIL: 'identity-test@example.invalid',
      },
    }).trim();
  git('init', '-q');
  writeFileSync(join(directory, '.gitignore'), '.env\n');
  writeFileSync(join(directory, 'tracked'), 'original\n');
  git('add', '.gitignore', 'tracked');
  git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'identity fixture');
  const sha = git('rev-parse', 'HEAD');
  writeFileSync(join(directory, '.env'), 'private fixture data\n');
  const invoke = (...extra) =>
    spawnSync(process.execPath, [cli, sha, sha, directory, ...extra], { encoding: 'utf8' });
  const accepted = invoke();
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.equal(accepted.stdout, '');
  assert.equal(accepted.stderr, '');
  const badArguments = invoke('extra');
  assert.equal(badArguments.status, 1);
  assert.equal(badArguments.stdout, '');
  assert.equal(badArguments.stderr, 'recovery_finalizer_identity_arguments_refused\n');
  writeFileSync(join(directory, 'private-untracked'), 'sensitive fixture data\n');
  const untracked = invoke();
  assert.equal(untracked.status, 1);
  assert.equal(untracked.stdout, '');
  assert.equal(untracked.stderr, 'recovery_finalizer_dirty_checkout\n');
  rmSync(join(directory, 'private-untracked'));
  writeFileSync(join(directory, 'tracked'), 'changed\n');
  assert.equal(invoke().stderr, 'recovery_finalizer_dirty_checkout\n');
  git('add', 'tracked');
  assert.equal(invoke().stderr, 'recovery_finalizer_dirty_checkout\n');
});
