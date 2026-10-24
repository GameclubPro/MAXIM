#!/usr/bin/env node

import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  closeSync,
  fsyncSync,
  readFileSync,
  renameSync,
  statfsSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readCurrentManifest, validateCompleteReleaseManifest } from './release-manifest.mjs';
import { WORKSTATION_IDENTITY } from './commercial-llm-workstation-profile.mjs';

import {
  COMMERCIAL_LLM_RUNTIME,
  COMMERCIAL_LLM_LEGACY_RUNTIME,
  COMMERCIAL_LLM_COMMAND,
  commercialLlmCommand,
} from './commercial-llm-profiles.mjs';
export { COMMERCIAL_LLM_RUNTIME, COMMERCIAL_LLM_LEGACY_RUNTIME, COMMERCIAL_LLM_COMMAND };
const pin = COMMERCIAL_LLM_RUNTIME;
const { stateDir, modelDir } = pin;
const composeArgs = [
  'compose',
  '--env-file',
  '.env',
  '-p',
  'infra',
  '-f',
  'infra/docker-compose.yml',
];
const safeSha = /^[0-9a-f]{40}$/u;
let capacityPaths = [];

function run(file, args, { timeout = 30000, input, maxBuffer = 1024 * 1024 } = {}) {
  try {
    return execFileSync(file, args, {
      encoding: 'utf8',
      timeout,
      maxBuffer,
      input,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    throw new Error(`commercial_llm_command_failed:${file}`);
  }
}

function emit(stage, details = {}) {
  process.stdout.write(
    `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, stage, ...details })}\n`,
  );
}

function assertSafeFile(path, { maximumBytes = Infinity, exactBytes } = {}) {
  const value = lstatSync(path);
  if (
    !value.isFile() ||
    value.isSymbolicLink() ||
    value.nlink !== 1 ||
    value.uid !== process.getuid() ||
    (value.mode & 0o022) !== 0 ||
    value.size > maximumBytes ||
    (exactBytes !== undefined && value.size !== exactBytes)
  ) {
    throw new Error('commercial_llm_unsafe_file');
  }
  return value;
}

function ensureDirectory(path) {
  if (!existsSync(path)) mkdirSync(path, { mode: 0o750 });
  const value = lstatSync(path);
  if (
    !value.isDirectory() ||
    value.isSymbolicLink() ||
    value.uid !== process.getuid() ||
    (value.mode & 0o022) !== 0
  ) {
    throw new Error('commercial_llm_unsafe_directory');
  }
}

function atomicWrite(path, contents, mode = 0o600) {
  if (existsSync(path)) assertSafeFile(path, { maximumBytes: 1024 * 1024 });
  const tempPath = `${path}.new-${process.pid}`;
  const fd = openSync(tempPath, 'wx', mode);
  try {
    writeFileSync(fd, contents);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tempPath, path);
  const parent = openSync(dirname(path), 'r');
  try {
    fsyncSync(parent);
  } finally {
    closeSync(parent);
  }
}

export function patchCommercialLlmEnvironment(source, enabled) {
  if (typeof source !== 'string' || Buffer.byteLength(source) > 1024 * 1024) {
    throw new Error('commercial_llm_environment_refused');
  }
  const pattern = /^(?:[ \t]*)(?:export[ \t]+)?COMMERCIAL_LLM_SHADOW_ENABLED[ \t]*=.*$/gmu;
  const matches = [...source.matchAll(pattern)];
  if (matches.length > 1) throw new Error('commercial_llm_duplicate_environment_flag');
  const line = `COMMERCIAL_LLM_SHADOW_ENABLED=${enabled ? 'true' : 'false'}`;
  if (matches.length === 1) return source.replace(pattern, line);
  return `${source}${source.endsWith('\n') || source.length === 0 ? '' : '\n'}${line}\n`;
}

export function assertCommercialLlmReceipt(receipt, profile = COMMERCIAL_LLM_RUNTIME) {
  if (
    receipt?.schemaVersion !== 1 ||
    !safeSha.test(receipt.sourceSha ?? '') ||
    !Number.isFinite(Date.parse(receipt.installedAt ?? '')) ||
    !/^[0-9a-f]{64}$/u.test(receipt.containerId ?? '') ||
    !['installed', 'stopped'].includes(receipt.state) ||
    receipt.imageRef !== profile.imageRef ||
    receipt.imageId !== profile.imageId ||
    receipt.modelSha256 !== profile.modelSha256 ||
    receipt.modelBytes !== profile.modelBytes ||
    receipt.modelManifestSha256 !== profile.modelManifestSha256 ||
    receipt.templateSha256 !== profile.templateSha256 ||
    receipt.licenseSha256 !== profile.licenseSha256 ||
    receipt.upstreamRevision !== profile.upstreamRevision ||
    receipt.upstreamVersion !== profile.upstreamVersion ||
    receipt.cpuLimit !== profile.cpuLimit ||
    receipt.memoryLimitBytes !== profile.memoryLimitBytes ||
    receipt.contextTokens !== 4096 ||
    receipt.parallelRequests !== 1 ||
    receipt.generationThreads !== profile.cpuLimit ||
    receipt.reasoning !== false ||
    receipt.smoke !== 'closed-synthetic-json-v1'
  ) {
    throw new Error('commercial_llm_receipt_refused');
  }
  return receipt;
}

// FLAG: Production Docker 29 identifies this image by its OCI manifest, not its config blob.
export function assertCommercialLlmImage(image) {
  if (
    image?.Id !== pin.imageId ||
    image.Descriptor?.digest !== pin.imageId ||
    image.Descriptor?.mediaType !== 'application/vnd.oci.image.manifest.v1+json' ||
    image.Architecture !== 'amd64' ||
    image.Os !== 'linux' ||
    !Array.isArray(image.RepoDigests) ||
    !image.RepoDigests.includes(pin.imageRef) ||
    image.Config?.Labels?.['org.opencontainers.image.revision'] !== pin.upstreamRevision ||
    image.Config?.Labels?.['org.opencontainers.image.version'] !== pin.upstreamVersion
  ) {
    throw new Error('commercial_llm_image_pin_refused');
  }
  return image.Id;
}

export function assertCommercialLlmContainer(
  container,
  { requireHealthy = true, requireRunning = true, profile = COMMERCIAL_LLM_RUNTIME } = {},
) {
  const config = container?.Config;
  const host = container?.HostConfig;
  const labels = config?.Labels;
  const networks = Object.keys(container?.NetworkSettings?.Networks ?? {});
  const mounts = container?.Mounts;
  const command = config?.Cmd;
  const tmpfs = Object.entries(host?.Tmpfs ?? {});
  const tmpfsOptions = new Map();
  const tmpfsValid =
    tmpfs.length === 1 &&
    tmpfs[0][0] === '/tmp' &&
    typeof tmpfs[0][1] === 'string' &&
    tmpfs[0][1].split(',').every((part) => {
      if (part === 'rw') return true;
      const separator = part.indexOf('=');
      if (separator < 1 || tmpfsOptions.has(part.slice(0, separator))) return false;
      tmpfsOptions.set(part.slice(0, separator), part.slice(separator + 1));
      return true;
    }) &&
    tmpfsOptions.size === 4 &&
    ['64m', '67108864'].includes(tmpfsOptions.get('size')) &&
    tmpfsOptions.get('mode') === '1777' &&
    tmpfsOptions.get('uid') === '1000' &&
    tmpfsOptions.get('gid') === '1000';
  const mountsExact =
    Array.isArray(mounts) &&
    mounts.length === (profile.templateMode === 'file' ? 2 : 1) &&
    [
      [profile.modelPath, profile.modelContainerPath],
      ...(profile.templateMode === 'file'
        ? [[profile.templatePath, '/models/chat_template.jinja']]
        : []),
    ].every(([source, target]) =>
      mounts.some(
        (mount) =>
          mount.Type === 'bind' &&
          mount.Source === source &&
          mount.Destination === target &&
          mount.RW === false,
      ),
    );
  // FLAG: The model is an isolated shadow auxiliary, never an API identity or a store client.
  if (
    !/^[0-9a-f]{64}$/u.test(container?.Id ?? '') ||
    container.Image !== profile.imageId ||
    config?.Image !== profile.imageRef ||
    config?.User !== '1000:1000' ||
    JSON.stringify(config?.Entrypoint) !== '["/app/llama-server"]' ||
    JSON.stringify([...(config?.Env ?? [])].sort()) !==
      JSON.stringify(
        [
          'LLAMA_ARG_HOST=0.0.0.0',
          'LLAMA_ARG_PORT=8080',
          'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
        ].sort(),
      ) ||
    labels?.['com.docker.compose.project'] !== 'infra' ||
    labels?.['com.docker.compose.service'] !== profile.service ||
    labels?.['com.maxim.commercial-llm-shadow'] !== 'true' ||
    labels?.['com.maxim.commercial-llm-model-sha256'] !== profile.modelSha256 ||
    (requireRunning && container.State?.Running !== true) ||
    (requireHealthy && container.State?.Health?.Status !== 'healthy') ||
    host?.ReadonlyRootfs !== true ||
    host?.Init !== true ||
    host?.NanoCpus !== profile.cpuLimit * 1e9 ||
    host?.CpuShares !== 128 ||
    host?.Memory !== profile.memoryLimitBytes ||
    host?.MemorySwap !== profile.memoryLimitBytes ||
    host?.PidsLimit !== profile.pidLimit ||
    JSON.stringify(host?.CapDrop) !== '["ALL"]' ||
    !host?.SecurityOpt?.includes('no-new-privileges:true') ||
    !tmpfsValid ||
    Object.keys(host?.PortBindings ?? {}).length !== 0 ||
    host?.Privileged === true ||
    networks.length !== 1 ||
    networks[0] !== 'infra_commercial_llm_internal' ||
    !mountsExact ||
    JSON.stringify(command) !== JSON.stringify(commercialLlmCommand(profile))
  ) {
    throw new Error('commercial_llm_runtime_attestation_refused');
  }
  return container.Id;
}

function sourceAdmission(expectedSha) {
  if (!safeSha.test(expectedSha ?? '')) throw new Error('commercial_llm_exact_source_required');
  if (run('git', ['rev-parse', 'HEAD']) !== expectedSha) {
    throw new Error('commercial_llm_source_mismatch');
  }
  if (run('git', ['status', '--porcelain', '--untracked-files=no']) !== '') {
    throw new Error('commercial_llm_dirty_source');
  }
  // FLAG: A valid ordinary release is required; installing an optional model cannot adopt recovery.
  run('node', ['infra/scripts/release-manifest.mjs', 'validate-current']);
  validateCompleteReleaseManifest(readCurrentManifest('/var/lib/maxim-deploy'));
}

export function checkCommercialLlmCapacity({ paths, availableMemoryBytes, needsDownload }) {
  const artifactBytes = needsDownload ? pin.modelBytes + pin.templateBytes + pin.licenseBytes : 0;
  const required = pin.diskReserveBytes + pin.downloadReserveBytes + artifactBytes;
  if (
    !Array.isArray(paths) ||
    paths.length < 2 ||
    paths.some(
      ({ availableBytes }) => !Number.isFinite(availableBytes) || availableBytes < required,
    )
  ) {
    throw new Error('commercial_llm_disk_reserve_refused');
  }
  if (
    !Number.isFinite(availableMemoryBytes) ||
    availableMemoryBytes < pin.minimumAvailableMemoryBytes
  ) {
    throw new Error('commercial_llm_memory_reserve_refused');
  }
  return { artifactBytes, requiredFreeBytes: required, availableMemoryBytes };
}

function capacity(needsDownload) {
  const dockerRoot = run('docker', ['info', '--format', '{{.DockerRootDir}}']);
  capacityPaths = [modelDir, dockerRoot];
  const paths = capacityPaths.map((path) => {
    const data = statfsSync(path);
    return { availableBytes: Number(data.bavail) * Number(data.bsize) };
  });
  const match = /^MemAvailable:\s+(\d+) kB$/mu.exec(readFileSync('/proc/meminfo', 'utf8'));
  return checkCommercialLlmCapacity({
    paths,
    availableMemoryBytes: Number(match?.[1] ?? NaN) * 1024,
    needsDownload,
  });
}

function inspectContainer({ requireHealthy = true, requireRunning = true, profile = pin } = {}) {
  const ids = run('docker', [...composeArgs, 'ps', '-a', '-q', pin.service]);
  if (!/^[0-9a-f]{64}$/u.test(ids)) throw new Error('commercial_llm_singleton_required');
  const rows = JSON.parse(run('docker', ['inspect', ids]));
  if (!Array.isArray(rows) || rows.length !== 1)
    throw new Error('commercial_llm_singleton_required');
  assertCommercialLlmContainer(rows[0], { requireHealthy, requireRunning, profile });
  const network = JSON.parse(
    run('docker', ['network', 'inspect', 'infra_commercial_llm_internal']),
  );
  if (network.length !== 1 || network[0]?.Internal !== true) {
    throw new Error('commercial_llm_internal_network_required');
  }
  const allowed = new Set([pin.service, 'api-moderation-background']);
  for (const id of Object.keys(network[0].Containers ?? {})) {
    const peer = JSON.parse(run('docker', ['inspect', id]));
    const labels = peer[0]?.Config?.Labels;
    if (
      peer.length !== 1 ||
      labels?.['com.docker.compose.project'] !== 'infra' ||
      !allowed.has(labels?.['com.docker.compose.service'])
    ) {
      throw new Error('commercial_llm_unexpected_network_peer');
    }
  }
  return rows[0];
}

function receiptPresent() {
  return lstatSync(pin.receiptPath, { throwIfNoEntry: false }) !== undefined;
}

function readReceipt() {
  assertSafeFile(pin.receiptPath, { maximumBytes: 16384 });
  return assertCommercialLlmReceipt(JSON.parse(readFileSync(pin.receiptPath, 'utf8')));
}

async function checksum(path, sha256, bytes) {
  const before = assertSafeFile(path, { exactBytes: bytes });
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path, { signal: AbortSignal.timeout(120000) }))
    hash.update(chunk);
  const after = assertSafeFile(path, { exactBytes: bytes });
  if (
    hash.digest('hex') !== sha256 ||
    ['ino', 'dev', 'mtimeMs', 'ctimeMs', 'size'].some((key) => before[key] !== after[key])
  ) {
    throw new Error('commercial_llm_artifact_checksum_refused');
  }
}

