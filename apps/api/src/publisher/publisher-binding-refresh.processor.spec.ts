import { DelayedError, type Job } from 'bullmq';
import { PublisherBindingRefreshProcessor } from './publisher-binding-refresh.processor';
import type { PublisherBindingRefreshJob } from './publisher-binding-refresh.queue';
import { PublisherCandidateRefreshSupersededError } from './publisher-binding-refresh.service';
import { PUBLISHER_DISPATCH_PAUSE_DEFER_MS } from './publisher-dispatch-job-guard';
import { PublisherDispatchDisabledError } from './publisher-runtime-boundary.service';
import { PublisherDispatchPausedError } from './publisher-dispatch-health.service';

describe('PublisherBindingRefreshProcessor', () => {
  const previousRole = process.env.APP_ROLE;
  const previousServiceName = process.env.APP_SERVICE_NAME;
  const candidateJob: PublisherBindingRefreshJob = {
    version: 1,
    chatId: 'chat-1',
    publisherBotId: 'publik_bot',
    candidateUserId: 'admin-1',
    reason: 'bot_added',
    requestedAt: '2026-08-26T12:00:00.000Z',
  };
  const policyEnablementJob: PublisherBindingRefreshJob = {
    version: 1,
    chatId: 'channel-1',
    publisherBotId: 'publik_bot',
    reason: 'policy_enablement_recheck',
    requestedAt: '2026-08-31T20:24:29.000Z',
  };

  beforeEach(() => {
    process.env.APP_ROLE = 'publisher';
    process.env.APP_SERVICE_NAME = 'api-publisher';
  });

  afterEach(() => {
    if (previousRole === undefined) delete process.env.APP_ROLE;
    else process.env.APP_ROLE = previousRole;
    if (previousServiceName === undefined) delete process.env.APP_SERVICE_NAME;
    else process.env.APP_SERVICE_NAME = previousServiceName;
    jest.useRealTimers();
  });

  it('durably delays a candidate job without probing while Publisher dispatch is disabled', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-26T12:00:00.000Z'));
    const refresh = jest.fn();
    const runtimeBoundary = {
      assertDispatchEnabled: jest.fn(() => {
        throw new PublisherDispatchDisabledError();
      }),
    };
    const processor = new PublisherBindingRefreshProcessor(
      { refresh } as never,
      runtimeBoundary as never,
      { assertDispatchAllowed: jest.fn() } as never,
    );
    const moveToDelayed = jest.fn().mockResolvedValue(undefined);
    const job = {
      data: candidateJob,
      attemptsMade: 5,
      opts: { attempts: 6 },
      token: 'job-token',
      moveToDelayed,
    } as unknown as Job<PublisherBindingRefreshJob>;

    await expect(processor.process(job, 'worker-token')).rejects.toBeInstanceOf(DelayedError);

    expect(moveToDelayed).toHaveBeenCalledWith(
      Date.parse('2026-08-26T12:00:00.000Z') + PUBLISHER_DISPATCH_PAUSE_DEFER_MS,
      'worker-token',
    );
    expect(job.data.candidateUserId).toBe('admin-1');
    expect(job.attemptsMade).toBe(5);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('passes the preserved candidate to refresh after dispatch is enabled', async () => {
    const refresh = jest.fn().mockResolvedValue(undefined);
    const runtimeBoundary = { assertDispatchEnabled: jest.fn() };
    const processor = new PublisherBindingRefreshProcessor(
      { refresh } as never,
      runtimeBoundary as never,
      { assertDispatchAllowed: jest.fn().mockResolvedValue(undefined) } as never,
    );
    const job = {
      data: candidateJob,
      moveToDelayed: jest.fn(),
    } as unknown as Job<PublisherBindingRefreshJob>;

    await processor.process(job, 'worker-token');

    expect(runtimeBoundary.assertDispatchEnabled).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledWith(candidateJob);
    expect(job.moveToDelayed).not.toHaveBeenCalled();
  });

  it('durably delays a policy enablement recheck without requiring a candidate user', async () => {
    const refresh = jest.fn();
    const runtimeBoundary = {
      assertDispatchEnabled: jest.fn(() => {
        throw new PublisherDispatchDisabledError();
      }),
    };
    const processor = new PublisherBindingRefreshProcessor(
      { refresh } as never,
      runtimeBoundary as never,
      { assertDispatchAllowed: jest.fn() } as never,
    );
    const moveToDelayed = jest.fn().mockResolvedValue(undefined);
    const job = {
      data: policyEnablementJob,
      attemptsMade: 0,
      opts: { attempts: 6 },
      moveToDelayed,
    } as unknown as Job<PublisherBindingRefreshJob>;

    await expect(processor.process(job, 'worker-token')).rejects.toBeInstanceOf(DelayedError);

    expect(runtimeBoundary.assertDispatchEnabled).toHaveBeenCalledTimes(1);
    expect(moveToDelayed).toHaveBeenCalledWith(expect.any(Number), 'worker-token');
    expect(refresh).not.toHaveBeenCalled();
  });

  it('passes an enabled policy recheck to the exact Publisher refresh service', async () => {
    const refresh = jest.fn().mockResolvedValue(undefined);
    const runtimeBoundary = { assertDispatchEnabled: jest.fn() };
    const dispatchHealth = { assertDispatchAllowed: jest.fn().mockResolvedValue(undefined) };
    const processor = new PublisherBindingRefreshProcessor(
      { refresh } as never,
      runtimeBoundary as never,
      dispatchHealth as never,
    );
    const job = {
      data: policyEnablementJob,
      moveToDelayed: jest.fn(),
    } as unknown as Job<PublisherBindingRefreshJob>;

    await processor.process(job, 'worker-token');

    expect(runtimeBoundary.assertDispatchEnabled).toHaveBeenCalledTimes(1);
    expect(dispatchHealth.assertDispatchAllowed).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledWith(policyEnablementJob);
  });

  it('completes a superseded candidate refresh as a terminal no-op', async () => {
    const superseded = new PublisherCandidateRefreshSupersededError();
    const refresh = jest.fn().mockRejectedValue(superseded);
    const processor = new PublisherBindingRefreshProcessor(
      { refresh } as never,
      { assertDispatchEnabled: jest.fn() } as never,
      { assertDispatchAllowed: jest.fn().mockResolvedValue(undefined) } as never,
    );
    const job = {
      data: candidateJob,
      moveToDelayed: jest.fn(),
    } as unknown as Job<PublisherBindingRefreshJob>;

    await expect(processor.process(job, 'worker-token')).resolves.toBeUndefined();

    expect(refresh).toHaveBeenCalledWith(candidateJob);
    expect(job.moveToDelayed).not.toHaveBeenCalled();
  });

  it('propagates non-superseded refresh failures to BullMQ retries', async () => {
    const failure = new Error('publisher refresh transport failed');
    const refresh = jest.fn().mockRejectedValue(failure);
    const processor = new PublisherBindingRefreshProcessor(
      { refresh } as never,
      { assertDispatchEnabled: jest.fn() } as never,
      { assertDispatchAllowed: jest.fn().mockResolvedValue(undefined) } as never,
    );
    const job = {
      data: candidateJob,
      moveToDelayed: jest.fn(),
    } as unknown as Job<PublisherBindingRefreshJob>;

    await expect(processor.process(job, 'worker-token')).rejects.toBe(failure);
  });

  it('durably delays a candidate while exact Publisher dispatch health is paused', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-26T12:00:00.000Z'));
    const refresh = jest.fn();
    const processor = new PublisherBindingRefreshProcessor(
      { refresh } as never,
      { assertDispatchEnabled: jest.fn() } as never,
      {
        assertDispatchAllowed: jest
          .fn()
          .mockRejectedValue(new PublisherDispatchPausedError('2026-08-26T11:59:00.000Z')),
      } as never,
    );
    const moveToDelayed = jest.fn().mockResolvedValue(undefined);
    const job = {
      data: candidateJob,
      attemptsMade: 5,
      opts: { attempts: 6 },
      moveToDelayed,
    } as unknown as Job<PublisherBindingRefreshJob>;

    await expect(processor.process(job, 'worker-token')).rejects.toBeInstanceOf(DelayedError);

    expect(moveToDelayed).toHaveBeenCalledWith(
      Date.parse('2026-08-26T12:00:00.000Z') + PUBLISHER_DISPATCH_PAUSE_DEFER_MS,
      'worker-token',
    );
    expect(refresh).not.toHaveBeenCalled();
  });
});
