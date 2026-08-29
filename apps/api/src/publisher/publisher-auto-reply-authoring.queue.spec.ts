import {
  PUBLISHER_AUTO_REPLY_AUTHORING_JOB_BUCKET_MS,
  PublisherAutoReplyAuthoringQueueService,
} from './publisher-auto-reply-authoring.queue';

describe('PublisherAutoReplyAuthoringQueueService', () => {
  it('deduplicates one recovery bucket but permits a later process replacement', async () => {
    const add = jest.fn().mockResolvedValue(undefined);
    const service = new PublisherAutoReplyAuthoringQueueService({ add } as never);
    const first = new Date('2026-08-29T12:00:01.000Z');
    const sameBucket = new Date(
      first.getTime() + PUBLISHER_AUTO_REPLY_AUTHORING_JOB_BUCKET_MS - 2_000,
    );
    const nextBucket = new Date(first.getTime() + PUBLISHER_AUTO_REPLY_AUTHORING_JOB_BUCKET_MS);

    await service.enqueueProcessContent('session-1', first);
    await service.enqueueProcessContent('session-1', sameBucket);
    await service.enqueueProcessContent('session-1', nextBucket);

    const firstId = add.mock.calls[0]?.[2]?.jobId;
    expect(add.mock.calls[1]?.[2]?.jobId).toBe(firstId);
    expect(add.mock.calls[2]?.[2]?.jobId).not.toBe(firstId);
  });

  it('permits a later activation replacement after a retained failed job', async () => {
    const add = jest.fn().mockResolvedValue(undefined);
    const service = new PublisherAutoReplyAuthoringQueueService({ add } as never);
    const first = new Date('2026-08-29T12:00:01.000Z');
    const nextBucket = new Date(first.getTime() + PUBLISHER_AUTO_REPLY_AUTHORING_JOB_BUCKET_MS);

    await service.enqueueActivation({ sessionId: 'session-1', requestedAt: first });
    await service.enqueueActivation({ sessionId: 'session-1', requestedAt: nextBucket });

    expect(add.mock.calls[1]?.[2]?.jobId).not.toBe(add.mock.calls[0]?.[2]?.jobId);
  });
});
