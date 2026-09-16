import {
  PublisherVideoUploadQueueService,
  PUBLISHER_VIDEO_UPLOAD_TTL_MS,
} from './publisher-video-upload.queue';

const request = {
  requestId: 'upload_request_123456',
  fileName: 'clip.mp4',
  mimeType: 'video/mp4',
  sizeBytes: 36_000_000,
};

function fixture() {
  const jobs = new Map<string, any>();
  const redis = { defineCommand: jest.fn(), runCommand: jest.fn().mockResolvedValue(1) };
  const queue = {
    client: Promise.resolve(redis),
    toKey: (key: string) => `test:${key}`,
    getJobCounts: jest.fn().mockResolvedValue({ waiting: 0 }),
    getJob: jest.fn().mockImplementation(async (id: string) => jobs.get(id)),
    add: jest.fn().mockImplementation(async (_name, data, options) => {
      if (!jobs.has(options.jobId))
        jobs.set(options.jobId, { data, getState: jest.fn().mockResolvedValue('waiting') });
      return jobs.get(options.jobId);
    }),
  };
  const service = new PublisherVideoUploadQueueService(
    queue as never,
    { get: () => 'publisher-bot' } as never,
  );
  return { service, queue, redis, jobs };
}

describe('Publisher video upload admission and ownership', () => {
  it('queues only bounded metadata for 36 MB and never queues video bytes', async () => {
    const { service, queue } = fixture();
    expect(await service.create('actor', request)).toEqual({
      status: 'PENDING',
      uploadId: request.requestId,
    });
    const [, data, options] = queue.add.mock.calls[0];
    expect(JSON.stringify(data).length).toBeLessThan(512);
    expect(data.sizeBytes).toBe(36_000_000);
    expect(data.publisherBotId).toBe('publisher-bot');
    expect(options.removeOnComplete).toEqual({ age: 3600, count: 1000 });
  });

  it('rejects empty, oversized, and unsupported metadata before queue admission', async () => {
    const { service, queue } = fixture();
    for (const override of [
      { sizeBytes: 0 },
      { sizeBytes: 100_000_001 },
      { mimeType: 'text/html' },
    ]) {
      await expect(service.create('actor', { ...request, ...override })).rejects.toThrow(
        'Максимум 100 МБ',
      );
    }
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('bounds admission by backlog and atomic user/global rate limits', async () => {
    const { service, queue, redis } = fixture();
    queue.getJobCounts.mockResolvedValueOnce({ waiting: 100 });
    await expect(service.create('actor', request)).rejects.toThrow('временно занята');
    redis.runCommand.mockResolvedValueOnce(0);
    await expect(service.create('actor', request)).rejects.toThrow('Слишком много загрузок');
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('replays a request without allocating another session, but rejects changed metadata', async () => {
    const { service, queue } = fixture();
    await service.create('actor', request);
    await service.create('actor', request);
    expect(queue.add).toHaveBeenCalledTimes(1);
    await expect(service.create('actor', { ...request, sizeBytes: 10 })).rejects.toThrow(
      'изменились',
    );
  });

  it('never exposes media tokens and denies another actor or an expired session', async () => {
    const { service, jobs } = fixture();
    await service.create('actor', request);
    const job = jobs.get(service.jobId('actor', request.requestId));
    job.getState.mockResolvedValue('completed');
    job.returnvalue = {
      kind: 'session',
      url: 'https://test.okcdn.ru/upload',
      token: 'private-media-token',
    };
    const response = await service.status('actor', request.requestId);
    expect(response.status).toBe('UPLOADING');
    expect(JSON.stringify(response)).not.toContain('private-media-token');
    await expect(service.status('other', request.requestId)).rejects.toThrow('Срок загрузки');
    job.data.requestedAtMs = Date.now() - PUBLISHER_VIDEO_UPLOAD_TTL_MS - 1;
    await expect(service.complete('actor', request.requestId)).rejects.toThrow('Срок загрузки');
  });

  it('only completes an owned prepared session and returns its confirmed asset', async () => {
    const { service, jobs } = fixture();
    await service.create('actor', request);
    await expect(service.complete('actor', request.requestId)).rejects.toThrow('ещё не готова');
    const source = jobs.get(service.jobId('actor', request.requestId));
    source.getState.mockResolvedValue('completed');
    source.returnvalue = {
      kind: 'session',
      token: 'private-token',
      url: 'https://test.okcdn.ru/upload',
    };
    expect((await service.complete('actor', request.requestId)).status).toBe('PROCESSING');
    const completed = jobs.get(service.jobId('actor', request.requestId, 'complete'));
    completed.getState.mockResolvedValue('completed');
    completed.returnvalue = { kind: 'asset', asset: { id: 'asset', type: 'video' } };
    expect(await service.status('actor', request.requestId)).toEqual({
      status: 'READY',
      uploadId: request.requestId,
      asset: completed.returnvalue.asset,
    });
  });
});
