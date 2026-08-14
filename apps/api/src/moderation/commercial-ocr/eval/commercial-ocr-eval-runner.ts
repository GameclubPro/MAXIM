import { ConfigService } from '@nestjs/config';
import {
  resolveCommercialOcrEvalRunProvenance,
  type CommercialOcrEvalExecutionConfig,
  type CommercialOcrEvalRunProvenance,
} from '../../../scripts/commercial-run-provenance.util';
import type { ChatSettings } from '../../../prisma/prisma-client';
import { CommercialAdDetector } from '../../commercial/commercial-ad.detector';
import {
  resolveCommercialOcrNativeEngineConfig,
  resolveCommercialOcrNativeRuntimeControls,
  resolveCommercialOcrProductionNativeConfigReader,
} from '../commercial-ocr-behavior-identity';
import {
  isCommercialOcrCyrillicOnlyDeleteDecision,
  type CommercialOcrDecision,
  type CommercialOcrDetector,
  type CommercialOcrPass,
} from '../commercial-ocr-decision-policy';
import { runCommercialOcrAlbumSchedule } from '../commercial-ocr-album-scheduler';
import { convertCommercialOcrNativePayload } from '../commercial-ocr-native-result.converter';
import { CommercialOcrPreprocessor } from '../commercial-ocr-preprocessor';
import { fingerprintCommercialOcrSettingsProfile } from '../commercial-ocr-settings-profile';
import { runNativeTesseract } from '../native-tesseract-runner';
import type { NativeTesseractPageSegmentationMode } from '../native-tesseract-ocr.types';
import {
  aggregateCommercialOcrEvalQuality,
  evaluateCommercialOcrEvalCaseQuality,
  type CommercialOcrEvalQualityMetrics,
} from './commercial-ocr-eval-quality';
import {
  isCommercialOcrEvalCyrillicGroundTruthEligible,
  loadCommercialOcrEvalManifest,
  readVerifiedCommercialOcrEvalImage,
  verifyCommercialOcrEvalImage,
  type CommercialOcrEvalCase,
  type CommercialOcrEvalCaseV1,
  type CommercialOcrEvalCaseV2,
  type CommercialOcrEvalManifest,
} from './commercial-ocr-eval.schema';

const DEFAULT_EVAL_CONCURRENCY = 1;
const MAX_EVAL_CONCURRENCY = 4;
export const COMMERCIAL_OCR_EVAL_PERFORMANCE_MEASUREMENT_VERSION =
  'commercial-ocr-eval-performance-v1' as const;

export type CommercialOcrEvalDurationDistribution = Readonly<{
  observed: number;
  average: number | null;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  maximum: number | null;
}>;

export type CommercialOcrEvalPerformance = Readonly<{
  measurementVersion: typeof COMMERCIAL_OCR_EVAL_PERFORMANCE_MEASUREMENT_VERSION;
  benchmarkEnvironmentSha256: string | null;
  evalConcurrency: number;
  certification: Readonly<{
    sourceCases: number;
    images: number;
    expectedOcrPasses: number;
    attemptedOcrPasses: number;
    passCoverage: number;
    durationMs: number;
    deadlineBudgetMs: number;
    deadlineUtilization: number;
    throughputImagesPerMinute: number | null;
    ocrPassSamplesMs: readonly number[];
    sourceCaseSamplesMs: readonly number[];
    ocrPassDurationMs: CommercialOcrEvalDurationDistribution;
    sourceCaseDurationMs: CommercialOcrEvalDurationDistribution;
  }>;
}>;

export type CommercialOcrEvalCaseResult = {
  id: string;
  sourceCaseId: string;
  clusterId: string;
  corpusSchemaVersion: 1 | 2;
  split: 'legacy' | 'development' | 'holdout' | 'adversarial';
  statisticsRepresentative: boolean;
  settingsProfileId: string;
  settingsFingerprint: string;
  language: 'ru' | 'en' | 'mixed';
  imageTextScript?: 'cyrillic_only' | 'latin_only' | 'mixed' | 'unknown';
  imageTextScripts?: Array<'cyrillic_only' | 'latin_only' | 'mixed' | 'unknown'>;
  captionLanguage?: 'none' | 'ru' | 'en' | 'mixed' | 'other' | 'unknown';
  cyrillicGroundTruthEligible: boolean;
  category: string;
  hardNegativeCategory?: string;
  expectedSubtype?: string;
  actualSubtype?: string;
  expectedCommercialAction: 'DELETE' | 'NO_ACTION';
  actualCommercialAction: 'DELETE' | 'NO_ACTION' | 'INCOMPLETE';
  expectedEnforcementAction: 'DELETE' | 'NO_ACTION';
  actualEnforcementAction: 'DELETE' | 'NO_ACTION' | 'INCOMPLETE';
  // Compatibility aliases for report consumers. They always describe enforcement.
  expectedAction: 'DELETE' | 'NO_ACTION';
  actualAction: 'DELETE' | 'NO_ACTION' | 'INCOMPLETE';
  passed: boolean;
  durationMs: number;
  reasonCodes: string[];
  ocrQuality: CommercialOcrEvalQualityMetrics | null;
};

