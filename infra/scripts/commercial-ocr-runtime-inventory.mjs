#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const MAX_INSPECT_BYTES = 16 * 1024 * 1024;
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
      const imageMatches = expectedImageId !== null && imageId === expectedImageId;
      const imageIsReviewed = expectedImageId === null || imageMatches;
      const apiRoleSignal = appRole !== null && API_ROLES.has(appRole);
      const apiLikeService = isApiLikeService(composeService);
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
        ownedName;
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

  const ownedUnreviewedIds = [];
  const ambiguousIds = [];
  for (const container of candidates) {
    const reviewed =
      container.project === expectedProject &&
      expected.has(container.composeService) &&
      container.appService === container.composeService &&
      container.appRole === expectedAppRoleByService[container.composeService] &&
      container.imageIsReviewed &&
      reviewedCounts.get(container.composeService) === 1;
    if (reviewed) continue;
    (container.owned ? ownedUnreviewedIds : ambiguousIds).push(container.id);
  }
  ownedUnreviewedIds.sort(compareStrings);
  ambiguousIds.sort(compareStrings);
  return Object.freeze({
    ownedUnreviewedIds: Object.freeze(ownedUnreviewedIds),
    ambiguousIds: Object.freeze(ambiguousIds),
  });
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
  const candidates = ['api', ...expectedServices];
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
  const [expectedImageIdRaw, ...expectedServices] = argv;
  if (expectedServices.length !== 13 || new Set(expectedServices).size !== 13) {
    throw new Error(
      'Usage: commercial-ocr-runtime-inventory.mjs <none|expected-image-id> <13 expected services>',
    );
  }
  const expectedImageId = expectedImageIdRaw === 'none' ? null : expectedImageIdRaw;
  const raw = readFileSync(0, 'utf8');
  if (Buffer.byteLength(raw, 'utf8') > MAX_INSPECT_BYTES) {
    throw new Error('Docker inspection exceeds the inventory limit.');
  }
  const inventory = classifyCommercialOcrApiContainerInventory(
    JSON.parse(raw),
    expectedServices,
    expectedImageId,
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
