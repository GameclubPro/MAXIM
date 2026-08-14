import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';

import { z } from 'zod';

import { digestCommercialOcrSettingsFingerprintSet } from '../commercial-ocr-settings-profile';
import {
  calculateCommercialOcrEvalCanonicalSha256,
  canonicalCommercialOcrEvalJson,
} from './commercial-ocr-eval-canonical';

const LOWER_GIT_SHA_PATTERN = /^[a-f0-9]{40}$/u;
const LOWER_SHA_256_PATTERN = /^[a-f0-9]{64}$/u;
const PROFILE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+~-]{0,127}$/u;
const SHA512_INTEGRITY_PATTERN = /^sha512-[A-Za-z0-9+/]+={0,2}$/u;
const ED25519_SIGNATURE_BYTES = 64;
const SIGNING_DOMAIN = 'MAXIM commercial OCR certification v1';
const UNSIGNED_SIGNATURE_BASE64 = Buffer.alloc(ED25519_SIGNATURE_BYTES).toString('base64');

export const COMMERCIAL_OCR_EVAL_CERTIFICATION_SCHEMA_VERSION = 1 as const;
export const COMMERCIAL_OCR_EVAL_CERTIFICATION_REQUEST_SCHEMA_VERSION = 1 as const;
export const COMMERCIAL_OCR_EVAL_CERTIFICATION_KIND =
  'commercial_ocr_enforcement_certification' as const;
export const COMMERCIAL_OCR_EVAL_CERTIFICATION_REQUEST_KIND =
  'commercial_ocr_enforcement_certification_request' as const;
export const COMMERCIAL_OCR_EVAL_CERTIFICATION_GATE_PROFILE_ID =
  'commercial_ocr_cyrillic_enforcement_v1' as const;
export const COMMERCIAL_OCR_EVAL_CERTIFICATION_GATE_PROFILE_SHA256 =
  '758db751cefee1f6f85e734631fc6573d2ac83cad1bb3284d32cc21c9b489693' as const;
export const COMMERCIAL_OCR_EVAL_CERTIFICATION_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
export const COMMERCIAL_OCR_EVAL_CERTIFICATION_MAX_ISSUANCE_LAG_MS = 24 * 60 * 60 * 1_000;

