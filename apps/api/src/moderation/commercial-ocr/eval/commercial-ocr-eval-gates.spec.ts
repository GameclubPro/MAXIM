import { COMMERCIAL_OCR_BENCHMARK_ENVIRONMENT_PROFILE_ID } from '../../../scripts/commercial-run-provenance.util';
import {
  createCommercialOcrNativeBehaviorIdentity,
  resolveCommercialOcrBehaviorIdentity,
  resolveCommercialOcrNativeRuntimeControls,
  resolveCommercialOcrProductionBehaviorDescriptor,
  resolveCommercialOcrProductionNativeConfigReader,
} from '../commercial-ocr-behavior-identity';
import {
  COMMERCIAL_OCR_CYRILLIC_ENFORCEMENT_GATES,
  COMMERCIAL_OCR_RU_ENFORCEMENT_GATES,
  evaluateCommercialOcrEvalGates,
  oneSidedClopperPearsonLower,
  oneSidedClopperPearsonUpper,
  type CommercialOcrEvalGateProfile,
} from './commercial-ocr-eval-gates';
import { calculateCommercialOcrEvalCanonicalSha256 } from './commercial-ocr-eval-canonical';
import { aggregateCommercialOcrEvalQuality } from './commercial-ocr-eval-quality';
import {
  COMMERCIAL_OCR_CERTIFICATION_ANNOTATION_PROTOCOL_VERSION,
  COMMERCIAL_OCR_CERTIFICATION_COLLECTION_PROTOCOL_VERSION,
} from './commercial-ocr-eval.schema';
import {
  COMMERCIAL_OCR_EVAL_PERFORMANCE_MEASUREMENT_VERSION,
  summarizeCommercialOcrEvalDurationSamples,
  CommercialOcrEvalCaseResult,
  CommercialOcrEvalReport,
  CommercialOcrEvalSlice,
} from './commercial-ocr-eval-runner';

const SMALL_PROFILE: CommercialOcrEvalGateProfile = {
  minTotal: 4,
  minAdversarialCases: 0,
  minAdversarialClusters: 0,
  minDeleteCases: 2,
  minEligibleNoActionCases: 2,
  minClusters: 4,
  minPositiveSubtypeClusters: 1,
  requiredPositiveSubtypes: ['SERVICES'],
  maxFalseDeleteRate: 0,
  maxFalseDeleteUpperConfidenceBound: 0.9,
  falseDeleteConfidenceLevel: 0.95,
  minDeleteRecall: 0.5,
  minDeleteRecallLowerConfidenceBound: 0.09,
  deleteRecallConfidenceLevel: 0.95,
  maxPositiveIncompleteRate: 0.9,
  maxNegativeIncompleteRate: 0.9,
  incompleteConfidenceLevel: 0.95,
  maxUnlabeledImageScriptCases: 0,
  maxUnlabeledCaptionLanguageCases: 0,
  requiredHardNegativeCategories: {},
  maxHardNegativeFalseDeletes: 0,
  minQualityCases: 2,
  minAttemptedPasses: 4,
  minCharacterReferenceLength: 200,
  minWordReferenceLength: 40,
  minCriticalTokens: 4,
  minConfidenceObservations: 4,
  minHighConfidencePasses: 4,
  minCriticalTokenRecall: 1,
  maxCharacterErrorRate: 0,
  maxWordErrorRate: 0,
  maxMeanAbsoluteConfidenceCalibrationError: 0,
  maxHighConfidenceSevereErrorRate: 0,
  minPerformanceSourceCases: 4,
  minPerformanceOcrPasses: 8,
  minPerformancePassCoverage: 1,
  maxOcrPassP95Ms: 5_000,
  maxOcrPassP99Ms: 8_000,
  maxOcrPassMs: 14_500,
  maxSourceCaseP95Ms: 12_000,
  maxSourceCaseP99Ms: 18_000,
  minThroughputImagesPerMinute: 4,
  maxDeadlineUtilization: 0.8,
};

