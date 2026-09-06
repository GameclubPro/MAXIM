#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const MAX_INSPECT_BYTES = 16 * 1024 * 1024;
const OCR_NATIVE_SANDBOX_SERVICE = 'ocr-native-sandbox';
const OCR_NATIVE_SANDBOX_COMMAND = Object.freeze([
  'node',
  'apps/api/dist/apps/api/src/moderation/commercial-ocr/native-ocr-sandbox.entrypoint.js',
]);
const OCR_NATIVE_SANDBOX_REQUIRED_ENV = Object.freeze({
  NODE_ENV: 'production',
  COMMERCIAL_OCR_NATIVE_SANDBOX_SOCKET_PATH: '/run/maxim-ocr/native-ocr.sock',
  PHOTO_DUPLICATE_MAX_BYTES: '16777216',
  COMMERCIAL_OCR_MAX_INPUT_PIXELS: '40000000',
  COMMERCIAL_OCR_MAX_OUTPUT_PIXELS: '3000000',
  COMMERCIAL_OCR_MAX_SIDE: '2000',
  COMMERCIAL_OCR_TESSERACT_BINARY: 'tesseract',
  COMMERCIAL_OCR_TESSERACT_CONCURRENCY: '1',
  COMMERCIAL_OCR_TESSERACT_MAX_QUEUE: '4',
  COMMERCIAL_OCR_TESSERACT_TIMEOUT_MS: '10000',
  COMMERCIAL_OCR_TESSERACT_RECYCLE_AFTER_JOBS: '250',
  COMMERCIAL_OCR_TESSERACT_MAX_IMAGE_BYTES: '16777216',
  COMMERCIAL_OCR_TESSERACT_MAX_OUTPUT_BYTES: '4194304',
  OMP_THREAD_LIMIT: '1',
});
const OCR_NATIVE_SANDBOX_ALLOWED_IMAGE_ENV = new Set([
  'HOME',
  'NODE_EXTRA_CA_CERTS',
  'NODE_VERSION',
  'PATH',
  'YARN_VERSION',
]);
const API_ROLES = new Set([
  'all',
  'ingress',
  'admin',
  'enqueue',
  'moderation',
  'action',
  'publisher',
]);
const imageIdPattern = /^sha256:[a-f0-9]{64}$/u;
const expectedAppRoleByService = Object.freeze({
  'api-ingress': 'ingress',
  'api-admin': 'admin',
  'api-enqueue': 'enqueue',
  'api-moderation': 'moderation',
  'api-moderation-critical': 'moderation',
  'api-moderation-join': 'moderation',
  'api-moderation-realtime-b': 'moderation',
  'api-moderation-realtime-c': 'moderation',
  'api-moderation-realtime-d': 'moderation',
  'api-moderation-background': 'moderation',
  'api-media-analysis': 'moderation',
  'api-action': 'action',
  'api-publisher': 'publisher',
});

