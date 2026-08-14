#!/usr/bin/env node

import {
  chmodSync,
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const MAX_CHAT_IDS = 10_000;
const MAX_CHAT_IDS_FILE_BYTES = 1024 * 1024;
export const MAX_COMMERCIAL_OCR_ROLLOUT_ENV_ENTRY_BYTES = 96 * 1024;
const MAX_CONTROL_AUDIT_INPUT_BYTES = 8 * 1024;
const MAX_CERTIFICATION_VERIFICATION_BYTES = 32 * 1024;
const MAX_CERTIFIED_SETTINGS_FINGERPRINTS = 32;
const MAX_PROMOTABLE_EXPECTED_REVISION = Number.MAX_SAFE_INTEGER - 2;
const exactChatIdPattern = /^-?[1-9]\d{0,18}$/u;
const gitShaPattern = /^[a-f0-9]{40}$/u;
const sha256Pattern = /^[a-f0-9]{64}$/u;
const allowedEnvKeys = new Set(['COMMERCIAL_OCR_ROLLOUT_MODE', 'COMMERCIAL_OCR_CANARY_CHAT_IDS']);
const productionAppRoleByService = Object.freeze({
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
});

export function normalizeCommercialOcrRolloutChatIds(contents) {
  if (Buffer.byteLength(contents, 'utf8') > MAX_CHAT_IDS_FILE_BYTES) {
    throw new Error(`Chat id input must be at most ${MAX_CHAT_IDS_FILE_BYTES} bytes.`);
  }
  const values = String(contents).split(/\r?\n/u);
  const normalized = new Set();
  for (const [index, raw] of values.entries()) {
    const value = raw.trim();
    if (!value || value.startsWith('#')) {
      continue;
    }
    if (!exactChatIdPattern.test(value)) {
      throw new Error(`Invalid exact MAX chat id on line ${index + 1}.`);
    }
    normalized.add(value);
    if (normalized.size > MAX_CHAT_IDS) {
      throw new Error(`Chat id input must contain at most ${MAX_CHAT_IDS} unique ids.`);
    }
  }
  if (normalized.size === 0) {
    throw new Error('Chat id input must contain at least one exact MAX chat id.');
  }
  const ids = [...normalized].sort(compareIntegerStrings);
  assertCommercialOcrRolloutEnvEntryFits(ids);
  return ids;
}

export function patchCommercialOcrRolloutEnv(contents, updates) {
  const keys = Object.keys(updates);
  if (keys.length === 0 || keys.some((key) => !allowedEnvKeys.has(key))) {
    throw new Error('Only the reviewed commercial OCR rollout env keys may be updated.');
  }
  for (const [key, value] of Object.entries(updates)) {
    if (typeof value !== 'string' || /[\r\n\0]/u.test(value)) {
      throw new Error(`${key} must be a single-line dotenv value.`);
    }
  }

  const hasTrailingNewline = contents.endsWith('\n');
  const lines = String(contents).split(/\n/u);
  if (hasTrailingNewline) {
    lines.pop();
  }
  const seen = new Set();
  const patched = lines.map((line) => {
    const match = /^[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=/u.exec(line);
    if (!match || !Object.hasOwn(updates, match[1])) {
      return line;
    }
    if (seen.has(match[1])) {
      throw new Error(`Duplicate dotenv key: ${match[1]}.`);
    }
    seen.add(match[1]);
    return `${match[1]}=${updates[match[1]]}`;
  });
  for (const key of keys) {
    if (!seen.has(key)) {
      patched.push(`${key}=${updates[key]}`);
    }
  }
  return `${patched.join('\n')}\n`;
}

export function buildCommercialOcrRolloutEnvUpdates(mode, cohort = null) {
  if (mode === 'canary') {
    assertNormalizedCohort(cohort);
    const ids = cohort.ids.join(',');
    return {
      COMMERCIAL_OCR_ROLLOUT_MODE: 'canary',
      COMMERCIAL_OCR_CANARY_CHAT_IDS: ids,
    };
  }
  if (mode === 'shadow' && cohort === null) {
    return {
      COMMERCIAL_OCR_ROLLOUT_MODE: 'shadow',
      COMMERCIAL_OCR_CANARY_CHAT_IDS: '',
    };
  }
  throw new Error('Rollout environment mode must be shadow or canary with a normalized cohort.');
}

export function verifyCommercialOcrRuntimeEnv(
  environment,
  mode,
  version,
  serviceName,
  cohort = null,
) {
  const identityMatches = verifyCommercialOcrRuntimeIdentity(environment, version, serviceName);
  const expected = buildCommercialOcrRolloutEnvUpdates(mode, cohort);
  return (
    identityMatches &&
    environment.COMMERCIAL_OCR_ROLLOUT_MODE === expected.COMMERCIAL_OCR_ROLLOUT_MODE &&
    environment.COMMERCIAL_OCR_CANARY_CHAT_IDS === expected.COMMERCIAL_OCR_CANARY_CHAT_IDS
  );
}

export function verifyCommercialOcrRuntimeIdentity(environment, version, serviceName) {
  if (!environment || typeof environment !== 'object' || Array.isArray(environment)) {
    throw new Error('Container rollout environment is not a JSON object.');
  }
  if (typeof version !== 'string' || version.length < 1 || /[\0\r\n]/u.test(version)) {
    throw new Error('Expected OCR version must be a non-empty single-line value.');
  }
  if (!Object.hasOwn(productionAppRoleByService, serviceName)) {
    throw new Error('Expected API service must be one of the reviewed production roles.');
  }
  const expectedAppRole = productionAppRoleByService[serviceName];
  return (
    environment.APP_SERVICE_NAME === serviceName &&
    environment.APP_ROLE === expectedAppRole &&
    environment.COMMERCIAL_OCR_VERSION === version
  );
}

export function writeFileAtomic(path, contents) {
  const target = resolve(path);
  const mode = statSync(target).mode & 0o777;
  const temporary = resolve(
    dirname(target),
    `.${basename(target)}.${process.pid}.${Date.now()}.tmp`,
  );
  try {
    writeFileSync(temporary, contents, { mode });
    chmodSync(temporary, mode);
    const descriptor = openSync(temporary, 'r');
    // Flush the replacement before the rename; the original remains intact on failure.
    try {
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    renameSync(temporary, target);
    const directoryDescriptor = openSync(dirname(target), 'r');
    // Persist the directory entry so a completed replacement survives a crash.
    try {
      fsyncSync(directoryDescriptor);
    } finally {
      closeSync(directoryDescriptor);
    }
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

export function digestCommercialOcrRolloutChatIds(ids) {
  return createHash('sha256')
    .update(`${ids.join('\n')}\n`)
    .digest('hex');
}

export function buildCommercialOcrRuntimeControl({
  cohort,
  certification,
  expectedRevision,
  actor,
  reason,
  ttlSec,
  now,
}) {
  validateCommercialOcrRuntimeControlOptions({
    cohort,
    certification,
    expectedRevision,
    actor,
    reason,
    ttlSec,
  });
  const creationTime = now ?? new Date();
  if (!(creationTime instanceof Date) || !Number.isFinite(creationTime.getTime())) {
    throw new Error('Control creation time must be valid.');
  }
  const timestamp = creationTime.toISOString();
  const controlExpiresAt = new Date(creationTime.getTime() + ttlSec * 1_000).toISOString();
  if (Date.parse(controlExpiresAt) > Date.parse(certification.certificationExpiresAt)) {
    throw new Error('Runtime control must not outlive its certification.');
  }
  return {
    version: 1,
    revision: (expectedRevision ?? 0) + 1,
    mode: 'canary',
    enforcementChatIds: [...cohort.ids],
    certificationSha256: certification.certificationSha256,
    certificationExpiresAt: certification.certificationExpiresAt,
    approvalKeyIdSha256: certification.approvalKeyIdSha256,
    behaviorIdentitySha256: certification.behaviorIdentitySha256,
    certifiedSettingsFingerprints: [...certification.certifiedSettingsFingerprints],
    certifiedSettingsFingerprintSetSha256: certification.certifiedSettingsFingerprintSetSha256,
    actor,
    reason,
    createdAt: timestamp,
    updatedAt: timestamp,
    expiresAt: controlExpiresAt,
  };
}

export function validateCommercialOcrRuntimeControlOptions({
  cohort,
  certification,
  expectedRevision,
  actor,
  reason,
  ttlSec,
}) {
  validateCommercialOcrRuntimeControlBaseOptions({
    cohort,
    expectedRevision,
    actor,
    reason,
    ttlSec,
  });
  assertCertificationBinding(certification);
  return true;
}

function validateCommercialOcrRuntimeControlBaseOptions({
  cohort,
  expectedRevision,
  actor,
  reason,
  ttlSec,
}) {
  assertNormalizedCohort(cohort);
  if (
    expectedRevision !== null &&
    (!Number.isSafeInteger(expectedRevision) ||
      expectedRevision < 1 ||
      expectedRevision > MAX_PROMOTABLE_EXPECTED_REVISION)
  ) {
    throw new Error(
      'Expected revision must leave one increment for promotion and one for guarded clear.',
    );
  }
  assertAuditText('Actor', actor, 200);
  assertAuditText('Reason', reason, 1_000);
  if (!Number.isSafeInteger(ttlSec) || ttlSec < 60 || ttlSec > 86_400) {
    throw new Error('Control TTL must be an integer between 60 and 86400 seconds.');
  }
  return true;
}

export function parseCommercialOcrCertificationVerification(contents, expectedSha256) {
  const input = Buffer.isBuffer(contents) ? contents : Buffer.from(String(contents), 'utf8');
  if (input.byteLength < 1 || input.byteLength > MAX_CERTIFICATION_VERIFICATION_BYTES) {
    throw new Error('Certification verification output exceeds the private inspection limit.');
  }
  if (typeof expectedSha256 !== 'string' || !sha256Pattern.test(expectedSha256)) {
    throw new Error('Expected certification SHA-256 is invalid.');
  }
  const value = parseJsonSafely(
    input.toString('utf8'),
    'Certification verification output is not valid JSON.',
  );
  const expectedKeys = new Set([
    'valid',
    'certificationSha256',
    'sourceSha',
    'immutableImageSha256',
    'reportSha256',
    'corpusManifestSha256',
    'corpusDescriptorSha256',
    'behaviorIdentitySha256',
    'certifiedSettingsFingerprints',
    'certifiedSettingsFingerprintSetSha256',
    'approvalKeyIdSha256',
    'issuedAt',
    'expiresAt',
  ]);
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== expectedKeys.size ||
    Object.keys(value).some((key) => !expectedKeys.has(key)) ||
    value.valid !== true ||
    value.certificationSha256 !== expectedSha256 ||
    !gitShaPattern.test(value.sourceSha) ||
    [
      value.immutableImageSha256,
      value.reportSha256,
      value.corpusManifestSha256,
      value.corpusDescriptorSha256,
      value.approvalKeyIdSha256,
      value.behaviorIdentitySha256,
    ].some((digest) => typeof digest !== 'string' || !sha256Pattern.test(digest))
  ) {
    throw new Error('Certification verification output is not the strict trusted envelope.');
  }
  const issuedAt = parseCanonicalIsoTimestamp(
    value.issuedAt,
    'Certification verification issuedAt is invalid.',
  );
  const expiresAt = parseCanonicalIsoTimestamp(
    value.expiresAt,
    'Certification verification expiresAt is invalid.',
  );
  if (issuedAt >= expiresAt) {
    throw new Error('Certification verification timestamps are inconsistent.');
  }
  const binding = {
    certificationSha256: value.certificationSha256,
    certificationExpiresAt: value.expiresAt,
    approvalKeyIdSha256: value.approvalKeyIdSha256,
    behaviorIdentitySha256: value.behaviorIdentitySha256,
    certifiedSettingsFingerprints: value.certifiedSettingsFingerprints,
    certifiedSettingsFingerprintSetSha256: value.certifiedSettingsFingerprintSetSha256,
  };
  assertCertificationBinding(binding);
  return Object.freeze({
    ...binding,
    certifiedSettingsFingerprints: Object.freeze([...binding.certifiedSettingsFingerprints]),
  });
}

export function summarizeCommercialOcrRuntimeControlResult(
  result,
  cohort = null,
  now = new Date(),
) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new Error('Runtime-control output is not a JSON object.');
  }
  const expectedKeys = new Set([
    'apply',
    'beforeKind',
    'chatCount',
    'chatDigest',
    'command',
    'complete',
    'expiresAt',
    'kind',
    'mode',
    'resultKind',
    'revision',
  ]);
  const keys = Object.keys(result);
  if (keys.length !== expectedKeys.size || keys.some((key) => !expectedKeys.has(key))) {
    throw new Error('Runtime-control output is not the privacy-safe public envelope.');
  }
  if (
    !['get', 'set', 'clear'].includes(result.command) ||
    typeof result.apply !== 'boolean' ||
    typeof result.complete !== 'boolean' ||
    !['missing', 'invalid', 'expired', 'active'].includes(result.beforeKind) ||
    typeof result.resultKind !== 'string' ||
    !/^[a-z_]+$/u.test(result.resultKind)
  ) {
    throw new Error('Runtime-control output has an invalid command envelope.');
  }
  const allowedResultKinds =
    result.command === 'get'
      ? ['read']
      : result.apply
        ? result.command === 'set'
          ? ['applied', 'ambiguous', 'conflict']
          : ['ambiguous', 'cleared', 'conflict']
        : ['preview'];
  if (
    (result.command === 'get' && result.apply) ||
    !allowedResultKinds.includes(result.resultKind)
  ) {
    throw new Error('Runtime-control output has contradictory command metadata.');
  }
  if (cohort !== null) {
    assertNormalizedCohort(cohort);
  }
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new Error('Runtime-control evaluation time must be valid.');
  }
  const evaluatedAtMs = now.getTime();
  const evaluatedAt = now.toISOString();
  const summary = summarizePublicSnapshot(result, cohort, evaluatedAtMs);
  assertCommandSnapshotConsistency(result);
  return {
    command: result.command,
    complete: result.complete,
    resultKind: result.resultKind,
    beforeKind: result.beforeKind,
    evaluatedAt,
    ...summary,
  };
}

function assertCommandSnapshotConsistency(output) {
  if (output.command === 'get' || !output.apply) {
    const expectedComplete = output.command === 'get' ? output.kind !== 'invalid' : true;
    if (output.kind !== output.beforeKind || output.complete !== expectedComplete) {
      throw new Error('Runtime-control output has contradictory command metadata.');
    }
    return;
  }

  const successfulResultKind = output.command === 'set' ? 'applied' : 'cleared';
  const successfulSnapshotKind = output.command === 'set' ? 'active' : 'missing';
  if (
    output.complete &&
    (output.resultKind !== successfulResultKind || output.kind !== successfulSnapshotKind)
  ) {
    throw new Error('Runtime-control output has contradictory command metadata.');
  }
}

function summarizePublicSnapshot(output, cohort, evaluatedAtMs) {
  if (!['missing', 'invalid', 'expired', 'active'].includes(output.kind)) {
    throw new Error('Runtime-control output has an invalid snapshot kind.');
  }
  if (output.revision !== null && (!Number.isSafeInteger(output.revision) || output.revision < 1)) {
    throw new Error('Runtime-control output has an invalid revision.');
  }
  if (output.kind === 'missing' || output.kind === 'invalid') {
    if (
      output.mode !== null ||
      output.chatCount !== 0 ||
      output.chatDigest !== null ||
      output.expiresAt !== null
    ) {
      throw new Error('Runtime-control empty summary unexpectedly contains control metadata.');
    }
    return {
      kind: output.kind,
      revision: output.revision,
      mode: null,
      chatCount: 0,
      matchesCohort: cohort === null ? null : false,
      expiresAt: null,
      remainingTtlSec: null,
    };
  }
  if (
    !['off', 'shadow', 'canary', 'on'].includes(output.mode) ||
    output.revision === null ||
    !Number.isSafeInteger(output.chatCount) ||
    output.chatCount < 0 ||
    output.chatCount > MAX_CHAT_IDS ||
    typeof output.chatDigest !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(output.chatDigest)
  ) {
    throw new Error('Runtime-control active summary contains invalid control metadata.');
  }
  const isEnforcing = output.mode === 'canary' || output.mode === 'on';
  if (
    (isEnforcing && output.chatCount === 0) ||
    (!isEnforcing &&
      (output.chatCount !== 0 || output.chatDigest !== digestCommercialOcrRolloutChatIds([])))
  ) {
    throw new Error('Runtime-control active summary contradicts its rollout mode.');
  }
  const expiresAtMs = parseCanonicalIsoTimestamp(
    output.expiresAt,
    'Runtime-control active summary contains an invalid expiresAt.',
  );
  const expectedKind = expiresAtMs <= evaluatedAtMs ? 'expired' : 'active';
  if (output.kind !== expectedKind) {
    throw new Error('Runtime-control snapshot kind contradicts expiresAt at evaluation time.');
  }
  return {
    kind: output.kind,
    revision: output.revision,
    mode: output.mode,
    chatCount: output.chatCount,
    matchesCohort:
      cohort === null
        ? null
        : output.chatCount === cohort.ids.length &&
          output.chatDigest === digestCommercialOcrRolloutChatIds(cohort.ids),
    expiresAt: output.expiresAt,
    remainingTtlSec: Math.max(0, Math.ceil((expiresAtMs - evaluatedAtMs) / 1_000)),
  };
}

function parseCanonicalIsoTimestamp(value, errorMessage) {
  const timestamp = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    throw new Error(errorMessage);
  }
  return timestamp;
}

