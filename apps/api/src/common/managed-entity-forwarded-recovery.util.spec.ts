import { extractManagedEntityForwardedRecoveryCandidate } from './managed-entity-forwarded-recovery.util';

const publisherOptions = { allowOfficialForwardContent: true };

function payload(messagePatch: Record<string, unknown> = {}, actor = '42') {
  return {
    type: 'message_created',
    message: { chatId: '123', senderId: actor, messageId: 'incoming' },
    raw: {
      update_type: 'message_created',
      message: {
        sender: { user_id: 42 },
        recipient: { chat_id: 123, chat_type: 'dialog' },
        body: { mid: 'incoming', text: '/start', attachments: null },
        link: { type: 'forward', chat_id: -70001, message: { mid: 'source' } },
        ...messagePatch,
      },
    },
  };
}

describe('managed entity forwarded recovery content boundary', () => {
  it.each([
    { text: '/start', attachments: null },
    { text: null, attachments: [{ type: 'image' }] },
    { text: null, attachments: [{ type: 'video' }] },
    { text: null, attachments: [{ type: 'file' }] },
  ])('requires Publisher opt-in for official outer content %j', (body) => {
    const update = payload({ body: { mid: 'incoming', ...body } });
    expect(extractManagedEntityForwardedRecoveryCandidate(update)).toBeNull();
    expect(extractManagedEntityForwardedRecoveryCandidate(update, publisherOptions)).toEqual({
      privateChatId: '123',
      sourceChatId: '-70001',
      forwarderUserId: '42',
      incomingMessageId: 'incoming',
      sourceMessageId: 'source',
    });
  });

  it.each([
    ['reply', { type: 'reply', chat_id: -70001, message: { mid: 'source' } }],
    ['unknown link', { type: 'unknown', chat_id: -70001, message: { mid: 'source' } }],
    ['hidden source', { type: 'forward', message: { mid: 'source' } }],
    ['private source', { type: 'forward', chat_id: 70001, message: { mid: 'source' } }],
    ['missing source message', { type: 'forward', chat_id: -70001, message: {} }],
  ])('rejects %s even when content is allowed', (_label, link) => {
    expect(
      extractManagedEntityForwardedRecoveryCandidate(payload({ link }), publisherOptions),
    ).toBeNull();
  });

  it('keeps legacy forwarded shapes strict and rejects raw/normalized actor disagreement', () => {
    const forwarded_message = { chat_id: -70001, message: { mid: 'source' } };
    expect(
      extractManagedEntityForwardedRecoveryCandidate(
        payload({ link: undefined, forwarded_message }),
        publisherOptions,
      ),
    ).toBeNull();
    expect(
      extractManagedEntityForwardedRecoveryCandidate(
        payload({ link: undefined, forwarded_message, body: null }),
      ),
    ).not.toBeNull();
    expect(
      extractManagedEntityForwardedRecoveryCandidate(payload({}, '999'), publisherOptions),
    ).toBeNull();
  });
});