async function longCommand(file, args, { stage, timeoutMs, artifactPath } = {}) {
  const started = Date.now();
  emit(stage, { event: 'started', deadline: new Date(started + timeoutMs).toISOString() });
  await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(file, args, { stdio: ['ignore', 'ignore', 'ignore'] });
    let killTimer;
    let timedOut = false;
    let observationError;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 5000);
    }, timeoutMs);
    const heartbeat = setInterval(() => {
      try {
        let downloadedBytes = null;
        if (artifactPath) downloadedBytes = statSync(artifactPath).size;
        for (const path of capacityPaths) {
          const fs = statfsSync(path);
          if (
            Number(fs.bavail) * Number(fs.bsize) <
            pin.diskReserveBytes + pin.downloadReserveBytes
          ) {
            throw new Error('commercial_llm_disk_floor_crossed');
          }
        }
        emit(stage, {
          event: 'heartbeat',
          childPid: child.pid,
          elapsedSeconds: Math.floor((Date.now() - started) / 1000),
          downloadedBytes,
        });
      } catch {
        observationError = new Error(`commercial_llm_${stage}_observation_or_disk_floor_failed`);
        emit(stage, { event: 'observation_missing_or_disk_floor_refused', childPid: child.pid });
        child.kill('SIGTERM');
        killTimer = setTimeout(() => child.kill('SIGKILL'), 5000);
      }
    }, 30000);
    const finish = (error) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      clearInterval(heartbeat);
      if (error) rejectPromise(error);
      else resolvePromise();
    };
    child.once('error', () => finish(new Error(`commercial_llm_${stage}_spawn_failed`)));
    child.once('exit', (code) =>
      finish(
        observationError || timedOut || code !== 0
          ? (observationError ??
              new Error(`commercial_llm_${stage}_${timedOut ? 'deadline' : `exit_${code}`}`))
          : null,
      ),
    );
  });
  emit(stage, { event: 'completed', elapsedSeconds: Math.floor((Date.now() - started) / 1000) });
}