export function classifyCommercialOcrApiContainerInventory(
  inspection,
  expectedServices,
  expectedImageId = null,
  expectedProject = 'infra',
  expectedAuxiliaryService = null,
) {
  if (!Array.isArray(inspection)) {
    throw new Error('Docker inspection must be an array.');
  }
  const expected = new Set(expectedServices);
  if (expected.size !== expectedServices.length || expected.size !== 13) {
    throw new Error('Commercial OCR inventory requires 13 unique expected services.');
  }
  if (expectedImageId !== null && !imageIdPattern.test(expectedImageId)) {
    throw new Error('Commercial OCR inventory expected image id is invalid.');
  }
  if (
    expectedAuxiliaryService !== null &&
    expectedAuxiliaryService !== OCR_NATIVE_SANDBOX_SERVICE
  ) {
    throw new Error('Commercial OCR inventory expected auxiliary service is invalid.');
  }

  const candidates = inspection
    .filter((container) => container?.State?.Running === true)
    .map((container) => {
      const labels = container?.Config?.Labels ?? {};
      const environment = parseEnvironment(container?.Config?.Env);
      const project = readOptionalString(labels['com.docker.compose.project']);
      const composeService = readOptionalString(labels['com.docker.compose.service']);
      const appService = readOptionalString(environment.APP_SERVICE_NAME);
      const appRole = readOptionalString(environment.APP_ROLE);
      const ocrVersion = readOptionalString(environment.COMMERCIAL_OCR_VERSION);
      const name = readOptionalString(container?.Name);
      const imageId = readOptionalString(container?.Image);
      const ownedName = isExpectedProjectApiContainerName(name, expectedProject, expectedServices);
      const releaseProtected = labels['com.maxim.release-protected'] === 'true';
      const ocrNativeSandbox = labels['com.maxim.ocr-native-sandbox'] === 'true';
      const ocrNativeSandboxCapable = labels['com.maxim.ocr-native-sandbox-capable'] === 'true';
      const imageMatches = expectedImageId !== null && imageId === expectedImageId;
      const imageIsReviewed = expectedImageId === null || imageMatches;
      const apiRoleSignal = appRole !== null && API_ROLES.has(appRole);
      const apiLikeService = isApiLikeService(composeService);
      const ocrNativeSandboxSignal =
        ocrNativeSandbox ||
        composeService === OCR_NATIVE_SANDBOX_SERVICE ||
        isExpectedComposeServiceContainerName(name, expectedProject, OCR_NATIVE_SANDBOX_SERVICE) ||
        hasExactStringArray(container?.Config?.Cmd, OCR_NATIVE_SANDBOX_COMMAND);
      const protectedApiSignal =
        releaseProtected &&
        (apiRoleSignal ||
          apiLikeService ||
          isApiLikeService(appService) ||
          isApiLikeContainerName(name) ||
          ocrVersion !== null ||
          imageMatches ||
          ownedName);
      const maximSpecificSignal =
        expected.has(composeService) ||
        expected.has(appService) ||
        ocrVersion !== null ||
        protectedApiSignal ||
        imageMatches ||
        ownedName ||
        ocrNativeSandboxSignal;
      const candidate =
        (project === expectedProject && (apiLikeService || apiRoleSignal || maximSpecificSignal)) ||
        maximSpecificSignal ||
        (apiLikeService && apiRoleSignal);
      return {
        id: readContainerId(container?.Id),
        project,
        composeService,
        appService,
        appRole,
        imageIsReviewed,
        candidate,
        owned: project === expectedProject || (project === null && ownedName),
        auxiliaryCandidate: ocrNativeSandboxSignal,
        reviewedAuxiliary:
          expectedAuxiliaryService === OCR_NATIVE_SANDBOX_SERVICE &&
          project === expectedProject &&
          composeService === OCR_NATIVE_SANDBOX_SERVICE &&
          name !== null &&
          isExpectedComposeServiceContainerName(
            name,
            expectedProject,
            OCR_NATIVE_SANDBOX_SERVICE,
          ) &&
          imageIsReviewed &&
          releaseProtected &&
          ocrNativeSandbox &&
          ocrNativeSandboxCapable &&
          appService === null &&
          appRole === null &&
          ocrVersion === null &&
          isReviewedOcrNativeSandboxRuntime(container, expectedProject),
      };
    })
    .filter((container) => container.candidate);

  const reviewedCounts = new Map();
  for (const container of candidates) {
    if (
      container.project === expectedProject &&
      expected.has(container.composeService) &&
      container.appService === container.composeService &&
      container.appRole === expectedAppRoleByService[container.composeService] &&
      container.imageIsReviewed
    ) {
      reviewedCounts.set(
        container.composeService,
        (reviewedCounts.get(container.composeService) ?? 0) + 1,
      );
    }
  }

  const reviewedAuxiliaryCount = candidates.filter(
    (container) => container.reviewedAuxiliary,
  ).length;
  const auxiliaryCandidateCount = candidates.filter(
    (container) => container.auxiliaryCandidate,
  ).length;

  const ownedUnreviewedIds = [];
  const ambiguousIds = [];
  for (const container of candidates) {
    const reviewedRole =
      !container.auxiliaryCandidate &&
      container.project === expectedProject &&
      expected.has(container.composeService) &&
      container.appService === container.composeService &&
      container.appRole === expectedAppRoleByService[container.composeService] &&
      container.imageIsReviewed &&
      reviewedCounts.get(container.composeService) === 1;
    const reviewedAuxiliary =
      container.reviewedAuxiliary && reviewedAuxiliaryCount === 1 && auxiliaryCandidateCount === 1;
    const reviewed = reviewedRole || reviewedAuxiliary;
    if (reviewed) continue;
    (container.owned ? ownedUnreviewedIds : ambiguousIds).push(container.id);
  }
  ownedUnreviewedIds.sort(compareStrings);
  ambiguousIds.sort(compareStrings);
  return Object.freeze({
    ownedUnreviewedIds: Object.freeze(ownedUnreviewedIds),
    ambiguousIds: Object.freeze(ambiguousIds),
    expectedAuxiliaryCount: expectedAuxiliaryService === null ? 0 : 1,
    reviewedAuxiliaryCount,
  });
}

