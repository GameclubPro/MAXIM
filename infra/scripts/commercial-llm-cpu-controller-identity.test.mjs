import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import {
  assertCommercialLlmCpuControllerIdentity,
  COMMERCIAL_LLM_CPU_ORIGINAL_CONTROLLER_SHA,
} from './commercial-llm-cpu-controller-identity.mjs';
import {
  cpuRecoveryPlanSha256,
  recoverCommercialLlmCpuQuarantine,
} from './commercial-llm-cpu-recovery.mjs';

const controllerSha = 'c'.repeat(40);
const repositoryRoot = '/reviewed/maxim';
const oldSha = '895cc0cbe10bae80a3379348fc98a355699d20d2';
const allowedPaths = [
  'infra/scripts/commercial-llm-runtime.mjs',
  'infra/scripts/commercial-llm-cpu-host.test.mjs',
  'infra/scripts/commercial-llm-cpu-controller-identity.mjs',
  'infra/scripts/commercial-llm-cpu-controller-identity.test.mjs',
  'docs/operations/runbooks/commercial-ai-pool.md',
];
const phases = [
  'prepared',
  'stopping_dispatcher',
  'dispatcher_stopped',
  'stopping_model',
  'model_stopped',
  'releasing_lease',
  'lease_released',
  'starting_model',
  'model_ready',
  'starting_dispatcher',
  'dispatcher_ready',
  'complete',
];

function journal(sourceSha = oldSha, phase = 'starting_dispatcher') {
  const generation = (id, startedAt = '2026-10-31T06:42:33.976867079Z') => ({
    id: id.repeat(64),
    imageId: `sha256:${'a'.repeat(64)}`,
    startedAt,
    restartCount: 0,
  });
  const plan = {
    schemaVersion: 1,
    kind: 'commercial-llm-cpu-quarantine-recovery-v1',
    sourceSha,
    operationId: 'c61d3d02-07ff-4a10-b077-1b910b6e859e',
    model: generation('b'),
    dispatcher: generation('d'),
    leaseFingerprint: 'e'.repeat(64),
  };
  const at = phases.indexOf(phase);
  return {
    schemaVersion: 1,
    kind: plan.kind,
    plan,
    planSha256: cpuRecoveryPlanSha256(plan),
    phase,
    modelRestart:
      at >= phases.indexOf('model_ready')
        ? generation('b', '2026-10-31T08:35:10.000000001Z')
        : null,
    dispatcherRestart:
      at >= phases.indexOf('dispatcher_ready')
        ? generation('d', '2026-10-31T08:35:40.725000001Z')
        : null,
  };
}