export type CommercialOcrEvalCorpusProvenance = Readonly<{
  sourceKind: 'production_temporal' | 'synthetic' | 'public_dataset';
  windowStartedAt: string | null;
  windowEndedAt: string | null;
  frozenAt: string;
  collectionProtocolVersion: string;
  annotationProtocolVersion: string;
  collectionArtifactSha256: string;
  adjudicationArtifactSha256: string;
}>;

export type CommercialOcrEvalReport = {
  schemaVersion: 3;
  corpusSchemaVersion: 1 | 2;
  corpusId: string;
  corpusRevision: string;
  corpusProvenance: CommercialOcrEvalCorpusProvenance | null;
  generatedAt: string;
  total: number;
  passed: number;
  failed: number;
  falseDeletes: number;
  missedDeletes: number;
  incomplete: number;
  incompleteExpectedDelete: number;
  incompleteExpectedNoAction: number;
  durationMs: number;
  quality: CommercialOcrEvalQualityMetrics;
  performance: CommercialOcrEvalPerformance;
  provenance: CommercialOcrEvalRunProvenance;
  languages: Record<'ru' | 'en' | 'mixed', CommercialOcrEvalSlice>;
  categories: Record<string, CommercialOcrEvalSlice>;
  clusters: CommercialOcrEvalClusterResult[];
  cases: CommercialOcrEvalCaseResult[];
};

export type CommercialOcrEvalRunnerDependencies = {
  loadManifest: typeof loadCommercialOcrEvalManifest;
  readImage: typeof readVerifiedCommercialOcrEvalImage;
  verifyImage: typeof verifyCommercialOcrEvalImage;
  createDetector: () => CommercialOcrDetector;
  recognizePass: (params: {
    preprocessor: CommercialOcrPreprocessor;
    execution: CommercialOcrEvalExecutionConfig;
    raw: Buffer;
    pass: 'primary' | 'confirmation';
    psm: NativeTesseractPageSegmentationMode;
  }) => Promise<CommercialOcrPass | null>;
  resolveProvenance: typeof resolveCommercialOcrEvalRunProvenance;
};

export type CommercialOcrEvalSlice = {
  total: number;
  falseDeletes: number;
  missedDeletes: number;
  incomplete: number;
  incompleteExpectedDelete: number;
  incompleteExpectedNoAction: number;
};

export type CommercialOcrEvalClusterResult = CommercialOcrEvalSlice & {
  clusterId: string;
  passed: boolean;
};

type EvalSettingsProfile = {
  id: string;
  settings: ChatSettings;
  fingerprint: string;
};

type PerformanceSample = Readonly<{
  split: CommercialOcrEvalCaseResult['split'];
  durationMs: number;
}>;

