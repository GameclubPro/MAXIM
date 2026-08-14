import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import sharp from 'sharp';

import {
  calculateCommercialOcrEvalCanonicalSha256,
  commercialOcrEvalCertificationEnvelopeSchema,
  commercialOcrEvalCertificationSigningBytes,
  type CommercialOcrEvalCertificationEnvelope,
  COMMERCIAL_OCR_EVAL_CERTIFICATION_GATE_PROFILE_ID,
  COMMERCIAL_OCR_EVAL_CERTIFICATION_GATE_PROFILE_SHA256,
  COMMERCIAL_OCR_EVAL_CERTIFICATION_KIND,
  COMMERCIAL_OCR_EVAL_CERTIFICATION_SCHEMA_VERSION,
  COMMERCIAL_OCR_EVAL_CERTIFICATION_TTL_MS,
} from '../moderation/commercial-ocr/eval/commercial-ocr-eval-certification';
import { CERTIFICATION_RESOURCE_LIMITS } from '../moderation/commercial-ocr/eval/commercial-ocr-eval-gates';
import {
  createCommercialOcrNativeBehaviorIdentity,
  resolveCommercialOcrBehaviorIdentity,
  resolveCommercialOcrNativeRuntimeControls,
  resolveCommercialOcrProductionBehaviorDescriptor,
  resolveCommercialOcrProductionNativeConfigReader,
  type CommercialOcrNativeArtifactVerification,
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
import { digestCommercialOcrSettingsFingerprintSet } from '../moderation/commercial-ocr/commercial-ocr-settings-profile';
import {
  COMMERCIAL_OCR_CERTIFICATION_ANNOTATION_PROTOCOL_VERSION,
  COMMERCIAL_OCR_CERTIFICATION_COLLECTION_PROTOCOL_VERSION,
} from '../moderation/commercial-ocr/eval/commercial-ocr-eval.schema';
import { COMMERCIAL_ENGINE_CONFIG } from '../moderation/commercial/commercial-config';
import { COMMERCIAL_SECOND_STAGE_VERSION } from '../moderation/rule-engine-commercial-second-stage-cache';
import {
  readCommercialOcrCertificationVerifierOptions,
  verifyCommercialOcrCertification,
  verifyCommercialOcrCertificationTrustedNativeBinding,
} from './verify-commercial-ocr-certification';

const SOURCE_SHA = 'a'.repeat(40);
const IMAGE_SHA256 = 'b'.repeat(64);
const NOW_MS = Date.parse('2026-08-14T12:00:00.000Z');
const SETTINGS_FINGERPRINT = '9'.repeat(64);
const APPROVAL_KEYS = generateKeyPairSync('ed25519');
const FORGED_KEYS = generateKeyPairSync('ed25519');
const TRUSTED_APPROVAL_PUBLIC_KEY_BASE64 = approvalPublicKeyBase64(APPROVAL_KEYS.publicKey);

describe('commercial OCR certification verifier', () => {
  it('accepts only the passing fresh artifact bound to the active source and image', () => {
    const { bytes, options, envelope, nativeVerification } = buildFixture();
    expect(
      verifyCommercialOcrCertificationTrustedNativeBinding({
        bytes,
        options,
        trustedApprovalPublicKeyBase64: TRUSTED_APPROVAL_PUBLIC_KEY_BASE64,
        nowMs: NOW_MS,
      }),
    ).toEqual({
      binarySha256: envelope.behavior.native.manifest.artifacts.tesseract.binarySha256,
      behaviorIdentitySha256: envelope.behavior.fingerprintSha256,
    });
    expect(
      verifyCommercialOcrCertification({
        bytes,
        options,
        trustedApprovalPublicKeyBase64: TRUSTED_APPROVAL_PUBLIC_KEY_BASE64,
        nativeVerification,
        nowMs: NOW_MS,
      }),
    ).toEqual({
      valid: true,
      certificationSha256: sha256(bytes),
      sourceSha: SOURCE_SHA,
      immutableImageSha256: IMAGE_SHA256,
      reportSha256: envelope.report.sha256,
      corpusManifestSha256: envelope.corpus.manifestSha256,
      corpusDescriptorSha256: envelope.corpus.descriptorSha256,
      certifiedSettingsFingerprints: [SETTINGS_FINGERPRINT],
      certifiedSettingsFingerprintSetSha256:
        envelope.certifiedSettingsFingerprintSetSha256,
      approvalKeyIdSha256: envelope.approval.keyIdSha256,
      behaviorIdentitySha256: envelope.behavior.fingerprintSha256,
      issuedAt: envelope.timestamps.issuedAt,
      expiresAt: envelope.timestamps.expiresAt,
    });
  });

  it('rejects digest, release, gate-profile and behavior mismatches', () => {
    const fixture = buildFixture();
    expect(() =>
      verifyCommercialOcrCertification({
        ...fixture,
        options: { ...fixture.options, expectedCertificationSha256: 'c'.repeat(64) },
        nowMs: NOW_MS,
      }),
    ).toThrow(/digest/u);
    expect(() =>
      verifyCommercialOcrCertification({
        ...fixture,
        options: { ...fixture.options, expectedSourceSha: 'd'.repeat(40) },
        nowMs: NOW_MS,
      }),
    ).toThrow(/source/u);
    expectRejectedMutation(fixture.envelope, {
      gate: { ...fixture.envelope.gate, profileSha256: 'e'.repeat(64) },
    }, fixture.nativeVerification);
    expectRejectedMutation(fixture.envelope, {
      behavior: {
        ...fixture.envelope.behavior,
        detector: { ...fixture.envelope.behavior.detector, sourceSha256: 'f'.repeat(64) },
      },
    }, fixture.nativeVerification);
  });

  it('rejects failed, expired, near-expiry and future certifications', () => {
    const fixture = buildFixture();
    expectRejectedMutation(fixture.envelope, {
      gate: {
        ...fixture.envelope.gate,
        passed: false,
        failureCount: 1,
        failuresSha256: calculateCommercialOcrEvalCanonicalSha256(['failure']),
      },
    }, fixture.nativeVerification);
    expect(() =>
      verifyCommercialOcrCertification({
        bytes: fixture.bytes,
        options: fixture.options,
        trustedApprovalPublicKeyBase64: TRUSTED_APPROVAL_PUBLIC_KEY_BASE64,
        nativeVerification: fixture.nativeVerification,
        nowMs: Date.parse(fixture.envelope.timestamps.expiresAt) - 1,
      }),
    ).toThrow(/fresh/u);

    const futureIssuedAt = NOW_MS + 10 * 60 * 1_000;
    const futureEvaluatedAt = futureIssuedAt - 1_000;
    expectRejectedMutation(fixture.envelope, {
      timestamps: {
        runStartedAt: new Date(futureIssuedAt - 2_000).toISOString(),
        evaluatedAt: new Date(futureEvaluatedAt).toISOString(),
        issuedAt: new Date(futureIssuedAt).toISOString(),
        expiresAt: new Date(
          futureEvaluatedAt + COMMERCIAL_OCR_EVAL_CERTIFICATION_TTL_MS,
        ).toISOString(),
      },
    }, fixture.nativeVerification);
  });

  it('rejects modified signed payloads and envelopes signed by an untrusted key', () => {
    const fixture = buildFixture();
    const modified = {
      ...fixture.envelope,
      report: { ...fixture.envelope.report, sha256: '0'.repeat(64) },
    };
    const modifiedBytes = Buffer.from(JSON.stringify(modified));
    expect(() =>
      verifyCommercialOcrCertification({
        bytes: modifiedBytes,
        options: {
          ...fixture.options,
          expectedCertificationSha256: sha256(modifiedBytes),
        },
        trustedApprovalPublicKeyBase64: TRUSTED_APPROVAL_PUBLIC_KEY_BASE64,
        nativeVerification: fixture.nativeVerification,
        nowMs: NOW_MS,
      }),
    ).toThrow(/approval signature/u);

    const forgedEnvelope = signEnvelope(fixture.envelope, FORGED_KEYS);
    const forgedBytes = Buffer.from(JSON.stringify(forgedEnvelope));
    expect(() =>
      verifyCommercialOcrCertification({
        bytes: forgedBytes,
        options: {
          ...fixture.options,
          expectedCertificationSha256: sha256(forgedBytes),
        },
        trustedApprovalPublicKeyBase64: TRUSTED_APPROVAL_PUBLIC_KEY_BASE64,
        nativeVerification: fixture.nativeVerification,
        nowMs: NOW_MS,
      }),
    ).toThrow(/approval signature/u);
    expect(() =>
      verifyCommercialOcrCertificationTrustedNativeBinding({
        bytes: forgedBytes,
        options: {
          ...fixture.options,
          expectedCertificationSha256: sha256(forgedBytes),
        },
        trustedApprovalPublicKeyBase64: TRUSTED_APPROVAL_PUBLIC_KEY_BASE64,
        nowMs: NOW_MS,
      }),
    ).toThrow(/approval signature/u);
  });

  it('recomputes the corpus descriptor digest and parses exactly three canonical bindings', () => {
    const fixture = buildFixture();
    expectRejectedMutation(fixture.envelope, {
      corpus: { ...fixture.envelope.corpus, revision: 'silently-changed' },
    }, fixture.nativeVerification);
    expect(
      readCommercialOcrCertificationVerifierOptions([
        '--expected-source-sha',
        SOURCE_SHA,
        '--expected-image-sha256',
        IMAGE_SHA256,
        '--expected-certification-sha256',
        'c'.repeat(64),
      ]),
    ).toEqual({
      expectedSourceSha: SOURCE_SHA,
      expectedImageSha256: IMAGE_SHA256,
      expectedCertificationSha256: 'c'.repeat(64),
    });
    expect(() =>
      readCommercialOcrCertificationVerifierOptions([
        '--expected-source-sha',
        SOURCE_SHA,
        '--expected-source-sha',
        SOURCE_SHA,
      ]),
    ).toThrow(/Usage/u);
  });
});

function buildFixture() {
  const issuedAtMs = NOW_MS - 60_000;
  const evaluatedAtMs = issuedAtMs - 1_000;
  const corpus = {
    schemaVersion: 2 as const,
    id: 'private-temporal-corpus',
    revision: 'reviewed-v1',
    manifestSha256: '1'.repeat(64),
    provenance: {
      sourceKind: 'production_temporal' as const,
      windowStartedAt: '2026-08-01T00:00:00.000Z',
      windowEndedAt: '2026-08-08T00:00:00.000Z',
      frozenAt: '2026-08-10T00:00:00.000Z',
      collectionProtocolVersion: COMMERCIAL_OCR_CERTIFICATION_COLLECTION_PROTOCOL_VERSION,
      annotationProtocolVersion: COMMERCIAL_OCR_CERTIFICATION_ANNOTATION_PROTOCOL_VERSION,
      collectionArtifactSha256: '2'.repeat(64),
      adjudicationArtifactSha256: '3'.repeat(64),
    },
  };
  const nativeIdentity = createCommercialOcrNativeBehaviorIdentity({
    controls: resolveCommercialOcrNativeRuntimeControls(
      resolveCommercialOcrProductionNativeConfigReader(),
    ),
    buildManifestSha256: '4'.repeat(64),
    artifacts: {
      runtime: {
        nodeVersion: process.version,
        platform: process.platform,
        architecture: process.arch,
        sharpVersion: sharp.versions.sharp!,
        libvipsVersion: sharp.versions.vips!,
      },
      tesseract: {
        version: 'tesseract 5.5.2',
        binarySha256: '6'.repeat(64),
        availableLanguages: ['eng', 'rus'],
        traineddataSha256: { rus: '7'.repeat(64), eng: '8'.repeat(64) },
      },
    },
  });
  const fullIdentity = resolveCommercialOcrBehaviorIdentity(
    resolveCommercialOcrProductionBehaviorDescriptor(undefined, nativeIdentity),
  );
  const nativeVerification: CommercialOcrNativeArtifactVerification = {
    verified: true,
    status: 'verified',
    mismatches: [],
    identity: nativeIdentity,
  };
  const envelope: CommercialOcrEvalCertificationEnvelope = {
    kind: COMMERCIAL_OCR_EVAL_CERTIFICATION_KIND,
    schemaVersion: COMMERCIAL_OCR_EVAL_CERTIFICATION_SCHEMA_VERSION,
    gate: {
      profileId: COMMERCIAL_OCR_EVAL_CERTIFICATION_GATE_PROFILE_ID,
      profileSha256: COMMERCIAL_OCR_EVAL_CERTIFICATION_GATE_PROFILE_SHA256,
      passed: true,
      failureCount: 0,
      failuresSha256: calculateCommercialOcrEvalCanonicalSha256([]),
    },
    certifiedSettingsProfiles: [
      {
        id: 'balanced-45-80',
        fingerprint: SETTINGS_FINGERPRINT,
        metricsSha256: '6'.repeat(64),
      },
    ],
    certifiedSettingsFingerprintSetSha256:
      digestCommercialOcrSettingsFingerprintSet([SETTINGS_FINGERPRINT]),
    timestamps: {
      runStartedAt: new Date(issuedAtMs - 2_000).toISOString(),
      evaluatedAt: new Date(evaluatedAtMs).toISOString(),
      issuedAt: new Date(issuedAtMs).toISOString(),
      expiresAt: new Date(evaluatedAtMs + COMMERCIAL_OCR_EVAL_CERTIFICATION_TTL_MS).toISOString(),
    },
    source: {
      gitCommit: SOURCE_SHA,
      sourceSha: SOURCE_SHA,
      immutableImageSha256: IMAGE_SHA256,
      auditTool: {
        digestKind: 'SOURCE_FILES' as const,
        sourceSha256: COMMERCIAL_OCR_AUDIT_TOOL_SOURCE_SHA256,
      },
    },
    report: { schemaVersion: 3 as const, sha256: '5'.repeat(64) },
    corpus: {
      ...corpus,
      descriptorSha256: calculateCommercialOcrEvalCanonicalSha256(corpus),
    },
    behavior: {
      fingerprintSha256: fullIdentity.fingerprintSha256,
      ocr: {
        version: COMMERCIAL_OCR_DEFAULT_VERSION,
        digestKind: 'SOURCE_FILES' as const,
        sourceSha256: COMMERCIAL_OCR_RUNTIME_SOURCE_SHA256,
      },
      policy: {
        version: COMMERCIAL_OCR_DECISION_POLICY_VERSION,
        digestKind: 'SOURCE_FILES' as const,
        sourceSha256: COMMERCIAL_OCR_POLICY_SOURCE_SHA256,
      },
      preprocess: {
        profiles: COMMERCIAL_OCR_PREPROCESS_PROFILES,
        digestKind: 'SOURCE_FILES' as const,
        sourceSha256: COMMERCIAL_OCR_PREPROCESS_SOURCE_SHA256,
      },
      detector: {
        digestKind: 'SOURCE_FILES' as const,
        sourceSha256: COMMERCIAL_OCR_DETECTOR_SOURCE_SHA256,
        decisionVersion: COMMERCIAL_ENGINE_CONFIG.decisionVersion,
        patternPolicyVersion: COMMERCIAL_ENGINE_CONFIG.patternPolicyVersion,
        classifierVersion: COMMERCIAL_SECOND_STAGE_VERSION,
      },
      native: {
        fingerprintSha256: nativeIdentity.fingerprintSha256,
        manifest: nativeIdentity.manifest,
      },
      evaluation: {
        concurrency: CERTIFICATION_RESOURCE_LIMITS.evalConcurrency,
        performanceProfileSha256: COMMERCIAL_OCR_EVAL_CERTIFICATION_GATE_PROFILE_SHA256,
        benchmarkEnvironmentSha256: 'c'.repeat(64),
        performanceSha256: 'd'.repeat(64),
      },
    },
    approval: {
      algorithm: 'Ed25519',
      keyIdSha256: approvalKeyIdSha256(APPROVAL_KEYS.publicKey),
      signatureBase64: Buffer.alloc(64).toString('base64'),
    },
  };
  const signedEnvelope = signEnvelope(envelope, APPROVAL_KEYS);
  const bytes = Buffer.from(JSON.stringify(signedEnvelope));
  return {
    bytes,
    envelope: signedEnvelope,
    nativeVerification,
    trustedApprovalPublicKeyBase64: TRUSTED_APPROVAL_PUBLIC_KEY_BASE64,
    options: {
      expectedSourceSha: SOURCE_SHA,
      expectedImageSha256: IMAGE_SHA256,
      expectedCertificationSha256: sha256(bytes),
    },
  };
}

function expectRejectedMutation(
  envelope: ReturnType<typeof buildFixture>['envelope'],
  mutation: Partial<ReturnType<typeof buildFixture>['envelope']>,
  nativeVerification: CommercialOcrNativeArtifactVerification,
) {
  expect(() => {
    const mutated = signEnvelope({ ...envelope, ...mutation }, APPROVAL_KEYS);
    const bytes = Buffer.from(JSON.stringify(mutated));
    verifyCommercialOcrCertification({
      bytes,
      options: {
        expectedSourceSha: SOURCE_SHA,
        expectedImageSha256: IMAGE_SHA256,
        expectedCertificationSha256: sha256(bytes),
      },
      trustedApprovalPublicKeyBase64: TRUSTED_APPROVAL_PUBLIC_KEY_BASE64,
      nativeVerification,
      nowMs: NOW_MS,
    });
  }).toThrow();
}

function signEnvelope(
  envelope: CommercialOcrEvalCertificationEnvelope,
  keys: { privateKey: KeyObject; publicKey: KeyObject },
): CommercialOcrEvalCertificationEnvelope {
  const unsigned = {
    ...envelope,
    approval: {
      algorithm: 'Ed25519' as const,
      keyIdSha256: approvalKeyIdSha256(keys.publicKey),
    },
  };
  const signatureBase64 = sign(
    null,
    commercialOcrEvalCertificationSigningBytes(unsigned),
    keys.privateKey,
  ).toString('base64');
  return commercialOcrEvalCertificationEnvelopeSchema.parse({
    ...unsigned,
    approval: { ...unsigned.approval, signatureBase64 },
  });
}

function approvalPublicKeyBase64(publicKey: KeyObject): string {
  return publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
}

function approvalKeyIdSha256(publicKey: KeyObject): string {
  return createHash('sha256')
    .update(publicKey.export({ type: 'spki', format: 'der' }))
    .digest('hex');
}

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}
