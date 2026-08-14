import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { availableParallelism, cpus, totalmem } from 'node:os';
import { relative, resolve } from 'node:path';
import { promisify } from 'node:util';

import { COMMERCIAL_ENGINE_CONFIG } from '../moderation/commercial/commercial-config';
import {
  canonicalCommercialOcrBehaviorJson,
  resolveCommercialOcrBehaviorIdentity,
  resolveCommercialOcrProductionBehaviorDescriptor,
  resolveVerifiedCommercialOcrNativeBehaviorIdentity,
  type CommercialOcrBehaviorIdentity,
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
import {
  COMMERCIAL_OCR_PREPROCESS_PROFILES,
  type CommercialOcrPreprocessConfigReader,
} from '../moderation/commercial-ocr/commercial-ocr-preprocessor';
import { COMMERCIAL_OCR_DEFAULT_VERSION } from '../moderation/commercial-ocr/commercial-ocr.queue';
import { SUPPORTED_PHOTO_IMAGE_FORMATS } from '../moderation/photo-duplicate/photo-image-format';
import { COMMERCIAL_SECOND_STAGE_VERSION } from '../moderation/rule-engine-commercial-second-stage-cache';

const execFileAsync = promisify(execFile);

export const COMMERCIAL_RUN_PROVENANCE_PROBE_TIMEOUT_MS = 5_000;
export const COMMERCIAL_OCR_BENCHMARK_ENVIRONMENT_PROFILE_ID =
  'commercial-ocr-production-equivalent-v1' as const;
const DETECTOR_SUPPORT_FILES = [
  'apps/api/src/common/url-text.util.ts',
  'apps/api/src/moderation/commercial-campaign.util.ts',
  'apps/api/src/moderation/rule-engine-commercial-second-stage-cache.ts',
  'apps/api/src/moderation/rule-engine-commercial-thresholds.ts',
  'apps/api/src/moderation/rule-engine-detection-context.ts',
  'apps/api/src/moderation/rule-engine-normalization.ts',
] as const;

export type CommercialRunProvenance = {
  startedAt: string;
  git: {
    commit: string | null;
    dirty: boolean | null;
  };
  detector: {
    digestKind: 'SOURCE_FILES' | 'VERSION_DESCRIPTOR';
    sourceSha256: string;
    decisionVersion: string;
    patternPolicyVersion: string;
    classifierVersion: string;
  };
  auditTool: {
    digestKind: 'SOURCE_FILES' | 'VERSION_DESCRIPTOR';
    sourceSha256: string;
  };
  runtime: {
    nodeVersion: string;
  };
};

type DetectorDigest = Pick<CommercialRunProvenance['detector'], 'digestKind' | 'sourceSha256'>;
type AuditToolDigest = CommercialRunProvenance['auditTool'];

type SourceDigest = {
  digestKind: 'SOURCE_FILES' | 'VERSION_DESCRIPTOR';
  sourceSha256: string;
};

export type CommercialOcrEvalExecutionConfig = {
  tesseractBinary: string;
  tessdataPrefix: string | null;
  timeoutMs: number;
  maxSourceImageBytes: number;
  maxImageBytes: number;
  maxOutputBytes: number;
  maxInputPixels: number;
  maxOutputPixels: number;
  maxSide: number;
  ompThreadLimit: number;
  nativeConcurrency: number;
  nativeMaxQueue: number;
  nativeRecycleAfterJobs: number;
  sharpConcurrency: number;
  sharpProcessingTimeoutSeconds: number;
  evalConcurrency: number;
};

export type CommercialOcrEvalRunProvenance = {
  run: CommercialRunProvenance;
  artifact: {
    manifestSha256: string;
    immutableImageSha256: string | null;
    sourceSha: string | null;
  };
  fingerprints: {
    ocr: SourceDigest & { version: typeof COMMERCIAL_OCR_DEFAULT_VERSION };
    policy: SourceDigest & { version: typeof COMMERCIAL_OCR_DECISION_POLICY_VERSION };
    preprocess: SourceDigest & {
      profiles: typeof COMMERCIAL_OCR_PREPROCESS_PROFILES;
    };
    detector: CommercialRunProvenance['detector'];
  };
  behaviorIdentity: Readonly<{
    fingerprintSha256: string;
    nativeFingerprintSha256: string;
    nativeVerification: Readonly<{
      verified: boolean;
      status: CommercialOcrNativeArtifactVerification['status'];
      mismatches: readonly string[];
    }>;
    descriptor: CommercialOcrBehaviorIdentity['descriptor'];
  }>;
  benchmarkEnvironment: Readonly<{
    profileId: typeof COMMERCIAL_OCR_BENCHMARK_ENVIRONMENT_PROFILE_ID;
    descriptorSha256: string;
    reviewedDescriptorSha256: string | null;
    descriptor: Readonly<{
      platform: string;
      architecture: string;
      nodeVersion: string;
      cpuModelSha256: string;
      logicalCpuCount: number;
      availableParallelism: number;
      totalMemoryBytes: number;
      constrainedMemoryBytes: number | null;
      nativeBuildManifestSha256: string | null;
      nativeBehaviorFingerprintSha256: string;
    }>;
  }>;
  runtime: {
    nodeVersion: string;
    sharpVersion: string | null;
    libvipsVersion: string | null;
    tesseractVersion: string | null;
  };
  sourceImages: {
    allowedFormats: typeof SUPPORTED_PHOTO_IMAGE_FORMATS;
  };
  tesseract: {
    binary: string;
    tessdataPrefix: string | null;
    languages: readonly ['rus', 'eng'];
    availableLanguages: string[] | null;
    binarySha256: string | null;
    traineddataSha256: { rus: string | null; eng: string | null };
    oem: 1;
    psm: { primary: 11; confirmation: 6 };
    resourceLimits: Omit<CommercialOcrEvalExecutionConfig, 'tesseractBinary' | 'tessdataPrefix'>;
  };
};

export const COMMERCIAL_OCR_RUNTIME_SOURCE_FILES = [
  'apps/api/src/moderation/commercial-ocr/commercial-ocr-analysis.service.ts',
  'apps/api/src/moderation/commercial-ocr/commercial-ocr-album-scheduler.ts',
  'apps/api/src/moderation/commercial-ocr/commercial-ocr-cache.store.ts',
  'apps/api/src/moderation/commercial-ocr/commercial-ocr-decision-policy.ts',
  'apps/api/src/moderation/commercial-ocr/commercial-ocr-evidence.ts',
  'apps/api/src/moderation/commercial-ocr/commercial-ocr-letter-script.ts',
  'apps/api/src/moderation/commercial-ocr/commercial-ocr-native-result.converter.ts',
  'apps/api/src/moderation/commercial-ocr/commercial-ocr-preprocessor.ts',
  'apps/api/src/moderation/commercial-ocr/commercial-ocr.queue.ts',
  'apps/api/src/moderation/commercial-ocr/native-tesseract-ocr.adapter.ts',
  'apps/api/src/moderation/commercial-ocr/native-tesseract-ocr.types.ts',
  'apps/api/src/moderation/commercial-ocr/native-tesseract-runner.ts',
  'apps/api/src/moderation/commercial-ocr/native-tesseract-tsv.ts',
  'apps/api/src/moderation/commercial-ocr/native-tesseract-worker-validation.ts',
  'apps/api/src/moderation/commercial-ocr/native-tesseract-worker.protocol.ts',
  'apps/api/src/moderation/commercial-ocr/native-tesseract-worker.ts',
  'apps/api/src/moderation/photo-duplicate/photo-image-format.ts',
  'apps/api/src/moderation/photo-duplicate/secure-photo-downloader.ts',
] as const;

async function gitOutput(cwd: string, args: readonly string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', [...args], {
      cwd,
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
      timeout: COMMERCIAL_RUN_PROVENANCE_PROBE_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    });
    return stdout.trim();
  } catch {
    return null;
  }
}

