import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import type { CommercialDetection } from '../moderation/commercial/commercial-ad.detector';
import { readCommercialManualOverlayEvaluatorCliOptions } from './evaluate-commercial-manual-overlay';
import {
  evaluateCommercialManualOverlay,
  type CommercialManualOverlayDetector,
  type CommercialManualOverlayEvaluationRecord,
} from './commercial-manual-overlay-evaluator.util';
import {
  COMMERCIAL_MANUAL_OVERLAY_SCHEMA_VERSION,
  fingerprintCommercialManualOverlayContext,
  type CommercialManualOverlayCampaignContext,
  type CommercialManualOverlayRecord,
  type CommercialManualOverlaySettings,
  type CommercialManualRecommendedAction,
} from './commercial-manual-overlay.util';
import { withCommercialOutputLocks } from './commercial-output-lock.util';

type TestCorpusRecord = {
  text: string;
  category: 'stable_clear';
  settings: CommercialManualOverlaySettings;
  commercialCampaignContext: CommercialManualOverlayCampaignContext | null;
};

const DEFAULT_SETTINGS: CommercialManualOverlaySettings = {
  commercialAdsSensitivity: 'BALANCED',
  commercialAdsWarnThreshold: 45,
  commercialAdsDeleteThreshold: 65,
};

