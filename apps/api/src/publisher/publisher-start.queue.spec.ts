import type { MaxUpdate } from '@maxim/contracts';
import { WebhookParser } from '../webhook/webhook.parser';
import { PublisherStartQueueService, PUBLISHER_START_MAX_AGE_MS } from './publisher-start.queue';

describe('PublisherStartQueueService', () => {
  const publisherBotId = 'publisher-bot';
  const now = new Date('2026-09-08T12:00:00Z');
  const parser = new WebhookParser();

  function fixture() {
    const client = { defineCommand: jest.fn(), runCommand: jest.fn().mockResolvedValue('OK') };
    const queue = {
      add: jest.fn(),
      client: Promise.resolve(client),
      toKey: (key: string) => `bull:publisher-start:${key}`,
    };
    const service = new PublisherStartQueueService(
      queue as never,
      {
        getPublisherBotDescriptor: () => ({ id: publisherBotId }),
      } as never,
    );
    return { service, queue, client };
  }

  function start(payload: Record<string, unknown> = {}): MaxUpdate {
    return parser.parse(
      {
        update_type: 'bot_started',
        timestamp: now.getTime(),
        chat_id: 123,
        user: { user_id: 42 },
        ...payload,
      },
      { botId: publisherBotId },
    );
  }

  beforeEach(() => jest.useFakeTimers().setSystemTime(now));
  afterEach(() => jest.useRealTimers());

  it('queues the first native start and deduplicates repeated delivery of that event', async () => {
    const { service, queue } = fixture();
    const update = start();
    await expect(service.observeWebhook(update)).resolves.toBe(true);
    await service.observeWebhook(update);
    expect(queue.add).toHaveBeenCalledWith(
      'greet',
      {
        version: 1,
        publisherBotId,
        privateChatId: '123',
        requestedAt: now.toISOString(),
      },
      expect.objectContaining({
        attempts: 3,
        removeOnComplete: { age: 172800 },
        removeOnFail: { age: 172800 },
      }),
    );
    expect(queue.add.mock.calls[0][2].jobId).toBe(queue.add.mock.calls[1][2].jobId);
  });

  it.each(['/start', 'Старт'])('supports the private %s command', async (text) => {
    const { service, queue } = fixture();
    const update = parser.parse(
      {
        update_type: 'message_created',
        timestamp: now.getTime(),
        message: {
          timestamp: now.getTime(),
          sender: { user_id: 42 },
          recipient: { chat_id: 123, chat_type: 'dialog' },
          body: { mid: 'msg-1', text },
        },
      },
      { botId: publisherBotId },
    );
    await expect(service.observeWebhook(update)).resolves.toBe(true);
    expect(queue.add).toHaveBeenCalledTimes(1);
  });

  it.each(['pi_token', 'pa_token', 'unknown'])(
    'does not consume deep-linked start %s',
    async (payload) => {
      const { service, queue } = fixture();
      await expect(service.observeWebhook(start({ payload }))).resolves.toBe(false);
      expect(queue.add).not.toHaveBeenCalled();
    },
  );

  it('leaves other bots, group starts and channels untouched', async () => {
    const { service, queue } = fixture();
    const update = start();
    for (const candidate of [
      { ...update, botId: 'major-bot' },
      { ...update, message: { ...update.message!, chatId: '-123' } },
      { ...update, message: { ...update.message!, entityType: 'channel' as const } },
      { ...update, message: undefined },
      { ...update, type: 'message_edited' },
    ])
      await expect(service.observeWebhook(candidate)).resolves.toBe(false);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('does not revive stale, future or untrusted starts after job retention ends', async () => {
    const { service, queue } = fixture();
    await service.observeWebhook(
      start({ timestamp: now.getTime() - PUBLISHER_START_MAX_AGE_MS - 1 }),
    );
    await service.observeWebhook(start({ timestamp: now.getTime() + 120_000 }));
    await service.observeWebhook({ ...start(), eventTimestampSource: 'ingress' });
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('atomically claims a dispatch for longer than the accepted event age', async () => {
    const { service, client } = fixture();
    await expect(service.claimDispatch('job-1')).resolves.toBe(true);
    client.runCommand.mockResolvedValueOnce(null);
    await expect(service.claimDispatch('job-1')).resolves.toBe(false);
    expect(client.runCommand).toHaveBeenCalledWith('claimPublisherStartDispatch', [
      'bull:publisher-start:dispatch-job-1',
      2 * PUBLISHER_START_MAX_AGE_MS,
    ]);
  });
});
