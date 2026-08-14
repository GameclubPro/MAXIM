import { createHash, generateKeyPairSync, verify } from 'node:crypto';

import { COMMERCIAL_OCR_BENCHMARK_ENVIRONMENT_PROFILE_ID } from '../../../scripts/commercial-run-provenance.util';
import {
  createCommercialOcrNativeBehaviorIdentity,
  resolveCommercialOcrBehaviorIdentity,
  resolveCommercialOcrNativeRuntimeControls,
  resolveCommercialOcrProductionBehaviorDescriptor,
  resolveCommercialOcrProductionNativeConfigReader,
} from '../commercial-ocr-behavior-identity';
import {
  calculateCommercialOcrEvalCanonicalSha256,
  commercialOcrEvalCertificationSigningBytes,
  commercialOcrEvalCertificationEnvelopeSchema,
  COMMERCIAL_OCR_EVAL_CERTIFICATION_GATE_PROFILE_SHA256,
  COMMERCIAL_OCR_EVAL_CERTIFICATION_MAX_ISSUANCE_LAG_MS,
  COMMERCIAL_OCR_EVAL_CERTIFICATION_TTL_MS,
  createCommercialOcrEvalCertificationEnvelope,
  createCommercialOcrEvalCertificationRequest,
  validateCommercialOcrEvalCertificationRequestForSigning,
} from './commercial-ocr-eval-certification';
import type { CommercialOcrEvalGateResult } from './commercial-ocr-eval-gates';
import {
  COMMERCIAL_OCR_EVAL_PERFORMANCE_MEASUREMENT_VERSION,
  summarizeCommercialOcrEvalDurationSamples,
  type CommercialOcrEvalReport,
} from './commercial-ocr-eval-runner';
import {
  COMMERCIAL_OCR_CERTIFICATION_ANNOTATION_PROTOCOL_VERSION,
  COMMERCIAL_OCR_CERTIFICATION_COLLECTION_PROTOCOL_VERSION,
} from './commercial-ocr-eval.schema';
import { signCommercialOcrCertification } from '../../../scripts/sign-commercial-ocr-certification';

const SETTINGS_PROFILE_ID = 'balanced-45-80';
const SETTINGS_FINGERPRINT = '9'.repeat(64);
const { privateKey: approvalPrivateKey, publicKey: approvalPublicKey } =
  generateKeyPairSync('ed25519');
const APPROVAL_PRIVATE_KEY_PEM = approvalPrivateKey.export({
  type: 'pkcs8',
  format: 'pem',
});
const APPROVAL_KEY_ID_SHA256 = createHash('sha256')
  .update(approvalPublicKey.export({ type: 'spki', format: 'der' }))
  .digest('hex');

