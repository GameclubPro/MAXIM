import { COMMERCIAL_ENGINE_CONFIG } from '../../commercial/commercial-config';
import { isDeepStrictEqual } from 'node:util';
import { COMMERCIAL_OCR_BENCHMARK_ENVIRONMENT_PROFILE_ID } from '../../../scripts/commercial-run-provenance.util';
import { COMMERCIAL_SECOND_STAGE_VERSION } from '../../rule-engine-commercial-second-stage-cache';
import {
  resolveCommercialOcrBehaviorIdentity,
  fingerprintCommercialOcrNativeBehaviorManifest,
  type CommercialOcrBehaviorDescriptor,
  type CommercialOcrNativeBehaviorManifest,
  resolveCommercialOcrNativeRuntimeControls,
  resolveCommercialOcrProductionNativeConfigReader,
} from '../commercial-ocr-behavior-identity';
import { COMMERCIAL_OCR_DECISION_POLICY_VERSION } from '../commercial-ocr-decision-policy';
import { COMMERCIAL_OCR_PREPROCESS_PROFILES } from '../commercial-ocr-preprocessor';
import { COMMERCIAL_OCR_DEFAULT_VERSION } from '../commercial-ocr.queue';
import { SUPPORTED_PHOTO_IMAGE_FORMATS } from '../../photo-duplicate/photo-image-format';
import {
  aggregateCommercialOcrEvalQuality,
  type CommercialOcrEvalQualityMetrics,
} from './commercial-ocr-eval-quality';
import {
  COMMERCIAL_OCR_CERTIFICATION_ANNOTATION_PROTOCOL_VERSION,
  COMMERCIAL_OCR_CERTIFICATION_COLLECTION_PROTOCOL_VERSION,
} from './commercial-ocr-eval.schema';
import { calculateCommercialOcrEvalCanonicalSha256 } from './commercial-ocr-eval-canonical';
import {
  COMMERCIAL_OCR_EVAL_PERFORMANCE_MEASUREMENT_VERSION,
  summarizeCommercialOcrEvalDurationSamples,
  type CommercialOcrEvalPerformance,
  CommercialOcrEvalCaseResult,
  CommercialOcrEvalReport,
} from './commercial-ocr-eval-runner';

const LOWER_GIT_SHA_PATTERN = /^[a-f0-9]{40}$/u;
const LOWER_SHA_256_PATTERN = /^[a-f0-9]{64}$/u;
const NODE_24_VERSION_PATTERN = /^v24\.\d+\.\d+$/u;
export const CERTIFICATION_RUNTIME_VERSIONS = Object.freeze({
  sharp: '0.35.3',
  libvips: '8.18.3',
  tesseract: 'tesseract 5.5.2',
});
const CERTIFICATION_NATIVE_RUNTIME_CONTROLS = resolveCommercialOcrNativeRuntimeControls(
  resolveCommercialOcrProductionNativeConfigReader(),
);
export const CERTIFICATION_RESOURCE_LIMITS = Object.freeze({
  timeoutMs: CERTIFICATION_NATIVE_RUNTIME_CONTROLS.timeoutMs,
  maxSourceImageBytes: CERTIFICATION_NATIVE_RUNTIME_CONTROLS.maxSourceImageBytes,
  maxImageBytes: CERTIFICATION_NATIVE_RUNTIME_CONTROLS.maxImageBytes,
  maxOutputBytes: CERTIFICATION_NATIVE_RUNTIME_CONTROLS.maxOutputBytes,
  maxInputPixels: CERTIFICATION_NATIVE_RUNTIME_CONTROLS.maxInputPixels,
  maxOutputPixels: CERTIFICATION_NATIVE_RUNTIME_CONTROLS.maxOutputPixels,
  maxSide: CERTIFICATION_NATIVE_RUNTIME_CONTROLS.maxSide,
  ompThreadLimit: CERTIFICATION_NATIVE_RUNTIME_CONTROLS.ompThreadLimit,
  nativeConcurrency: CERTIFICATION_NATIVE_RUNTIME_CONTROLS.concurrency,
  nativeMaxQueue: CERTIFICATION_NATIVE_RUNTIME_CONTROLS.maxQueue,
  nativeRecycleAfterJobs: CERTIFICATION_NATIVE_RUNTIME_CONTROLS.recycleAfterJobs,
  sharpConcurrency: CERTIFICATION_NATIVE_RUNTIME_CONTROLS.sharpConcurrency,
  sharpProcessingTimeoutSeconds:
    CERTIFICATION_NATIVE_RUNTIME_CONTROLS.sharpProcessingTimeoutSeconds,
  evalConcurrency: 1,
});
const DAY_MS = 24 * 60 * 60 * 1_000;
export const COMMERCIAL_OCR_CERTIFICATION_MIN_COLLECTION_WINDOW_MS = 7 * DAY_MS;
export const COMMERCIAL_OCR_CERTIFICATION_MAX_CORPUS_AGE_MS = 90 * DAY_MS;
export const COMMERCIAL_OCR_CERTIFICATION_MAX_FREEZE_LAG_MS = 30 * DAY_MS;

export type CommercialOcrEvalHardNegativeGate = Readonly<{
  minCases: number;
  minClusters: number;
}>;

export type CommercialOcrEvalGateProfile = {
  minTotal: number;
  minAdversarialCases: number;
  minAdversarialClusters: number;
  minDeleteCases: number;
  minEligibleNoActionCases: number;
  minClusters: number;
  minPositiveSubtypeClusters: number;
  requiredPositiveSubtypes: readonly NonNullable<CommercialOcrEvalCaseResult['expectedSubtype']>[];
  maxFalseDeleteRate: number;
  maxFalseDeleteUpperConfidenceBound: number;
  falseDeleteConfidenceLevel: number;
  minDeleteRecall: number;
  minDeleteRecallLowerConfidenceBound: number;
  deleteRecallConfidenceLevel: number;
  maxPositiveIncompleteRate: number;
  maxNegativeIncompleteRate: number;
  incompleteConfidenceLevel: number;
  maxUnlabeledImageScriptCases: number;
  maxUnlabeledCaptionLanguageCases: number;
  requiredHardNegativeCategories: Readonly<Record<string, CommercialOcrEvalHardNegativeGate>>;
  maxHardNegativeFalseDeletes: number;
  minQualityCases: number;
  minAttemptedPasses: number;
  minCharacterReferenceLength: number;
  minWordReferenceLength: number;
  minCriticalTokens: number;
  minConfidenceObservations: number;
  minHighConfidencePasses: number;
  minCriticalTokenRecall: number;
  maxCharacterErrorRate: number;
  maxWordErrorRate: number;
  maxMeanAbsoluteConfidenceCalibrationError: number;
  maxHighConfidenceSevereErrorRate: number;
  minPerformanceSourceCases: number;
  minPerformanceOcrPasses: number;
  minPerformancePassCoverage: number;
  maxOcrPassP95Ms: number;
  maxOcrPassP99Ms: number;
  maxOcrPassMs: number;
  maxSourceCaseP95Ms: number;
  maxSourceCaseP99Ms: number;
  minThroughputImagesPerMinute: number;
  maxDeadlineUtilization: number;
};

const REQUIRED_HARD_NEGATIVE_CATEGORIES = {
  rules_or_moderation_context: { minCases: 100, minClusters: 60 },
  spam_complaint_or_fraud_warning: { minCases: 100, minClusters: 60 },
  news_or_analytics: { minCases: 100, minClusters: 60 },
  brand_mention_only: { minCases: 100, minClusters: 60 },
  private_one_off_sale: { minCases: 100, minClusters: 60 },
  ordinary_recruitment: { minCases: 100, minClusters: 60 },
  public_training_or_help: { minCases: 100, minClusters: 60 },
  request_or_recommendation: { minCases: 100, minClusters: 60 },
} as const satisfies Readonly<Record<string, CommercialOcrEvalHardNegativeGate>>;

