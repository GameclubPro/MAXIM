import { createHash, createPrivateKey, createPublicKey } from 'node:crypto';
import { z } from 'zod';

import {
  COMMERCIAL_OCR_CYRILLIC_ENFORCEMENT_GATES,
  type CommercialOcrEvalGateResult,
} from './commercial-ocr-eval-gates';
import type { CommercialOcrEvalReport } from './commercial-ocr-eval-runner';
import {
  COMMERCIAL_OCR_CERTIFICATION_ANNOTATION_PROTOCOL_VERSION,
  COMMERCIAL_OCR_CERTIFICATION_COLLECTION_PROTOCOL_VERSION,
} from './commercial-ocr-eval.schema';
import { calculateCommercialOcrEvalCanonicalSha256 } from './commercial-ocr-eval-canonical';
import {
  commercialOcrEvalCertificationRequestPureSchema,
  commercialOcrEvalCertificationSigningBytesPure,
  COMMERCIAL_OCR_EVAL_CERTIFICATION_GATE_PROFILE_SHA256 as PURE_CERTIFICATION_GATE_PROFILE_SHA256,
  signCommercialOcrEvalCertificationRequestPure,
  validateCommercialOcrEvalCertificationRequestPureForSigning,
} from './commercial-ocr-eval-certification-pure';
import {
  COMMERCIAL_OCR_MAX_CERTIFIED_SETTINGS_PROFILES,
  digestCommercialOcrSettingsFingerprintSet,
  normalizeCommercialOcrSettingsFingerprints,
} from '../commercial-ocr-settings-profile';
import {
  commercialOcrCompleteNativeBehaviorIdentitySchema,
  resolveCommercialOcrBehaviorIdentity,
} from '../commercial-ocr-behavior-identity';

const LOWER_GIT_SHA_PATTERN = /^[a-f0-9]{40}$/u;
const LOWER_SHA_256_PATTERN = /^[a-f0-9]{64}$/u;
const PROFILE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const ED25519_SIGNATURE_BYTES = 64;
const UNSIGNED_APPROVAL_KEY_ID_SHA256 = '0'.repeat(64);
const UNSIGNED_APPROVAL_SIGNATURE_BASE64 = Buffer.alloc(ED25519_SIGNATURE_BYTES).toString('base64');

export const COMMERCIAL_OCR_EVAL_CERTIFICATION_SCHEMA_VERSION = 1 as const;
export const COMMERCIAL_OCR_EVAL_CERTIFICATION_REQUEST_SCHEMA_VERSION = 1 as const;
export const COMMERCIAL_OCR_EVAL_CERTIFICATION_KIND =
  'commercial_ocr_enforcement_certification' as const;
export const COMMERCIAL_OCR_EVAL_CERTIFICATION_REQUEST_KIND =
  'commercial_ocr_enforcement_certification_request' as const;
export const COMMERCIAL_OCR_EVAL_CERTIFICATION_GATE_PROFILE_ID =
  'commercial_ocr_cyrillic_enforcement_v1' as const;
export const COMMERCIAL_OCR_EVAL_CERTIFICATION_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
export const COMMERCIAL_OCR_EVAL_CERTIFICATION_MAX_ISSUANCE_LAG_MS = 24 * 60 * 60 * 1_000;
const calculatedGateProfileSha256 = calculateCommercialOcrEvalCanonicalSha256(
  COMMERCIAL_OCR_CYRILLIC_ENFORCEMENT_GATES,
);
if (calculatedGateProfileSha256 !== PURE_CERTIFICATION_GATE_PROFILE_SHA256) {
  throw new Error('Commercial OCR pure certification gate profile digest is stale');
}
export const COMMERCIAL_OCR_EVAL_CERTIFICATION_GATE_PROFILE_SHA256: string =
  PURE_CERTIFICATION_GATE_PROFILE_SHA256;

const sha256Schema = z.string().regex(LOWER_SHA_256_PATTERN);
const gitShaSchema = z.string().regex(LOWER_GIT_SHA_PATTERN);
const digestKindSchema = z.enum(['SOURCE_FILES', 'VERSION_DESCRIPTOR']);
const canonicalEd25519SignatureSchema = z.string().refine((value) => {
  try {
    const bytes = Buffer.from(value, 'base64');
    return bytes.byteLength === ED25519_SIGNATURE_BYTES && bytes.toString('base64') === value;
  } catch {
    return false;
  }
}, 'approval signature must be canonical Ed25519 base64');