function isReviewedOcrNativeSandboxRuntime(container, expectedProject) {
  const config = container?.Config ?? {};
  const state = container?.State ?? {};
  const hostConfig = container?.HostConfig ?? {};
  return (
    state.Running === true &&
    state.Status === 'running' &&
    state?.Health?.Status === 'healthy' &&
    config.User === '1000:1000' &&
    hasExactStringArray(config.Cmd, OCR_NATIVE_SANDBOX_COMMAND) &&
    isExactOcrNativeSandboxEnvironment(config.Env) &&
    hostConfig.NetworkMode === 'none' &&
    hostConfig.ReadonlyRootfs === true &&
    hostConfig.Init === true &&
    hostConfig.Memory === 1024 ** 3 &&
    hostConfig.NanoCpus === 1_000_000_000 &&
    hostConfig.PidsLimit === 128 &&
    hasExactStringArray(hostConfig.CapDrop, ['ALL']) &&
    hasExactStringArray(hostConfig.SecurityOpt, ['no-new-privileges:true']) &&
    hasExactSandboxTmpfs(hostConfig.Tmpfs) &&
    hasExactSandboxMount(container?.Mounts, expectedProject)
  );
}

function isExactOcrNativeSandboxEnvironment(value) {
  if (!Array.isArray(value)) return false;
  const environment = new Map();
  for (const entry of value) {
    if (typeof entry !== 'string') return false;
    const separator = entry.indexOf('=');
    if (separator < 1) return false;
    const key = entry.slice(0, separator);
    if (environment.has(key)) return false;
    if (
      !Object.hasOwn(OCR_NATIVE_SANDBOX_REQUIRED_ENV, key) &&
      !OCR_NATIVE_SANDBOX_ALLOWED_IMAGE_ENV.has(key)
    ) {
      return false;
    }
    environment.set(key, entry.slice(separator + 1));
  }
  return Object.entries(OCR_NATIVE_SANDBOX_REQUIRED_ENV).every(
    ([key, expectedValue]) => environment.get(key) === expectedValue,
  );
}