describe('commercial OCR eval gates', () => {
  it('keeps the RU constant as an alias of the Cyrillic enforcement profile', () => {
    expect(COMMERCIAL_OCR_RU_ENFORCEMENT_GATES).toBe(COMMERCIAL_OCR_CYRILLIC_ENFORCEMENT_GATES);
    expect(COMMERCIAL_OCR_CYRILLIC_ENFORCEMENT_GATES).toMatchObject({
      minAdversarialCases: 100,
      minAdversarialClusters: 60,
      minEligibleNoActionCases: 4_603,
      minCriticalTokenRecall: 0.95,
      maxCharacterErrorRate: 0.25,
      maxWordErrorRate: 0.4,
      maxMeanAbsoluteConfidenceCalibrationError: 0.2,
      maxHighConfidenceSevereErrorRate: 0.01,
    });
  });

  it('matches exact one-sided confidence-bound thresholds', () => {
    expect(oneSidedClopperPearsonUpper(0, 4_603, 0.99)).toBeLessThan(0.001);
    expect(oneSidedClopperPearsonUpper(0, 4_602, 0.99)).toBeGreaterThanOrEqual(0.001);
    expect(oneSidedClopperPearsonLower(484, 500, 0.95)).toBeGreaterThanOrEqual(0.95);
    expect(oneSidedClopperPearsonLower(483, 500, 0.95)).toBeLessThan(0.95);
  });

  it('passes a fully labeled v2 holdout with independent representatives', () => {
    expect(
      evaluateCommercialOcrEvalGates(buildReport(passingCases()), SMALL_PROFILE),
    ).toMatchObject({
      passed: true,
      failures: [],
      profileSha256: calculateCommercialOcrEvalCanonicalSha256(SMALL_PROFILE),
    });
  });

  it.each(['synthetic', 'public_dataset'] as const)(
    'rejects %s corpora for enforcement certification',
    (sourceKind) => {
      const report = buildReport(passingCases());
      report.corpusProvenance = {
        ...report.corpusProvenance!,
        sourceKind,
        windowStartedAt: null,
        windowEndedAt: null,
      };

      expect(evaluateCommercialOcrEvalGates(report, SMALL_PROFILE).failures).toContain(
        'Certification corpus must use production-temporal real images',
      );
    },
  );

  it('requires supported protocols, verified artifact digests, and a fresh temporal window', () => {
    const report = buildReport(passingCases());
    report.generatedAt = '2026-08-14T00:00:00.000Z';
    report.corpusProvenance = {
      ...report.corpusProvenance!,
      windowStartedAt: '2026-01-01T00:00:00.000Z',
      windowEndedAt: '2026-01-02T00:00:00.000Z',
      frozenAt: '2026-03-15T00:00:00.000Z',
      collectionProtocolVersion: 'self-selected-v1',
      annotationProtocolVersion: 'single-review-v1',
      collectionArtifactSha256: 'A'.repeat(64),
      adjudicationArtifactSha256: 'a'.repeat(64),
    };

    expect(evaluateCommercialOcrEvalGates(report, SMALL_PROFILE).failures).toEqual(
      expect.arrayContaining([
        'Certification collection protocol is unsupported',
        'Certification annotation protocol is unsupported',
        'Certification collection artifact SHA-256 must be canonical lowercase hex',
        'Certification collection window must cover at least 7 days',
        'Certification corpus must be frozen within 30 days after collection',
        'Certification corpus collection must end within 90 days of evaluation',
      ]),
    );
  });

  it('requires canonical clean source and immutable image bindings', () => {
    const report = buildReport(passingCases());
    setProvenanceValue(report, ['run', 'git', 'commit'], null);
    setProvenanceValue(report, ['run', 'git', 'dirty'], true);
    setProvenanceValue(report, ['artifact', 'sourceSha'], 'A'.repeat(40));
    setProvenanceValue(report, ['artifact', 'immutableImageSha256'], null);

    expect(evaluateCommercialOcrEvalGates(report, SMALL_PROFILE).failures).toEqual(
      expect.arrayContaining([
        'Certification Git commit must be a canonical lowercase 40-character SHA',
        'Certification source SHA must be a canonical lowercase 40-character SHA',
        'Certification immutable image SHA-256 must be canonical lowercase hex',
        'Certification requires a clean Git worktree',
      ]),
    );
  });

  it('requires the source SHA to equal the evaluated Git commit', () => {
    const report = buildReport(passingCases());
    setProvenanceValue(report, ['artifact', 'sourceSha'], 'd'.repeat(40));

    expect(evaluateCommercialOcrEvalGates(report, SMALL_PROFILE).failures).toContain(
      'Certification source SHA must match the evaluated Git commit',
    );
  });

  it('rejects malformed manifest and behavior fingerprints', () => {
    const report = buildReport(passingCases());
    setProvenanceValue(report, ['artifact', 'manifestSha256'], 'A'.repeat(64));
    setProvenanceValue(report, ['fingerprints', 'ocr', 'sourceSha256'], 'not-a-digest');
    setProvenanceValue(report, ['fingerprints', 'policy', 'sourceSha256'], 'B'.repeat(64));
    setProvenanceValue(report, ['fingerprints', 'preprocess', 'sourceSha256'], 'f'.repeat(63));
    setProvenanceValue(report, ['fingerprints', 'detector', 'sourceSha256'], 'g'.repeat(64));

    expect(evaluateCommercialOcrEvalGates(report, SMALL_PROFILE).failures).toEqual(
      expect.arrayContaining([
        'Certification manifest SHA-256 must be canonical lowercase hex',
        'Certification OCR fingerprint SHA-256 must be canonical lowercase hex',
        'Certification policy fingerprint SHA-256 must be canonical lowercase hex',
        'Certification preprocess fingerprint SHA-256 must be canonical lowercase hex',
        'Certification detector fingerprint SHA-256 must be canonical lowercase hex',
      ]),
    );
  });

  it('requires production OCR runtimes, languages, and traineddata identities', () => {
    const report = buildReport(passingCases());
    setProvenanceValue(report, ['runtime', 'nodeVersion'], 'v22.0.0');
    setProvenanceValue(report, ['run', 'runtime', 'nodeVersion'], 'v22.0.0');
    setProvenanceValue(report, ['runtime', 'sharpVersion'], 'latest');
    setProvenanceValue(report, ['runtime', 'libvipsVersion'], null);
    setProvenanceValue(report, ['runtime', 'tesseractVersion'], '5.5.2');
    setProvenanceValue(report, ['tesseract', 'availableLanguages'], ['eng']);
    setProvenanceValue(report, ['tesseract', 'traineddataSha256', 'rus'], 'C'.repeat(64));

    expect(evaluateCommercialOcrEvalGates(report, SMALL_PROFILE).failures).toEqual(
      expect.arrayContaining([
        'Certification runtime must use Node 24',
        'Certification runtime must use the production Sharp version',
        'Certification runtime must use the production libvips version',
        'Certification runtime must use the production Tesseract version',
        'Certification Tesseract inventory must include rus and eng',
        'Certification rus.traineddata SHA-256 must be canonical lowercase hex',
      ]),
    );
  });

  it('binds policy identities and execution limits to the production behavior', () => {
    const report = buildReport(passingCases());
    setProvenanceValue(report, ['fingerprints', 'ocr', 'version'], 'legacy-ocr');
    setProvenanceValue(report, ['fingerprints', 'policy', 'version'], 'legacy-policy');
    setProvenanceValue(report, ['fingerprints', 'preprocess', 'profiles', 'primary'], 'legacy');
    setProvenanceValue(report, ['fingerprints', 'detector', 'decisionVersion'], 'legacy');
    setProvenanceValue(report, ['tesseract', 'languages'], ['eng', 'rus']);
    setProvenanceValue(report, ['tesseract', 'oem'], 3);
    setProvenanceValue(report, ['tesseract', 'psm', 'primary'], 6);
    setProvenanceValue(report, ['sourceImages', 'allowedFormats'], ['png']);
    setProvenanceValue(report, ['tesseract', 'resourceLimits', 'maxSourceImageBytes'], 1);
    setProvenanceValue(report, ['tesseract', 'resourceLimits', 'evalConcurrency'], 4);

    expect(evaluateCommercialOcrEvalGates(report, SMALL_PROFILE).failures).toEqual(
      expect.arrayContaining([
        'Certification OCR version identity does not match the current runtime',
        'Certification policy version identity does not match the current runtime',
        'Certification primary preprocess identity does not match the current runtime',
        'Certification detector decision identity does not match the current runtime',
        'Certification detector fingerprints are internally inconsistent',
        'Certification OCR language order must be exactly rus+eng',
        'Certification Tesseract OEM must be 1',
        'Certification primary Tesseract PSM must be 11',
        'Certification source image formats must match the runtime raster allowlist',
        'Certification maxSourceImageBytes must match the production OCR resource profile',
        'Certification evalConcurrency must match the production OCR resource profile',
      ]),
    );
  });

  it('rejects near-timeout OCR, low throughput, deadline saturation, and unreviewed hardware', () => {
    const report = buildReport(passingCases());
    const measured = report.performance.certification;
    const ocrPassSamplesMs = measured.ocrPassSamplesMs.map(() => 9_000);
    const sourceCaseSamplesMs = measured.sourceCaseSamplesMs.map(() => 25_000);
    const durationMs = sourceCaseSamplesMs.reduce((total, value) => total + value, 0);
    report.performance = {
      ...report.performance,
      certification: {
        ...measured,
        durationMs,
        deadlineUtilization:
          Math.round((durationMs / measured.deadlineBudgetMs) * 1_000_000) / 1_000_000,
        throughputImagesPerMinute:
          Math.round(((measured.images * 60_000) / durationMs) * 1_000_000) / 1_000_000,
        ocrPassSamplesMs,
        sourceCaseSamplesMs,
        ocrPassDurationMs: summarizeCommercialOcrEvalDurationSamples(ocrPassSamplesMs),
        sourceCaseDurationMs: summarizeCommercialOcrEvalDurationSamples(sourceCaseSamplesMs),
      },
    };
    setProvenanceValue(
      report,
      ['benchmarkEnvironment', 'reviewedDescriptorSha256'],
      null,
    );

    const failures = evaluateCommercialOcrEvalGates(report, SMALL_PROFILE).failures.join('\n');
    expect(failures).toMatch(/benchmark environment was not bound to a reviewed descriptor/u);
    expect(failures).toMatch(/OCR pass p95 latency/u);
    expect(failures).toMatch(/OCR pass p99 latency/u);
    expect(failures).toMatch(/source-case p95 latency/u);
    expect(failures).toMatch(/source-case p99 latency/u);
    expect(failures).toMatch(/image throughput per minute/u);
    expect(failures).toMatch(/runtime deadline utilization/u);
  });

  it('allows a descriptor fallback only with a complete immutable source binding', () => {
    const valid = buildReport(passingCases());
    setProvenanceValue(valid, ['fingerprints', 'ocr', 'digestKind'], 'VERSION_DESCRIPTOR');
    expect(evaluateCommercialOcrEvalGates(valid, SMALL_PROFILE)).toMatchObject({ passed: true });

    const unbound = buildReport(passingCases());
    setProvenanceValue(unbound, ['fingerprints', 'ocr', 'digestKind'], 'VERSION_DESCRIPTOR');
    setProvenanceValue(unbound, ['artifact', 'immutableImageSha256'], null);
    expect(evaluateCommercialOcrEvalGates(unbound, SMALL_PROFILE).failures).toContain(
      'VERSION_DESCRIPTOR fingerprints require an immutable image bound to the clean source commit',
    );
  });

  it('rejects legacy corpora even when point metrics pass', () => {
    const outcome = evaluateCommercialOcrEvalGates(
      { ...buildReport(passingCases()), corpusSchemaVersion: 1 },
      SMALL_PROFILE,
    );
    expect(outcome.failures).toContain('Enforcement certification requires corpus schema v2');
  });

  it.each(['latin_only', 'mixed', 'unknown'] as const)(
    'blocks an enforcement false DELETE in the %s script cohort',
    (script) => {
      const cases = passingCases();
      cases.push(
        buildCase('unsafe-script', 'NO_ACTION', 'DELETE', {
          imageTextScript: script,
          imageTextScripts: [script],
          split: 'adversarial',
          statisticsRepresentative: false,
        }),
      );
      expect(evaluateCommercialOcrEvalGates(buildReport(cases), SMALL_PROFILE).failures).toEqual(
        expect.arrayContaining([
          expect.stringContaining('All-script enforcement false DELETE cases'),
          expect.stringContaining('Adversarial expectation mismatches'),
        ]),
      );
    },
  );

  it('blocks a commercial false DELETE even when the language guard suppresses enforcement', () => {
    const cases = passingCases();
    cases.push(
      buildCase('guarded-false-delete', 'NO_ACTION', 'NO_ACTION', {
        split: 'adversarial',
        statisticsRepresentative: false,
        imageTextScript: 'latin_only',
        imageTextScripts: ['latin_only'],
        actualCommercialAction: 'DELETE',
        actualSubtype: 'SERVICES',
        passed: false,
      }),
    );

    expect(evaluateCommercialOcrEvalGates(buildReport(cases), SMALL_PROFILE).failures).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Certification commercial false DELETE cases'),
        expect.stringContaining('Adversarial expectation mismatches'),
      ]),
    );
  });

  it('counts only one marked representative per cluster in statistical bounds', () => {
    const cases = passingCases();
    cases.push(
      buildCase('variant', 'NO_ACTION', 'NO_ACTION', {
        clusterId: cases[2]!.clusterId,
        split: 'adversarial',
        statisticsRepresentative: false,
      }),
    );
    const result = evaluateCommercialOcrEvalGates(buildReport(cases), SMALL_PROFILE);
    expect(result.metrics.profiles['balanced-45-65']).toMatchObject({
      representativeCases: 4,
      negativeClusters: 2,
    });
  });

  it('does not let Latin or commercial report-only cases inflate the eligible-negative denominator', () => {
    const cases = passingCases();
    cases[2] = {
      ...cases[2]!,
      imageTextScript: 'latin_only',
      imageTextScripts: ['latin_only'],
      cyrillicGroundTruthEligible: false,
    };
    cases[3] = {
      ...cases[3]!,
      expectedCommercialAction: 'DELETE',
      actualCommercialAction: 'DELETE',
      expectedSubtype: 'SERVICES',
      actualSubtype: 'SERVICES',
      imageTextScript: 'latin_only',
      imageTextScripts: ['latin_only'],
      cyrillicGroundTruthEligible: false,
      passed: true,
    };
    const result = evaluateCommercialOcrEvalGates(buildReport(cases), SMALL_PROFILE);

    expect(result.metrics.profiles['balanced-45-65']).toMatchObject({
      eligibleNoActionCases: 0,
      excludedNoActionCases: 1,
      falseDeleteUpperConfidenceBound: Number.NaN,
    });
    expect(result.failures).toContainEqual(
      expect.stringContaining('eligible commercial no-action cases'),
    );
    expect(result.failures).toContainEqual(
      expect.stringContaining('false-delete upper confidence bound'),
    );
  });

  it('allows bounded representative misses and incomplete results through confidence gates', () => {
    const cases = [
      ...buildCases(20, 'delete', 'DELETE', 'DELETE'),
      ...buildCases(20, 'safe', 'NO_ACTION', 'NO_ACTION'),
    ];
    cases[0] = buildCase('delete-miss', 'DELETE', 'NO_ACTION');
    cases[1] = buildCase('delete-incomplete', 'DELETE', 'INCOMPLETE');
    cases[20] = buildCase('safe-incomplete', 'NO_ACTION', 'INCOMPLETE');
    const result = evaluateCommercialOcrEvalGates(buildReport(cases), {
      ...SMALL_PROFILE,
      minTotal: 40,
      minDeleteCases: 20,
      minEligibleNoActionCases: 20,
      minClusters: 40,
      minDeleteRecall: 0.85,
      minDeleteRecallLowerConfidenceBound: 0.7,
      maxPositiveIncompleteRate: 0.3,
      maxNegativeIncompleteRate: 0.3,
    });

    expect(result.passed).toBe(true);
    expect(result.metrics.profiles['balanced-45-65']).toMatchObject({
      successfulDeletes: 18,
      positiveIncomplete: 1,
      negativeIncomplete: 1,
    });
  });

  it('rejects a DELETE with the wrong commercial subtype', () => {
    const cases = passingCases();
    cases[0] = { ...cases[0]!, actualSubtype: 'RECRUITMENT', passed: false };

    expect(evaluateCommercialOcrEvalGates(buildReport(cases), SMALL_PROFILE).failures).toEqual(
      expect.arrayContaining([expect.stringContaining('Commercial subtype mismatches')]),
    );
  });

  it('fails closed when OCR quality observations are missing or exceed conservative bounds', () => {
    const missing = passingCases().map((item) =>
      item.expectedEnforcementAction === 'DELETE' ? { ...item, ocrQuality: null } : item,
    );
    expect(evaluateCommercialOcrEvalGates(buildReport(missing), SMALL_PROFILE).failures).toEqual(
      expect.arrayContaining([
        expect.stringContaining('OCR quality cases'),
        expect.stringContaining('OCR attempted passes'),
        expect.stringContaining('OCR critical-token observations'),
        expect.stringContaining('OCR confidence observations'),
      ]),
    );

    const poor = passingCases().map((item) =>
      item.expectedEnforcementAction === 'DELETE'
        ? {
            ...item,
            ocrQuality: qualityMetrics({
              characterEdits: 100,
              wordEdits: 20,
              criticalTokensMatchedPrimary: 0,
              criticalTokensMatchedConfirmation: 0,
              criticalTokensMatchedBoth: 0,
              absoluteConfidenceCalibrationErrorPermille: 2_000,
              highConfidenceSevereErrorPasses: 2,
            }),
          }
        : item,
    );
    expect(evaluateCommercialOcrEvalGates(buildReport(poor), SMALL_PROFILE).failures).toEqual(
      expect.arrayContaining([
        expect.stringContaining('OCR critical-token both-pass recall'),
        expect.stringContaining('OCR character error rate'),
        expect.stringContaining('OCR word error rate'),
        expect.stringContaining('OCR confidence calibration error'),
        expect.stringContaining('OCR high-confidence severe-error rate'),
      ]),
    );
  });

  it('evaluates each settings profile independently on the same representative sources', () => {
    const balanced = passingCases();
    const strict = forProfile(passingCases(), 'strict-50-75', 'b'.repeat(64));
    strict[0] = {
      ...strict[0]!,
      actualCommercialAction: 'NO_ACTION',
      actualEnforcementAction: 'NO_ACTION',
      actualAction: 'NO_ACTION',
      actualSubtype: undefined,
      passed: false,
    };
    const result = evaluateCommercialOcrEvalGates(buildReport([...balanced, ...strict]), {
      ...SMALL_PROFILE,
      minDeleteRecall: 1,
      minDeleteRecallLowerConfidenceBound: 0,
    });

    expect(result.failures).toContainEqual(
      expect.stringContaining('Settings profile strict-50-75 delete recall'),
    );
    expect(result.failures).not.toContainEqual(
      expect.stringContaining('Settings profile balanced-45-65 delete recall'),
    );
    expect(result.metrics.profiles['balanced-45-65']?.successfulDeletes).toBe(2);
    expect(result.metrics.profiles['strict-50-75']?.successfulDeletes).toBe(1);
  });

  it('fails exact two-pass quality coverage per settings profile without cross-profile borrowing', () => {
    const balanced = passingCases();
    const strict = forProfile(passingCases(), 'strict-50-75', 'b'.repeat(64));
    strict[0] = {
      ...strict[0]!,
      ocrQuality: qualityMetrics({
        attemptedPasses: 1,
        attemptedConfirmationPasses: 0,
      }),
    };
    strict[1] = {
      ...strict[1]!,
      ocrQuality: qualityMetrics({
        failedPasses: 1,
        failedConfirmationPasses: 1,
      }),
    };

    const result = evaluateCommercialOcrEvalGates(
      buildReport([...balanced, ...strict]),
      SMALL_PROFILE,
    );

    expect(result.failures).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Settings profile strict-50-75 OCR quality coverage-gap cases'),
        expect.stringContaining(
          'Settings profile strict-50-75 OCR confirmation attempted coverage',
        ),
        expect.stringContaining('Settings profile strict-50-75 OCR failed confirmation passes'),
      ]),
    );
    expect(result.failures).not.toContainEqual(
      expect.stringContaining('Settings profile balanced-45-65 OCR quality coverage'),
    );
    expect(result.failures).not.toContainEqual(
      expect.stringContaining('Settings profile balanced-45-65 OCR failed'),
    );
  });

  it('requires the profile-independent quality lane to be identical across settings profiles', () => {
    const strict = forProfile(passingCases(), 'strict-50-75', 'b'.repeat(64));
    strict[0] = {
      ...strict[0]!,
      ocrQuality: qualityMetrics({
        characterEdits: 1,
        absoluteConfidenceCalibrationErrorPermille: 1,
      }),
    };

    expect(
      evaluateCommercialOcrEvalGates(buildReport([...passingCases(), ...strict]), SMALL_PROFILE)
        .failures,
    ).toContainEqual(expect.stringContaining('Profile-independent OCR quality mismatches'));
  });

  it('rejects settings profiles evaluated on different representative sources', () => {
    const strict = forProfile(passingCases(), 'strict-50-75', 'b'.repeat(64));
    strict[0] = {
      ...strict[0]!,
      id: 'different-source@strict-50-75',
      sourceCaseId: 'different-source',
    };

    expect(
      evaluateCommercialOcrEvalGates(buildReport([...passingCases(), ...strict]), SMALL_PROFILE)
        .failures,
    ).toContainEqual(expect.stringContaining('does not use the shared holdout representative set'));
  });

  it('rejects settings profiles evaluated on different adversarial source sets', () => {
    const balancedAdversarial = buildCase('adversarial-balanced', 'NO_ACTION', 'NO_ACTION', {
      split: 'adversarial',
      statisticsRepresentative: false,
    });
    const strictAdversarial = forProfile(
      [
        buildCase('adversarial-strict', 'NO_ACTION', 'NO_ACTION', {
          split: 'adversarial',
          statisticsRepresentative: false,
        }),
      ],
      'strict-50-75',
      'b'.repeat(64),
    );

    expect(
      evaluateCommercialOcrEvalGates(
        buildReport([
          ...passingCases(),
          ...forProfile(passingCases(), 'strict-50-75', 'b'.repeat(64)),
          balancedAdversarial,
          ...strictAdversarial,
        ]),
        SMALL_PROFILE,
      ).failures,
    ).toContainEqual(expect.stringContaining('does not use the shared adversarial source set'));
  });

  it('blocks every adversarial mismatch', () => {
    const cases = passingCases();
    cases.push(
      buildCase('adversarial-miss', 'DELETE', 'NO_ACTION', {
        split: 'adversarial',
        statisticsRepresentative: false,
      }),
    );

    expect(
      evaluateCommercialOcrEvalGates(buildReport(cases), {
        ...SMALL_PROFILE,
        minAdversarialCases: 1,
      }).failures,
    ).toContainEqual(expect.stringContaining('Adversarial expectation mismatches'));
  });

  it('requires independent adversarial clusters in addition to case volume', () => {
    const cases = passingCases();
    cases.push(
      buildCase('adversarial-1', 'NO_ACTION', 'NO_ACTION', {
        clusterId: 'shared-adversarial-cluster',
        split: 'adversarial',
        statisticsRepresentative: false,
      }),
      buildCase('adversarial-2', 'NO_ACTION', 'NO_ACTION', {
        clusterId: 'shared-adversarial-cluster',
        split: 'adversarial',
        statisticsRepresentative: false,
      }),
    );

    const outcome = evaluateCommercialOcrEvalGates(buildReport(cases), {
      ...SMALL_PROFILE,
      minAdversarialCases: 2,
      minAdversarialClusters: 2,
    });

    expect(outcome.metrics).toMatchObject({ adversarialCases: 2, adversarialClusters: 1 });
    expect(outcome.failures).toContainEqual(
      expect.stringContaining('Adversarial independent clusters'),
    );
  });

  it('keeps development failures outside certification statistics', () => {
    const cases = passingCases();
    cases.push(
      buildCase('development-false-delete', 'NO_ACTION', 'DELETE', {
        split: 'development',
        statisticsRepresentative: false,
      }),
    );

    expect(evaluateCommercialOcrEvalGates(buildReport(cases), SMALL_PROFILE)).toMatchObject({
      passed: true,
      failures: [],
    });
  });

  it('requires coverage and zero false deletes for each hard-negative category', () => {
    const cases = passingCases();
    cases[2] = buildCase('hard-negative', 'NO_ACTION', 'DELETE', {
      hardNegativeCategory: 'rules_or_moderation_context',
    });
    const profile = {
      ...SMALL_PROFILE,
      maxFalseDeleteRate: 1,
      maxFalseDeleteUpperConfidenceBound: 1,
      requiredHardNegativeCategories: {
        rules_or_moderation_context: { minCases: 2, minClusters: 2 },
      },
    };
    expect(evaluateCommercialOcrEvalGates(buildReport(cases), profile).failures).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Hard-negative commercial false deletes'),
        expect.stringContaining('rules_or_moderation_context cases'),
        expect.stringContaining('rules_or_moderation_context distinct clusters'),
      ]),
    );
  });
});