function fixture(overrides = {}) {
  const input = { controllerSha, journal: journal(), repositoryRoot, ...overrides };
  const state = {
    root: repositoryRoot,
    head: controllerSha,
    status: '',
    changes: `${allowedPaths.join('\0')}\0`,
    failAt: null,
    calls: [],
  };
  input.run = (command, allArgs, options) => {
    assert.equal(command, 'git');
    assert.deepEqual(allArgs.slice(0, 2), ['--no-optional-locks', '--no-replace-objects']);
    const args = allArgs.slice(2);
    state.calls.push(args);
    assert.equal(options.cwd, input.repositoryRoot);
    assert.equal(options.timeout, 30_000);
    assert.equal(options.maxBuffer, 1024 * 1024);
    assert.equal(options.encoding, 'utf8');
    assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe']);
    for (const key of [
      'GIT_DIR',
      'GIT_WORK_TREE',
      'GIT_COMMON_DIR',
      'GIT_INDEX_FILE',
      'GIT_OBJECT_DIRECTORY',
      'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    ])
      assert.equal(Object.hasOwn(options.env, key), false);
    if (args[0] === state.failAt) throw new Error('private Git diagnostic');
    if (args[0] === 'rev-parse')
      return `${args[1] === '--show-toplevel' ? state.root : state.head}\n`;
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
      assert.deepEqual(args, ['merge-base', '--is-ancestor', oldSha, input.controllerSha]);
      return '';
    }
    assert.deepEqual(args, [
      'diff',
      '--no-ext-diff',
      '--no-textconv',
      '--name-only',
      '--no-renames',
      '-z',
      oldSha,
      input.controllerSha,
      '--',
    ]);
    return state.changes;
  };
  return { input, state, check: () => assertCommercialLlmCpuControllerIdentity(input) };
}

test('only the fixed original controller admits its unchanged late journal under a descendant', () => {
  assert.equal(COMMERCIAL_LLM_CPU_ORIGINAL_CONTROLLER_SHA, oldSha);
  for (const phase of ['starting_dispatcher', 'dispatcher_ready', 'complete']) {
    const h = fixture({ journal: journal(oldSha, phase) });
    const before = structuredClone(h.input.journal);
    assert.equal(h.check(), oldSha);
    assert.deepEqual(h.input.journal, before);
    assert.equal(h.state.calls.filter((args) => args[0] === 'merge-base').length, 1);
  }
});

test('fresh and same-source operations retain the current source without compatibility checks', () => {
  for (const value of [undefined, ...phases.map((phase) => journal(controllerSha, phase))]) {
    const h = fixture({ journal: value });
    h.state.failAt = 'merge-base';
    assert.equal(h.check(), controllerSha);
    assert.equal(
      h.state.calls.some((args) => ['merge-base', 'diff'].includes(args[0])),
      false,
    );
  }
});

for (const phase of phases.slice(0, phases.indexOf('starting_dispatcher'))) {
  test(`an old-source ${phase} cannot enter the corrective continuation`, () => {
    const h = fixture({ journal: journal(oldSha, phase) });
    assert.throws(h.check, /commercial_llm_cpu_controller_continuation_refused/u);
    assert.deepEqual(h.state.calls, []);
  });
}

test('an unrelated old source cannot acquire the continuation exception', () => {
  const h = fixture({ journal: journal('b'.repeat(40)) });
  assert.throws(h.check, /commercial_llm_cpu_controller_continuation_refused/u);
  assert.deepEqual(h.state.calls, []);
});

for (const mutate of [
  (value) => {
    value.phase = 'unknown';
  },
  (value) => {
    value.schemaVersion = 2;
  },
  (value) => {
    value.extra = true;
  },
  (value) => {
    value.planSha256 = '0'.repeat(64);
  },
  (value) => {
    value.plan.operationId = '../other';
  },
  (value) => {
    value.plan.leaseFingerprint = '0'.repeat(64);
  },
  (value) => {
    value.modelRestart.id = 'f'.repeat(64);
  },
  (value) => {
    value.modelRestart.startedAt = value.plan.model.startedAt;
  },
  (value) => {
    value.dispatcherRestart = structuredClone(value.plan.dispatcher);
  },
]) {
  test(`the core journal boundary rejects malformed continuation: ${mutate}`, () => {
    const value = journal();
    mutate(value);
    const h = fixture({ journal: value });
    assert.throws(h.check, /commercial_llm_cpu_recovery_/u);
    assert.deepEqual(h.state.calls, []);
  });
}

test('null is not an absent journal', () => {
  const h = fixture({ journal: null });
  assert.throws(h.check, /commercial_llm_cpu_recovery_journal_invalid/u);
  assert.deepEqual(h.state.calls, []);
});

for (const value of ['main', '', 'A'.repeat(40), 'a'.repeat(39), null, 123, {}]) {
  test(`noncanonical controller source is rejected before Git: ${JSON.stringify(value)}`, () => {
    const h = fixture({ controllerSha: value });
    assert.throws(h.check, /commercial_llm_cpu_controller_sha_required/u);
    assert.deepEqual(h.state.calls, []);
  });
}

for (const root of ['relative/path', '', null, '/bad\0root']) {
  test(`invalid repository selection is rejected: ${JSON.stringify(root)}`, () => {
    const h = fixture({ repositoryRoot: root });
    assert.throws(h.check, /commercial_llm_cpu_controller_repository_required/u);
    assert.deepEqual(h.state.calls, []);
  });
}

test('another repository root or HEAD cannot establish controller identity', () => {
  const h = fixture();
  h.state.root = '/other/checkout';
  assert.throws(h.check, /commercial_llm_cpu_controller_repository_changed/u);
  h.state.root = repositoryRoot;
  h.state.head = 'b'.repeat(40);
  assert.throws(h.check, /commercial_llm_cpu_controller_head_changed/u);
  assert.equal(
    h.state.calls.some((args) => args[0] === 'merge-base'),
    false,
  );
});

for (const status of [' M tracked\0', 'M  staged\0', '?? untracked\0', ' m submodule\0']) {
  test(`a dirty checkout cannot continue: ${JSON.stringify(status)}`, () => {
    const h = fixture();
    h.state.status = status;
    assert.throws(h.check, /commercial_llm_cpu_controller_dirty_checkout/u);
    assert.equal(
      h.state.calls.some((args) => args[0] === 'merge-base'),
      false,
    );
  });
}

test('each reviewed correction path is admitted', () => {
  for (const path of allowedPaths) {
    const h = fixture();
    h.state.changes = `${path}\0`;
    assert.equal(h.check(), oldSha);
  }
});

for (const path of [
  'infra/scripts/commercial-llm-cpu-recovery.mjs',
  'infra/scripts/commercial-llm-cpu-lease.cjs',
  'infra/scripts/commercial-llm-cpu-recovery.test.mjs',
  'infra/scripts/commercial-llm-profile.mjs',
  'apps/api/src/moderation/commercial/commercial-llm-pool.protocol.ts',
  'apps/api/src/main.ts',
  'apps/api/Dockerfile',
  'packages/contracts/src/index.ts',
  'infra/docker-compose.yml',
  'infra/scripts/lib/deploy-lock.sh',
  'infra/scripts/release-manifest.mjs',
  'infra/scripts/vps-connect.sh',
  'package.json',
  'package-lock.json',
  'docs/arbitrary.md',
  'infra/scripts/commercial-llm-runtime.mjs\napps/api/src/main.ts',
]) {
  test(`runtime, protocol and unreviewed dependencies are refused: ${JSON.stringify(path)}`, () => {
    const h = fixture();
    h.state.changes = `${path}\0`;
    assert.throws(h.check, /commercial_llm_cpu_controller_dependency_changed/u);
  });
}

test('renames cannot conceal a forbidden source or destination', () => {
  for (const paths of [
    [allowedPaths[0], 'infra/scripts/commercial-llm-cpu-recovery.mjs'],
    ['infra/scripts/commercial-llm-cpu-lease.cjs', allowedPaths[0]],
  ]) {
    const h = fixture();
    h.state.changes = `${paths.join('\0')}\0`;
    assert.throws(h.check, /commercial_llm_cpu_controller_dependency_changed/u);
  }
});

for (const value of [
  allowedPaths[0],
  `${allowedPaths[0]}\0\0`,
  Buffer.from(`${allowedPaths[0]}\0`),
]) {
  test(`malformed Git output fails closed: ${JSON.stringify(value)}`, () => {
    const h = fixture();
    h.state.changes = value;
    assert.throws(
      h.check,
      /commercial_llm_cpu_controller_(dependency_changed|git_output_refused)/u,
    );
  });
}

for (const command of ['rev-parse', 'status', 'merge-base', 'diff']) {
  test(`failed or timed-out ${command} hides private diagnostics`, () => {
    const h = fixture();
    h.state.failAt = command;
    assert.throws(h.check, { message: 'commercial_llm_cpu_controller_git_failed' });
  });
}

test('Git environment overrides cannot redirect identity checks', () => {
  const keys = [
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_COMMON_DIR',
    'GIT_INDEX_FILE',
    'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  ];
  const before = keys.map((key) => [key, process.env[key]]);
  try {
    for (const key of keys) process.env[key] = '/unreviewed/git-state';
    assert.equal(fixture().check(), oldSha);
  } finally {
    for (const [key, value] of before) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

function realRepository(t) {
  const directory = mkdtempSync(join(tmpdir(), 'maxim-cpu-controller-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const environment = {
    ...process.env,
    GIT_AUTHOR_NAME: 'CPU Controller Test',
    GIT_AUTHOR_EMAIL: 'cpu-controller@example.invalid',
    GIT_COMMITTER_NAME: 'CPU Controller Test',
    GIT_COMMITTER_EMAIL: 'cpu-controller@example.invalid',
  };
  const git = (...args) =>
    execFileSync('git', args, {
      cwd: directory,
      env: environment,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    }).trim();
  git('init', '-q');
  writeFileSync(join(directory, '.gitignore'), '.env\n');
  for (const path of [
    ...allowedPaths,
    'infra/scripts/commercial-llm-cpu-recovery.mjs',
    'apps/api/src/moderation/commercial/commercial-llm-pool.protocol.ts',
  ]) {
    mkdirSync(dirname(join(directory, path)), { recursive: true });
    writeFileSync(join(directory, path), '// synthetic fixture\n');
  }
  git('add', '.');
  git(
    '-c',
    'commit.gpgsign=false',
    '-c',
    'core.hooksPath=/dev/null',
    'commit',
    '-qm',
    'base fixture',
  );
  const base = git('rev-parse', 'HEAD');
  const commit = (path, text = '\n// controller identity fixture\n') => {
    appendFileSync(join(directory, path), text);
    git('add', '--', path);
    git('-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'fixture');
    return git('rev-parse', 'HEAD');
  };
  const check = (sha, ...values) =>
    assertCommercialLlmCpuControllerIdentity({
      controllerSha: sha,
      journal: values.length ? values[0] : journal(),
      repositoryRoot: directory,
      // The production base cannot be synthesized, and CI may have only one fetched commit.
      // Only translate that object identity; ancestry, status and diffs execute real Git.
      run: (command, args, options) =>
        execFileSync(
          command,
          args.map((value) => (value === oldSha ? base : value)),
          options,
        ),
    });
  return { directory, git, commit, check };
}

test('real Git admits an exact clean descendant and preserves the original journal', (t) => {
  const h = realRepository(t);
  const sha = h.commit(allowedPaths[0]);
  writeFileSync(join(h.directory, '.env'), 'ignored synthetic fixture\n');
  const value = journal();
  const before = structuredClone(value);
  assert.equal(h.check(sha, value), oldSha);
  assert.deepEqual(value, before);
  assert.equal(h.check(sha, undefined), sha);
  assert.equal(h.check(sha, journal(sha, 'prepared')), sha);
  writeFileSync(join(h.directory, 'untracked-fixture'), 'synthetic fixture\n');
  assert.throws(() => h.check(sha), /commercial_llm_cpu_controller_dirty_checkout/u);
  rmSync(join(h.directory, 'untracked-fixture'));
  appendFileSync(join(h.directory, allowedPaths[0]), '\n// unstaged fixture\n');
  assert.throws(() => h.check(sha), /commercial_llm_cpu_controller_dirty_checkout/u);
  h.git('add', '--', allowedPaths[0]);
  assert.throws(() => h.check(sha), /commercial_llm_cpu_controller_dirty_checkout/u);
});

for (const path of [
  'infra/scripts/commercial-llm-cpu-recovery.mjs',
  'apps/api/src/moderation/commercial/commercial-llm-pool.protocol.ts',
]) {
  test(`real Git refuses a descendant changing protected runtime/protocol: ${path}`, (t) => {
    const h = realRepository(t);
    const sha = h.commit(path);
    assert.throws(() => h.check(sha), /commercial_llm_cpu_controller_dependency_changed/u);
  });
}

test('real Git refuses a clean unrelated controller even with an allowed tree', (t) => {
  const h = realRepository(t);
  const tree = h.git('rev-parse', 'HEAD^{tree}');
  const unrelated = h.git(
    '-c',
    'commit.gpgsign=false',
    'commit-tree',
    tree,
    '-m',
    'unrelated fixture',
  );
  h.git('checkout', '-q', '--detach', unrelated);
  assert.throws(() => h.check(unrelated), /commercial_llm_cpu_controller_git_failed/u);
});

for (const phase of ['starting_dispatcher', 'dispatcher_ready', 'complete']) {
  test(`the admitted ${phase} tail completes without stopping, starting or releasing again`, async () => {
    const h = fixture({ journal: journal(oldSha, phase) });
    let current = structuredClone(h.input.journal);
    const originalPlan = structuredClone(current.plan);
    const originalDigest = current.planSha256;
    const model = { ...current.modelRestart, running: true };
    const dispatcher = {
      ...(current.dispatcherRestart ?? journal(oldSha, 'dispatcher_ready').dispatcherRestart),
      running: true,
    };
    const writes = [];
    const forbidden = async () =>
      assert.fail('a tail continuation attempted a process or lease mutation');
    const result = await recoverCommercialLlmCpuQuarantine({
      sourceSha: h.check(),
      operationId: originalPlan.operationId,
      expectedPlanSha256: originalDigest,
      apply: true,
      io: {
        readJournal: async () => structuredClone(current),
        writeJournal: async (value) => {
          assert.deepEqual(value.plan, originalPlan);
          assert.equal(value.planSha256, originalDigest);
          writes.push(value.phase);
          current = structuredClone(value);
        },
        snapshot: async () => ({ model: { ...model }, dispatcher: { ...dispatcher } }),
        waitDispatcherReady: async (value) => {
          assert.deepEqual(value, {
            id: dispatcher.id,
            imageId: dispatcher.imageId,
            startedAt: dispatcher.startedAt,
            restartCount: dispatcher.restartCount,
          });
        },
        leaseStatus: forbidden,
        releaseLease: forbidden,
        stopModel: forbidden,
        stopDispatcher: forbidden,
        startModel: forbidden,
        startDispatcher: forbidden,
        waitModelReady: forbidden,
      },
    });
    assert.equal(result.sourceSha, oldSha);
    assert.equal(result.operationId, originalPlan.operationId);
    assert.equal(result.planSha256, originalDigest);
    assert.equal(current.phase, 'complete');
    assert.deepEqual(
      writes,
      phase === 'complete'
        ? []
        : phase === 'dispatcher_ready'
          ? ['complete']
          : ['dispatcher_ready', 'complete'],
    );
  });
}