async function resolveGitRoot(cwd: string): Promise<string | null> {
  const root = await gitOutput(cwd, ['rev-parse', '--show-toplevel']);
  return root ? resolve(root) : null;
}

function versionDescriptorDigest(scope: 'DETECTOR' | 'AUDIT_TOOL'): DetectorDigest {
  const descriptor = JSON.stringify({
    scope,
    decisionVersion: COMMERCIAL_ENGINE_CONFIG.decisionVersion,
    patternPolicyVersion: COMMERCIAL_ENGINE_CONFIG.patternPolicyVersion,
    classifierVersion: COMMERCIAL_SECOND_STAGE_VERSION,
  });
  return {
    digestKind: 'VERSION_DESCRIPTOR',
    sourceSha256: createHash('sha256').update(descriptor).digest('hex'),
  };
}

export async function calculateCommercialDetectorSourceDigest(
  repositoryRoot: string,
): Promise<DetectorDigest> {
  const root = resolve(repositoryRoot);
  try {
    const commercialDirectory = resolve(root, 'apps/api/src/moderation/commercial');
    const commercialFiles = (await readdir(commercialDirectory))
      .filter((name) => name.endsWith('.ts') && !name.endsWith('.spec.ts'))
      .map((name) => resolve(commercialDirectory, name));
    const files = [
      ...commercialFiles,
      ...DETECTOR_SUPPORT_FILES.map((pathname) => resolve(root, pathname)),
    ].sort((left, right) => left.localeCompare(right));
    const hash = createHash('sha256');
    for (const pathname of files) {
      hash.update(relative(root, pathname));
      hash.update('\0');
      hash.update(await readFile(pathname));
      hash.update('\0');
    }
    return {
      digestKind: 'SOURCE_FILES',
      sourceSha256: hash.digest('hex'),
    };
  } catch {
    return versionDescriptorDigest('DETECTOR');
  }
}