export async function runCommercialOcrEval(params: {
  manifestPath: string;
  config?: ConfigService;
  concurrency?: number;
  immutableImageSha256?: string;
  sourceSha?: string;
  expectedBenchmarkEnvironmentSha256?: string;
  dependencies?: Partial<CommercialOcrEvalRunnerDependencies>;
}): Promise<CommercialOcrEvalReport> {
  const startedAt = performance.now();
  const runStartedAt = new Date().toISOString();
  const config = params.config ?? new ConfigService(process.env);
  const concurrency = readEvalConcurrency(params.concurrency);
  const dependencies = resolveRunnerDependencies(params.dependencies);
  const execution = resolveCommercialOcrEvalExecutionConfig(config, concurrency);
  const { manifest, manifestPath, manifestSha256, corpusRoot } = await dependencies.loadManifest(
    params.manifestPath,
  );
  const provenance = await dependencies.resolveProvenance({
    manifestPath,
    manifestSha256,
    execution,
    startedAt: runStartedAt,
    ...(params.immutableImageSha256 ? { immutableImageSha256: params.immutableImageSha256 } : {}),
    ...(params.sourceSha ? { sourceSha: params.sourceSha } : {}),
    ...(params.expectedBenchmarkEnvironmentSha256
      ? { expectedBenchmarkEnvironmentSha256: params.expectedBenchmarkEnvironmentSha256 }
      : {}),
  });
  const preprocessor = new CommercialOcrPreprocessor(config);
  const detector = dependencies.createDetector();
  const profiles = resolveSettingsProfiles(manifest);
  const fixtures: CommercialOcrEvalCase[] = [...manifest.cases];
  const ocrPassPerformanceSamples: PerformanceSample[] = [];
  const sourceCasePerformanceSamples: PerformanceSample[] = [];
  const nestedCases = await mapCommercialOcrEvalWithConcurrency<
    CommercialOcrEvalCase,
    CommercialOcrEvalCaseResult[]
  >(fixtures, concurrency, async (fixture) => {
    const caseStartedAt = performance.now();
    try {
      return await evaluateCase({
        fixture,
        corpusSchemaVersion: manifest.schemaVersion,
        profiles,
        corpusRoot,
        preprocessor,
        execution,
        dependencies,
        detector,
        ocrPassPerformanceSamples,
      });
    } finally {
      sourceCasePerformanceSamples.push({
        split: performanceSplit(fixture),
        durationMs: roundMs(performance.now() - caseStartedAt),
      });
    }
  });
  const cases = nestedCases.flat();
  const uniqueQualityCases = [
    ...new Map(cases.map((item) => [item.sourceCaseId, item])).values(),
  ].flatMap((item) => (item.ocrQuality ? [item.ocrQuality] : []));
  const falseDeletes = cases.filter(
    (item) => item.expectedAction === 'NO_ACTION' && item.actualAction === 'DELETE',
  ).length;
  const missedDeletes = cases.filter(
    (item) => item.expectedAction === 'DELETE' && item.actualAction === 'NO_ACTION',
  ).length;
  const incomplete = cases.filter((item) => item.actualAction === 'INCOMPLETE').length;
  const incompleteExpectedDelete = cases.filter(
    (item) => item.expectedAction === 'DELETE' && item.actualAction === 'INCOMPLETE',
  ).length;
  const incompleteExpectedNoAction = cases.filter(
    (item) => item.expectedAction === 'NO_ACTION' && item.actualAction === 'INCOMPLETE',
  ).length;
  const languages = {
    ru: summarizeCases(cases.filter((item) => item.language === 'ru')),
    en: summarizeCases(cases.filter((item) => item.language === 'en')),
    mixed: summarizeCases(cases.filter((item) => item.language === 'mixed')),
  };
  const categories = Object.fromEntries(
    [...groupCases(cases, (item) => item.category).entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([category, categoryCases]) => [category, summarizeCases(categoryCases)]),
  );
  const clusters = [...groupCases(cases, (item) => item.clusterId).entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([clusterId, clusterCases]) => {
      const summary = summarizeCases(clusterCases);
      return {
        clusterId,
        passed: clusterCases.every((item) => item.passed),
        ...summary,
      };
    });
  const durationMs = roundMs(performance.now() - startedAt);
  const performanceReport = buildCommercialOcrEvalPerformance({
    fixtures,
    execution,
    provenance,
    ocrPassPerformanceSamples,
    sourceCasePerformanceSamples,
  });
  return {
    schemaVersion: 3,
    corpusSchemaVersion: manifest.schemaVersion,
    corpusId: manifest.corpusId,
    corpusRevision: manifest.corpusRevision,
    corpusProvenance: reportCorpusProvenance(manifest),
    generatedAt: new Date().toISOString(),
    total: cases.length,
    passed: cases.filter((item) => item.passed).length,
    failed: cases.filter((item) => !item.passed).length,
    falseDeletes,
    missedDeletes,
    incomplete,
    incompleteExpectedDelete,
    incompleteExpectedNoAction,
    durationMs,
    quality: aggregateCommercialOcrEvalQuality(uniqueQualityCases),
    performance: performanceReport,
    provenance,
    languages,
    categories,
    clusters,
    cases,
  };
}

