import type { MaxUpdate } from '@maxim/contracts';
import {
  extractPublisherAutoReplyMessageCandidate,
  normalizePublisherAutoReplyTrigger,
} from './publisher-auto-reply-normalization';

function buildUpdate(overrides: Partial<MaxUpdate> = {}): MaxUpdate {
  return {
    updateId: 'update-1',
    botId: 'publisher-bot',
    type: 'message_created',
    message: {
      messageId: 'message-1',
      chatId: '-100',
      entityType: 'chat',
      senderId: 'user-1',
      text: '  ПРАЙС\tна   сегодня  ',
      createdAt: '2026-08-29T12:00:00.000Z',
    },
    raw: {
      update_type: 'message_created',
      message: {
        body: { mid: 'message-1', text: '  ПРАЙС\tна   сегодня  ' },
        sender: { user_id: 'user-1' },
        recipient: { chat_id: '-100', chat_type: 'chat' },
      },
    },
    ...overrides,
  };
}

const options = {
  publisherBotId: 'publisher-bot',
  isKnownRuntimeBotUserId: (userId: string) => userId.startsWith('bot-'),
};

describe('Publisher auto-reply normalization', () => {
  it('normalizes compatibility forms, Russian case and whitespace', () => {
    expect(normalizePublisherAutoReplyTrigger('  ＰРАЙС\n\tЁЖ  ')).toBe('pрайс ёж');
  });

  it('extracts a direct authored group-chat text candidate', () => {
    expect(extractPublisherAutoReplyMessageCandidate(buildUpdate(), options)).toEqual({
      chatId: '-100',
      sourceMessageId: 'message-1',
      senderUserId: 'user-1',
      normalizedTrigger: 'прайс на сегодня',
    });
  });

  it('rejects known runtime bot messages', () => {
    const update = buildUpdate({
      message: { ...buildUpdate().message!, senderId: 'bot-major' },
    });
    expect(extractPublisherAutoReplyMessageCandidate(update, options)).toBeNull();
  });

  it('rejects forwarded messages even with supplemental authored text', () => {
    const update = buildUpdate();
    const rawMessage = (update.raw?.message ?? {}) as Record<string, unknown>;
    rawMessage.link = { type: 'forward', message: { mid: 'source-1', text: 'ПРАЙС' } };
    expect(extractPublisherAutoReplyMessageCandidate(update, options)).toBeNull();
  });

  it.each(['dialog', 'channel'] as const)('rejects %s recipients', (chatType) => {
    const update = buildUpdate({
      message: {
        ...buildUpdate().message!,
        entityType: chatType === 'channel' ? 'channel' : undefined,
      },
    });
    const rawMessage = (update.raw?.message ?? {}) as Record<string, unknown>;
    rawMessage.recipient = { chat_id: chatType === 'dialog' ? '100' : '-100', chat_type: chatType };
    expect(extractPublisherAutoReplyMessageCandidate(update, options)).toBeNull();
  });

  it('rejects service and attachment-bearing messages', () => {
    const service = buildUpdate();
    (
      (service.raw?.message as Record<string, unknown>).body as Record<string, unknown>
    ).new_members = [{ user_id: '2' }];
    expect(extractPublisherAutoReplyMessageCandidate(service, options)).toBeNull();

    const media = buildUpdate();
    ((media.raw?.message as Record<string, unknown>).body as Record<string, unknown>).attachments =
      [{ type: 'image' }];
    expect(extractPublisherAutoReplyMessageCandidate(media, options)).toBeNull();
  });

  it('rejects edited events', () => {
    expect(
      extractPublisherAutoReplyMessageCandidate(buildUpdate({ type: 'message_edited' }), options),
    ).toBeNull();
  });
});