const REQUIRED_ENFORCING_SUBTYPES = [
  'CHANNEL_PLACEMENT',
  'PROPERTY_AGENT',
  'PROPERTY_COMMERCIAL',
  'RECRUITMENT',
  'INFO_PRODUCT',
  'BUYOUT',
  'SERVICES',
  'GOODS_RETAIL',
  'GROUP_PROMOTION',
] as const satisfies readonly NonNullable<CommercialOcrEvalCaseResult['expectedSubtype']>[];

export const COMMERCIAL_OCR_CYRILLIC_ENFORCEMENT_GATES: CommercialOcrEvalGateProfile = {
  minTotal: 5_103,
  minAdversarialCases: 100,
  minAdversarialClusters: 60,
  minDeleteCases: 500,
  minEligibleNoActionCases: 4_603,
  minClusters: 5_103,
  minPositiveSubtypeClusters: 25,
  requiredPositiveSubtypes: REQUIRED_ENFORCING_SUBTYPES,
  maxFalseDeleteRate: 0.001,
  maxFalseDeleteUpperConfidenceBound: 0.001,
  falseDeleteConfidenceLevel: 0.99,
  minDeleteRecall: 0.95,
  minDeleteRecallLowerConfidenceBound: 0.95,
  deleteRecallConfidenceLevel: 0.95,
  maxPositiveIncompleteRate: 0.01,
  maxNegativeIncompleteRate: 0.01,
  incompleteConfidenceLevel: 0.95,
  maxUnlabeledImageScriptCases: 0,
  maxUnlabeledCaptionLanguageCases: 0,
  requiredHardNegativeCategories: REQUIRED_HARD_NEGATIVE_CATEGORIES,
  maxHardNegativeFalseDeletes: 0,
  minQualityCases: 500,
  minAttemptedPasses: 1_000,
  minCharacterReferenceLength: 10_000,
  minWordReferenceLength: 4_000,
  minCriticalTokens: 1_000,
  minConfidenceObservations: 1_000,
  minHighConfidencePasses: 900,
  minCriticalTokenRecall: 0.95,
  maxCharacterErrorRate: 0.25,
  maxWordErrorRate: 0.4,
  maxMeanAbsoluteConfidenceCalibrationError: 0.2,
  maxHighConfidenceSevereErrorRate: 0.01,
  minPerformanceSourceCases: 1_000,
  minPerformanceOcrPasses: 2_000,
  minPerformancePassCoverage: 1,
  maxOcrPassP95Ms: 5_000,
  maxOcrPassP99Ms: 8_000,
  maxOcrPassMs: 14_500,
  maxSourceCaseP95Ms: 12_000,
  maxSourceCaseP99Ms: 18_000,
  minThroughputImagesPerMinute: 4,
  maxDeadlineUtilization: 0.8,
};

export const COMMERCIAL_OCR_RU_ENFORCEMENT_GATES = COMMERCIAL_OCR_CYRILLIC_ENFORCEMENT_GATES;

export type CommercialOcrEvalGateResult = {
  passed: boolean;
  failures: string[];
  profileSha256: string;
  metrics: {
    certificationCases: number;
    adversarialCases: number;
    adversarialClusters: number;
    commercialFalseDeletes: number;
    enforcementFalseDeletes: number;
    performance: CommercialOcrEvalPerformance;
    profiles: Record<string, CommercialOcrEvalProfileGateMetrics>;
  };
};

export type CommercialOcrEvalProfileGateMetrics = {
  representativeCases: number;
  eligibleNoActionCases: number;
  excludedNoActionCases: number;
  negativeClusters: number;
  positiveClusters: number;
  falseDeletes: number;
  falseDeleteRate: number;
  falseDeleteUpperConfidenceBound: number;
  successfulDeletes: number;
  deleteRecall: number;
  deleteRecallLowerConfidenceBound: number;
  positiveIncomplete: number;
  negativeIncomplete: number;
  positiveIncompleteUpperConfidenceBound: number;
  negativeIncompleteUpperConfidenceBound: number;
  qualityCases: number;
  quality: CommercialOcrEvalQualityMetrics;
};