async function evaluateCase(params: {
  fixture: CommercialOcrEvalCase;
  corpusSchemaVersion: 1 | 2;
  profiles: ReadonlyMap<string, EvalSettingsProfile>;
  corpusRoot: string;
  preprocessor: CommercialOcrPreprocessor;
  execution: CommercialOcrEvalExecutionConfig;
  dependencies: CommercialOcrEvalRunnerDependencies;
  detector: CommercialOcrDetector;
  ocrPassPerformanceSamples: PerformanceSample[];
}): Promise<CommercialOcrEvalCaseResult[]> {
  const startedAt = performance.now();
  for (let imageIndex = 0; imageIndex < params.fixture.images.length; imageIndex += 1) {
    const imageFixture = params.fixture.images[imageIndex]!;
    try {
      await params.dependencies.verifyImage({
        corpusRoot: params.corpusRoot,
        image: imageFixture,
        maxBytes: params.execution.maxSourceImageBytes,
      });
    } catch {
      const ocrQuality = qualityForUnattemptedCase(params.fixture, params.corpusSchemaVersion);
      return selectedProfiles(params.fixture, params.profiles).map((profile) =>
        result(params.fixture, params.corpusSchemaVersion, profile, {
          commercialAction: 'INCOMPLETE',
          enforcementAction: 'INCOMPLETE',
          reasonCodes: [],
          startedAt,
          ocrQuality,
        }),
      );
    }
  }

  const passCache = new Map<string, Promise<CommercialOcrPass | null>>();
  type EvalImageContext = { raw: Buffer | null };
  const resolveCachedPass = (
    context: EvalImageContext,
    imageIndex: number,
    pass: 'primary' | 'confirmation',
  ) => {
    const key = `${imageIndex}:${pass}`;
    let pending = passCache.get(key);
    if (!pending) {
      pending = (async () => {
        context.raw ??= await params.dependencies.readImage({
          corpusRoot: params.corpusRoot,
          image: params.fixture.images[imageIndex]!,
          maxBytes: params.execution.maxSourceImageBytes,
        });
        const passStartedAt = performance.now();
        try {
          return await params.dependencies.recognizePass({
            preprocessor: params.preprocessor,
            execution: params.execution,
            raw: context.raw,
            pass,
            psm: pass === 'primary' ? 11 : 6,
          });
        } finally {
          params.ocrPassPerformanceSamples.push({
            split: performanceSplit(params.fixture),
            durationMs: roundMs(performance.now() - passStartedAt),
          });
        }
      })().catch(() => null);
      passCache.set(key, pending);
    }
    return pending;
  };

  const qualityPasses =
    params.corpusSchemaVersion === 2
      ? await resolveFullQualityPasses(params.fixture, resolveCachedPass)
      : null;

  const results: CommercialOcrEvalCaseResult[] = [];
  for (const profile of selectedProfiles(params.fixture, params.profiles)) {
    const profileStartedAt = performance.now();
    const scheduled = await runCommercialOcrAlbumSchedule<EvalImageContext, null>({
      caption: params.fixture.caption,
      settings: profile.settings,
      imageSources: params.fixture.images.map((image) =>
        'source' in image ? image.source : 'direct',
      ),
      detector: params.detector,
      createImageContext: () => ({ raw: null }),
      resolvePass: async ({ context, imageIndex, pass }) => {
        const recognized = await resolveCachedPass(context, imageIndex, pass);
        return recognized ? { kind: 'ready', value: recognized } : { kind: 'stop', result: null };
      },
      finishImage: (context) => {
        context.raw = null;
      },
    });
    if (scheduled.kind === 'stopped') {
      results.push(
        result(params.fixture, params.corpusSchemaVersion, profile, {
          commercialAction: 'INCOMPLETE',
          enforcementAction: 'INCOMPLETE',
          reasonCodes: [],
          startedAt: profileStartedAt,
          ocrQuality: null,
        }),
      );
      continue;
    }
    const decision = scheduled.decision;
    const enforcementAction = isCommercialOcrCyrillicOnlyDeleteDecision(decision)
      ? 'DELETE'
      : 'NO_ACTION';
    results.push(
      result(params.fixture, params.corpusSchemaVersion, profile, {
        commercialAction: decision.action,
        enforcementAction,
        reasonCodes:
          decision.action === 'DELETE' && enforcementAction === 'NO_ACTION'
            ? [...decision.reasonCodes, 'runtime-report-only-language']
            : decision.reasonCodes,
        startedAt: profileStartedAt,
        decision,
        ocrQuality: null,
      }),
    );
  }
  void startedAt;
  const ocrQuality = qualityPasses
    ? evaluateCommercialOcrEvalCaseQuality({
        fixture: params.fixture as CommercialOcrEvalCaseV2,
        passes: qualityPasses,
      })
    : null;
  return results.map((item) => ({ ...item, ocrQuality }));
}