function parseJsonSafely(contents, errorMessage) {
  try {
    return JSON.parse(contents);
  } catch {
    throw new Error(errorMessage);
  }
}

function parseCanonicalPositiveInteger(value, errorMessage) {
  if (typeof value !== 'string' || !/^[1-9]\d*$/u.test(value)) {
    throw new Error(errorMessage);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(errorMessage);
  }
  return parsed;
}

export function parseCommercialOcrControlAuditInput(contents) {
  const input = Buffer.isBuffer(contents) ? contents : Buffer.from(String(contents), 'utf8');
  if (input.byteLength > MAX_CONTROL_AUDIT_INPUT_BYTES) {
    throw new Error('Control audit input exceeds the private inspection limit.');
  }
  const value = input.toString('utf8');
  const separator = value.indexOf('\0');
  if (separator < 0 || value.indexOf('\0', separator + 1) !== value.length - 1) {
    throw new Error('Control audit input is invalid.');
  }
  return {
    actor: value.slice(0, separator),
    reason: value.slice(separator + 1, -1),
  };
}

async function readBoundedStdin(maxBytes, errorMessage) {
  const chunks = [];
  let byteLength = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
    byteLength += buffer.byteLength;
    if (byteLength > maxBytes) {
      throw new Error(errorMessage);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function assertNormalizedCohort(cohort) {
  if (
    !cohort ||
    !Array.isArray(cohort.ids) ||
    cohort.ids.length < 1 ||
    cohort.ids.length > MAX_CHAT_IDS ||
    cohort.ids.some((value) => typeof value !== 'string' || !exactChatIdPattern.test(value)) ||
    new Set(cohort.ids).size !== cohort.ids.length ||
    cohort.ids.some(
      (value, index) => index > 0 && compareIntegerStrings(cohort.ids[index - 1], value) >= 0,
    ) ||
    cohort.count !== cohort.ids.length
  ) {
    throw new Error('Normalized chat cohort is invalid.');
  }
  assertCommercialOcrRolloutEnvEntryFits(cohort.ids);
}

function assertCommercialOcrRolloutEnvEntryFits(ids) {
  const serializedEntry = `COMMERCIAL_OCR_CANARY_CHAT_IDS=${ids.join(',')}\0`;
  if (Buffer.byteLength(serializedEntry, 'utf8') > MAX_COMMERCIAL_OCR_ROLLOUT_ENV_ENTRY_BYTES) {
    throw new Error('Normalized chat cohort exceeds the bounded rollout environment entry size.');
  }
}

function assertCertificationBinding(certification) {
  const certificationExpiresAtMs =
    certification && typeof certification.certificationExpiresAt === 'string'
      ? Date.parse(certification.certificationExpiresAt)
      : Number.NaN;
  if (
    !certification ||
    typeof certification !== 'object' ||
    Array.isArray(certification) ||
    typeof certification.certificationSha256 !== 'string' ||
    !sha256Pattern.test(certification.certificationSha256) ||
    !Number.isFinite(certificationExpiresAtMs) ||
    new Date(certificationExpiresAtMs).toISOString() !== certification.certificationExpiresAt ||
    typeof certification.approvalKeyIdSha256 !== 'string' ||
    !sha256Pattern.test(certification.approvalKeyIdSha256) ||
    typeof certification.behaviorIdentitySha256 !== 'string' ||
    !sha256Pattern.test(certification.behaviorIdentitySha256) ||
    !Array.isArray(certification.certifiedSettingsFingerprints) ||
    certification.certifiedSettingsFingerprints.length < 1 ||
    certification.certifiedSettingsFingerprints.length > MAX_CERTIFIED_SETTINGS_FINGERPRINTS ||
    certification.certifiedSettingsFingerprints.some(
      (fingerprint) => typeof fingerprint !== 'string' || !sha256Pattern.test(fingerprint),
    ) ||
    new Set(certification.certifiedSettingsFingerprints).size !==
      certification.certifiedSettingsFingerprints.length ||
    certification.certifiedSettingsFingerprints.some(
      (fingerprint, index) =>
        index > 0 &&
        certification.certifiedSettingsFingerprints[index - 1].localeCompare(fingerprint) >= 0,
    ) ||
    typeof certification.certifiedSettingsFingerprintSetSha256 !== 'string' ||
    !sha256Pattern.test(certification.certifiedSettingsFingerprintSetSha256) ||
    certification.certifiedSettingsFingerprintSetSha256 !==
      createHash('sha256')
        .update(`${certification.certifiedSettingsFingerprints.join('\n')}\n`)
        .digest('hex')
  ) {
    throw new Error('Certification runtime binding is invalid.');
  }
}

function assertAuditText(label, value, maxLength) {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > maxLength ||
    value !== value.trim() ||
    /[\0\r\n]/u.test(value)
  ) {
    throw new Error(`${label} must be a bounded single-line value without surrounding spaces.`);
  }
}

function compareIntegerStrings(left, right) {
  const leftNegative = left.startsWith('-');
  const rightNegative = right.startsWith('-');
  if (leftNegative !== rightNegative) {
    return leftNegative ? -1 : 1;
  }
  const leftDigits = leftNegative ? left.slice(1) : left;
  const rightDigits = rightNegative ? right.slice(1) : right;
  if (leftDigits.length !== rightDigits.length) {
    const order = leftDigits.length - rightDigits.length;
    return leftNegative ? -order : order;
  }
  const order = leftDigits.localeCompare(rightDigits);
  return leftNegative ? -order : order;
}

function parseCli(argv) {
  const [command, ...args] = argv;
  if (command === 'normalize-chat-ids' && args.length === 1) {
    return { command, input: args[0] };
  }
  if (
    command === 'patch-rollout-env' &&
    ((args[1] === 'shadow' && args.length === 2) || (args[1] === 'canary' && args.length === 3))
  ) {
    return { command, input: args[0], mode: args[1], cohort: args[2] ?? null };
  }
  if (
    command === 'verify-runtime-env' &&
    ((args[0] === 'shadow' && args.length === 3) || (args[0] === 'canary' && args.length === 4))
  ) {
    return {
      command,
      mode: args[0],
      version: args[1],
      serviceName: args[2],
      cohort: args[3] ?? null,
    };
  }
  if (command === 'verify-runtime-identity' && args.length === 2) {
    return { command, version: args[0], serviceName: args[1] };
  }
  if (command === 'validate-control-options' && args.length === 3) {
    return {
      command,
      cohort: args[0],
      expectedRevision: args[1],
      ttlSec: args[2],
    };
  }
  if (command === 'build-control' && args.length === 5) {
    return {
      command,
      cohort: args[0],
      expectedRevision: args[1],
      ttlSec: args[2],
      certificationVerification: args[3],
      expectedCertificationSha256: args[4],
    };
  }
  if (command === 'validate-certification-verification' && args.length === 2) {
    return {
      command,
      certificationVerification: args[0],
      expectedCertificationSha256: args[1],
    };
  }
  if (command === 'summarize-control') {
    if (args.length === 0) {
      return { command, cohort: null, now: null };
    }
    if (args.length === 1 && args[0] !== '--now') {
      return { command, cohort: args[0], now: null };
    }
    if (args.length === 2 && args[0] === '--now') {
      return { command, cohort: null, now: args[1] };
    }
    if (args.length === 3 && args[1] === '--now') {
      return { command, cohort: args[0], now: args[2] };
    }
  }
  throw new Error(
    'Usage: commercial-ocr-rollout-state.mjs normalize-chat-ids <file> | patch-rollout-env <env-file> shadow | patch-rollout-env <env-file> canary <cohort-json> | verify-runtime-identity <version> <service-name> | verify-runtime-env shadow <version> <service-name> | verify-runtime-env canary <version> <service-name> <cohort-json> | validate-control-options <cohort-json> <none|revision> <ttl-sec> <audit-stdin> | validate-certification-verification <verification-json> <expected-sha256> | build-control <cohort-json> <none|revision> <ttl-sec> <verification-json> <expected-sha256> <audit-stdin> | summarize-control [cohort-json] [--now <canonical-ISO-8601>]',
  );
}

async function main(argv) {
  const options = parseCli(argv);
  if (options.command === 'validate-certification-verification') {
    readCommercialOcrCertificationVerificationFile(
      options.certificationVerification,
      options.expectedCertificationSha256,
    );
    process.stdout.write('{"valid":true}\n');
    return;
  }
  if (options.command === 'normalize-chat-ids') {
    if (statSync(options.input).size > MAX_CHAT_IDS_FILE_BYTES) {
      throw new Error(`Chat id input must be at most ${MAX_CHAT_IDS_FILE_BYTES} bytes.`);
    }
    const ids = normalizeCommercialOcrRolloutChatIds(readFileSync(options.input, 'utf8'));
    process.stdout.write(`${JSON.stringify({ ids, count: ids.length })}\n`);
    return;
  }
  if (options.command === 'validate-control-options' || options.command === 'build-control') {
    const audit = parseCommercialOcrControlAuditInput(
      await readBoundedStdin(
        MAX_CONTROL_AUDIT_INPUT_BYTES,
        'Control audit input exceeds the private inspection limit.',
      ),
    );
    const cohort = parseJsonSafely(
      readFileSync(options.cohort, 'utf8'),
      'Normalized chat cohort JSON is invalid.',
    );
    const expectedRevision =
      options.expectedRevision === 'none'
        ? null
        : parseCanonicalPositiveInteger(
            options.expectedRevision,
            'Expected revision must be none or a canonical positive integer.',
          );
    const controlOptions = {
      cohort,
      ...(options.command === 'build-control'
        ? {
            certification: readCommercialOcrCertificationVerificationFile(
              options.certificationVerification,
              options.expectedCertificationSha256,
            ),
          }
        : {}),
      expectedRevision,
      actor: audit.actor,
      reason: audit.reason,
      ttlSec: parseCanonicalPositiveInteger(
        options.ttlSec,
        'Control TTL must be a canonical positive integer.',
      ),
    };
    if (options.command === 'validate-control-options') {
      validateCommercialOcrRuntimeControlBaseOptions(controlOptions);
      process.stdout.write('{"valid":true}\n');
      return;
    }
    const control = buildCommercialOcrRuntimeControl(controlOptions);
    process.stdout.write(`${JSON.stringify(control)}\n`);
    return;
  }
  if (options.command === 'summarize-control') {
    const raw = readFileSync(0, 'utf8');
    if (Buffer.byteLength(raw, 'utf8') > 1024 * 1024) {
      throw new Error('Runtime-control output exceeds the inspection limit.');
    }
    const cohort = options.cohort
      ? parseJsonSafely(
          readFileSync(options.cohort, 'utf8'),
          'Normalized chat cohort JSON is invalid.',
        )
      : null;
    const now =
      options.now === null
        ? new Date()
        : new Date(
            parseCanonicalIsoTimestamp(
              options.now,
              'Runtime-control --now must be a canonical ISO-8601 UTC value.',
            ),
          );
    process.stdout.write(
      `${JSON.stringify(
        summarizeCommercialOcrRuntimeControlResult(
          parseJsonSafely(raw, 'Runtime-control output is not valid JSON.'),
          cohort,
          now,
        ),
      )}\n`,
    );
    return;
  }
  if (options.command === 'verify-runtime-identity') {
    const raw = readFileSync(0, 'utf8');
    if (Buffer.byteLength(raw, 'utf8') > 32 * 1024) {
      throw new Error('Container rollout environment exceeds the inspection limit.');
    }
    if (
      !verifyCommercialOcrRuntimeIdentity(
        parseJsonSafely(raw, 'Container rollout environment is not valid JSON.'),
        options.version,
        options.serviceName,
      )
    ) {
      throw new Error('Container does not match the expected runtime identity.');
    }
    return;
  }
  const cohort = options.cohort
    ? parseJsonSafely(
        readFileSync(options.cohort, 'utf8'),
        'Normalized chat cohort JSON is invalid.',
      )
    : null;
  if (options.command === 'verify-runtime-env') {
    const raw = readFileSync(0, 'utf8');
    if (Buffer.byteLength(raw, 'utf8') > 32 * 1024) {
      throw new Error('Container rollout environment exceeds the inspection limit.');
    }
    if (
      !verifyCommercialOcrRuntimeEnv(
        parseJsonSafely(raw, 'Container rollout environment is not valid JSON.'),
        options.mode,
        options.version,
        options.serviceName,
        cohort,
      )
    ) {
      throw new Error('Container does not match the expected rollout environment.');
    }
    return;
  }
  const updates = buildCommercialOcrRolloutEnvUpdates(options.mode, cohort);
  const contents = readFileSync(options.input, 'utf8');
  const patched = patchCommercialOcrRolloutEnv(contents, updates);
  writeFileAtomic(options.input, patched);
  process.stdout.write(`${JSON.stringify({ updatedKeys: Object.keys(updates).sort() })}\n`);
}

function readCommercialOcrCertificationVerificationFile(path, expectedSha256) {
  const metadata = statSync(path);
  if (
    !metadata.isFile() ||
    metadata.size < 1 ||
    metadata.size > MAX_CERTIFICATION_VERIFICATION_BYTES
  ) {
    throw new Error('Certification verification file size is invalid.');
  }
  return parseCommercialOcrCertificationVerification(readFileSync(path), expectedSha256);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  });
}
