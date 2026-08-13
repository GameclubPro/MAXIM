import {
  COMMERCIAL_OCR_CYRILLIC_ENFORCEMENT_GATES,
  COMMERCIAL_OCR_RU_ENFORCEMENT_GATES,
  evaluateCommercialOcrEvalGates,
  type CommercialOcrEvalGateProfile,
} from './commercial-ocr-eval-gates';
import type {
  CommercialOcrEvalCaseResult,
  CommercialOcrEvalReport,
  CommercialOcrEvalSlice,
} from './commercial-ocr-eval-runner';

const SMALL_PROFILE: CommercialOcrEvalGateProfile = {
  minTotal: 4,
  minDeleteCases: 2,
  minNoActionCases: 2,
  minClusters: 4,
  maxFalseDeleteRate: 0,
  minDeleteRecall: 0.5,
  maxPositiveIncompleteRate: 0.5,
  maxNegativeIncompleteRate: 0.5,
  maxUnlabeledImageScriptCases: 0,
  maxUnlabeledCaptionLanguageCases: 0,
  requiredHardNegativeCategories: {},
  maxHardNegativeFalseDeletes: 0,
};

describe('commercial OCR eval gates', () => {
  it('keeps the RU constant as an alias of the Cyrillic enforcement profile', () => {
    expect(COMMERCIAL_OCR_RU_ENFORCEMENT_GATES).toBe(COMMERCIAL_OCR_CYRILLIC_ENFORCEMENT_GATES);
  });

  it('accepts a sufficiently large labeled Cyrillic corpus with every hard-negative category', () => {
    const categories = Object.keys(
      COMMERCIAL_OCR_CYRILLIC_ENFORCEMENT_GATES.requiredHardNegativeCategories,
    );
    const deleteCases = buildCases({
      count: COMMERCIAL_OCR_CYRILLIC_ENFORCEMENT_GATES.minDeleteCases,
      prefix: 'delete',
      expectedAction: 'DELETE',
      actualAction: 'DELETE',
    });
    const noActionCases = buildCases({
      count: COMMERCIAL_OCR_CYRILLIC_ENFORCEMENT_GATES.minNoActionCases,
      prefix: 'safe',
      expectedAction: 'NO_ACTION',
      actualAction: 'NO_ACTION',
    }).map((item, index) => ({
      ...item,
      hardNegativeCategory:
        index < categories.length * 25 ? categories[Math.floor(index / 25)] : undefined,
    }));

    expect(evaluateCommercialOcrEvalGates(buildReport([...deleteCases, ...noActionCases]))).toEqual(
      {
        passed: true,
        failures: [],
      },
    );
  });

  it('uses observed image script rather than the legacy language label for the cohort', () => {
    const passingCases = buildPassingCyrillicCases();
    const reportOnlyCases = [
      buildCase('ru-latin-false-delete', 'ru', 'NO_ACTION', 'DELETE', {
        imageTextScript: 'latin_only',
      }),
      buildCase('ru-mixed-missed-delete', 'ru', 'DELETE', 'NO_ACTION', {
        imageTextScript: 'mixed',
      }),
    ];

    expect(
      evaluateCommercialOcrEvalGates(
        buildReport([...passingCases, ...reportOnlyCases]),
        SMALL_PROFILE,
      ),
    ).toEqual({ passed: true, failures: [] });

    const mislabeledCyrillic = buildCase('en-cyrillic-false-delete', 'en', 'NO_ACTION', 'DELETE');
    expect(
      evaluateCommercialOcrEvalGates(
        buildReport([...passingCases, mislabeledCyrillic]),
        SMALL_PROFILE,
      ).failures,
    ).toContainEqual(expect.stringContaining('Cyrillic-only false-delete rate'));
  });

  it('fails closed when image-script or caption-language labels are absent', () => {
    const unlabeledScript = buildPassingCyrillicCases().map((item, index) =>
      index === 0 ? { ...item, imageTextScript: undefined } : item,
    );
    const unlabeledCaption = buildPassingCyrillicCases().map((item, index) =>
      index === 0 ? { ...item, captionLanguage: undefined } : item,
    );

    expect(
      evaluateCommercialOcrEvalGates(buildReport(unlabeledScript), SMALL_PROFILE).failures,
    ).toContainEqual(expect.stringContaining('Unlabeled image-script cases'));
    expect(
      evaluateCommercialOcrEvalGates(buildReport(unlabeledCaption), SMALL_PROFILE).failures,
    ).toContainEqual(expect.stringContaining('Unlabeled caption-language cases'));
  });

  it('measures Cyrillic recall as actual DELETE divided by expected DELETE', () => {
    const report = buildReport([
      buildCase('delete-hit', 'ru', 'DELETE', 'DELETE'),
      buildCase('delete-incomplete', 'ru', 'DELETE', 'INCOMPLETE'),
      buildCase('safe-1', 'ru', 'NO_ACTION', 'NO_ACTION'),
      buildCase('safe-2', 'ru', 'NO_ACTION', 'NO_ACTION'),
    ]);

    expect(
      evaluateCommercialOcrEvalGates(report, {
        ...SMALL_PROFILE,
        minDeleteRecall: 0.5,
      }),
    ).toEqual({ passed: true, failures: [] });
    expect(
      evaluateCommercialOcrEvalGates(report, {
        ...SMALL_PROFILE,
        minDeleteRecall: 0.500_001,
      }).failures,
    ).toContainEqual(expect.stringContaining('Cyrillic-only delete recall'));
  });

  it('gates incomplete positives and negatives independently', () => {
    const positiveIncomplete = buildReport([
      buildCase('delete-hit', 'ru', 'DELETE', 'DELETE'),
      buildCase('delete-incomplete', 'ru', 'DELETE', 'INCOMPLETE'),
      buildCase('safe-1', 'ru', 'NO_ACTION', 'NO_ACTION'),
      buildCase('safe-2', 'ru', 'NO_ACTION', 'NO_ACTION'),
    ]);
    const negativeIncomplete = buildReport([
      buildCase('delete-1', 'ru', 'DELETE', 'DELETE'),
      buildCase('delete-2', 'ru', 'DELETE', 'DELETE'),
      buildCase('safe-hit', 'ru', 'NO_ACTION', 'NO_ACTION'),
      buildCase('safe-incomplete', 'ru', 'NO_ACTION', 'INCOMPLETE'),
    ]);
    const profile = {
      ...SMALL_PROFILE,
      maxPositiveIncompleteRate: 0.49,
      maxNegativeIncompleteRate: 0.49,
    };

    expect(evaluateCommercialOcrEvalGates(positiveIncomplete, profile).failures).toEqual([
      expect.stringContaining('Cyrillic-only positive incomplete rate'),
    ]);
    expect(evaluateCommercialOcrEvalGates(negativeIncomplete, profile).failures).toEqual([
      expect.stringContaining('Cyrillic-only negative incomplete rate'),
    ]);
  });

  it('requires case and cluster coverage for every hard-negative category', () => {
    const profile: CommercialOcrEvalGateProfile = {
      ...SMALL_PROFILE,
      requiredHardNegativeCategories: {
        rules_or_moderation_context: { minCases: 2, minClusters: 2 },
        news_or_analytics: { minCases: 1, minClusters: 1 },
      },
    };
    const cases = buildPassingCyrillicCases().map((item, index) =>
      index >= 2
        ? {
            ...item,
            clusterId: 'one-rules-cluster',
            hardNegativeCategory: 'rules_or_moderation_context',
          }
        : item,
    );

    expect(evaluateCommercialOcrEvalGates(buildReport(cases), profile).failures).toEqual(
      expect.arrayContaining([
        expect.stringContaining('news_or_analytics cases'),
        expect.stringContaining('rules_or_moderation_context distinct clusters'),
      ]),
    );
  });

  it('allows no false deletes in the hard-negative cohort', () => {
    const cases = buildPassingCyrillicCases();
    cases[2] = {
      ...cases[2]!,
      hardNegativeCategory: 'rules_or_moderation_context',
      actualAction: 'DELETE',
      passed: false,
    };
    const profile = { ...SMALL_PROFILE, maxFalseDeleteRate: 1 };

    expect(evaluateCommercialOcrEvalGates(buildReport(cases), profile).failures).toEqual([
      expect.stringContaining('Cyrillic-only hard-negative false deletes'),
    ]);
  });

  it('counts only distinct Cyrillic cohort clusters toward diversity', () => {
    const cases = buildPassingCyrillicCases().map((item) => ({
      ...item,
      clusterId: 'one-cyrillic-cluster',
    }));

    expect(
      evaluateCommercialOcrEvalGates(buildReport(cases), SMALL_PROFILE).failures,
    ).toContainEqual(expect.stringContaining('Cyrillic-only distinct clusters'));
  });
});