describe('commercial OCR eval certification envelope', () => {
  it('exports a strict, expiring binding for report, corpus, source, audit tool, and behavior', () => {
    const report = buildReport();
    const envelope = createCommercialOcrEvalCertificationEnvelope({
      report,
      gates: passingGates(),
      approvalPrivateKey: APPROVAL_PRIVATE_KEY_PEM,
      issuedAt: '2026-08-14T00:00:01.000Z',
    });

    expect(envelope).toMatchObject({
      kind: 'commercial_ocr_enforcement_certification',
      schemaVersion: 1,
      gate: {
        profileId: 'commercial_ocr_cyrillic_enforcement_v1',
        passed: true,
        failureCount: 0,
        profileSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        failuresSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      },
      certifiedSettingsProfiles: [
        {
          id: SETTINGS_PROFILE_ID,
          fingerprint: SETTINGS_FINGERPRINT,
          metricsSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        },
      ],
      certifiedSettingsFingerprintSetSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      timestamps: {
        runStartedAt: '2026-08-14T00:00:00.000Z',
        evaluatedAt: '2026-08-14T00:00:01.000Z',
        issuedAt: '2026-08-14T00:00:01.000Z',
        expiresAt: '2026-09-13T00:00:01.000Z',
      },
      source: {
        gitCommit: 'c'.repeat(40),
        sourceSha: 'c'.repeat(40),
        immutableImageSha256: 'b'.repeat(64),
        auditTool: { digestKind: 'SOURCE_FILES', sourceSha256: '2'.repeat(64) },
      },
      report: { schemaVersion: 3, sha256: expect.stringMatching(/^[a-f0-9]{64}$/u) },
      corpus: {
        schemaVersion: 2,
        id: 'test-corpus',
        revision: 'v2',
        manifestSha256: 'a'.repeat(64),
        descriptorSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        provenance: expect.objectContaining({
          sourceKind: 'production_temporal',
          collectionProtocolVersion: COMMERCIAL_OCR_CERTIFICATION_COLLECTION_PROTOCOL_VERSION,
          annotationProtocolVersion: COMMERCIAL_OCR_CERTIFICATION_ANNOTATION_PROTOCOL_VERSION,
          collectionArtifactSha256: '5'.repeat(64),
          adjudicationArtifactSha256: '6'.repeat(64),
        }),
      },
      behavior: {
        ocr: expect.objectContaining({ sourceSha256: 'd'.repeat(64) }),
        policy: expect.objectContaining({ sourceSha256: 'e'.repeat(64) }),
        preprocess: expect.objectContaining({ sourceSha256: 'f'.repeat(64) }),
        detector: expect.objectContaining({ sourceSha256: '1'.repeat(64) }),
        evaluation: {
          concurrency: 1,
          performanceProfileSha256: COMMERCIAL_OCR_EVAL_CERTIFICATION_GATE_PROFILE_SHA256,
          benchmarkEnvironmentSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
          performanceSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        },
      },
      approval: {
        algorithm: 'Ed25519',
        keyIdSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        signatureBase64: expect.any(String),
      },
    });
    expect(
      Date.parse(envelope.timestamps.expiresAt) - Date.parse(envelope.timestamps.issuedAt),
    ).toBe(COMMERCIAL_OCR_EVAL_CERTIFICATION_TTL_MS);
    expect(commercialOcrEvalCertificationEnvelopeSchema.parse(envelope)).toEqual(envelope);
    expect(
      verify(
        null,
        commercialOcrEvalCertificationSigningBytes(envelope),
        approvalPublicKey,
        Buffer.from(envelope.approval.signatureBase64, 'base64'),
      ),
    ).toBe(true);
  });

  it('uses canonical report hashing and rejects unsupported JSON values', () => {
    expect(calculateCommercialOcrEvalCanonicalSha256({ b: 2, a: 1 })).toBe(
      calculateCommercialOcrEvalCanonicalSha256({ a: 1, b: 2 }),
    );
    expect(() => calculateCommercialOcrEvalCanonicalSha256({ invalid: Number.NaN })).toThrow(
      /non-finite/u,
    );

    const first = createCommercialOcrEvalCertificationEnvelope({
      report: buildReport(),
      gates: passingGates(),
      approvalPrivateKey: APPROVAL_PRIVATE_KEY_PEM,
      issuedAt: '2026-08-14T00:00:01.000Z',
    });
    const changed = createCommercialOcrEvalCertificationEnvelope({
      report: { ...buildReport(), durationMs: 2 },
      gates: passingGates(),
      approvalPrivateKey: APPROVAL_PRIVATE_KEY_PEM,
      issuedAt: '2026-08-14T00:00:01.000Z',
    });
    expect(changed.report.sha256).not.toBe(first.report.sha256);
  });

  it('freezes a strict unsigned request and signs it without retaining private key bytes', async () => {
    const request = createCommercialOcrEvalCertificationRequest({
      report: buildReport(),
      gates: passingGates(),
      approvalKeyIdSha256: APPROVAL_KEY_ID_SHA256,
    });
    const privateKeyBytes = Buffer.from(APPROVAL_PRIVATE_KEY_PEM);
    const certification = await signCommercialOcrCertification({
      request,
      approvalPrivateKeyFile: '/not-read-by-test',
      issuedAt: '2026-08-14T00:00:02.000Z',
      dependencies: {
        readApprovalPrivateKey: jest.fn(async () => privateKeyBytes),
      },
    });

    expect(privateKeyBytes.every((value) => value === 0)).toBe(true);
    expect(commercialOcrEvalCertificationEnvelopeSchema.parse(certification)).toEqual(
      certification,
    );
    expect(
      verify(
        null,
        commercialOcrEvalCertificationSigningBytes(certification as never),
        approvalPublicKey,
        Buffer.from(certification.approval.signatureBase64, 'base64'),
      ),
    ).toBe(true);
  });

  it('allows a reviewed 24-hour signing window and rejects the next millisecond', () => {
    const request = createCommercialOcrEvalCertificationRequest({
      report: buildReport(),
      gates: passingGates(),
      approvalKeyIdSha256: APPROVAL_KEY_ID_SHA256,
    });
    const evaluatedAtMs = Date.parse(request.unsignedEnvelope.timestamps.evaluatedAt);
    const boundary = new Date(
      evaluatedAtMs + COMMERCIAL_OCR_EVAL_CERTIFICATION_MAX_ISSUANCE_LAG_MS,
    ).toISOString();
    expect(validateCommercialOcrEvalCertificationRequestForSigning(request, boundary)).toEqual(
      request,
    );
    expect(() =>
      validateCommercialOcrEvalCertificationRequestForSigning(
        request,
        new Date(
          evaluatedAtMs + COMMERCIAL_OCR_EVAL_CERTIFICATION_MAX_ISSUANCE_LAG_MS + 1,
        ).toISOString(),
      ),
    ).toThrow(/issued promptly/u);
  });

  it('rejects nested request tampering before the signer reads the approval key', async () => {
    const request = createCommercialOcrEvalCertificationRequest({
      report: buildReport(),
      gates: passingGates(),
      approvalKeyIdSha256: APPROVAL_KEY_ID_SHA256,
    });
    const tampered = structuredClone(request) as unknown as {
      unsignedEnvelope: {
        behavior: { native: { manifest: { controls: Record<string, unknown> } } };
      };
    };
    tampered.unsignedEnvelope.behavior.native.manifest.controls.unreviewed = 1;
    const readApprovalPrivateKey = jest.fn(async () => Buffer.from(APPROVAL_PRIVATE_KEY_PEM));

    await expect(
      signCommercialOcrCertification({
        request: tampered,
        approvalPrivateKeyFile: '/must-not-be-read',
        issuedAt: '2026-08-14T00:00:02.000Z',
        dependencies: { readApprovalPrivateKey },
      }),
    ).rejects.toThrow();
    expect(readApprovalPrivateKey).not.toHaveBeenCalled();
  });

  it('fails closed on source mismatch, unsupported passing corpus, and extra fields', () => {
    const sourceMismatch = buildReport();
    sourceMismatch.provenance.artifact.sourceSha = 'd'.repeat(40);
    expect(() =>
      createCommercialOcrEvalCertificationEnvelope({
        report: sourceMismatch,
        gates: passingGates(),
        approvalPrivateKey: APPROVAL_PRIVATE_KEY_PEM,
        issuedAt: '2026-08-14T00:00:01.000Z',
      }),
    ).toThrow(/source SHA must equal/u);

    const synthetic = buildReport();
    synthetic.corpusProvenance = {
      ...synthetic.corpusProvenance!,
      sourceKind: 'synthetic',
      windowStartedAt: null,
      windowEndedAt: null,
    };
    expect(() =>
      createCommercialOcrEvalCertificationEnvelope({
        report: synthetic,
        gates: passingGates(),
        approvalPrivateKey: APPROVAL_PRIVATE_KEY_PEM,
        issuedAt: '2026-08-14T00:00:01.000Z',
      }),
    ).toThrow(/supported production corpus protocols/u);

    const envelope = createCommercialOcrEvalCertificationEnvelope({
      report: buildReport(),
      gates: passingGates(),
      approvalPrivateKey: APPROVAL_PRIVATE_KEY_PEM,
      issuedAt: '2026-08-14T00:00:01.000Z',
    });
    expect(() =>
      commercialOcrEvalCertificationEnvelopeSchema.parse({ ...envelope, extra: true }),
    ).toThrow();
    expect(() =>
      commercialOcrEvalCertificationEnvelopeSchema.parse({
        ...envelope,
        gate: { ...envelope.gate, profileSha256: '0'.repeat(64) },
      }),
    ).toThrow();
    expect(() =>
      commercialOcrEvalCertificationEnvelopeSchema.parse({
        ...envelope,
        corpus: { ...envelope.corpus, revision: 'rewritten' },
      }),
    ).toThrow(/corpus descriptor digest/u);
    expect(() =>
      createCommercialOcrEvalCertificationEnvelope({
        report: buildReport(),
        gates: passingGates(),
        approvalPrivateKey: APPROVAL_PRIVATE_KEY_PEM,
        issuedAt: '2026-08-15T00:00:01.001Z',
      }),
    ).toThrow(/issued promptly/u);
  });

  it('never issues an approval envelope for failed gates', () => {
    const report = { ...buildReport(), corpusSchemaVersion: 1 as const, corpusProvenance: null };
    expect(() =>
      createCommercialOcrEvalCertificationEnvelope({
        report,
        gates: {
          ...passingGates(),
          passed: false,
          failures: ['Enforcement certification requires corpus schema v2'],
        },
        approvalPrivateKey: APPROVAL_PRIVATE_KEY_PEM,
        issuedAt: '2026-08-14T00:00:01.000Z',
      }),
    ).toThrow(/passing active gate profile/u);
  });
});

