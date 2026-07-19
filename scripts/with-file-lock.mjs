import { spawn } from 'node:child_process';
import {
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { resolve } from 'node:path';

const repoRoot = resolve(import.meta.dirname, '..');
const separatorIndex = process.argv.indexOf('--');
const lockName = process.argv[2];
const command = separatorIndex >= 0 ? process.argv.slice(separatorIndex + 1) : [];

if (!lockName || !/^[a-z0-9][a-z0-9._-]*$/u.test(lockName) || command.length === 0) {
  throw new Error(
    'Usage: node scripts/with-file-lock.mjs <lock-name> -- <command> [arguments...]',
  );
}

const lockRoot = resolve(process.env.MAXIM_LOCK_ROOT || resolve(repoRoot, '.codex', 'locks'));
const lockPath = resolve(lockRoot, `${lockName}.lock`);
const ownerPath = resolve(lockPath, 'owner.json');
const waitTimeoutMs = Number(process.env.MAXIM_LOCK_WAIT_TIMEOUT_MS || 20 * 60 * 1000);
const staleAfterMs = Number(process.env.MAXIM_LOCK_STALE_AFTER_MS || 12 * 60 * 60 * 1000);
const currentHost = hostname();
let acquired = false;
let child;

function sleep(milliseconds) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

function processExists(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function readOwner() {
  try {
    return JSON.parse(readFileSync(ownerPath, 'utf8'));
  } catch {
    return null;
  }
}

function lockIsStale() {
  const owner = readOwner();
  let ageMs = Number.POSITIVE_INFINITY;

  try {
    ageMs = Date.now() - statSync(lockPath).mtimeMs;
  } catch {
    return true;
  }

  if (owner?.hostname === currentHost && !processExists(owner.pid)) {
    return true;
  }

  return !owner && ageMs > staleAfterMs;
}

function release() {
  if (!acquired) {
    return;
  }

  acquired = false;
  rmSync(lockPath, { force: true, recursive: true });
}

async function acquire() {
  mkdirSync(lockRoot, { recursive: true });
  const startedAt = Date.now();
  let attempt = 0;

  while (true) {
    try {
      mkdirSync(lockPath);
      acquired = true;
      writeFileSync(
        ownerPath,
        `${JSON.stringify(
          {
            pid: process.pid,
            hostname: currentHost,
            startedAt: new Date().toISOString(),
            cwd: process.cwd(),
            command,
          },
          null,
          2,
        )}\n`,
      );
      return;
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        throw error;
      }

      if (lockIsStale()) {
        rmSync(lockPath, { force: true, recursive: true });
        continue;
      }

      if (Date.now() - startedAt >= waitTimeoutMs) {
        const owner = readOwner();
        throw new Error(
          `Timed out waiting for lock ${lockName}${owner ? ` held by pid ${owner.pid} on ${owner.hostname}` : ''}`,
        );
      }

      attempt += 1;
      await sleep(Math.min(1000, 50 * 2 ** Math.min(attempt, 5)));
    }
  }
}

function forwardSignal(signal) {
  if (child && !child.killed) {
    child.kill(signal);
  }
}

process.once('SIGINT', () => forwardSignal('SIGINT'));
process.once('SIGTERM', () => forwardSignal('SIGTERM'));
process.once('exit', release);

await acquire();

const [executable, ...args] = command;
child = spawn(executable, args, {
  cwd: process.cwd(),
  env: process.env,
  stdio: 'inherit',
});

const exitCode = await new Promise((resolveExit, reject) => {
  child.once('error', reject);
  child.once('exit', (code, signal) => {
    if (signal) {
      resolveExit(128 + (signal === 'SIGINT' ? 2 : 15));
      return;
    }
    resolveExit(code ?? 1);
  });
});

release();
process.exitCode = exitCode;
