import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import {
  access,
  constants as fsConstants,
  readFile,
  realpath,
} from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { z } from 'zod';

import { COMMERCIAL_ENGINE_CONFIG } from '../commercial/commercial-config';
import { resolvePhotoDownloadMaxBytes } from '../photo-duplicate/secure-photo-downloader';
import { COMMERCIAL_SECOND_STAGE_VERSION } from '../rule-engine-commercial-second-stage-cache';
import {
  COMMERCIAL_OCR_DECISION_POLICY_VERSION,
  COMMERCIAL_OCR_DELETE_GATE,
} from './commercial-ocr-decision-policy';
import {
  COMMERCIAL_OCR_BUILD_IDENTITY,
  COMMERCIAL_OCR_DETECTOR_SOURCE_FILE_COUNT,
  COMMERCIAL_OCR_DETECTOR_SOURCE_SHA256,
  COMMERCIAL_OCR_PRODUCTION_NATIVE_ENVIRONMENT,
  COMMERCIAL_OCR_RUNTIME_SOURCE_FILE_COUNT,
  COMMERCIAL_OCR_RUNTIME_SOURCE_SHA256,
} from './commercial-ocr-detector-source.generated';
import {
  COMMERCIAL_OCR_DEFAULT_PREPROCESS_LIMITS,
  COMMERCIAL_OCR_PREPROCESS_PROFILES,
  COMMERCIAL_OCR_SHARP_CONCURRENCY,
  COMMERCIAL_OCR_SHARP_PROCESSING_TIMEOUT_SECONDS,
  resolveCommercialOcrPreprocessLimits,
  type CommercialOcrPreprocessConfigReader,
  type CommercialOcrPreprocessLimits,
} from './commercial-ocr-preprocess-config';
import { COMMERCIAL_OCR_DEFAULT_VERSION } from './commercial-ocr.queue';
import { SUPPORTED_PHOTO_IMAGE_FORMATS } from '../photo-duplicate/photo-image-format';

const execFileAsync = promisify(execFile);
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const SHA512_INTEGRITY_PATTERN = /^sha512-[A-Za-z0-9+/]+={0,2}$/u;
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+~-]{0,127}$/u;
const NATIVE_BUILD_MANIFEST_FILENAME = 'commercial-ocr-native-build-manifest.json';
const NATIVE_PROBE_TIMEOUT_MS = 5_000;
const NATIVE_PROBE_MAX_OUTPUT_BYTES = 1024 * 1024;

export const COMMERCIAL_OCR_NATIVE_BUILD_MANIFEST_KIND =
  'commercial_ocr_native_build_manifest' as const;
export const COMMERCIAL_OCR_NATIVE_BUILD_MANIFEST_SCHEMA_VERSION = 1 as const;
export const COMMERCIAL_OCR_NATIVE_BEHAVIOR_SCHEMA_VERSION = 1 as const;
export const COMMERCIAL_OCR_NATIVE_REQUIRED_LANGUAGES = ['rus', 'eng'] as const;

export const COMMERCIAL_OCR_NATIVE_ORCHESTRATION = Object.freeze({
  workerStartupTimeoutMs: 5_000,
  workerResultGraceMs: 500,
  workerRestartDelayMs: 100,
  workerRetryCooldownMs: 30_000,
  workerShutdownGraceMs: 1_000,
  workerForceExitGraceMs: 250,
  maxWorkerRestartAttempts: 3,
  workerStartupProbeTimeoutMs: 4_000,
  workerStartupProbeMaxOutputBytes: 64 * 1024,
  nativeProcessKillSettleGraceMs: 250,
  nativeStderrCaptureMaxBytes: 64 * 1024,
});

export type CommercialOcrNativeRuntimeControls = Readonly<{
  timeoutMs: number;
  concurrency: number;
  maxQueue: number;
  recycleAfterJobs: number;
  maxSourceImageBytes: number;
  maxImageBytes: number;
  maxOutputBytes: number;
  maxInputPixels: number;
  maxOutputPixels: number;
  maxSide: number;
  ompThreadLimit: number;
  sharpConcurrency: typeof COMMERCIAL_OCR_SHARP_CONCURRENCY;
  sharpProcessingTimeoutSeconds: typeof COMMERCIAL_OCR_SHARP_PROCESSING_TIMEOUT_SECONDS;
}>;

export type CommercialOcrNativeEngineConfig = Readonly<{
  binary: string;
  tessdataPrefix: string | null;
  ompThreadLimit: number;
}>;

export type CommercialOcrNativeArtifactSnapshot = Readonly<{
  runtime: Readonly<{
    nodeVersion: string;
    platform: string;
    architecture: string;
    sharpVersion: string;
    libvipsVersion: string;
  }>;
  tesseract: Readonly<{
    version: string;
    binarySha256: string;
    availableLanguages: readonly string[];
    traineddataSha256: Readonly<{ rus: string; eng: string }>;
  }>;
}>;

type PartialCommercialOcrNativeArtifactSnapshot = Readonly<{
  runtime: Readonly<{
    nodeVersion: string;
    platform: string;
    architecture: string;
    sharpVersion: string | null;
    libvipsVersion: string | null;
  }>;
  tesseract: Readonly<{
    version: string | null;
    binarySha256: string | null;
    availableLanguages: readonly string[] | null;
    traineddataSha256: Readonly<{ rus: string | null; eng: string | null }>;
  }>;
}>;

export type CommercialOcrNativeBuildManifest = Readonly<{
  kind: typeof COMMERCIAL_OCR_NATIVE_BUILD_MANIFEST_KIND;
  schemaVersion: typeof COMMERCIAL_OCR_NATIVE_BUILD_MANIFEST_SCHEMA_VERSION;
  build: typeof COMMERCIAL_OCR_BUILD_IDENTITY;
  artifacts: CommercialOcrNativeArtifactSnapshot;
}>;