const DEFAULT_CONTEXT: CommercialManualOverlayCampaignContext = {
  senderDistinctChatCount: 1,
  sameTextDistinctChatCount: 0,
  repeatedPhoneDistinctChatCount: 0,
  repeatedLinkDistinctChatCount: 0,
};

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function jsonl(records: readonly unknown[]): string {
  return `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
}

function actionAdjudicationTsv(
  rows: readonly {
    textSha256: string;
    instances: number;
    sourceManualLabel: string;
    adjudicatedClass: string;
    recommendedAction: string;
    reasonCode: string;
  }[],
): string {
  const header =
    'text_sha256\tinstances\tsource_manual_label\tadjudicated_class\trecommended_action\treason_code';
  return `${[
    header,
    ...rows.map((row) =>
      [
        row.textSha256,
        row.instances,
        row.sourceManualLabel,
        row.adjudicatedClass,
        row.recommendedAction,
        row.reasonCode,
      ].join('\t'),
    ),
  ].join('\n')}\n`;
}

function corpusRecord(params: {
  text: string;
  settings?: CommercialManualOverlaySettings;
  commercialCampaignContext?: CommercialManualOverlayCampaignContext | null;
}): TestCorpusRecord {
  return {
    text: params.text,
    category: 'stable_clear',
    settings: params.settings ?? { ...DEFAULT_SETTINGS },
    commercialCampaignContext:
      params.commercialCampaignContext === undefined
        ? { ...DEFAULT_CONTEXT }
        : params.commercialCampaignContext,
  };
}

function overlayRecord(params: {
  inputSha256: string;
  line: number;
  corpusRecord: TestCorpusRecord;
  manualLabel: string;
  recommendedAction: CommercialManualRecommendedAction | null;
}): CommercialManualOverlayRecord {
  const settings = { ...params.corpusRecord.settings };
  const commercialCampaignContext = params.corpusRecord.commercialCampaignContext
    ? { ...params.corpusRecord.commercialCampaignContext }
    : null;
  return {
    schemaVersion: COMMERCIAL_MANUAL_OVERLAY_SCHEMA_VERSION,
    inputSha256: params.inputSha256,
    line: params.line,
    textSha256: sha256(params.corpusRecord.text),
    manualLabel: params.manualLabel,
    confidence: 'high',
    recommendedAction: params.recommendedAction,
    sourceFiles: [`review-${params.manualLabel}.tsv`],
    settings,
    commercialCampaignContext,
    contextFingerprint: fingerprintCommercialManualOverlayContext(
      settings,
      commercialCampaignContext,
    ),
  };
}

function commercialDetection(
  actionBand: 'REVIEW_ONLY' | 'WARN' | 'DELETE' | 'DELETE_AND_ESCALATE',
): CommercialDetection {
  const confidenceScore =
    actionBand === 'REVIEW_ONLY'
      ? 45
      : actionBand === 'WARN'
        ? 60
        : actionBand === 'DELETE'
          ? 85
          : 100;
  return {
    rawText: 'test',
    confidenceScore,
    decisionBand: confidenceScore < 65 ? 'MEDIUM' : 'HIGH',
    matchedSignals: [`signal:${actionBand}`],
    negativeSignals: ['safe:test'],
    primarySubtype: 'SERVICES',
    supportingSubtypes: [],
    evidenceStrength: 'DIRECT',
    reviewRecommended: true,
    reviewReasons: ['review:test'],
    campaignContext: null,
    appliedThresholds: {
      warnThreshold: 45,
      deleteThreshold: 65,
      sensitivity: 'BALANCED',
      strictness: 0,
    },
    classifierVersion: null,
    commercialProbability: null,
    reviewProbability: null,
    classifierReasons: ['classifier:test'],
    score: confidenceScore,
    actionScore: confidenceScore,
    fpRisk: 10,
    evidenceTier: 'DIRECT',
    subtype: 'SERVICES',
    actionBand,
    reviewPriority: 'HIGH',
    campaignStrength: 'NONE',
    safeContextBucket: 'test-safe-context',
    actionable: true,
    recordable: true,
    deleteSuppressed: false,
    suppressionReasons: ['suppression:test'],
    reasonCodes: ['reason:test'],
    featureVector: { commercialIntent: 1 },
  } as CommercialDetection;
}

async function expectMissing(pathname: string): Promise<void> {
  await expect(readFile(pathname, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
}

async function writeSingleRecordFixture(directory: string) {
  const inputPath = join(directory, 'corpus.jsonl');
  const overlayPath = join(directory, 'overlay.jsonl');
  const actionAdjudicationPath = join(directory, 'action-adjudication.tsv');
  const resultsOutputPath = join(directory, 'results.jsonl');
  const record = corpusRecord({ text: 'Одна поездка для ручного решения' });
  const corpusBody = jsonl([record]);
  const overlay = overlayRecord({
    inputSha256: sha256(corpusBody),
    line: 1,
    corpusRecord: record,
    manualLabel: 'transport_offer',
    recommendedAction: 'WARN',
  });
  await writeFile(inputPath, corpusBody, 'utf8');
  await writeFile(overlayPath, jsonl([overlay]), 'utf8');
  return {
    inputPath,
    overlayPath,
    actionAdjudicationPath,
    allowPartialActionAdjudication: true,
    resultsOutputPath,
    record,
  };
}

describe('commercial manual overlay evaluator', () => {
  it('replays every annotated instance with exact corpus context and summarizes rank comparisons', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'commercial-overlay-evaluator-'));
    const inputPath = join(directory, 'corpus.jsonl');
    const overlayPath = join(directory, 'overlay.jsonl');
    const resultsPath = join(directory, 'results.jsonl');
    const summaryPath = join(directory, 'summary.json');
    const records = [
      corpusRecord({ text: 'exact allow' }),
      corpusRecord({
        text: 'under delete',
        settings: {
          commercialAdsSensitivity: 'STRICT',
          commercialAdsWarnThreshold: 60,
          commercialAdsDeleteThreshold: 80,
        },
        commercialCampaignContext: {
          ...DEFAULT_CONTEXT,
          senderDistinctChatCount: 2,
          nearTextDistinctChatCount: 3,
        },
      }),
      corpusRecord({
        text: 'over warn',
        settings: {
          commercialAdsSensitivity: 'BALANCED',
          commercialAdsWarnThreshold: 50,
          commercialAdsDeleteThreshold: 70,
        },
        commercialCampaignContext: null,
      }),
      corpusRecord({
        text: 'unspecified escalate',
        settings: {
          commercialAdsSensitivity: 'STRICT',
          commercialAdsWarnThreshold: 30,
          commercialAdsDeleteThreshold: 55,
        },
        commercialCampaignContext: {
          ...DEFAULT_CONTEXT,
          repeatedDomainDistinctChatCount: 4,
          senderDistinctChatCount30m: 5,
        },
      }),
    ];
    const corpusBody = jsonl(records);
    const inputSha256 = sha256(corpusBody);
    const overlayRecords = [
      overlayRecord({
        inputSha256,
        line: 1,
        corpusRecord: records[0],
        manualLabel: 'legitimate',
        recommendedAction: 'ALLOW',
      }),
      overlayRecord({
        inputSha256,
        line: 2,
        corpusRecord: records[1],
        manualLabel: 'strong_ad',
        recommendedAction: 'DELETE_AND_ESCALATE',
      }),
      overlayRecord({
        inputSha256,
        line: 3,
        corpusRecord: records[2],
        manualLabel: 'review_only',
        recommendedAction: 'REVIEW_ONLY',
      }),
      overlayRecord({
        inputSha256,
        line: 4,
        corpusRecord: records[3],
        manualLabel: 'disputed',
        recommendedAction: null,
      }),
    ];
    const overlayBody = jsonl(overlayRecords);
    const detect = jest.fn<
      ReturnType<CommercialManualOverlayDetector['detect']>,
      Parameters<CommercialManualOverlayDetector['detect']>
    >(({ rawLoweredText }) => {
      if (rawLoweredText.includes('under delete')) {
        return commercialDetection('DELETE');
      }
      if (rawLoweredText.includes('over warn')) {
        return commercialDetection('WARN');
      }
      if (rawLoweredText.includes('unspecified escalate')) {
        return commercialDetection('DELETE_AND_ESCALATE');
      }
      return null;
    });

    await writeFile(inputPath, corpusBody, 'utf8');
    await writeFile(overlayPath, overlayBody, 'utf8');

    try {
      const summary = await evaluateCommercialManualOverlay({
        inputPath,
        overlayPath,
        resultsOutputPath: resultsPath,
        summaryOutputPath: summaryPath,
        detector: { detect },
      });
      const resultsBody = await readFile(resultsPath, 'utf8');
      const evaluations = resultsBody
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as CommercialManualOverlayEvaluationRecord);
      const storedSummary = JSON.parse(await readFile(summaryPath, 'utf8')) as unknown;

      expect(detect).toHaveBeenCalledTimes(4);
      expect(
        detect.mock.calls.map(([params]) => ({
          settings: params.settings,
          commercialCampaignContext: params.commercialCampaignContext,
        })),
      ).toEqual(
        records.map((record) => ({
          settings: {
            commercialAdsFilterEnabled: true,
            ...record.settings,
          },
          commercialCampaignContext: record.commercialCampaignContext,
        })),
      );
      expect(evaluations).toHaveLength(4);
      expect(evaluations.map((evaluation) => evaluation.line)).toEqual([1, 2, 3, 4]);
      expect(evaluations.map((evaluation) => evaluation.recommendationComparison)).toEqual([
        'EXACT',
        'UNDER',
        'OVER',
        'UNSPECIFIED',
      ]);
      expect(evaluations[1].replayed).toEqual(
        expect.objectContaining({
          hit: true,
          action: 'DELETE',
          actionScore: 85,
          confidenceScore: 85,
          subtype: 'SERVICES',
          primarySubtype: 'SERVICES',
          matchedSignals: ['signal:DELETE'],
          negativeSignals: ['safe:test'],
          classifierReasons: ['classifier:test'],
          reviewRecommended: true,
          reviewReasons: ['review:test'],
          reasonCodes: ['reason:test'],
          safeContextBucket: 'test-safe-context',
          deleteSuppressed: false,
          suppressionReasons: ['suppression:test'],
        }),
      );
      expect(evaluations[3]).toEqual(
        expect.objectContaining({
          text: 'unspecified escalate',
          manualLabel: 'disputed',
          confidence: 'high',
          baseRecommendedAction: null,
          recommendedAction: null,
          actionAdjudication: null,
          sourceFiles: ['review-disputed.tsv'],
        }),
      );
      expect(summary).toEqual(
        expect.objectContaining({
          input: expect.objectContaining({
            corpusSha256: inputSha256,
            corpusRecords: 4,
            overlaySha256: sha256(overlayBody),
            overlayRecords: 4,
            actionAdjudication: null,
          }),
          output: expect.objectContaining({
            resultsSha256: sha256(resultsBody),
            records: 4,
          }),
          manualLabelCounts: {
            disputed: 1,
            legitimate: 1,
            review_only: 1,
            strong_ad: 1,
          },
          replayedActionCounts: {
            DELETE: 1,
            DELETE_AND_ESCALATE: 1,
            NONE: 1,
            WARN: 1,
          },
          recommendedActionCoverage: {
            specified: 3,
            unspecified: 1,
            byAction: {
              ALLOW: 1,
              DELETE_AND_ESCALATE: 1,
              REVIEW_ONLY: 1,
            },
          },
          recommendationRankComparison: {
            exact: 1,
            under: 1,
            over: 1,
            unspecified: 1,
          },
          recommendedActionTransitions: {
            'ALLOW->NONE': 1,
            'DELETE_AND_ESCALATE->DELETE': 1,
            'REVIEW_ONLY->WARN': 1,
            'UNSPECIFIED->DELETE_AND_ESCALATE': 1,
          },
        }),
      );
      expect(storedSummary).toEqual(summary);
      expect((await stat(resultsPath)).mode & 0o777).toBe(0o600);
      expect((await stat(summaryPath)).mode & 0o777).toBe(0o600);

      await expect(
        evaluateCommercialManualOverlay({
          inputPath,
          overlayPath,
          resultsOutputPath: resultsPath,
          summaryOutputPath: summaryPath,
          detector: { detect },
        }),
      ).rejects.toThrow(`Output already exists: ${resultsPath}`);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('applies a hash-bound action adjudication to every matching overlay instance', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'commercial-overlay-adjudication-'));
    const inputPath = join(directory, 'corpus.jsonl');
    const overlayPath = join(directory, 'overlay.jsonl');
    const actionAdjudicationPath = join(directory, 'transport-actions.tsv');
    const resultsPath = join(directory, 'results.jsonl');
    const summaryPath = join(directory, 'summary.json');
    const repeatedText = 'Едем вместе в аэропорт, есть два места';
    const records = [
      corpusRecord({ text: repeatedText }),
      corpusRecord({ text: repeatedText }),
      corpusRecord({ text: 'Магазин предлагает доставку товаров' }),
    ];
    const corpusBody = jsonl(records);
    const inputSha256 = sha256(corpusBody);
    const overlayBody = jsonl([
      overlayRecord({
        inputSha256,
        line: 1,
        corpusRecord: records[0],
        manualLabel: 'transport_offer',
        recommendedAction: 'WARN',
      }),
      overlayRecord({
        inputSha256,
        line: 2,
        corpusRecord: records[1],
        manualLabel: 'transport_offer',
        recommendedAction: 'REVIEW_ONLY',
      }),
      overlayRecord({
        inputSha256,
        line: 3,
        corpusRecord: records[2],
        manualLabel: 'retail_offer',
        recommendedAction: 'DELETE',
      }),
    ]);
    const adjudicationBody = actionAdjudicationTsv([
      {
        textSha256: sha256(repeatedText),
        instances: 2,
        sourceManualLabel: 'transport_offer',
        adjudicatedClass: 'B',
        recommendedAction: 'ALLOW',
        reasonCode: 'private_rideshare',
      },
    ]);
    await writeFile(inputPath, corpusBody, 'utf8');
    await writeFile(overlayPath, overlayBody, 'utf8');
    await writeFile(actionAdjudicationPath, adjudicationBody, 'utf8');
    const actionAdjudicationExpected = {
      sha256: sha256(adjudicationBody),
      records: 1,
      instances: 2,
    };

    try {
      const summary = await evaluateCommercialManualOverlay({
        inputPath,
        overlayPath,
        actionAdjudicationPath,
        actionAdjudicationExpected,
        resultsOutputPath: resultsPath,
        summaryOutputPath: summaryPath,
        detector: { detect: () => commercialDetection('WARN') },
      });
      const evaluations = (await readFile(resultsPath, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as CommercialManualOverlayEvaluationRecord);

      expect(evaluations.map((evaluation) => evaluation.baseRecommendedAction)).toEqual([
        'WARN',
        'REVIEW_ONLY',
        'DELETE',
      ]);
      expect(evaluations.map((evaluation) => evaluation.recommendedAction)).toEqual([
        'ALLOW',
        'ALLOW',
        'DELETE',
      ]);
      expect(evaluations.slice(0, 2).map((evaluation) => evaluation.actionAdjudication)).toEqual([
        { adjudicatedClass: 'B', reasonCode: 'private_rideshare' },
        { adjudicatedClass: 'B', reasonCode: 'private_rideshare' },
      ]);
      expect(evaluations[2].actionAdjudication).toBeNull();
      expect(summary.input.actionAdjudication).toEqual({
        path: resolve(actionAdjudicationPath),
        sha256: sha256(adjudicationBody),
        records: 1,
        instances: 2,
        expected: actionAdjudicationExpected,
      });
      expect(summary.recommendedActionCoverage).toEqual({
        specified: 3,
        unspecified: 0,
        byAction: { ALLOW: 2, DELETE: 1 },
      });
      expect(await readFile(overlayPath, 'utf8')).toBe(overlayBody);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects an action adjudication hash missing from the base overlay', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'commercial-overlay-adjudication-unknown-'));
    try {
      const fixture = await writeSingleRecordFixture(directory);
      await writeFile(
        fixture.actionAdjudicationPath,
        actionAdjudicationTsv([
          {
            textSha256: sha256('unknown text'),
            instances: 1,
            sourceManualLabel: 'transport_offer',
            adjudicatedClass: 'A',
            recommendedAction: 'WARN',
            reasonCode: 'unknown_hash',
          },
        ]),
        'utf8',
      );

      await expect(
        evaluateCommercialManualOverlay({
          ...fixture,
          detector: { detect: () => null },
        }),
      ).rejects.toThrow('is not present in the base overlay');
      await expectMissing(fixture.resultsOutputPath);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects an action adjudication instance count mismatch', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'commercial-overlay-adjudication-count-'));
    try {
      const fixture = await writeSingleRecordFixture(directory);
      await writeFile(
        fixture.actionAdjudicationPath,
        actionAdjudicationTsv([
          {
            textSha256: sha256(fixture.record.text),
            instances: 2,
            sourceManualLabel: 'transport_offer',
            adjudicatedClass: 'B',
            recommendedAction: 'ALLOW',
            reasonCode: 'count_mismatch',
          },
        ]),
        'utf8',
      );

      await expect(
        evaluateCommercialManualOverlay({
          ...fixture,
          detector: { detect: () => null },
        }),
      ).rejects.toThrow('instances 2 does not match base overlay count 1');
      await expectMissing(fixture.resultsOutputPath);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects an action adjudication manual-label mismatch', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'commercial-overlay-adjudication-label-'));
    try {
      const fixture = await writeSingleRecordFixture(directory);
      await writeFile(
        fixture.actionAdjudicationPath,
        actionAdjudicationTsv([
          {
            textSha256: sha256(fixture.record.text),
            instances: 1,
            sourceManualLabel: 'ambiguous_transport_offer',
            adjudicatedClass: 'C',
            recommendedAction: 'REVIEW_ONLY',
            reasonCode: 'label_mismatch',
          },
        ]),
        'utf8',
      );

      await expect(
        evaluateCommercialManualOverlay({
          ...fixture,
          detector: { detect: () => null },
        }),
      ).rejects.toThrow('does not match base overlay label(s) transport_offer');
      await expectMissing(fixture.resultsOutputPath);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects duplicate hashes in an action adjudication', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'commercial-overlay-adjudication-duplicate-'));
    try {
      const fixture = await writeSingleRecordFixture(directory);
      const row = {
        textSha256: sha256(fixture.record.text),
        instances: 1,
        sourceManualLabel: 'transport_offer',
        adjudicatedClass: 'A',
        recommendedAction: 'WARN',
        reasonCode: 'private_ride',
      };
      await writeFile(fixture.actionAdjudicationPath, actionAdjudicationTsv([row, row]), 'utf8');

      await expect(
        evaluateCommercialManualOverlay({
          ...fixture,
          detector: { detect: () => null },
        }),
      ).rejects.toThrow('duplicate text_sha256');
      await expectMissing(fixture.resultsOutputPath);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects actions outside the adjudication action set', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'commercial-overlay-adjudication-action-'));
    try {
      const fixture = await writeSingleRecordFixture(directory);
      await writeFile(
        fixture.actionAdjudicationPath,
        actionAdjudicationTsv([
          {
            textSha256: sha256(fixture.record.text),
            instances: 1,
            sourceManualLabel: 'transport_offer',
            adjudicatedClass: 'A',
            recommendedAction: 'DELETE',
            reasonCode: 'unsupported_action',
          },
        ]),
        'utf8',
      );

      await expect(
        evaluateCommercialManualOverlay({
          ...fixture,
          detector: { detect: () => null },
        }),
      ).rejects.toThrow('recommended_action must be ALLOW, WARN, or REVIEW_ONLY');
      await expectMissing(fixture.resultsOutputPath);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects an adjudication action that does not match its class', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'commercial-overlay-adjudication-class-'));
    try {
      const fixture = await writeSingleRecordFixture(directory);
      await writeFile(
        fixture.actionAdjudicationPath,
        actionAdjudicationTsv([
          {
            textSha256: sha256(fixture.record.text),
            instances: 1,
            sourceManualLabel: 'transport_offer',
            adjudicatedClass: 'A',
            recommendedAction: 'ALLOW',
            reasonCode: 'invalid_class_action',
          },
        ]),
        'utf8',
      );

      await expect(
        evaluateCommercialManualOverlay({
          ...fixture,
          detector: { detect: () => null },
        }),
      ).rejects.toThrow('adjudicated_class A requires recommended_action WARN');
      await expectMissing(fixture.resultsOutputPath);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects free-form adjudication reasons and a mismatched frozen identity', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'commercial-overlay-adjudication-identity-'));
    try {
      const fixture = await writeSingleRecordFixture(directory);
      const invalidReasonBody = actionAdjudicationTsv([
        {
          textSha256: sha256(fixture.record.text),
          instances: 1,
          sourceManualLabel: 'transport_offer',
          adjudicatedClass: 'A',
          recommendedAction: 'WARN',
          reasonCode: 'phone_79991234567',
        },
      ]);
      await writeFile(fixture.actionAdjudicationPath, invalidReasonBody, 'utf8');
      await expect(
        evaluateCommercialManualOverlay({
          ...fixture,
          detector: { detect: () => null },
        }),
      ).rejects.toThrow('reason_code must contain lowercase words separated by underscores');

      const validBody = actionAdjudicationTsv([
        {
          textSha256: sha256(fixture.record.text),
          instances: 1,
          sourceManualLabel: 'transport_offer',
          adjudicatedClass: 'A',
          recommendedAction: 'WARN',
          reasonCode: 'explicit_service',
        },
      ]);
      await writeFile(fixture.actionAdjudicationPath, validBody, 'utf8');
      await expect(
        evaluateCommercialManualOverlay({
          ...fixture,
          allowPartialActionAdjudication: false,
          actionAdjudicationExpected: {
            sha256: '0'.repeat(64),
            records: 1,
            instances: 1,
          },
          detector: { detect: () => null },
        }),
      ).rejects.toThrow('Action adjudication sha256 mismatch');
      await expectMissing(fixture.resultsOutputPath);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects a corpus whose full SHA changed outside annotated lines', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'commercial-overlay-corpus-sha-'));
    const inputPath = join(directory, 'corpus.jsonl');
    const overlayPath = join(directory, 'overlay.jsonl');
    const resultsPath = join(directory, 'results.jsonl');
    const record = corpusRecord({ text: 'annotated row' });
    const originalCorpusBody = jsonl([record]);
    const overlayBody = jsonl([
      overlayRecord({
        inputSha256: sha256(originalCorpusBody),
        line: 1,
        corpusRecord: record,
        manualLabel: 'commercial',
        recommendedAction: 'WARN',
      }),
    ]);
    await writeFile(
      inputPath,
      `${originalCorpusBody}${jsonl([corpusRecord({ text: 'unannotated appended row' })])}`,
      'utf8',
    );
    await writeFile(overlayPath, overlayBody, 'utf8');

    try {
      await expect(
        evaluateCommercialManualOverlay({
          inputPath,
          overlayPath,
          resultsOutputPath: resultsPath,
          detector: { detect: () => null },
        }),
      ).rejects.toThrow('Overlay inputSha256 mismatch');
      await expectMissing(resultsPath);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects duplicate overlay corpus lines', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'commercial-overlay-duplicate-'));
    const inputPath = join(directory, 'corpus.jsonl');
    const overlayPath = join(directory, 'overlay.jsonl');
    const resultsPath = join(directory, 'results.jsonl');
    const record = corpusRecord({ text: 'one row' });
    const corpusBody = jsonl([record]);
    const duplicate = overlayRecord({
      inputSha256: sha256(corpusBody),
      line: 1,
      corpusRecord: record,
      manualLabel: 'commercial',
      recommendedAction: 'WARN',
    });
    await writeFile(inputPath, corpusBody, 'utf8');
    await writeFile(overlayPath, jsonl([duplicate, duplicate]), 'utf8');

    try {
      await expect(
        evaluateCommercialManualOverlay({
          inputPath,
          overlayPath,
          resultsOutputPath: resultsPath,
          detector: { detect: () => null },
        }),
      ).rejects.toThrow('duplicate corpus line 1');
      await expectMissing(resultsPath);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects an overlay text hash that does not match the exact corpus row', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'commercial-overlay-text-sha-'));
    const inputPath = join(directory, 'corpus.jsonl');
    const overlayPath = join(directory, 'overlay.jsonl');
    const resultsPath = join(directory, 'results.jsonl');
    const record = corpusRecord({ text: 'original exact text' });
    const corpusBody = jsonl([record]);
    const overlay = overlayRecord({
      inputSha256: sha256(corpusBody),
      line: 1,
      corpusRecord: record,
      manualLabel: 'commercial',
      recommendedAction: 'WARN',
    });
    overlay.textSha256 = sha256('different text');
    await writeFile(inputPath, corpusBody, 'utf8');
    await writeFile(overlayPath, jsonl([overlay]), 'utf8');

    try {
      await expect(
        evaluateCommercialManualOverlay({
          inputPath,
          overlayPath,
          resultsOutputPath: resultsPath,
          detector: { detect: () => null },
        }),
      ).rejects.toThrow('Overlay textSha256 mismatch at corpus line 1');
      await expectMissing(resultsPath);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects corpus context drift even when the overlay SHA binding was updated', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'commercial-overlay-context-'));
    const inputPath = join(directory, 'corpus.jsonl');
    const overlayPath = join(directory, 'overlay.jsonl');
    const resultsPath = join(directory, 'results.jsonl');
    const record = corpusRecord({
      text: 'same text with changed context',
      commercialCampaignContext: {
        ...DEFAULT_CONTEXT,
        senderDistinctChatCount: 2,
      },
    });
    const staleContextRecord = corpusRecord({
      text: record.text,
      commercialCampaignContext: DEFAULT_CONTEXT,
    });
    const corpusBody = jsonl([record]);
    const overlay = overlayRecord({
      inputSha256: sha256(corpusBody),
      line: 1,
      corpusRecord: staleContextRecord,
      manualLabel: 'commercial',
      recommendedAction: 'WARN',
    });
    await writeFile(inputPath, corpusBody, 'utf8');
    await writeFile(overlayPath, jsonl([overlay]), 'utf8');

    try {
      await expect(
        evaluateCommercialManualOverlay({
          inputPath,
          overlayPath,
          resultsOutputPath: resultsPath,
          detector: { detect: () => null },
        }),
      ).rejects.toThrow('Overlay contextFingerprint mismatch at corpus line 1');
      await expectMissing(resultsPath);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects an overlay line outside the corpus', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'commercial-overlay-line-'));
    const inputPath = join(directory, 'corpus.jsonl');
    const overlayPath = join(directory, 'overlay.jsonl');
    const resultsPath = join(directory, 'results.jsonl');
    const record = corpusRecord({ text: 'only corpus row' });
    const corpusBody = jsonl([record]);
    const overlay = overlayRecord({
      inputSha256: sha256(corpusBody),
      line: 2,
      corpusRecord: record,
      manualLabel: 'commercial',
      recommendedAction: 'WARN',
    });
    await writeFile(inputPath, corpusBody, 'utf8');
    await writeFile(overlayPath, jsonl([overlay]), 'utf8');

    try {
      await expect(
        evaluateCommercialManualOverlay({
          inputPath,
          overlayPath,
          resultsOutputPath: resultsPath,
          detector: { detect: () => null },
        }),
      ).rejects.toThrow('Overlay lines not found in corpus: 2');
      await expectMissing(resultsPath);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('does not publish results when the summary output already exists', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'commercial-overlay-summary-'));
    const inputPath = join(directory, 'corpus.jsonl');
    const overlayPath = join(directory, 'overlay.jsonl');
    const resultsPath = join(directory, 'results.jsonl');
    const summaryPath = join(directory, 'summary.json');
    const record = corpusRecord({ text: 'one annotated row' });
    const corpusBody = jsonl([record]);
    const overlay = overlayRecord({
      inputSha256: sha256(corpusBody),
      line: 1,
      corpusRecord: record,
      manualLabel: 'commercial',
      recommendedAction: 'WARN',
    });
    await writeFile(inputPath, corpusBody, 'utf8');
    await writeFile(overlayPath, jsonl([overlay]), 'utf8');
    await writeFile(summaryPath, 'existing-summary\n', 'utf8');

    try {
      await expect(
        evaluateCommercialManualOverlay({
          inputPath,
          overlayPath,
          resultsOutputPath: resultsPath,
          summaryOutputPath: summaryPath,
          detector: { detect: () => commercialDetection('WARN') },
        }),
      ).rejects.toThrow(`Output already exists: ${summaryPath}`);
      await expectMissing(resultsPath);
      await expect(readFile(summaryPath, 'utf8')).resolves.toBe('existing-summary\n');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects absolute annotation source paths before they can reach results', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'commercial-overlay-source-privacy-'));
    const inputPath = join(directory, 'corpus.jsonl');
    const overlayPath = join(directory, 'overlay.jsonl');
    const resultsPath = join(directory, 'results.jsonl');
    const record = corpusRecord({ text: 'private source path' });
    const corpusBody = jsonl([record]);
    const overlay = overlayRecord({
      inputSha256: sha256(corpusBody),
      line: 1,
      corpusRecord: record,
      manualLabel: 'commercial',
      recommendedAction: 'WARN',
    });
    overlay.sourceFiles = ['/home/operator/private-review.tsv'];
    await writeFile(inputPath, corpusBody, 'utf8');
    await writeFile(overlayPath, jsonl([overlay]), 'utf8');

    try {
      await expect(
        evaluateCommercialManualOverlay({
          inputPath,
          overlayPath,
          resultsOutputPath: resultsPath,
          detector: { detect: () => commercialDetection('WARN') },
        }),
      ).rejects.toThrow('sourceFiles must contain logical basenames only');
      await expectMissing(resultsPath);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('keeps the previous output pair when a concurrent overwrite holds both locks', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'commercial-overlay-locked-overwrite-'));
    const inputPath = join(directory, 'corpus.jsonl');
    const overlayPath = join(directory, 'overlay.jsonl');
    const resultsPath = join(directory, 'results.jsonl');
    const summaryPath = join(directory, 'summary.json');
    const record = corpusRecord({ text: 'locked annotated row' });
    const corpusBody = jsonl([record]);
    const overlay = overlayRecord({
      inputSha256: sha256(corpusBody),
      line: 1,
      corpusRecord: record,
      manualLabel: 'commercial',
      recommendedAction: 'WARN',
    });
    await writeFile(inputPath, corpusBody, 'utf8');
    await writeFile(overlayPath, jsonl([overlay]), 'utf8');
    await writeFile(resultsPath, 'previous-results\n', 'utf8');
    await writeFile(summaryPath, 'previous-summary\n', 'utf8');

    let releaseLock!: () => void;
    const holdLock = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    let signalLocked!: () => void;
    const locked = new Promise<void>((resolve) => {
      signalLocked = resolve;
    });
    const competingWriter = withCommercialOutputLocks([resultsPath, summaryPath], async () => {
      signalLocked();
      await holdLock;
    });
    await locked;

    try {
      await expect(
        evaluateCommercialManualOverlay({
          inputPath,
          overlayPath,
          resultsOutputPath: resultsPath,
          summaryOutputPath: summaryPath,
          overwrite: true,
          detector: { detect: () => commercialDetection('WARN') },
        }),
      ).rejects.toThrow('Output is locked by another process');
      await expect(readFile(resultsPath, 'utf8')).resolves.toBe('previous-results\n');
      await expect(readFile(summaryPath, 'utf8')).resolves.toBe('previous-summary\n');
      expect((await readdir(directory)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    } finally {
      releaseLock();
      await competingWriter;
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('parses explicit paths and keeps overwrite opt-in', () => {
    expect(
      readCommercialManualOverlayEvaluatorCliOptions([
        '--input',
        'corpus.jsonl',
        '--overlay',
        'overlay.jsonl',
        '--action-adjudication',
        'transport-actions.tsv',
        '--action-adjudication-sha256',
        'a'.repeat(64),
        '--action-adjudication-records',
        '121',
        '--action-adjudication-instances',
        '214',
        '--output',
        'results.jsonl',
        '--summary-output',
        'summary.json',
        '--overwrite',
      ]),
    ).toEqual({
      inputPath: 'corpus.jsonl',
      overlayPath: 'overlay.jsonl',
      actionAdjudicationPath: 'transport-actions.tsv',
      actionAdjudicationExpected: {
        sha256: 'a'.repeat(64),
        records: 121,
        instances: 214,
      },
      allowPartialActionAdjudication: false,
      resultsOutputPath: 'results.jsonl',
      summaryOutputPath: 'summary.json',
      overwrite: true,
    });
    expect(
      readCommercialManualOverlayEvaluatorCliOptions([
        '--input',
        'corpus.jsonl',
        '--overlay',
        'overlay.jsonl',
        '--output',
        'results.jsonl',
      ]),
    ).toEqual({
      inputPath: 'corpus.jsonl',
      overlayPath: 'overlay.jsonl',
      allowPartialActionAdjudication: false,
      resultsOutputPath: 'results.jsonl',
      summaryOutputPath: undefined,
      overwrite: false,
    });
    expect(() =>
      readCommercialManualOverlayEvaluatorCliOptions([
        '--input',
        'corpus.jsonl',
        '--output',
        'results.jsonl',
      ]),
    ).toThrow('Usage:');
    expect(() =>
      readCommercialManualOverlayEvaluatorCliOptions([
        '--input',
        'one.jsonl',
        '--input',
        'two.jsonl',
        '--overlay',
        'overlay.jsonl',
        '--output',
        'results.jsonl',
      ]),
    ).toThrow('--input may be specified only once');
    expect(() =>
      readCommercialManualOverlayEvaluatorCliOptions([
        '--input',
        'corpus.jsonl',
        '--overlay',
        'overlay.jsonl',
        '--action-adjudication',
        'transport-actions.tsv',
        '--action-adjudication-sha256',
        'a'.repeat(64),
        '--output',
        'results.jsonl',
      ]),
    ).toThrow('requires sha256, records, and instances together');
    expect(
      readCommercialManualOverlayEvaluatorCliOptions([
        '--input',
        'corpus.jsonl',
        '--overlay',
        'overlay.jsonl',
        '--action-adjudication',
        'transport-actions.tsv',
        '--allow-partial-action-adjudication',
        '--output',
        'results.jsonl',
      ]),
    ).toEqual({
      inputPath: 'corpus.jsonl',
      overlayPath: 'overlay.jsonl',
      actionAdjudicationPath: 'transport-actions.tsv',
      allowPartialActionAdjudication: true,
      resultsOutputPath: 'results.jsonl',
      summaryOutputPath: undefined,
      overwrite: false,
    });
  });

  it('rejects a summary path that aliases the results lock path before reading inputs', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'commercial-overlay-lock-collision-'));
    const resultsPath = join(directory, 'results.jsonl');
    const detector = { detect: jest.fn(() => null) };

    try {
      await expect(
        evaluateCommercialManualOverlay({
          inputPath: join(directory, 'missing-corpus.jsonl'),
          overlayPath: join(directory, 'missing-overlay.jsonl'),
          resultsOutputPath: resultsPath,
          summaryOutputPath: `${resultsPath}.lock`,
          overwrite: true,
          detector,
        }),
      ).rejects.toThrow('collides with an output lock path');
      expect(detector.detect).not.toHaveBeenCalled();
      expect(await readdir(directory)).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('resolves output paths before recording them in the summary', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'commercial-overlay-paths-'));
    const inputPath = join(directory, 'corpus.jsonl');
    const overlayPath = join(directory, 'overlay.jsonl');
    const resultsPath = join(directory, 'results.jsonl');
    const record = corpusRecord({ text: 'path record' });
    const corpusBody = jsonl([record]);
    await writeFile(inputPath, corpusBody, 'utf8');
    await writeFile(
      overlayPath,
      jsonl([
        overlayRecord({
          inputSha256: sha256(corpusBody),
          line: 1,
          corpusRecord: record,
          manualLabel: 'commercial',
          recommendedAction: 'ALLOW',
        }),
      ]),
      'utf8',
    );

    try {
      const summary = await evaluateCommercialManualOverlay({
        inputPath,
        overlayPath,
        resultsOutputPath: resultsPath,
        detector: { detect: () => null },
      });
      expect(summary.output).toEqual(
        expect.objectContaining({
          resultsPath: resolve(resultsPath),
          summaryPath: resolve(`${resultsPath}.summary.json`),
        }),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
