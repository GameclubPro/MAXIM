import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { isDeepStrictEqual } from 'node:util';

import { COMMERCIAL_ENGINE_CONFIG } from '../moderation/commercial/commercial-config';
import {
  calculateCommercialOcrEvalCanonicalSha256,
  commercialOcrEvalCertificationSigningBytes,
  commercialOcrEvalCertificationEnvelopeSchema,
  COMMERCIAL_OCR_EVAL_CERTIFICATION_GATE_PROFILE_SHA256,
} from '../moderation/commercial-ocr/eval/commercial-ocr-eval-certification';
import { CERTIFICATION_RESOURCE_LIMITS } from '../moderation/commercial-ocr/eval/commercial-ocr-eval-gates';
import {
  resolveCommercialOcrBehaviorIdentity,
  resolveCommercialOcrProductionBehaviorDescriptor,
  resolveCommercialOcrProductionNativeConfigReader,
  resolveVerifiedCommercialOcrNativeBehaviorIdentity,
  type CommercialOcrNativeArtifactVerification,
  type CommercialOcrNativeBehaviorManifest,
} from '../moderation/commercial-ocr/commercial-ocr-behavior-identity';
import { COMMERCIAL_OCR_DECISION_POLICY_VERSION } from '../moderation/commercial-ocr/commercial-ocr-decision-policy';
import {
  COMMERCIAL_OCR_AUDIT_TOOL_SOURCE_SHA256,
  COMMERCIAL_OCR_DETECTOR_SOURCE_SHA256,
  COMMERCIAL_OCR_POLICY_SOURCE_SHA256,
  COMMERCIAL_OCR_PREPROCESS_SOURCE_SHA256,
  COMMERCIAL_OCR_RUNTIME_SOURCE_SHA256,
} from '../moderation/commercial-ocr/commercial-ocr-detector-source.generated';
import { COMMERCIAL_OCR_PREPROCESS_PROFILES } from '../moderation/commercial-ocr/commercial-ocr-preprocessor';
import { COMMERCIAL_OCR_DEFAULT_VERSION } from '../moderation/commercial-ocr/commercial-ocr.queue';
import {
  digestCommercialOcrSettingsFingerprintSet,
  normalizeCommercialOcrSettingsFingerprints,
} from '../moderation/commercial-ocr/commercial-ocr-settings-profile';
import { COMMERCIAL_SECOND_STAGE_VERSION } from '../moderation/rule-engine-commercial-second-stage-cache';

const MAX_CERTIFICATION_BYTES = 256 * 1024;
const MAX_FUTURE_CLOCK_SKEW_MS = 5 * 60 * 1_000;
const MIN_REMAINING_VALIDITY_MS = 24 * 60 * 60 * 1_000;
const TRUSTED_APPROVAL_PUBLIC_KEY_ENV =
  'COMMERCIAL_OCR_CERTIFICATION_APPROVAL_PUBLIC_KEY_BASE64';
const LOWER_GIT_SHA_PATTERN = /^[a-f0-9]{40}$/u;
const LOWER_SHA_256_PATTERN = /^[a-f0-9]{64}$/u;
const USAGE =
  'Usage: --expected-source-sha <40-hex> --expected-image-sha256 <64-hex> --expected-certification-sha256 <64-hex>';

export type CommercialOcrCertificationVerifierOptions = Readonly<{
  expectedSourceSha: string;
  expectedImageSha256: string;
  expectedCertificationSha256: string;
}>;

export type CommercialOcrCertificationVerification = Readonly<{
  valid: true;
  certificationSha256: string;
  sourceSha: string;
  immutableImageSha256: string;
  reportSha256: string;
  corpusManifestSha256: string;
  corpusDescriptorSha256: string;
  certifiedSettingsFingerprints: readonly string[];
  certifiedSettingsFingerprintSetSha256: string;
  approvalKeyIdSha256: string;
  behaviorIdentitySha256: string;
  issuedAt: string;
  expiresAt: string;
}>;

export type CommercialOcrCertificationTrustedNativeBinding = Readonly<{
  binarySha256: string;
  behaviorIdentitySha256: string;
}>;

