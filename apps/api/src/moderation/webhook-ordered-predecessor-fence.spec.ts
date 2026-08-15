import { DelayedError } from 'bullmq';

import { CriticalWebhookProcessor } from './moderation.service';
import {
  deferWebhookOrderedPredecessorJob,
  WebhookOrderedPredecessorPendingError,
} from './webhook-ordered-predecessor-fence';

describe('webhook ordered predecessor fence', () => {
  const originalAppRole = process.env.APP_ROLE;

  afterEach(() => {
    if (originalAppRole === undefined) {
      delete process.env.APP_ROLE;
    } else {
      process.env.APP_ROLE = originalAppRole;
    }
    jest.restoreAllMocks();
  });

  it('defers a static Nest worker job instead of completing it', async () => {
    process.env.APP_ROLE = 'moderation';
    const error = new WebhookOrderedPredecessorPendingError('event-b', 'event-a');
    const moderationExecutionService = {
      processWebhookEvent: jest.fn().mockRejectedValue(error),
    };
    const Processor = CriticalWebhookProcessor as unknown as new (
      service: typeof moderationExecutionService,
    ) => {
      process: (job: unknown, token?: string) => Promise<void>;
    };
    const processor = new Processor(moderationExecutionService);
    const job = {
      id: 'event-b',
      data: { webhookEventId: 'event-b' },
      moveToDelayed: jest.fn().mockResolvedValue(undefined),
    };

    await expect(processor.process(job, 'static-job-token')).rejects.toBeInstanceOf(DelayedError);

    expect(moderationExecutionService.processWebhookEvent).toHaveBeenCalledWith('event-b');
    expect(job.moveToDelayed).toHaveBeenCalledWith(expect.any(Number), 'static-job-token');
  });

  it('moves a locked BullMQ job to a short deterministic delay', async () => {
    const nowMs = Date.parse('2026-08-15T12:00:00.000Z');
    jest.spyOn(Date, 'now').mockReturnValue(nowMs);
    const error = new WebhookOrderedPredecessorPendingError('event-b', 'event-a');
    const job = {
      id: 'event-b',
      token: 'job-token',
      moveToDelayed: jest.fn().mockResolvedValue(undefined),
    };

    await expect(
      deferWebhookOrderedPredecessorJob(job as never, undefined, error),
    ).rejects.toBeInstanceOf(DelayedError);

    expect(job.moveToDelayed).toHaveBeenCalledWith(expect.any(Number), 'job-token');
    const delayedUntilMs = job.moveToDelayed.mock.calls[0]?.[0] as number;
    expect(delayedUntilMs).toBeGreaterThanOrEqual(nowMs + 2_000);
    expect(delayedUntilMs).toBeLessThanOrEqual(nowMs + 3_000);
  });

  it('keeps the job on the failed path when its BullMQ lock token is unavailable', async () => {
    const error = new WebhookOrderedPredecessorPendingError('event-b', 'event-a');
    const job = {
      id: 'event-b',
      token: undefined,
      moveToDelayed: jest.fn(),
    };

    await expect(deferWebhookOrderedPredecessorJob(job as never, undefined, error)).rejects.toBe(
      error,
    );
    expect(job.moveToDelayed).not.toHaveBeenCalled();
  });

  it('keeps the job on the failed path when BullMQ cannot persist the delay', async () => {
    const error = new WebhookOrderedPredecessorPendingError('event-b', 'event-a');
    const job = {
      id: 'event-b',
      token: 'job-token',
      moveToDelayed: jest.fn().mockRejectedValue(new Error('Redis unavailable')),
    };

    await expect(deferWebhookOrderedPredecessorJob(job as never, undefined, error)).rejects.toBe(
      error,
    );
  });
});
