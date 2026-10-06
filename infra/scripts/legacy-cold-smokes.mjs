import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const nativeHelper = fileURLToPath(new URL('./legacy-cold-native-smokes.sh', import.meta.url));

export function createLegacyColdSmokes({
  bindings,
  runtime,
  client,
  run = execute,
  fetchImpl = fetch,
  now = Date.now,
  wait = setTimeout,
}) {
  const base = {
    version: 1,
    complete: true,
    sourceSha: bindings.targetSha,
    imageId: bindings.targetImageId,
    selectionDigest: bindings.selectionDigest,
    controllerNonce: bindings.controllerNonce,
  };
  const readReady = async (port) => {
    const response = await fetchImpl(`http://127.0.0.1:${port}/api/health/ready`, {
      signal: AbortSignal.timeout(5_000),
      redirect: 'error',
      headers: { accept: 'application/json' },
    });
    if (!response.ok) throw new Error('ready_unproved');
    const body = await response.json();
    const lag = body?.checks?.queueLag;
    const age = now() - Date.parse(lag?.sampleGeneratedAt);
    if (
      body?.ok !== true ||
      body.checks.database !== true ||
      body.checks.redis !== true ||
      lag.rawOk !== true ||
      !Number.isFinite(lag.effectiveLagSec) ||
      lag.effectiveLagSec < 0 ||
      lag.effectiveLagSec > 10 ||
      !Number.isFinite(age) ||
      age < -1_000 ||
      age > 15_000
    )
      throw new Error('ready_detail_unproved');
    return lag.effectiveLagSec;
  };
  return {
    async readNativeIdentity() {
      runtime.readRuntimeIdentity();
      try {
        await run('bash', [nativeHelper, bindings.targetSha, bindings.targetImageId], {
          timeout: 240_000,
          maxBuffer: 1024 * 1024,
          encoding: 'utf8',
        });
      } catch {
        throw new Error('native_smokes_unproved');
      }
      const identity = runtime.readRuntimeIdentity();
      return { ...base, exactGenerationCount: identity.auxiliaries.length };
    },
    async strictSmokes() {
      const deadline = now() + 120_000;
      let good = 0;
      let lag = 0;
      while (now() < deadline) {
        try {
          runtime.readRuntimeIdentity();
          const queues = client.invoke('queues', { version: 1, operation: 'status' });
          if (queues.ownerPresent !== false || queues.pausedCount !== 0 || queues.queueCount !== 24)
            throw new Error('queue_resume_unproved');
          const values = await Promise.all([readReady(3001), readReady(3002)]);
          lag = Math.max(...values);
          if (++good >= 3)
            return {
              ...base,
              ingressReady: true,
              adminReady: true,
              queuesResumed: true,
              actionableLagSeconds: lag,
            };
        } catch {
          good = 0;
        }
        await wait(5_000);
      }
      throw new Error('strict_smoke_deadline');
    },
  };
}
