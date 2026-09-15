import type { MaxUpdate } from '@maxim/contracts';
import { PublisherVkBotReviewQueueService } from './publisher-vk-bot-review.queue';

function fixture() {
  const queue = { add: jest.fn().mockResolvedValue(undefined) };
  const registry = { getPublisherBotDescriptor: () => ({ id: 'publik_bot' }) };
  return {
    queue,
    service: new PublisherVkBotReviewQueueService(queue as never, registry as never),
  };
}
function update(overrides: Partial<MaxUpdate> = {}): MaxUpdate {
  return {
    botId: 'publik_bot',
    updateId: 'update-1',
    type: 'message_created',
    message: {
      chatId: '42',
      senderId: '17',
      messageId: 'message-1',
      text: '/vk',
      createdAt: new Date().toISOString(),
    },
    raw: { timestamp: Date.now() },
    ...overrides,
  };
}
describe('Publisher VK review queue', () => {
  it('binds an explicit private command to the authenticated Publisher scope', async () => {
    const { queue, service } = fixture();
    await expect(service.observeWebhook(update())).resolves.toBe(true);
    expect(queue.add).toHaveBeenCalledWith(
      'vk-bot-review',
      expect.objectContaining({
        kind: 'vk-bot-review',
        action: 'connect',
        requiredBotId: 'publik_bot',
        userId: '17',
        privateChatId: '42',
      }),
      expect.objectContaining({ priority: 1 }),
    );
  });
  it('deduplicates replayed webhook jobs', async () => {
    const { queue, service } = fixture();
    await service.observeWebhook(update());
    await service.observeWebhook(update());
    expect(queue.add.mock.calls[0]?.[2].jobId).toBe(queue.add.mock.calls[1]?.[2].jobId);
  });
  it.each([
    { botId: 'major' },
    { message: { ...update().message!, chatId: '-123' } },
    { message: { ...update().message!, text: 'ordinary post' } },
    { raw: { timestamp: Date.now() - 3 * 24 * 60 * 60_000 } },
  ])('does not enqueue an unrelated, non-private or expired update', async (patch) => {
    const { queue, service } = fixture();
    await service.observeWebhook(update(patch));
    expect(queue.add).not.toHaveBeenCalled();
  });
  it('takes callback actor from callback.user, not the bot-authored message sender', async () => {
    const { queue, service } = fixture();
    await service.observeWebhook(
      update({
        type: 'message_callback',
        message: { ...update().message!, senderId: 'bot' },
        raw: {
          timestamp: Date.now(),
          callback: {
            timestamp: Date.now(),
            callback_id: 'cb',
            payload: 'vkr:v1:publish:review-1:2',
            user: { user_id: 17 },
          },
        },
      }),
    );
    expect(queue.add).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ userId: '17', id: 'review-1', revision: 2, action: 'publish' }),
      expect.anything(),
    );
  });
});
