import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { deployLockFixture, deployLockEnvironment } from './test-fixtures/deploy-lock.mjs';

function fixture(t, modern = false) {
  const root = mkdtempSync(join(tmpdir(), 'maxim-cold-wrapper-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const scripts = join(root, 'infra/scripts');
  mkdirSync(join(scripts, 'lib'), { recursive: true });
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const sha = 'a'.repeat(40);
  writeFileSync(join(bin, 'git'), `#!/bin/sh\nprintf '%s\\n' '${sha}'\n`, { mode: 0o700 });
  const wrapperName = modern ? 'vps-source-abandonment.sh' : 'vps-legacy-cold-recovery.sh';
  const wrapper = join(scripts, wrapperName);
  writeFileSync(wrapper, readFileSync(new URL(`./${wrapperName}`, import.meta.url)));
  const lock = deployLockFixture(root, join(scripts, 'lib/deploy-lock.sh'));
  writeFileSync(
    join(scripts, modern ? 'source-abandonment-host.mjs' : 'legacy-cold-host.mjs'),
    `
    import { fstatSync, readFileSync } from 'node:fs';
    const fd = Number(process.env.MAXIM_DEPLOY_LOCK_FD);
    const stat = fstatSync(fd);
    if (process.env.MAXIM_DEPLOY_LOCK_VERSION !== 'flock-v1' ||
      process.env.MAXIM_DEPLOY_LOCK_IDENTITY !== stat.dev + ':' + stat.ino ||
      !readFileSync('/proc/self/fdinfo/' + fd, 'utf8').includes('FLOCK')) throw new Error('lock lost');
    process.stdout.write('LOCKED\\n');
    let input = '';
    for await (const chunk of process.stdin) input += chunk;
    if (JSON.parse(input).operation !== 'status') throw new Error('request changed');
  `,
  );
  const env = deployLockEnvironment({
    PATH: `${bin}:${process.env.PATH}`,
    MAXIM_EXPECTED_DEPLOY_SHA: sha,
  });
  return { wrapper, lock, env };
}

for (const modern of [false, true]) {
  test(`${modern ? 'source' : 'legacy'} real shell-to-Node exec keeps the protected flock through stdin and controller completion`, async (t) => {
    const h = fixture(t, modern);
    const child = spawn('bash', [h.wrapper], { env: h.env, stdio: ['pipe', 'pipe', 'pipe'] });
    const done = once(child, 'close');
    t.after(async () => {
      if (child.exitCode === null) child.kill('SIGKILL');
      await done;
    });
    const first = await Promise.race([
      once(child.stdout, 'data'),
      done.then(([code]) => {
        throw new Error(`controller exited early: ${code}`);
      }),
    ]);
    assert.match(first[0].toString(), /LOCKED/u);
    const observe = () =>
      spawnSync('bash', ['-c', 'source "$1"; acquire_deploy_lock', 'fixture', h.lock.helper], {
        env: h.env,
        encoding: 'utf8',
        timeout: 3000,
      });
    assert.notEqual(observe().status, 0);
    child.stdin.end('{"version":1,"operation":"status"}\n');
    assert.equal((await done)[0], 0);
    assert.equal(observe().status, 0);
  });

  test(`${modern ? 'source' : 'legacy'} source mismatch and extra arguments refuse before the controller starts`, (t) => {
    const h = fixture(t, modern);
    for (const [args, env] of [
      [[], { ...h.env, MAXIM_EXPECTED_DEPLOY_SHA: 'b'.repeat(40) }],
      [['--bypass'], h.env],
    ]) {
      const result = spawnSync('bash', [h.wrapper, ...args], {
        env,
        encoding: 'utf8',
        timeout: 3000,
      });
      assert.equal(result.status, 2);
      assert.equal(result.stdout.includes('LOCKED'), false);
    }
  });
}