const corpusProvenanceSchema = z
  .object({
    sourceKind: z.enum(['production_temporal', 'synthetic', 'public_dataset']),
    windowStartedAt: z.string().datetime({ offset: true }).nullable(),
    windowEndedAt: z.string().datetime({ offset: true }).nullable(),
    frozenAt: z.string().datetime({ offset: true }),
    collectionProtocolVersion: z.string().min(1),
    annotationProtocolVersion: z.string().min(1),
    collectionArtifactSha256: sha256Schema,
    adjudicationArtifactSha256: sha256Schema,
  })
  .strict();

export const commercialOcrEvalCertificationEnvelopeSchema = z
  .object({
    kind: z.literal(COMMERCIAL_OCR_EVAL_CERTIFICATION_KIND),
    schemaVersion: z.literal(COMMERCIAL_OCR_EVAL_CERTIFICATION_SCHEMA_VERSION),
    gate: z
      .object({
        profileId: z.literal(COMMERCIAL_OCR_EVAL_CERTIFICATION_GATE_PROFILE_ID),
        profileSha256: z.literal(COMMERCIAL_OCR_EVAL_CERTIFICATION_GATE_PROFILE_SHA256),
        passed: z.boolean(),
        failureCount: z.number().int().nonnegative(),
        failuresSha256: sha256Schema,
      })
      .strict(),
    certifiedSettingsProfiles: z
      .array(
        z
          .object({
            id: z.string().regex(PROFILE_ID_PATTERN),
            fingerprint: sha256Schema,
            metricsSha256: sha256Schema,
          })
          .strict(),
      )
      .min(1)
      .max(COMMERCIAL_OCR_MAX_CERTIFIED_SETTINGS_PROFILES),
    certifiedSettingsFingerprintSetSha256: sha256Schema,
    timestamps: z
      .object({
        runStartedAt: z.string().datetime({ offset: true }),
        evaluatedAt: z.string().datetime({ offset: true }),
        issuedAt: z.string().datetime({ offset: true }),
        expiresAt: z.string().datetime({ offset: true }),
      })
      .strict(),
    source: z
      .object({
        gitCommit: gitShaSchema,
        sourceSha: gitShaSchema,
        immutableImageSha256: sha256Schema,
        auditTool: z
          .object({
            digestKind: digestKindSchema,
            sourceSha256: sha256Schema,
          })
          .strict(),
      })
      .strict(),
    report: z
      .object({
        schemaVersion: z.literal(3),
        sha256: sha256Schema,
      })
      .strict(),
    corpus: z
      .object({
        schemaVersion: z.union([z.literal(1), z.literal(2)]),
        id: z.string().min(1),
        revision: z.string().min(1),
        manifestSha256: sha256Schema,
        descriptorSha256: sha256Schema,
        provenance: corpusProvenanceSchema.nullable(),
      })
      .strict(),
    behavior: z
      .object({
        fingerprintSha256: sha256Schema,
        ocr: z
          .object({
            version: z.string().min(1),
            digestKind: digestKindSchema,
            sourceSha256: sha256Schema,
          })
          .strict(),
        policy: z
          .object({
            version: z.string().min(1),
            digestKind: digestKindSchema,
            sourceSha256: sha256Schema,
          })
          .strict(),
        preprocess: z
          .object({
            profiles: z
              .object({
                primary: z.string().min(1),
                confirmation: z.string().min(1),
              })
              .strict(),
            digestKind: digestKindSchema,
            sourceSha256: sha256Schema,
          })
          .strict(),
        detector: z
          .object({
            digestKind: digestKindSchema,
            sourceSha256: sha256Schema,
            decisionVersion: z.string().min(1),
            patternPolicyVersion: z.string().min(1),
            classifierVersion: z.string().min(1),
          })
          .strict(),
        native: commercialOcrCompleteNativeBehaviorIdentitySchema,
        evaluation: z
          .object({
            concurrency: z.number().int().positive().max(4),
            performanceProfileSha256: sha256Schema,
            benchmarkEnvironmentSha256: sha256Schema,
            performanceSha256: sha256Schema,
          })
          .strict(),
      })
      .strict(),
    approval: z
      .object({
        algorithm: z.literal('Ed25519'),
        keyIdSha256: sha256Schema,
        signatureBase64: canonicalEd25519SignatureSchema,
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    const profileIds = value.certifiedSettingsProfiles.map((profile) => profile.id);
    const fingerprints = value.certifiedSettingsProfiles.map((profile) => profile.fingerprint);
    if (
      new Set(profileIds).size !== profileIds.length ||
      new Set(fingerprints).size !== fingerprints.length ||
      profileIds.some((id, index) => index > 0 && profileIds[index - 1]!.localeCompare(id) >= 0)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['certifiedSettingsProfiles'],
        message: 'certified settings profiles must be unique and sorted by id',
      });
    }
    try {
      if (
        value.certifiedSettingsFingerprintSetSha256 !==
        digestCommercialOcrSettingsFingerprintSet(fingerprints)
      ) {
        context.addIssue({
          code: 'custom',
          path: ['certifiedSettingsFingerprintSetSha256'],
          message: 'certified settings fingerprint set digest is inconsistent',
        });
      }
    } catch {
      context.addIssue({
        code: 'custom',
        path: ['certifiedSettingsProfiles'],
        message: 'certified settings fingerprint set is invalid',
      });
    }
    if (value.gate.passed && value.source.gitCommit !== value.source.sourceSha) {
      context.addIssue({
        code: 'custom',
        path: ['source', 'sourceSha'],
        message: 'source SHA must equal the evaluated Git commit',
      });
    }
    const runStartedAt = Date.parse(value.timestamps.runStartedAt);
    const evaluatedAt = Date.parse(value.timestamps.evaluatedAt);
    const issuedAt = Date.parse(value.timestamps.issuedAt);
    const expiresAt = Date.parse(value.timestamps.expiresAt);
    if (!(runStartedAt <= evaluatedAt && evaluatedAt <= issuedAt && issuedAt < expiresAt)) {
      context.addIssue({
        code: 'custom',
        path: ['timestamps'],
        message: 'certification timestamps must be ordered',
      });
    }
    if (issuedAt - evaluatedAt > COMMERCIAL_OCR_EVAL_CERTIFICATION_MAX_ISSUANCE_LAG_MS) {
      context.addIssue({
        code: 'custom',
        path: ['timestamps', 'issuedAt'],
        message: 'certification must be issued promptly after evaluation',
      });
    }
    if (expiresAt - evaluatedAt !== COMMERCIAL_OCR_EVAL_CERTIFICATION_TTL_MS) {
      context.addIssue({
        code: 'custom',
        path: ['timestamps', 'expiresAt'],
        message: 'certification expiry must use the fixed TTL',
      });
    }
    if (value.gate.passed !== (value.gate.failureCount === 0)) {
      context.addIssue({
        code: 'custom',
        path: ['gate'],
        message: 'gate outcome and failure count are inconsistent',
      });
    }
    if (value.corpus.schemaVersion === 1 && value.corpus.provenance !== null) {
      context.addIssue({
        code: 'custom',
        path: ['corpus', 'provenance'],
        message: 'schema-v1 corpus must not claim schema-v2 provenance',
      });
    }
    if (value.corpus.schemaVersion === 2 && value.corpus.provenance === null) {
      context.addIssue({
        code: 'custom',
        path: ['corpus', 'provenance'],
        message: 'schema-v2 corpus requires provenance',
      });
    }
    const expectedCorpusDescriptorSha256 = calculateCommercialOcrEvalCanonicalSha256({
      schemaVersion: value.corpus.schemaVersion,
      id: value.corpus.id,
      revision: value.corpus.revision,
      manifestSha256: value.corpus.manifestSha256,
      provenance: value.corpus.provenance,
    });
    if (value.corpus.descriptorSha256 !== expectedCorpusDescriptorSha256) {
      context.addIssue({
        code: 'custom',
        path: ['corpus', 'descriptorSha256'],
        message: 'corpus descriptor digest is inconsistent',
      });
    }
    if (value.gate.passed) {
      const provenance = value.corpus.provenance;
      if (
        value.corpus.schemaVersion !== 2 ||
        provenance?.sourceKind !== 'production_temporal' ||
        provenance.collectionProtocolVersion !==
          COMMERCIAL_OCR_CERTIFICATION_COLLECTION_PROTOCOL_VERSION ||
        provenance.annotationProtocolVersion !==
          COMMERCIAL_OCR_CERTIFICATION_ANNOTATION_PROTOCOL_VERSION
      ) {
        context.addIssue({
          code: 'custom',
          path: ['corpus'],
          message: 'passing certification requires the supported production corpus protocols',
        });
      }
    }
  });

