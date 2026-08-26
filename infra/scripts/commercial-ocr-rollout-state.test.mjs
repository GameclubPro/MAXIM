import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  statSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import {
  buildCommercialOcrRolloutEnvUpdates,
  buildCommercialOcrRuntimeControl,
  digestCommercialOcrRolloutChatIds,
  MAX_COMMERCIAL_OCR_ROLLOUT_ENV_ENTRY_BYTES,
  normalizeCommercialOcrRolloutChatIds,
  parseCommercialOcrCertificationVerification,
  parseCommercialOcrControlAuditInput,
  patchCommercialOcrRolloutEnv,
  summarizeCommercialOcrRuntimeControlResult,
  validateCommercialOcrRuntimeControlOptions,
  verifyCommercialOcrRuntimeEnv,
  verifyCommercialOcrRuntimeIdentity,
  writeFileAtomic,
} from './commercial-ocr-rollout-state.mjs';

function cohort() {
  const ids = ['-12', '42'];
  return { ids, count: ids.length };
}

function certificationBinding() {
  const certifiedSettingsFingerprints = ['7'.repeat(64), '8'.repeat(64)];
  return {
    certificationSha256: 'a'.repeat(64),
    certificationExpiresAt: '2026-09-13T10:00:00.000Z',
    approvalKeyIdSha256: '1'.repeat(64),
    behaviorIdentitySha256: '2'.repeat(64),
    certifiedSettingsFingerprints,
    certifiedSettingsFingerprintSetSha256: createHash('sha256')
      .update(`${certifiedSettingsFingerprints.join('\n')}\n`)
      .digest('hex'),
  };
}

function certificationVerification(overrides = {}) {
  const { certificationExpiresAt, ...binding } = certificationBinding();
  return {
    valid: true,
    ...binding,
    sourceSha: 'b'.repeat(40),
    immutableImageSha256: 'c'.repeat(64),
    reportSha256: 'd'.repeat(64),
    corpusManifestSha256: 'e'.repeat(64),
    corpusDescriptorSha256: 'f'.repeat(64),
    issuedAt: '2026-08-14T10:00:00.000Z',
    expiresAt: certificationExpiresAt,
    ...overrides,
  };
}

function publicControlOutput(overrides = {}) {
  const target = cohort();
  return {
    command: 'get',
    apply: false,
    complete: true,
    resultKind: 'read',
    beforeKind: 'active',
    kind: 'active',
    revision: 1,
    mode: 'canary',
    chatCount: target.count,
    chatDigest: digestCommercialOcrRolloutChatIds(target.ids),
    expiresAt: '2026-08-14T11:00:00.000Z',
    ...overrides,
  };
}

test('normalizes exact numeric MAX chat ids deterministically', () => {
  const ids = normalizeCommercialOcrRolloutChatIds(
    ['# reviewed cohort', ' 42 ', '-70000000000001', '42', '-12', '7', ''].join('\n'),
  );

  assert.deepEqual(ids, ['-70000000000001', '-12', '7', '42']);
  assert.match(digestCommercialOcrRolloutChatIds(ids), /^[0-9a-f]{64}$/u);
});

test('rejects empty, wildcard, unsafe and oversized cohorts without echoing values', () => {
  for (const input of ['', '*', 'chat-1', '0', '+123', '1,2', '12\0']) {
    assert.throws(() => normalizeCommercialOcrRolloutChatIds(input), /chat id/u);
  }
  assert.throws(
    () => normalizeCommercialOcrRolloutChatIds('1\n'.repeat(600_000)),
    /at most 1048576 bytes/u,
  );
});

test('rejects a serialized cohort before it can exceed the Linux environment-entry limit', () => {
  const ids = Array.from({ length: 5_000 }, (_, index) =>
    (1_000_000_000_000_000_000n + BigInt(index)).toString(),
  );

  assert.ok(MAX_COMMERCIAL_OCR_ROLLOUT_ENV_ENTRY_BYTES < 128 * 1024);
  assert.throws(
    () => normalizeCommercialOcrRolloutChatIds(ids.join('\n')),
    /bounded rollout environment entry size/u,
  );
  assert.throws(
    () => buildCommercialOcrRolloutEnvUpdates('canary', { ids, count: ids.length }),
    /bounded rollout environment entry size/u,
  );
});