async function downloadArtifact({ path, url, sha256, bytes, stage }) {
  if (existsSync(path)) {
    await checksum(path, sha256, bytes);
    emit(stage, { event: 'checksum_verified', bytes });
    return;
  }
  const partial = `${path}.partial`;
  if (existsSync(partial)) {
    const prior = assertSafeFile(partial, { maximumBytes: bytes });
    if (prior.size === bytes) {
      await checksum(partial, sha256, bytes);
      chmodSync(partial, 0o444);
      renameSync(partial, path);
      emit(stage, { event: 'complete_partial_checksum_verified', bytes });
      return;
    }
  }
  await longCommand(
    'curl',
    [
      '--fail',
      '--silent',
      '--show-error',
      '--location',
      '--proto',
      '=https',
      '--proto-redir',
      '=https',
      '--connect-timeout',
      '15',
      '--max-time',
      String(pin.downloadDeadlineSeconds),
      '--speed-limit',
      '65536',
      '--speed-time',
      '120',
      '--limit-rate',
      String(pin.downloadRateBytes),
      '--continue-at',
      '-',
      '--output',
      partial,
      url,
      '--max-filesize',
      String(bytes),
    ],
    { stage, timeoutMs: pin.downloadDeadlineSeconds * 1000 + 10000, artifactPath: partial },
  );
  await checksum(partial, sha256, bytes);
  chmodSync(partial, 0o444);
  renameSync(partial, path);
  emit(stage, { event: 'checksum_verified', bytes });
}

