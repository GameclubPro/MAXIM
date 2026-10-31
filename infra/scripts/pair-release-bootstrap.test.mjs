import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';

function fixture(
  t,
  {
    runtime = false,
    detachedKaravan = false,
    compatibilityFiles = [],
    majorToolingFiles = [],
    publisherChange = null,
  } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), 'pair-bootstrap-test-'));
  const stage = `/tmp/major-karavan-admission.${randomBytes(4).toString('hex')}`;
  const major = join(directory, 'major');
  const karavan = join(directory, 'karavan');
  const state = join(directory, 'maxim-state');
  const admission = join(directory, 'admission');
  const bin = join(directory, 'bin');
  mkdirSync(stage, { mode: 0o700 });
  mkdirSync(state);
  mkdirSync(bin);
  t.after(() => {
    rmSync(directory, { recursive: true, force: true });
    rmSync(stage, { recursive: true, force: true });
  });
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture',
    GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    PATH: `${bin}:${process.env.PATH}`,
  };
  for (const key of Object.keys(env))
    if (key.startsWith('PAIR_RELEASE_') || key.startsWith('MAXIM_DEPLOY_LOCK_')) delete env[key];
  const git = (root, ...args) =>
    execFileSync('git', ['-C', root, ...args], {
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  const relocate = (source) =>
    source
      .replaceAll('/var/www/Chat_bot', major)
      .replaceAll('/var/www/max-delivery-platform', karavan)
      .replaceAll('/var/lib/maxim-deploy', state)
      .replaceAll('/var/lib/major-karavan-release', admission)
      .replace(
        "pair_release_admission_root_uid() { printf '%s\\n' 0; }",
        `pair_release_admission_root_uid() { printf '%s\\n' ${process.getuid()}; }`,
      );
  const helper = relocate(
    readFileSync(new URL('./lib/pair-release-admission.sh', import.meta.url), 'utf8'),
  );
  const reporter = relocate(
    readFileSync(new URL('./pair-release-state.mjs', import.meta.url), 'utf8'),
  );
  const result = {};
  for (const name of ['major', 'karavan']) {
    const source = join(directory, `${name}-source`);
    const root = name === 'major' ? major : karavan;
    mkdirSync(join(source, 'infra/scripts/lib'), { recursive: true });
    writeFileSync(join(source, '.gitignore'), '.env\n.env.karavan\nvar/\n');
    writeFileSync(
      join(source, 'infra/scripts/lib/deploy-lock.sh'),
      'require_market_statistics_lock_dispatch() { :; }\n',
    );
    if (name === 'major' && publisherChange) {
      writeFileSync(
        join(source, 'infra/scripts/vps-publisher-dispatch-rollout.sh'),
        "#!/usr/bin/env bash\n      command=start-rollup\nprintf '%s\\n' preserved\n",
      );
    }
    git(source, 'init', '-b', 'main');
    git(source, 'add', '.');
    git(source, 'commit', '-m', 'old');
    const before = git(source, 'rev-parse', 'HEAD');
    execFileSync('git', ['clone', source, root], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const helperPath =
      name === 'major'
        ? 'infra/scripts/lib/pair-release-admission.sh'
        : 'infra/scripts/pair-release-admission.sh';
    writeFileSync(join(source, helperPath), helper);
    writeFileSync(join(source, 'infra/scripts/pair-release-state.mjs'), reporter);
    if (name === 'major') {
      for (const file of majorToolingFiles) {
        mkdirSync(dirname(join(source, file)), { recursive: true });
        writeFileSync(join(source, file), 'reviewed CI tooling fixture\n');
      }
      if (publisherChange) {
        const file = join(source, 'infra/scripts/vps-publisher-dispatch-rollout.sh');
        writeFileSync(
          file,
          readFileSync(file, 'utf8').replace('command=start-rollup', "command='start-rollup'") +
            (publisherChange === 'runtime' ? 'echo unexpected-runtime-change\n' : ''),
        );
        writeFileSync(
          join(source, 'infra/scripts/check-infra.sh'),
          '#!/usr/bin/env bash\nexit 0\n',
        );
      }
      writeFileSync(
        join(source, 'infra/scripts/lib/deploy-lock.sh'),
        relocate(readFileSync(new URL('./lib/deploy-lock.sh', import.meta.url), 'utf8')),
      );
      for (const file of ['vps-connect.sh', 'vps-pull-build-up.sh', 'vps-runtime-rollback.sh'])
        writeFileSync(
          join(source, 'infra/scripts', file),
          readFileSync(new URL(`./${file}`, import.meta.url), 'utf8'),
        );
    } else
      writeFileSync(
        join(source, 'infra/scripts/karavan-operation-lock.sh'),
        'pair_release_admission_acquire karavan\npair_release_admission_assert\n',
      );
    if (runtime && name === 'karavan') {
      mkdirSync(join(source, 'apps'));
      writeFileSync(join(source, 'apps/runtime.js'), 'process.exit(0)\n');
    }
    if (name === 'karavan')
      for (const file of compatibilityFiles) {
        mkdirSync(dirname(join(source, file)), { recursive: true });
        writeFileSync(
          join(source, file),
          JSON.stringify({ version: 1, sourceBundle: 'reviewed tooling closure' }),
        );
      }
    git(source, 'add', '.');
    git(source, 'commit', '-m', 'reviewed tooling');
    const target = git(source, 'rev-parse', 'HEAD');
    git(source, 'bundle', 'create', join(stage, `${name}.bundle`), 'refs/heads/main', `^${before}`);
    result[name] = { root, before, target };
  }
  if (detachedKaravan) git(karavan, 'switch', '--detach', result.karavan.before);
  mkdirSync(join(karavan, 'var/ops'), { recursive: true });
  const majorLock = join(state, 'deploy.lock');
  const karavanLock = join(karavan, 'var/ops/karavan-production-operation.lock');
  for (const lock of [majorLock, karavanLock]) writeFileSync(lock, '', { mode: 0o600 });
  // Only privilege dispatch and process discovery are adapted. Real Git, files, both
  // product flocks, helper verification and protected installation execute unchanged.
  writeFileSync(
    join(bin, 'runuser'),
    '#!/usr/bin/env bash\n[[ "$1" == -u && "$3" == -- ]] || exit 97\nshift 3\nexec "$@"\n',
  );
  writeFileSync(
    join(bin, 'install'),
    '#!/usr/bin/env bash\nargs=()\nwhile (( $# )); do case "$1" in -o|-g) shift 2;; *) args+=("$1"); shift;; esac; done\nexec /usr/bin/install "${args[@]}"\n',
  );
  writeFileSync(join(bin, 'pgrep'), '#!/usr/bin/env bash\nexit 1\n');
  for (const file of ['runuser', 'install', 'pgrep']) chmodSync(join(bin, file), 0o755);
  const installer = relocate(
    readFileSync(new URL('./install-pair-release-admission.sh', import.meta.url), 'utf8'),
  ).replace('[[ "$EUID" == 0 ]]', `[[ "$EUID" == ${process.getuid()} ]]`);
  const run = () =>
    spawnSync(
      'bash',
      [
        '-s',
        '--',
        'install',
        userInfo().username,
        result.major.target,
        result.karavan.target,
        stage,
      ],
      { env, input: installer, encoding: 'utf8', timeout: 10_000 },
    );
  return { directory, stage, admission, majorLock, karavanLock, git, result, run, env };
}

test('initial bootstrap imports exact thin bundles and advances source under both existing inodes', (t) => {
  const f = fixture(t);
  const before = [statSync(f.majorLock).ino, statSync(f.karavanLock).ino];
  const installed = f.run();
  assert.equal(installed.status, 0, `${installed.stdout}\n${installed.stderr}`);
  assert.equal(f.git(f.result.major.root, 'rev-parse', 'HEAD'), f.result.major.target);
  assert.equal(f.git(f.result.karavan.root, 'rev-parse', 'HEAD'), f.result.karavan.target);
  assert.equal(
    readFileSync(join(f.admission, 'protocol-v1'), 'utf8'),
    'major-karavan-release-v1\n',
  );
  assert.deepEqual([statSync(f.majorLock).ino, statSync(f.karavanLock).ino], before);
  const pairInode = statSync(join(f.admission, 'state/admission.lock')).ino;
  const repeated = f.run();
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.equal(statSync(join(f.admission, 'state/admission.lock')).ino, pairInode);
});

test(
  'a busy existing product lock prevents any bootstrap source advance or authority creation',
  { timeout: 10_000 },
  async (t) => {
    const f = fixture(t);
    const holder = spawn(
      'flock',
      ['-n', f.majorLock, 'bash', '-c', 'printf "held\\n"; read -r _'],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const done = once(holder, 'close');
    t.after(async () => {
      holder.stdin.end();
      await done;
    });
    await once(holder.stdout, 'data');
    const refused = f.run();
    assert.equal(refused.status, 75, refused.stderr);
    assert.equal(f.git(f.result.major.root, 'rev-parse', 'HEAD'), f.result.major.before);
    assert.equal(f.git(f.result.karavan.root, 'rev-parse', 'HEAD'), f.result.karavan.before);
    assert.equal(existsSync(f.admission), false);
  },
);

test('dirty production source remains intact and does not create admission', (t) => {
  const f = fixture(t);
  const file = join(f.result.karavan.root, 'infra/scripts/lib/deploy-lock.sh');
  writeFileSync(file, 'preserved user edit\n');
  const refused = f.run();
  assert.notEqual(refused.status, 0);
  assert.equal(readFileSync(file, 'utf8'), 'preserved user edit\n');
  assert.equal(f.git(f.result.major.root, 'rev-parse', 'HEAD'), f.result.major.before);
  assert.equal(existsSync(f.admission), false);
});

test('bootstrap refuses application source changes before advancing either checkout', (t) => {
  const f = fixture(t, { runtime: true });
  const refused = f.run();
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /application changes require normal release/u);
  assert.equal(f.git(f.result.major.root, 'rev-parse', 'HEAD'), f.result.major.before);
  assert.equal(f.git(f.result.karavan.root, 'rev-parse', 'HEAD'), f.result.karavan.before);
  assert.equal(existsSync(f.admission), false);
});

test('bootstrap admits tooling lint and only exact behavior-neutral Publisher literal quoting', (t) => {
  const f = fixture(t, { publisherChange: 'quote' });
  const installed = f.run();
  assert.equal(installed.status, 0, `${installed.stdout}\n${installed.stderr}`);
  assert.equal(f.git(f.result.major.root, 'rev-parse', 'HEAD'), f.result.major.target);
});

test('bootstrap rejects an adjacent Publisher runtime change before advancing either source', (t) => {
  const f = fixture(t, { publisherChange: 'runtime' });
  const refused = f.run();
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /only the reviewed Publisher command literal quoting/u);
  assert.equal(f.git(f.result.major.root, 'rev-parse', 'HEAD'), f.result.major.before);
  assert.equal(f.git(f.result.karavan.root, 'rev-parse', 'HEAD'), f.result.karavan.before);
  assert.equal(existsSync(f.admission), false);
});

test('operator transport-stage symlinks cannot redirect privileged derived source', (t) => {
  const f = fixture(t);
  const canary = join(f.directory, 'root-owned-canary');
  writeFileSync(canary, 'preserved trusted bytes\n');
  symlinkSync(canary, join(f.stage, 'major-admission.sh'));
  const installed = f.run();
  assert.equal(installed.status, 0, installed.stderr);
  assert.equal(readFileSync(canary, 'utf8'), 'preserved trusted bytes\n');
  assert.equal(
    readFileSync(join(f.admission, 'admission.sh'), 'utf8').includes(
      'pair_release_admission_acquire()',
    ),
    true,
  );
});

test('clean detached Karavan release source advances without moving or creating a branch', (t) => {
  const f = fixture(t, { detachedKaravan: true });
  const karavanMain = f.git(f.result.karavan.root, 'rev-parse', 'refs/heads/main');
  const installed = f.run();
  assert.equal(installed.status, 0, installed.stderr);
  assert.equal(f.git(f.result.karavan.root, 'rev-parse', 'HEAD'), f.result.karavan.target);
  assert.equal(f.git(f.result.karavan.root, 'branch', '--show-current'), '');
  assert.equal(f.git(f.result.karavan.root, 'rev-parse', 'refs/heads/main'), karavanMain);
  assert.equal(f.git(f.result.major.root, 'branch', '--show-current'), 'main');
});

test('a named Karavan feature branch remains intact and refuses bootstrap', (t) => {
  const f = fixture(t);
  f.git(f.result.karavan.root, 'switch', '-c', 'preserve-feature');
  const refused = f.run();
  assert.notEqual(refused.status, 0);
  assert.equal(f.git(f.result.karavan.root, 'branch', '--show-current'), 'preserve-feature');
  assert.equal(f.git(f.result.karavan.root, 'rev-parse', 'HEAD'), f.result.karavan.before);
  assert.equal(f.git(f.result.major.root, 'rev-parse', 'HEAD'), f.result.major.before);
});

test('interrupted second-source advancement keeps a durable fence until exact bootstrap resume', (t) => {
  const f = fixture(t);
  const gitShim = join(f.directory, 'bin/git');
  writeFileSync(
    gitShim,
    `#!/usr/bin/env bash\nif [[ "$1" == -C && "$2" == '${f.result.karavan.root}' && " $* " == *" merge --ff-only "* ]]; then exit 71; fi\nexec /usr/bin/git "$@"\n`,
  );
  chmodSync(gitShim, 0o755);
  const interrupted = f.run();
  assert.equal(interrupted.status, 71, interrupted.stderr);
  assert.equal(f.git(f.result.major.root, 'rev-parse', 'HEAD'), f.result.major.target);
  assert.equal(f.git(f.result.karavan.root, 'rev-parse', 'HEAD'), f.result.karavan.before);
  const ownerFile = join(f.admission, 'state/admission.owner');
  const record = readFileSync(ownerFile, 'utf8');
  assert.match(record, /^mode=bootstrap$/mu);
  const inode = statSync(join(f.admission, 'state/admission.lock')).ino;
  const helper = join(f.admission, 'admission.sh');
  const verify = spawnSync('bash', [helper, 'verify'], { env: f.env, encoding: 'utf8' });
  assert.equal(verify.status, 70, verify.stderr);
  const nextRelease = spawnSync(
    'bash',
    ['-c', 'source "$1"; pair_release_admission_acquire major', 'fixture', helper],
    { env: f.env, encoding: 'utf8' },
  );
  assert.equal(nextRelease.status, 70, nextRelease.stderr);
  const token = /^token=(.+)$/mu.exec(record)[1];
  const reentry = spawnSync(
    'bash',
    ['-c', 'source "$1"; pair_release_admission_assert "$2"', 'fixture', helper, token],
    { env: f.env, encoding: 'utf8' },
  );
  assert.equal(reentry.status, 70, reentry.stderr);
  const selected = f.result.karavan.target;
  f.result.karavan.target = f.result.karavan.before;
  assert.equal(f.run().status, 70);
  assert.equal(readFileSync(ownerFile, 'utf8'), record);
  f.result.karavan.target = selected;
  rmSync(gitShim);
  const resumed = f.run();
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal(f.git(f.result.major.root, 'rev-parse', 'HEAD'), f.result.major.target);
  assert.equal(f.git(f.result.karavan.root, 'rev-parse', 'HEAD'), selected);
  assert.equal(existsSync(ownerFile), false);
  assert.equal(statSync(join(f.admission, 'state/admission.lock')).ino, inode);
  assert.equal(spawnSync('bash', [helper, 'verify'], { env: f.env }).status, 0);
  const admitted = spawnSync(
    'bash',
    [
      '-c',
      'source "$1"; pair_release_admission_acquire major; pair_release_admission_release',
      'fixture',
      helper,
    ],
    { env: f.env, encoding: 'utf8' },
  );
  assert.equal(admitted.status, 0, admitted.stderr);
});

test('bootstrap permits the two exact existing Karavan compatibility floor records', (t) => {
  const f = fixture(t, {
    compatibilityFiles: [
      'infra/compatibility/karavan-store-profile-catalog-coverage-v1.json',
      'infra/compatibility/karavan-transport-service-request-flow-v1.json',
    ],
  });
  const installed = f.run();
  assert.equal(installed.status, 0, installed.stderr);
  assert.equal(f.git(f.result.karavan.root, 'rev-parse', 'HEAD'), f.result.karavan.target);
});

test('bootstrap refuses an unlisted compatibility JSON before advancing source', (t) => {
  const f = fixture(t, { compatibilityFiles: ['infra/compatibility/unrelated.json'] });
  const refused = f.run();
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /application changes require normal release/u);
  assert.equal(f.git(f.result.major.root, 'rev-parse', 'HEAD'), f.result.major.before);
  assert.equal(f.git(f.result.karavan.root, 'rev-parse', 'HEAD'), f.result.karavan.before);
});

test('bootstrap permits the exact CI workflow and its coverage guard', (t) => {
  const f = fixture(t, {
    majorToolingFiles: ['.github/workflows/ci.yml', 'scripts/ci/static-coverage.test.mjs'],
  });
  const installed = f.run();
  assert.equal(installed.status, 0, installed.stderr);
  assert.equal(f.git(f.result.major.root, 'rev-parse', 'HEAD'), f.result.major.target);
});

test('bootstrap still refuses other workflows and CI executables before source advance', (t) => {
  for (const file of ['.github/workflows/unreviewed.yml', 'scripts/ci/impact.mjs']) {
    const f = fixture(t, { majorToolingFiles: [file] });
    const refused = f.run();
    assert.notEqual(refused.status, 0, file);
    assert.match(refused.stderr, /application changes require normal release/u);
    assert.equal(f.git(f.result.major.root, 'rev-parse', 'HEAD'), f.result.major.before);
    assert.equal(f.git(f.result.karavan.root, 'rev-parse', 'HEAD'), f.result.karavan.before);
    assert.equal(existsSync(f.admission), false);
  }
});
