import { buildWebhookSemanticEventKey } from './webhook-semantic-event-key';

describe('buildWebhookSemanticEventKey', () => {
  it('keeps exact millisecond timestamps for membership event identity', () => {
    const base = {
      type: 'bot_removed',
      message: {
        chatId: '-100123',
        senderId: 'bot-2',
      },
      membership: {
        memberUserIds: ['bot-2'],
      },
    };

    expect(
      buildWebhookSemanticEventKey({
        ...base,
        message: { ...base.message, createdAt: '2026-07-10T12:00:00.123Z' },
      }),
    ).not.toBe(
      buildWebhookSemanticEventKey({
        ...base,
        message: { ...base.message, createdAt: '2026-07-10T12:00:00.456Z' },
      }),
    );
  });

  it('collapses mirrored bot receipts without including the transport bot id', () => {
    const payload = {
      type: 'message_created',
      message: {
        chatId: '-100123',
        messageId: 'mid-shared',
        createdAt: '2026-07-10T12:00:00.123Z',
      },
    };

    expect(buildWebhookSemanticEventKey({ ...payload, botId: 'bot-1' })).toBe(
      buildWebhookSemanticEventKey({ ...payload, botId: 'bot-6' }),
    );
  });

  it('keeps successive edits of the same message as distinct semantic events', () => {
    const base = {
      type: 'message_edited',
      message: {
        chatId: '-100123',
        messageId: 'mid-edited',
        timestamp: '2026-07-10T11:00:00.000Z',
      },
    };

    expect(
      buildWebhookSemanticEventKey({
        ...base,
        timestamp: '2026-07-10T12:00:00.123Z',
      }),
    ).not.toBe(
      buildWebhookSemanticEventKey({
        ...base,
        timestamp: '2026-07-10T12:00:00.456Z',
      }),
    );
  });

  it('does not deduplicate edits that have no event timestamp', () => {
    expect(
      buildWebhookSemanticEventKey({
        type: 'message_edited',
        message: { chatId: '-100123', messageId: 'mid-without-time' },
      }),
    ).toBeNull();
  });

  it('does not conflate bot lifecycle events with user membership events', () => {
    const payload = {
      message: {
        chatId: '-100123',
        senderId: 'bot-2',
        createdAt: '2026-07-10T12:00:00.123Z',
      },
      membership: {
        memberUserIds: ['bot-2'],
      },
    };

    expect(buildWebhookSemanticEventKey({ ...payload, type: 'bot_added' })).not.toBe(
      buildWebhookSemanticEventKey({ ...payload, type: 'user_added' }),
    );
  });

  it('does not canonicalize lifecycle events using an ingress-synthesized timestamp', () => {
    expect(
      buildWebhookSemanticEventKey({
        type: 'bot_added',
        botId: 'bot-1',
        eventTimestampSource: 'ingress',
        message: {
          chatId: '-100123',
          senderId: 'bot-1',
          createdAt: '2026-07-10T12:00:00.123Z',
        },
        membership: { memberUserIds: ['bot-1'] },
      }),
    ).toBeNull();
  });
});
