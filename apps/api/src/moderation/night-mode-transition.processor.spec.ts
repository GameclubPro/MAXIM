import type { Job } from 'bullmq';
import { MaxActionNoExecutableRouteError } from '../max/max-action-dispatch-error';
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

  it('completes a no-route transition and keeps future transitions scheduled', async () => {
    const moderationExecutionService = {
      processNightModeTransitionJob: jest
        .fn()
        .mockRejectedValue(new MaxActionNoExecutableRouteError('SEND_MESSAGE', 'chat-1')),
    };
    const scheduler = {
      enqueueNextTransitionsForChat: jest.fn().mockResolvedValue(undefined),
    };
    const processor = new NightModeTransitionProcessor(
      moderationExecutionService as never,
      scheduler as never,
    );

    await expect(processor.process(job)).resolves.toBeUndefined();

    expect(scheduler.enqueueNextTransitionsForChat).toHaveBeenCalledWith('chat-1');
  });

  it('keeps non-route processing failures on the BullMQ failure path', async () => {
    const processingError = new Error('state persistence failed');
    const moderationExecutionService = {
      processNightModeTransitionJob: jest.fn().mockRejectedValue(processingError),
    };
    const scheduler = {
      enqueueNextTransitionsForChat: jest.fn(),
    };
    const processor = new NightModeTransitionProcessor(
      moderationExecutionService as never,
      scheduler as never,
    );

    await expect(processor.process(job)).rejects.toBe(processingError);
    expect(scheduler.enqueueNextTransitionsForChat).not.toHaveBeenCalled();
  });
});
