import type { Job, Queue } from 'bullmq';
import {
  buildPublisherPublicationWakeupJobId,
  PUBLISHER_PUBLICATION_WAKEUP_JOB,
  PublisherPublicationWakeupQueueService,
  type PublisherPublicationWakeupJob,
} from './publisher-publication-wakeup.queue';

describe('PublisherPublicationWakeupQueueService', () => {
  const requestedAt = new Date('2026-09-04T10:15:30.000Z');

  function fixture(existing: Partial<Job<PublisherPublicationWakeupJob>> | null = null) {
    const queue = {
      getJob: jest.fn().mockResolvedValue(existing),
      add: jest.fn().mockResolvedValue(undefined),
    } as unknown as Queue<PublisherPublicationWakeupJob>;
    return {
      queue,
      service: new PublisherPublicationWakeupQueueService(queue),
    };
  }

  it('builds a deterministic BullMQ-safe id from trimmed mutation identity', () => {
    const expected =
      'publisher-publication-wakeup__6352d02777fbeaae92f06948e6ed28a7471f8984048283fed46397539524bbf4';

    expect(buildPublisherPublicationWakeupJobId('publication-1', 'mutation-1')).toBe(expected);
    expect(buildPublisherPublicationWakeupJobId(' publication-1 ', ' mutation-1 ')).toBe(expected);
    expect(buildPublisherPublicationWakeupJobId('publication-1', 'mutation-2')).not.toBe(expected);
    expect(expected).not.toContain(':');
  });

  it('enqueues the exact ordinary envelope and bounded retry options', async () => {
    const { queue, service } = fixture();
    const jobId = buildPublisherPublicationWakeupJobId('publication-1', 'mutation-1');

    await service.enqueue({
      publicationId: ' publication-1 ',
      mutationRequestId: ' mutation-1 ',
      reason: 'update',
      requestedAt,
    });

    expect(queue.getJob).toHaveBeenCalledWith(jobId);
    expect(queue.add).toHaveBeenCalledWith(
      PUBLISHER_PUBLICATION_WAKEUP_JOB,
      {
        version: 1,
        kind: 'materialize_publication',
        publicationId: 'publication-1',
        occurrenceId: null,
        reason: 'update',
        idempotencyKey: jobId,
        retryPolicyName: 'publisher-publication-wakeup',
        createdAt: '2026-09-04T10:15:30.000Z',
      },
      {
        jobId,
        priority: 1,
        attempts: 5,
        backoff: { type: 'exponential', delay: 1_000 },
        removeOnComplete: { age: 60 * 60, count: 10_000 },
        removeOnFail: { age: 7 * 24 * 60 * 60, count: 10_000 },
      },
    );
  });

  it('preserves the exact occurrence identity in a retry envelope', async () => {
    const { queue, service } = fixture();

    await service.enqueue({
      publicationId: 'publication-1',
      mutationRequestId: 'mutation-1',
      reason: 'retry',
      occurrenceId: ' occurrence-7 ',
      requestedAt,
    });

    expect(queue.add).toHaveBeenCalledWith(
      PUBLISHER_PUBLICATION_WAKEUP_JOB,
      expect.objectContaining({
        publicationId: 'publication-1',
        occurrenceId: 'occurrence-7',
        reason: 'retry',
      }),
      expect.any(Object),
    );
  });

  it('preserves the exact occurrence identity in a resolution envelope', async () => {
    const { queue, service } = fixture();

    await service.enqueue({
      publicationId: 'publication-1',
      mutationRequestId: 'mutation-1',
      reason: 'resolution',
      occurrenceId: ' occurrence-7 ',
      requestedAt,
    });

    expect(queue.add).toHaveBeenCalledWith(
      PUBLISHER_PUBLICATION_WAKEUP_JOB,
      expect.objectContaining({
        publicationId: 'publication-1',
        occurrenceId: 'occurrence-7',
        reason: 'resolution',
      }),
      expect.any(Object),
    );
  });

  it('maps the resolution convenience call to an occurrence-scoped durable signal', async () => {
    const { service } = fixture();
    const enqueue = jest
      .spyOn(service, 'enqueueAfterCommittedMutation')
      .mockResolvedValue(undefined);

    await service.enqueueResolution('publication-1', 'occurrence-7', 'mutation-1');

    expect(enqueue).toHaveBeenCalledWith({
      publicationId: 'publication-1',
      occurrenceId: 'occurrence-7',
      mutationRequestId: 'mutation-1',
      reason: 'resolution',
    });
  });

  it.each(['active', 'waiting', 'delayed', 'prioritized', 'completed'])(
    'keeps an existing %s job as an idempotent no-op',
    async (state) => {
      const existing = {
        getState: jest.fn().mockResolvedValue(state),
        remove: jest.fn(),
      };
      const { queue, service } = fixture(existing);

      await service.enqueue({
        publicationId: 'publication-1',
        mutationRequestId: 'mutation-1',
        reason: 'create',
        requestedAt,
      });

      expect(existing.remove).not.toHaveBeenCalled();
      expect(queue.add).not.toHaveBeenCalled();
    },
  );

  it('recycles a failed signal before enqueuing its replacement', async () => {
    const calls: string[] = [];
    const existing = {
      getState: jest.fn().mockResolvedValue('failed'),
      remove: jest.fn(async () => {
        calls.push('remove');
      }),
    };
    const { queue, service } = fixture(existing);
    (queue.add as jest.Mock).mockImplementation(async () => {
      calls.push('add');
    });

    await service.enqueue({
      publicationId: 'publication-1',
      mutationRequestId: 'mutation-1',
      reason: 'resume',
      requestedAt,
    });

    expect(calls).toEqual(['remove', 'add']);
  });

  it('keeps a committed mutation successful when Redis is unavailable', async () => {
    const failure = new Error('redis unavailable');
    const { queue, service } = fixture();
    (queue.getJob as jest.Mock).mockRejectedValue(failure);
    const warn = jest.spyOn((service as any).logger, 'warn').mockImplementation(() => undefined);

    await expect(
      service.enqueueAfterCommittedMutation({
        publicationId: 'publication-1',
        mutationRequestId: 'mutation-1',
        reason: 'create',
        requestedAt,
      }),
    ).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        publicationId: 'publication-1',
        mutationRequestId: 'mutation-1',
        reason: 'create',
        err: 'redis unavailable',
      }),
      'Failed to enqueue Publisher publication wakeup after committed mutation',
    );
  });

  it.each([
    {
      reason: 'retry' as const,
      occurrenceId: undefined,
    },
    {
      reason: 'resolution' as const,
      occurrenceId: undefined,
    },
    {
      reason: 'update' as const,
      occurrenceId: 'occurrence-1',
    },
  ])('rejects a mismatched occurrence scope', async ({ reason, occurrenceId }) => {
    const { queue, service } = fixture();

    await expect(
      service.enqueue({
        publicationId: 'publication-1',
        mutationRequestId: 'mutation-1',
        reason,
        occurrenceId,
        requestedAt,
      }),
    ).rejects.toThrow('exact occurrence id');

    expect(queue.getJob).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
  });
});