export function evaluateCommercialOcrEvalGates(
  report: CommercialOcrEvalReport,
  profile: CommercialOcrEvalGateProfile = COMMERCIAL_OCR_CYRILLIC_ENFORCEMENT_GATES,
): CommercialOcrEvalGateResult {
  const failures: string[] = [];
  validateCertificationProvenance(report.provenance, failures);
  validateCertificationCorpusProvenance(report, failures);
  if (report.corpusSchemaVersion !== 2) {
    failures.push('Enforcement certification requires corpus schema v2');
  }

  const certificationCases = report.cases.filter(
    (item) => item.split === 'holdout' || item.split === 'adversarial',
  );
  validateCertificationPerformance(report, profile, certificationCases, failures);
  const representatives = certificationCases.filter(
    (item) => item.split === 'holdout' && item.statisticsRepresentative,
  );
  const profileIds = [...new Set(certificationCases.map((item) => item.settingsProfileId))].sort(
    (left, right) => left.localeCompare(right),
  );
  requireMinimum(failures, 'Certified settings profiles', profileIds.length, 1);
  validateProfileIndependentQuality(certificationCases, failures);

  const commercialFalseDeletes = certificationCases.filter(
    (item) =>
      item.expectedCommercialAction === 'NO_ACTION' && item.actualCommercialAction === 'DELETE',
  );
  const enforcementFalseDeletes = certificationCases.filter(
    (item) =>
      item.expectedEnforcementAction === 'NO_ACTION' && item.actualEnforcementAction === 'DELETE',
  );
  requireMaximum(
    failures,
    'Certification commercial false DELETE cases',
    commercialFalseDeletes.length,
    0,
  );
  requireMaximum(
    failures,
    'All-script enforcement false DELETE cases',
    enforcementFalseDeletes.length,
    0,
  );
  const adversarialCaseCount = new Set(
    certificationCases
      .filter((item) => item.split === 'adversarial')
      .map((item) => item.sourceCaseId),
  ).size;
  const adversarialClusterCount = new Set(
    certificationCases.filter((item) => item.split === 'adversarial').map((item) => item.clusterId),
  ).size;
  requireMinimum(failures, 'Adversarial cases', adversarialCaseCount, profile.minAdversarialCases);
  requireMinimum(
    failures,
    'Adversarial independent clusters',
    adversarialClusterCount,
    profile.minAdversarialClusters,
  );
  requireMaximum(
    failures,
    'Adversarial expectation mismatches',
    certificationCases.filter((item) => item.split === 'adversarial' && !item.passed).length,
    0,
  );
  requireMaximum(
    failures,
    'Commercial subtype mismatches',
    certificationCases.filter(
      (item) =>
        item.actualCommercialAction === 'DELETE' && item.actualSubtype !== item.expectedSubtype,
    ).length,
    0,
  );
  requireMaximum(
    failures,
    'Unlabeled image-script certification cases',
    certificationCases.filter(
      (item) => !item.imageTextScripts || item.imageTextScripts.length === 0,
    ).length,
    profile.maxUnlabeledImageScriptCases,
  );
  requireMaximum(
    failures,
    'Unlabeled caption-language certification cases',
    certificationCases.filter((item) => item.captionLanguage === undefined).length,
    profile.maxUnlabeledCaptionLanguageCases,
  );

  const hardNegativeCases = certificationCases.filter(
    (item) =>
      item.expectedCommercialAction === 'NO_ACTION' &&
      item.cyrillicGroundTruthEligible &&
      item.hardNegativeCategory !== undefined,
  );
  requireMaximum(
    failures,
    'Hard-negative commercial false deletes',
    hardNegativeCases.filter((item) => item.actualCommercialAction === 'DELETE').length,
    profile.maxHardNegativeFalseDeletes,
  );

  const profileMetrics: Record<string, CommercialOcrEvalProfileGateMetrics> = {};
  let representativeSourceSignature: string | null = null;
  let adversarialSourceSignature: string | null = null;
  for (const profileId of profileIds) {
    const profileCases = representatives.filter((item) => item.settingsProfileId === profileId);
    const profileCertificationCases = certificationCases.filter(
      (item) => item.settingsProfileId === profileId,
    );
    const currentSourceSignature = profileCases
      .map((item) => item.sourceCaseId)
      .sort((left, right) => left.localeCompare(right))
      .join('\0');
    if (representativeSourceSignature === null) {
      representativeSourceSignature = currentSourceSignature;
    } else if (currentSourceSignature !== representativeSourceSignature) {
      failures.push(
        `Settings profile ${profileId} does not use the shared holdout representative set`,
      );
    }
    requireMaximum(
      failures,
      `Settings profile ${profileId} fingerprints`,
      new Set(profileCases.map((item) => item.settingsFingerprint)).size,
      1,
    );
    requireMaximum(
      failures,
      `Settings profile ${profileId} duplicate representative sources`,
      profileCases.length - new Set(profileCases.map((item) => item.sourceCaseId)).size,
      0,
    );
    const profileAdversarialCases = certificationCases.filter(
      (item) => item.split === 'adversarial' && item.settingsProfileId === profileId,
    );
    const currentAdversarialSourceSignature = profileAdversarialCases
      .map((item) => item.sourceCaseId)
      .sort((left, right) => left.localeCompare(right))
      .join('\0');
    if (adversarialSourceSignature === null) {
      adversarialSourceSignature = currentAdversarialSourceSignature;
    } else if (currentAdversarialSourceSignature !== adversarialSourceSignature) {
      failures.push(`Settings profile ${profileId} does not use the shared adversarial source set`);
    }
    requireMaximum(
      failures,
      `Settings profile ${profileId} duplicate adversarial sources`,
      profileAdversarialCases.length -
        new Set(profileAdversarialCases.map((item) => item.sourceCaseId)).size,
      0,
    );

    const label = `Settings profile ${profileId}`;
    const qualityCoverage = aggregateCommercialOcrEvalQuality(
      profileCertificationCases.flatMap((item) => (item.ocrQuality ? [item.ocrQuality] : [])),
    );
    requireMaximum(
      failures,
      `${label} missing OCR quality cases`,
      profileCertificationCases.filter((item) => item.ocrQuality === null).length,
      0,
    );
    requireMaximum(
      failures,
      `${label} OCR quality coverage-gap cases`,
      profileCertificationCases.filter(
        (item) => !item.ocrQuality || !hasExactCommercialOcrQualityCoverage(item.ocrQuality),
      ).length,
      0,
    );
    requireExactQualityCoverage(failures, label, qualityCoverage);
    const deleteCases = profileCases.filter((item) => item.expectedEnforcementAction === 'DELETE');
    const eligibleNoActionCases = profileCases.filter(
      (item) => item.expectedCommercialAction === 'NO_ACTION' && item.cyrillicGroundTruthEligible,
    );
    const statisticalCases = [...deleteCases, ...eligibleNoActionCases];
    const metrics = evaluateProfileMetrics(profileCases, profile);
    profileMetrics[profileId] = metrics;
    requireMinimum(
      failures,
      `${label} representative cases`,
      statisticalCases.length,
      profile.minTotal,
    );
    requireMinimum(failures, `${label} delete cases`, deleteCases.length, profile.minDeleteCases);
    requireMinimum(
      failures,
      `${label} eligible commercial no-action cases`,
      eligibleNoActionCases.length,
      profile.minEligibleNoActionCases,
    );
    requireMinimum(
      failures,
      `${label} distinct clusters`,
      new Set(statisticalCases.map((item) => item.clusterId)).size,
      profile.minClusters,
    );
    requireMaximum(
      failures,
      `${label} false-delete rate`,
      metrics.falseDeleteRate,
      profile.maxFalseDeleteRate,
    );
    requireMaximum(
      failures,
      `${label} false-delete upper confidence bound`,
      metrics.falseDeleteUpperConfidenceBound,
      profile.maxFalseDeleteUpperConfidenceBound,
    );
    requireMinimum(
      failures,
      `${label} delete recall`,
      metrics.deleteRecall,
      profile.minDeleteRecall,
    );
    requireMinimum(
      failures,
      `${label} delete recall lower confidence bound`,
      metrics.deleteRecallLowerConfidenceBound,
      profile.minDeleteRecallLowerConfidenceBound,
    );
    requireMaximum(
      failures,
      `${label} positive incomplete upper confidence bound`,
      metrics.positiveIncompleteUpperConfidenceBound,
      profile.maxPositiveIncompleteRate,
    );
    requireMaximum(
      failures,
      `${label} negative incomplete upper confidence bound`,
      metrics.negativeIncompleteUpperConfidenceBound,
      profile.maxNegativeIncompleteRate,
    );
    requireMinimum(
      failures,
      `${label} OCR quality cases`,
      metrics.qualityCases,
      profile.minQualityCases,
    );
    requireMinimum(
      failures,
      `${label} OCR attempted passes`,
      metrics.quality.attemptedPasses,
      profile.minAttemptedPasses,
    );
    requireMinimum(
      failures,
      `${label} OCR character reference length`,
      metrics.quality.characterReferenceLength,
      profile.minCharacterReferenceLength,
    );
    requireMinimum(
      failures,
      `${label} OCR word reference length`,
      metrics.quality.wordReferenceLength,
      profile.minWordReferenceLength,
    );
    requireMinimum(
      failures,
      `${label} OCR critical-token observations`,
      metrics.quality.criticalTokens,
      profile.minCriticalTokens,
    );
    requireMinimum(
      failures,
      `${label} OCR confidence observations`,
      metrics.quality.confidenceObservations,
      profile.minConfidenceObservations,
    );
    requireMinimum(
      failures,
      `${label} OCR high-confidence observations`,
      metrics.quality.highConfidencePasses,
      profile.minHighConfidencePasses,
    );
    requireMinimum(
      failures,
      `${label} OCR critical-token both-pass recall`,
      metrics.quality.criticalTokenRecall,
      profile.minCriticalTokenRecall,
    );
    requireMaximum(
      failures,
      `${label} OCR character error rate`,
      metrics.quality.characterErrorRate,
      profile.maxCharacterErrorRate,
    );
    requireMaximum(
      failures,
      `${label} OCR word error rate`,
      metrics.quality.wordErrorRate,
      profile.maxWordErrorRate,
    );
    requireMaximum(
      failures,
      `${label} OCR confidence calibration error`,
      metrics.quality.meanAbsoluteConfidenceCalibrationError,
      profile.maxMeanAbsoluteConfidenceCalibrationError,
    );
    requireMaximum(
      failures,
      `${label} OCR high-confidence severe-error rate`,
      metrics.quality.highConfidenceSevereErrorRate,
      profile.maxHighConfidenceSevereErrorRate,
    );

    const profileHardNegatives = eligibleNoActionCases.filter(
      (item) => item.hardNegativeCategory !== undefined,
    );
    for (const [category, categoryGate] of Object.entries(
      profile.requiredHardNegativeCategories,
    ).sort(([left], [right]) => left.localeCompare(right))) {
      const categoryCases = profileHardNegatives.filter(
        (item) => item.hardNegativeCategory === category,
      );
      requireMinimum(
        failures,
        `${label} hard-negative ${category} cases`,
        categoryCases.length,
        categoryGate.minCases,
      );
      requireMinimum(
        failures,
        `${label} hard-negative ${category} distinct clusters`,
        new Set(categoryCases.map((item) => item.clusterId)).size,
        categoryGate.minClusters,
      );
    }
    for (const subtype of profile.requiredPositiveSubtypes) {
      const subtypeCases = deleteCases.filter((item) => item.expectedSubtype === subtype);
      requireMinimum(
        failures,
        `${label} enforcing subtype ${subtype} positive clusters`,
        new Set(subtypeCases.map((item) => item.clusterId)).size,
        profile.minPositiveSubtypeClusters,
      );
    }
  }

  return {
    passed: failures.length === 0,
    failures,
    profileSha256: calculateCommercialOcrEvalCanonicalSha256(profile),
    metrics: {
      certificationCases: new Set(certificationCases.map((item) => item.sourceCaseId)).size,
      adversarialCases: adversarialCaseCount,
      adversarialClusters: adversarialClusterCount,
      commercialFalseDeletes: commercialFalseDeletes.length,
      enforcementFalseDeletes: enforcementFalseDeletes.length,
      performance: report.performance,
      profiles: profileMetrics,
    },
  };
}

