import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = new URL('../..', import.meta.url).pathname;
const probeCommand = `set -e
df -B1 --output=avail / | tail -1
curl -fsS --max-time 8 http://127.0.0.1:3001/api/health/ready
printf '\\n'
curl -fsS --max-time 8 http://127.0.0.1:3002/api/health/ready
printf '\\n'`;

// FLAG: Fail closed on stale/missing health, including a queue breach hidden by
// readiness hysteresis. Never print the raw response (it can contain identities).
export function evaluateBackupProbe(stdout, now = Date.now()) {
  try {
    const lines = stdout.trim().split('\n');
    if (lines.length !== 3 || !/^\s*\d+\s*$/u.test(lines[0])) return 'invalid_probe';
    if (Number(lines[0]) < 4 * 1024 ** 3) return 'root_reserve';
    for (const line of lines.slice(1)) {
      const health = JSON.parse(line);
      const lag = health.checks?.queueLag;
      const sampled = Date.parse(lag?.sampleGeneratedAt);
      if (!Number.isFinite(sampled) || now - sampled > 30_000 || sampled > now + 5_000)
        return 'stale_probe';
      if (
        health.ok !== true ||
        health.checks?.database !== true ||
        health.checks?.redis !== true ||
        lag?.ok !== true ||
        lag?.rawOk !== true ||
        health.systemMode?.degraded !== false
      )
        return 'unhealthy';
      if (
        typeof lag.effectiveLagSec !== 'number' ||
        !Number.isFinite(lag.effectiveLagSec) ||
        lag.effectiveLagSec < 0 ||
        lag.effectiveLagSec >= 10
      )
        return 'queue_lag';
    }
    return null;
  } catch {
    return 'invalid_probe';
  }
}

function signalGroup(child, signal) {
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}

export async function runWatchedBackup(args, { probe, start, intervalMs = 15_000 } = {}) {
  if (args.includes('--allow-degraded'))
    throw new Error('The watchdog requires healthy readiness.');
  probe ??= () =>
    new Promise((resolve) => {
      const child = spawn('bash', ['infra/scripts/vps-connect.sh', 'exec', probeCommand], {
        cwd: root,
        detached: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      let output = '';
      let failed = false;
      const timer = setTimeout(() => {
        failed = true;
        signalGroup(child, 'SIGKILL');
      }, 25_000);
      child.stdout.on('data', (data) => {
        output += data;
        if (output.length > 65_536) {
          failed = true;
          signalGroup(child, 'SIGKILL');
        }
      });
      child.on('error', () => {
        failed = true;
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve(failed || code !== 0 ? 'probe_failed' : evaluateBackupProbe(output));
      });
    });
  const initial = await probe();
  if (initial) throw new Error(`Backup preflight stopped: ${initial}`);
  const child = start
    ? start(args)
    : spawn('bash', ['infra/scripts/stream-live-postgres-backup-to-local.sh', ...args], {
        cwd: root,
        detached: true,
        stdio: 'inherit',
        env: { ...process.env, MAXIM_LIVE_POSTGRES_REQUIRE_READY: '1' },
      });
  let stopped = false;
  let abortReason = null;
  let killTimer;
  const abort = (reason) => {
    if (abortReason || stopped) return;
    abortReason = reason;
    // Give the reviewed stream helper time to terminate its exact PG backend.
    signalGroup(child, 'SIGTERM');
    killTimer = setTimeout(() => signalGroup(child, 'SIGKILL'), 45_000);
  };
  const onTerm = () => abort('operator_signal');
  process.once('SIGTERM', onTerm);
  process.once('SIGINT', onTerm);
  const completion = new Promise((resolve) => {
    child.once('error', () => {
      abortReason = 'spawn_failed';
    });
    child.once('close', (code) => {
      stopped = true;
      resolve(code ?? 1);
    });
  });
  try {
    while (!stopped && !abortReason) {
      await Promise.race([completion, delay(intervalMs, undefined, { ref: false })]);
      if (stopped) break;
      const reason = await probe();
      if (reason) abort(reason);
    }
    const code = await completion;
    if (abortReason) throw new Error(`Backup watchdog stopped: ${abortReason}`);
    if (code !== 0) throw new Error(`Backup helper exited with status ${code}`);
  } finally {
    clearTimeout(killTimer);
    process.removeListener('SIGTERM', onTerm);
    process.removeListener('SIGINT', onTerm);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runWatchedBackup(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