export async function calculateCommercialAuditToolSourceDigest(
  repositoryRoot: string,
): Promise<AuditToolDigest> {
  const root = resolve(repositoryRoot);
  try {
    const scriptsDirectory = resolve(root, 'apps/api/src/scripts');
    const evalDirectory = resolve(root, 'apps/api/src/moderation/commercial-ocr/eval');
    const scriptFiles = (await readdir(scriptsDirectory))
      .filter(
        (name) =>
          name.endsWith('.ts') &&
          !name.endsWith('.spec.ts') &&
          (name.startsWith('commercial-') ||
            name === 'run-commercial-ocr-eval.ts' ||
            /^(?:audit|build|evaluate|remap|replay|validate)-commercial-/u.test(name)),
      )
      .map((name) => resolve(scriptsDirectory, name));
    const evalFiles = await listNonSpecTypeScriptSources(evalDirectory);
    const files = [...scriptFiles, ...evalFiles].sort((left, right) => left.localeCompare(right));
    if (files.length === 0) {
      throw new Error('Commercial audit tool sources were not found');
    }
    const hash = createHash('sha256');
    for (const pathname of files) {
      hash.update(relative(root, pathname));
      hash.update('\0');
      hash.update(await readFile(pathname));
      hash.update('\0');
    }
    return {
      digestKind: 'SOURCE_FILES',
      sourceSha256: hash.digest('hex'),
    };
  } catch {
    return versionDescriptorDigest('AUDIT_TOOL');
  }
}

async function listNonSpecTypeScriptSources(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry): Promise<string[]> => {
      const pathname = resolve(directory, entry.name);
      if (entry.isDirectory()) return listNonSpecTypeScriptSources(pathname);
      return entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')
        ? [pathname]
        : [];
    }),
  );
  return nested.flat();
}