function passingGates(): CommercialOcrEvalGateResult {
  return {
    passed: true,
    failures: [],
    profileSha256: COMMERCIAL_OCR_EVAL_CERTIFICATION_GATE_PROFILE_SHA256,
    metrics: {
      certificationCases: 0,
      adversarialCases: 0,
      adversarialClusters: 0,
      commercialFalseDeletes: 0,
      enforcementFalseDeletes: 0,
      performance: {} as CommercialOcrEvalGateResult['metrics']['performance'],
      profiles: {
        [SETTINGS_PROFILE_ID]: {} as CommercialOcrEvalGateResult['metrics']['profiles'][string],
      },
    },
  };
}

function buildReport(): CommercialOcrEvalReport {
  const emptySlice = {
    total: 0,
    falseDeletes: 0,
    missedDeletes: 0,
    incomplete: 0,
    incompleteExpectedDelete: 0,
    incompleteExpectedNoAction: 0,
  };
  const quality = {
    expectedPasses: 0,
    attemptedPasses: 0,
    failedPasses: 0,
    expectedPrimaryPasses: 0,
    attemptedPrimaryPasses: 0,
    failedPrimaryPasses: 0,
    expectedConfirmationPasses: 0,
    attemptedConfirmationPasses: 0,
    failedConfirmationPasses: 0,
    characterEdits: 0,
    characterReferenceLength: 0,
    wordEdits: 0,
    wordReferenceLength: 0,
    criticalTokens: 0,
    criticalTokensMatchedPrimary: 0,
    criticalTokensMatchedConfirmation: 0,
    criticalTokensMatchedBoth: 0,
    confidenceObservations: 0,
    absoluteConfidenceCalibrationErrorPermille: 0,
    highConfidencePasses: 0,
    highConfidenceSevereErrorPasses: 0,
    characterErrorRate: 0,
    wordErrorRate: 0,
    criticalTokenRecall: 0,
    meanAbsoluteConfidenceCalibrationError: 0,
    highConfidenceSevereErrorRate: 0,
  };
  const detector = {
    digestKind: 'SOURCE_FILES' as const,
    sourceSha256: '1'.repeat(64),
    decisionVersion: 'commercial-deterministic-v2',
    patternPolicyVersion: 'commercial-patterns-v2',
    classifierVersion: '2026-service-private-v4',
  };
  const behaviorIdentity = buildVerifiedBehaviorIdentity();
  const benchmarkDescriptor = {
    platform: 'linux',
    architecture: 'x64',
    nodeVersion: 'v24.16.0',
    cpuModelSha256: '9'.repeat(64),
    logicalCpuCount: 4,
    availableParallelism: 2,
    totalMemoryBytes: 8 * 1024 * 1024 * 1024,
    constrainedMemoryBytes: 4 * 1024 * 1024 * 1024,
    nativeBuildManifestSha256: '8'.repeat(64),
    nativeBehaviorFingerprintSha256: behaviorIdentity.nativeFingerprintSha256,
  };
  const benchmarkDescriptorSha256 = calculateCommercialOcrEvalCanonicalSha256(benchmarkDescriptor);
  const emptyPerformanceDistribution = summarizeCommercialOcrEvalDurationSamples([]);
  return {
    schemaVersion: 3,
    corpusSchemaVersion: 2,
    corpusId: 'test-corpus',
    corpusRevision: 'v2',
    corpusProvenance: {
      sourceKind: 'production_temporal',
      windowStartedAt: '2026-08-01T00:00:00.000Z',
      windowEndedAt: '2026-08-08T00:00:00.000Z',
      frozenAt: '2026-08-10T00:00:00.000Z',
      collectionProtocolVersion: COMMERCIAL_OCR_CERTIFICATION_COLLECTION_PROTOCOL_VERSION,
      annotationProtocolVersion: COMMERCIAL_OCR_CERTIFICATION_ANNOTATION_PROTOCOL_VERSION,
      collectionArtifactSha256: '5'.repeat(64),
      adjudicationArtifactSha256: '6'.repeat(64),
    },
    generatedAt: '2026-08-14T00:00:01.000Z',
    ...emptySlice,
    passed: 0,
    failed: 0,
    durationMs: 1,
    quality,
    performance: {
      measurementVersion: COMMERCIAL_OCR_EVAL_PERFORMANCE_MEASUREMENT_VERSION,
      benchmarkEnvironmentSha256: benchmarkDescriptorSha256,
      evalConcurrency: 1,
      certification: {
        sourceCases: 0,
        images: 0,
        expectedOcrPasses: 0,
        attemptedOcrPasses: 0,
        passCoverage: 0,
        durationMs: 0,
        deadlineBudgetMs: 0,
        deadlineUtilization: 0,
        throughputImagesPerMinute: null,
        ocrPassSamplesMs: [],
        sourceCaseSamplesMs: [],
        ocrPassDurationMs: emptyPerformanceDistribution,
        sourceCaseDurationMs: emptyPerformanceDistribution,
      },
    },
    provenance: {
      run: {
        startedAt: '2026-08-14T00:00:00.000Z',
        git: { commit: 'c'.repeat(40), dirty: false },
        detector: { ...detector },
        auditTool: { digestKind: 'SOURCE_FILES', sourceSha256: '2'.repeat(64) },
        runtime: { nodeVersion: 'v24.16.0' },
      },
      artifact: {
        manifestSha256: 'a'.repeat(64),
        immutableImageSha256: 'b'.repeat(64),
        sourceSha: 'c'.repeat(40),
      },
      fingerprints: {
        ocr: {
          digestKind: 'SOURCE_FILES',
          sourceSha256: 'd'.repeat(64),
          version: 'tesseract-rus-eng-v2',
        },
        policy: {
          digestKind: 'SOURCE_FILES',
          sourceSha256: 'e'.repeat(64),
          version: 'commercial-ocr-delete-policy-v2',
        },
        preprocess: {
          digestKind: 'SOURCE_FILES',
          sourceSha256: 'f'.repeat(64),
          profiles: {
            primary: 'gray-bounded-v3',
            confirmation: 'normalized-threshold160-v3',
          },
        },
        detector: { ...detector },
      },
      behaviorIdentity,
      benchmarkEnvironment: {
        profileId: COMMERCIAL_OCR_BENCHMARK_ENVIRONMENT_PROFILE_ID,
        descriptorSha256: benchmarkDescriptorSha256,
        reviewedDescriptorSha256: benchmarkDescriptorSha256,
        descriptor: benchmarkDescriptor,
      },
      runtime: {
        nodeVersion: 'v24.16.0',
        sharpVersion: '0.35.3',
        libvipsVersion: '8.18.3',
        tesseractVersion: 'tesseract 5.5.2',
      },
      sourceImages: { allowedFormats: ['jpeg', 'png', 'webp', 'gif', 'avif', 'heif', 'tiff'] },
      tesseract: {
        binary: 'tesseract',
        tessdataPrefix: '/usr/share/tessdata',
        languages: ['rus', 'eng'],
        availableLanguages: ['eng', 'rus'],
        binarySha256: '7'.repeat(64),
        traineddataSha256: { rus: '3'.repeat(64), eng: '4'.repeat(64) },
        oem: 1,
        psm: { primary: 11, confirmation: 6 },
        resourceLimits: {
          timeoutMs: 10_000,
          maxSourceImageBytes: 16 * 1024 * 1024,
          maxImageBytes: 16 * 1024 * 1024,
          maxOutputBytes: 4 * 1024 * 1024,
          maxInputPixels: 40_000_000,
          maxOutputPixels: 3_000_000,
          maxSide: 2_000,
          ompThreadLimit: 1,
          nativeConcurrency: 1,
          nativeMaxQueue: 4,
          nativeRecycleAfterJobs: 250,
          sharpConcurrency: 1,
          sharpProcessingTimeoutSeconds: 5,
          evalConcurrency: 1,
        },
      },
    },
    languages: { ru: emptySlice, en: emptySlice, mixed: emptySlice },
    categories: {},
    clusters: [],
    cases: [
      {
        settingsProfileId: SETTINGS_PROFILE_ID,
        settingsFingerprint: SETTINGS_FINGERPRINT,
      },
    ] as unknown as CommercialOcrEvalReport['cases'],
  };
}

