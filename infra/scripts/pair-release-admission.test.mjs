import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  statSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { pairReleaseFixture } from './test-fixtures/pair-release.mjs';
import { deployLockEnvironment } from './test-fixtures/deploy-lock.mjs';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'major-karavan-admission-'));
  const data = pairReleaseFixture(directory, join(directory, 'pair-release-admission.sh'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { directory, ...data };
}

function run(data, script, env = {}, args = []) {
  return spawnSync(
    'bash',
    ['-c', `set -euo pipefail\nsource "$1"\n${script}`, 'fixture', data.helper, ...args],
    { env: deployLockEnvironment(env), encoding: 'utf8', timeout: 5_000 },
  );
}

function actor(t, data, script, env = {}) {
  const child = spawn(
    'bash',
    ['-c', `set -euo pipefail\nsource "$1"\n${script}`, 'fixture', data.helper],
    { env: deployLockEnvironment(env), stdio: ['pipe', 'pipe', 'pipe'], detached: true },
  );
  const lines = [];
  const waiters = [];
  let stderr = '';
  child.stderr.on('data', (value) => {
    stderr += value;
  });
  createInterface({ input: child.stdout }).on('line', (line) => {
    lines.push(line);
    for (const waiter of [...waiters])
      if (waiter.test(line)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(line);
      }
  });
  const done = once(child, 'close').then(([code, signal]) => ({ code, signal, stderr }));
  child.on('close', () => {
    for (const waiter of waiters) waiter.reject(new Error(stderr));
  });
  t.after(async () => {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
    await done;
  });
  return {
    child,
    done,
    gate: () => child.stdin.write('continue\n'),
    marker: (value) => {
      const predicate = typeof value === 'function' ? value : (line) => line === value;
      const previous = lines.find(predicate);
      return previous === undefined
        ? new Promise((resolve, reject) => waiters.push({ test: predicate, resolve, reject }))
        : Promise.resolve(previous);
    },
  };
}

test(
  'Major and Karavan share one persistent admission inode and verified nested owner',
  { timeout: 10_000 },
  async (t) => {
    const data = fixture(t);
    const owner = actor(
      t,
      data,
      'pair_release_admission_acquire major\nprintf "HELD\\n"\nread -r _\nbash -c \'source "$1"; pair_release_admission_acquire karavan; pair_release_admission_assert; pair_release_admission_release\' fixture "$1"\npair_release_admission_assert\nprintf "NESTED\\n"\nread -r _\npair_release_admission_release',
    );
    await owner.marker('HELD');
    const inode = statSync(data.file).ino;
    assert.equal(run(data, 'pair_release_admission_acquire karavan').status, 75);
    owner.gate();
    await owner.marker('NESTED');
    assert.equal(run(data, 'pair_release_admission_acquire major').status, 75);
    owner.gate();
    assert.equal((await owner.done).code, 0);
    assert.equal(
      run(
        data,
        'pair_release_admission_acquire karavan; pair_release_admission_assert; pair_release_admission_release',
      ).status,
      0,
    );
    assert.equal(statSync(data.file).ino, inode);
  },
);

test(
  'a lost holder or mismatched process start refuses the next mutation',
  { timeout: 10_000 },
  async (t) => {
    const data = fixture(t);
    const owner = actor(
      t,
      data,
      'pair_release_admission_acquire major\nprintf "HELD\\n"\nread -r _',
    );
    await owner.marker('HELD');
    const file = join(data.state, 'admission.owner');
    const record = readFileSync(file, 'utf8');
    const token = /^token=(.+)$/mu.exec(record)[1];
    writeFileSync(file, record.replace(/^start=.+$/mu, 'start=0'), { mode: 0o600 });
    assert.equal(
      run(data, 'pair_release_admission_assert "$2"; touch "$3"', {}, [
        token,
        join(data.directory, 'forbidden'),
      ]).status,
      70,
    );
    writeFileSync(file, record, { mode: 0o600 });
    process.kill(-owner.child.pid, 'SIGKILL');
    await owner.done;
    assert.equal(run(data, 'pair_release_admission_assert "$2"', {}, [token]).status, 70);
    assert.equal(
      run(data, 'pair_release_admission_acquire karavan; pair_release_admission_release').status,
      70,
    );
    assert.equal(readFileSync(file, 'utf8'), record);
    assert.equal(
      JSON.parse(run(data, 'pair_release_admission_state').stdout).admission.status,
      'unknown',
    );
  },
);

test('a changed planned fingerprint is refused before product admission', (t) => {
  const data = fixture(t);
  const current = run(data, 'pair_release_admission_state --fingerprint').stdout.trim();
  writeFileSync(join(data.majorRoot, '.env'), 'PRIVATE_TEST_TOKEN=never-print-this-value\n');
  const stale = run(
    data,
    'pair_release_admission_acquire major; touch "$2"',
    { PAIR_RELEASE_EXPECTED_STATE_SHA256: current },
    [join(data.directory, 'forbidden')],
  );
  assert.equal(stale.status, 70);
  assert.match(stale.stderr, /state changed/u);
  const output = run(data, 'pair_release_admission_state');
  assert.equal(output.status, 0, output.stderr);
  assert.equal(output.stdout.includes('never-print-this-value'), false);
  assert.notEqual(JSON.parse(output.stdout).fingerprint, current);
  assert.equal(
    run(data, 'pair_release_admission_acquire karavan; pair_release_admission_release').status,
    0,
  );
});

test('source/config mutation after a nested operation retains the original admission proof', async (t) => {
  const data = fixture(t);
  const current = run(data, 'pair_release_admission_state --fingerprint').stdout.trim();
  const result = run(
    data,
    'pair_release_admission_acquire major; printf "changed\\n" >"$2"; bash -c \'source "$1"; pair_release_admission_acquire major; pair_release_admission_assert\' fixture "$1"; pair_release_admission_release',
    { PAIR_RELEASE_EXPECTED_STATE_SHA256: current },
    [join(data.majorRoot, '.env')],
  );
  assert.equal(result.status, 0, result.stderr);
});

test('fixed admission rejects missing provisioning and symlinked authority', (t) => {
  const data = fixture(t);
  const marker = join(data.protectedDirectory, 'protocol-v1');
  unlinkSync(marker);
  symlinkSync(data.file, marker);
  assert.equal(run(data, 'pair_release_admission_acquire major').status, 70);
  assert.equal(statSync(data.file).ino > 0, true);
});

test('state projection keeps Major component sources and Karavan smoke distinct', (t) => {
  const data = fixture(t);
  writeFileSync(
    join(data.majorRoot, 'current.json'),
    JSON.stringify({
      targetSha: 'a'.repeat(40),
      components: {
        'api-shared': { sourceSha: 'b'.repeat(40), imageId: `sha256:${'c'.repeat(64)}` },
        'miniapp-major-static': { sourceSha: 'a'.repeat(40), imageId: `sha256:${'d'.repeat(64)}` },
      },
    }),
  );
  writeFileSync(
    join(data.karavanRoot, 'var/ops/karavan-release-current.json'),
    JSON.stringify({
      git: { commit: 'e'.repeat(40) },
      origin: { commit: 'f'.repeat(40) },
      deliveryMode: 'origin',
      smoke: { status: 'passed', completedAt: '2026-10-31T01:00:00.000Z' },
    }),
  );
  const result = run(data, 'pair_release_admission_state');
  assert.equal(result.status, 0, result.stderr);
  const state = JSON.parse(result.stdout);
  assert.equal(state.major.targetSha, 'a'.repeat(40));
  assert.equal(state.major.components[0].sourceSha, 'b'.repeat(40));
  assert.equal(state.karavan.commit, 'e'.repeat(40));
  assert.equal(state.karavan.originCommit, 'f'.repeat(40));
  assert.equal(state.karavan.smoke.status, 'passed');
});

test(
  'simultaneous fresh Major and Karavan requests admit exactly one owner',
  { timeout: 10_000 },
  async (t) => {
    const data = fixture(t);
    const script = (product) =>
      `printf 'READY\\n'; read -r _; if pair_release_admission_acquire ${product}; then printf 'RESULT 0\\n'; read -r _; pair_release_admission_release; else result=$?; printf 'RESULT %s\\n' "$result"; fi`;
    const major = actor(t, data, script('major'));
    const karavan = actor(t, data, script('karavan'));
    await Promise.all([major.marker('READY'), karavan.marker('READY')]);
    major.gate();
    karavan.gate();
    const results = await Promise.all([
      major.marker((line) => line.startsWith('RESULT ')),
      karavan.marker((line) => line.startsWith('RESULT ')),
    ]);
    assert.deepEqual([...results].sort(), ['RESULT 0', 'RESULT 75']);
    (results[0] === 'RESULT 0' ? major : karavan).gate();
    assert.deepEqual(
      (await Promise.all([major.done, karavan.done])).map((value) => value.code),
      [0, 0],
    );
  },
);

test('invalid calendar timestamps remain missing observations', (t) => {
  const data = fixture(t);
  writeFileSync(
    join(data.majorRoot, 'current.json'),
    JSON.stringify({ createdAt: '2026-02-30T01:00:00.000Z' }),
  );
  writeFileSync(
    join(data.karavanRoot, 'var/ops/karavan-release-current.json'),
    JSON.stringify({ smoke: { completedAt: '2026-13-01T01:00:00.000Z' } }),
  );
  const result = run(data, 'pair_release_admission_state');
  assert.equal(result.status, 0, result.stderr);
  const current = JSON.parse(result.stdout);
  assert.equal(current.major.createdAt, null);
  assert.equal(current.karavan.smoke.completedAt, null);
});

function checkout(root) {
  for (const args of [
    ['init', '-b', 'main'],
    [
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '--allow-empty',
      '-m',
      'fixture',
    ],
  ]) {
    const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
  return spawnSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
}

function rootRunner(t) {
  if (process.getuid() === 0) {
    t.skip('Cross-UID coverage needs an ordinary operator test process.');
    return null;
  }
  const clear = ['env', '-u', 'SUDO_UID', '-u', 'SUDO_GID', '-u', 'SUDO_USER'];
  const candidates = [['sudo', '-n', ...clear]];
  if (process.env.WSL_DISTRO_NAME) {
    candidates.push([
      '/mnt/c/WINDOWS/system32/wsl.exe',
      '--distribution',
      process.env.WSL_DISTRO_NAME,
      '--user',
      'root',
      '--exec',
      ...clear,
    ]);
  }
  for (const [executable, ...prefix] of candidates) {
    const probe = spawnSync(
      executable,
      [...prefix, process.execPath, '-e', 'process.exit(process.getuid() === 0 ? 0 : 1)'],
      {
        encoding: 'utf8',
        timeout: 10_000,
      },
    );
    if (probe.status === 0) {
      return (args) =>
        spawnSync(executable, [...prefix, ...args], {
          encoding: 'utf8',
          timeout: 15_000,
        });
    }
  }
  t.skip('Cross-UID coverage requires passwordless root execution.');
  return null;
}

test('root maintenance publishes operator-owned admission and releases the original inode', (t) => {
  const elevated = rootRunner(t);
  if (!elevated) return;
  const data = fixture(t);
  const inode = statSync(data.file).ino;
  const result = elevated([
    '/bin/bash',
    '-c',
    `set -euo pipefail
source "$1"
pair_release_admission_acquire major
stat -c '%u:%a:%h' "$2/admission.owner"
bash -c 'source "$1"; pair_release_admission_acquire major; pair_release_admission_assert' fixture "$1"
pair_release_admission_assert
pair_release_admission_release`,
    'fixture',
    data.helper,
    data.state,
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), `${process.getuid()}:600:1`);
  assert.equal(existsSync(join(data.state, 'admission.owner')), false);
  assert.equal(statSync(data.file).ino, inode);
  assert.equal(
    run(data, 'pair_release_admission_acquire karavan; pair_release_admission_release').status,
    0,
  );
});

test('root maintenance observes exact operator-owned Git sources without SUDO_UID', (t) => {
  const elevated = rootRunner(t);
  if (!elevated) return;
  const data = fixture(t);
  const major = checkout(data.majorRoot);
  const karavan = checkout(data.karavanRoot);
  const result = elevated([process.execPath, data.reporter]);
  assert.equal(result.status, 0, result.stderr);
  const observed = JSON.parse(result.stdout);
  assert.equal(observed.major.checkoutSha, major);
  assert.equal(observed.karavan.checkoutSha, karavan);
  assert.equal(
    observed.fingerprint,
    JSON.parse(run(data, 'pair_release_admission_state').stdout).fingerprint,
  );
});

function state(data) {
  const result = run(data, 'pair_release_admission_state');
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

async function interruptedOwner(t, data, product, mode, target) {
  const owner = actor(
    t,
    data,
    `pair_release_admission_acquire ${product} '' ${mode} ${target}; printf 'HELD\\n'; read -r _`,
  );
  await owner.marker('HELD');
  process.kill(-owner.child.pid, 'SIGKILL');
  await owner.done;
  return state(data);
}

function reconcile(data, observed, product, target, mode, components = '', overrides = {}) {
  return run(data, 'pair_release_admission_reconcile "$2" "$3" "$4" "$5" "$6" "$7"', {}, [
    overrides.ownerSha256 ?? observed.admission.ownerSha256,
    overrides.fingerprint ?? observed.fingerprint,
    product,
    target,
    mode,
    components,
  ]);
}

test(
  'tooling recovery binds the owner digest, pair fingerprint, selected mode and exact checkout',
  { timeout: 10_000 },
  async (t) => {
    const data = fixture(t);
    const target = checkout(data.majorRoot);
    const observed = await interruptedOwner(t, data, 'major', 'tooling', target);
    const original = readFileSync(join(data.state, 'admission.owner'), 'utf8');
    const inode = statSync(data.file).ino;
    assert.equal(reconcile(data, observed, 'major', target, 'runtime').status, 70);
    assert.equal(reconcile(data, observed, 'major', 'a'.repeat(40), 'tooling').status, 70);
    assert.equal(
      reconcile(data, observed, 'major', target, 'tooling', '', { ownerSha256: 'a'.repeat(64) })
        .status,
      70,
    );
    assert.equal(
      reconcile(data, observed, 'major', target, 'tooling', '', { fingerprint: 'a'.repeat(64) })
        .status,
      70,
    );
    assert.equal(readFileSync(join(data.state, 'admission.owner'), 'utf8'), original);
    const recovered = reconcile(data, observed, 'major', target, 'tooling');
    assert.equal(recovered.status, 0, recovered.stderr);
    const proof = JSON.parse(recovered.stdout);
    assert.equal(proof.ownerSha256, observed.admission.ownerSha256);
    assert.equal(proof.targetSha, target);
    assert.equal(
      readFileSync(join(data.state, 'reconciled', `${proof.ownerSha256}.owner`), 'utf8'),
      original,
    );
    assert.deepEqual(
      JSON.parse(
        readFileSync(join(data.state, 'reconciled', `${proof.ownerSha256}.proof.json`), 'utf8'),
      ),
      proof,
    );
    assert.equal(existsSync(join(data.state, 'admission.owner')), false);
    assert.equal(statSync(data.file).ino, inode);
    assert.equal(
      run(data, 'pair_release_admission_acquire karavan; pair_release_admission_release').status,
      0,
    );
  },
);

test(
  'a live original PID cannot be recovered after changing cwd or closing its descriptor',
  { timeout: 10_000 },
  async (t) => {
    const data = fixture(t);
    const target = checkout(data.majorRoot);
    const owner = actor(
      t,
      data,
      `pair_release_admission_acquire major '' tooling ${target}; exec {PAIR_RELEASE_ADMISSION_FD}>&-; cd "$TEST_CHANGED_CWD"; printf 'CHANGED\\n'; read -r _`,
      { TEST_CHANGED_CWD: data.majorRoot },
    );
    await owner.marker('CHANGED');
    const observed = state(data);
    assert.equal(observed.admission.status, 'unknown');
    const result = reconcile(data, observed, 'major', target, 'tooling');
    assert.equal(result.status, 70);
    assert.match(result.stderr, /owner is still alive/u);
    assert.equal(existsSync(join(data.state, 'admission.owner')), true);
  },
);

test(
  'runtime Major recovery requires a fresh exact component manifest and all required smokes',
  { timeout: 10_000 },
  async (t) => {
    const data = fixture(t);
    const target = checkout(data.majorRoot);
    let observed = await interruptedOwner(t, data, 'major', 'runtime', target);
    assert.equal(reconcile(data, observed, 'major', target, 'runtime', 'api-shared').status, 70);
    const manifest = {
      targetSha: target,
      createdAt: new Date().toISOString(),
      components: { 'api-shared': { sourceSha: target, imageId: `sha256:${'c'.repeat(64)}` } },
      smokes: ['api-local-live', 'api-local-ready', 'api-admin-live', 'api-admin-ready'],
    };
    writeFileSync(join(data.majorRoot, 'current.json'), JSON.stringify(manifest));
    observed = state(data);
    assert.equal(reconcile(data, observed, 'major', target, 'runtime', 'api-shared').status, 70);
    manifest.smokes.push('api-public-live');
    writeFileSync(join(data.majorRoot, 'current.json'), JSON.stringify(manifest));
    observed = state(data);
    const recovered = reconcile(data, observed, 'major', target, 'runtime', 'api-shared');
    assert.equal(recovered.status, 0, recovered.stderr);
    assert.deepEqual(JSON.parse(recovered.stdout).components, ['api-shared']);
  },
);

test(
  'runtime Karavan recovery requires exact source and origin plus a fresh passed smoke',
  { timeout: 10_000 },
  async (t) => {
    const data = fixture(t);
    const target = checkout(data.karavanRoot);
    let observed = await interruptedOwner(t, data, 'karavan', 'runtime', target);
    const manifest = {
      git: { commit: target },
      origin: { commit: 'f'.repeat(40) },
      smoke: { status: 'passed', completedAt: new Date().toISOString() },
    };
    const file = join(data.karavanRoot, 'var/ops/karavan-release-current.json');
    writeFileSync(file, JSON.stringify(manifest));
    observed = state(data);
    assert.equal(reconcile(data, observed, 'karavan', target, 'runtime').status, 70);
    manifest.origin.commit = target;
    manifest.smoke.status = 'failed';
    writeFileSync(file, JSON.stringify(manifest));
    observed = state(data);
    assert.equal(reconcile(data, observed, 'karavan', target, 'runtime').status, 70);
    manifest.smoke.status = 'passed';
    writeFileSync(file, JSON.stringify(manifest));
    observed = state(data);
    assert.equal(reconcile(data, observed, 'karavan', target, 'runtime').status, 0);
  },
);

test(
  'recovery refuses a busy product lock or a still-running release actor',
  { timeout: 10_000 },
  async (t) => {
    const data = fixture(t);
    const target = checkout(data.majorRoot);
    const observed = await interruptedOwner(t, data, 'major', 'tooling', target);
    const holder = spawn(
      'flock',
      ['-n', join(data.majorRoot, 'deploy.lock'), 'bash', '-c', 'printf "HELD\\n"; read -r _'],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const heldDone = once(holder, 'close');
    t.after(async () => {
      holder.stdin.end();
      await heldDone;
    });
    await once(holder.stdout, 'data');
    assert.equal(reconcile(data, observed, 'major', target, 'tooling').status, 75);
    holder.stdin.end();
    await heldDone;
    const release = spawn(
      'bash',
      ['-c', 'printf "RUNNING\\n"; read -r _', 'vps-deploy-karavan.sh'],
      { cwd: data.karavanRoot, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const releaseDone = once(release, 'close');
    t.after(async () => {
      release.stdin.end();
      await releaseDone;
    });
    await once(release.stdout, 'data');
    const refused = reconcile(data, observed, 'major', target, 'tooling');
    assert.equal(refused.status, 70);
    assert.match(refused.stderr, /actor remains active/u);
  },
);
