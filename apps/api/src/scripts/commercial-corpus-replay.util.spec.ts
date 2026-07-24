import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CommercialDetection } from '../moderation/commercial/commercial-ad.detector';
import {
  emptyCommercialReplaySnapshot,
  replayCommercialCorpusFile,
  replayCommercialCorpusRecord,
  snapshotFromCommercialDetection,
  type CommercialCorpusDetector,
  type CommercialReplaySnapshot,
} from './commercial-corpus-replay.util';
import {
  COMMERCIAL_MANUAL_OVERLAY_SCHEMA_VERSION,
  fingerprintCommercialManualOverlayContext,
  type CommercialManualOverlayRecord,
  type CommercialManualOverlaySettings,
  type CommercialManualRecommendedAction,
} from './commercial-manual-overlay.util';
import { withCommercialOutputLocks } from './commercial-output-lock.util';
import type { CommercialRunProvenance } from './commercial-run-provenance.util';
import { readCommercialCorpusReplayCliOptions } from './replay-commercial-corpus';

const TEST_PROVENANCE: CommercialRunProvenance = {
  startedAt: '2026-07-23T18:00:00.000Z',
  git: { commit: '1'.repeat(40), dirty: true },
  detector: {
    digestKind: 'SOURCE_FILES',
    sourceSha256: '2'.repeat(64),
    decisionVersion: 'test-decision',
    patternPolicyVersion: 'test-pattern-policy',
    classifierVersion: 'test-classifier',
  },
  auditTool: {
    digestKind: 'SOURCE_FILES',
    sourceSha256: '3'.repeat(64),
  },
  runtime: { nodeVersion: 'v24.0.0' },
};

function corpusRecord(params: {
  text: string;
  current?: ReturnType<typeof emptyCommercialReplaySnapshot>;
  label?: string;
  expectedAction?: string;
  sanitizedBaseline?: CommercialReplaySnapshot | null;
}) {
  const record = {
    label: params.label ?? 'negative_candidate',
    category: 'stable_clear',
    policyCategory: 'none',
    segment: 'OTHER',
    expectedAction:
      params.expectedAction ?? (params.label === 'positive_candidate' ? 'WARN' : 'ALLOW'),
    expectedSubtype: params.label === 'positive_candidate' ? 'SERVICES' : null,
    isHardNegative: params.label !== 'positive_candidate',
    text: params.text,
    settings: {
      commercialAdsSensitivity: 'BALANCED',
      commercialAdsWarnThreshold: 45,
      commercialAdsDeleteThreshold: 65,
    },
    commercialCampaignContext: {
      senderDistinctChatCount: 1,
      sameTextDistinctChatCount: 0,
      repeatedPhoneDistinctChatCount: 0,
      repeatedLinkDistinctChatCount: 0,
    },
    current: params.current ?? emptyCommercialReplaySnapshot(),
  };
  return params.sanitizedBaseline === undefined
    ? record
    : { ...record, sanitizedBaseline: params.sanitizedBaseline };
}

function manualOverlayRecord(params: {
  corpusBody: string;
  corpusLine: number;
  record: ReturnType<typeof corpusRecord>;
  recommendedAction: CommercialManualRecommendedAction | null;
}): CommercialManualOverlayRecord {
  const settings: CommercialManualOverlaySettings = {
    commercialAdsSensitivity: params.record.settings
      .commercialAdsSensitivity as CommercialManualOverlaySettings['commercialAdsSensitivity'],
    commercialAdsWarnThreshold: params.record.settings.commercialAdsWarnThreshold,
    commercialAdsDeleteThreshold: params.record.settings.commercialAdsDeleteThreshold,
  };
  const commercialCampaignContext = { ...params.record.commercialCampaignContext };
  return {
    schemaVersion: COMMERCIAL_MANUAL_OVERLAY_SCHEMA_VERSION,
    inputSha256: createHash('sha256').update(params.corpusBody).digest('hex'),
    line: params.corpusLine,
    textSha256: createHash('sha256').update(params.record.text).digest('hex'),
    manualLabel: 'manual-review',
    confidence: 'high',
    recommendedAction: params.recommendedAction,
    sourceFiles: ['manual-review.tsv'],
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
    matchedSignals: ['intent:offer'],
    negativeSignals: [],
    primarySubtype: 'SERVICES',
    supportingSubtypes: [],
    evidenceStrength: 'DIRECT',
    reviewRecommended: false,
    reviewReasons: [],
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
    classifierReasons: [],
    score: confidenceScore,
    actionScore: confidenceScore,
    fpRisk: 10,
    evidenceTier: 'DIRECT',
    subtype: 'SERVICES',
    actionBand,
    reviewPriority: 'NONE',
    campaignStrength: 'NONE',
    safeContextBucket: 'none',
    actionable: true,
    recordable: true,
    deleteSuppressed: false,
    suppressionReasons: [],
    reasonCodes: ['test'],
    featureVector: { commercialIntent: 1 },
  } as CommercialDetection;
}