export type CommercialOcrEvalCertificationEnvelope = z.infer<
  typeof commercialOcrEvalCertificationEnvelopeSchema
>;

export const commercialOcrEvalCertificationRequestSchema = z
  .object({
    kind: z.literal(COMMERCIAL_OCR_EVAL_CERTIFICATION_REQUEST_KIND),
    schemaVersion: z.literal(COMMERCIAL_OCR_EVAL_CERTIFICATION_REQUEST_SCHEMA_VERSION),
    unsignedEnvelope: commercialOcrEvalCertificationEnvelopeSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const envelope = value.unsignedEnvelope;
    if (
      envelope.approval.keyIdSha256 === UNSIGNED_APPROVAL_KEY_ID_SHA256 ||
      envelope.approval.signatureBase64 !== UNSIGNED_APPROVAL_SIGNATURE_BASE64
    ) {
      context.addIssue({
        code: 'custom',
        path: ['unsignedEnvelope', 'approval'],
        message: 'certification request must contain the exact unsigned approval marker',
      });
    }
    if (envelope.timestamps.issuedAt !== envelope.timestamps.evaluatedAt) {
      context.addIssue({
        code: 'custom',
        path: ['unsignedEnvelope', 'timestamps', 'issuedAt'],
        message: 'certification request issue timestamp must equal evaluation time',
      });
    }
  });