test('rejects an oversized sparse chat id file before the CLI reads it', () => {
  const directory = mkdtempSync(join(tmpdir(), 'maxim-ocr-oversized-cohort-'));
  const inputPath = join(directory, 'chat-ids.txt');
  writeFileSync(inputPath, '', { mode: 0o600 });
  truncateSync(inputPath, 64 * 1024 * 1024);
  chmodSync(inputPath, 0o000);

  const normalized = spawnSync(
    process.execPath,
    [import.meta.filename.replace(/\.test\.mjs$/u, '.mjs'), 'normalize-chat-ids', inputPath],
    { encoding: 'utf8' },
  );

  assert.equal(normalized.status, 2);
  assert.equal(normalized.stdout, '');
  assert.match(normalized.stderr, /at most 1048576 bytes/u);
});

test('normalizes a private cohort without publishing a stable cohort digest', () => {
  const directory = mkdtempSync(join(tmpdir(), 'maxim-ocr-normalized-cohort-'));
  const inputPath = join(directory, 'chat-ids.txt');
  writeFileSync(inputPath, '42\n-12\n', { mode: 0o600 });

  const normalized = spawnSync(
    process.execPath,
    [import.meta.filename.replace(/\.test\.mjs$/u, '.mjs'), 'normalize-chat-ids', inputPath],
    { encoding: 'utf8' },
  );

  assert.equal(normalized.status, 0, normalized.stderr);
  assert.deepEqual(JSON.parse(normalized.stdout), { ids: ['-12', '42'], count: 2 });
  assert.doesNotMatch(normalized.stdout, /digest|[a-f0-9]{64}/u);
});