async function resolveFullQualityPasses(
  fixture: CommercialOcrEvalCase,
  resolvePass: (
    context: { raw: Buffer | null },
    imageIndex: number,
    pass: 'primary' | 'confirmation',
  ) => Promise<CommercialOcrPass | null>,
): Promise<Array<{ primary: CommercialOcrPass | null; confirmation: CommercialOcrPass | null }>> {
  const passes: Array<{
    primary: CommercialOcrPass | null;
    confirmation: CommercialOcrPass | null;
  }> = [];
  for (let imageIndex = 0; imageIndex < fixture.images.length; imageIndex += 1) {
    const context = { raw: null as Buffer | null };
    try {
      passes.push({
        primary: await resolvePass(context, imageIndex, 'primary'),
        confirmation: await resolvePass(context, imageIndex, 'confirmation'),
      });
    } finally {
      context.raw = null;
    }
  }
  return passes;
}

async function recognizePass(params: {
  preprocessor: CommercialOcrPreprocessor;
  execution: CommercialOcrEvalExecutionConfig;
  raw: Buffer;
  pass: 'primary' | 'confirmation';
  psm: NativeTesseractPageSegmentationMode;
}): Promise<CommercialOcrPass | null> {
  const prepared = await params.preprocessor.prepare(params.raw, params.pass);
  if (prepared.bytes.byteLength < 1 || prepared.bytes.byteLength > params.execution.maxImageBytes) {
    return null;
  }
  const native = await runNativeTesseract({
    binary: params.execution.tesseractBinary,
    ...(params.execution.tessdataPrefix ? { tessdataPrefix: params.execution.tessdataPrefix } : {}),
    image: prepared.bytes,
    psm: params.psm,
    timeoutMs: params.execution.timeoutMs,
    maxOutputBytes: params.execution.maxOutputBytes,
    ompThreadLimit: params.execution.ompThreadLimit,
  });
  if (!native.ok) {
    return null;
  }
  const converted = convertCommercialOcrNativePayload(native.payload);
  return converted.kind === 'ready' ? converted.pass : null;
}

export function resolveCommercialOcrEvalExecutionConfig(
  config: ConfigService,
  evalConcurrency: number,
): CommercialOcrEvalExecutionConfig {
  const productionConfig = resolveCommercialOcrProductionNativeConfigReader(config);
  const engine = resolveCommercialOcrNativeEngineConfig(productionConfig);
  const controls = resolveCommercialOcrNativeRuntimeControls(productionConfig);
  return {
    tesseractBinary: engine.binary,
    tessdataPrefix: engine.tessdataPrefix,
    timeoutMs: controls.timeoutMs,
    maxSourceImageBytes: controls.maxSourceImageBytes,
    maxImageBytes: controls.maxImageBytes,
    maxOutputBytes: controls.maxOutputBytes,
    maxInputPixels: controls.maxInputPixels,
    maxOutputPixels: controls.maxOutputPixels,
    maxSide: controls.maxSide,
    ompThreadLimit: controls.ompThreadLimit,
    nativeConcurrency: controls.concurrency,
    nativeMaxQueue: controls.maxQueue,
    nativeRecycleAfterJobs: controls.recycleAfterJobs,
    sharpConcurrency: controls.sharpConcurrency,
    sharpProcessingTimeoutSeconds: controls.sharpProcessingTimeoutSeconds,
    evalConcurrency,
  };
}

function resolveRunnerDependencies(
  overrides: Partial<CommercialOcrEvalRunnerDependencies> | undefined,
): CommercialOcrEvalRunnerDependencies {
  const readImage = overrides?.readImage ?? readVerifiedCommercialOcrEvalImage;
  return {
    loadManifest: overrides?.loadManifest ?? loadCommercialOcrEvalManifest,
    readImage,
    verifyImage:
      overrides?.verifyImage ??
      (overrides?.readImage
        ? async (params) => {
            await readImage(params);
          }
        : verifyCommercialOcrEvalImage),
    createDetector: overrides?.createDetector ?? (() => new CommercialAdDetector()),
    recognizePass: overrides?.recognizePass ?? recognizePass,
    resolveProvenance: overrides?.resolveProvenance ?? resolveCommercialOcrEvalRunProvenance,
  };
}