export function commercialLlmSyntheticRequest() {
  return {
    model: pin.alias,
    messages: [
      {
        role: 'system',
        content: 'Классифицируй сообщение. Обычное приветствие не является коммерческой рекламой.',
      },
      { role: 'user', content: 'Доброе утро, соседи!' },
    ],
    temperature: 0,
    max_tokens: 96,
    stream: false,
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'commercial_shadow_closed_probe',
        strict: true,
        schema: {
          type: 'object',
          properties: {
            classification: { type: 'string', enum: ['NOT_COMMERCIAL'] },
            reasonCodes: {
              type: 'array',
              items: { type: 'string', enum: ['ORDINARY_DISCUSSION'] },
              minItems: 1,
              maxItems: 1,
            },
          },
          required: ['classification', 'reasonCodes'],
          additionalProperties: false,
        },
      },
    },
  };
}

export function validateCommercialLlmSyntheticResponse(response) {
  const choice = response?.choices?.[0];
  const content = choice?.message?.content;
  if (choice?.finish_reason !== 'stop' || typeof content !== 'string' || content.length > 1024) {
    throw new Error('commercial_llm_synthetic_smoke_refused');
  }
  const result = JSON.parse(content);
  if (
    Object.keys(result).sort().join(',') !== 'classification,reasonCodes' ||
    result.classification !== 'NOT_COMMERCIAL' ||
    JSON.stringify(result.reasonCodes) !== '["ORDINARY_DISCUSSION"]'
  ) {
    throw new Error('commercial_llm_synthetic_smoke_refused');
  }
}

function smoke(expectedContainerId) {
  const container = inspectContainer();
  if (expectedContainerId && container.Id !== expectedContainerId) {
    throw new Error('commercial_llm_generation_changed');
  }
  assertCommercialLlmTemplate(
    JSON.parse(
      run(
        'docker',
        [
          'exec',
          container.Id,
          'curl',
          '--fail',
          '--silent',
          '--max-time',
          '5',
          '--max-filesize',
          '65536',
          'http://127.0.0.1:8080/props',
        ],
        { maxBuffer: 65536 },
      ),
    ),
  );
  const response = run(
    'docker',
    [
      'exec',
      '-i',
      container.Id,
      'curl',
      '--fail',
      '--silent',
      '--max-time',
      '120',
      '--max-filesize',
      '16384',
      '-H',
      'Content-Type: application/json',
      '--data-binary',
      '@-',
      'http://127.0.0.1:8080/v1/chat/completions',
    ],
    { input: JSON.stringify(commercialLlmSyntheticRequest()), timeout: 125000, maxBuffer: 16384 },
  );
  validateCommercialLlmSyntheticResponse(JSON.parse(response));
  if (inspectContainer().Id !== container.Id) throw new Error('commercial_llm_generation_changed');
  emit('smoke', {
    result: 'closed-synthetic-json-v1',
    containerId: container.Id,
    modelSha256: pin.modelSha256,
  });
  return container;
}

function hasExactKeys(value, keys) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

export function validateCommercialLlmClientSmokeResponse(response) {
  const expectedCases = [
    { name: 'commercial-service', classification: 'COMMERCIAL' },
    { name: 'personal-used-item', classification: 'NOT_COMMERCIAL' },
  ];
  if (
    !hasExactKeys(response, [
      'ok',
      'casesPassed',
      'casesTotal',
      'modelSha256',
      'promptSha256',
      'cases',
    ]) ||
    response.ok !== true ||
    response.casesPassed !== 2 ||
    response.casesTotal !== 2 ||
    response.modelSha256 !== pin.modelSha256 ||
    response.promptSha256 !== pin.smokePromptSha256 ||
    !Array.isArray(response.cases) ||
    response.cases.length !== expectedCases.length ||
    !response.cases.every(
      (current, index) =>
        hasExactKeys(current, ['name', 'classification', 'durationMs']) &&
        current.name === expectedCases[index].name &&
        current.classification === expectedCases[index].classification &&
        Number.isFinite(current.durationMs) &&
        current.durationMs >= 0 &&
        current.durationMs <= 60000,
    )
  ) {
    throw new Error('commercial_llm_client_smoke_refused');
  }
  return {
    ok: true,
    casesPassed: 2,
    casesTotal: 2,
    modelSha256: pin.modelSha256,
    promptSha256: pin.smokePromptSha256,
    cases: response.cases.map(({ name, classification, durationMs }) => ({
      name,
      classification,
      durationMs,
    })),
  };
}

function inspectBackgroundClient() {
  run('node', ['infra/scripts/release-manifest.mjs', 'validate-current']);
  const manifest = readCurrentManifest('/var/lib/maxim-deploy');
  validateCompleteReleaseManifest(manifest);
  const imageId = manifest.components['api-shared'].imageId;
  const id = run('docker', [...composeArgs, 'ps', '-q', 'api-moderation-background']);
  if (!/^[0-9a-f]{64}$/u.test(id)) throw new Error('commercial_llm_client_singleton_required');
  const rows = JSON.parse(run('docker', ['inspect', id]));
  const client = rows[0];
  if (
    rows.length !== 1 ||
    client.Image !== imageId ||
    client.State?.Running !== true ||
    client.Config?.Labels?.['com.maxim.release-protected'] !== 'true' ||
    client.Config?.Labels?.['com.docker.compose.project'] !== 'infra' ||
    client.Config?.Labels?.['com.docker.compose.service'] !== 'api-moderation-background' ||
    client.Config?.Env?.filter((value) => value === 'APP_ROLE=moderation').length !== 1 ||
    client.Config?.Env?.filter((value) => value === 'APP_SERVICE_NAME=api-moderation-background')
      .length !== 1
  ) {
    throw new Error('commercial_llm_client_identity_refused');
  }
  return id;
}