export type CommercialOcrEvalCertificationRequest = z.infer<
  typeof commercialOcrEvalCertificationRequestSchema
>;

export function createCommercialOcrEvalCertificationRequest(params: {
  report: CommercialOcrEvalReport;
  gates: CommercialOcrEvalGateResult;
  approvalKeyIdSha256: string;
}): CommercialOcrEvalCertificationRequest {
  if (
    !LOWER_SHA_256_PATTERN.test(params.approvalKeyIdSha256) ||
    params.approvalKeyIdSha256 === UNSIGNED_APPROVAL_KEY_ID_SHA256
  ) {
    throw new Error('Commercial OCR certification approval key id is invalid');
  }
  const unsignedEnvelope = buildCommercialOcrEvalCertificationEnvelope({
    report: params.report,
    gates: params.gates,
    issuedAt: params.report.generatedAt,
  });
  const request = commercialOcrEvalCertificationRequestSchema.parse({
    kind: COMMERCIAL_OCR_EVAL_CERTIFICATION_REQUEST_KIND,
    schemaVersion: COMMERCIAL_OCR_EVAL_CERTIFICATION_REQUEST_SCHEMA_VERSION,
    unsignedEnvelope: {
      ...unsignedEnvelope,
      approval: {
        algorithm: 'Ed25519',
        keyIdSha256: params.approvalKeyIdSha256,
        signatureBase64: UNSIGNED_APPROVAL_SIGNATURE_BASE64,
      },
    },
  });
  commercialOcrEvalCertificationRequestPureSchema.parse(request);
  return request;
}

export function validateCommercialOcrEvalCertificationRequestForSigning(
  value: unknown,
  issuedAt: string,
): CommercialOcrEvalCertificationRequest {
  const request = commercialOcrEvalCertificationRequestSchema.parse(value);
  normalizeCertificationIssueTime(request, issuedAt);
  validateCommercialOcrEvalCertificationRequestPureForSigning(request, issuedAt);
  return request;
}

export function signCommercialOcrEvalCertificationRequest(params: {
  request: unknown;
  approvalPrivateKey: string | Buffer;
  issuedAt?: string;
}): CommercialOcrEvalCertificationEnvelope {
  return commercialOcrEvalCertificationEnvelopeSchema.parse(
    signCommercialOcrEvalCertificationRequestPure({
      request: params.request,
      approvalPrivateKey: params.approvalPrivateKey,
      issuedAt: params.issuedAt ?? new Date().toISOString(),
    }),
  );
}

