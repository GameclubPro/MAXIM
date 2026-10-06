import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

const root = resolve(import.meta.dirname, '../..');
const lockSource = resolve(root, 'infra/scripts/lib/deploy-lock.sh');
const wrapperSource = resolve(root, 'infra/scripts/vps-recover-multibot-preparation.sh');

async function marker(path) {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    try {
      return JSON.parse(await readFile(path, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    }
    await delay(10);
  }
  assert.fail('Owned wrapper fixture did not reach its expected marker');
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

function observeLock(lockPath, env) {
  return new Promise((resolveResult, reject) => {
    execFile(
      'bash',
      [
        '-c',
        'source "$1"; acquire_deploy_lock; result=$?; if ((result == 0)); then release_deploy_lock; fi; exit "$result"',
        'lock-observer',
        lockPath,
      ],
      { env, timeout: 2_000 },
      (error) => {
        if (!error) resolveResult(0);
        else if (error.code === 1) resolveResult(1);
        else reject(error);
      },
    );
  });
}

for (const signal of ['SIGTERM', 'SIGHUP', 'SIGINT']) {
  test(
    `shell-only ${signal} retains the real deploy lock until exact child cleanup and exit`,
    { timeout: 8_000 },
    async (t) => {
      const fixture = await mkdtemp(resolve(tmpdir(), 'maxim-recovery-wrapper-'));
      const scripts = resolve(fixture, 'infra/scripts');
      const binaries = resolve(fixture, 'bin');
      await mkdir(resolve(scripts, 'lib'), { recursive: true });
      await mkdir(binaries);
      const wrapper = resolve(scripts, 'vps-recover-multibot-preparation.sh');
      const lock = resolve(scripts, 'lib/deploy-lock.sh');
      await copyFile(wrapperSource, wrapper);
      await copyFile(lockSource, lock);
      const started = resolve(fixture, 'started.json');
      const cleaning = resolve(fixture, 'cleaning.json');
      const finished = resolve(fixture, 'finished.json');
      const gate = resolve(fixture, 'allow-cleanup');
      // FLAG: Substitute only Node's workload; execute the checked-in shell wrapper
      // and deploy-lock implementation, without production paths or processes.
      await writeFile(
        resolve(binaries, 'node'),
        `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
if (process.argv.includes('--validate-args')) process.exit(0);
const directory = process.env.MAXIM_WRAPPER_FIXTURE_DIRECTORY;
const mark = (name, value) => fs.writeFileSync(path.join(directory, name), JSON.stringify(value));
let closing = false;
for (const signal of ['SIGTERM', 'SIGHUP', 'SIGINT']) process.on(signal, () => {
  if (closing) return;
  closing = true;
  mark('cleaning.json', {pid: process.pid, signal});
  const finish = () => {
    if (!fs.existsSync(path.join(directory, 'allow-cleanup'))) return;
    mark('finished.json', {pid: process.pid});
    process.exit(1);
  };
  finish();
  setInterval(finish, 10);
});
mark('started.json', {pid: process.pid});
setInterval(() => {}, 1000);
`,
        { mode: 0o700 },
      );
      const env = {
        ...process.env,
        PATH: `${binaries}:${process.env.PATH}`,
        MAXIM_DEPLOY_LOCK_DIR: resolve(fixture, 'deploy-lock'),
        MAXIM_WRAPPER_FIXTURE_DIRECTORY: fixture,
      };
      const observer = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
        stdio: 'ignore',
      });
      const observerDone = new Promise((done) => observer.once('close', done));
      const child = spawn('bash', [wrapper], { env, stdio: 'ignore' });
      const childDone = new Promise((done) =>
        child.once('close', (code, exitSignal) => done({ code, exitSignal })),
      );
      let nodePid;
      t.after(async () => {
        await writeFile(gate, 'release');
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
        await Promise.race([childDone, delay(1_000)]);
        if (nodePid && alive(nodePid)) process.kill(nodePid, 'SIGKILL');
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        await childDone;
        observer.kill('SIGTERM');
        await observerDone;
        await rm(fixture, { recursive: true, force: true });
      });
      nodePid = (await marker(started)).pid;
      assert.notEqual(nodePid, child.pid);
      assert.equal(
        (await readFile(resolve(env.MAXIM_DEPLOY_LOCK_DIR, 'pid'), 'utf8')).trim(),
        String(child.pid),
      );
      assert.equal(await observeLock(lock, env), 1);
      // Deliver only to Bash, rather than the process group or Node itself.
      process.kill(child.pid, signal);
      const interrupted = await marker(cleaning);
      assert.deepEqual(
        { pid: interrupted.pid, signal: interrupted.signal },
        { pid: nodePid, signal },
      );
      assert.equal(alive(nodePid), true);
      assert.equal(alive(observer.pid), true);
      // FLAG: The explicit gate proves the lock survives pending cleanup. Timer
      // callbacks and wall-clock differences do not guarantee a minimum duration.
      assert.equal(await observeLock(lock, env), 1);
      await assert.rejects(readFile(finished), { code: 'ENOENT' });
      await writeFile(gate, 'release');
      const outcome = await childDone;
      const completed = await marker(finished);
      assert.equal(completed.pid, nodePid);
      assert.deepEqual(outcome, { code: 1, exitSignal: null });
      assert.equal(alive(nodePid), false);
      assert.equal(alive(observer.pid), true);
      assert.equal(await observeLock(lock, env), 0);
      await assert.rejects(readFile(resolve(env.MAXIM_DEPLOY_LOCK_DIR, 'pid')), { code: 'ENOENT' });
    },
  );
}
