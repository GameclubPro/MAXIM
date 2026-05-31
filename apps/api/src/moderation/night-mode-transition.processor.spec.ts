import type { Job } from 'bullmq';
import { NightModeTransitionProcessor } from './night-mode-transition.processor';
import type { NightModeTransitionJob } from './night-mode-transition.queue';

describe('NightModeTransitionProcessor', () => {
  const job = {
    data: {
      chatId: 'chat-1',
      transition: 'open',
      scheduledFor: '2026-05-31T05:00:00.000Z',
      sessionKey: 'v1:Europe/Moscow:23:00:08:00:2026-05-30',
    },
  } as Job<NightModeTransitionJob>;

  it('does not enqueue the next transition after access-loss processing result', async () => {
    const moderationExecutionService = {
      processNightModeTransitionJob: jest.fn().mockResolvedValue({ shouldEnqueueNext: false }),
    };
    const scheduler = {
      enqueueNextTransitionsForChat: jest.fn(),
    };
    const processor = new NightModeTransitionProcessor(
      moderationExecutionService as never,
      scheduler as never,
    );

    await processor.process(job);

    expect(moderationExecutionService.processNightModeTransitionJob).toHaveBeenCalledWith(job.data);
    expect(scheduler.enqueueNextTransitionsForChat).not.toHaveBeenCalled();
  });

  it('enqueues the next transition after a normal processing result', async () => {
    const moderationExecutionService = {
      processNightModeTransitionJob: jest.fn().mockResolvedValue({ shouldEnqueueNext: true }),
    };
    const scheduler = {
      enqueueNextTransitionsForChat: jest.fn().mockResolvedValue(undefined),
    };
    const processor = new NightModeTransitionProcessor(
      moderationExecutionService as never,
      scheduler as never,
    );

    await processor.process(job);

    expect(scheduler.enqueueNextTransitionsForChat).toHaveBeenCalledWith('chat-1');
  });
});
