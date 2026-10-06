import {
  legacyBotCleanupSourceAt,
  readLegacyBotCleanupSourceAt,
} from './legacy-bot-message-cleanup-source';

function fixture() {
  const at = Date.now() - 60_000;
  return {
    at,
    params: {
      chatId: '-1',
      messageId: 'notice',
      userId: '10',
      raw: {
        update_type: 'message_created',
        timestamp: Date.now(),
        message: {
          timestamp: at,
          sender: { user_id: 10, is_bot: true },
          recipient: { chat_id: -1, chat_type: 'chat' },
          body: { mid: 'notice' },
        },
      },
    },
  };
}

it('uses the original message clock despite a later webhook clock', () => {
  const { at, params } = fixture();
  expect(legacyBotCleanupSourceAt(params)?.getTime()).toBe(at);
});

it.each(['missing', 'edited', 'future', 'human', 'chat', 'message', 'user'])(
  'does not grant a source clock from %s evidence',
  (kind) => {
    const { params } = fixture();
    if (kind === 'missing')
      return expect(legacyBotCleanupSourceAt({ ...params, raw: null })).toBeNull();
    if (kind === 'edited') params.raw.update_type = 'message_edited';
    if (kind === 'future') params.raw.message.timestamp = Date.now() + 100_000;
    if (kind === 'human') params.raw.message.sender.is_bot = false;
    if (kind === 'chat') params.raw.message.recipient.chat_id = -2;
    if (kind === 'message') params.raw.message.body.mid = 'other';
    if (kind === 'user') params.raw.message.sender.user_id = 11;
    expect(legacyBotCleanupSourceAt(params)).toBeNull();
  },
);

it('requires versioned original-clock evidence for a persisted cleanup', () => {
  const at = new Date(Date.now() - 60_000).toISOString();
  expect(readLegacyBotCleanupSourceAt({ sourceMessageAt: at })).toBeNull();
  expect(readLegacyBotCleanupSourceAt({ botMessageOriginalCreatedAt: at })).toBeNull();
  expect(
    readLegacyBotCleanupSourceAt({
      botMessageOriginalCreatedAt: at,
      botMessageOriginalCreatedAtSource: 'max_message_timestamp_v1',
    })?.toISOString(),
  ).toBe(at);
});
