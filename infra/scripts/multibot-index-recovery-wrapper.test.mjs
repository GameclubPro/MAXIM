import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

const supported = process.platform === 'linux' && existsSync('/proc/self/stat');

function processState(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0];
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ESRCH') return null;
    throw error;
  }
}

function fixture(mode, cleanupFails = false) {
  const directory = mkdtempSync(join(tmpdir(), 'maxim-multibot-recovery-wrapper-'));
  const scripts = join(directory, 'infra/scripts');
  const bin = join(directory, 'bin');
  mkdirSync(join(scripts, 'lib'), { recursive: true });
  mkdirSync(bin);
  const wrapper = join(scripts, 'vps-recover-multibot-index-migration.sh');
  copyFileSync(new URL('./vps-recover-multibot-index-migration.sh', import.meta.url), wrapper);
  copyFileSync(
    new URL('./lib/deploy-lock.sh', import.meta.url),
    join(scripts, 'lib/deploy-lock.sh'),
  );
  const stub = join(bin, 'node');
  const nodeSource = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const directory = process.env.RECOVERY_WRAPPER_FIXTURE;
const events = path.join(directory, 'events');
const metadata = path.join(directory, 'worker.json');
const record = (message) => fs.appendFileSync(events, message + '\\n');
if (process.argv[2] === '-p') {
  console.log('11111111-1111-4111-8111-111111111111');
  process.exit(0);
}
if (process.argv[3] === '--cleanup') {
  const worker = JSON.parse(fs.readFileSync(metadata, 'utf8'));
  let state = null;
  try {
    const stat = fs.readFileSync('/proc/' + worker.pid + '/stat', 'utf8');
    state = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0];
  } catch (error) {
    if (error.code !== 'ENOENT' && error.code !== 'ESRCH') throw error;
  }
  const quiescent = state === null || state === 'Z';
  const locked = fs.existsSync(process.env.MAXIM_DEPLOY_LOCK_DIR);
  record('cleanup:' + JSON.stringify({ quiescent, locked }));
  process.exit(quiescent && locked && process.env.RECOVERY_WRAPPER_CLEANUP_FAIL !== '1' ? 0 : 1);
}
// FLAG: Block the real Node signal handler in synchronous work. Killing only GNU
// timeout would leave this worker able to start a later operation after cleanup.
process.on('SIGTERM', () => record('worker:term-handler'));
fs.writeFileSync(metadata, JSON.stringify({ pid: process.pid, parentPid: process.ppid }));
record('worker:ready');
if (process.env.RECOVERY_WRAPPER_MODE === 'success') process.exit(0);
const end = Date.now() + 15000;
while (Date.now() < end) {}
record('worker:next-operation');
setInterval(() => {}, 1000);
`;
  writeFileSync(stub, nodeSource, { mode: 0o700 });
  chmodSync(stub, 0o700);
  const child = spawn('bash', [wrapper], {
    cwd: directory,
    detached: true,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      MAXIM_DEPLOY_LOCK_DIR: join(directory, 'deploy.lock'),
      RECOVERY_WRAPPER_FIXTURE: directory,
      RECOVERY_WRAPPER_MODE: mode,
      RECOVERY_WRAPPER_CLEANUP_FAIL: cleanupFails ? '1' : '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  child.stdout.resume();
  const done = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  return {
    directory,
    child,
    done,
    stderr: () => stderr,
    events: () => readFileSync(join(directory, 'events'), 'utf8').trim().split('\n'),
    metadata: () => JSON.parse(readFileSync(join(directory, 'worker.json'), 'utf8')),
    async ready() {
      const deadline = Date.now() + 5000;
      while (!existsSync(join(directory, 'worker.json'))) {
        if (Date.now() >= deadline) throw new Error('Fixture worker did not start.');
        await delay(20);
      }
      return this.metadata();
    },
    async close() {
      if (existsSync(join(directory, 'worker.json'))) {
        const { pid, parentPid } = this.metadata();
        // FLAG: These PIDs come only from our private fixture's owned launcher. Reap
        // an interrupted test without targeting any production process or name.
        if (processState(pid) && processState(pid) !== 'Z') {
          try {
            process.kill(-parentPid, 'SIGKILL');
          } catch (error) {
            if (error.code !== 'ESRCH') throw error;
          }
        }
      }
      if (child.exitCode === null && child.signalCode === null) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch (error) {
          if (error.code !== 'ESRCH') throw error;
        }
      }
      await done;
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

for (const [signal, expectedCode] of [
  ['SIGTERM', 143],
  ['SIGHUP', 129],
]) {
  test(
    `shell-only ${signal} stops the real owned timeout group before cleanup and unlock`,
    { skip: !supported, timeout: 25000 },
    async () => {
      const h = fixture('blocked');
      try {
        const worker = await h.ready();
        assert.ok(![null, 'Z'].includes(processState(worker.pid)), 'Owned Node must be live');
        assert.equal(h.child.kill(signal), true);
        const outcome = await h.done;
        assert.deepEqual(outcome, { code: expectedCode, signal: null }, h.stderr());
        assert.ok([null, 'Z'].includes(processState(worker.pid)), 'Owned Node must be quiescent');
        assert.deepEqual(h.events(), ['worker:ready', 'cleanup:{"quiescent":true,"locked":true}']);
        assert.equal(existsSync(join(h.directory, 'deploy.lock')), false);
      } finally {
        await h.close();
      }
    },
  );
}

test(
  'successful helper cannot report success when exact cleanup is unconfirmed',
  { skip: !supported, timeout: 10000 },
  async () => {
    const h = fixture('success', true);
    try {
      await h.ready();
      assert.deepEqual(await h.done, { code: 1, signal: null });
      assert.match(h.stderr(), /MULTIBOT_RECOVERY_CLEANUP_UNCONFIRMED/u);
      assert.deepEqual(h.events(), ['worker:ready', 'cleanup:{"quiescent":true,"locked":true}']);
      assert.equal(existsSync(join(h.directory, 'deploy.lock')), false);
    } finally {
      await h.close();
    }
  },
);
