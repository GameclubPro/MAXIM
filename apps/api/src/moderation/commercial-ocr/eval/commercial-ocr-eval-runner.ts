import { ConfigService } from '@nestjs/config';
import type { ChatSettings } from '../../../prisma/prisma-client';
import { deriveCommercialOcrCriticalEvidence } from '../commercial-ocr-evidence';
import {
  evaluateCommercialOcrDecision,
  isCommercialOcrCyrillicOnlyDeleteDecision,
  type CommercialOcrDecision,
  type CommercialOcrPass,
} from '../commercial-ocr-decision-policy';
import { CommercialOcrPreprocessor } from '../commercial-ocr-preprocessor';
import { runNativeTesseract } from '../native-tesseract-runner';
import type { NativeTesseractPageSegmentationMode } from '../native-tesseract-ocr.types';
import {
  loadCommercialOcrEvalManifest,
  readVerifiedCommercialOcrEvalImage,
  type CommercialOcrEvalCase,
} from './commercial-ocr-eval.schema';

const DEFAULT_MAX_IMAGE_BYTES = 16 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const DEFAULT_EVAL_CONCURRENCY = 1;
const MAX_EVAL_CONCURRENCY = 4;

export type CommercialOcrEvalCaseResult = {
  id: string;
  clusterId: string;
  language: 'ru' | 'en' | 'mixed';
  imageTextScript?: 'cyrillic_only' | 'latin_only' | 'mixed' | 'unknown';
  captionLanguage?: 'none' | 'ru' | 'en' | 'mixed' | 'other' | 'unknown';
  category: string;
  hardNegativeCategory?: string;
  expectedAction: 'DELETE' | 'NO_ACTION';
  actualAction: 'DELETE' | 'NO_ACTION' | 'INCOMPLETE';
  passed: boolean;
  durationMs: number;
  reasonCodes: string[];
};

export type CommercialOcrEvalReport = {
  schemaVersion: 1;
  corpusId: string;
  corpusRevision: string;
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
  languages: Record<'ru' | 'en' | 'mixed', CommercialOcrEvalSlice>;
  categories: Record<string, CommercialOcrEvalSlice>;
  clusters: CommercialOcrEvalClusterResult[];
  cases: CommercialOcrEvalCaseResult[];
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
  expectedAction: 'DELETE' | 'NO_ACTION';
  passed: boolean;
};

export async function runCommercialOcrEval(params: {
  manifestPath: string;
  config?: ConfigService;
  concurrency?: number;
}): Promise<CommercialOcrEvalReport> {
  const startedAt = performance.now();
  const config = params.config ?? new ConfigService(process.env);
  const concurrency = readEvalConcurrency(params.concurrency);
  const { manifest, corpusRoot } = await loadCommercialOcrEvalManifest(params.manifestPath);
  const preprocessor = new CommercialOcrPreprocessor(config);
  const cases = await mapCommercialOcrEvalWithConcurrency(
    manifest.cases,
    concurrency,
    async (fixture) => evaluateCase({ fixture, corpusRoot, preprocessor, config }),
  );
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
        expectedAction: clusterCases[0]!.expectedAction,
        passed: clusterCases.every((item) => item.passed),
        ...summary,
      };
    });
  return {
    schemaVersion: 1,
    corpusId: manifest.corpusId,
    corpusRevision: manifest.corpusRevision,
    generatedAt: new Date().toISOString(),
    total: cases.length,
    passed: cases.filter((item) => item.passed).length,
    failed: cases.filter((item) => !item.passed).length,
    falseDeletes,
    missedDeletes,
    incomplete,
    incompleteExpectedDelete,
    incompleteExpectedNoAction,
    durationMs: roundMs(performance.now() - startedAt),
    languages,
    categories,
    clusters,
    cases,
  };
}