export function readCommercialOcrCertificationVerifierOptions(
  argv: readonly string[],
): CommercialOcrCertificationVerifierOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (
      !name ||
      !value ||
      value.startsWith('--') ||
      values.has(name) ||
      ![
        '--expected-source-sha',
        '--expected-image-sha256',
        '--expected-certification-sha256',
      ].includes(name)
    ) {
      throw new Error(USAGE);
    }
    values.set(name, value);
  }
  if (values.size !== 3) {
    throw new Error(USAGE);
  }
  return {
    expectedSourceSha: requireCanonicalHex(
      values.get('--expected-source-sha'),
      LOWER_GIT_SHA_PATTERN,
    ),
    expectedImageSha256: requireCanonicalHex(
      values.get('--expected-image-sha256'),
      LOWER_SHA_256_PATTERN,
    ),
    expectedCertificationSha256: requireCanonicalHex(
      values.get('--expected-certification-sha256'),
      LOWER_SHA_256_PATTERN,
    ),
  };
}

export function verifyCommercialOcrCertification(params: {
  bytes: Buffer;
  options: CommercialOcrCertificationVerifierOptions;
  trustedApprovalPublicKeyBase64: string;
  nowMs?: number;
  nativeVerification: CommercialOcrNativeArtifactVerification;
}): CommercialOcrCertificationVerification {
  validateCommercialOcrCertificationBytes(params.bytes);
  const options = {
    expectedSourceSha: requireCanonicalHex(params.options.expectedSourceSha, LOWER_GIT_SHA_PATTERN),
    expectedImageSha256: requireCanonicalHex(
      params.options.expectedImageSha256,
      LOWER_SHA_256_PATTERN,
    ),
    expectedCertificationSha256: requireCanonicalHex(
      params.options.expectedCertificationSha256,
      LOWER_SHA_256_PATTERN,
    ),
  };
  const certificationSha256 = createHash('sha256').update(params.bytes).digest('hex');
  if (certificationSha256 !== options.expectedCertificationSha256) {
    throw new Error('Commercial OCR certification digest does not match the reviewed artifact.');
  }

  const envelope = parseCommercialOcrCertificationEnvelope(params.bytes);
  const approvalPublicKey = parseTrustedApprovalPublicKey(
    params.trustedApprovalPublicKeyBase64,
  );
  const approvalPublicKeyDer = approvalPublicKey.export({ type: 'spki', format: 'der' });
  const approvalKeyIdSha256 = createHash('sha256').update(approvalPublicKeyDer).digest('hex');
  if (
    envelope.approval.keyIdSha256 !== approvalKeyIdSha256 ||
    !verifySignature(
      null,
      commercialOcrEvalCertificationSigningBytes(envelope),
      approvalPublicKey,
      Buffer.from(envelope.approval.signatureBase64, 'base64'),
    )
  ) {
    throw new Error('Commercial OCR certification approval signature is invalid.');
  }
  if (!envelope.gate.passed || envelope.gate.failureCount !== 0) {
    throw new Error('Commercial OCR certification gate did not pass.');
  }
  if (
    envelope.gate.profileSha256 !== COMMERCIAL_OCR_EVAL_CERTIFICATION_GATE_PROFILE_SHA256 ||
    envelope.gate.failuresSha256 !== calculateCommercialOcrEvalCanonicalSha256([])
  ) {
    throw new Error('Commercial OCR certification gate profile is not the active profile.');
  }
  if (
    envelope.source.gitCommit !== options.expectedSourceSha ||
    envelope.source.sourceSha !== options.expectedSourceSha
  ) {
    throw new Error('Commercial OCR certification source does not match the active release.');
  }
  if (envelope.source.immutableImageSha256 !== options.expectedImageSha256) {
    throw new Error('Commercial OCR certification image does not match the active release.');
  }

  const nowMs = params.nowMs ?? Date.now();
  if (!Number.isSafeInteger(nowMs) || nowMs <= 0) {
    throw new Error('Commercial OCR certification verification time is invalid.');
  }
  const evaluatedAtMs = Date.parse(envelope.timestamps.evaluatedAt);
  const issuedAtMs = Date.parse(envelope.timestamps.issuedAt);
  const expiresAtMs = Date.parse(envelope.timestamps.expiresAt);
  if (
    evaluatedAtMs > nowMs + MAX_FUTURE_CLOCK_SKEW_MS ||
    issuedAtMs > nowMs + MAX_FUTURE_CLOCK_SKEW_MS ||
    expiresAtMs - nowMs < MIN_REMAINING_VALIDITY_MS
  ) {
    throw new Error('Commercial OCR certification is not currently fresh enough for promotion.');
  }

  const corpusDescriptor = {
    schemaVersion: envelope.corpus.schemaVersion,
    id: envelope.corpus.id,
    revision: envelope.corpus.revision,
    manifestSha256: envelope.corpus.manifestSha256,
    provenance: envelope.corpus.provenance,
  };
  if (
    calculateCommercialOcrEvalCanonicalSha256(corpusDescriptor) !== envelope.corpus.descriptorSha256
  ) {
    throw new Error('Commercial OCR certification corpus descriptor digest is invalid.');
  }
  if (
    envelope.source.auditTool.digestKind !== 'SOURCE_FILES' ||
    envelope.behavior.ocr.digestKind !== 'SOURCE_FILES' ||
    envelope.behavior.policy.digestKind !== 'SOURCE_FILES' ||
    envelope.behavior.preprocess.digestKind !== 'SOURCE_FILES' ||
    envelope.behavior.detector.digestKind !== 'SOURCE_FILES'
  ) {
    throw new Error('Commercial OCR certification requires source-file fingerprints.');
  }
  if (
    envelope.source.auditTool.sourceSha256 !== COMMERCIAL_OCR_AUDIT_TOOL_SOURCE_SHA256 ||
    envelope.behavior.ocr.version !== COMMERCIAL_OCR_DEFAULT_VERSION ||
    envelope.behavior.ocr.sourceSha256 !== COMMERCIAL_OCR_RUNTIME_SOURCE_SHA256 ||
    envelope.behavior.policy.version !== COMMERCIAL_OCR_DECISION_POLICY_VERSION ||
    envelope.behavior.policy.sourceSha256 !== COMMERCIAL_OCR_POLICY_SOURCE_SHA256 ||
    envelope.behavior.preprocess.profiles.primary !== COMMERCIAL_OCR_PREPROCESS_PROFILES.primary ||
    envelope.behavior.preprocess.profiles.confirmation !==
      COMMERCIAL_OCR_PREPROCESS_PROFILES.confirmation ||
    envelope.behavior.preprocess.sourceSha256 !== COMMERCIAL_OCR_PREPROCESS_SOURCE_SHA256 ||
    envelope.behavior.detector.sourceSha256 !== COMMERCIAL_OCR_DETECTOR_SOURCE_SHA256 ||
    envelope.behavior.detector.decisionVersion !== COMMERCIAL_ENGINE_CONFIG.decisionVersion ||
    envelope.behavior.detector.patternPolicyVersion !==
      COMMERCIAL_ENGINE_CONFIG.patternPolicyVersion ||
    envelope.behavior.detector.classifierVersion !== COMMERCIAL_SECOND_STAGE_VERSION
  ) {
    throw new Error('Commercial OCR certification behavior does not match the active release.');
  }
  verifyRuntimeBehavior(envelope.behavior, params.nativeVerification);
  const certifiedSettingsFingerprints = normalizeCommercialOcrSettingsFingerprints(
    envelope.certifiedSettingsProfiles.map((profile) => profile.fingerprint),
  );
  if (
    digestCommercialOcrSettingsFingerprintSet(certifiedSettingsFingerprints) !==
    envelope.certifiedSettingsFingerprintSetSha256
  ) {
    throw new Error('Commercial OCR certification settings fingerprints are invalid.');
  }

  return Object.freeze({
    valid: true,
    certificationSha256,
    sourceSha: envelope.source.sourceSha,
    immutableImageSha256: envelope.source.immutableImageSha256,
    reportSha256: envelope.report.sha256,
    corpusManifestSha256: envelope.corpus.manifestSha256,
    corpusDescriptorSha256: envelope.corpus.descriptorSha256,
    certifiedSettingsFingerprints,
    certifiedSettingsFingerprintSetSha256:
      envelope.certifiedSettingsFingerprintSetSha256,
    approvalKeyIdSha256,
    behaviorIdentitySha256: envelope.behavior.fingerprintSha256,
    issuedAt: envelope.timestamps.issuedAt,
    expiresAt: envelope.timestamps.expiresAt,
  });
}

