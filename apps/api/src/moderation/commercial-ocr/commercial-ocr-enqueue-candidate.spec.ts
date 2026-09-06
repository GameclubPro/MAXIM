import type { RuleViolation } from '../rule-engine.contract';
import type { MaxUpdate } from '@maxim/contracts';
import {
  hasActionableCompetingViolation,
  resolveCommercialOcrEnqueueCandidate,
} from './commercial-ocr-enqueue-candidate';

describe('commercial OCR enqueue candidate policy', () => {
  it('builds an image-text-only candidate only for an enabled non-empty stop-list', () => {
    expect(
      resolveCommercialOcrEnqueueCandidate({
        update: photoUpdate(),
        webhookEventId: 'event-1',
        updateType: 'message_created',
        commercialAdsFilterEnabled: false,
        imageTextScanEnabled: true,
        hasImageTextStopList: true,
        hasPhotoAttachment: true,
        chatId: 'chat-1',
        messageId: 'message-1',
        sourceCreatedAt: '2026-08-12T08:00:00.000Z',
      }),
    ).toMatchObject({
      commercialScanRequested: false,
      imageTextScanRequested: true,
      imageCount: 1,
    });

    expect(
      resolveCommercialOcrEnqueueCandidate({
        update: photoUpdate(),
        webhookEventId: 'event-1',
        updateType: 'message_created',
        commercialAdsFilterEnabled: false,
        imageTextScanEnabled: true,
        hasImageTextStopList: false,
        hasPhotoAttachment: true,
        chatId: 'chat-1',
        messageId: 'message-1',
        sourceCreatedAt: '2026-08-12T08:00:00.000Z',
      }),
    ).toBeNull();
  });

  it.each([
    { violations: [], expected: false },
    {
      violations: [{ ruleCode: 'LINK_BLOCKED', score: 1, reason: 'link' }],
      expected: true,
    },
    {
      violations: [commercialViolation({ actionBand: 'REVIEW_ONLY', actionable: false })],
      expected: false,
    },
    {
      violations: [commercialViolation({ actionBand: 'DELETE', actionable: true })],
      expected: true,
    },
    {
      violations: [commercialViolation({ actionBand: 'DELETE', actionable: false })],
      expected: false,
    },
  ])('returns $expected for competing violations', ({ violations, expected }) => {
    expect(hasActionableCompetingViolation(violations)).toBe(expected);
  });
});

function photoUpdate(): MaxUpdate {
  const createdAt = '2026-08-12T08:00:00.000Z';
  return {
    updateId: 'update-1',
    type: 'message_created',
    message: {
      messageId: 'message-1',
      chatId: 'chat-1',
      senderId: 'user-1',
      text: '',
      createdAt,
    },
    raw: {
      message: {
        id: 'message-1',
        timestamp: createdAt,
        recipient: { chat_id: 'chat-1' },
        sender: { user_id: 'user-1', is_bot: false },
        body: {
          attachments: [
            {
              type: 'image',
              payload: { photo_id: 'photo-1', url: 'https://i.oneme.ru/photo-1' },
            },
          ],
        },
      },
    },
  };
}

function commercialViolation(metadata: Record<string, unknown>): RuleViolation {
  return { ruleCode: 'COMMERCIAL_AD', score: 1, reason: 'commercial', metadata };
}