export function createCommercialOcrEvalCertificationEnvelope(params: {
  report: CommercialOcrEvalReport;
  gates: CommercialOcrEvalGateResult;
  approvalPrivateKey: string | Buffer;
  issuedAt?: string;
}): CommercialOcrEvalCertificationEnvelope {
  const privateKey = createPrivateKey(params.approvalPrivateKey);
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('Commercial OCR certification approval key must be Ed25519');
  }
  const approvalKeyIdSha256 = createHash('sha256')
    .update(createPublicKey(privateKey).export({ type: 'spki', format: 'der' }))
    .digest('hex');
  return signCommercialOcrEvalCertificationRequest({
    request: createCommercialOcrEvalCertificationRequest({
      report: params.report,
      gates: params.gates,
      approvalKeyIdSha256,
    }),
    approvalPrivateKey: params.approvalPrivateKey,
    ...(params.issuedAt ? { issuedAt: params.issuedAt } : {}),
  });
}

function buildCommercialOcrEvalCertificationEnvelope(params: {
  report: CommercialOcrEvalReport;
  gates: CommercialOcrEvalGateResult;
  issuedAt: string;
}) {
  if (
    !params.gates.passed ||
    params.gates.profileSha256 !== COMMERCIAL_OCR_EVAL_CERTIFICATION_GATE_PROFILE_SHA256
  ) {
    throw new Error('Commercial OCR certification requires the passing active gate profile');
  }
  const issuedAtMs = Date.parse(params.issuedAt);
  if (!Number.isFinite(issuedAtMs)) {
    throw new Error('Invalid commercial OCR certification issue timestamp');
  }
  const evaluatedAtMs = Date.parse(params.report.generatedAt);
  if (!Number.isFinite(evaluatedAtMs)) {
    throw new Error('Invalid commercial OCR certification evaluation timestamp');
  }
  const issuedAt = new Date(issuedAtMs).toISOString();
  const expiresAt = new Date(
    evaluatedAtMs + COMMERCIAL_OCR_EVAL_CERTIFICATION_TTL_MS,
  ).toISOString();
  const corpusDescriptor = {
    schemaVersion: params.report.corpusSchemaVersion,
    id: params.report.corpusId,
    revision: params.report.corpusRevision,
    manifestSha256: params.report.provenance.artifact.manifestSha256,
    provenance: params.report.corpusProvenance,
  };
  const certifiedSettingsProfiles = resolveCertifiedSettingsProfiles(params.report, params.gates);
  const certifiedSettingsFingerprints = normalizeCommercialOcrSettingsFingerprints(
    certifiedSettingsProfiles.map((profile) => profile.fingerprint),
  );
  const certifiedBehavior = requireCertificationBehavior(params.report);
  return {
    kind: COMMERCIAL_OCR_EVAL_CERTIFICATION_KIND,
    schemaVersion: COMMERCIAL_OCR_EVAL_CERTIFICATION_SCHEMA_VERSION,
    gate: {
      profileId: COMMERCIAL_OCR_EVAL_CERTIFICATION_GATE_PROFILE_ID,
      profileSha256: COMMERCIAL_OCR_EVAL_CERTIFICATION_GATE_PROFILE_SHA256,
      passed: params.gates.passed,
      failureCount: params.gates.failures.length,
      failuresSha256: calculateCommercialOcrEvalCanonicalSha256(params.gates.failures),
    },
    certifiedSettingsProfiles,
    certifiedSettingsFingerprintSetSha256: digestCommercialOcrSettingsFingerprintSet(
      certifiedSettingsFingerprints,
    ),
    timestamps: {
      runStartedAt: params.report.provenance.run.startedAt,
      evaluatedAt: params.report.generatedAt,
      issuedAt,
      expiresAt,
    },
    source: {
      gitCommit: params.report.provenance.run.git.commit,
      sourceSha: params.report.provenance.artifact.sourceSha,
      immutableImageSha256: params.report.provenance.artifact.immutableImageSha256,
      auditTool: params.report.provenance.run.auditTool,
    },
    report: {
      schemaVersion: params.report.schemaVersion,
      sha256: calculateCommercialOcrEvalCanonicalSha256(params.report),
    },
    corpus: {
      ...corpusDescriptor,
      descriptorSha256: calculateCommercialOcrEvalCanonicalSha256(corpusDescriptor),
    },
    behavior: {
      fingerprintSha256: certifiedBehavior.fingerprintSha256,
      ocr: params.report.provenance.fingerprints.ocr,
      policy: params.report.provenance.fingerprints.policy,
      preprocess: params.report.provenance.fingerprints.preprocess,
      detector: params.report.provenance.fingerprints.detector,
      native: {
        fingerprintSha256: certifiedBehavior.nativeFingerprintSha256,
        manifest: certifiedBehavior.descriptor.native,
      },
      evaluation: {
        concurrency: params.report.provenance.tesseract.resourceLimits.evalConcurrency,
        performanceProfileSha256: COMMERCIAL_OCR_EVAL_CERTIFICATION_GATE_PROFILE_SHA256,
        benchmarkEnvironmentSha256: params.report.provenance.benchmarkEnvironment.descriptorSha256,
        performanceSha256: calculateCommercialOcrEvalCanonicalSha256(params.report.performance),
      },
    },
  };
}