function passingCases(): CommercialOcrEvalCaseResult[] {
  return [
    buildCase('delete-1', 'DELETE', 'DELETE'),
    buildCase('delete-2', 'DELETE', 'DELETE'),
    buildCase('safe-1', 'NO_ACTION', 'NO_ACTION'),
    buildCase('safe-2', 'NO_ACTION', 'NO_ACTION'),
  ];
}

function buildCases(
  count: number,
  prefix: string,
  expectedAction: 'DELETE' | 'NO_ACTION',
  actualAction: 'DELETE' | 'NO_ACTION' | 'INCOMPLETE',
): CommercialOcrEvalCaseResult[] {
  return Array.from({ length: count }, (_, index) =>
    buildCase(`${prefix}-${index}`, expectedAction, actualAction),
  );
}

function forProfile(
  cases: readonly CommercialOcrEvalCaseResult[],
  settingsProfileId: string,
  settingsFingerprint: string,
): CommercialOcrEvalCaseResult[] {
  return cases.map((item) => ({
    ...item,
    id: `${item.sourceCaseId}@${settingsProfileId}`,
    settingsProfileId,
    settingsFingerprint,
  }));
}

function buildCase(
  id: string,
  expectedAction: 'DELETE' | 'NO_ACTION',
  actualAction: 'DELETE' | 'NO_ACTION' | 'INCOMPLETE',
  overrides: Partial<CommercialOcrEvalCaseResult> = {},
): CommercialOcrEvalCaseResult {
  return {
    id: `${id}@balanced-45-65`,
    sourceCaseId: id,
    clusterId: `${id}-cluster`,
    corpusSchemaVersion: 2,
    split: 'holdout',
    statisticsRepresentative: true,
    settingsProfileId: 'balanced-45-65',
    settingsFingerprint: 'a'.repeat(64),
    language: 'ru',
    imageTextScript: 'cyrillic_only',
    imageTextScripts: ['cyrillic_only'],
    captionLanguage: 'none',
    cyrillicGroundTruthEligible: true,
    category: 'test',
    expectedSubtype: expectedAction === 'DELETE' ? 'SERVICES' : undefined,
    actualSubtype: actualAction === 'DELETE' ? 'SERVICES' : undefined,
    expectedCommercialAction: expectedAction,
    actualCommercialAction: actualAction,
    expectedEnforcementAction: expectedAction,
    actualEnforcementAction: actualAction,
    expectedAction,
    actualAction,
    passed: expectedAction === actualAction,
    durationMs: 1,
    reasonCodes: [],
    ocrQuality: qualityMetrics(),
    ...overrides,
  };
}

