import { DelayedError, UnrecoverableError, type Job } from 'bullmq';
import {
  MaxActionNoExecutableRouteError,
  MaxActionRouteQuarantinedError,
} from '../max/max-action-dispatch-error';
import { NightModeTransitionProcessor } from './night-mode-transition.processor';
import type { NightModeTransitionJob } from './night-mode-transition.queue';

describe('NightModeTransitionProcessor', () => {
  const buildJob = () =>
    ({
      data: {
        chatId: 'chat-1',
        transition: 'close',
        scheduledFor: '2026-05-30T20:00:00.000Z',
        sessionKey: 'v1:Europe/Moscow:23:00:08:00:2026-05-30',
      },
      moveToDelayed: jest.fn().mockResolvedValue(undefined),
    }) as unknown as Job<NightModeTransitionJob>;

  afterEach(() => {
    jest.useRealTimers();
  });

  it('does not enqueue the next transition after access-loss processing result', async () => {
    const job = buildJob();
    const moderationExecutionService = {
      processNightModeTransitionJob: jest.fn().mockResolvedValue({ shouldEnqueueNext: false }),
    };
    const scheduler = {
      shouldProcessChatTransitions: jest.fn().mockResolvedValue(true),
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
    const job = buildJob();
    const moderationExecutionService = {
      processNightModeTransitionJob: jest.fn().mockResolvedValue({ shouldEnqueueNext: true }),
    };
    const scheduler = {
      shouldProcessChatTransitions: jest.fn().mockResolvedValue(true),
      enqueueNextTransitionsForChat: jest.fn().mockResolvedValue(undefined),
    };
    const processor = new NightModeTransitionProcessor(
      moderationExecutionService as never,
      scheduler as never,
    );

    await processor.process(job);

    expect(scheduler.enqueueNextTransitionsForChat).toHaveBeenCalledWith('chat-1');
  });

  it('delays a no-route transition without scheduling past the missed occurrence', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-31T04:59:00.000Z'));
    const job = buildJob();
    const moderationExecutionService = {
      processNightModeTransitionJob: jest
        .fn()
        .mockRejectedValue(new MaxActionNoExecutableRouteError('SEND_MESSAGE', 'chat-1')),
    };
    const scheduler = {
      shouldProcessChatTransitions: jest.fn().mockResolvedValue(true),
      enqueueNextTransitionsForChat: jest.fn().mockResolvedValue(undefined),
    };
    const processor = new NightModeTransitionProcessor(
      moderationExecutionService as never,
      scheduler as never,
    );

    await expect(processor.process(job, 'lock-token')).rejects.toBeInstanceOf(DelayedError);

    expect(job.moveToDelayed).toHaveBeenCalledWith(
      new Date('2026-05-31T05:04:00.000Z').getTime(),
      'lock-token',
    );
    expect(scheduler.enqueueNextTransitionsForChat).not.toHaveBeenCalled();
  });

  it('delays a quarantined route until its retry time', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-31T05:00:00.000Z'));
    const retryAt = new Date('2026-05-31T05:02:30.000Z');
    const job = buildJob();
    const moderationExecutionService = {
      processNightModeTransitionJob: jest
        .fn()
        .mockRejectedValue(
          new MaxActionRouteQuarantinedError('SEND_MESSAGE', 'chat-1', retryAt, ['bot-1']),
        ),
    };
    const scheduler = {
      shouldProcessChatTransitions: jest.fn().mockResolvedValue(true),
      enqueueNextTransitionsForChat: jest.fn(),
    };
    const processor = new NightModeTransitionProcessor(
      moderationExecutionService as never,
      scheduler as never,
    );

    await expect(processor.process(job, 'lock-token')).rejects.toBeInstanceOf(DelayedError);

    expect(job.moveToDelayed).toHaveBeenCalledWith(retryAt.getTime(), 'lock-token');
    expect(scheduler.enqueueNextTransitionsForChat).not.toHaveBeenCalled();
  });

  it('applies a minimum delay when the quarantine retry time is stale', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-31T05:00:00.000Z'));
    const job = buildJob();
    const moderationExecutionService = {
      processNightModeTransitionJob: jest
        .fn()
        .mockRejectedValue(
          new MaxActionRouteQuarantinedError(
            'SEND_MESSAGE',
            'chat-1',
            new Date('2026-05-31T04:59:00.000Z'),
            ['bot-1'],
          ),
        ),
    };
    const scheduler = {
      shouldProcessChatTransitions: jest.fn().mockResolvedValue(true),
      enqueueNextTransitionsForChat: jest.fn(),
    };
    const processor = new NightModeTransitionProcessor(
      moderationExecutionService as never,
      scheduler as never,
    );

    await expect(processor.process(job, 'lock-token')).rejects.toBeInstanceOf(DelayedError);

    expect(job.moveToDelayed).toHaveBeenCalledWith(
      new Date('2026-05-31T05:00:15.000Z').getTime(),
      'lock-token',
    );
    expect(scheduler.enqueueNextTransitionsForChat).not.toHaveBeenCalled();
  });

  it('schedules future transitions when the delayed occurrence later succeeds', async () => {
    const job = buildJob();
    const moderationExecutionService = {
      processNightModeTransitionJob: jest
        .fn()
        .mockRejectedValueOnce(new MaxActionNoExecutableRouteError('SEND_MESSAGE', 'chat-1'))
        .mockResolvedValueOnce({ shouldEnqueueNext: true }),
    };
    const scheduler = {
      shouldProcessChatTransitions: jest.fn().mockResolvedValue(true),
      enqueueNextTransitionsForChat: jest.fn().mockResolvedValue(undefined),
    };
    const processor = new NightModeTransitionProcessor(
      moderationExecutionService as never,
      scheduler as never,
    );

    await expect(processor.process(job, 'lock-token')).rejects.toBeInstanceOf(DelayedError);
    await expect(processor.process(job, 'lock-token')).resolves.toBeUndefined();

    expect(scheduler.enqueueNextTransitionsForChat).toHaveBeenCalledTimes(1);
    expect(scheduler.enqueueNextTransitionsForChat).toHaveBeenCalledWith('chat-1');
  });

  it('falls back to a retryable no-route failure when the lock token is unavailable', async () => {
    const job = buildJob();
    const noRouteError = new MaxActionNoExecutableRouteError('SEND_MESSAGE', 'chat-1');
    const moderationExecutionService = {
      processNightModeTransitionJob: jest.fn().mockRejectedValue(noRouteError),
    };
    const scheduler = {
      shouldProcessChatTransitions: jest.fn().mockResolvedValue(true),
      enqueueNextTransitionsForChat: jest.fn(),
    };
    const processor = new NightModeTransitionProcessor(
      moderationExecutionService as never,
      scheduler as never,
    );

    const processing = processor.process(job);

    await expect(processing).rejects.toEqual(new Error(noRouteError.message));
    await expect(processing).rejects.not.toBeInstanceOf(UnrecoverableError);
    expect(job.moveToDelayed).not.toHaveBeenCalled();
    expect(scheduler.enqueueNextTransitionsForChat).not.toHaveBeenCalled();
  });

  it('falls back to a retryable no-route failure when delaying the job fails', async () => {
    const job = buildJob();
    (job.moveToDelayed as jest.Mock).mockRejectedValue(new Error('redis unavailable'));
    const noRouteError = new MaxActionNoExecutableRouteError('SEND_MESSAGE', 'chat-1');
    const moderationExecutionService = {
      processNightModeTransitionJob: jest.fn().mockRejectedValue(noRouteError),
    };
    const scheduler = {
      shouldProcessChatTransitions: jest.fn().mockResolvedValue(true),
      enqueueNextTransitionsForChat: jest.fn(),
    };
    const processor = new NightModeTransitionProcessor(
      moderationExecutionService as never,
      scheduler as never,
    );

    const processing = processor.process(job, 'lock-token');

    await expect(processing).rejects.toEqual(new Error(noRouteError.message));
    await expect(processing).rejects.not.toBeInstanceOf(UnrecoverableError);
    expect(job.moveToDelayed).toHaveBeenCalledWith(expect.any(Number), 'lock-token');
    expect(scheduler.enqueueNextTransitionsForChat).not.toHaveBeenCalled();
  });

  it('keeps non-route processing failures on the BullMQ failure path', async () => {
    const job = buildJob();
    const processingError = new Error('state persistence failed');
    const moderationExecutionService = {
      processNightModeTransitionJob: jest.fn().mockRejectedValue(processingError),
    };
    const scheduler = {
      shouldProcessChatTransitions: jest.fn().mockResolvedValue(true),
      enqueueNextTransitionsForChat: jest.fn(),
    };
    const processor = new NightModeTransitionProcessor(
      moderationExecutionService as never,
      scheduler as never,
    );

    await expect(processor.process(job)).rejects.toBe(processingError);
    expect(scheduler.enqueueNextTransitionsForChat).not.toHaveBeenCalled();
  });

  it('completes an all-removed transition without entering moderation or MAX routing', async () => {
    const job = buildJob();
    const moderationExecutionService = {
      processNightModeTransitionJob: jest.fn(),
    };
    const scheduler = {
      shouldProcessChatTransitions: jest.fn().mockResolvedValue(false),
      enqueueNextTransitionsForChat: jest.fn(),
    };
    const processor = new NightModeTransitionProcessor(
      moderationExecutionService as never,
      scheduler as never,
    );

    await expect(processor.process(job, 'lock-token')).resolves.toBeUndefined();

    expect(moderationExecutionService.processNightModeTransitionJob).not.toHaveBeenCalled();
    expect(job.moveToDelayed).not.toHaveBeenCalled();
    expect(scheduler.enqueueNextTransitionsForChat).not.toHaveBeenCalled();
  });

  it('does not delay a no-route job when removal wins during route resolution', async () => {
    const job = buildJob();
    const moderationExecutionService = {
      processNightModeTransitionJob: jest
        .fn()
        .mockRejectedValue(new MaxActionNoExecutableRouteError('SEND_MESSAGE', 'chat-1')),
    };
    const scheduler = {
      shouldProcessChatTransitions: jest
        .fn()
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false),
      enqueueNextTransitionsForChat: jest.fn(),
    };
    const processor = new NightModeTransitionProcessor(
      moderationExecutionService as never,
      scheduler as never,
    );

    await expect(processor.process(job, 'lock-token')).resolves.toBeUndefined();

    expect(moderationExecutionService.processNightModeTransitionJob).toHaveBeenCalledTimes(1);
    expect(scheduler.shouldProcessChatTransitions).toHaveBeenCalledTimes(2);
    expect(job.moveToDelayed).not.toHaveBeenCalled();
  });
});
