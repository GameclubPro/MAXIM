import { setTimeout as delay } from 'node:timers/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { LEGACY_COLD_API_SERVICES } from './multibot-legacy-cold-recovery.mjs';
import { classifyCommercialOcrApiContainerInventory } from './commercial-ocr-runtime-inventory.mjs';

const nativeServices = ['ocr-native-sandbox', 'photo-native-sandbox'];
const idPattern = /^[0-9a-f]{64}$/u;
const allServices = [...LEGACY_COLD_API_SERVICES, ...nativeServices];

export function inspectLegacyColdGenerations(
  containers,
  bindings,
  expected = null,
  stopped = false,
) {
  if (!Array.isArray(containers) || containers.length > 256)
    throw new Error('runtime_inventory_budget');
  const running = classifyCommercialOcrApiContainerInventory(
    containers,
    LEGACY_COLD_API_SERVICES,
    bindings.targetImageId,
    'infra',
    nativeServices.join(','),
  );
  if (
    running.ownedUnreviewedIds.length ||
    running.ambiguousIds.length ||
    running.reviewedAuxiliaryCount !== (stopped ? 0 : 2)
  )
    throw new Error('unreviewed_runtime_producer');
  if (stopped && !expected) throw new Error('stopped_baseline_missing');
  const select = (serviceName) => {
    const rows = containers.filter(
      (row) =>
        row.Config?.Labels?.['com.docker.compose.project'] === 'infra' &&
        row.Config?.Labels?.['com.docker.compose.service'] === serviceName,
    );
    const row = rows[0];
    const prior = [...(expected?.services ?? []), ...(expected?.auxiliaries ?? [])].find(
      (value) => value.serviceName === serviceName,
    );
    if (
      rows.length !== 1 ||
      !idPattern.test(row?.Id ?? '') ||
      row.Image !== bindings.targetImageId ||
      row.Config?.Image !== `maxim-api:${bindings.targetSha}` ||
      row.Config?.Labels?.['org.opencontainers.image.revision'] !== bindings.targetSha ||
      row.HostConfig?.RestartPolicy?.Name !== 'unless-stopped' ||
      row.State?.Running !== !stopped ||
      row.State?.Status !== (stopped ? 'exited' : 'running') ||
      row.State?.Paused !== false ||
      row.State?.Restarting !== false ||
      row.State?.Dead !== false ||
      (prior && prior.containerId !== row.Id)
    )
      throw new Error('runtime_generation_unproved');
    let nativeBoundaryDigest;
    if (nativeServices.includes(serviceName)) {
      nativeBoundaryDigest = createHash('sha256')
        .update(
          JSON.stringify({
            config: row.Config,
            host: row.HostConfig,
            mounts: row.Mounts,
          }),
        )
        .digest('hex');
      if (prior && nativeBoundaryDigest !== prior.nativeBoundaryDigest)
        throw new Error('native_boundary_changed');
    } else {
      const env = row.Config.Env ?? [];
      const role =
        serviceName.startsWith('api-moderation') || serviceName === 'api-media-analysis'
          ? 'moderation'
          : serviceName.slice(4);
      for (const [key, value] of [
        ['APP_SERVICE_NAME', serviceName],
        ['APP_ROLE', role],
      ]) {
        const matches = env.filter(
          (entry) => typeof entry === 'string' && entry.startsWith(`${key}=`),
        );
        if (matches.length !== 1 || matches[0] !== `${key}=${value}`)
          throw new Error('role_identity_unproved');
      }
    }
    return {
      serviceName,
      containerId: row.Id,
      imageId: row.Image,
      sourceSha: bindings.targetSha,
      stopped,
      exactGeneration: true,
      restartPolicy: 'unless-stopped',
      ...(nativeBoundaryDigest ? { nativeBoundaryDigest } : {}),
    };
  };
  const services = LEGACY_COLD_API_SERVICES.map(select);
  const auxiliaries = nativeServices.map(select);
  return {
    version: 1,
    complete: true,
    sourceSha: bindings.targetSha,
    imageId: bindings.targetImageId,
    selectionDigest: bindings.selectionDigest,
    controllerNonce: bindings.controllerNonce,
    compatible: true,
    singletonCount: 14,
    nativeCount: 2,
    unreviewedProducers: 0,
    services,
    auxiliaries,
  };
}