const sha256Schema = z.string().regex(LOWER_SHA_256_PATTERN);
const gitShaSchema = z.string().regex(LOWER_GIT_SHA_PATTERN);
const packageVersionSchema = z.string().regex(VERSION_PATTERN);
const digestKindSchema = z.enum(['SOURCE_FILES', 'VERSION_DESCRIPTOR']);
const canonicalEd25519SignatureSchema = z.string().refine((value) => {
  const bytes = Buffer.from(value, 'base64');
  return bytes.byteLength === ED25519_SIGNATURE_BYTES && bytes.toString('base64') === value;
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

const buildIdentitySchema = z
  .object({
    nodeBaseImage: z
      .object({
        reference: z.string().min(1).max(512),
        digest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
      })
      .strict(),
    packages: z
      .object({
        sharp: z
          .object({
            name: z.literal('sharp'),
            version: packageVersionSchema,
            integrity: z.string().regex(SHA512_INTEGRITY_PATTERN),
          })
          .strict(),
        tesseract: packageIdentitySchema('tesseract-ocr'),
        traineddataEng: packageIdentitySchema('tesseract-ocr-data-eng'),
        traineddataRus: packageIdentitySchema('tesseract-ocr-data-rus'),
      })
      .strict(),
  })
  .strict();

const nativeArtifactSchema = z
  .object({
    runtime: z
      .object({
        nodeVersion: z.string().regex(/^v\d+\.\d+\.\d+$/u),
        platform: z.string().min(1).max(64),
        architecture: z.string().min(1).max(64),
        sharpVersion: packageVersionSchema,
        libvipsVersion: packageVersionSchema,
      })
      .strict(),
    tesseract: z
      .object({
        version: z.string().min(1).max(256),
        binarySha256: sha256Schema,
        availableLanguages: z
          .array(z.string().regex(/^[A-Za-z0-9_-]+$/u))
          .min(2)
          .max(128)
          .readonly(),
        traineddataSha256: z.object({ rus: sha256Schema, eng: sha256Schema }).strict(),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    if (!value.tesseract.availableLanguages.includes('rus')) {
      context.addIssue({
        code: 'custom',
        path: ['tesseract', 'availableLanguages'],
        message: 'rus is required',
      });
    }
    if (!value.tesseract.availableLanguages.includes('eng')) {
      context.addIssue({
        code: 'custom',
        path: ['tesseract', 'availableLanguages'],
        message: 'eng is required',
      });
    }
    if (
      value.tesseract.availableLanguages.some(
        (language, index, values) => index > 0 && values[index - 1]!.localeCompare(language) >= 0,
      )
    ) {
      context.addIssue({
        code: 'custom',
        path: ['tesseract', 'availableLanguages'],
        message: 'available languages must be unique and sorted',
      });
    }
  });

const nativeManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    buildManifestSha256: sha256Schema,
    source: z
      .object({
        digestKind: z.literal('SOURCE_FILES'),
        sourceSha256: sha256Schema,
        sourceFileCount: z.number().int().positive(),
      })
      .strict(),
    build: buildIdentitySchema,
    artifacts: nativeArtifactSchema,
    engine: z
      .object({
        languages: z.tuple([z.literal('rus'), z.literal('eng')]).readonly(),
        oem: z.literal(1),
        psm: z.object({ primary: z.literal(11), confirmation: z.literal(6) }).strict(),
      })
      .strict(),
    sourceImages: z
      .object({
        allowedFormats: z.tuple([
          z.literal('jpeg'),
          z.literal('png'),
          z.literal('webp'),
          z.literal('gif'),
          z.literal('avif'),
          z.literal('heif'),
          z.literal('tiff'),
        ]),
      })
      .strict(),
    controls: positiveIntegerRecordSchema([
      'timeoutMs',
      'concurrency',
      'maxQueue',
      'recycleAfterJobs',
      'maxSourceImageBytes',
      'maxImageBytes',
      'maxOutputBytes',
      'maxInputPixels',
      'maxOutputPixels',
      'maxSide',
      'ompThreadLimit',
      'sharpConcurrency',
      'sharpProcessingTimeoutSeconds',
    ]),
    orchestration: positiveIntegerRecordSchema([
      'workerStartupTimeoutMs',
      'workerResultGraceMs',
      'workerRestartDelayMs',
      'workerRetryCooldownMs',
      'workerShutdownGraceMs',
      'workerForceExitGraceMs',
      'maxWorkerRestartAttempts',
      'workerStartupProbeTimeoutMs',
      'workerStartupProbeMaxOutputBytes',
      'nativeProcessKillSettleGraceMs',
      'nativeStderrCaptureMaxBytes',
    ]),
  })
  .strict();

const nativeIdentitySchema = z
  .object({ fingerprintSha256: sha256Schema, manifest: nativeManifestSchema })
  .strict()
  .superRefine((value, context) => {
    if (calculateCommercialOcrEvalCanonicalSha256(value.manifest) !== value.fingerprintSha256) {
      context.addIssue({
        code: 'custom',
        path: ['fingerprintSha256'],
        message: 'native behavior fingerprint is inconsistent',
      });
    }
  });

export const commercialOcrEvalCertificationEnvelopePureSchema = z
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
      .max(32),
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
        auditTool: z.object({ digestKind: digestKindSchema, sourceSha256: sha256Schema }).strict(),
      })
      .strict(),
    report: z.object({ schemaVersion: z.literal(3), sha256: sha256Schema }).strict(),
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
              .object({ primary: z.string().min(1), confirmation: z.string().min(1) })
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
        native: nativeIdentitySchema,
        evaluation: z
          .object({
            concurrency: z.number().int().positive().max(4),
            performanceProfileSha256: z.literal(
              COMMERCIAL_OCR_EVAL_CERTIFICATION_GATE_PROFILE_SHA256,
            ),
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
        message: 'timestamps are unordered',
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
      context.addIssue({ code: 'custom', path: ['gate'], message: 'gate outcome is inconsistent' });
    }
    const corpusDescriptor = {
      schemaVersion: value.corpus.schemaVersion,
      id: value.corpus.id,
      revision: value.corpus.revision,
      manifestSha256: value.corpus.manifestSha256,
      provenance: value.corpus.provenance,
    };
    if (
      calculateCommercialOcrEvalCanonicalSha256(corpusDescriptor) !== value.corpus.descriptorSha256
    ) {
      context.addIssue({
        code: 'custom',
        path: ['corpus', 'descriptorSha256'],
        message: 'corpus descriptor digest is inconsistent',
      });
    }
    if (
      value.gate.passed &&
      (value.corpus.schemaVersion !== 2 ||
        value.corpus.provenance?.sourceKind !== 'production_temporal' ||
        value.corpus.provenance.collectionProtocolVersion !== 'production-temporal-random-v1' ||
        value.corpus.provenance.annotationProtocolVersion !== 'ocr-adjudication-v2')
    ) {
      context.addIssue({
        code: 'custom',
        path: ['corpus'],
        message: 'passing certification requires supported production corpus protocols',
      });
    }
  });

