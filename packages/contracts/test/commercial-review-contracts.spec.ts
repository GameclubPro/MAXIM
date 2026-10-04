import { describe, expect, it } from 'vitest';
import {
  commercialReviewDecisionRequestSchema,
  commercialReviewItemSchema,
  commercialReviewEvidenceMetadataSchema,
  commercialReviewDecisionSnapshotSchema,
  commercialReviewExportQuerySchema,
  commercialReviewSamplingFrameItemSchema,
} from '@maxim/contracts/safety-desk';

const date = '2026-10-01T10:00:00.000Z';
const blind = {
  id: 'sample-1',
  chatId: 'chat-1',
  chatTitle: 'Чат',
  source: 'TEXT',
  excerpt: 'Сообщение',
  score: null,
  actionBand: null,
  messageDisposition: null,
  requiredPolicyCohorts: [],
  detectorVersion: 'unknown',
  decisionFingerprint: 'unknown',
  reviewPriority: null,
  reasons: [],
  label: null,
  historicalLabel: null,
  reviewReason: '',
  reviewedAt: null,
  ownReview: null,
  reviewState: 'UNREVIEWED',
  independentReviewCount: 0,
  decisionVisible: false,
  canReview: true,
  canAdjudicate: false,
  imageEvidenceAvailable: false,
  sourceExcerptComplete: null,
  evidenceMetadata: null,
  observedAt: date,
  expiresAt: date,
  updatedAt: date,
};

describe('independent commercial review contracts', () => {
  it('requires server-redacted evidence before the reviewer has saved a label', () => {
    expect(commercialReviewItemSchema.safeParse(blind).success).toBe(true);
    for (const exposed of [
      { score: 85 },
      { actionBand: 'DELETE_ONLY' },
      { messageDisposition: 'DELETE' },
      { reviewPriority: 90 },
      { reasons: ['SERVICE_OFFER'] },
      { detectorVersion: 'detector-v1' },
      { requiredPolicyCohorts: ['commercial-text'] },
      { label: 'COMMERCIAL' },
      { historicalLabel: 'NOT_COMMERCIAL' },
      { reviewReason: 'Previous opinion' },
    ])
      expect(commercialReviewItemSchema.safeParse({ ...blind, ...exposed }).success).toBe(false);
  });
  it('rejects reviewer identity supplied in a browser request and contradictory dispositions', () => {
    const request = {
      expectedUpdatedAt: date,
      label: 'NOT_COMMERCIAL',
      expectedDisposition: 'KEEP',
      reason: ' Частное объявление ',
    };
    expect(commercialReviewDecisionRequestSchema.parse(request).reason).toBe('Частное объявление');
    for (const invalid of [
      { ...request, reviewerKey: 'browser-actor' },
      { ...request, reviewerId: 'browser-actor' },
      { ...request, expectedDisposition: 'DELETE' },
      { ...request, label: 'UNSURE', expectedDisposition: 'KEEP' },
    ])
      expect(commercialReviewDecisionRequestSchema.safeParse(invalid).success).toBe(false);
    expect(
      commercialReviewDecisionRequestSchema.safeParse({ ...request, label: 'COMMERCIAL' }).success,
    ).toBe(true);
  });
  it('keeps legacy unknown outcomes separate from explicit deletion evidence and strips unknown metadata', () => {
    const input = {
      schemaVersion: 2,
      samplingProbability: null,
      samplingStratum: 'UNKNOWN',
      logicalMessageKey: null,
      authorGroupId: null,
      campaignGroupId: null,
      sourceSnapshotSha256: null,
      imageReviewRequired: false,
      sourceExcerptComplete: null,
      messageCreatedAt: null,
      settingsProfileDigest: null,
      detectorSourceSha256: null,
      hasDetection: null,
      decisionOutcome: null,
      deleteEligible: null,
      executionOutcome: 'UNKNOWN',
      analysisOutcome: 'UNKNOWN',
      candidateDecision: null,
      rawText: 'Do not retain',
    };
    expect(commercialReviewEvidenceMetadataSchema.parse(input)).not.toHaveProperty('rawText');
    expect(
      commercialReviewEvidenceMetadataSchema.safeParse({ ...input, samplingProbability: 1.1 })
        .success,
    ).toBe(false);
    expect(
      commercialReviewEvidenceMetadataSchema.safeParse({
        ...input,
        detectorSourceSha256: 'not-a-digest',
      }).success,
    ).toBe(false);
  });
  it('bounds export windows to retention and keeps the sampling frame free of labels and decisions', () => {
    expect(
      commercialReviewExportQuerySchema.safeParse({
        since: '2026-10-01T00:00:00.000Z',
        until: '2026-10-15T00:00:00.000Z',
      }).success,
    ).toBe(true);
    expect(
      commercialReviewExportQuerySchema.safeParse({
        since: '2026-10-01T00:00:00.000Z',
        until: '2026-10-15T00:00:00.001Z',
      }).success,
    ).toBe(false);
    const frame = {
      source: 'TEXT',
      observedAt: date,
      sourceSnapshotSha256: null,
      logicalMessageKey: null,
      pseudonymizationKeyId: null,
      settingsProfileDigest: null,
      campaignGroupingComplete: null,
      messageCreatedAt: null,
      evaluationSamplingProbability: null,
    };
    expect(commercialReviewSamplingFrameItemSchema.safeParse(frame).success).toBe(true);
    for (const privateField of [
      { score: 85 },
      { label: 'COMMERCIAL' },
      { excerpt: 'private text' },
      { samplingStratum: 'HIT' },
    ])
      expect(
        commercialReviewSamplingFrameItemSchema.safeParse({ ...frame, ...privateField }).success,
      ).toBe(false);
    const snapshot = commercialReviewDecisionSnapshotSchema.parse({
      score: 50,
      actionBand: 'REVIEW_ONLY',
      messageDisposition: 'KEEP',
      detectorVersion: 'v1',
      decisionFingerprint: 'v1',
      reasons: [],
      requiredPolicyCohorts: [],
    });
    expect(snapshot).toMatchObject({ hasDetection: null, actionable: null, deleteEligible: null });
  });
});