function qualityMetrics(
  overrides: Partial<NonNullable<CommercialOcrEvalCaseResult['ocrQuality']>> = {},
): NonNullable<CommercialOcrEvalCaseResult['ocrQuality']> {
  const counts = {
    expectedPasses: 2,
    attemptedPasses: 2,
    failedPasses: 0,
    expectedPrimaryPasses: 1,
    attemptedPrimaryPasses: 1,
    failedPrimaryPasses: 0,
    expectedConfirmationPasses: 1,
    attemptedConfirmationPasses: 1,
    failedConfirmationPasses: 0,
    characterEdits: 0,
    characterReferenceLength: 100,
    wordEdits: 0,
    wordReferenceLength: 20,
    criticalTokens: 2,
    criticalTokensMatchedPrimary: 2,
    criticalTokensMatchedConfirmation: 2,
    criticalTokensMatchedBoth: 2,
    confidenceObservations: 2,
    absoluteConfidenceCalibrationErrorPermille: 0,
    highConfidencePasses: 2,
    highConfidenceSevereErrorPasses: 0,
    ...overrides,
  };
  return {
    ...counts,
    characterErrorRate: counts.characterEdits / counts.characterReferenceLength,
    wordErrorRate: counts.wordEdits / counts.wordReferenceLength,
    criticalTokenRecall: counts.criticalTokensMatchedBoth / counts.criticalTokens,
    meanAbsoluteConfidenceCalibrationError:
      counts.absoluteConfidenceCalibrationErrorPermille / (counts.confidenceObservations * 1_000),
    highConfidenceSevereErrorRate:
      counts.highConfidenceSevereErrorPasses / counts.highConfidencePasses,
  };
}

