import type { EnsureModerationDeleteIntentInput } from '../moderation-delete-intent.types';
import type { Candidate } from './commercial-review.service';
import {
  prepareCommercialQualityDelete,
  recordCommercialQualityExecution,
} from './commercial-quality-capture';

const observation: Candidate = {
  chatId: 'chat',
  userId: 'user',
  messageId: 'message',
  text: 'Продам свой холодильник',
  score: 80,
  actionBand: 'DELETE',
  source: 'TEXT',
  decisionFingerprint: 'actual',
  detectorVersion: 'commercial-intent-quality-v1',
  messageDisposition: 'DELETE',
  requiredPolicyCohorts: [],
  sourceSnapshotSha256: 'a'.repeat(64),
  detectorSourceSha256: 'b'.repeat(64),
  executionOutcome: 'UNKNOWN',
};
const intent: EnsureModerationDeleteIntentInput = {
  chatId: 'chat',
  messageId: 'message',
  ruleCode: 'COMMERCIAL_AD_DELETE',
  reasonKey: 'actual',
  event: { metadata: { existing: 'policy' } },
};
function capture() {
  return {
    recordCandidate: jest.fn().mockResolvedValue(undefined),
    recordExecution: jest.fn().mockResolvedValue('RECORDED'),
  };
}
describe('commercial quality capture boundary', () => {
  it('preserves the actual frozen sample and immutable intent while adding a source-bound review link', async () => {
    const review = capture();
    const prepared = await prepareCommercialQualityDelete(review, observation, intent);
    expect(review.recordCandidate).toHaveBeenCalledWith({
      ...observation,
      executionOutcome: 'PENDING',
    });
    expect(prepared.event?.metadata).toMatchObject({
      existing: 'policy',
      commercialReviewBinding: {
        source: 'TEXT',
        detectorVersion: observation.detectorVersion,
        sourceSnapshotSha256: observation.sourceSnapshotSha256,
        evidenceHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      },
    });
    expect(intent.event?.metadata).toEqual({ existing: 'policy' });
    expect(observation.executionOutcome).toBe('UNKNOWN');
    expect(review.recordExecution).not.toHaveBeenCalled();
  });
  it('does not bind another rule, a changed target, OCR or unknown source provenance', async () => {
    const review = capture();
    for (const changed of [
      { ...intent, ruleCode: 'PROFANITY_DELETE' },
      { ...intent, messageId: 'edited-target' },
    ])
      expect(await prepareCommercialQualityDelete(review, observation, changed)).toBe(changed);
    expect(
      await prepareCommercialQualityDelete(review, { ...observation, source: 'OCR' }, intent),
    ).toBe(intent);
    expect(
      await prepareCommercialQualityDelete(
        review,
        { ...observation, sourceSnapshotSha256: undefined },
        intent,
      ),
    ).toBe(intent);
    expect(review.recordCandidate).not.toHaveBeenCalled();
  });
  it.each([
    { deleted: true, gone: true, commercialVerified: true, expected: 'CONFIRMED_DELETE' },
    { deleted: false, gone: true, commercialVerified: true, expected: 'ALREADY_ABSENT' },
    { deleted: true, gone: true, commercialVerified: false, expected: null },
    { deleted: false, gone: false, commercialVerified: true, expected: null },
  ])(
    'separates confirmed commercial DELETE, exact absence and unverified outcomes: %j',
    async ({ expected, ...result }) => {
      const review = capture();
      await recordCommercialQualityExecution(review, observation, result);
      if (expected)
        expect(review.recordExecution).toHaveBeenCalledWith(
          expect.objectContaining({
            chatId: 'chat',
            messageId: 'message',
            executionOutcome: expected,
          }),
        );
      else expect(review.recordExecution).not.toHaveBeenCalled();
      expect(review.recordCandidate).not.toHaveBeenCalled();
    },
  );
});