export async function resolveCommercialRunProvenance(
  options: {
    startedAt?: string;
    repositoryRoot?: string;
  } = {},
): Promise<CommercialRunProvenance> {
  const startedAt = options.startedAt ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(startedAt))) {
    throw new Error(`Invalid commercial run startedAt: ${startedAt}`);
  }
  const repositoryRoot = options.repositoryRoot
    ? resolve(options.repositoryRoot)
    : await resolveGitRoot(process.cwd());
  const commit = repositoryRoot ? await gitOutput(repositoryRoot, ['rev-parse', 'HEAD']) : null;
  const status = repositoryRoot
    ? await gitOutput(repositoryRoot, ['status', '--porcelain=v1', '--untracked-files=all'])
    : null;
  const detectorDigest = {
    digestKind: 'SOURCE_FILES' as const,
    sourceSha256: COMMERCIAL_OCR_DETECTOR_SOURCE_SHA256,
  };
  const auditToolDigest = {
    digestKind: 'SOURCE_FILES' as const,
    sourceSha256: COMMERCIAL_OCR_AUDIT_TOOL_SOURCE_SHA256,
  };

  return {
    startedAt: new Date(startedAt).toISOString(),
    git: {
      commit,
      dirty: status === null ? null : status.length > 0,
    },
    detector: {
      ...detectorDigest,
      decisionVersion: COMMERCIAL_ENGINE_CONFIG.decisionVersion,
      patternPolicyVersion: COMMERCIAL_ENGINE_CONFIG.patternPolicyVersion,
      classifierVersion: COMMERCIAL_SECOND_STAGE_VERSION,
    },
    auditTool: auditToolDigest,
    runtime: {
      nodeVersion: process.version,
    },
  };
}

export async function resolveCommercialOcrEvalRunProvenance(options: {
  manifestPath: string;
  manifestSha256?: string;
  execution: CommercialOcrEvalExecutionConfig;
  startedAt?: string;
  repositoryRoot?: string;
  immutableImageSha256?: string;
  sourceSha?: string;
  nativeBuildManifestPath?: string;
  expectedBenchmarkEnvironmentSha256?: string;
}): Promise<CommercialOcrEvalRunProvenance> {
  const manifestSha256 =
    normalizeOptionalDigest(options.manifestSha256, 64, 'manifest SHA-256') ??
    (await sha256File(resolve(options.manifestPath)));
  const run = await resolveCommercialRunProvenance({
    ...(options.startedAt ? { startedAt: options.startedAt } : {}),
    ...(options.repositoryRoot ? { repositoryRoot: options.repositoryRoot } : {}),
  });
  const nativeConfig = commercialOcrExecutionConfigReader(options.execution);
  const nativeVerification = await resolveVerifiedCommercialOcrNativeBehaviorIdentity(
    nativeConfig,
    options.nativeBuildManifestPath
      ? { buildManifestPath: options.nativeBuildManifestPath }
      : undefined,
  );
  const behaviorIdentity = resolveCommercialOcrBehaviorIdentity(
    resolveCommercialOcrProductionBehaviorDescriptor(nativeConfig, nativeVerification.identity),
  );
  const ocrDigest = {
    digestKind: 'SOURCE_FILES' as const,
    sourceSha256: COMMERCIAL_OCR_RUNTIME_SOURCE_SHA256,
  };
  const policyDigest = {
    digestKind: 'SOURCE_FILES' as const,
    sourceSha256: COMMERCIAL_OCR_POLICY_SOURCE_SHA256,
  };
  const preprocessDigest = {
    digestKind: 'SOURCE_FILES' as const,
    sourceSha256: COMMERCIAL_OCR_PREPROCESS_SOURCE_SHA256,
  };
  const nativeArtifacts = nativeVerification.identity.manifest.artifacts;
  const benchmarkEnvironment = resolveCommercialOcrBenchmarkEnvironment(
    nativeVerification,
    options.expectedBenchmarkEnvironmentSha256,
  );

  return {
    run,
    artifact: {
      manifestSha256,
      immutableImageSha256: normalizeOptionalDigest(
        options.immutableImageSha256,
        64,
        'immutable image SHA-256',
      ),
      sourceSha: normalizeOptionalSourceSha(options.sourceSha),
    },
    fingerprints: {
      ocr: { ...ocrDigest, version: COMMERCIAL_OCR_DEFAULT_VERSION },
      policy: { ...policyDigest, version: COMMERCIAL_OCR_DECISION_POLICY_VERSION },
      preprocess: { ...preprocessDigest, profiles: COMMERCIAL_OCR_PREPROCESS_PROFILES },
      detector: run.detector,
    },
    behaviorIdentity: {
      fingerprintSha256: behaviorIdentity.fingerprintSha256,
      nativeFingerprintSha256: nativeVerification.identity.fingerprintSha256,
      nativeVerification: {
        verified: nativeVerification.verified,
        status: nativeVerification.status,
        mismatches: nativeVerification.mismatches,
      },
      descriptor: behaviorIdentity.descriptor,
    },
    benchmarkEnvironment,
    runtime: {
      nodeVersion: nativeArtifacts.runtime.nodeVersion,
      sharpVersion: nativeArtifacts.runtime.sharpVersion,
      libvipsVersion: nativeArtifacts.runtime.libvipsVersion,
      tesseractVersion: nativeArtifacts.tesseract.version,
    },
    sourceImages: {
      allowedFormats: SUPPORTED_PHOTO_IMAGE_FORMATS,
    },
    tesseract: {
      binary: options.execution.tesseractBinary,
      tessdataPrefix: options.execution.tessdataPrefix,
      languages: ['rus', 'eng'],
      availableLanguages: nativeArtifacts.tesseract.availableLanguages
        ? [...nativeArtifacts.tesseract.availableLanguages]
        : null,
      binarySha256: nativeArtifacts.tesseract.binarySha256,
      traineddataSha256: nativeArtifacts.tesseract.traineddataSha256,
      oem: 1,
      psm: { primary: 11, confirmation: 6 },
      resourceLimits: {
        timeoutMs: options.execution.timeoutMs,
        maxSourceImageBytes: options.execution.maxSourceImageBytes,
        maxImageBytes: options.execution.maxImageBytes,
        maxOutputBytes: options.execution.maxOutputBytes,
        maxInputPixels: options.execution.maxInputPixels,
        maxOutputPixels: options.execution.maxOutputPixels,
        maxSide: options.execution.maxSide,
        ompThreadLimit: options.execution.ompThreadLimit,
        nativeConcurrency: options.execution.nativeConcurrency,
        nativeMaxQueue: options.execution.nativeMaxQueue,
        nativeRecycleAfterJobs: options.execution.nativeRecycleAfterJobs,
        sharpConcurrency: options.execution.sharpConcurrency,
        sharpProcessingTimeoutSeconds: options.execution.sharpProcessingTimeoutSeconds,
        evalConcurrency: options.execution.evalConcurrency,
      },
    },
  };
}