function validateCertificationPerformance(
  report: CommercialOcrEvalReport,
  profile: CommercialOcrEvalGateProfile,
  certificationCases: readonly CommercialOcrEvalCaseResult[],
  failures: string[],
): void {
  const performanceReport = report.performance;
  requireExact(
    failures,
    'Certification performance measurement version is unsupported',
    performanceReport?.measurementVersion,
    COMMERCIAL_OCR_EVAL_PERFORMANCE_MEASUREMENT_VERSION,
  );
  requireExact(
    failures,
    'Certification performance evaluation concurrency must be exactly one',
    performanceReport?.evalConcurrency,
    1,
  );
  requireExact(
    failures,
    'Certification performance concurrency is inconsistent with execution provenance',
    performanceReport?.evalConcurrency,
    valueAt(report.provenance, ['tesseract', 'resourceLimits', 'evalConcurrency']),
  );

  const benchmark = report.provenance.benchmarkEnvironment;
  requireExact(
    failures,
    'Certification benchmark environment profile is unsupported',
    benchmark?.profileId,
    COMMERCIAL_OCR_BENCHMARK_ENVIRONMENT_PROFILE_ID,
  );
  const descriptorSha256 = benchmark?.descriptorSha256;
  requirePattern(
    failures,
    'Certification benchmark environment SHA-256 must be canonical lowercase hex',
    descriptorSha256,
    LOWER_SHA_256_PATTERN,
  );
  if (
    !benchmark?.descriptor ||
    calculateCommercialOcrEvalCanonicalSha256(benchmark.descriptor) !== descriptorSha256
  ) {
    failures.push('Certification benchmark environment descriptor digest is inconsistent');
  }
  if (benchmark?.reviewedDescriptorSha256 !== descriptorSha256) {
    failures.push('Certification benchmark environment was not bound to a reviewed descriptor');
  }
  if (performanceReport?.benchmarkEnvironmentSha256 !== descriptorSha256) {
    failures.push('Certification performance results use a different benchmark environment');
  }

  const sourceImages = new Map<string, number>();
  for (const item of certificationCases) {
    const imageCount = item.imageTextScripts?.length ?? 0;
    const previous = sourceImages.get(item.sourceCaseId);
    if (previous !== undefined && previous !== imageCount) {
      failures.push('Certification performance source image counts are inconsistent');
      break;
    }
    sourceImages.set(item.sourceCaseId, imageCount);
  }
  const sourceCases = sourceImages.size;
  const images = [...sourceImages.values()].reduce((total, value) => total + value, 0);
  const expectedOcrPasses = images * 2;
  const measured = performanceReport?.certification;
  requireExactCount(
    failures,
    'Certification performance source cases',
    measured?.sourceCases ?? Number.NaN,
    sourceCases,
  );
  requireExactCount(
    failures,
    'Certification performance source images',
    measured?.images ?? Number.NaN,
    images,
  );
  requireExactCount(
    failures,
    'Certification expected OCR performance passes',
    measured?.expectedOcrPasses ?? Number.NaN,
    expectedOcrPasses,
  );
  requireMinimum(
    failures,
    'Certification measured performance source cases',
    measured?.sourceCases ?? Number.NaN,
    profile.minPerformanceSourceCases,
  );
  requireMinimum(
    failures,
    'Certification measured OCR performance passes',
    measured?.attemptedOcrPasses ?? Number.NaN,
    profile.minPerformanceOcrPasses,
  );
  requireMinimum(
    failures,
    'Certification OCR performance pass coverage',
    measured?.passCoverage ?? Number.NaN,
    profile.minPerformancePassCoverage,
  );

  const passSamples = measured?.ocrPassSamplesMs;
  const caseSamples = measured?.sourceCaseSamplesMs;
  if (!Array.isArray(passSamples) || !Array.isArray(caseSamples)) {
    failures.push('Certification performance samples are unavailable');
    return;
  }
  try {
    const passDistribution = summarizeCommercialOcrEvalDurationSamples(passSamples);
    const caseDistribution = summarizeCommercialOcrEvalDurationSamples(caseSamples);
    if (
      !isDeepStrictEqual(passDistribution, measured.ocrPassDurationMs) ||
      !isDeepStrictEqual(caseDistribution, measured.sourceCaseDurationMs)
    ) {
      failures.push('Certification performance distributions are inconsistent with raw samples');
    }
  } catch {
    failures.push('Certification performance samples are invalid');
  }
  requireExactCount(
    failures,
    'Certification attempted OCR performance passes',
    measured.attemptedOcrPasses,
    passSamples.length,
  );
  requireExactCount(
    failures,
    'Certification source-case performance samples',
    caseSamples.length,
    sourceCases,
  );
  requireExact(
    failures,
    'Certification OCR performance pass coverage is inconsistent',
    measured.passCoverage,
    roundPerformanceRate(passSamples.length / Math.max(1, expectedOcrPasses)),
  );
  const measuredDurationMs = roundPerformanceMs(
    caseSamples.reduce((total, value) => total + value, 0),
  );
  requireExact(
    failures,
    'Certification source-case performance duration is inconsistent',
    measured.durationMs,
    measuredDurationMs,
  );
  const passDeadlineMs =
    Number(valueAt(report.provenance, ['tesseract', 'resourceLimits', 'timeoutMs'])) +
    Number(
      valueAt(report.provenance, [
        'tesseract',
        'resourceLimits',
        'sharpProcessingTimeoutSeconds',
      ]),
    ) *
      1_000;
  const deadlineBudgetMs = expectedOcrPasses * passDeadlineMs;
  requireExact(
    failures,
    'Certification performance deadline budget is inconsistent',
    measured.deadlineBudgetMs,
    deadlineBudgetMs,
  );
  requireExact(
    failures,
    'Certification performance deadline utilization is inconsistent',
    measured.deadlineUtilization,
    deadlineBudgetMs > 0 ? roundPerformanceRate(measuredDurationMs / deadlineBudgetMs) : 0,
  );
  requireMaximum(
    failures,
    'Certification OCR pass p95 latency (ms)',
    measured.ocrPassDurationMs.p95 ?? Number.NaN,
    profile.maxOcrPassP95Ms,
  );
  requireMaximum(
    failures,
    'Certification OCR pass p99 latency (ms)',
    measured.ocrPassDurationMs.p99 ?? Number.NaN,
    profile.maxOcrPassP99Ms,
  );
  requireMaximum(
    failures,
    'Certification OCR pass maximum latency (ms)',
    measured.ocrPassDurationMs.maximum ?? Number.NaN,
    profile.maxOcrPassMs,
  );
  requireMaximum(
    failures,
    'Certification source-case p95 latency (ms)',
    measured.sourceCaseDurationMs.p95 ?? Number.NaN,
    profile.maxSourceCaseP95Ms,
  );
  requireMaximum(
    failures,
    'Certification source-case p99 latency (ms)',
    measured.sourceCaseDurationMs.p99 ?? Number.NaN,
    profile.maxSourceCaseP99Ms,
  );
  const expectedThroughput =
    images > 0 && measuredDurationMs > 0
      ? roundPerformanceRate((images * 60_000) / measuredDurationMs)
      : Number.NaN;
  requireExact(
    failures,
    'Certification image throughput is inconsistent',
    measured.throughputImagesPerMinute,
    expectedThroughput,
  );
  requireMinimum(
    failures,
    'Certification image throughput per minute',
    measured.throughputImagesPerMinute ?? Number.NaN,
    profile.minThroughputImagesPerMinute,
  );
  requireMaximum(
    failures,
    'Certification runtime deadline utilization',
    measured.deadlineUtilization,
    profile.maxDeadlineUtilization,
  );
}