export function verifyCommercialOcrCertificationTrustedNativeBinding(params: {
  bytes: Buffer;
  options: CommercialOcrCertificationVerifierOptions;
  trustedApprovalPublicKeyBase64: string;
  nowMs?: number;
}): CommercialOcrCertificationTrustedNativeBinding {
  const envelope = parseCommercialOcrCertificationEnvelope(params.bytes);
  verifyCommercialOcrCertification({
    ...params,
    nativeVerification: {
      verified: true,
      status: 'verified',
      mismatches: [],
      identity: {
        complete: true,
        fingerprintSha256: envelope.behavior.native.fingerprintSha256,
        manifest:
          envelope.behavior.native.manifest as unknown as CommercialOcrNativeBehaviorManifest,
      },
    },
  });
  const binarySha256 = envelope.behavior.native.manifest.artifacts.tesseract.binarySha256;
  if (typeof binarySha256 !== 'string') {
    throw new Error('Commercial OCR certification native binary identity is incomplete.');
  }
  return Object.freeze({
    binarySha256,
    behaviorIdentitySha256: envelope.behavior.fingerprintSha256,
  });
}

function validateCommercialOcrCertificationBytes(bytes: Buffer): void {
  if (!Buffer.isBuffer(bytes) || bytes.byteLength < 1 || bytes.byteLength > MAX_CERTIFICATION_BYTES) {
    throw new Error('Commercial OCR certification size is invalid.');
  }
}