const execute = (command, args, options = {}) =>
  execFileSync(command, args, {
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  }).trim();

// FLAG: This controller never creates containers or restores an earlier image.
// Manual stop plus unless-stopped survives a Docker daemon restart. Startup is
// limited to the exact captured generations after the caller proves sealed holds.
export function createLegacyColdRuntime({
  bindings,
  baseline = null,
  run = execute,
  now = Date.now,
  wait = delay,
}) {
  let captured = baseline;
  const inventory = () => {
    const raw = run('docker', ['ps', '-aq', '--no-trunc']);
    const ids = raw ? raw.split('\n') : [];
    if (!ids.length || ids.length > 256 || ids.some((id) => !idPattern.test(id)))
      throw new Error('runtime_inventory_budget');
    return JSON.parse(run('docker', ['inspect', ...ids]));
  };
  return {
    inspectRuntime() {
      const snapshot = inspectLegacyColdGenerations(inventory(), bindings);
      captured = snapshot;
      return snapshot;
    },
    readStoppedRuntime() {
      if (!captured) throw new Error('runtime_baseline_missing');
      return inspectLegacyColdGenerations(inventory(), bindings, captured, true);
    },
    stopRuntime() {
      if (!captured) throw new Error('runtime_baseline_missing');
      const generations = [...captured.services, ...captured.auxiliaries];
      if (
        generations.length !== 16 ||
        new Set(generations.map((row) => row.containerId)).size !== 16 ||
        generations.some(
          (row) => !allServices.includes(row.serviceName) || !idPattern.test(row.containerId),
        )
      )
        throw new Error('runtime_baseline_invalid');
      // FLAG: Stopping the captured identities remains possible even if a different
      // unexpected producer appeared. Readback then refuses that changed fleet.
      const existing = inventory();
      const owned = generations.filter((row) =>
        existing.some((value) => value.Id === row.containerId),
      );
      if (owned.length)
        run('docker', ['stop', '--time', '40', ...owned.map((row) => row.containerId)], {
          timeout: 180_000,
        });
    },
    async startBoundRuntime() {
      if (!captured) throw new Error('runtime_baseline_missing');
      const stopped = inspectLegacyColdGenerations(inventory(), bindings, captured, true);
      run('docker', ['start', ...stopped.auxiliaries.map((row) => row.containerId)], {
        timeout: 60_000,
      });
      run('docker', ['start', ...stopped.services.map((row) => row.containerId)], {
        timeout: 120_000,
      });
      // FLAG: Docker start precedes the first healthcheck. Attest the same native
      // generations after bounded startup; a starting probe is not a foreign producer.
      const deadline = now() + 60_000;
      for (;;) {
        const rows = inventory();
        const native = stopped.auxiliaries.map(({ containerId, imageId }) => {
          const row = rows.find((value) => value.Id === containerId);
          if (
            !row?.State?.Running ||
            row.Image !== imageId ||
            !['starting', 'healthy'].includes(row.State.Health?.Status)
          )
            throw new Error('native_startup_unproved');
          return row;
        });
        if (native.every((row) => row.State.Health.Status === 'healthy')) break;
        if (now() >= deadline) throw new Error('native_startup_deadline');
        await wait(1000);
      }
    },
    readRuntimeIdentity() {
      if (!captured) throw new Error('runtime_baseline_missing');
      return {
        ...inspectLegacyColdGenerations(inventory(), bindings, captured),
        exactGenerationCount: 14,
      };
    },
  };
}