describe('commercial corpus replay', () => {
  it('replays stored settings/context and emits a structured decision diff', () => {
    const detect = jest.fn(() => commercialDetection('WARN'));
    const evaluation = replayCommercialCorpusRecord({
      value: corpusRecord({ text: 'Ремонт квартир, звоните [phone]' }),
      line: 7,
      detector: { detect },
    });

    expect(detect).toHaveBeenCalledWith(
      expect.objectContaining({
        settings: expect.objectContaining({
          commercialAdsFilterEnabled: true,
          commercialAdsSensitivity: 'BALANCED',
          commercialAdsWarnThreshold: 45,
          commercialAdsDeleteThreshold: 65,
        }),
        commercialCampaignContext: expect.objectContaining({ senderDistinctChatCount: 1 }),
      }),
    );
    expect(evaluation.diff).toEqual(
      expect.objectContaining({
        line: 7,
        changeKind: 'NEW_HIT',
        labelImpact: 'POSSIBLE_FALSE_POSITIVE_REGRESSION',
        hitTransition: 'false->true',
        actionTransition: 'NONE->WARN',
        containsSanitizedPlaceholders: true,
        trustBucket: 'UNTRUSTED_SANITIZED_PLACEHOLDER',
        baselineSource: 'CURRENT_SNAPSHOT',
        materialChanged: true,
      }),
    );
    expect(evaluation.diff?.changes).toEqual(
      expect.objectContaining({
        hit: { stored: false, replayed: true },
        actionBand: { stored: null, replayed: 'WARN' },
      }),
    );
  });

  it('prefers sanitizedBaseline and trusts placeholder rows that have one', () => {
    const evaluation = replayCommercialCorpusRecord({
      value: corpusRecord({
        text: 'Ремонт квартир, звоните [phone]',
        current: snapshotFromCommercialDetection(commercialDetection('DELETE')),
        sanitizedBaseline: emptyCommercialReplaySnapshot(),
        label: 'positive_candidate',
        expectedAction: 'WARN',
      }),
      line: 3,
      detector: { detect: () => commercialDetection('WARN') },
    });

    expect(evaluation).toEqual(
      expect.objectContaining({
        changed: true,
        trustBucket: 'TRUSTED',
      }),
    );
    expect(evaluation.diff).toEqual(
      expect.objectContaining({
        baselineSource: 'SANITIZED_BASELINE',
        hitTransition: 'false->true',
        actionTransition: 'NONE->WARN',
        labelImpact: 'RECALL_GAIN',
      }),
    );
  });

  it('treats bank-account placeholders as untrusted without a sanitized baseline', () => {
    const evaluation = replayCommercialCorpusRecord({
      value: corpusRecord({ text: 'Расчетный счет [account]' }),
      line: 4,
      detector: { detect: () => null },
    });

    expect(evaluation).toEqual(
      expect.objectContaining({
        containsSanitizedPlaceholders: true,
        trustBucket: 'UNTRUSTED_SANITIZED_PLACEHOLDER',
      }),
    );
  });

  it('rejects a malformed sanitizedBaseline instead of trusting current as fallback', () => {
    expect(() =>
      replayCommercialCorpusRecord({
        value: {
          ...corpusRecord({ text: 'Ремонт квартир [phone]' }),
          sanitizedBaseline: { hit: 'invalid' },
        },
        line: 9,
        detector: { detect: () => null },
      }),
    ).toThrow('line 9: sanitizedBaseline.score is required');
  });

  it.each([
    ['invalid action type', { ...emptyCommercialReplaySnapshot(), actionBand: 42 }],
    ['invalid signal item', { ...emptyCommercialReplaySnapshot(), matchedSignals: ['valid', 42] }],
    ['out-of-range score', { ...emptyCommercialReplaySnapshot(), confidenceScore: 101 }],
  ])('rejects a trusted sanitizedBaseline with %s', (_label, sanitizedBaseline) => {
    expect(() =>
      replayCommercialCorpusRecord({
        value: corpusRecord({
          text: 'Ремонт квартир [phone]',
          sanitizedBaseline: sanitizedBaseline as CommercialReplaySnapshot,
        }),
        line: 10,
        detector: { detect: () => null },
      }),
    ).toThrow('line 10: sanitizedBaseline.');
  });

  it('rejects replay settings and campaign counts outside the runtime contract', () => {
    const base = corpusRecord({ text: 'invalid numeric schema' });
    expect(() =>
      replayCommercialCorpusRecord({
        value: {
          ...base,
          settings: { ...base.settings, commercialAdsWarnThreshold: 45.5 },
        },
        line: 11,
        detector: { detect: () => null },
      }),
    ).toThrow('commercialAdsWarnThreshold must be an integer in [10, 90]');
    expect(() =>
      replayCommercialCorpusRecord({
        value: {
          ...base,
          settings: {
            ...base.settings,
            commercialAdsWarnThreshold: 65,
            commercialAdsDeleteThreshold: 65,
          },
        },
        line: 12,
        detector: { detect: () => null },
      }),
    ).toThrow('commercialAdsDeleteThreshold must be greater');
    expect(() =>
      replayCommercialCorpusRecord({
        value: {
          ...base,
          commercialCampaignContext: {
            ...base.commercialCampaignContext,
            senderDistinctChatCount: 1.5,
          },
        },
        line: 13,
        detector: { detect: () => null },
      }),
    ).toThrow('senderDistinctChatCount must be a non-negative integer');
  });

  it('flags gray-zone escalation relative to expectedAction', () => {
    const evaluation = replayCommercialCorpusRecord({
      value: corpusRecord({
        text: 'ambiguous commercial message',
        current: snapshotFromCommercialDetection(commercialDetection('REVIEW_ONLY')),
        label: 'gray_candidate',
        expectedAction: 'REVIEW_ONLY',
      }),
      line: 4,
      detector: { detect: () => commercialDetection('DELETE') },
    });

    expect(evaluation.diff).toEqual(
      expect.objectContaining({
        actionTransition: 'REVIEW_ONLY->DELETE',
        labelImpact: 'POSSIBLE_FALSE_POSITIVE_REGRESSION',
      }),
    );
  });

  it('gives instance-specific manual recommendations precedence over automatic labels', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'commercial-replay-manual-overlay-'));
    const inputPath = join(directory, 'corpus.jsonl');
    const overlayPath = join(directory, 'overlay.jsonl');
    const diffPath = join(directory, 'diff.jsonl');
    const summaryPath = join(directory, 'summary.json');
    const recallRecord = corpusRecord({ text: 'manual positive target' });
    const falsePositiveRecord = corpusRecord({
      text: 'manual allow target',
      label: 'positive_candidate',
      expectedAction: 'WARN',
      current: snapshotFromCommercialDetection(commercialDetection('WARN')),
    });
    const corpusBody = `${[recallRecord, falsePositiveRecord]
      .map((record) => JSON.stringify(record))
      .join('\n')}\n`;
    const overlayRecords = [
      manualOverlayRecord({
        corpusBody,
        corpusLine: 1,
        record: recallRecord,
        recommendedAction: 'WARN',
      }),
      manualOverlayRecord({
        corpusBody,
        corpusLine: 2,
        record: falsePositiveRecord,
        recommendedAction: 'ALLOW',
      }),
    ];
    const overlayBody = `${overlayRecords.map((record) => JSON.stringify(record)).join('\n')}\n`;
    const detector: CommercialCorpusDetector = {
      detect: ({ rawLoweredText }) =>
        rawLoweredText.includes('positive')
          ? commercialDetection('WARN')
          : commercialDetection('DELETE'),
    };

    await writeFile(inputPath, corpusBody, 'utf8');
    await writeFile(overlayPath, overlayBody, 'utf8');

    try {
      const summary = await replayCommercialCorpusFile({
        inputPath,
        manualOverlayPath: overlayPath,
        diffOutputPath: diffPath,
        summaryOutputPath: summaryPath,
        detector,
      });
      const diffs = (await readFile(diffPath, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>);

      expect(diffs).toHaveLength(2);
      expect(diffs[0]).toEqual(
        expect.objectContaining({
          label: 'negative_candidate',
          expectedAction: 'ALLOW',
          effectiveLabel: 'positive_candidate',
          effectiveExpectedAction: 'WARN',
          expectedActionSource: 'MANUAL_OVERLAY',
          labelImpact: 'RECALL_GAIN',
          manualOverlay: expect.objectContaining({
            manualLabel: 'manual-review',
            recommendedAction: 'WARN',
            sourceFiles: ['manual-review.tsv'],
          }),
        }),
      );
      expect(diffs[1]).toEqual(
        expect.objectContaining({
          label: 'positive_candidate',
          expectedAction: 'WARN',
          effectiveLabel: 'negative_candidate',
          effectiveExpectedAction: 'ALLOW',
          expectedActionSource: 'MANUAL_OVERLAY',
          actionTransition: 'WARN->DELETE',
          labelImpact: 'POSSIBLE_FALSE_POSITIVE_REGRESSION',
          manualOverlay: expect.objectContaining({ recommendedAction: 'ALLOW' }),
        }),
      );
      expect(summary.input.manualOverlay).toEqual({
        path: overlayPath,
        sha256: createHash('sha256').update(overlayBody).digest('hex'),
        records: 2,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([
    [
      'corpus SHA-256',
      (record: CommercialManualOverlayRecord) => ({
        ...record,
        inputSha256: '0'.repeat(64),
      }),
      'does not match corpus SHA-256',
    ],
    [
      'text SHA-256',
      (record: CommercialManualOverlayRecord) => ({
        ...record,
        textSha256: '0'.repeat(64),
      }),
      'does not match corpus text',
    ],
    [
      'settings',
      (record: CommercialManualOverlayRecord) => {
        const settings = { ...record.settings, commercialAdsWarnThreshold: 46 };
        return {
          ...record,
          settings,
          contextFingerprint: fingerprintCommercialManualOverlayContext(
            settings,
            record.commercialCampaignContext,
          ),
        };
      },
      'settings do not match the corpus record',
    ],
    [
      'campaign context',
      (record: CommercialManualOverlayRecord) => {
        const commercialCampaignContext = {
          ...(record.commercialCampaignContext ?? {
            senderDistinctChatCount: 1,
            sameTextDistinctChatCount: 0,
            repeatedPhoneDistinctChatCount: 0,
            repeatedLinkDistinctChatCount: 0,
          }),
          senderDistinctChatCount: 2,
        };
        return {
          ...record,
          commercialCampaignContext,
          contextFingerprint: fingerprintCommercialManualOverlayContext(
            record.settings,
            commercialCampaignContext,
          ),
        };
      },
      'commercialCampaignContext does not match the corpus record',
    ],
    [
      'required campaign context field',
      (record: CommercialManualOverlayRecord) => {
        const withoutCampaignContext = { ...record } as Record<string, unknown>;
        delete withoutCampaignContext.commercialCampaignContext;
        return withoutCampaignContext;
      },
      'commercialCampaignContext must be an object or null',
    ],
    [
      'context fingerprint',
      (record: CommercialManualOverlayRecord) => ({
        ...record,
        contextFingerprint: '0'.repeat(64),
      }),
      'contextFingerprint does not match overlay settings/context',
    ],
  ])('fails closed when the manual overlay has a mismatched %s', async (_name, mutate, error) => {
    const directory = await mkdtemp(join(tmpdir(), 'commercial-replay-overlay-mismatch-'));
    const inputPath = join(directory, 'corpus.jsonl');
    const overlayPath = join(directory, 'overlay.jsonl');
    const diffPath = join(directory, 'diff.jsonl');
    const record = corpusRecord({ text: 'overlay validation target' });
    const corpusBody = `${JSON.stringify(record)}\n`;
    const overlay = mutate(
      manualOverlayRecord({
        corpusBody,
        corpusLine: 1,
        record,
        recommendedAction: 'WARN',
      }),
    );
    await writeFile(inputPath, corpusBody, 'utf8');
    await writeFile(overlayPath, `${JSON.stringify(overlay)}\n`, 'utf8');

    try {
      await expect(
        replayCommercialCorpusFile({
          inputPath,
          manualOverlayPath: overlayPath,
          diffOutputPath: diffPath,
          detector: { detect: () => commercialDetection('WARN') },
        }),
      ).rejects.toThrow(error);
      await expect(readFile(diffPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('keeps untrusted placeholder changes out of output and trusted aggregates by default', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'commercial-replay-'));
    const inputPath = join(directory, 'corpus.jsonl');
    const diffPath = join(directory, 'diff.jsonl');
    const summaryPath = join(directory, 'summary.json');
    const explanationOnly = emptyCommercialReplaySnapshot();
    explanationOnly.reasonCodes = ['old'];
    const detector: CommercialCorpusDetector = {
      detect: ({ rawLoweredText }) => {
        if (rawLoweredText.includes('new hit')) {
          return commercialDetection('DELETE');
        }
        return null;
      },
    };

    await writeFile(
      inputPath,
      [
        corpusRecord({ text: 'unchanged clear' }),
        corpusRecord({ text: 'new hit advertisement', label: 'positive_candidate' }),
        corpusRecord({ text: 'explanation changed', current: explanationOnly }),
        corpusRecord({ text: 'new hit advertisement [phone]' }),
      ]
        .map((record) => JSON.stringify(record))
        .join('\n') + '\n',
      'utf8',
    );

    try {
      const summary = await replayCommercialCorpusFile({
        inputPath,
        diffOutputPath: diffPath,
        summaryOutputPath: summaryPath,
        detector,
        provenance: TEST_PROVENANCE,
      });
      const diffs = (await readFile(diffPath, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as unknown);
      const storedSummary = JSON.parse(await readFile(summaryPath, 'utf8')) as unknown;

      expect(summary).toEqual(
        expect.objectContaining({
          recordsProcessed: 4,
          emittedDiffRecords: 1,
          provenance: TEST_PROVENANCE,
          replay: {
            textMode: 'CORPUS_TEXT_AS_STORED',
            trustPolicy: 'SANITIZED_PLACEHOLDERS_REQUIRE_SANITIZED_BASELINE',
          },
        }),
      );
      expect(summary.input.sha256).toMatch(/^[a-f0-9]{64}$/u);
      expect(summary.output).toEqual(
        expect.objectContaining({
          includeUntrustedPlaceholderDiffs: false,
          diffSha256: createHash('sha256')
            .update(await readFile(diffPath))
            .digest('hex'),
        }),
      );
      expect(summary.trustBuckets.TRUSTED).toEqual(
        expect.objectContaining({
          recordsProcessed: 3,
          unchangedRecords: 1,
          changedRecords: 2,
          materialChangedRecords: 1,
          explanationOnlyRecords: 1,
          emittedDiffRecords: 1,
        }),
      );
      expect(summary.trustBuckets.UNTRUSTED_SANITIZED_PLACEHOLDER).toEqual(
        expect.objectContaining({
          recordsProcessed: 1,
          changedRecords: 1,
          materialChangedRecords: 1,
          emittedDiffRecords: 0,
          labelImpacts: { POSSIBLE_FALSE_POSITIVE_REGRESSION: 1 },
        }),
      );
      expect(diffs).toHaveLength(1);
      expect(diffs[0]).toEqual(
        expect.objectContaining({
          text: 'new hit advertisement',
          labelImpact: 'RECALL_GAIN',
          trustBucket: 'TRUSTED',
        }),
      );
      expect(storedSummary).toEqual(summary);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('emits untrusted placeholder changes only with explicit opt-in', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'commercial-replay-untrusted-'));
    const inputPath = join(directory, 'corpus.jsonl');
    const diffPath = join(directory, 'diff.jsonl');
    const summaryPath = join(directory, 'summary.json');
    await writeFile(
      inputPath,
      `${JSON.stringify(corpusRecord({ text: 'new hit [url]' }))}\n`,
      'utf8',
    );

    try {
      const summary = await replayCommercialCorpusFile({
        inputPath,
        diffOutputPath: diffPath,
        summaryOutputPath: summaryPath,
        includeUntrustedPlaceholderDiffs: true,
        detector: { detect: () => commercialDetection('WARN') },
      });
      const diff = JSON.parse((await readFile(diffPath, 'utf8')).trim()) as Record<string, unknown>;

      expect(summary.output.includeUntrustedPlaceholderDiffs).toBe(true);
      expect(summary.emittedDiffRecords).toBe(1);
      expect(summary.trustBuckets.UNTRUSTED_SANITIZED_PLACEHOLDER.emittedDiffRecords).toBe(1);
      expect(diff.trustBucket).toBe('UNTRUSTED_SANITIZED_PLACEHOLDER');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('does not publish a partial diff when the summary path is claimed concurrently', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'commercial-replay-race-'));
    const inputPath = join(directory, 'corpus.jsonl');
    const diffPath = join(directory, 'diff.jsonl');
    const summaryPath = join(directory, 'summary.json');
    await writeFile(
      inputPath,
      `${JSON.stringify(corpusRecord({ text: 'new hit advertisement' }))}\n`,
      'utf8',
    );

    try {
      await expect(
        replayCommercialCorpusFile({
          inputPath,
          diffOutputPath: diffPath,
          summaryOutputPath: summaryPath,
          detector: { detect: () => commercialDetection('WARN') },
          onProgress: () => {
            writeFileSync(summaryPath, 'claimed-by-another-run\n', { flag: 'wx' });
          },
        }),
      ).rejects.toThrow(`Output already exists: ${summaryPath}`);
      await expect(readFile(diffPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(readFile(summaryPath, 'utf8')).resolves.toBe('claimed-by-another-run\n');
      expect((await readdir(directory)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects a summary path that is also the diff lock path before replaying', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'commercial-replay-lock-collision-'));
    const inputPath = join(directory, 'corpus.jsonl');
    const diffPath = join(directory, 'diff.jsonl');
    await writeFile(
      inputPath,
      `${JSON.stringify(corpusRecord({ text: 'new hit advertisement' }))}\n`,
      'utf8',
    );
    const detector = { detect: jest.fn(() => commercialDetection('WARN')) };

    try {
      await expect(
        replayCommercialCorpusFile({
          inputPath,
          diffOutputPath: diffPath,
          summaryOutputPath: `${diffPath}.lock`,
          overwrite: true,
          detector,
        }),
      ).rejects.toThrow('collides with an output lock path');
      expect(detector.detect).not.toHaveBeenCalled();
      expect((await readdir(directory)).sort()).toEqual(['corpus.jsonl']);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('restores the previous diff when overwrite cannot publish the summary', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'commercial-replay-overwrite-'));
    const inputPath = join(directory, 'corpus.jsonl');
    const diffPath = join(directory, 'diff.jsonl');
    const summaryPath = join(directory, 'summary.json');
    await writeFile(
      inputPath,
      `${JSON.stringify(corpusRecord({ text: 'new hit advertisement' }))}\n`,
      'utf8',
    );
    await writeFile(diffPath, 'previous-diff\n', 'utf8');
    await mkdir(summaryPath);

    try {
      await expect(
        replayCommercialCorpusFile({
          inputPath,
          diffOutputPath: diffPath,
          summaryOutputPath: summaryPath,
          overwrite: true,
          detector: { detect: () => commercialDetection('WARN') },
        }),
      ).rejects.toMatchObject({ code: expect.stringMatching(/^(?:EISDIR|ENOTDIR)$/u) });
      await expect(readFile(diffPath, 'utf8')).resolves.toBe('previous-diff\n');
      expect((await readdir(directory)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('keeps the previous output pair when a concurrent overwrite holds both locks', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'commercial-replay-locked-overwrite-'));
    const inputPath = join(directory, 'corpus.jsonl');
    const diffPath = join(directory, 'diff.jsonl');
    const summaryPath = join(directory, 'summary.json');
    await writeFile(
      inputPath,
      `${JSON.stringify(corpusRecord({ text: 'new hit advertisement' }))}\n`,
      'utf8',
    );
    await writeFile(diffPath, 'previous-diff\n', 'utf8');
    await writeFile(summaryPath, 'previous-summary\n', 'utf8');

    let releaseLock!: () => void;
    const holdLock = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    let signalLocked!: () => void;
    const locked = new Promise<void>((resolve) => {
      signalLocked = resolve;
    });
    const competingWriter = withCommercialOutputLocks([diffPath, summaryPath], async () => {
      signalLocked();
      await holdLock;
    });
    await locked;

    try {
      await expect(
        replayCommercialCorpusFile({
          inputPath,
          diffOutputPath: diffPath,
          summaryOutputPath: summaryPath,
          overwrite: true,
          detector: { detect: () => commercialDetection('WARN') },
        }),
      ).rejects.toThrow('Output is locked by another process');
      await expect(readFile(diffPath, 'utf8')).resolves.toBe('previous-diff\n');
      await expect(readFile(summaryPath, 'utf8')).resolves.toBe('previous-summary\n');
      expect((await readdir(directory)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    } finally {
      releaseLock();
      await competingWriter;
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('parses the manual overlay and explicit untrusted-placeholder CLI opt-in', () => {
    expect(
      readCommercialCorpusReplayCliOptions([
        '--input',
        'corpus.jsonl',
        '--manual-overlay',
        'overlay.jsonl',
        '--output',
        'diff.jsonl',
        '--include-untrusted-placeholders',
      ]),
    ).toEqual(
      expect.objectContaining({
        manualOverlayPath: 'overlay.jsonl',
        includeUntrustedPlaceholderDiffs: true,
      }),
    );
  });

  it('rejects unknown and duplicate replay options instead of dropping the overlay silently', () => {
    expect(() =>
      readCommercialCorpusReplayCliOptions([
        '--input',
        'corpus.jsonl',
        '--manual-overly',
        'overlay.jsonl',
        '--output',
        'diff.jsonl',
      ]),
    ).toThrow('Unknown option: --manual-overly');
    expect(() =>
      readCommercialCorpusReplayCliOptions([
        '--input',
        'corpus.jsonl',
        '--manual-overlay',
        'first.jsonl',
        '--manual-overlay',
        'second.jsonl',
        '--output',
        'diff.jsonl',
      ]),
    ).toThrow('--manual-overlay may be specified only once');
  });

  it('reports the physical JSONL line for malformed records', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'commercial-replay-invalid-'));
    const inputPath = join(directory, 'corpus.jsonl');
    const diffPath = join(directory, 'diff.jsonl');
    await writeFile(inputPath, `\n${JSON.stringify({ text: 'missing fields' })}\n`, 'utf8');

    try {
      await expect(
        replayCommercialCorpusFile({ inputPath, diffOutputPath: diffPath }),
      ).rejects.toThrow('line 2: settings are missing');
      await expect(readFile(diffPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