export type CommercialOcrNativeBehaviorManifest = Readonly<{
  schemaVersion: typeof COMMERCIAL_OCR_NATIVE_BEHAVIOR_SCHEMA_VERSION;
  buildManifestSha256: string | null;
  source: Readonly<{
    digestKind: 'SOURCE_FILES';
    sourceSha256: typeof COMMERCIAL_OCR_RUNTIME_SOURCE_SHA256;
    sourceFileCount: typeof COMMERCIAL_OCR_RUNTIME_SOURCE_FILE_COUNT;
  }>;
  build: typeof COMMERCIAL_OCR_BUILD_IDENTITY;
  artifacts: PartialCommercialOcrNativeArtifactSnapshot;
  engine: Readonly<{
    languages: typeof COMMERCIAL_OCR_NATIVE_REQUIRED_LANGUAGES;
    oem: 1;
    psm: Readonly<{ primary: 11; confirmation: 6 }>;
  }>;
  sourceImages: Readonly<{ allowedFormats: typeof SUPPORTED_PHOTO_IMAGE_FORMATS }>;
  controls: CommercialOcrNativeRuntimeControls;
  orchestration: typeof COMMERCIAL_OCR_NATIVE_ORCHESTRATION;
}>;

export type CommercialOcrNativeBehaviorIdentity = Readonly<{
  fingerprintSha256: string;
  complete: boolean;
  manifest: CommercialOcrNativeBehaviorManifest;
}>;

export type CommercialOcrNativeArtifactVerification = Readonly<{
  verified: boolean;
  status: 'verified' | 'build_manifest_missing' | 'build_manifest_invalid' | 'probe_failed' | 'mismatch';
  mismatches: readonly string[];
  identity: CommercialOcrNativeBehaviorIdentity;
}>;

type NativeProbeCommandOptions = Readonly<{
  encoding: 'utf8';
  env: NodeJS.ProcessEnv;
  maxBuffer: number;
  timeout: number;
  killSignal: 'SIGKILL';
}>;

export type CommercialOcrNativeProbeDependencies = Readonly<{
  execFile: (
    binary: string,
    args: readonly string[],
    options: NativeProbeCommandOptions,
  ) => Promise<{ stdout: string; stderr: string }>;
  readFile: (pathname: string) => Promise<Buffer>;
  realpath: (pathname: string) => Promise<string>;
  access: (pathname: string, mode: number) => Promise<void>;
  runtime: Readonly<{ nodeVersion: string; platform: string; architecture: string }>;
  sharpVersions: Readonly<{ sharp: string | undefined; vips: string | undefined }>;
  environment: Readonly<NodeJS.ProcessEnv>;
  path: string | undefined;
  cwd: string;
}>;

export type CommercialOcrNativeBuildManifestReadResult = Readonly<{
  status: 'loaded' | 'missing' | 'invalid';
  pathname: string;
  sha256: string | null;
  manifest: CommercialOcrNativeBuildManifest | null;
}>;

const sha256Schema = z.string().regex(SHA256_PATTERN);
const packageVersionSchema = z.string().regex(VERSION_PATTERN);
const npmPackageIdentitySchema = z
  .object({
    name: z.literal('sharp'),
    version: packageVersionSchema,
    integrity: z.string().regex(SHA512_INTEGRITY_PATTERN),
  })
  .strict();
const apkPackageIdentitySchema = (name: string) =>
  z.object({ name: z.literal(name), version: packageVersionSchema }).strict();
const commercialOcrBuildIdentitySchema = z
  .object({
    nodeBaseImage: z
      .object({
        reference: z.string().min(1).max(512),
        digest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
      })
      .strict(),
    packages: z
      .object({
        sharp: npmPackageIdentitySchema,
        tesseract: apkPackageIdentitySchema('tesseract-ocr'),
        traineddataEng: apkPackageIdentitySchema('tesseract-ocr-data-eng'),
        traineddataRus: apkPackageIdentitySchema('tesseract-ocr-data-rus'),
      })
      .strict(),
  })
  .strict();