function result(
  fixture: CommercialOcrEvalCase,
  corpusSchemaVersion: 1 | 2,
  profile: EvalSettingsProfile,
  params: {
    commercialAction: CommercialOcrEvalCaseResult['actualCommercialAction'];
    enforcementAction: CommercialOcrEvalCaseResult['actualEnforcementAction'];
    reasonCodes: string[];
    startedAt: number;
    decision?: CommercialOcrDecision;
    ocrQuality: CommercialOcrEvalQualityMetrics | null;
  },
): CommercialOcrEvalCaseResult {
  const expectedCommercialAction =
    corpusSchemaVersion === 2
      ? expectationForProfile(fixture as CommercialOcrEvalCaseV2, profile.id)
          .expectedCommercialAction
      : (fixture as CommercialOcrEvalCaseV1).expectedAction;
  const expectedEnforcementAction =
    corpusSchemaVersion === 2
      ? expectationForProfile(fixture as CommercialOcrEvalCaseV2, profile.id)
          .expectedEnforcementAction
      : (fixture as CommercialOcrEvalCaseV1).expectedAction;
  const imageTextScripts =
    corpusSchemaVersion === 2
      ? (fixture as CommercialOcrEvalCaseV2).images.map((image) => image.imageTextScript)
      : undefined;
  const legacyScript = (fixture as CommercialOcrEvalCaseV1).imageTextScript;
  const imageTextScript =
    corpusSchemaVersion === 2 ? summarizeGroundTruthScripts(imageTextScripts ?? []) : legacyScript;
  const expectedSubtype =
    corpusSchemaVersion === 2 ? (fixture as CommercialOcrEvalCaseV2).commercialSubtype : undefined;
  const actualSubtype = params.decision?.deleteSource
    ? params.decision.images.find(
        (image) => image.imageIndex === params.decision?.deleteSource?.imageIndex,
      )?.primary.detection?.primarySubtype
    : undefined;
  const passed =
    params.commercialAction !== 'INCOMPLETE' &&
    params.enforcementAction !== 'INCOMPLETE' &&
    params.commercialAction === expectedCommercialAction &&
    params.enforcementAction === expectedEnforcementAction &&
    (expectedCommercialAction !== 'DELETE' || actualSubtype === expectedSubtype);
  return {
    id: `${fixture.id}@${profile.id}`,
    sourceCaseId: fixture.id,
    clusterId: fixture.clusterId,
    corpusSchemaVersion,
    split:
      corpusSchemaVersion === 2 ? (fixture as CommercialOcrEvalCaseV2).split : ('legacy' as const),
    statisticsRepresentative:
      corpusSchemaVersion === 2
        ? (fixture as CommercialOcrEvalCaseV2).statisticsRepresentative
        : false,
    settingsProfileId: profile.id,
    settingsFingerprint: profile.fingerprint,
    language: fixture.language,
    imageTextScript,
    imageTextScripts,
    captionLanguage: fixture.captionLanguage,
    cyrillicGroundTruthEligible:
      corpusSchemaVersion === 2
        ? isCommercialOcrEvalCyrillicGroundTruthEligible(fixture as CommercialOcrEvalCaseV2)
        : false,
    category: fixture.category,
    hardNegativeCategory: fixture.hardNegativeCategory,
    expectedSubtype,
    actualSubtype,
    expectedCommercialAction,
    actualCommercialAction: params.commercialAction,
    expectedEnforcementAction,
    actualEnforcementAction: params.enforcementAction,
    expectedAction: expectedEnforcementAction,
    actualAction: params.enforcementAction,
    passed,
    durationMs: roundMs(performance.now() - params.startedAt),
    reasonCodes: params.reasonCodes,
    ocrQuality: params.ocrQuality,
  };
}

function qualityForUnattemptedCase(
  fixture: CommercialOcrEvalCase,
  corpusSchemaVersion: 1 | 2,
): CommercialOcrEvalQualityMetrics | null {
  if (corpusSchemaVersion !== 2) return null;
  return evaluateCommercialOcrEvalCaseQuality({
    fixture: fixture as CommercialOcrEvalCaseV2,
    passes: fixture.images.map(() => ({ primary: undefined, confirmation: undefined })),
  });
}

function reportCorpusProvenance(
  manifest: CommercialOcrEvalManifest,
): CommercialOcrEvalCorpusProvenance | null {
  if (manifest.schemaVersion !== 2) return null;
  return {
    sourceKind: manifest.provenance.sourceKind,
    windowStartedAt: manifest.provenance.windowStartedAt,
    windowEndedAt: manifest.provenance.windowEndedAt,
    frozenAt: manifest.provenance.frozenAt,
    collectionProtocolVersion: manifest.provenance.collectionProtocolVersion,
    annotationProtocolVersion: manifest.provenance.annotationProtocolVersion,
    collectionArtifactSha256: manifest.provenance.collectionArtifact.sha256,
    adjudicationArtifactSha256: manifest.provenance.adjudicationArtifact.sha256,
  };
}