function buildPassingCyrillicCases(): CommercialOcrEvalCaseResult[] {
  return [
    buildCase('delete-1', 'ru', 'DELETE', 'DELETE'),
    buildCase('delete-2', 'ru', 'DELETE', 'DELETE'),
    buildCase('safe-1', 'ru', 'NO_ACTION', 'NO_ACTION'),
    buildCase('safe-2', 'ru', 'NO_ACTION', 'NO_ACTION'),
  ];
}

function buildCases(params: {
  count: number;
  prefix: string;
  language?: CommercialOcrEvalCaseResult['language'];
  expectedAction: CommercialOcrEvalCaseResult['expectedAction'];
  actualAction: CommercialOcrEvalCaseResult['actualAction'];
}): CommercialOcrEvalCaseResult[] {
  return Array.from({ length: params.count }, (_, index) =>
    buildCase(
      `${params.prefix}-${index}`,
      params.language ?? 'ru',
      params.expectedAction,
      params.actualAction,
    ),
  );
}

function buildCase(
  id: string,
  language: CommercialOcrEvalCaseResult['language'],
  expectedAction: CommercialOcrEvalCaseResult['expectedAction'],
  actualAction: CommercialOcrEvalCaseResult['actualAction'],
  metadata: Partial<Pick<CommercialOcrEvalCaseResult, 'imageTextScript' | 'captionLanguage'>> = {},
): CommercialOcrEvalCaseResult {
  return {
    id,
    clusterId: `${id}-cluster`,
    language,
    imageTextScript: 'cyrillic_only',
    captionLanguage: 'none',
    category: 'test',
    expectedAction,
    actualAction,
    passed: expectedAction === actualAction,
    durationMs: 1,
    reasonCodes: [],
    ...metadata,
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
  const clusters = cases.map((item) => ({
    clusterId: item.clusterId,
    expectedAction: item.expectedAction,
    passed: item.passed,
    ...summarize([item]),
  }));
  return {
    schemaVersion: 1,
    corpusId: 'test-corpus',
    corpusRevision: 'v1',
    generatedAt: '2026-08-13T00:00:00.000Z',
    passed: cases.filter((item) => item.passed).length,
    failed: cases.filter((item) => !item.passed).length,
    ...summary,
    durationMs: cases.length,
    languages: {
      ru: summarize(cases.filter((item) => item.language === 'ru')),
      en: summarize(cases.filter((item) => item.language === 'en')),
      mixed: summarize(cases.filter((item) => item.language === 'mixed')),
    },
    categories: { test: summary },
    clusters,
    cases,
  };
}
