import {
  DEFAULT_WEBHOOK_QUEUE_NAMES,
  JOIN_WEBHOOK_QUEUE_NAMES,
  resolveDefaultWebhookQueueIndexForChatId,
  resolveDefaultWebhookQueueNameForChatId,
  resolveJoinWebhookQueueNameForChatId,
  resolveWebhookQueueName,
  WEBHOOK_QUEUE_BACKGROUND,
  WEBHOOK_QUEUE_CRITICAL,
} from './webhook-queues';

describe('webhook-queues', () => {
  it('routes message_created updates deterministically by chat id', () => {
    expect(resolveDefaultWebhookQueueNameForChatId('-69202557471483')).toBe(
      resolveWebhookQueueName({
        type: 'message_created',
        message: { chatId: '-69202557471483' },
      }),
    );
  });

  it('routes message_edited updates through the same default shard as message_created', () => {
    const chatId = '-69202557471483';

    expect(resolveWebhookQueueName({ type: 'message_edited', message: { chatId } })).toBe(
      resolveDefaultWebhookQueueNameForChatId(chatId),
    );
  });

  it('spreads real numeric MAX chat ids across multiple default shards', () => {
    const hotChatIds = [
      '-69202557471483',
      '-69203671911163',
      '-70758799264456',
      '-69205664795387',
      '-70142531685064',
      '-71383271951048',
      '-70605438517459',
      '-69205136509691',
      '-69731350678267',
      '-72070918453960',
      '-68434907867770',
      '-70659436006088',
    ];

    const shardIndexes = new Set(
      hotChatIds.map((chatId) => resolveDefaultWebhookQueueIndexForChatId(chatId)),
    );

    expect(DEFAULT_WEBHOOK_QUEUE_NAMES).toHaveLength(16);
    expect(shardIndexes.size).toBeGreaterThanOrEqual(6);
    expect([...shardIndexes].every((value) => value === 0 || value === 1)).toBe(false);
  });

  it('keeps critical and background events out of default shards', () => {
    expect(resolveWebhookQueueName({ type: 'message_callback' })).toBe(WEBHOOK_QUEUE_CRITICAL);
    expect(resolveWebhookQueueName({ type: 'user_removed' })).toBe(WEBHOOK_QUEUE_BACKGROUND);
  });

  it('routes user_added updates into deterministic join shards', () => {
    const chatId = '-72826040868309';
    expect(resolveWebhookQueueName({ type: 'user_added', message: { chatId } })).toBe(
      resolveJoinWebhookQueueNameForChatId(chatId),
    );
    expect(JOIN_WEBHOOK_QUEUE_NAMES).toContain(resolveJoinWebhookQueueNameForChatId(chatId));
  });
});