function parseCommercialOcrCertificationEnvelope(bytes: Buffer) {
  validateCommercialOcrCertificationBytes(bytes);
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new Error('Commercial OCR certification is not valid UTF-8 JSON.');
  }
  const parsed = commercialOcrEvalCertificationEnvelopeSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error('Commercial OCR certification envelope is invalid.');
  }
  return parsed.data;
}

function parseTrustedApprovalPublicKey(value: string) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 4_096) {
    throw new Error('Commercial OCR certification approval trust anchor is unavailable.');
  }
  const der = Buffer.from(value, 'base64');
  if (der.byteLength < 1 || der.toString('base64') !== value) {
    throw new Error('Commercial OCR certification approval trust anchor is invalid.');
  }
  try {
    const key = createPublicKey({ key: der, format: 'der', type: 'spki' });
    if (key.asymmetricKeyType !== 'ed25519') {
      throw new Error('not Ed25519');
    }
    return key;
  } catch {
    throw new Error('Commercial OCR certification approval trust anchor is invalid.');
  }
}

function verifyRuntimeBehavior(
  behavior: ReturnType<typeof commercialOcrEvalCertificationEnvelopeSchema.parse>['behavior'],
  verification: CommercialOcrNativeArtifactVerification,
): void {
  const productionConfig = resolveCommercialOcrProductionNativeConfigReader({
    get: (propertyPath) => process.env[propertyPath],
  });
  const activeBehavior = resolveCommercialOcrBehaviorIdentity(
    resolveCommercialOcrProductionBehaviorDescriptor(productionConfig, verification.identity),
  );
  if (
    !verification.verified ||
    verification.status !== 'verified' ||
    verification.mismatches.length !== 0 ||
    behavior.native.fingerprintSha256 !== verification.identity.fingerprintSha256 ||
    !isDeepStrictEqual(behavior.native.manifest, verification.identity.manifest) ||
    behavior.fingerprintSha256 !== activeBehavior.fingerprintSha256 ||
    behavior.evaluation.concurrency !== CERTIFICATION_RESOURCE_LIMITS.evalConcurrency ||
    behavior.evaluation.performanceProfileSha256 !==
      COMMERCIAL_OCR_EVAL_CERTIFICATION_GATE_PROFILE_SHA256
  ) {
    throw new Error('Commercial OCR certification native runtime does not match the active image.');
  }
}

function requireCanonicalHex(value: string | undefined, pattern: RegExp): string {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new Error(USAGE);
  }
  return value;
}

async function readBoundedStdin(): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_CERTIFICATION_BYTES) {
      throw new Error('Commercial OCR certification size is invalid.');
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, totalBytes);
}

async function main(): Promise<void> {
  const options = readCommercialOcrCertificationVerifierOptions(process.argv.slice(2));
  const bytes = await readBoundedStdin();
  const trustedApprovalPublicKeyBase64 =
    process.env[TRUSTED_APPROVAL_PUBLIC_KEY_ENV] ?? '';
  const trustedNativeBinding = verifyCommercialOcrCertificationTrustedNativeBinding({
    bytes,
    options,
    trustedApprovalPublicKeyBase64,
  });
  const productionConfig = resolveCommercialOcrProductionNativeConfigReader({
    get: (propertyPath) => process.env[propertyPath],
  });
  const nativeVerification = await resolveVerifiedCommercialOcrNativeBehaviorIdentity(
    productionConfig,
    { trustedBinarySha256: trustedNativeBinding.binarySha256 },
  );
  const result = verifyCommercialOcrCertification({
    bytes,
    options,
    nativeVerification,
    trustedApprovalPublicKeyBase64,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'Commercial OCR certification failed.'}\n`,
    );
    process.exitCode = 1;
  });
}