function buildCommercialOcrEvalPerformance(params: {
  fixtures: readonly CommercialOcrEvalCase[];
  execution: CommercialOcrEvalExecutionConfig;
  provenance: CommercialOcrEvalRunProvenance;
  ocrPassPerformanceSamples: readonly PerformanceSample[];
  sourceCasePerformanceSamples: readonly PerformanceSample[];
}): CommercialOcrEvalPerformance {
  const certificationFixtures = params.fixtures.filter((fixture) => {
    const split = performanceSplit(fixture);
    return split === 'holdout' || split === 'adversarial';
  });
  const certificationPassSamples = params.ocrPassPerformanceSamples
    .filter((sample) => sample.split === 'holdout' || sample.split === 'adversarial')
    .map((sample) => sample.durationMs)
    .sort((left, right) => left - right);
  const certificationCaseSamples = params.sourceCasePerformanceSamples
    .filter((sample) => sample.split === 'holdout' || sample.split === 'adversarial')
    .map((sample) => sample.durationMs)
    .sort((left, right) => left - right);
  const images = certificationFixtures.reduce(
    (total, fixture) => total + fixture.images.length,
    0,
  );
  const expectedOcrPasses = images * 2;
  const durationMs = roundMs(
    certificationCaseSamples.reduce((total, sample) => total + sample, 0),
  );
  const deadlineBudgetMs =
    expectedOcrPasses *
    (params.execution.timeoutMs + params.execution.sharpProcessingTimeoutSeconds * 1_000);
  return Object.freeze({
    measurementVersion: COMMERCIAL_OCR_EVAL_PERFORMANCE_MEASUREMENT_VERSION,
    benchmarkEnvironmentSha256:
      params.provenance.benchmarkEnvironment?.descriptorSha256 ?? null,
    evalConcurrency: params.execution.evalConcurrency,
    certification: Object.freeze({
      sourceCases: certificationFixtures.length,
      images,
      expectedOcrPasses,
      attemptedOcrPasses: certificationPassSamples.length,
      passCoverage: ratio(certificationPassSamples.length, expectedOcrPasses),
      durationMs,
      deadlineBudgetMs,
      deadlineUtilization: ratio(durationMs, deadlineBudgetMs),
      throughputImagesPerMinute:
        images > 0 && durationMs > 0 ? roundRate((images * 60_000) / durationMs) : null,
      ocrPassSamplesMs: Object.freeze(certificationPassSamples),
      sourceCaseSamplesMs: Object.freeze(certificationCaseSamples),
      ocrPassDurationMs: summarizeCommercialOcrEvalDurationSamples(certificationPassSamples),
      sourceCaseDurationMs: summarizeCommercialOcrEvalDurationSamples(certificationCaseSamples),
    }),
  });
}

export function summarizeCommercialOcrEvalDurationSamples(
  samples: readonly number[],
): CommercialOcrEvalDurationDistribution {
  if (
    samples.some(
      (sample, index) =>
        !Number.isFinite(sample) ||
        sample < 0 ||
        (index > 0 && samples[index - 1]! > sample),
    )
  ) {
    throw new Error('Commercial OCR performance samples must be finite, nonnegative, and sorted');
  }
  if (samples.length === 0) {
    return Object.freeze({
      observed: 0,
      average: null,
      p50: null,
      p95: null,
      p99: null,
      maximum: null,
    });
  }
  const total = samples.reduce((sum, sample) => sum + sample, 0);
  return Object.freeze({
    observed: samples.length,
    average: roundMs(total / samples.length),
    p50: nearestRankDuration(samples, 0.5),
    p95: nearestRankDuration(samples, 0.95),
    p99: nearestRankDuration(samples, 0.99),
    maximum: samples.at(-1)!,
  });
}

function performanceSplit(fixture: CommercialOcrEvalCase): CommercialOcrEvalCaseResult['split'] {
  return 'split' in fixture ? fixture.split : 'legacy';
}

function nearestRankDuration(samples: readonly number[], ratioValue: number): number {
  return samples[Math.max(0, Math.ceil(samples.length * ratioValue) - 1)]!;
}

function ratio(numerator: number, denominator: number): number {
  return denominator > 0 ? roundRate(numerator / denominator) : 0;
}

function roundRate(value: number): number {
  return Math.max(0, Math.round(value * 1_000_000) / 1_000_000);
}