function hasExactSandboxTmpfs(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  if (entries.length !== 1 || entries[0][0] !== '/tmp' || typeof entries[0][1] !== 'string') {
    return false;
  }
  const options = new Map();
  const flags = new Set();
  for (const option of entries[0][1].split(',')) {
    const separator = option.indexOf('=');
    if (separator < 1) {
      if (option !== 'rw' || flags.has(option)) return false;
      flags.add(option);
      continue;
    }
    const key = option.slice(0, separator);
    if (options.has(key)) return false;
    options.set(key, option.slice(separator + 1));
  }
  return (
    options.size === 4 &&
    flags.size <= 1 &&
    ['64m', '64M', String(64 * 1024 * 1024)].includes(options.get('size')) &&
    options.get('mode') === '1777' &&
    options.get('uid') === '1000' &&
    options.get('gid') === '1000'
  );
}

function hasExactSandboxMount(value, expectedProject) {
  if (!Array.isArray(value) || value.length !== 1) return false;
  const mount = value[0];
  return (
    mount !== null &&
    typeof mount === 'object' &&
    mount.Type === 'volume' &&
    mount.Name === `${expectedProject}_ocr_native_ipc` &&
    mount.Destination === '/run/maxim-ocr' &&
    mount.RW === true &&
    mount.Mode === 'rw'
  );
}

function hasExactStringArray(value, expected) {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    value.every((entry, index) => entry === expected[index])
  );
}

function parseEnvironment(value) {
  if (!Array.isArray(value)) return {};
  const result = {};
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    const separator = entry.indexOf('=');
    if (separator < 1) continue;
    result[entry.slice(0, separator)] = entry.slice(separator + 1);
  }
  return result;
}

function isApiLikeService(value) {
  return typeof value === 'string' && /^api(?:-|$)/u.test(value);
}

function isApiLikeContainerName(value) {
  if (typeof value !== 'string') return false;
  const normalizedName = value.startsWith('/') ? value.slice(1) : value;
  return /(?:^|[-_])api(?:[-_]|$)/u.test(normalizedName);
}

function isExpectedProjectApiContainerName(value, expectedProject, expectedServices) {
  if (typeof value !== 'string') return false;
  const candidates = ['api', OCR_NATIVE_SANDBOX_SERVICE, ...expectedServices];
  return candidates.some(
    (service) =>
      value === `/${expectedProject}-${service}-1` ||
      value === `/${expectedProject}_${service}_1` ||
      new RegExp(
        `^/${escapeRegExp(expectedProject)}(?:-|_)${escapeRegExp(service)}(?:-|_)[1-9]\\d*$`,
        'u',
      ).test(value),
  );
}

function isExpectedComposeServiceContainerName(value, expectedProject, service) {
  return (
    value === `/${expectedProject}-${service}-1` || value === `/${expectedProject}_${service}_1`
  );
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function readOptionalString(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function readContainerId(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{12,64}$/u.test(value)) {
    throw new Error('Docker inspection contains an invalid container id.');
  }
  return value;
}

function main(argv) {
  const [expectedImageIdRaw, expectedAuxiliaryRaw, ...expectedServices] = argv;
  if (
    !['none', OCR_NATIVE_SANDBOX_SERVICE].includes(expectedAuxiliaryRaw) ||
    expectedServices.length !== 13 ||
    new Set(expectedServices).size !== 13
  ) {
    throw new Error(
      'Usage: commercial-ocr-runtime-inventory.mjs <none|expected-image-id> <none|ocr-native-sandbox> <13 expected services>',
    );
  }
  const expectedImageId = expectedImageIdRaw === 'none' ? null : expectedImageIdRaw;
  const expectedAuxiliaryService = expectedAuxiliaryRaw === 'none' ? null : expectedAuxiliaryRaw;
  const raw = readFileSync(0, 'utf8');
  if (Buffer.byteLength(raw, 'utf8') > MAX_INSPECT_BYTES) {
    throw new Error('Docker inspection exceeds the inventory limit.');
  }
  const inventory = classifyCommercialOcrApiContainerInventory(
    JSON.parse(raw),
    expectedServices,
    expectedImageId,
    'infra',
    expectedAuxiliaryService,
  );
  process.stdout.write(`${JSON.stringify(inventory)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