function checkClient() {
  inspectBackgroundClient();
  inspectContainer();
  const response = JSON.parse(
    run(
      'docker',
      [
        ...composeArgs,
        'exec',
        '-T',
        'api-moderation-background',
        'node',
        'apps/api/dist/apps/api/src/scripts/commercial-llm-shadow-smoke.js',
      ],
      { timeout: 140000, maxBuffer: 16384 },
    ),
  );
  emit('check_client', validateCommercialLlmClientSmokeResponse(response));
}

// FLAG: One bounded observational SSH session; never hold the deployment lock or expose a port.
async function workstationBridge() {
  const id = inspectBackgroundClient();
  await new Promise((resolve, reject) => {
    const child = spawn(
      'docker',
      [
        'exec',
        '-i',
        id,
        'node',
        'apps/api/dist/apps/api/src/scripts/commercial-llm-workstation-bridge.js',
      ],
      { stdio: 'inherit', timeout: 31 * 60_000, killSignal: 'SIGTERM' },
    );
    const stop = () => child.kill('SIGTERM');
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
    child.once('error', () => reject(new Error('workstation_bridge_unavailable')));
    child.once('close', (code) => {
      process.removeListener('SIGTERM', stop);
      process.removeListener('SIGINT', stop);
      if (code === 0) resolve();
      else reject(new Error('workstation_bridge_unavailable'));
    });
  });
}

function checkWorkstation(expectPrimary) {
  const id = inspectBackgroundClient();
  const response = JSON.parse(
    run(
      'docker',
      [
        'exec',
        id,
        'node',
        'apps/api/dist/apps/api/src/scripts/commercial-llm-cascade-smoke.js',
        expectPrimary ? '--expect-primary' : '--expect-offline',
      ],
      { timeout: 115000, maxBuffer: 16384 },
    ),
  );
  emit('check_workstation', validateWorkstationSmokeResponse(response, expectPrimary));
}

export function validateWorkstationSmokeResponse(response, expectPrimary) {
  if (
    !hasExactKeys(response, [
      'ok',
      'casesPassed',
      'casesTotal',
      'expectPrimary',
      'cascadeVersion',
      'cases',
    ]) ||
    response.ok !== true ||
    response.casesPassed !== 2 ||
    response.casesTotal !== 2 ||
    response.expectPrimary !== expectPrimary ||
    response.cascadeVersion !== 'commercial-qwen4b9b-shadow-v1' ||
    !Array.isArray(response.cases) ||
    response.cases.length !== 2
  )
    throw new Error('workstation_smoke_refused');
  const expected = [
    {
      name: 'personal-used-item',
      classification: 'NOT_COMMERCIAL',
      route: expectPrimary ? 'primary' : 'secondary_unavailable',
    },
    {
      name: 'commercial-service',
      classification: 'COMMERCIAL',
      route: expectPrimary ? 'secondary_commercial' : 'secondary_unavailable',
    },
  ];
  for (let i = 0; i < expected.length; i++) {
    const item = response.cases[i];
    if (
      !hasExactKeys(item, [
        'name',
        'classification',
        'route',
        'modelAlias',
        'modelSha256',
        'promptSha256',
        'durationMs',
        'primaryDurationMs',
        'secondaryDurationMs',
      ]) ||
      item.modelAlias !==
        (expectPrimary && i === 0 ? WORKSTATION_IDENTITY.modelAlias : pin.alias) ||
      ![item.primaryDurationMs, item.secondaryDurationMs].every(
        (value) => value === null || (Number.isSafeInteger(value) && value >= 0 && value <= 80000),
      ) ||
      !Object.entries(expected[i]).every(([key, value]) => item[key] === value) ||
      item.promptSha256 !== pin.smokePromptSha256 ||
      item.modelSha256 !==
        (expectPrimary && i === 0 ? WORKSTATION_IDENTITY.modelSha256 : pin.modelSha256) ||
      !Number.isSafeInteger(item.durationMs) ||
      item.durationMs < 0 ||
      item.durationMs > 80000
    )
      throw new Error('workstation_smoke_refused');
  }
  return {
    ok: true,
    casesPassed: 2,
    casesTotal: 2,
    expectPrimary,
    cascadeVersion: response.cascadeVersion,
    cases: response.cases.map(
      ({
        name,
        classification,
        route,
        modelAlias,
        modelSha256,
        promptSha256,
        durationMs,
        primaryDurationMs,
        secondaryDurationMs,
      }) => ({
        name,
        classification,
        route,
        modelAlias,
        modelSha256,
        promptSha256,
        durationMs,
        primaryDurationMs,
        secondaryDurationMs,
      }),
    ),
  };
}

function buildReceipt(sourceSha, containerId) {
  const receipt = {
    schemaVersion: 1,
    sourceSha,
    installedAt: new Date().toISOString(),
    state: 'installed',
    containerId,
    imageRef: pin.imageRef,
    imageId: pin.imageId,
    modelSha256: pin.modelSha256,
    modelBytes: pin.modelBytes,
    modelManifestSha256: pin.modelManifestSha256,
    templateSha256: pin.templateSha256,
    licenseSha256: pin.licenseSha256,
    upstreamRevision: pin.upstreamRevision,
    upstreamVersion: pin.upstreamVersion,
    cpuLimit: pin.cpuLimit,
    memoryLimitBytes: pin.memoryLimitBytes,
    contextTokens: 4096,
    parallelRequests: 1,
    generationThreads: pin.cpuLimit,
    reasoning: false,
    smoke: 'closed-synthetic-json-v1',
  };
  assertCommercialLlmReceipt(receipt);
  return receipt;
}