function resolveCommercialOcrBenchmarkEnvironment(
  nativeVerification: CommercialOcrNativeArtifactVerification,
  expectedDescriptorSha256: string | undefined,
): CommercialOcrEvalRunProvenance['benchmarkEnvironment'] {
  const cpuInventory = cpus();
  const cpuModels = [...new Set(cpuInventory.map((cpu) => cpu.model.trim()).filter(Boolean))].sort(
    (left, right) => left.localeCompare(right),
  );
  const constrainedMemory = process.constrainedMemory();
  const descriptor = Object.freeze({
    platform: process.platform,
    architecture: process.arch,
    nodeVersion: process.version,
    cpuModelSha256: createHash('sha256').update(cpuModels.join('\0')).digest('hex'),
    logicalCpuCount: cpuInventory.length,
    availableParallelism: availableParallelism(),
    totalMemoryBytes: totalmem(),
    constrainedMemoryBytes:
      typeof constrainedMemory === 'number' &&
      Number.isSafeInteger(constrainedMemory) &&
      constrainedMemory > 0
        ? constrainedMemory
        : null,
    nativeBuildManifestSha256: nativeVerification.identity.manifest.buildManifestSha256,
    nativeBehaviorFingerprintSha256: nativeVerification.identity.fingerprintSha256,
  });
  const descriptorSha256 = createHash('sha256')
    .update(canonicalCommercialOcrBehaviorJson(descriptor))
    .digest('hex');
  const reviewedDescriptorSha256 = normalizeOptionalDigest(
    expectedDescriptorSha256,
    64,
    'benchmark environment SHA-256',
  );
  if (reviewedDescriptorSha256 && reviewedDescriptorSha256 !== descriptorSha256) {
    throw new Error('Commercial OCR benchmark environment does not match the reviewed descriptor');
  }
  return Object.freeze({
    profileId: COMMERCIAL_OCR_BENCHMARK_ENVIRONMENT_PROFILE_ID,
    descriptorSha256,
    reviewedDescriptorSha256,
    descriptor,
  });
}