function selectedProfiles(
  fixture: CommercialOcrEvalCase,
  profiles: ReadonlyMap<string, EvalSettingsProfile>,
): EvalSettingsProfile[] {
  const ids =
    'expectations' in fixture
      ? fixture.expectations.map((item) => item.settingsProfileId)
      : [LEGACY_PROFILE_ID];
  return ids.map((id) => {
    const profile = profiles.get(id);
    if (!profile) {
      throw new Error(`Commercial OCR eval references unknown settings profile ${id}`);
    }
    return profile;
  });
}

function expectationForProfile(fixture: CommercialOcrEvalCaseV2, profileId: string) {
  const expectation = fixture.expectations.find((item) => item.settingsProfileId === profileId);
  if (!expectation) {
    throw new Error(`Commercial OCR eval case ${fixture.id} has no expectation for ${profileId}`);
  }
  return expectation;
}

function resolveSettingsProfiles(
  manifest: Awaited<ReturnType<typeof loadCommercialOcrEvalManifest>>['manifest'],
): Map<string, EvalSettingsProfile> {
  const sourceProfiles =
    manifest.schemaVersion === 2
      ? manifest.settingsProfiles
      : [
          {
            id: LEGACY_PROFILE_ID,
            commercialAdsSensitivity: 'BALANCED' as const,
            commercialAdsWarnThreshold: 45,
            commercialAdsDeleteThreshold: 65,
          },
        ];
  return new Map(
    sourceProfiles.map((profile) => {
      const settings = {
        commercialAdsFilterEnabled: true,
        commercialAdsSensitivity: profile.commercialAdsSensitivity,
        commercialAdsWarnThreshold: profile.commercialAdsWarnThreshold,
        commercialAdsDeleteThreshold: profile.commercialAdsDeleteThreshold,
        nightModeTimezone: 'Europe/Moscow',
      } as ChatSettings;
      return [
        profile.id,
        {
          id: profile.id,
          settings,
          fingerprint: fingerprintCommercialOcrSettingsProfile(profile),
        },
      ];
    }),
  );
}

function summarizeGroundTruthScripts(
  scripts: readonly ('cyrillic_only' | 'latin_only' | 'mixed' | 'unknown')[],
): 'cyrillic_only' | 'latin_only' | 'mixed' | 'unknown' {
  if (scripts.length === 0 || scripts.includes('unknown')) return 'unknown';
  if (scripts.includes('mixed')) return 'mixed';
  return new Set(scripts).size === 1 ? scripts[0]! : 'mixed';
}

export async function mapCommercialOcrEvalWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  evaluate: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const workerCount = Math.min(readEvalConcurrency(concurrency), items.length);
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  const worker = async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await evaluate(items[index]!, index);
    }
  };

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

function readEvalConcurrency(value: number | undefined): number {
  const concurrency = value ?? DEFAULT_EVAL_CONCURRENCY;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > MAX_EVAL_CONCURRENCY) {
    throw new Error(
      `Commercial OCR eval concurrency must be between 1 and ${MAX_EVAL_CONCURRENCY}`,
    );
  }
  return concurrency;
}

function roundMs(value: number): number {
  return Math.max(0, Math.round(value * 100) / 100);
}

function summarizeCases(cases: readonly CommercialOcrEvalCaseResult[]): CommercialOcrEvalSlice {
  return {
    total: cases.length,
    falseDeletes: cases.filter(
      (item) => item.expectedAction === 'NO_ACTION' && item.actualAction === 'DELETE',
    ).length,
    missedDeletes: cases.filter(
      (item) => item.expectedAction === 'DELETE' && item.actualAction === 'NO_ACTION',
    ).length,
    incomplete: cases.filter((item) => item.actualAction === 'INCOMPLETE').length,
    incompleteExpectedDelete: cases.filter(
      (item) => item.expectedAction === 'DELETE' && item.actualAction === 'INCOMPLETE',
    ).length,
    incompleteExpectedNoAction: cases.filter(
      (item) => item.expectedAction === 'NO_ACTION' && item.actualAction === 'INCOMPLETE',
    ).length,
  };
}

function groupCases(
  cases: readonly CommercialOcrEvalCaseResult[],
  key: (item: CommercialOcrEvalCaseResult) => string,
): Map<string, CommercialOcrEvalCaseResult[]> {
  const groups = new Map<string, CommercialOcrEvalCaseResult[]>();
  for (const item of cases) {
    const groupKey = key(item);
    const group = groups.get(groupKey);
    if (group) {
      group.push(item);
    } else {
      groups.set(groupKey, [item]);
    }
  }
  return groups;
}

const LEGACY_PROFILE_ID = 'legacy-balanced-45-65';