test('patches only allowlisted dotenv keys while preserving unrelated bytes', () => {
  const source = [
    '# keep this comment',
    'SECRET=value with spaces',
    'COMMERCIAL_OCR_ROLLOUT_MODE=shadow',
    'MODERATION_DELETE_INTENT_MODE=shadow',
    '',
  ].join('\n');
  const patched = patchCommercialOcrRolloutEnv(source, {
    COMMERCIAL_OCR_ROLLOUT_MODE: 'canary',
    COMMERCIAL_OCR_CANARY_CHAT_IDS: '-12,42',
  });

  assert.match(patched, /^# keep this comment\nSECRET=value with spaces\n/mu);
  assert.match(patched, /^COMMERCIAL_OCR_ROLLOUT_MODE=canary$/mu);
  assert.match(patched, /^MODERATION_DELETE_INTENT_MODE=shadow$/mu);
  assert.match(patched, /^COMMERCIAL_OCR_CANARY_CHAT_IDS=-12,42$/mu);
  assert.doesNotMatch(patched, /^MODERATION_DELETE_INTENT_CANARY_CHAT_IDS=/mu);
  assert.throws(
    () => patchCommercialOcrRolloutEnv(source, { REDIS_URL: 'redis://secret' }),
    /reviewed commercial OCR rollout env keys/u,
  );
  assert.throws(
    () => patchCommercialOcrRolloutEnv(source, { MODERATION_DELETE_INTENT_MODE: 'canary' }),
    /reviewed commercial OCR rollout env keys/u,
  );
});

test('rejects duplicate rollout keys and atomically preserves the env file mode', () => {
  assert.throws(
    () =>
      patchCommercialOcrRolloutEnv(
        ' export COMMERCIAL_OCR_ROLLOUT_MODE = shadow\nCOMMERCIAL_OCR_ROLLOUT_MODE=off\n',
        { COMMERCIAL_OCR_ROLLOUT_MODE: 'canary' },
      ),
    /Duplicate dotenv key/u,
  );

  const directory = mkdtempSync(join(tmpdir(), 'maxim-ocr-rollout-'));
  const path = join(directory, '.env');
  writeFileSync(path, 'UNCHANGED=1\n', { mode: 0o600 });
  writeFileAtomic(path, 'UNCHANGED=1\nCOMMERCIAL_OCR_ROLLOUT_MODE=shadow\n');

  assert.equal(readFileSync(path, 'utf8'), 'UNCHANGED=1\nCOMMERCIAL_OCR_ROLLOUT_MODE=shadow\n');
  assert.equal(statSync(path).mode & 0o777, 0o600);
});

test('builds and verifies matching shadow and canary runtime environments', () => {
  const target = cohort();
  const canary = buildCommercialOcrRolloutEnvUpdates('canary', target);
  const shadow = buildCommercialOcrRolloutEnvUpdates('shadow');

  assert.deepEqual(canary, {
    COMMERCIAL_OCR_ROLLOUT_MODE: 'canary',
    COMMERCIAL_OCR_CANARY_CHAT_IDS: '-12,42',
  });
  assert.equal(
    verifyCommercialOcrRuntimeEnv(
      {
        ...canary,
        APP_ROLE: 'moderation',
        APP_SERVICE_NAME: 'api-moderation',
        COMMERCIAL_OCR_VERSION: 'tesseract-rus-eng-v2',
        MODERATION_DELETE_INTENT_MODE: 'shadow',
        MODERATION_DELETE_INTENT_CANARY_CHAT_IDS: 'unrelated-chat',
      },
      'canary',
      'tesseract-rus-eng-v2',
      'api-moderation',
      target,
    ),
    true,
  );
  assert.equal(
    verifyCommercialOcrRuntimeEnv(
      {
        ...shadow,
        APP_ROLE: 'moderation',
        APP_SERVICE_NAME: 'api-media-analysis',
        COMMERCIAL_OCR_VERSION: 'tesseract-rus-eng-v1',
      },
      'shadow',
      'tesseract-rus-eng-v2',
      'api-media-analysis',
    ),
    false,
  );
  assert.throws(() => buildCommercialOcrRolloutEnvUpdates('canary'), /chat cohort is invalid/iu);
});

test('verifies the exact APP_SERVICE_NAME and APP_ROLE identity for all 13 production roles', () => {
  const shadow = buildCommercialOcrRolloutEnvUpdates('shadow');
  const identities = [
    ['api-ingress', 'ingress'],
    ['api-admin', 'admin'],
    ['api-enqueue', 'enqueue'],
    ['api-moderation', 'moderation'],
    ['api-moderation-critical', 'moderation'],
    ['api-moderation-join', 'moderation'],
    ['api-moderation-realtime-b', 'moderation'],
    ['api-moderation-realtime-c', 'moderation'],
    ['api-moderation-realtime-d', 'moderation'],
    ['api-moderation-background', 'moderation'],
    ['api-media-analysis', 'moderation'],
    ['api-action', 'action'],
    ['api-publisher', 'publisher'],
  ];

  for (const [serviceName, appRole] of identities) {
    const environment = {
      ...shadow,
      APP_ROLE: appRole,
      APP_SERVICE_NAME: serviceName,
      COMMERCIAL_OCR_VERSION: 'tesseract-rus-eng-v2',
    };
    assert.equal(
      verifyCommercialOcrRuntimeEnv(environment, 'shadow', 'tesseract-rus-eng-v2', serviceName),
      true,
    );
    assert.equal(
      verifyCommercialOcrRuntimeIdentity(
        {
          APP_ROLE: appRole,
          APP_SERVICE_NAME: serviceName,
          COMMERCIAL_OCR_VERSION: 'tesseract-rus-eng-v2',
          COMMERCIAL_OCR_ROLLOUT_MODE: 'ignored-by-identity-check',
        },
        'tesseract-rus-eng-v2',
        serviceName,
      ),
      true,
    );
    assert.equal(
      verifyCommercialOcrRuntimeEnv(
        { ...environment, APP_ROLE: 'action' },
        'shadow',
        'tesseract-rus-eng-v2',
        serviceName,
      ),
      appRole === 'action',
    );
    assert.equal(
      verifyCommercialOcrRuntimeEnv(
        { ...environment, APP_SERVICE_NAME: 'api-wrong' },
        'shadow',
        'tesseract-rus-eng-v2',
        serviceName,
      ),
      false,
    );
  }
  assert.throws(
    () => verifyCommercialOcrRuntimeEnv({}, 'shadow', 'tesseract-rus-eng-v2', 'api-unreviewed'),
    /reviewed production roles/u,
  );
  assert.equal(
    verifyCommercialOcrRuntimeIdentity(
      {
        APP_ROLE: 'admin',
        APP_SERVICE_NAME: 'api-admin',
        COMMERCIAL_OCR_VERSION: 'wrong-version',
      },
      'tesseract-rus-eng-v2',
      'api-admin',
    ),
    false,
  );
});

test('keeps cohort ids out of patch and runtime verification command output', () => {
  const directory = mkdtempSync(join(tmpdir(), 'maxim-ocr-rollout-cli-'));
  const cohortPath = join(directory, 'cohort.json');
  const envPath = join(directory, '.env');
  const target = cohort();
  writeFileSync(cohortPath, JSON.stringify(target), { mode: 0o600 });
  writeFileSync(envPath, 'UNCHANGED=1\n', { mode: 0o600 });

  const patch = spawnSync(
    process.execPath,
    [
      import.meta.filename.replace(/\.test\.mjs$/u, '.mjs'),
      'patch-rollout-env',
      envPath,
      'canary',
      cohortPath,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(patch.status, 0, patch.stderr);
  assert.doesNotMatch(`${patch.stdout}${patch.stderr}`, /-12|42/u);

  const verify = spawnSync(
    process.execPath,
    [
      import.meta.filename.replace(/\.test\.mjs$/u, '.mjs'),
      'verify-runtime-env',
      'canary',
      'tesseract-rus-eng-v2',
      'api-moderation',
      cohortPath,
    ],
    {
      encoding: 'utf8',
      input: JSON.stringify({
        ...buildCommercialOcrRolloutEnvUpdates('canary', target),
        APP_ROLE: 'moderation',
        APP_SERVICE_NAME: 'api-moderation',
        COMMERCIAL_OCR_VERSION: 'tesseract-rus-eng-v2',
      }),
    },
  );
  assert.equal(verify.status, 0, verify.stderr);
  assert.equal(verify.stdout, '');
  assert.doesNotMatch(verify.stderr, /-12|42/u);
});

test('verifies runtime identity through bounded stdin without inspecting rollout fields', () => {
  const helper = import.meta.filename.replace(/\.test\.mjs$/u, '.mjs');
  const environment = {
    APP_ROLE: 'admin',
    APP_SERVICE_NAME: 'api-admin',
    COMMERCIAL_OCR_VERSION: 'tesseract-rus-eng-v2',
    COMMERCIAL_OCR_ROLLOUT_MODE: 'intentionally-ignored',
    COMMERCIAL_OCR_CANARY_CHAT_IDS: '-12,42',
  };
  const verified = spawnSync(
    process.execPath,
    [helper, 'verify-runtime-identity', 'tesseract-rus-eng-v2', 'api-admin'],
    { encoding: 'utf8', input: JSON.stringify(environment) },
  );

  assert.equal(verified.status, 0, verified.stderr);
  assert.equal(verified.stdout, '');

  const oversized = spawnSync(
    process.execPath,
    [helper, 'verify-runtime-identity', 'tesseract-rus-eng-v2', 'api-admin'],
    { encoding: 'utf8', input: JSON.stringify({ ...environment, padding: 'x'.repeat(33_000) }) },
  );
  assert.equal(oversized.status, 2);
  assert.match(oversized.stderr, /exceeds the inspection limit/u);
});

test('validates every control option separately before constructing a control', () => {
  const options = {
    cohort: cohort(),
    certification: certificationBinding(),
    expectedRevision: 4,
    actor: 'operator:test',
    reason: 'bounded OCR canary',
    ttlSec: 3_600,
  };

  assert.equal(validateCommercialOcrRuntimeControlOptions(options), true);
  assert.equal(
    validateCommercialOcrRuntimeControlOptions({
      ...options,
      expectedRevision: Number.MAX_SAFE_INTEGER - 2,
    }),
    true,
  );
  assert.throws(
    () =>
      validateCommercialOcrRuntimeControlOptions({ ...options, cohort: { ...cohort(), count: 1 } }),
    /cohort is invalid/u,
  );
  assert.throws(
    () =>
      validateCommercialOcrRuntimeControlOptions({
        ...options,
        expectedRevision: Number.MAX_SAFE_INTEGER - 1,
      }),
    /Expected revision/u,
  );
  assert.throws(
    () => validateCommercialOcrRuntimeControlOptions({ ...options, actor: ' operator:test' }),
    /Actor/u,
  );
  assert.throws(
    () => validateCommercialOcrRuntimeControlOptions({ ...options, reason: 'line one\nline two' }),
    /Reason/u,
  );
  assert.throws(
    () => validateCommercialOcrRuntimeControlOptions({ ...options, ttlSec: 59 }),
    /Control TTL/u,
  );
  assert.throws(
    () =>
      validateCommercialOcrRuntimeControlOptions({
        ...options,
        certification: {
          ...certificationBinding(),
          certifiedSettingsFingerprintSetSha256: '0'.repeat(64),
        },
      }),
    /runtime binding/u,
  );
  assert.throws(
    () =>
      validateCommercialOcrRuntimeControlOptions({
        ...options,
        certification: {
          ...certificationBinding(),
          certificationExpiresAt: '2026-09-13T10:00:00Z',
        },
      }),
    /runtime binding/u,
  );
});

test('accepts only the strict verifier output bound to the reviewed certification digest', () => {
  const verification = certificationVerification();
  assert.deepEqual(
    parseCommercialOcrCertificationVerification(
      JSON.stringify(verification),
      verification.certificationSha256,
    ),
    certificationBinding(),
  );
  for (const mutation of [
    { certificationSha256: '0'.repeat(64) },
    { approvalKeyIdSha256: '0'.repeat(63) },
    { behaviorIdentitySha256: '0'.repeat(63) },
    { certifiedSettingsFingerprints: ['8'.repeat(64), '7'.repeat(64)] },
    { certifiedSettingsFingerprintSetSha256: '0'.repeat(64) },
    { expiresAt: '2026-09-13T10:00:00Z' },
    { valid: false },
    { extra: true },
  ]) {
    assert.throws(
      () =>
        parseCommercialOcrCertificationVerification(
          JSON.stringify({ ...verification, ...mutation }),
          verification.certificationSha256,
        ),
      /verification|runtime binding/u,
    );
  }
});

test('parses bounded private audit fields without accepting ambiguous framing', () => {
  assert.deepEqual(parseCommercialOcrControlAuditInput('operator:test\0bounded canary\0'), {
    actor: 'operator:test',
    reason: 'bounded canary',
  });
  for (const value of [
    'operator:test',
    'operator:test\0reason',
    'operator:test\0reason\0extra\0',
    Buffer.alloc(8 * 1024 + 1, 'x'),
  ]) {
    assert.throws(() => parseCommercialOcrControlAuditInput(value), /audit input/u);
  }
});

test('preflights control options privately and leaves timestamp creation to build-control', () => {
  const directory = mkdtempSync(join(tmpdir(), 'maxim-ocr-control-cli-'));
  const cohortPath = join(directory, 'cohort.json');
  const verificationPath = join(directory, 'certification-verification.json');
  const target = cohort();
  const verification = certificationVerification();
  const helper = import.meta.filename.replace(/\.test\.mjs$/u, '.mjs');
  writeFileSync(cohortPath, JSON.stringify(target), { mode: 0o600 });
  writeFileSync(verificationPath, JSON.stringify(verification), { mode: 0o600 });

  const preflightArgs = [helper, 'validate-control-options', cohortPath, '4', '3600'];
  const preflight = spawnSync(process.execPath, preflightArgs, {
    encoding: 'utf8',
    input: 'sensitive-operator\0sensitive-reason\0',
  });
  assert.equal(preflight.status, 0, preflight.stderr);
  assert.equal(preflight.stdout, '{"valid":true}\n');
  assert.doesNotMatch(preflightArgs.join(' '), /sensitive/u);
  assert.doesNotMatch(`${preflight.stdout}${preflight.stderr}`, /-12|42|sensitive/u);

  const startedAt = Date.now();
  const built = spawnSync(
    process.execPath,
    [
      helper,
      'build-control',
      cohortPath,
      '4',
      '3600',
      verificationPath,
      verification.certificationSha256,
    ],
    {
      encoding: 'utf8',
      input: 'operator:test\0bounded OCR canary\0',
    },
  );
  const finishedAt = Date.now();
  assert.equal(built.status, 0, built.stderr);
  const control = JSON.parse(built.stdout);
  assert.ok(Date.parse(control.createdAt) >= startedAt);
  assert.ok(Date.parse(control.createdAt) <= finishedAt);
  assert.equal(Date.parse(control.expiresAt) - Date.parse(control.createdAt), 3_600_000);
  assert.equal(control.certificationSha256, verification.certificationSha256);
  assert.equal(control.certificationExpiresAt, verification.expiresAt);
  assert.equal(control.approvalKeyIdSha256, verification.approvalKeyIdSha256);
  assert.equal(control.behaviorIdentitySha256, verification.behaviorIdentitySha256);
  assert.deepEqual(
    control.certifiedSettingsFingerprints,
    verification.certifiedSettingsFingerprints,
  );
  assert.equal(
    control.certifiedSettingsFingerprintSetSha256,
    verification.certifiedSettingsFingerprintSetSha256,
  );

  const oversized = spawnSync(
    process.execPath,
    [helper, 'validate-control-options', cohortPath, '4', '3600'],
    { encoding: 'utf8', input: `operator:test\0${'x'.repeat(8 * 1024)}\0` },
  );
  assert.equal(oversized.status, 2);
  assert.match(oversized.stderr, /private inspection limit/u);

  for (const args of [
    [helper, 'validate-control-options', cohortPath, '1e2', '3600'],
    [helper, 'validate-control-options', cohortPath, '4', '3.6e3'],
  ]) {
    const nonCanonical = spawnSync(process.execPath, args, {
      encoding: 'utf8',
      input: 'operator:test\0bounded OCR canary\0',
    });
    assert.equal(nonCanonical.status, 2);
    assert.match(nonCanonical.stderr, /canonical positive integer/u);
  }
});

test('builds a bounded canary control from a normalized cohort', () => {
  const built = buildCommercialOcrRuntimeControl({
    cohort: cohort(),
    certification: certificationBinding(),
    expectedRevision: 4,
    actor: 'operator:test',
    reason: 'bounded OCR canary',
    ttlSec: 3_600,
    now: new Date('2026-08-14T10:00:00.000Z'),
  });

  assert.deepEqual(built, {
    version: 1,
    revision: 5,
    mode: 'canary',
    enforcementChatIds: ['-12', '42'],
    ...certificationBinding(),
    actor: 'operator:test',
    reason: 'bounded OCR canary',
    createdAt: '2026-08-14T10:00:00.000Z',
    updatedAt: '2026-08-14T10:00:00.000Z',
    expiresAt: '2026-08-14T11:00:00.000Z',
  });
  assert.throws(
    () =>
      buildCommercialOcrRuntimeControl({
        cohort: cohort(),
        certification: certificationBinding(),
        expectedRevision: 4,
        actor: 'operator:test',
        reason: 'bounded OCR canary',
        ttlSec: 86_401,
      }),
    /Control TTL/u,
  );
  assert.doesNotThrow(() =>
    buildCommercialOcrRuntimeControl({
      cohort: cohort(),
      certification: {
        ...certificationBinding(),
        certificationExpiresAt: '2026-08-14T11:00:00.000Z',
      },
      expectedRevision: 4,
      actor: 'operator:test',
      reason: 'bounded OCR canary',
      ttlSec: 3_600,
      now: new Date('2026-08-14T10:00:00.000Z'),
    }),
  );
  assert.throws(
    () =>
      buildCommercialOcrRuntimeControl({
        cohort: cohort(),
        certification: {
          ...certificationBinding(),
          certificationExpiresAt: '2026-08-14T10:59:59.999Z',
        },
        expectedRevision: 4,
        actor: 'operator:test',
        reason: 'bounded OCR canary',
        ttlSec: 3_600,
        now: new Date('2026-08-14T10:00:00.000Z'),
      }),
    /must not outlive its certification/u,
  );
});

test('summarizes the public control envelope without requiring chat ids or audit text', () => {
  const target = cohort();
  const summary = summarizeCommercialOcrRuntimeControlResult(
    publicControlOutput({
      command: 'set',
      apply: true,
      complete: true,
      resultKind: 'applied',
      beforeKind: 'missing',
    }),
    target,
    new Date('2026-08-14T10:30:00.000Z'),
  );

  assert.deepEqual(summary, {
    command: 'set',
    complete: true,
    resultKind: 'applied',
    beforeKind: 'missing',
    evaluatedAt: '2026-08-14T10:30:00.000Z',
    kind: 'active',
    revision: 1,
    mode: 'canary',
    chatCount: 2,
    matchesCohort: true,
    expiresAt: '2026-08-14T11:00:00.000Z',
    remainingTtlSec: 1_800,
  });
  assert.doesNotMatch(
    JSON.stringify(summary),
    /-12|42|actor|reason|enforcementChatIds|approvalKeyIdSha256|behaviorIdentitySha256|chatDigest|[a-f0-9]{64}/u,
  );
});

test('rejects contradictory command, completion, and snapshot metadata', () => {
  const emptySnapshot = {
    kind: 'missing',
    mode: null,
    chatCount: 0,
    chatDigest: null,
    expiresAt: null,
  };
  const contradictions = [
    publicControlOutput({ complete: false }),
    publicControlOutput({ beforeKind: 'missing' }),
    publicControlOutput({
      command: 'set',
      apply: false,
      complete: false,
      resultKind: 'preview',
    }),
    publicControlOutput({
      command: 'set',
      apply: false,
      resultKind: 'preview',
      beforeKind: 'missing',
    }),
    publicControlOutput({
      command: 'set',
      apply: true,
      complete: true,
      resultKind: 'conflict',
    }),
    publicControlOutput({
      command: 'set',
      apply: true,
      complete: true,
      resultKind: 'applied',
      ...emptySnapshot,
    }),
    publicControlOutput({
      command: 'clear',
      apply: true,
      complete: true,
      resultKind: 'cleared',
    }),
  ];

  for (const result of contradictions) {
    assert.throws(
      () =>
        summarizeCommercialOcrRuntimeControlResult(
          result,
          null,
          new Date('2026-08-14T10:30:00.000Z'),
        ),
      /contradictory command metadata/u,
    );
  }
});

test('preserves the revision fence when summarizing expired and missing controls', () => {
  const target = cohort();
  const expired = summarizeCommercialOcrRuntimeControlResult(
    publicControlOutput({
      beforeKind: 'expired',
      kind: 'expired',
      revision: 5,
      expiresAt: '2026-08-14T10:01:00.000Z',
    }),
    target,
    new Date('2026-08-14T10:02:00.000Z'),
  );
  const missing = summarizeCommercialOcrRuntimeControlResult(
    publicControlOutput({
      beforeKind: 'missing',
      kind: 'missing',
      revision: 5,
      mode: null,
      chatCount: 0,
      chatDigest: null,
      expiresAt: null,
    }),
    null,
    new Date('2026-08-14T10:02:00.000Z'),
  );

  assert.deepEqual(expired, {
    command: 'get',
    complete: true,
    resultKind: 'read',
    beforeKind: 'expired',
    evaluatedAt: '2026-08-14T10:02:00.000Z',
    kind: 'expired',
    revision: 5,
    mode: 'canary',
    chatCount: 2,
    matchesCohort: true,
    expiresAt: '2026-08-14T10:01:00.000Z',
    remainingTtlSec: 0,
  });
  assert.deepEqual(missing, {
    command: 'get',
    complete: true,
    resultKind: 'read',
    beforeKind: 'missing',
    evaluatedAt: '2026-08-14T10:02:00.000Z',
    kind: 'missing',
    revision: 5,
    mode: null,
    chatCount: 0,
    matchesCohort: null,
    expiresAt: null,
    remainingTtlSec: null,
  });
});

test('fails closed when snapshot kind contradicts expiry at the evaluation time', () => {
  const result = publicControlOutput({ expiresAt: '2026-08-14T10:01:00.000Z' });

  assert.throws(
    () =>
      summarizeCommercialOcrRuntimeControlResult(
        result,
        null,
        new Date('2026-08-14T10:01:00.000Z'),
      ),
    /contradicts expiresAt/u,
  );
  assert.throws(
    () =>
      summarizeCommercialOcrRuntimeControlResult(
        {
          ...result,
          beforeKind: 'expired',
          kind: 'expired',
        },
        null,
        new Date('2026-08-14T10:00:59.999Z'),
      ),
    /contradicts expiresAt/u,
  );
});

test('rejects legacy raw snapshots instead of inspecting private control fields', () => {
  const control = buildCommercialOcrRuntimeControl({
    cohort: cohort(),
    certification: certificationBinding(),
    expectedRevision: null,
    actor: 'sensitive-operator',
    reason: 'sensitive-reason',
    ttlSec: 3_600,
    now: new Date('2026-08-14T10:00:00.000Z'),
  });

  assert.throws(
    () =>
      summarizeCommercialOcrRuntimeControlResult({
        command: 'get',
        complete: true,
        before: { kind: 'active', revision: 1, control },
        result: { kind: 'read' },
      }),
    /privacy-safe public envelope/u,
  );
});

test('summarize-control CLI evaluates TTL deterministically without exposing control details', () => {
  const directory = mkdtempSync(join(tmpdir(), 'maxim-ocr-summary-cli-'));
  const cohortPath = join(directory, 'cohort.json');
  const target = cohort();
  writeFileSync(cohortPath, JSON.stringify(target), { mode: 0o600 });

  const summarized = spawnSync(
    process.execPath,
    [
      import.meta.filename.replace(/\.test\.mjs$/u, '.mjs'),
      'summarize-control',
      cohortPath,
      '--now',
      '2026-08-14T10:30:00.000Z',
    ],
    {
      encoding: 'utf8',
      input: JSON.stringify(publicControlOutput()),
    },
  );

  assert.equal(summarized.status, 0, summarized.stderr);
  const summary = JSON.parse(summarized.stdout);
  assert.equal(summary.evaluatedAt, '2026-08-14T10:30:00.000Z');
  assert.equal(summary.expiresAt, '2026-08-14T11:00:00.000Z');
  assert.equal(summary.remainingTtlSec, 1_800);
  assert.doesNotMatch(
    `${summarized.stdout}${summarized.stderr}`,
    /-12|42|actor|reason|enforcementChatIds|approvalKeyIdSha256|behaviorIdentitySha256|chatDigest|[a-f0-9]{64}/u,
  );
});