function roundPerformanceMs(value: number): number {
  return Math.max(0, Math.round(value * 100) / 100);
}

function roundPerformanceRate(value: number): number {
  return Math.max(0, Math.round(value * 1_000_000) / 1_000_000);
}

function validateCertificationProvenance(provenance: unknown, failures: string[]): void {
  const gitCommit = valueAt(provenance, ['run', 'git', 'commit']);
  const sourceSha = valueAt(provenance, ['artifact', 'sourceSha']);
  const immutableImageSha256 = valueAt(provenance, ['artifact', 'immutableImageSha256']);
  const clean = valueAt(provenance, ['run', 'git', 'dirty']) === false;
  const gitCommitValid = requirePattern(
    failures,
    'Certification Git commit must be a canonical lowercase 40-character SHA',
    gitCommit,
    LOWER_GIT_SHA_PATTERN,
  );
  const sourceShaValid = requirePattern(
    failures,
    'Certification source SHA must be a canonical lowercase 40-character SHA',
    sourceSha,
    LOWER_GIT_SHA_PATTERN,
  );
  const immutableImageShaValid = requirePattern(
    failures,
    'Certification immutable image SHA-256 must be canonical lowercase hex',
    immutableImageSha256,
    LOWER_SHA_256_PATTERN,
  );
  if (!clean) {
    failures.push('Certification requires a clean Git worktree');
  }
  if (gitCommitValid && sourceShaValid && gitCommit !== sourceSha) {
    failures.push('Certification source SHA must match the evaluated Git commit');
  }

  requirePattern(
    failures,
    'Certification manifest SHA-256 must be canonical lowercase hex',
    valueAt(provenance, ['artifact', 'manifestSha256']),
    LOWER_SHA_256_PATTERN,
  );

  const fingerprintPaths = [
    ['fingerprints', 'ocr'] as const,
    ['fingerprints', 'policy'] as const,
    ['fingerprints', 'preprocess'] as const,
    ['fingerprints', 'detector'] as const,
    ['run', 'detector'] as const,
    ['run', 'auditTool'] as const,
  ];
  const fingerprintLabels = [
    'OCR',
    'policy',
    'preprocess',
    'detector',
    'run detector',
    'audit tool',
  ] as const;
  let usesVersionDescriptor = false;
  for (let index = 0; index < fingerprintPaths.length; index += 1) {
    const path = fingerprintPaths[index]!;
    const label = fingerprintLabels[index]!;
    requirePattern(
      failures,
      `Certification ${label} fingerprint SHA-256 must be canonical lowercase hex`,
      valueAt(provenance, [...path, 'sourceSha256']),
      LOWER_SHA_256_PATTERN,
    );
    const digestKind = valueAt(provenance, [...path, 'digestKind']);
    if (digestKind !== 'SOURCE_FILES' && digestKind !== 'VERSION_DESCRIPTOR') {
      failures.push(`Certification ${label} fingerprint digest kind is invalid`);
    }
    if (digestKind === 'VERSION_DESCRIPTOR') usesVersionDescriptor = true;
  }
  if (
    usesVersionDescriptor &&
    (!immutableImageShaValid ||
      !sourceShaValid ||
      !gitCommitValid ||
      !clean ||
      sourceSha !== gitCommit)
  ) {
    failures.push(
      'VERSION_DESCRIPTOR fingerprints require an immutable image bound to the clean source commit',
    );
  }

  requireExact(
    failures,
    'Certification OCR version identity does not match the current runtime',
    valueAt(provenance, ['fingerprints', 'ocr', 'version']),
    COMMERCIAL_OCR_DEFAULT_VERSION,
  );
  requireExact(
    failures,
    'Certification policy version identity does not match the current runtime',
    valueAt(provenance, ['fingerprints', 'policy', 'version']),
    COMMERCIAL_OCR_DECISION_POLICY_VERSION,
  );
  requireExact(
    failures,
    'Certification primary preprocess identity does not match the current runtime',
    valueAt(provenance, ['fingerprints', 'preprocess', 'profiles', 'primary']),
    COMMERCIAL_OCR_PREPROCESS_PROFILES.primary,
  );
  requireExact(
    failures,
    'Certification confirmation preprocess identity does not match the current runtime',
    valueAt(provenance, ['fingerprints', 'preprocess', 'profiles', 'confirmation']),
    COMMERCIAL_OCR_PREPROCESS_PROFILES.confirmation,
  );

  for (const detectorPath of [
    ['fingerprints', 'detector'] as const,
    ['run', 'detector'] as const,
  ]) {
    requireExact(
      failures,
      'Certification detector decision identity does not match the current runtime',
      valueAt(provenance, [...detectorPath, 'decisionVersion']),
      COMMERCIAL_ENGINE_CONFIG.decisionVersion,
    );
    requireExact(
      failures,
      'Certification detector pattern identity does not match the current runtime',
      valueAt(provenance, [...detectorPath, 'patternPolicyVersion']),
      COMMERCIAL_ENGINE_CONFIG.patternPolicyVersion,
    );
    requireExact(
      failures,
      'Certification detector classifier identity does not match the current runtime',
      valueAt(provenance, [...detectorPath, 'classifierVersion']),
      COMMERCIAL_SECOND_STAGE_VERSION,
    );
  }
  for (const property of [
    'digestKind',
    'sourceSha256',
    'decisionVersion',
    'patternPolicyVersion',
    'classifierVersion',
  ] as const) {
    if (
      valueAt(provenance, ['fingerprints', 'detector', property]) !==
      valueAt(provenance, ['run', 'detector', property])
    ) {
      failures.push('Certification detector fingerprints are internally inconsistent');
      break;
    }
  }

  const behaviorFingerprint = valueAt(provenance, ['behaviorIdentity', 'fingerprintSha256']);
  const nativeFingerprint = valueAt(provenance, [
    'behaviorIdentity',
    'nativeFingerprintSha256',
  ]);
  requirePattern(
    failures,
    'Certification behavior identity SHA-256 must be canonical lowercase hex',
    behaviorFingerprint,
    LOWER_SHA_256_PATTERN,
  );
  requirePattern(
    failures,
    'Certification native behavior identity SHA-256 must be canonical lowercase hex',
    nativeFingerprint,
    LOWER_SHA_256_PATTERN,
  );
  if (
    valueAt(provenance, ['behaviorIdentity', 'nativeVerification', 'verified']) !== true ||
    valueAt(provenance, ['behaviorIdentity', 'nativeVerification', 'status']) !== 'verified' ||
    !isDeepStrictEqual(
      valueAt(provenance, ['behaviorIdentity', 'nativeVerification', 'mismatches']),
      [],
    )
  ) {
    failures.push('Certification native artifacts must match the active image build manifest');
  }
  const behaviorDescriptor = valueAt(provenance, ['behaviorIdentity', 'descriptor']);
  const nativeManifest = valueAt(behaviorDescriptor, ['native']);
  try {
    if (
      resolveCommercialOcrBehaviorIdentity(
        behaviorDescriptor as CommercialOcrBehaviorDescriptor,
      ).fingerprintSha256 !== behaviorFingerprint
    ) {
      failures.push('Certification behavior identity fingerprint is internally inconsistent');
    }
    if (
      fingerprintCommercialOcrNativeBehaviorManifest(
        nativeManifest as CommercialOcrNativeBehaviorManifest,
      ) !== nativeFingerprint
    ) {
      failures.push('Certification native behavior fingerprint is internally inconsistent');
    }
  } catch {
    failures.push('Certification behavior identity descriptor is invalid');
  }

  const nodeVersion = valueAt(provenance, ['runtime', 'nodeVersion']);
  if (typeof nodeVersion !== 'string' || !NODE_24_VERSION_PATTERN.test(nodeVersion)) {
    failures.push('Certification runtime must use Node 24');
  }
  if (valueAt(provenance, ['run', 'runtime', 'nodeVersion']) !== nodeVersion) {
    failures.push('Certification Node runtime identities are internally inconsistent');
  }
  requireExact(
    failures,
    'Certification runtime must use the production Sharp version',
    valueAt(provenance, ['runtime', 'sharpVersion']),
    CERTIFICATION_RUNTIME_VERSIONS.sharp,
  );
  requireExact(
    failures,
    'Certification runtime must use the production libvips version',
    valueAt(provenance, ['runtime', 'libvipsVersion']),
    CERTIFICATION_RUNTIME_VERSIONS.libvips,
  );
  requireExact(
    failures,
    'Certification runtime must use the production Tesseract version',
    valueAt(provenance, ['runtime', 'tesseractVersion']),
    CERTIFICATION_RUNTIME_VERSIONS.tesseract,
  );

  const languages = valueAt(provenance, ['tesseract', 'languages']);
  if (
    !Array.isArray(languages) ||
    languages.length !== 2 ||
    languages[0] !== 'rus' ||
    languages[1] !== 'eng'
  ) {
    failures.push('Certification OCR language order must be exactly rus+eng');
  }
  const availableLanguages = valueAt(provenance, ['tesseract', 'availableLanguages']);
  if (
    !Array.isArray(availableLanguages) ||
    !availableLanguages.includes('rus') ||
    !availableLanguages.includes('eng')
  ) {
    failures.push('Certification Tesseract inventory must include rus and eng');
  }
  const sourceFormats = valueAt(provenance, ['sourceImages', 'allowedFormats']);
  if (
    !Array.isArray(sourceFormats) ||
    sourceFormats.length !== SUPPORTED_PHOTO_IMAGE_FORMATS.length ||
    !sourceFormats.every((format, index) => format === SUPPORTED_PHOTO_IMAGE_FORMATS[index])
  ) {
    failures.push('Certification source image formats must match the runtime raster allowlist');
  }
  for (const language of ['rus', 'eng'] as const) {
    requirePattern(
      failures,
      `Certification ${language}.traineddata SHA-256 must be canonical lowercase hex`,
      valueAt(provenance, ['tesseract', 'traineddataSha256', language]),
      LOWER_SHA_256_PATTERN,
    );
  }

  requireExact(
    failures,
    'Certification Tesseract OEM must be 1',
    valueAt(provenance, ['tesseract', 'oem']),
    1,
  );
  requireExact(
    failures,
    'Certification primary Tesseract PSM must be 11',
    valueAt(provenance, ['tesseract', 'psm', 'primary']),
    11,
  );
  requireExact(
    failures,
    'Certification confirmation Tesseract PSM must be 6',
    valueAt(provenance, ['tesseract', 'psm', 'confirmation']),
    6,
  );
  for (const [name, expected] of Object.entries(CERTIFICATION_RESOURCE_LIMITS)) {
    requireExact(
      failures,
      `Certification ${name} must match the production OCR resource profile`,
      valueAt(provenance, ['tesseract', 'resourceLimits', name]),
      expected,
    );
  }
  const nativeControlNames: Readonly<Record<string, string>> = {
    timeoutMs: 'timeoutMs',
    maxSourceImageBytes: 'maxSourceImageBytes',
    maxImageBytes: 'maxImageBytes',
    maxOutputBytes: 'maxOutputBytes',
    maxInputPixels: 'maxInputPixels',
    maxOutputPixels: 'maxOutputPixels',
    maxSide: 'maxSide',
    ompThreadLimit: 'ompThreadLimit',
    nativeConcurrency: 'concurrency',
    nativeMaxQueue: 'maxQueue',
    nativeRecycleAfterJobs: 'recycleAfterJobs',
    sharpConcurrency: 'sharpConcurrency',
    sharpProcessingTimeoutSeconds: 'sharpProcessingTimeoutSeconds',
  };
  for (const [resourceName, controlName] of Object.entries(nativeControlNames)) {
    if (
      valueAt(provenance, ['tesseract', 'resourceLimits', resourceName]) !==
      valueAt(nativeManifest, ['controls', controlName])
    ) {
      failures.push(`Certification ${resourceName} is inconsistent with native behavior identity`);
    }
  }
  for (const [legacyPath, nativePath] of [
    [['runtime', 'nodeVersion'], ['artifacts', 'runtime', 'nodeVersion']],
    [['runtime', 'sharpVersion'], ['artifacts', 'runtime', 'sharpVersion']],
    [['runtime', 'libvipsVersion'], ['artifacts', 'runtime', 'libvipsVersion']],
    [['runtime', 'tesseractVersion'], ['artifacts', 'tesseract', 'version']],
    [['tesseract', 'binarySha256'], ['artifacts', 'tesseract', 'binarySha256']],
    [
      ['tesseract', 'traineddataSha256'],
      ['artifacts', 'tesseract', 'traineddataSha256'],
    ],
    [['tesseract', 'availableLanguages'], ['artifacts', 'tesseract', 'availableLanguages']],
    [['sourceImages'], ['sourceImages']],
  ] as const) {
    if (!isDeepStrictEqual(valueAt(provenance, legacyPath), valueAt(nativeManifest, nativePath))) {
      failures.push('Certification native behavior artifacts are internally inconsistent');
      break;
    }
  }
}