async function install(sourceSha) {
  ensureDirectory(stateDir);
  ensureDirectory(modelDir);
  const existing = run('docker', [...composeArgs, 'ps', '-a', '-q', pin.service]);
  if (existing) {
    await reconcileCommercialLlmGeneration({
      operation: 'install',
      sourceSha,
      receipt: receiptPresent() ? readReceipt() : undefined,
      io: runtimeIo,
    });
    return;
  }
  if (receiptPresent()) {
    readReceipt();
    throw new Error('commercial_llm_recorded_generation_missing');
  }
  await prepareTargetArtifacts();
  await longCommand('docker', ['pull', '--platform', 'linux/amd64', pin.imageRef], {
    stage: 'image_pull',
    timeoutMs: 900000,
  });
  const image = JSON.parse(run('docker', ['image', 'inspect', pin.imageRef]));
  if (!Array.isArray(image) || image.length !== 1) {
    throw new Error('commercial_llm_image_pin_refused');
  }
  assertCommercialLlmImage(image[0]);
  emit('capacity', capacity(false));
  run(
    'docker',
    [
      ...composeArgs,
      '--profile',
      'commercial-llm',
      'up',
      '-d',
      '--no-deps',
      '--no-build',
      '--pull',
      'never',
      pin.service,
    ],
    { timeout: 60000 },
  );
  await waitUntilReady();
  const container = smoke();
  const receipt = buildReceipt(sourceSha, container.Id);
  atomicWrite(pin.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  emit('install', { result: 'installed', ...receipt });
}

async function waitUntilReady(expectedContainerId) {
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    const container = inspectContainer({ requireHealthy: false, requireRunning: false });
    if (expectedContainerId && container.Id !== expectedContainerId) {
      throw new Error('commercial_llm_generation_changed');
    }
    if (container.State?.Running === true && container.State?.Health?.Status === 'healthy') return;
    emit('model_readiness', { event: 'waiting', deadline: new Date(deadline).toISOString() });
    await new Promise((done) => setTimeout(done, 10000));
  }
  throw new Error('commercial_llm_readiness_deadline');
}

async function verifyPinnedArtifacts(profile = pin) {
  await checksum(profile.modelPath, profile.modelSha256, profile.modelBytes);
  if (profile.templateMode === 'file')
    await checksum(profile.templatePath, profile.templateSha256, profile.templateBytes);
  await checksum(profile.licensePath, profile.licenseSha256, profile.licenseBytes);
}

async function prepareTargetArtifacts() {
  emit('capacity', capacity(!existsSync(pin.modelPath)));
  if (!existsSync(pin.modelPath) && existsSync(pin.cachedModelPath)) {
    await checksum(pin.cachedModelPath, pin.modelSha256, pin.modelBytes);
    const partial = `${pin.modelPath}.partial`;
    if (!existsSync(partial)) {
      copyFileSync(pin.cachedModelPath, partial);
      chmodSync(partial, 0o444);
    }
  }
  await downloadArtifact({
    path: pin.modelPath,
    sha256: pin.modelSha256,
    bytes: pin.modelBytes,
    stage: 'model_download',
    url: pin.modelUrl,
  });
  await downloadArtifact({
    path: pin.licensePath,
    sha256: pin.licenseSha256,
    bytes: pin.licenseBytes,
    stage: 'license_download',
    url: pin.licenseUrl,
  });
  await verifyPinnedArtifacts();
  emit('capacity', capacity(false));
}

export function assertCommercialLlmTemplate(props) {
  const template = props?.chat_template;
  if (
    typeof template !== 'string' ||
    Buffer.byteLength(template) !== pin.templateBytes ||
    createHash('sha256').update(template).digest('hex') !== pin.templateSha256
  ) {
    throw new Error('commercial_llm_template_identity_refused');
  }
}

// FLAG: Recovery may adopt only a positively attested generation with all pinned artifacts.
// A present invalid receipt must never be interpreted as an interrupted unrecorded install.
export async function reconcileCommercialLlmGeneration({ operation, sourceSha, receipt, io }) {
  if (!['install', 'stop'].includes(operation) || !safeSha.test(sourceSha ?? '')) {
    throw new Error('commercial_llm_generation_operation_refused');
  }
  if (receipt !== undefined) assertCommercialLlmReceipt(receipt);
  const before = await io.inspect();
  assertCommercialLlmContainer(before, { requireHealthy: false, requireRunning: false });
  if (receipt && receipt.containerId !== before.Id) {
    throw new Error('commercial_llm_existing_runtime_receipt_mismatch');
  }
  await io.verifyArtifacts();
  const inspectSameGeneration = async (requireHealthy = false) => {
    const current = await io.inspect();
    assertCommercialLlmContainer(current, { requireHealthy, requireRunning: requireHealthy });
    if (current.Id !== before.Id) throw new Error('commercial_llm_generation_changed');
    return current;
  };
  let current = await inspectSameGeneration();
  if (operation === 'stop') {
    await io.stop(before.Id);
    current = await inspectSameGeneration();
    if (current.State?.Running !== false) throw new Error('commercial_llm_stop_readback_refused');
    if (receipt) {
      await io.record({ ...receipt, state: 'stopped', stoppedAt: new Date().toISOString() });
    }
    const outcome = {
      result: receipt ? 'stopped' : 'unrecorded_generation_stopped',
      containerId: before.Id,
      retainedArtifacts: true,
      successReceiptWritten: false,
      runtimeActivation: 'api_shadow_flag_requires_separate_disable_and_deploy',
    };
    io.emit('stop', outcome);
    return outcome;
  }
  const restarting = current.State?.Running !== true;
  if (restarting) {
    await io.capacity();
    await io.start(before.Id);
  }
  await io.waitReady(before.Id);
  const smoked = await io.smoke(before.Id);
  if (smoked?.Id !== before.Id) throw new Error('commercial_llm_generation_changed');
  await inspectSameGeneration(true);
  const nextReceipt = receipt
    ? { ...receipt, state: 'installed', validatedAt: new Date().toISOString() }
    : buildReceipt(sourceSha, before.Id);
  assertCommercialLlmReceipt(nextReceipt);
  await io.record(nextReceipt);
  const outcome = {
    result: receipt ? 'already_installed' : 'recovered_unrecorded_generation',
    sourceSha: nextReceipt.sourceSha,
    containerId: before.Id,
    successReceiptWritten: true,
  };
  io.emit('install', outcome);
  return outcome;
}

