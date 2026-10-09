import type { MaxUpdate } from '@maxim/contracts';
import { buildWebhookExecutionDeadlineAt } from './webhook-execution-deadline';

describe('webhook executor readiness source deadlines', () => {
  const receivedAt = new Date('2026-10-06T21:00:00.000Z');
  const earlierAt = new Date('2026-10-06T20:59:00.000Z');
  const imageRaw = {
    message: {
      body: {
        attachments: [{ type: 'image', payload: { url: 'https://image.test/photo.jpg' } }],
      },
    },
  };
  const update = (type: string, source: string, eventTimestampSource: 'payload' | 'ingress') =>
    ({
      updateId: 'fixture-update',
      type,
      eventTimestampSource,
      message: {
        chatId: '-123',
        messageId: 'fixture-message',
        senderId: 'fixture-user',
        text: '',
        createdAt: source,
      },
      raw: imageRaw,
    }) satisfies MaxUpdate;

  it.each([
    ['payload', earlierAt.toISOString(), '2026-10-06T21:04:00.000Z'],
    ['payload', '2026-10-06T22:00:00.000Z', '2026-10-06T21:05:00.000Z'],
    ['payload', 'invalid', '2026-10-06T21:05:00.000Z'],
    ['ingress', earlierAt.toISOString(), '2026-10-06T21:05:00.000Z'],
  ] as const)(
    'bounds user_added from %s timestamp %s even with image-shaped raw content',
    (timestampSource, source, deadline) => {
      expect(
        buildWebhookExecutionDeadlineAt(update('user_added', source, timestampSource), receivedAt),
      ).toEqual(new Date(deadline));
    },
  );

  it.each(['message_created', 'message_edited'])(
    'preserves the ten-minute image deadline for %s',
    (type) => {
      expect(
        buildWebhookExecutionDeadlineAt(
          update(type, earlierAt.toISOString(), 'payload'),
          receivedAt,
        ),
      ).toEqual(new Date('2026-10-06T21:09:00.000Z'));
    },
  );

  it.each([
    ['payload', '2025-01-01T00:00:00.000Z'],
    ['payload', '2026-10-06T22:00:00.000Z'],
    ['ingress', earlierAt.toISOString()],
  ] as const)(
    'bounds callbacks from the original receipt regardless of %s message time %s',
    (timestampSource, messageAt) => {
      expect(
        buildWebhookExecutionDeadlineAt(
          update('message_callback', messageAt, timestampSource),
          receivedAt,
        ),
      ).toEqual(new Date('2026-10-06T21:05:00.000Z'));
    },
  );

  it.each(['user_removed', 'bot_added', 'bot_removed', 'bot_started'])(
    'does not introduce a readiness deadline for %s',
    (type) => {
      expect(
        buildWebhookExecutionDeadlineAt(
          update(type, earlierAt.toISOString(), 'payload'),
          receivedAt,
        ),
      ).toBeNull();
    },
  );
});