function validateCertificationCorpusProvenance(
  report: CommercialOcrEvalReport,
  failures: string[],
): void {
  const provenance = report.corpusProvenance;
  if (!provenance) {
    failures.push('Enforcement certification requires verified corpus provenance');
    return;
  }
  requireExact(
    failures,
    'Certification corpus must use production-temporal real images',
    provenance.sourceKind,
    'production_temporal',
  );
  requireExact(
    failures,
    'Certification collection protocol is unsupported',
    provenance.collectionProtocolVersion,
    COMMERCIAL_OCR_CERTIFICATION_COLLECTION_PROTOCOL_VERSION,
  );
  requireExact(
    failures,
    'Certification annotation protocol is unsupported',
    provenance.annotationProtocolVersion,
    COMMERCIAL_OCR_CERTIFICATION_ANNOTATION_PROTOCOL_VERSION,
  );
  const collectionDigestValid = requirePattern(
    failures,
    'Certification collection artifact SHA-256 must be canonical lowercase hex',
    provenance.collectionArtifactSha256,
    LOWER_SHA_256_PATTERN,
  );
  const adjudicationDigestValid = requirePattern(
    failures,
    'Certification adjudication artifact SHA-256 must be canonical lowercase hex',
    provenance.adjudicationArtifactSha256,
    LOWER_SHA_256_PATTERN,
  );
  if (
    collectionDigestValid &&
    adjudicationDigestValid &&
    provenance.collectionArtifactSha256 === provenance.adjudicationArtifactSha256
  ) {
    failures.push('Certification collection and adjudication artifacts must be distinct');
  }

  const windowStartedAt = certificationTimestamp(
    failures,
    'Certification collection window start is invalid',
    provenance.windowStartedAt,
  );
  const windowEndedAt = certificationTimestamp(
    failures,
    'Certification collection window end is invalid',
    provenance.windowEndedAt,
  );
  const frozenAt = certificationTimestamp(
    failures,
    'Certification corpus freeze timestamp is invalid',
    provenance.frozenAt,
  );
  const generatedAt = certificationTimestamp(
    failures,
    'Certification report timestamp is invalid',
    report.generatedAt,
  );
  if (windowStartedAt !== null && windowEndedAt !== null) {
    const collectionWindowMs = windowEndedAt - windowStartedAt;
    if (collectionWindowMs < COMMERCIAL_OCR_CERTIFICATION_MIN_COLLECTION_WINDOW_MS) {
      failures.push('Certification collection window must cover at least 7 days');
    }
    if (collectionWindowMs <= 0) {
      failures.push('Certification collection window must be ordered');
    }
  }
  if (windowEndedAt !== null && frozenAt !== null) {
    const freezeLagMs = frozenAt - windowEndedAt;
    if (freezeLagMs < 0 || freezeLagMs > COMMERCIAL_OCR_CERTIFICATION_MAX_FREEZE_LAG_MS) {
      failures.push('Certification corpus must be frozen within 30 days after collection');
    }
  }
  if (windowEndedAt !== null && generatedAt !== null) {
    const corpusAgeMs = generatedAt - windowEndedAt;
    if (corpusAgeMs < 0 || corpusAgeMs > COMMERCIAL_OCR_CERTIFICATION_MAX_CORPUS_AGE_MS) {
      failures.push('Certification corpus collection must end within 90 days of evaluation');
    }
  }
  if (frozenAt !== null && generatedAt !== null && frozenAt > generatedAt) {
    failures.push('Certification corpus freeze must not be later than the report');
  }
}

