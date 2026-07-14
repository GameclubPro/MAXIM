import { WebhookStatus } from '../prisma/prisma-client';
import {
  classifyReplayEvent,
  readCliOptions,
  type ReplayDecision,
} from './repair-karavan-storefront-relays';

function createEvent(overrides: Record<string, unknown> = {}) {
  const rawMessageOverrides =
    typeof overrides.rawMessage === 'object' && overrides.rawMessage !== null
      ? (overrides.rawMessage as Record<string, unknown>)
      : {};
  const normalizedPayloadOverrides =
    typeof overrides.normalizedPayload === 'object' && overrides.normalizedPayload !== null
      ? (overrides.normalizedPayload as Record<string, unknown>)
      : {};

  return {
    id: 'webhook-1',
    status: WebhookStatus.PROCESSED,
    normalizedPayload: {
      updateId: 'update-1',
      type: 'message_created',
      message: {
        messageId: 'mid-1',
        chatId: '-1001',
        senderId: 'seller-1',
        text: '$ витрина',
        createdAt: '2026-07-14T07:38:00.000Z',
      },
      raw: {
        message: {
          body: {
            text: '',
          },
          link: {
            type: 'forward',
            sender: {
              user_id: 'seller-1',
            },
            message: {
              text: '$ витрина',
            },
          },
          ...rawMessageOverrides,
        },
      },
      ...normalizedPayloadOverrides,
    },
  };
}

function expectSkip(decision: ReplayDecision, reason: string) {
  expect(decision).toEqual({
    kind: 'skipped',
    webhookEventId: 'webhook-1',
    reason,
  });
}

describe('repair Karavan storefront relays CLI', () => {
  it('requires explicit unique webhook event IDs', () => {
    expect(() => readCliOptions([])).toThrow('At least one --webhook-event-id is required');
    expect(() =>
      readCliOptions(['--webhook-event-id', 'one', '--webhook-event-id', 'one']),
    ).toThrow('Each --webhook-event-id must be unique');
    expect(readCliOptions(['--webhook-event-id', 'one', '--apply', '--json'])).toEqual({
      webhookEventIds: ['one'],
      apply: true,
      json: true,
    });
  });

  it('accepts the confirmed forwarded-only relay shape', () => {
    expect(classifyReplayEvent(createEvent())).toMatchObject({
      kind: 'eligible',
      candidate: {
        webhookEventId: 'webhook-1',
        chatId: '-1001',
        messageId: 'mid-1',
        senderId: 'seller-1',
      },
    });
  });

  it('accepts the same relay shape inside a webhook event envelope', () => {
    expect(
      classifyReplayEvent(
        createEvent({
          normalizedPayload: {
            raw: {
              update_type: 'message_created',
              message_created: {
                message: {
                  body: {
                    text: '',
                  },
                  link: {
                    type: 'forward',
                    sender: {
                      user_id: 'seller-1',
                    },
                    message: {
                      text: '$ витрина',
                    },
                  },
                },
              },
            },
          },
        }),
      ),
    ).toMatchObject({
      kind: 'eligible',
      candidate: {
        webhookEventId: 'webhook-1',
      },
    });
  });

  it('rejects a reply preview even when normalized text begins with a dollar marker', () => {
    expectSkip(
      classifyReplayEvent(
        createEvent({
          rawMessage: {
            link: {
              type: 'reply',
              message: {
                text: '$ чужая витрина',
              },
            },
          },
        }),
      ),
      'not_forward',
    );
  });

  it('rejects a forward with direct current-message text or mismatched author', () => {
    expectSkip(
      classifyReplayEvent(
        createEvent({
          rawMessage: {
            body: {
              text: 'мой комментарий',
            },
          },
        }),
      ),
      'direct_text_present',
    );
    expectSkip(
      classifyReplayEvent(
        createEvent({
          rawMessage: {
            link: {
              type: 'forward',
              sender: {
                user_id: 'other-seller',
              },
              message: {
                text: '$ чужая витрина',
              },
            },
          },
        }),
      ),
      'forward_sender_mismatch',
    );
  });
});