const runtimeIo = {
  inspect: () => inspectContainer({ requireHealthy: false, requireRunning: false }),
  verifyArtifacts: verifyPinnedArtifacts,
  capacity: () => emit('capacity', capacity(false)),
  start: (id) => run('docker', ['start', id], { timeout: 60000 }),
  stop: (id) => run('docker', ['stop', '--time', '30', id], { timeout: 40000 }),
  waitReady: waitUntilReady,
  smoke,
  record: (receipt) => atomicWrite(pin.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`),
  emit,
};

export function assertCommercialLlmTransition(value, sourceSha) {
  if (
    value?.schemaVersion !== 1 ||
    value.kind !== 'gemma4-to-qwen35-9b-v1' ||
    value.sourceSha !== sourceSha ||
    !safeSha.test(sourceSha ?? '') ||
    value.targetModelSha256 !== pin.modelSha256 ||
    !['prepared', 'started', 'complete'].includes(value.phase) ||
    !Number.isFinite(Date.parse(value.startedAt ?? '')) ||
    (value.targetContainerId !== null && !/^[0-9a-f]{64}$/u.test(value.targetContainerId ?? '')) ||
    (value.phase !== 'prepared' && value.targetContainerId === null)
  )
    throw new Error('commercial_llm_transition_refused');
  assertCommercialLlmReceipt(value.previousReceipt, COMMERCIAL_LLM_LEGACY_RUNTIME);
  return value;
}

// FLAG: Replacement stops only the captured, fully attested old generation before creating one
// target. The durable journal keeps its receipt; interruption never licenses an unrelated removal.
export async function replaceCommercialLlmGeneration({ sourceSha, receipt, transition, io }) {
  if (!safeSha.test(sourceSha ?? '')) throw new Error('commercial_llm_exact_source_required');
  let journal = transition;
  if (journal !== undefined) assertCommercialLlmTransition(journal, sourceSha);
  else assertCommercialLlmReceipt(receipt, COMMERCIAL_LLM_LEGACY_RUNTIME);

  const previous = journal?.previousReceipt ?? receipt;
  const currentIsTarget = receipt?.modelSha256 === pin.modelSha256;
  assertCommercialLlmReceipt(receipt, currentIsTarget ? pin : COMMERCIAL_LLM_LEGACY_RUNTIME);
  if (!currentIsTarget && JSON.stringify(receipt) !== JSON.stringify(previous))
    throw new Error('commercial_llm_transition_receipt_drift');
  if (currentIsTarget && (!journal || journal.targetContainerId !== receipt.containerId))
    throw new Error('commercial_llm_transition_receipt_drift');

  const attest = (container) => {
    if (!container) return null;
    const legacy =
      container.Config?.Labels?.['com.maxim.commercial-llm-model-sha256'] ===
      COMMERCIAL_LLM_LEGACY_RUNTIME.modelSha256;
    assertCommercialLlmContainer(container, {
      profile: legacy ? COMMERCIAL_LLM_LEGACY_RUNTIME : pin,
      requireHealthy: false,
      requireRunning: false,
    });
    if (
      legacy &&
      (container.Id !== previous.containerId || journal?.targetContainerId || currentIsTarget)
    )
      throw new Error('commercial_llm_generation_changed');
    if (
      !legacy &&
      (!journal || (journal.targetContainerId && container.Id !== journal.targetContainerId))
    )
      throw new Error('commercial_llm_generation_changed');
    return legacy ? 'legacy' : 'target';
  };
  let observed = await io.inspect();
  let kind = attest(observed);
  if (!journal && kind !== 'legacy') throw new Error('commercial_llm_recorded_generation_missing');
  if (journal?.targetContainerId && kind !== 'target')
    throw new Error('commercial_llm_recorded_generation_missing');
  if (journal?.phase === 'complete') {
    if (!currentIsTarget || receipt.state !== 'installed')
      throw new Error('commercial_llm_transition_receipt_drift');
    assertCommercialLlmContainer(observed);
    return { result: 'already_replaced', containerId: observed.Id };
  }
  await io.prepare();
  if (!journal) {
    journal = {
      schemaVersion: 1,
      kind: 'gemma4-to-qwen35-9b-v1',
      sourceSha,
      targetModelSha256: pin.modelSha256,
      phase: 'prepared',
      startedAt: new Date().toISOString(),
      previousReceipt: previous,
      targetContainerId: null,
    };
    await io.recordTransition(journal);
  }
  const capturedId = observed?.Id;
  observed = await io.inspect();
  kind = attest(observed);
  if (observed?.Id !== capturedId) throw new Error('commercial_llm_generation_changed');
  if (kind === 'legacy') {
    await io.stop(observed.Id);
    observed = await io.inspect();
    if (attest(observed) !== 'legacy' || observed.State?.Running !== false)
      throw new Error('commercial_llm_stop_readback_refused');
    await io.remove(observed.Id);
    observed = await io.inspect();
    if (observed) throw new Error('commercial_llm_generation_changed');
  }
  if (!observed) {
    await io.create();
    observed = await io.inspect();
    if (attest(observed) !== 'target') throw new Error('commercial_llm_target_missing');
  }
  if (!journal.targetContainerId) {
    journal = { ...journal, phase: 'started', targetContainerId: observed.Id };
    await io.recordTransition(journal);
  }
  const targetId = journal.targetContainerId;
  observed = await io.inspect();
  if (attest(observed) !== 'target') throw new Error('commercial_llm_target_missing');
  if (!observed.State.Running) await io.start(targetId);
  await io.waitReady(targetId);
  const smoked = await io.smoke(targetId);
  if (smoked?.Id !== targetId) throw new Error('commercial_llm_generation_changed');
  observed = await io.inspect();
  if (attest(observed) !== 'target') throw new Error('commercial_llm_target_missing');
  assertCommercialLlmContainer(observed);
  const nextReceipt = currentIsTarget ? receipt : buildReceipt(sourceSha, targetId);
  await io.record(nextReceipt);
  await io.recordTransition({
    ...journal,
    phase: 'complete',
    completedAt: new Date().toISOString(),
  });
  return { result: 'replaced', containerId: targetId, retainedPreviousArtifacts: true };
}

async function replace(sourceSha) {
  ensureDirectory(stateDir);
  ensureDirectory(modelDir);
  assertSafeFile(pin.receiptPath, { maximumBytes: 16384 });
  const receipt = JSON.parse(readFileSync(pin.receiptPath, 'utf8'));
  let transition;
  if (lstatSync(pin.transitionPath, { throwIfNoEntry: false }) !== undefined) {
    assertSafeFile(pin.transitionPath, { maximumBytes: 32768 });
    transition = JSON.parse(readFileSync(pin.transitionPath, 'utf8'));
  }
  const outcome = await replaceCommercialLlmGeneration({
    sourceSha,
    receipt,
    transition,
    io: {
      ...runtimeIo,
      inspect: () => {
        const ids = run('docker', [...composeArgs, 'ps', '-a', '-q', pin.service]);
        if (!ids) return null;
        if (!/^[0-9a-f]{64}$/u.test(ids)) throw new Error('commercial_llm_singleton_required');
        const rows = JSON.parse(run('docker', ['inspect', ids]));
        if (rows.length !== 1) throw new Error('commercial_llm_singleton_required');
        const profile =
          rows[0].Config?.Labels?.['com.maxim.commercial-llm-model-sha256'] ===
          COMMERCIAL_LLM_LEGACY_RUNTIME.modelSha256
            ? COMMERCIAL_LLM_LEGACY_RUNTIME
            : pin;
        const verified = inspectContainer({
          requireHealthy: false,
          requireRunning: false,
          profile,
        });
        if (verified.Id !== ids) throw new Error('commercial_llm_generation_changed');
        return verified;
      },
      prepare: async () => {
        await verifyPinnedArtifacts(COMMERCIAL_LLM_LEGACY_RUNTIME);
        await prepareTargetArtifacts();
        const images = JSON.parse(run('docker', ['image', 'inspect', pin.imageRef]));
        if (images.length !== 1) throw new Error('commercial_llm_image_pin_refused');
        assertCommercialLlmImage(images[0]);
      },
      remove: (id) => run('docker', ['rm', id]),
      create: () =>
        run(
          'docker',
          [
            ...composeArgs,
            '--profile',
            'commercial-llm',
            'up',
            '-d',
            '--no-deps',
            '--no-build',
            '--pull',
            'never',
            pin.service,
          ],
          { timeout: 60000 },
        ),
      recordTransition: (value) => {
        assertCommercialLlmTransition(value, sourceSha);
        atomicWrite(pin.transitionPath, `${JSON.stringify(value, null, 2)}\n`);
      },
    },
  });
  emit('replace', outcome);
}

function status() {
  if (!receiptPresent()) {
    const existing = run('docker', [...composeArgs, 'ps', '-a', '-q', pin.service]);
    emit('status', { installed: false, unrecordedContainerPresent: existing !== '' });
    if (existing) throw new Error('commercial_llm_unrecorded_runtime');
    return;
  }
  const receipt = readReceipt();
  if (receipt.state === 'stopped') {
    const ids = run('docker', [...composeArgs, 'ps', '-q', pin.service]);
    if (ids) throw new Error('commercial_llm_stopped_receipt_runtime_drift');
    emit('status', receipt);
    return;
  }
  const container = inspectContainer();
  if (container.Id !== receipt.containerId) throw new Error('commercial_llm_receipt_runtime_drift');
  emit('status', {
    ...receipt,
    running: true,
    healthy: true,
    restartCount: container.RestartCount,
    cpuLimit: pin.cpuLimit,
    memoryLimitBytes: pin.memoryLimitBytes,
  });
}

async function cli(argv) {
  const [operation = 'status', ...args] = argv;
  if (
    ![
      'install',
      'replace',
      'status',
      'stop',
      'enable',
      'disable',
      'smoke',
      'check-client',
      'workstation-bridge',
      'check-workstation',
      'check-workstation-offline',
    ].includes(operation) ||
    args.some((arg) => arg !== '--apply') ||
    args.length > 1 ||
    ([
      'status',
      'smoke',
      'check-client',
      'workstation-bridge',
      'check-workstation',
      'check-workstation-offline',
    ].includes(operation) &&
      args.length)
  ) {
    throw new Error(
      'Usage: commercial-llm install|replace|enable|disable|stop [--apply] | status | smoke | check-client',
    );
  }
  if (operation === 'status') return status();
  if (operation === 'smoke') return smoke();
  if (operation === 'check-client') return checkClient();
  if (operation === 'workstation-bridge') return workstationBridge();
  if (operation === 'check-workstation') return checkWorkstation(true);
  if (operation === 'check-workstation-offline') return checkWorkstation(false);
  const sourceSha = process.env.MAXIM_EXPECTED_DEPLOY_SHA;
  sourceAdmission(sourceSha);
  if (!args.includes('--apply')) {
    emit('preview', {
      operation,
      sourceSha,
      imageRef: pin.imageRef,
      modelSha256: pin.modelSha256,
      modelBytes: pin.modelBytes,
      cpuLimit: pin.cpuLimit,
      memoryLimitBytes: pin.memoryLimitBytes,
    });
    return;
  }
  if (operation === 'install') return install(sourceSha);
  if (operation === 'replace') return replace(sourceSha);
  if (operation === 'enable' || operation === 'disable') {
    if (operation === 'enable') {
      const receipt = readReceipt();
      const container = inspectContainer();
      if (receipt.state !== 'installed' || receipt.containerId !== container.Id)
        throw new Error('commercial_llm_enable_receipt_refused');
      smoke();
    }
    assertSafeFile('.env', { maximumBytes: 1024 * 1024 });
    atomicWrite(
      '.env',
      patchCommercialLlmEnvironment(readFileSync('.env', 'utf8'), operation === 'enable'),
    );
    emit(operation, {
      result: 'environment_staged',
      enabled: operation === 'enable',
      runtimeActivation: 'requires_normal_api_deploy',
    });
    return;
  }
  await reconcileCommercialLlmGeneration({
    operation: 'stop',
    sourceSha,
    receipt: receiptPresent() ? readReceipt() : undefined,
    io: runtimeIo,
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  cli(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