function certificationTimestamp(
  failures: string[],
  message: string,
  value: unknown,
): number | null {
  if (typeof value !== 'string') {
    failures.push(message);
    return null;
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    failures.push(message);
    return null;
  }
  return timestamp;
}

function valueAt(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const key of path) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requirePattern(
  failures: string[],
  message: string,
  value: unknown,
  pattern: RegExp,
): boolean {
  const passed = typeof value === 'string' && pattern.test(value);
  if (!passed) failures.push(message);
  return passed;
}

function requireExact(
  failures: string[],
  message: string,
  actual: unknown,
  expected: unknown,
): void {
  if (actual !== expected) failures.push(message);
}

function evaluateProfileMetrics(
  cases: readonly CommercialOcrEvalCaseResult[],
  profile: CommercialOcrEvalGateProfile,
): CommercialOcrEvalProfileGateMetrics {
  const deleteCases = cases.filter((item) => item.expectedEnforcementAction === 'DELETE');
  const eligibleNoActionCases = cases.filter(
    (item) => item.expectedCommercialAction === 'NO_ACTION' && item.cyrillicGroundTruthEligible,
  );
  const excludedNoActionCases = cases.filter(
    (item) => item.expectedCommercialAction === 'NO_ACTION' && !item.cyrillicGroundTruthEligible,
  );
  const falseDeletes = eligibleNoActionCases.filter(
    (item) => item.actualEnforcementAction === 'DELETE',
  ).length;
  const successfulDeletes = deleteCases.filter(
    (item) => item.actualEnforcementAction === 'DELETE',
  ).length;
  const positiveIncomplete = deleteCases.filter(
    (item) => item.actualEnforcementAction === 'INCOMPLETE',
  ).length;
  const negativeIncomplete = eligibleNoActionCases.filter(
    (item) => item.actualEnforcementAction === 'INCOMPLETE',
  ).length;
  const qualityCases = deleteCases.flatMap((item) => (item.ocrQuality ? [item.ocrQuality] : []));
  return {
    representativeCases: deleteCases.length + eligibleNoActionCases.length,
    eligibleNoActionCases: eligibleNoActionCases.length,
    excludedNoActionCases: excludedNoActionCases.length,
    negativeClusters: new Set(eligibleNoActionCases.map((item) => item.clusterId)).size,
    positiveClusters: new Set(deleteCases.map((item) => item.clusterId)).size,
    falseDeletes,
    falseDeleteRate: ratio(falseDeletes, eligibleNoActionCases.length),
    falseDeleteUpperConfidenceBound: oneSidedClopperPearsonUpper(
      falseDeletes,
      eligibleNoActionCases.length,
      profile.falseDeleteConfidenceLevel,
    ),
    successfulDeletes,
    deleteRecall: ratio(successfulDeletes, deleteCases.length),
    deleteRecallLowerConfidenceBound: oneSidedClopperPearsonLower(
      successfulDeletes,
      deleteCases.length,
      profile.deleteRecallConfidenceLevel,
    ),
    positiveIncomplete,
    negativeIncomplete,
    positiveIncompleteUpperConfidenceBound: oneSidedClopperPearsonUpper(
      positiveIncomplete,
      deleteCases.length,
      profile.incompleteConfidenceLevel,
    ),
    negativeIncompleteUpperConfidenceBound: oneSidedClopperPearsonUpper(
      negativeIncomplete,
      eligibleNoActionCases.length,
      profile.incompleteConfidenceLevel,
    ),
    qualityCases: qualityCases.length,
    quality: aggregateCommercialOcrEvalQuality(qualityCases),
  };
}

function hasExactCommercialOcrQualityCoverage(quality: CommercialOcrEvalQualityMetrics): boolean {
  const counts = [
    quality.expectedPasses,
    quality.attemptedPasses,
    quality.failedPasses,
    quality.expectedPrimaryPasses,
    quality.attemptedPrimaryPasses,
    quality.failedPrimaryPasses,
    quality.expectedConfirmationPasses,
    quality.attemptedConfirmationPasses,
    quality.failedConfirmationPasses,
  ];
  return (
    counts.every((value) => Number.isSafeInteger(value) && value >= 0) &&
    quality.expectedPrimaryPasses > 0 &&
    quality.expectedPrimaryPasses === quality.expectedConfirmationPasses &&
    quality.expectedPasses === quality.expectedPrimaryPasses + quality.expectedConfirmationPasses &&
    quality.attemptedPasses ===
      quality.attemptedPrimaryPasses + quality.attemptedConfirmationPasses &&
    quality.failedPasses === quality.failedPrimaryPasses + quality.failedConfirmationPasses &&
    quality.attemptedPasses === quality.expectedPasses &&
    quality.attemptedPrimaryPasses === quality.expectedPrimaryPasses &&
    quality.attemptedConfirmationPasses === quality.expectedConfirmationPasses &&
    quality.failedPasses === 0 &&
    quality.failedPrimaryPasses === 0 &&
    quality.failedConfirmationPasses === 0
  );
}

