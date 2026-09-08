import type { Job } from 'bullmq';
import { UnrecoverableError } from 'bullmq';
import { USER_AGREEMENT_START_NOTICE } from '../common/user-agreement-notice';
import { PublisherDispatchDisabledError } from './publisher-runtime-boundary.service';
import { PublisherStartProcessor, buildPublisherStartText } from './publisher-start.processor';
import type { PublisherStartJob } from './publisher-start.queue';

describe('PublisherStartProcessor', () => {
  const oldRole = process.env.APP_ROLE;
  const oldService = process.env.APP_SERVICE_NAME;
  beforeEach(() => {
    process.env.APP_ROLE = 'publisher';
    process.env.APP_SERVICE_NAME = 'api-publisher';
  });
  afterEach(() => {
    if (oldRole === undefined) delete process.env.APP_ROLE;
    else process.env.APP_ROLE = oldRole;
    if (oldService === undefined) delete process.env.APP_SERVICE_NAME;
    else process.env.APP_SERVICE_NAME = oldService;
  });

  function fixture() {
    const job = {
      id: 'start-1',
      data: {
        version: 1,
        publisherBotId: 'publisher-bot',
        privateChatId: '123',
        requestedAt: new Date().toISOString(),
      },
      updateData: jest.fn(async (data: PublisherStartJob) => {
        job.data = data;
      }),
    };
    const maxClient = {
      sendMessageImmediateWithId: jest.fn(async (_chat, _text, options) => {
        await options.beforeSend();
        return { messageId: 'sent-1' };
      }),
    };
    const runtime = { assertDispatchEnabled: jest.fn() };
    const identity = { assertAttested: jest.fn() };
    const health = { assertDispatchAllowed: jest.fn() };
    const queue = { claimDispatch: jest.fn().mockResolvedValue(true) };
    const links = {
      buildMiniappStartUrlSync: jest
        .fn()
        .mockReturnValue('https://max.ru/publisher-bot?startapp=home'),
    };
    const processor = new PublisherStartProcessor(
      maxClient as never,
      {
        getPublisherBotDescriptor: () => ({ id: 'publisher-bot' }),
      } as never,
      links as never,
      { get: () => undefined } as never,
      runtime as never,
      identity as never,
      health as never,
      queue as never,
    );
    return {
      processor,
      job: job as unknown as Job<PublisherStartJob>,
      maxClient,
      runtime,
      identity,
      health,
      queue,
      links,
    };
  }

  it('sends the approved Markdown with Major and legal hyperlinks using only the Publisher bot', async () => {
    const { processor, job, maxClient, links } = fixture();
    await processor.process(job);
    const text = buildPublisherStartText();
    expect(text).toContain('[Майора Максимова](https://max.ru/id613070470872_9_bot)');
    expect(text).toContain(USER_AGREEMENT_START_NOTICE);
    expect(text).toContain('автопостинг из VK.');
    expect(text).not.toContain('Настройки модерации');
    expect(maxClient.sendMessageImmediateWithId).toHaveBeenCalledWith(
      '123',
      text,
      expect.objectContaining({
        textFormat: 'markdown',
        buttons: [
          [
            expect.objectContaining({
              text: 'Открыть Публик',
              url: 'https://max.ru/publisher-bot?startapp=home',
            }),
          ],
          [expect.objectContaining({ text: 'Поддержка' })],
        ],
      }),
      expect.objectContaining({
        botId: 'publisher-bot',
        trafficClass: 'interactive',
        sourceTag: 'publisher_start',
      }),
    );
    expect(links.buildMiniappStartUrlSync).toHaveBeenCalledWith(
      expect.stringMatching(/^mr-/u),
      'publisher-bot',
    );
    expect(job.data.dispatchStarted).toBe(true);
    await processor.process(job);
    expect(maxClient.sendMessageImmediateWithId).toHaveBeenCalledTimes(1);
  });

  it('uses the configured legal document origin', () => {
    expect(buildPublisherStartText('https://example.test/')).toContain(
      '[пользовательское соглашение](https://example.test/app/legal/agreement)',
    );
  });

  it('refuses another role or bot identity', async () => {
    const { processor, job, maxClient } = fixture();
    process.env.APP_ROLE = 'action';
    await expect(processor.process(job)).rejects.toThrow('outside api-publisher');
    process.env.APP_ROLE = 'publisher';
    job.data.publisherBotId = 'major-bot';
    await expect(processor.process(job)).rejects.toBeInstanceOf(UnrecoverableError);
    expect(maxClient.sendMessageImmediateWithId).not.toHaveBeenCalled();
  });

  it('checks runtime, identity and dispatch health before touching the send fence', async () => {
    for (const guard of ['runtime', 'identity', 'health'] as const) {
      const fixtureValue = fixture();
      const { processor, job, maxClient, queue, runtime, identity, health } = fixtureValue;
      const error = new Error('guard unavailable');
      if (guard === 'runtime')
        runtime.assertDispatchEnabled.mockImplementation(() => {
          throw new PublisherDispatchDisabledError();
        });
      if (guard === 'identity') identity.assertAttested.mockRejectedValue(error);
      if (guard === 'health') health.assertDispatchAllowed.mockRejectedValue(error);
      await expect(processor.process(job)).rejects.toThrow();
      expect(maxClient.sendMessageImmediateWithId).not.toHaveBeenCalled();
      expect(queue.claimDispatch).not.toHaveBeenCalled();
    }
  });

  it('does not automatically retry an ambiguous send', async () => {
    const { processor, job, maxClient } = fixture();
    maxClient.sendMessageImmediateWithId.mockImplementationOnce(async (_chat, _text, options) => {
      await options.beforeSend();
      throw new Error('timeout');
    });
    await expect(processor.process(job)).rejects.toBeInstanceOf(UnrecoverableError);
    await processor.process(job);
    expect(maxClient.sendMessageImmediateWithId).toHaveBeenCalledTimes(1);
  });

  it('fences competing workers and refuses to send when persisting the marker fails', async () => {
    const { processor, job, queue } = fixture();
    queue.claimDispatch.mockResolvedValueOnce(false);
    await expect(processor.process(job)).rejects.toBeInstanceOf(UnrecoverableError);
    expect(job.updateData).not.toHaveBeenCalled();
    (job.updateData as jest.Mock).mockRejectedValueOnce(new Error('redis disconnected'));
    await expect(processor.process(job)).rejects.toBeInstanceOf(UnrecoverableError);
  });

  it('allows preparation failures to retry without claiming dispatch', async () => {
    const { processor, job, maxClient, queue } = fixture();
    const error = new Error('rate limited before dispatch');
    maxClient.sendMessageImmediateWithId.mockRejectedValueOnce(error);
    await expect(processor.process(job)).rejects.toBe(error);
    expect(queue.claimDispatch).not.toHaveBeenCalled();
    expect(job.updateData).not.toHaveBeenCalled();
  });

  it('discards stale queued greetings', async () => {
    const { processor, job, maxClient } = fixture();
    job.data.requestedAt = '2020-01-01T00:00:00Z';
    await processor.process(job);
    expect(maxClient.sendMessageImmediateWithId).not.toHaveBeenCalled();
  });
});