export async function calculateCommercialOcrSourceDigest(
  repositoryRoot: string | null,
): Promise<SourceDigest> {
  return calculateSourceDigest(repositoryRoot, COMMERCIAL_OCR_RUNTIME_SOURCE_FILES, {
    scope: 'COMMERCIAL_OCR',
    version: COMMERCIAL_OCR_DEFAULT_VERSION,
  });
}

async function calculateSourceDigest(
  repositoryRoot: string | null,
  files: readonly string[],
  descriptor: Readonly<Record<string, unknown>>,
): Promise<SourceDigest> {
  if (repositoryRoot) {
    try {
      const hash = createHash('sha256');
      for (const relativePath of [...files].sort((left, right) => left.localeCompare(right))) {
        hash.update(relativePath);
        hash.update('\0');
        hash.update(await readFile(resolve(repositoryRoot, relativePath)));
        hash.update('\0');
      }
      return { digestKind: 'SOURCE_FILES', sourceSha256: hash.digest('hex') };
    } catch {
      // A built image has no TypeScript sources; the immutable descriptor remains auditable.
    }
  }
  return {
    digestKind: 'VERSION_DESCRIPTOR',
    sourceSha256: createHash('sha256').update(JSON.stringify(descriptor)).digest('hex'),
  };
}

function commercialOcrExecutionConfigReader(
  execution: CommercialOcrEvalExecutionConfig,
): CommercialOcrPreprocessConfigReader {
  const values: Readonly<Record<string, unknown>> = {
    COMMERCIAL_OCR_TESSERACT_BINARY: execution.tesseractBinary,
    COMMERCIAL_OCR_TESSDATA_PREFIX: execution.tessdataPrefix,
    COMMERCIAL_OCR_TESSERACT_TIMEOUT_MS: execution.timeoutMs,
    COMMERCIAL_OCR_TESSERACT_CONCURRENCY: execution.nativeConcurrency,
    COMMERCIAL_OCR_TESSERACT_MAX_QUEUE: execution.nativeMaxQueue,
    COMMERCIAL_OCR_TESSERACT_RECYCLE_AFTER_JOBS: execution.nativeRecycleAfterJobs,
    COMMERCIAL_OCR_TESSERACT_MAX_IMAGE_BYTES: execution.maxImageBytes,
    COMMERCIAL_OCR_TESSERACT_MAX_OUTPUT_BYTES: execution.maxOutputBytes,
    COMMERCIAL_OCR_MAX_INPUT_PIXELS: execution.maxInputPixels,
    COMMERCIAL_OCR_MAX_OUTPUT_PIXELS: execution.maxOutputPixels,
    COMMERCIAL_OCR_MAX_SIDE: execution.maxSide,
    PHOTO_DUPLICATE_MAX_BYTES: execution.maxSourceImageBytes,
    OMP_THREAD_LIMIT: execution.ompThreadLimit,
  };
  return { get: (propertyPath) => values[propertyPath] };
}

async function sha256File(pathname: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(pathname))
    .digest('hex');
}

function normalizeOptionalDigest(
  value: string | undefined,
  length: number,
  label: string,
): string | null {
  if (value === undefined) return null;
  const normalized = value.trim().toLowerCase();
  if (!new RegExp(`^[a-f0-9]{${length}}$`, 'u').test(normalized)) {
    throw new Error(`Invalid ${label}`);
  }
  return normalized;
}

function normalizeOptionalSourceSha(value: string | undefined): string | null {
  if (value === undefined) return null;
  const normalized = value.trim().toLowerCase();
  if (!/^[a-f0-9]{40}$/u.test(normalized)) {
    throw new Error('Invalid source SHA');
  }
  return normalized;
}