function validateProfileIndependentQuality(
  cases: readonly CommercialOcrEvalCaseResult[],
  failures: string[],
): void {
  const signatures = new Map<string, string>();
  let mismatches = 0;
  for (const item of cases) {
    const signature = item.ocrQuality
      ? calculateCommercialOcrEvalCanonicalSha256(item.ocrQuality)
      : 'missing';
    const expected = signatures.get(item.sourceCaseId);
    if (expected === undefined) {
      signatures.set(item.sourceCaseId, signature);
    } else if (expected !== signature) {
      mismatches += 1;
    }
  }
  requireMaximum(failures, 'Profile-independent OCR quality mismatches', mismatches, 0);
}

function requireExactQualityCoverage(
  failures: string[],
  label: string,
  quality: CommercialOcrEvalQualityMetrics,
): void {
  requireExactCount(
    failures,
    `${label} OCR overall attempted coverage`,
    quality.attemptedPasses,
    quality.expectedPasses,
  );
  requireExactCount(
    failures,
    `${label} OCR primary attempted coverage`,
    quality.attemptedPrimaryPasses,
    quality.expectedPrimaryPasses,
  );
  requireExactCount(
    failures,
    `${label} OCR confirmation attempted coverage`,
    quality.attemptedConfirmationPasses,
    quality.expectedConfirmationPasses,
  );
  requireMaximum(failures, `${label} OCR failed passes`, quality.failedPasses, 0);
  requireMaximum(failures, `${label} OCR failed primary passes`, quality.failedPrimaryPasses, 0);
  requireMaximum(
    failures,
    `${label} OCR failed confirmation passes`,
    quality.failedConfirmationPasses,
    0,
  );
}

export function oneSidedClopperPearsonUpper(
  successes: number,
  trials: number,
  confidenceLevel: number,
): number {
  assertBinomialArguments(successes, trials, confidenceLevel);
  if (trials === 0) return Number.NaN;
  if (successes === trials) return 1;
  return inverseRegularizedBeta(confidenceLevel, successes + 1, trials - successes);
}

export function oneSidedClopperPearsonLower(
  successes: number,
  trials: number,
  confidenceLevel: number,
): number {
  assertBinomialArguments(successes, trials, confidenceLevel);
  if (trials === 0) return Number.NaN;
  if (successes === 0) return 0;
  return inverseRegularizedBeta(1 - confidenceLevel, successes, trials - successes + 1);
}

function inverseRegularizedBeta(probability: number, alpha: number, beta: number): number {
  let lower = 0;
  let upper = 1;
  for (let iteration = 0; iteration < 80; iteration += 1) {
    const midpoint = (lower + upper) / 2;
    if (regularizedBeta(midpoint, alpha, beta) < probability) lower = midpoint;
    else upper = midpoint;
  }
  return (lower + upper) / 2;
}

function regularizedBeta(value: number, alpha: number, beta: number): number {
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  const logTerm =
    logGamma(alpha + beta) -
    logGamma(alpha) -
    logGamma(beta) +
    alpha * Math.log(value) +
    beta * Math.log1p(-value);
  const front = Math.exp(logTerm);
  return value < (alpha + 1) / (alpha + beta + 2)
    ? (front * betaContinuedFraction(value, alpha, beta)) / alpha
    : 1 - (front * betaContinuedFraction(1 - value, beta, alpha)) / beta;
}

function betaContinuedFraction(value: number, alpha: number, beta: number): number {
  const maxIterations = 300;
  const epsilon = 3e-14;
  const floor = 1e-300;
  const sum = alpha + beta;
  const alphaPlusOne = alpha + 1;
  const alphaMinusOne = alpha - 1;
  let c = 1;
  let d = 1 - (sum * value) / alphaPlusOne;
  if (Math.abs(d) < floor) d = floor;
  d = 1 / d;
  let result = d;
  for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
    const doubled = iteration * 2;
    let coefficient =
      (iteration * (beta - iteration) * value) / ((alphaMinusOne + doubled) * (alpha + doubled));
    d = 1 + coefficient * d;
    if (Math.abs(d) < floor) d = floor;
    c = 1 + coefficient / c;
    if (Math.abs(c) < floor) c = floor;
    d = 1 / d;
    result *= d * c;
    coefficient =
      (-(alpha + iteration) * (sum + iteration) * value) /
      ((alpha + doubled) * (alphaPlusOne + doubled));
    d = 1 + coefficient * d;
    if (Math.abs(d) < floor) d = floor;
    c = 1 + coefficient / c;
    if (Math.abs(c) < floor) c = floor;
    d = 1 / d;
    const delta = d * c;
    result *= delta;
    if (Math.abs(delta - 1) < epsilon) break;
  }
  return result;
}

function logGamma(value: number): number {
  const coefficients = [
    676.5203681218851, -1259.1392167224028, 771.3234287776531, -176.6150291621406,
    12.507343278686905, -0.13857109526572012, 9.984369578019572e-6, 1.5056327351493116e-7,
  ];
  if (value < 0.5) {
    return Math.log(Math.PI) - Math.log(Math.sin(Math.PI * value)) - logGamma(1 - value);
  }
  const shifted = value - 1;
  let accumulator = 0.9999999999998099;
  for (let index = 0; index < coefficients.length; index += 1) {
    accumulator += coefficients[index]! / (shifted + index + 1);
  }
  const term = shifted + coefficients.length - 0.5;
  return (
    0.5 * Math.log(2 * Math.PI) + (shifted + 0.5) * Math.log(term) - term + Math.log(accumulator)
  );
}

function assertBinomialArguments(successes: number, trials: number, confidenceLevel: number): void {
  if (
    !Number.isSafeInteger(successes) ||
    !Number.isSafeInteger(trials) ||
    successes < 0 ||
    trials < 0 ||
    successes > trials ||
    !Number.isFinite(confidenceLevel) ||
    confidenceLevel <= 0 ||
    confidenceLevel >= 1
  ) {
    throw new Error('Invalid binomial confidence-bound arguments');
  }
}

function ratio(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : Number.NaN;
}

function requireMinimum(failures: string[], name: string, actual: number, expected: number): void {
  if (!Number.isFinite(actual) || actual < expected) {
    failures.push(`${name} ${format(actual)} is below ${format(expected)}`);
  }
}

function requireMaximum(failures: string[], name: string, actual: number, expected: number): void {
  if (!Number.isFinite(actual) || actual > expected) {
    failures.push(`${name} ${format(actual)} exceeds ${format(expected)}`);
  }
}

function requireExactCount(
  failures: string[],
  name: string,
  actual: number,
  expected: number,
): void {
  if (
    !Number.isSafeInteger(actual) ||
    !Number.isSafeInteger(expected) ||
    actual < 0 ||
    expected < 0 ||
    actual !== expected
  ) {
    failures.push(`${name} ${format(actual)} does not equal expected ${format(expected)}`);
  }
}

function format(value: number): string {
  return Number.isFinite(value) ? String(Math.round(value * 1_000_000) / 1_000_000) : 'unavailable';
}