function buildVerifiedBehaviorIdentity(): CommercialOcrEvalReport['provenance']['behaviorIdentity'] {
  const nativeIdentity = createCommercialOcrNativeBehaviorIdentity({
    controls: resolveCommercialOcrNativeRuntimeControls(
      resolveCommercialOcrProductionNativeConfigReader(),
    ),
    buildManifestSha256: '8'.repeat(64),
    artifacts: {
      runtime: {
        nodeVersion: 'v24.16.0',
        platform: 'linux',
        architecture: 'x64',
        sharpVersion: '0.35.3',
        libvipsVersion: '8.18.3',
      },
      tesseract: {
        version: 'tesseract 5.5.2',
        binarySha256: '7'.repeat(64),
        availableLanguages: ['eng', 'rus'],
        traineddataSha256: { rus: '3'.repeat(64), eng: '4'.repeat(64) },
      },
    },
  });
  const identity = resolveCommercialOcrBehaviorIdentity(
    resolveCommercialOcrProductionBehaviorDescriptor(undefined, nativeIdentity),
  );
  return {
    fingerprintSha256: identity.fingerprintSha256,
    nativeFingerprintSha256: nativeIdentity.fingerprintSha256,
    nativeVerification: { verified: true, status: 'verified', mismatches: [] },
    descriptor: identity.descriptor,
  };
}
