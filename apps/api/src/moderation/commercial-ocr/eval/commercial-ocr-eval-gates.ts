import type { CommercialOcrEvalReport } from './commercial-ocr-eval-runner';

export type CommercialOcrEvalHardNegativeGate = Readonly<{
  minCases: number;
  minClusters: number;
}>;

export type CommercialOcrEvalGateProfile = {
  minTotal: number;
  minDeleteCases: number;
  minNoActionCases: number;
  minClusters: number;
  maxFalseDeleteRate: number;
  minDeleteRecall: number;
  maxPositiveIncompleteRate: number;
  maxNegativeIncompleteRate: number;
  maxUnlabeledImageScriptCases: number;
  maxUnlabeledCaptionLanguageCases: number;
  requiredHardNegativeCategories: Readonly<Record<string, CommercialOcrEvalHardNegativeGate>>;
  maxHardNegativeFalseDeletes: number;
};

const REQUIRED_HARD_NEGATIVE_CATEGORIES = {
  rules_or_moderation_context: { minCases: 25, minClusters: 10 },
  spam_complaint_or_fraud_warning: { minCases: 25, minClusters: 10 },
  news_or_analytics: { minCases: 25, minClusters: 10 },
  brand_mention_only: { minCases: 25, minClusters: 10 },
  private_one_off_sale: { minCases: 25, minClusters: 10 },
  ordinary_recruitment: { minCases: 25, minClusters: 10 },
  public_training_or_help: { minCases: 25, minClusters: 10 },
  request_or_recommendation: { minCases: 25, minClusters: 10 },
} as const satisfies Readonly<Record<string, CommercialOcrEvalHardNegativeGate>>;

export const COMMERCIAL_OCR_CYRILLIC_ENFORCEMENT_GATES: CommercialOcrEvalGateProfile = {
  minTotal: 2_000,
  minDeleteCases: 500,
  minNoActionCases: 1_500,
  minClusters: 400,
  maxFalseDeleteRate: 0.001,
  minDeleteRecall: 0.95,
  maxPositiveIncompleteRate: 0.01,
  maxNegativeIncompleteRate: 0.01,
  maxUnlabeledImageScriptCases: 0,
  maxUnlabeledCaptionLanguageCases: 0,
  requiredHardNegativeCategories: REQUIRED_HARD_NEGATIVE_CATEGORIES,
  maxHardNegativeFalseDeletes: 0,
};

export const COMMERCIAL_OCR_RU_ENFORCEMENT_GATES = COMMERCIAL_OCR_CYRILLIC_ENFORCEMENT_GATES;

export function evaluateCommercialOcrEvalGates(
  report: CommercialOcrEvalReport,
  profile: CommercialOcrEvalGateProfile = COMMERCIAL_OCR_CYRILLIC_ENFORCEMENT_GATES,
): { passed: boolean; failures: string[] } {
  const cohortCases = report.cases.filter((item) => item.imageTextScript === 'cyrillic_only');
  const deleteCases = cohortCases.filter((item) => item.expectedAction === 'DELETE');
  const noActionCases = cohortCases.filter((item) => item.expectedAction === 'NO_ACTION');
  const actualDeletes = deleteCases.filter((item) => item.actualAction === 'DELETE').length;
  const falseDeletes = noActionCases.filter((item) => item.actualAction === 'DELETE').length;
  const incompletePositive = deleteCases.filter(
    (item) => item.actualAction === 'INCOMPLETE',
  ).length;
  const incompleteNegative = noActionCases.filter(
    (item) => item.actualAction === 'INCOMPLETE',
  ).length;
  const cohortClusters = new Set(cohortCases.map((item) => item.clusterId)).size;
  const falseDeleteRate = ratio(falseDeletes, noActionCases.length);
  const deleteRecall = ratio(actualDeletes, deleteCases.length);
  const positiveIncompleteRate = ratio(incompletePositive, deleteCases.length);
  const negativeIncompleteRate = ratio(incompleteNegative, noActionCases.length);
  const unlabeledImageScriptCases = report.cases.filter(
    (item) => item.imageTextScript === undefined,
  ).length;
  const unlabeledCaptionLanguageCases = report.cases.filter(
    (item) => item.captionLanguage === undefined,
  ).length;
  const hardNegativeCases = cohortCases.filter((item) => item.hardNegativeCategory !== undefined);
  const hardNegativeFalseDeletes = hardNegativeCases.filter(
    (item) => item.actualAction === 'DELETE',
  ).length;
  const failures: string[] = [];

  requireMinimum(failures, 'Cyrillic-only total cases', cohortCases.length, profile.minTotal);
  requireMinimum(
    failures,
    'Cyrillic-only delete cases',
    deleteCases.length,
    profile.minDeleteCases,
  );
  requireMinimum(
    failures,
    'Cyrillic-only no-action cases',
    noActionCases.length,
    profile.minNoActionCases,
  );
  requireMinimum(failures, 'Cyrillic-only distinct clusters', cohortClusters, profile.minClusters);
  requireMaximum(
    failures,
    'Cyrillic-only false-delete rate',
    falseDeleteRate,
    profile.maxFalseDeleteRate,
  );
  requireMinimum(failures, 'Cyrillic-only delete recall', deleteRecall, profile.minDeleteRecall);
  requireMaximum(
    failures,
    'Cyrillic-only positive incomplete rate',
    positiveIncompleteRate,
    profile.maxPositiveIncompleteRate,
  );
  requireMaximum(
    failures,
    'Cyrillic-only negative incomplete rate',
    negativeIncompleteRate,
    profile.maxNegativeIncompleteRate,
  );
  requireMaximum(
    failures,
    'Unlabeled image-script cases',
    unlabeledImageScriptCases,
    profile.maxUnlabeledImageScriptCases,
  );
  requireMaximum(
    failures,
    'Unlabeled caption-language cases',
    unlabeledCaptionLanguageCases,
    profile.maxUnlabeledCaptionLanguageCases,
  );
  requireMaximum(
    failures,
    'Cyrillic-only hard-negative false deletes',
    hardNegativeFalseDeletes,
    profile.maxHardNegativeFalseDeletes,
  );

  for (const [category, categoryGate] of Object.entries(
    profile.requiredHardNegativeCategories,
  ).sort(([left], [right]) => left.localeCompare(right))) {
    const categoryCases = hardNegativeCases.filter(
      (item) => item.hardNegativeCategory === category,
    );
    const categoryClusters = new Set(categoryCases.map((item) => item.clusterId)).size;
    requireMinimum(
      failures,
      `Cyrillic-only hard-negative ${category} cases`,
      categoryCases.length,
      categoryGate.minCases,
    );
    requireMinimum(
      failures,
      `Cyrillic-only hard-negative ${category} distinct clusters`,
      categoryClusters,
      categoryGate.minClusters,
    );
  }

  return { passed: failures.length === 0, failures };
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

function format(value: number): string {
  return Number.isFinite(value) ? String(Math.round(value * 100_000) / 100_000) : 'unavailable';
}