function normalizeCertificationIssueTime(
  request: CommercialOcrEvalCertificationRequest,
  value: string,
): string {
  const issuedAtMs = Date.parse(value);
  const evaluatedAtMs = Date.parse(request.unsignedEnvelope.timestamps.evaluatedAt);
  const expiresAtMs = Date.parse(request.unsignedEnvelope.timestamps.expiresAt);
  if (
    !Number.isFinite(issuedAtMs) ||
    issuedAtMs < evaluatedAtMs ||
    issuedAtMs - evaluatedAtMs > COMMERCIAL_OCR_EVAL_CERTIFICATION_MAX_ISSUANCE_LAG_MS ||
    issuedAtMs >= expiresAtMs
  ) {
    throw new Error('Commercial OCR certification must be issued promptly after evaluation');
  }
  return new Date(issuedAtMs).toISOString();
}

export function commercialOcrEvalCertificationSigningBytes(value: {
  approval: { algorithm: 'Ed25519'; keyIdSha256: string; signatureBase64?: string };
  [key: string]: unknown;
}): Buffer {
  return commercialOcrEvalCertificationSigningBytesPure(value);
}

function resolveCertifiedSettingsProfiles(
  report: CommercialOcrEvalReport,
  gates: CommercialOcrEvalGateResult,
): Array<{ id: string; fingerprint: string; metricsSha256: string }> {
  const profileIds = Object.keys(gates.metrics.profiles).sort((left, right) =>
    left.localeCompare(right),
  );
  if (profileIds.length < 1 || profileIds.length > COMMERCIAL_OCR_MAX_CERTIFIED_SETTINGS_PROFILES) {
    throw new Error('Commercial OCR certification settings profile count is invalid');
  }
  return profileIds.map((id) => {
    const fingerprints = [
      ...new Set(
        report.cases
          .filter((item) => item.settingsProfileId === id)
          .map((item) => item.settingsFingerprint),
      ),
    ];
    if (fingerprints.length !== 1) {
      throw new Error(`Commercial OCR certification profile ${id} has no exact fingerprint`);
    }
    const [fingerprint] = normalizeCommercialOcrSettingsFingerprints(fingerprints);
    return {
      id,
      fingerprint: fingerprint!,
      metricsSha256: calculateCommercialOcrEvalCanonicalSha256(gates.metrics.profiles[id]),
    };
  });
}

function requireCertificationBehavior(
  report: CommercialOcrEvalReport,
): CommercialOcrEvalReport['provenance']['behaviorIdentity'] {
  const behavior = report.provenance.behaviorIdentity;
  const recomputed = resolveCommercialOcrBehaviorIdentity(behavior.descriptor);
  if (
    !behavior.nativeVerification.verified ||
    behavior.nativeVerification.status !== 'verified' ||
    behavior.nativeVerification.mismatches.length !== 0 ||
    recomputed.fingerprintSha256 !== behavior.fingerprintSha256
  ) {
    throw new Error('Commercial OCR certification behavior identity is not verified');
  }
  const native = commercialOcrCompleteNativeBehaviorIdentitySchema.safeParse({
    fingerprintSha256: behavior.nativeFingerprintSha256,
    manifest: behavior.descriptor.native,
  });
  if (!native.success) {
    throw new Error('Commercial OCR certification native behavior identity is incomplete');
  }
  return behavior;
}

export { calculateCommercialOcrEvalCanonicalSha256 } from './commercial-ocr-eval-canonical';