export type CommercialOcrEvalCertificationEnvelopePure = z.infer<
  typeof commercialOcrEvalCertificationEnvelopePureSchema
>;

export const commercialOcrEvalCertificationRequestPureSchema = z
  .object({
    kind: z.literal(COMMERCIAL_OCR_EVAL_CERTIFICATION_REQUEST_KIND),
    schemaVersion: z.literal(COMMERCIAL_OCR_EVAL_CERTIFICATION_REQUEST_SCHEMA_VERSION),
    unsignedEnvelope: commercialOcrEvalCertificationEnvelopePureSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const envelope = value.unsignedEnvelope;
    if (
      envelope.approval.keyIdSha256 === '0'.repeat(64) ||
      envelope.approval.signatureBase64 !== UNSIGNED_SIGNATURE_BASE64
    ) {
      context.addIssue({
        code: 'custom',
        path: ['unsignedEnvelope', 'approval'],
        message: 'certification request approval marker is invalid',
      });
    }
    if (envelope.timestamps.issuedAt !== envelope.timestamps.evaluatedAt) {
      context.addIssue({
        code: 'custom',
        path: ['unsignedEnvelope', 'timestamps', 'issuedAt'],
        message: 'request issue timestamp must equal evaluation time',
      });
    }
    if (!envelope.gate.passed || envelope.gate.failureCount !== 0) {
      context.addIssue({
        code: 'custom',
        path: ['unsignedEnvelope', 'gate'],
        message: 'certification request gate did not pass',
      });
    }
  });

export type CommercialOcrEvalCertificationRequestPure = z.infer<
  typeof commercialOcrEvalCertificationRequestPureSchema
>;

export function validateCommercialOcrEvalCertificationRequestPureForSigning(
  value: unknown,
  issuedAt: string,
): CommercialOcrEvalCertificationRequestPure {
  const request = commercialOcrEvalCertificationRequestPureSchema.parse(value);
  normalizeIssueTime(request, issuedAt);
  return request;
}

export function signCommercialOcrEvalCertificationRequestPure(params: {
  request: unknown;
  approvalPrivateKey: string | Buffer;
  issuedAt: string;
}): CommercialOcrEvalCertificationEnvelopePure {
  const request = validateCommercialOcrEvalCertificationRequestPureForSigning(
    params.request,
    params.issuedAt,
  );
  const issuedAt = normalizeIssueTime(request, params.issuedAt);
  const privateKey = createPrivateKey(params.approvalPrivateKey);
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('Commercial OCR certification approval key must be Ed25519');
  }
  const publicKeyDer = createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
  const approval = {
    algorithm: 'Ed25519' as const,
    keyIdSha256: createHash('sha256').update(publicKeyDer).digest('hex'),
  };
  if (approval.keyIdSha256 !== request.unsignedEnvelope.approval.keyIdSha256) {
    throw new Error('Commercial OCR certification approval key does not match request');
  }
  const unsignedEnvelope = {
    ...request.unsignedEnvelope,
    timestamps: { ...request.unsignedEnvelope.timestamps, issuedAt },
    approval,
  };
  const signatureBase64 = sign(
    null,
    commercialOcrEvalCertificationSigningBytesPure(unsignedEnvelope),
    privateKey,
  ).toString('base64');
  return commercialOcrEvalCertificationEnvelopePureSchema.parse({
    ...unsignedEnvelope,
    approval: { ...approval, signatureBase64 },
  });
}

export function commercialOcrEvalCertificationSigningBytesPure(value: {
  approval: { algorithm: 'Ed25519'; keyIdSha256: string; signatureBase64?: string };
  [key: string]: unknown;
}): Buffer {
  const approval = {
    algorithm: value.approval.algorithm,
    keyIdSha256: value.approval.keyIdSha256,
  };
  const payload = Buffer.from(canonicalCommercialOcrEvalJson({ ...value, approval }), 'utf8');
  return Buffer.concat([Buffer.from(`${SIGNING_DOMAIN}:${payload.byteLength}:`, 'utf8'), payload]);
}

function normalizeIssueTime(
  request: CommercialOcrEvalCertificationRequestPure,
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

function packageIdentitySchema(name: string) {
  return z.object({ name: z.literal(name), version: packageVersionSchema }).strict();
}

function positiveIntegerRecordSchema<const T extends readonly string[]>(keys: T) {
  return z
    .object(
      Object.fromEntries(keys.map((key) => [key, z.number().int().positive()])) as {
        [K in T[number]]: z.ZodNumber;
      },
    )
    .strict();
}