async function evaluateCase(params: {
  fixture: CommercialOcrEvalCase;
  corpusRoot: string;
  preprocessor: CommercialOcrPreprocessor;
  config: ConfigService;
}): Promise<CommercialOcrEvalCaseResult> {
  const startedAt = performance.now();
  const images: Array<{
    imageIndex: number;
    source: 'direct';
    primary: CommercialOcrPass;
    verification: CommercialOcrPass;
  }> = [];
  for (let imageIndex = 0; imageIndex < params.fixture.images.length; imageIndex += 1) {
    const imageFixture = params.fixture.images[imageIndex]!;
    const raw = await readVerifiedCommercialOcrEvalImage({
      corpusRoot: params.corpusRoot,
      image: imageFixture,
      maxBytes: readBoundedInt(
        params.config.get('COMMERCIAL_OCR_TESSERACT_MAX_IMAGE_BYTES'),
        DEFAULT_MAX_IMAGE_BYTES,
        1_024,
        64 * 1024 * 1024,
      ),
    });
    try {
      const primary = await recognizePass(params.preprocessor, params.config, raw, 'primary', 11);
      const verification = await recognizePass(
        params.preprocessor,
        params.config,
        raw,
        'confirmation',
        6,
      );
      if (!primary || !verification) {
        return result(params.fixture, 'INCOMPLETE', [], startedAt);
      }
      images.push({ imageIndex, source: 'direct', primary, verification });
    } catch {
      return result(params.fixture, 'INCOMPLETE', [], startedAt);
    }
  }
  const decision = evaluateCommercialOcrDecision({
    caption: params.fixture.caption,
    expectedImageCount: params.fixture.images.length,
    images,
    settings: EVAL_SETTINGS,
  });
  const enforcementAction = isCommercialOcrCyrillicOnlyDeleteDecision(decision)
    ? 'DELETE'
    : 'NO_ACTION';
  return result(
    params.fixture,
    enforcementAction,
    decision.action === 'DELETE' && enforcementAction === 'NO_ACTION'
      ? [...decision.reasonCodes, 'runtime-report-only-language']
      : decision.reasonCodes,
    startedAt,
    decision,
  );
}

async function recognizePass(
  preprocessor: CommercialOcrPreprocessor,
  config: ConfigService,
  raw: Buffer,
  pass: 'primary' | 'confirmation',
  psm: NativeTesseractPageSegmentationMode,
): Promise<CommercialOcrPass | null> {
  const prepared = await preprocessor.prepare(raw, pass);
  const native = await runNativeTesseract({
    binary: readString(config.get('COMMERCIAL_OCR_TESSERACT_BINARY'), 'tesseract'),
    tessdataPrefix: readOptionalString(config.get('COMMERCIAL_OCR_TESSDATA_PREFIX')),
    image: prepared.bytes,
    psm,
    timeoutMs: readBoundedInt(
      config.get('COMMERCIAL_OCR_TESSERACT_TIMEOUT_MS'),
      DEFAULT_TIMEOUT_MS,
      250,
      60_000,
    ),
    maxOutputBytes: readBoundedInt(
      config.get('COMMERCIAL_OCR_TESSERACT_MAX_OUTPUT_BYTES'),
      DEFAULT_MAX_OUTPUT_BYTES,
      64 * 1024,
      16 * 1024 * 1024,
    ),
  });
  if (!native.ok || native.payload.truncated) {
    return null;
  }
  const text = native.payload.text;
  const confidencePermille = Math.max(
    0,
    Math.min(1_000, Math.round((native.payload.aggregateConfidence ?? 0) * 10)),
  );
  return {
    status: text ? 'recognized' : 'no_text',
    text,
    confidencePermille,
    criticalEvidence: deriveCommercialOcrCriticalEvidence({
      text,
      words: native.payload.words.map((word) => ({
        text: word.text,
        start: word.start,
        end: word.end,
        confidencePermille: Math.max(0, Math.min(1_000, Math.round(word.confidence * 10))),
      })),
    }),
  };
}

function result(
  fixture: CommercialOcrEvalCase,
  actualAction: CommercialOcrEvalCaseResult['actualAction'],
  reasonCodes: string[],
  startedAt: number,
  _decision?: CommercialOcrDecision,
): CommercialOcrEvalCaseResult {
  return {
    id: fixture.id,
    clusterId: fixture.clusterId,
    language: fixture.language,
    imageTextScript: fixture.imageTextScript,
    captionLanguage: fixture.captionLanguage,
    category: fixture.category,
    hardNegativeCategory: fixture.hardNegativeCategory,
    expectedAction: fixture.expectedAction,
    actualAction,
    passed: actualAction === fixture.expectedAction,
    durationMs: roundMs(performance.now() - startedAt),
    reasonCodes,
  };
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

function readBoundedInt(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

function readString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
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

const EVAL_SETTINGS = {
  commercialAdsFilterEnabled: true,
  commercialAdsSensitivity: 'BALANCED',
  commercialAdsWarnThreshold: 45,
  commercialAdsDeleteThreshold: 65,
  nightModeTimezone: 'Europe/Moscow',
} as ChatSettings;