const commercialOcrNativeArtifactSnapshotSchema = z
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
    for (const language of COMMERCIAL_OCR_NATIVE_REQUIRED_LANGUAGES) {
      if (!value.tesseract.availableLanguages.includes(language)) {
        context.addIssue({
          code: 'custom',
          path: ['tesseract', 'availableLanguages'],
          message: `required language ${language} is unavailable`,
        });
      }
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

export const commercialOcrNativeBuildManifestSchema = z
  .object({
    kind: z.literal(COMMERCIAL_OCR_NATIVE_BUILD_MANIFEST_KIND),
    schemaVersion: z.literal(COMMERCIAL_OCR_NATIVE_BUILD_MANIFEST_SCHEMA_VERSION),
    build: commercialOcrBuildIdentitySchema,
    artifacts: commercialOcrNativeArtifactSnapshotSchema,
  })
  .strict();

const partialCommercialOcrNativeArtifactSnapshotSchema = z
  .object({
    runtime: z
      .object({
        nodeVersion: z.string().regex(/^v\d+\.\d+\.\d+$/u),
        platform: z.string().min(1).max(64),
        architecture: z.string().min(1).max(64),
        sharpVersion: packageVersionSchema.nullable(),
        libvipsVersion: packageVersionSchema.nullable(),
      })
      .strict(),
    tesseract: z
      .object({
        version: z.string().min(1).max(256).nullable(),
        binarySha256: sha256Schema.nullable(),
        availableLanguages: z
          .array(z.string().regex(/^[A-Za-z0-9_-]+$/u))
          .min(2)
          .max(128)
          .readonly()
          .nullable(),
        traineddataSha256: z
          .object({ rus: sha256Schema.nullable(), eng: sha256Schema.nullable() })
          .strict(),
      })
      .strict(),
  })
  .strict();

export const commercialOcrNativeBehaviorManifestSchema = z
  .object({
    schemaVersion: z.literal(COMMERCIAL_OCR_NATIVE_BEHAVIOR_SCHEMA_VERSION),
    buildManifestSha256: sha256Schema.nullable(),
    source: z
      .object({
        digestKind: z.literal('SOURCE_FILES'),
        sourceSha256: z.literal(COMMERCIAL_OCR_RUNTIME_SOURCE_SHA256),
        sourceFileCount: z.literal(COMMERCIAL_OCR_RUNTIME_SOURCE_FILE_COUNT),
      })
      .strict(),
    build: commercialOcrBuildIdentitySchema,
    artifacts: partialCommercialOcrNativeArtifactSnapshotSchema,
    engine: z
      .object({
        languages: z.tuple([z.literal('rus'), z.literal('eng')]).readonly(),
        oem: z.literal(1),
        psm: z.object({ primary: z.literal(11), confirmation: z.literal(6) }).strict(),
      })
      .strict(),
    sourceImages: z
      .object({
        allowedFormats: z
          .array(z.enum(SUPPORTED_PHOTO_IMAGE_FORMATS))
          .length(SUPPORTED_PHOTO_IMAGE_FORMATS.length)
          .readonly(),
      })
      .strict(),
    controls: z
      .object({
        timeoutMs: z.number().int().positive(),
        concurrency: z.number().int().positive(),
        maxQueue: z.number().int().positive(),
        recycleAfterJobs: z.number().int().positive(),
        maxSourceImageBytes: z.number().int().positive(),
        maxImageBytes: z.number().int().positive(),
        maxOutputBytes: z.number().int().positive(),
        maxInputPixels: z.number().int().positive(),
        maxOutputPixels: z.number().int().positive(),
        maxSide: z.number().int().positive(),
        ompThreadLimit: z.number().int().positive(),
        sharpConcurrency: z.literal(COMMERCIAL_OCR_SHARP_CONCURRENCY),
        sharpProcessingTimeoutSeconds: z.literal(
          COMMERCIAL_OCR_SHARP_PROCESSING_TIMEOUT_SECONDS,
        ),
      })
      .strict(),
    orchestration: z
      .object({
        workerStartupTimeoutMs: z.literal(
          COMMERCIAL_OCR_NATIVE_ORCHESTRATION.workerStartupTimeoutMs,
        ),
        workerResultGraceMs: z.literal(
          COMMERCIAL_OCR_NATIVE_ORCHESTRATION.workerResultGraceMs,
        ),
        workerRestartDelayMs: z.literal(
          COMMERCIAL_OCR_NATIVE_ORCHESTRATION.workerRestartDelayMs,
        ),
        workerRetryCooldownMs: z.literal(
          COMMERCIAL_OCR_NATIVE_ORCHESTRATION.workerRetryCooldownMs,
        ),
        workerShutdownGraceMs: z.literal(
          COMMERCIAL_OCR_NATIVE_ORCHESTRATION.workerShutdownGraceMs,
        ),
        workerForceExitGraceMs: z.literal(
          COMMERCIAL_OCR_NATIVE_ORCHESTRATION.workerForceExitGraceMs,
        ),
        maxWorkerRestartAttempts: z.literal(
          COMMERCIAL_OCR_NATIVE_ORCHESTRATION.maxWorkerRestartAttempts,
        ),
        workerStartupProbeTimeoutMs: z.literal(
          COMMERCIAL_OCR_NATIVE_ORCHESTRATION.workerStartupProbeTimeoutMs,
        ),
        workerStartupProbeMaxOutputBytes: z.literal(
          COMMERCIAL_OCR_NATIVE_ORCHESTRATION.workerStartupProbeMaxOutputBytes,
        ),
        nativeProcessKillSettleGraceMs: z.literal(
          COMMERCIAL_OCR_NATIVE_ORCHESTRATION.nativeProcessKillSettleGraceMs,
        ),
        nativeStderrCaptureMaxBytes: z.literal(
          COMMERCIAL_OCR_NATIVE_ORCHESTRATION.nativeStderrCaptureMaxBytes,
        ),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    try {
      requireExpectedBuildIdentity(value.build);
    } catch {
      context.addIssue({
        code: 'custom',
        path: ['build'],
        message: 'build identity does not match generated sources',
      });
    }
    if (
      value.sourceImages.allowedFormats.some(
        (format, index) => format !== SUPPORTED_PHOTO_IMAGE_FORMATS[index],
      )
    ) {
      context.addIssue({
        code: 'custom',
        path: ['sourceImages', 'allowedFormats'],
        message: 'source image formats are not canonical',
      });
    }
  });

export const commercialOcrCompleteNativeBehaviorIdentitySchema = z
  .object({
    fingerprintSha256: sha256Schema,
    manifest: commercialOcrNativeBehaviorManifestSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const manifest = value.manifest as unknown as CommercialOcrNativeBehaviorManifest;
    if (!isCommercialOcrNativeBehaviorManifestComplete(manifest)) {
      context.addIssue({
        code: 'custom',
        path: ['manifest'],
        message: 'native behavior identity is incomplete',
      });
    }
    if (
      fingerprintCommercialOcrNativeBehaviorManifest(manifest) !== value.fingerprintSha256
    ) {
      context.addIssue({
        code: 'custom',
        path: ['fingerprintSha256'],
        message: 'native behavior fingerprint is inconsistent',
      });
    }
  });

export const COMMERCIAL_OCR_DETECTOR_SOURCE_IDENTITY = Object.freeze({
  digestKind: 'SOURCE_FILES',
  sourceSha256: COMMERCIAL_OCR_DETECTOR_SOURCE_SHA256,
  sourceFileCount: COMMERCIAL_OCR_DETECTOR_SOURCE_FILE_COUNT,
  entrypoint: 'CommercialAdDetector.detect',
  featureSource: 'collectCommercialSignals',
  decisionVersion: COMMERCIAL_ENGINE_CONFIG.decisionVersion,
  patternPolicyVersion: COMMERCIAL_ENGINE_CONFIG.patternPolicyVersion,
  classifierVersion: COMMERCIAL_SECOND_STAGE_VERSION,
});

export type CommercialOcrBehaviorDescriptor = Readonly<{
  schemaVersion: 2;
  ocrVersion: string;
  preprocessProfiles: Readonly<Record<string, string>>;
  preprocessLimits: CommercialOcrPreprocessLimits;
  decisionPolicy: Readonly<{
    version: string;
    deleteGate: Readonly<Record<string, number>>;
  }>;
  detector: Readonly<{
    sourceIdentity: unknown;
    engineConfig: unknown;
  }>;
  native: CommercialOcrNativeBehaviorManifest;
}>;

export type CommercialOcrBehaviorIdentity = Readonly<{
  scope: string;
  fingerprint: string;
  fingerprintSha256: string;
  descriptor: CommercialOcrBehaviorDescriptor;
}>;

export function resolveCommercialOcrNativeRuntimeControls(
  configService?: CommercialOcrPreprocessConfigReader,
): CommercialOcrNativeRuntimeControls {
  const preprocess = resolveCommercialOcrPreprocessLimits(configService);
  return Object.freeze({
    timeoutMs: readBoundedPositiveInteger(
      configService?.get('COMMERCIAL_OCR_TESSERACT_TIMEOUT_MS'),
      10_000,
      250,
      60_000,
    ),
    concurrency: readBoundedPositiveInteger(
      configService?.get('COMMERCIAL_OCR_TESSERACT_CONCURRENCY'),
      1,
      1,
      8,
    ),
    maxQueue: readBoundedPositiveInteger(
      configService?.get('COMMERCIAL_OCR_TESSERACT_MAX_QUEUE'),
      16,
      1,
      256,
    ),
    recycleAfterJobs: readBoundedPositiveInteger(
      configService?.get('COMMERCIAL_OCR_TESSERACT_RECYCLE_AFTER_JOBS'),
      250,
      1,
      10_000,
    ),
    maxSourceImageBytes: resolvePhotoDownloadMaxBytes(
      configService?.get('PHOTO_DUPLICATE_MAX_BYTES'),
    ),
    maxImageBytes: readBoundedPositiveInteger(
      configService?.get('COMMERCIAL_OCR_TESSERACT_MAX_IMAGE_BYTES'),
      16 * 1024 * 1024,
      1_024,
      64 * 1024 * 1024,
    ),
    maxOutputBytes: readBoundedPositiveInteger(
      configService?.get('COMMERCIAL_OCR_TESSERACT_MAX_OUTPUT_BYTES'),
      4 * 1024 * 1024,
      64 * 1024,
      16 * 1024 * 1024,
    ),
    maxInputPixels: preprocess.maxInputPixels,
    maxOutputPixels: preprocess.maxOutputPixels,
    maxSide: preprocess.maxSide,
    ompThreadLimit: readBoundedPositiveInteger(
      configService?.get('OMP_THREAD_LIMIT'),
      1,
      1,
      8,
    ),
    sharpConcurrency: COMMERCIAL_OCR_SHARP_CONCURRENCY,
    sharpProcessingTimeoutSeconds: COMMERCIAL_OCR_SHARP_PROCESSING_TIMEOUT_SECONDS,
  });
}

export function resolveCommercialOcrNativeEngineConfig(
  configService?: CommercialOcrPreprocessConfigReader,
): CommercialOcrNativeEngineConfig {
  return Object.freeze({
    binary: readCommand(configService?.get('COMMERCIAL_OCR_TESSERACT_BINARY'), 'tesseract'),
    tessdataPrefix: readOptionalPath(configService?.get('COMMERCIAL_OCR_TESSDATA_PREFIX')),
    ompThreadLimit: readBoundedPositiveInteger(
      configService?.get('OMP_THREAD_LIMIT'),
      1,
      1,
      8,
    ),
  });
}

export function resolveCommercialOcrProductionNativeConfigReader(
  configService?: CommercialOcrPreprocessConfigReader,
): CommercialOcrPreprocessConfigReader {
  return Object.freeze({
    get(propertyPath: string): unknown {
      if (
        Object.prototype.hasOwnProperty.call(
          COMMERCIAL_OCR_PRODUCTION_NATIVE_ENVIRONMENT,
          propertyPath,
        )
      ) {
        return COMMERCIAL_OCR_PRODUCTION_NATIVE_ENVIRONMENT[
          propertyPath as keyof typeof COMMERCIAL_OCR_PRODUCTION_NATIVE_ENVIRONMENT
        ];
      }
      return configService?.get(propertyPath);
    },
  });
}

export function resolveCommercialOcrNativeBuildManifestPath(cwd = process.cwd()): string {
  return cwd === '/app'
    ? '/app/apps/api/commercial-ocr-native-build-manifest.json'
    : resolve(cwd, 'apps/api', NATIVE_BUILD_MANIFEST_FILENAME);
}

export function createCommercialOcrNativeBuildManifest(
  artifacts: CommercialOcrNativeArtifactSnapshot,
): CommercialOcrNativeBuildManifest {
  return deepFreeze(
    commercialOcrNativeBuildManifestSchema.parse({
      kind: COMMERCIAL_OCR_NATIVE_BUILD_MANIFEST_KIND,
      schemaVersion: COMMERCIAL_OCR_NATIVE_BUILD_MANIFEST_SCHEMA_VERSION,
      build: COMMERCIAL_OCR_BUILD_IDENTITY,
      artifacts: normalizeNativeArtifacts(artifacts),
    }),
  ) as CommercialOcrNativeBuildManifest;
}

export function serializeCommercialOcrNativeBuildManifest(
  manifest: CommercialOcrNativeBuildManifest,
): string {
  const parsed = commercialOcrNativeBuildManifestSchema.parse(manifest);
  requireExpectedBuildIdentity(parsed.build);
  return `${canonicalJson(parsed)}\n`;
}

export function readCommercialOcrNativeBuildManifest(
  pathname = resolveCommercialOcrNativeBuildManifestPath(),
): CommercialOcrNativeBuildManifestReadResult {
  let bytes: Buffer;
  try {
    bytes = readFileSync(pathname);
  } catch {
    return { status: 'missing', pathname, sha256: null, manifest: null };
  }
  try {
    const value = commercialOcrNativeBuildManifestSchema.parse(
      JSON.parse(bytes.toString('utf8')) as unknown,
    );
    requireExpectedBuildIdentity(value.build);
    const manifest = deepFreeze(value) as CommercialOcrNativeBuildManifest;
    if (bytes.toString('utf8') !== serializeCommercialOcrNativeBuildManifest(manifest)) {
      throw new Error('Commercial OCR native build manifest is not canonical');
    }
    return {
      status: 'loaded',
      pathname,
      sha256: sha256(bytes),
      manifest,
    };
  } catch {
    return { status: 'invalid', pathname, sha256: null, manifest: null };
  }
}

export function createCommercialOcrNativeBehaviorIdentity(params: {
  controls: CommercialOcrNativeRuntimeControls;
  artifacts?: CommercialOcrNativeArtifactSnapshot;
  buildManifestSha256?: string | null;
}): CommercialOcrNativeBehaviorIdentity {
  const artifacts = params.artifacts
    ? normalizeNativeArtifacts(params.artifacts)
    : unavailableNativeArtifacts();
  const buildManifestSha256 = normalizeOptionalSha256(params.buildManifestSha256 ?? null);
  const manifest = deepFreeze({
    schemaVersion: COMMERCIAL_OCR_NATIVE_BEHAVIOR_SCHEMA_VERSION,
    buildManifestSha256,
    source: {
      digestKind: 'SOURCE_FILES' as const,
      sourceSha256: COMMERCIAL_OCR_RUNTIME_SOURCE_SHA256,
      sourceFileCount: COMMERCIAL_OCR_RUNTIME_SOURCE_FILE_COUNT,
    },
    build: COMMERCIAL_OCR_BUILD_IDENTITY,
    artifacts,
    engine: {
      languages: COMMERCIAL_OCR_NATIVE_REQUIRED_LANGUAGES,
      oem: 1 as const,
      psm: { primary: 11 as const, confirmation: 6 as const },
    },
    sourceImages: { allowedFormats: SUPPORTED_PHOTO_IMAGE_FORMATS },
    controls: params.controls,
    orchestration: COMMERCIAL_OCR_NATIVE_ORCHESTRATION,
  }) as CommercialOcrNativeBehaviorManifest;
  return Object.freeze({
    fingerprintSha256: fingerprintCommercialOcrNativeBehaviorManifest(manifest),
    complete: isCommercialOcrNativeBehaviorManifestComplete(manifest),
    manifest,
  });
}

export function resolveExpectedCommercialOcrNativeBehaviorIdentity(
  configService?: CommercialOcrPreprocessConfigReader,
  buildManifestPath = resolveCommercialOcrNativeBuildManifestPath(),
): Readonly<{
  buildManifest: CommercialOcrNativeBuildManifestReadResult;
  identity: CommercialOcrNativeBehaviorIdentity;
}> {
  const buildManifest = readCommercialOcrNativeBuildManifest(buildManifestPath);
  return Object.freeze({
    buildManifest,
    identity: createCommercialOcrNativeBehaviorIdentity({
      controls: resolveCommercialOcrNativeRuntimeControls(configService),
      ...(buildManifest.manifest ? { artifacts: buildManifest.manifest.artifacts } : {}),
      buildManifestSha256: buildManifest.sha256,
    }),
  });
}

export function resolveExpectedCommercialOcrProductionBehaviorIdentity(
  configService?: CommercialOcrPreprocessConfigReader,
  buildManifestPath = resolveCommercialOcrNativeBuildManifestPath(),
): ReturnType<typeof resolveExpectedCommercialOcrNativeBehaviorIdentity> {
  return resolveExpectedCommercialOcrNativeBehaviorIdentity(
    resolveCommercialOcrProductionNativeConfigReader(configService),
    buildManifestPath,
  );
}

export async function resolveVerifiedCommercialOcrNativeBehaviorIdentity(
  configService?: CommercialOcrPreprocessConfigReader,
  options: {
    buildManifestPath?: string;
    dependencies?: Partial<CommercialOcrNativeProbeDependencies>;
    trustedBinarySha256?: string;
  } = {},
): Promise<CommercialOcrNativeArtifactVerification> {
  const buildManifest = readCommercialOcrNativeBuildManifest(
    options.buildManifestPath ?? resolveCommercialOcrNativeBuildManifestPath(),
  );
  const controls = resolveCommercialOcrNativeRuntimeControls(configService);
  if (!buildManifest.manifest) {
    return Object.freeze({
      verified: false,
      status:
        buildManifest.status === 'missing' ? 'build_manifest_missing' : 'build_manifest_invalid',
      mismatches: Object.freeze(['buildManifest']),
      identity: createCommercialOcrNativeBehaviorIdentity({ controls }),
    });
  }
  const trustedBinarySha256 = options.trustedBinarySha256
    ? normalizeOptionalSha256(options.trustedBinarySha256)
    : null;
  if (
    trustedBinarySha256 &&
    trustedBinarySha256 !== buildManifest.manifest.artifacts.tesseract.binarySha256
  ) {
    return Object.freeze({
      verified: false,
      status: 'mismatch',
      mismatches: Object.freeze(['tesseract.binarySha256']),
      identity: createCommercialOcrNativeBehaviorIdentity({
        controls,
        artifacts: buildManifest.manifest.artifacts,
        buildManifestSha256: buildManifest.sha256,
      }),
    });
  }
  let artifacts: CommercialOcrNativeArtifactSnapshot;
  try {
    artifacts = await probeCommercialOcrNativeArtifacts(
      resolveCommercialOcrNativeEngineConfig(configService),
      options.dependencies,
      {
        expectedBinarySha256:
          trustedBinarySha256 ?? buildManifest.manifest.artifacts.tesseract.binarySha256,
      },
    );
  } catch (error) {
    const mismatches =
      error instanceof CommercialOcrNativeArtifactMismatchError
        ? error.mismatches
        : Object.freeze(['artifacts.unavailable']);
    return Object.freeze({
      verified: false,
      status:
        error instanceof CommercialOcrNativeArtifactMismatchError ? 'mismatch' : 'probe_failed',
      mismatches,
      identity: createCommercialOcrNativeBehaviorIdentity({
        controls,
        artifacts: buildManifest.manifest.artifacts,
        buildManifestSha256: buildManifest.sha256,
      }),
    });
  }

  const identity = createCommercialOcrNativeBehaviorIdentity({
    controls,
    artifacts,
    buildManifestSha256: buildManifest.sha256,
  });
  const mismatches = diffNativeArtifacts(buildManifest.manifest.artifacts, artifacts);
  return Object.freeze({
    verified: mismatches.length === 0 && identity.complete,
    status: mismatches.length === 0 && identity.complete ? 'verified' : 'mismatch',
    mismatches: Object.freeze(mismatches),
    identity,
  });
}

export async function probeCommercialOcrNativeArtifacts(
  engine: CommercialOcrNativeEngineConfig,
  dependencyOverrides: Partial<CommercialOcrNativeProbeDependencies> = {},
  expectations: Readonly<{ expectedBinarySha256?: string }> = {},
): Promise<CommercialOcrNativeArtifactSnapshot> {
  const dependencies = resolveNativeProbeDependencies(dependencyOverrides);
  const binaryPath = await resolveExecutablePath(engine.binary, dependencies);
  const binaryBytesBefore = await dependencies.readFile(binaryPath);
  const binarySha256 = sha256(binaryBytesBefore);
  if (
    expectations.expectedBinarySha256 &&
    binarySha256 !== normalizeOptionalSha256(expectations.expectedBinarySha256)
  ) {
    throw new CommercialOcrNativeArtifactMismatchError(['tesseract.binarySha256']);
  }
  const commandOptions: NativeProbeCommandOptions = {
    encoding: 'utf8',
    env: nativeProbeEnvironment(engine, dependencies),
    maxBuffer: NATIVE_PROBE_MAX_OUTPUT_BYTES,
    timeout: NATIVE_PROBE_TIMEOUT_MS,
    killSignal: 'SIGKILL',
  };
  const [versionResult, languageResult] = await Promise.all([
    dependencies.execFile(binaryPath, ['--version'], commandOptions),
    dependencies.execFile(binaryPath, ['--list-langs'], commandOptions),
  ]);
  const binaryBytesAfter = await dependencies.readFile(binaryPath);
  if (sha256(binaryBytesAfter) !== binarySha256) {
    throw new CommercialOcrNativeArtifactMismatchError(['tesseract.binarySha256']);
  }
  const versionOutput = [versionResult.stdout, versionResult.stderr].filter(Boolean).join('\n');
  const version = versionOutput
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => /^tesseract\s+\d/iu.test(line));
  if (!version) {
    throw new Error('Tesseract version is unavailable');
  }
  const languageOutput = [languageResult.stdout, languageResult.stderr].filter(Boolean).join('\n');
  const languageLines = languageOutput.split(/\r?\n/u).map((line) => line.trim());
  const availableLanguages = [...new Set(languageLines.filter(isLanguageName))].sort((left, right) =>
    left.localeCompare(right),
  );
  const reportedDirectory =
    languageLines
      .map((line) => line.match(/"([^"]+)"/u)?.[1] ?? null)
      .find((value): value is string => value !== null) ?? null;
  const directories = uniqueStrings([
    engine.tessdataPrefix,
    engine.tessdataPrefix ? join(engine.tessdataPrefix, 'tessdata') : null,
    reportedDirectory,
    '/usr/share/tessdata',
    '/usr/share/tesseract-ocr/5/tessdata',
    '/usr/share/tesseract-ocr/4.00/tessdata',
  ]);
  const [rus, eng] = await Promise.all([
    digestFirstReadableFile(directories, 'rus.traineddata', dependencies),
    digestFirstReadableFile(directories, 'eng.traineddata', dependencies),
  ]);
  return normalizeNativeArtifacts({
    runtime: {
      nodeVersion: dependencies.runtime.nodeVersion,
      platform: dependencies.runtime.platform,
      architecture: dependencies.runtime.architecture,
      sharpVersion: requireRuntimeVersion(dependencies.sharpVersions.sharp, 'Sharp'),
      libvipsVersion: requireRuntimeVersion(dependencies.sharpVersions.vips, 'libvips'),
    },
    tesseract: {
      version,
      binarySha256,
      availableLanguages,
      traineddataSha256: { rus, eng },
    },
  });
}

export function fingerprintCommercialOcrNativeBehaviorManifest(
  manifest: CommercialOcrNativeBehaviorManifest,
): string {
  return createHash('sha256').update(canonicalJson(manifest)).digest('hex');
}

export function isCommercialOcrNativeBehaviorManifestComplete(
  manifest: CommercialOcrNativeBehaviorManifest,
): boolean {
  const artifacts = manifest.artifacts;
  return (
    typeof manifest.buildManifestSha256 === 'string' &&
    SHA256_PATTERN.test(manifest.buildManifestSha256) &&
    typeof artifacts.runtime.sharpVersion === 'string' &&
    typeof artifacts.runtime.libvipsVersion === 'string' &&
    typeof artifacts.tesseract.version === 'string' &&
    typeof artifacts.tesseract.binarySha256 === 'string' &&
    Array.isArray(artifacts.tesseract.availableLanguages) &&
    COMMERCIAL_OCR_NATIVE_REQUIRED_LANGUAGES.every((language) =>
      artifacts.tesseract.availableLanguages!.includes(language),
    ) &&
    typeof artifacts.tesseract.traineddataSha256.rus === 'string' &&
    typeof artifacts.tesseract.traineddataSha256.eng === 'string'
  );
}

const unavailableNativeIdentity = createCommercialOcrNativeBehaviorIdentity({
  controls: resolveCommercialOcrNativeRuntimeControls(),
});

export const COMMERCIAL_OCR_BEHAVIOR_DESCRIPTOR: CommercialOcrBehaviorDescriptor = Object.freeze({
  schemaVersion: 2,
  ocrVersion: COMMERCIAL_OCR_DEFAULT_VERSION,
  preprocessProfiles: COMMERCIAL_OCR_PREPROCESS_PROFILES,
  preprocessLimits: COMMERCIAL_OCR_DEFAULT_PREPROCESS_LIMITS,
  decisionPolicy: Object.freeze({
    version: COMMERCIAL_OCR_DECISION_POLICY_VERSION,
    deleteGate: COMMERCIAL_OCR_DELETE_GATE,
  }),
  detector: Object.freeze({
    sourceIdentity: COMMERCIAL_OCR_DETECTOR_SOURCE_IDENTITY,
    engineConfig: COMMERCIAL_ENGINE_CONFIG,
  }),
  native: unavailableNativeIdentity.manifest,
});

export function resolveCommercialOcrBehaviorDescriptor(
  configService?: CommercialOcrPreprocessConfigReader,
  nativeIdentity = resolveExpectedCommercialOcrNativeBehaviorIdentity(configService).identity,
): CommercialOcrBehaviorDescriptor {
  return Object.freeze({
    ...COMMERCIAL_OCR_BEHAVIOR_DESCRIPTOR,
    preprocessLimits: resolveCommercialOcrPreprocessLimits(configService),
    native: nativeIdentity.manifest,
  });
}

export function resolveCommercialOcrProductionBehaviorDescriptor(
  configService?: CommercialOcrPreprocessConfigReader,
  nativeIdentity = resolveExpectedCommercialOcrProductionBehaviorIdentity(configService).identity,
): CommercialOcrBehaviorDescriptor {
  const productionConfig = resolveCommercialOcrProductionNativeConfigReader(configService);
  return resolveCommercialOcrBehaviorDescriptor(productionConfig, nativeIdentity);
}

export function resolveCommercialOcrBehaviorIdentity(
  descriptor: CommercialOcrBehaviorDescriptor = COMMERCIAL_OCR_BEHAVIOR_DESCRIPTOR,
): CommercialOcrBehaviorIdentity {
  const fingerprintSha256 = createHash('sha256').update(canonicalJson(descriptor)).digest('hex');
  const fingerprint = fingerprintSha256.slice(0, 24);
  return {
    scope: `${descriptor.ocrVersion}:${fingerprint}`,
    fingerprint,
    fingerprintSha256,
    descriptor,
  };
}

export function canonicalCommercialOcrBehaviorJson(value: unknown): string {
  return canonicalJson(value);
}

function normalizeNativeArtifacts(
  artifacts: CommercialOcrNativeArtifactSnapshot,
): CommercialOcrNativeArtifactSnapshot {
  return deepFreeze(
    commercialOcrNativeArtifactSnapshotSchema.parse({
      ...artifacts,
      tesseract: {
        ...artifacts.tesseract,
        availableLanguages: [...new Set(artifacts.tesseract.availableLanguages)].sort((left, right) =>
          left.localeCompare(right),
        ),
      },
    }),
  ) as CommercialOcrNativeArtifactSnapshot;
}

function unavailableNativeArtifacts(): PartialCommercialOcrNativeArtifactSnapshot {
  return deepFreeze({
    runtime: {
      nodeVersion: process.version,
      platform: process.platform,
      architecture: process.arch,
      sharpVersion: null,
      libvipsVersion: null,
    },
    tesseract: {
      version: null,
      binarySha256: null,
      availableLanguages: null,
      traineddataSha256: { rus: null, eng: null },
    },
  });
}

function resolveNativeProbeDependencies(
  overrides: Partial<CommercialOcrNativeProbeDependencies>,
): CommercialOcrNativeProbeDependencies {
  return {
    execFile:
      overrides.execFile ??
      (async (binary, args, options) => {
        const result = await execFileAsync(binary, [...args], options);
        return { stdout: result.stdout, stderr: result.stderr };
      }),
    readFile: overrides.readFile ?? (async (pathname) => readFile(pathname)),
    realpath: overrides.realpath ?? realpath,
    access: overrides.access ?? access,
    runtime: overrides.runtime ?? {
      nodeVersion: process.version,
      platform: process.platform,
      architecture: process.arch,
    },
    sharpVersions: overrides.sharpVersions ?? loadSharpVersions(),
    environment: overrides.environment ?? process.env,
    path: overrides.path ?? process.env.PATH,
    cwd: overrides.cwd ?? process.cwd(),
  };
}

function loadSharpVersions(): Readonly<{ sharp: string | undefined; vips: string | undefined }> {
  // Loaded only by the build/eval or sandbox artifact probe, never by the networked OCR client.
  const runtimeSharp = createRequire(__filename)('sharp') as typeof import('sharp').default;
  return runtimeSharp.versions;
}

function nativeProbeEnvironment(
  engine: CommercialOcrNativeEngineConfig,
  dependencies: CommercialOcrNativeProbeDependencies,
): NodeJS.ProcessEnv {
  return {
    PATH: dependencies.path,
    LANG: dependencies.environment.LANG ?? 'C.UTF-8',
    LC_ALL: dependencies.environment.LC_ALL,
    LD_LIBRARY_PATH: dependencies.environment.LD_LIBRARY_PATH,
    OMP_THREAD_LIMIT: String(engine.ompThreadLimit),
    ...(engine.tessdataPrefix ? { TESSDATA_PREFIX: engine.tessdataPrefix } : {}),
  };
}

class CommercialOcrNativeArtifactMismatchError extends Error {
  readonly mismatches: readonly string[];

  constructor(mismatches: readonly string[]) {
    super('Commercial OCR native artifacts do not match the image build manifest');
    this.mismatches = Object.freeze([...mismatches]);
  }
}

async function resolveExecutablePath(
  command: string,
  dependencies: CommercialOcrNativeProbeDependencies,
): Promise<string> {
  const candidates =
    isAbsolute(command) || command.includes('/') || command.includes('\\')
      ? [isAbsolute(command) ? command : resolve(dependencies.cwd, command)]
      : (dependencies.path ?? '')
          .split(delimiter)
          .filter(Boolean)
          .map((directory) => resolve(directory, command));
  for (const candidate of candidates) {
    try {
      await dependencies.access(candidate, fsConstants.X_OK);
      return await dependencies.realpath(candidate);
    } catch {
      // Continue through the bounded PATH candidate list.
    }
  }
  throw new Error('Tesseract executable is unavailable');
}

async function digestFirstReadableFile(
  directories: readonly string[],
  filename: string,
  dependencies: CommercialOcrNativeProbeDependencies,
): Promise<string> {
  for (const directory of directories) {
    try {
      return sha256(await dependencies.readFile(resolve(directory, filename)));
    } catch {
      // Continue through known Tesseract data layouts.
    }
  }
  throw new Error(`${filename} is unavailable`);
}

function diffNativeArtifacts(
  expected: CommercialOcrNativeArtifactSnapshot,
  actual: CommercialOcrNativeArtifactSnapshot,
): string[] {
  const paths = [
    'runtime.nodeVersion',
    'runtime.platform',
    'runtime.architecture',
    'runtime.sharpVersion',
    'runtime.libvipsVersion',
    'tesseract.version',
    'tesseract.binarySha256',
    'tesseract.availableLanguages',
    'tesseract.traineddataSha256.rus',
    'tesseract.traineddataSha256.eng',
  ] as const;
  return paths.filter(
    (path) => canonicalJson(valueAtPath(expected, path)) !== canonicalJson(valueAtPath(actual, path)),
  );
}

function valueAtPath(value: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((current, key) => {
    if (!current || typeof current !== 'object') return undefined;
    return (current as Record<string, unknown>)[key];
  }, value);
}

function requireExpectedBuildIdentity(value: unknown): void {
  if (canonicalJson(value) !== canonicalJson(COMMERCIAL_OCR_BUILD_IDENTITY)) {
    throw new Error('Commercial OCR native build identity does not match generated sources');
  }
}

function requireRuntimeVersion(value: string | undefined, label: string): string {
  if (!value || !VERSION_PATTERN.test(value)) {
    throw new Error(`${label} runtime version is unavailable`);
  }
  return value;
}

function normalizeOptionalSha256(value: string | null): string | null {
  if (value === null) return null;
  const normalized = value.trim().toLowerCase();
  if (!SHA256_PATTERN.test(normalized)) {
    throw new Error('Commercial OCR native build manifest SHA-256 is invalid');
  }
  return normalized;
}

function readBoundedPositiveInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

function readCommand(value: unknown, fallback: string): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized && normalized.length <= 512 && !normalized.includes('\0')
    ? normalized
    : fallback;
}

function readOptionalPath(value: unknown): string | null {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized && normalized.length <= 1_024 && !normalized.includes('\0')
    ? normalized
    : null;
}

function uniqueStrings(values: readonly (string | null)[]): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function isLanguageName(value: string): boolean {
  return /^[A-Za-z0-9_-]+$/u.test(value);
}

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('Commercial OCR behavior descriptor contains a non-finite number');
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  throw new Error('Commercial OCR behavior descriptor contains an unsupported value');
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value as Record<string, unknown>)) {
    deepFreeze(nested);
  }
  return Object.freeze(value);
}