function summarize(cases: readonly CommercialOcrEvalCaseResult[]): CommercialOcrEvalSlice {
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

function buildReport(cases: CommercialOcrEvalCaseResult[]): CommercialOcrEvalReport {
  const summary = summarize(cases);
  const provenance = buildValidProvenance();
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
    generatedAt: '2026-08-14T00:00:00.000Z',
    provenance,
    passed: cases.filter((item) => item.passed).length,
    failed: cases.filter((item) => !item.passed).length,
    ...summary,
    durationMs: cases.length,
    quality: aggregateCommercialOcrEvalQuality(
      [...new Map(cases.map((item) => [item.sourceCaseId, item])).values()].flatMap((item) =>
        item.ocrQuality ? [item.ocrQuality] : [],
      ),
    ),
    performance: buildValidPerformance(cases, provenance.benchmarkEnvironment.descriptorSha256),
    languages: { ru: summary, en: summarize([]), mixed: summarize([]) },
    categories: { test: summary },
    clusters: cases.map((item) => ({
      clusterId: item.clusterId,
      passed: item.passed,
      ...summarize([item]),
    })),
    cases,
  };
}

function buildValidProvenance(): CommercialOcrEvalReport['provenance'] {
  const detector: CommercialOcrEvalReport['provenance']['fingerprints']['detector'] = {
    digestKind: 'SOURCE_FILES',
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
  const benchmarkDescriptorSha256 =
    calculateCommercialOcrEvalCanonicalSha256(benchmarkDescriptor);
  return {
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
    sourceImages: {
      allowedFormats: ['jpeg', 'png', 'webp', 'gif', 'avif', 'heif', 'tiff'],
    },
    tesseract: {
      binary: 'tesseract',
      tessdataPrefix: '/usr/share/tessdata',
      languages: ['rus', 'eng'],
      availableLanguages: ['eng', 'osd', 'rus'],
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
  };
}

function buildValidPerformance(
  cases: readonly CommercialOcrEvalCaseResult[],
  benchmarkEnvironmentSha256: string,
): CommercialOcrEvalReport['performance'] {
  const sourceImages = new Map<string, number>();
  for (const item of cases.filter(
    (candidate) => candidate.split === 'holdout' || candidate.split === 'adversarial',
  )) {
    sourceImages.set(item.sourceCaseId, item.imageTextScripts?.length ?? 0);
  }
  const sourceCases = sourceImages.size;
  const images = [...sourceImages.values()].reduce((total, value) => total + value, 0);
  const expectedOcrPasses = images * 2;
  const ocrPassSamplesMs = Array.from({ length: expectedOcrPasses }, () => 100);
  const sourceCaseSamplesMs = Array.from({ length: sourceCases }, () => 250);
  const durationMs = sourceCaseSamplesMs.reduce((total, value) => total + value, 0);
  const deadlineBudgetMs = expectedOcrPasses * 15_000;
  return {
    measurementVersion: COMMERCIAL_OCR_EVAL_PERFORMANCE_MEASUREMENT_VERSION,
    benchmarkEnvironmentSha256,
    evalConcurrency: 1,
    certification: {
      sourceCases,
      images,
      expectedOcrPasses,
      attemptedOcrPasses: ocrPassSamplesMs.length,
      passCoverage: 1,
      durationMs,
      deadlineBudgetMs,
      deadlineUtilization: Math.round((durationMs / deadlineBudgetMs) * 1_000_000) / 1_000_000,
      throughputImagesPerMinute:
        Math.round(((images * 60_000) / durationMs) * 1_000_000) / 1_000_000,
      ocrPassSamplesMs,
      sourceCaseSamplesMs,
      ocrPassDurationMs: summarizeCommercialOcrEvalDurationSamples(ocrPassSamplesMs),
      sourceCaseDurationMs: summarizeCommercialOcrEvalDurationSamples(sourceCaseSamplesMs),
    },
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
        availableLanguages: ['eng', 'osd', 'rus'],
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

function setProvenanceValue(
  report: CommercialOcrEvalReport,
  path: readonly string[],
  value: unknown,
): void {
  let target = report.provenance as unknown as Record<string, unknown>;
  for (const key of path.slice(0, -1)) {
    target = target[key] as Record<string, unknown>;
  }
  target[path.at(-1)!] = value;
}
