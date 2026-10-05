import { ConfigService } from '@nestjs/config';
import { DelayedError, Queue, UnrecoverableError, Worker } from 'bullmq';
import { randomUUID } from 'node:crypto';
import {
  PUBLISHER_VIDEO_UPLOAD_QUEUE,
  PublisherVideoUploadQueueService,
  type PublisherVideoUploadJob,
  type PublisherVideoUploadResult,
} from './publisher-video-upload.queue';
import { PublisherVideoUploadProcessor } from './publisher-video-upload.processor';
import { PublisherIdentityAttestationError } from './publisher-identity-attestation.service';
import { PublisherDispatchDisabledError } from './publisher-runtime-boundary.service';
import { PublisherDispatchPausedError } from './publisher-dispatch-health.service';

const redisUrl = process.env.MAXIM_TEST_REDIS_URL?.trim() ?? '';
const integration = redisUrl ? describe : describe.skip;
jest.setTimeout(30_000);

integration('Publisher video upload recovery on real BullMQ', () => {
  let queue: Queue<PublisherVideoUploadJob, PublisherVideoUploadResult>;
  let worker: Worker<PublisherVideoUploadJob, PublisherVideoUploadResult>;
  let uploads: PublisherVideoUploadQueueService;
  let processor: PublisherVideoUploadProcessor;
  const oldRole = process.env.APP_ROLE;
  const oldService = process.env.APP_SERVICE_NAME;
  const max = {
    createVideoUploadSession: jest
      .fn()
      .mockResolvedValue({ url: 'https://synthetic.invalid/upload', token: 'synthetic-token' }),
    getVideoDownloadUrl: jest.fn().mockResolvedValue('https://synthetic.invalid/video'),
  };
  const boundary = { assertDispatchEnabled: jest.fn() };
  const health = { assertDispatchAllowed: jest.fn() };
  const identity = { assertAttested: jest.fn() };
  const asset = {
    id: 'synthetic-asset',
    mimeType: 'video/mp4',
    fileName: 'synthetic.mp4',
    sizeBytes: 36_000_000,
  };
  const prisma = { publicationAsset: { upsert: jest.fn().mockResolvedValue(asset) } };
  const input = () => ({
    requestId: `video_${randomUUID()}`,
    fileName: asset.fileName,
    mimeType: asset.mimeType,
    sizeBytes: asset.sizeBytes,
  });

  beforeEach(() => {
    const url = new URL(redisUrl);
    if (!['localhost', '127.0.0.1'].includes(url.hostname))
      throw new Error('Disposable local Redis required');
    process.env.APP_ROLE = 'publisher';
    process.env.APP_SERVICE_NAME = 'api-publisher';
    const options = {
      prefix: `video-upload-test-${randomUUID()}`,
      connection: { host: url.hostname, port: Number(url.port) },
    };
    queue = new Queue(PUBLISHER_VIDEO_UPLOAD_QUEUE, options);
    worker = new Worker<PublisherVideoUploadJob, PublisherVideoUploadResult>(
      PUBLISHER_VIDEO_UPLOAD_QUEUE,
      async () => {
        throw new Error('Use the explicit synthetic worker boundary');
      },
      { ...options, autorun: false },
    );
    uploads = new PublisherVideoUploadQueueService(
      queue,
      new ConfigService({ MAX_PUBLISHER_BOT_ID: 'publisher-test' }),
    );
    processor = new PublisherVideoUploadProcessor(
      uploads,
      max as never,
      prisma as never,
      boundary as never,
      health as never,
      identity as never,
    );
    jest.clearAllMocks();
    boundary.assertDispatchEnabled.mockReset();
    health.assertDispatchAllowed.mockReset();
    identity.assertAttested.mockReset();
  });

  afterEach(async () => {
    await worker.close();
    await queue.obliterate({ force: true });
    await queue.close();
    if (oldRole === undefined) delete process.env.APP_ROLE;
    else process.env.APP_ROLE = oldRole;
    if (oldService === undefined) delete process.env.APP_SERVICE_NAME;
    else process.env.APP_SERVICE_NAME = oldService;
  });

  async function createSession(request = input()) {
    await uploads.create('actor', request);
    const source = (await worker.getNextJob('session-worker'))!;
    const result = await processor.process(source, 'session-worker');
    await source.moveToCompleted(result, 'session-worker', false);
    return request;
  }

  it('rearms one retained failed completion under concurrent retries and reuses the same upload token', async () => {
    const request = await createSession();
    await uploads.complete('actor', request.requestId);
    const completion = (await worker.getNextJob('failed-worker'))!;
    await completion.moveToFailed(
      new UnrecoverableError('Synthetic MAX video is still processing'),
      'failed-worker',
      false,
    );
    expect(await completion.getState()).toBe('failed');
    expect((await queue.getJob(completion.id!))!.attemptsMade).toBe(1);
    const responses = await Promise.all([
      uploads.complete('actor', request.requestId),
      uploads.complete('actor', request.requestId),
    ]);
    expect(responses.map((response) => response.status)).toEqual(['PROCESSING', 'PROCESSING']);
    const resumed = (await worker.getNextJob('resumed-worker'))!;
    expect(resumed.id).toBe(completion.id);
    expect(resumed.attemptsMade).toBe(0);
    expect(resumed.data.requestedAtMs).toBe(completion.data.requestedAtMs);
    const result = await processor.process(resumed, 'resumed-worker');
    await resumed.moveToCompleted(result, 'resumed-worker', false);
    expect(await uploads.status('actor', request.requestId)).toEqual({
      status: 'READY',
      uploadId: request.requestId,
      asset: { ...asset, type: 'video' },
    });
    expect(max.createVideoUploadSession).toHaveBeenCalledTimes(1);
    expect(max.getVideoDownloadUrl).toHaveBeenCalledWith(
      'synthetic-token',
      expect.objectContaining({ botId: 'publisher-test' }),
    );
    expect(await queue.getJobCounts('waiting', 'active', 'failed', 'completed')).toMatchObject({
      waiting: 0,
      active: 0,
      failed: 0,
      completed: 2,
    });
  });

  it.each(['create', 'complete'] as const)(
    'keeps the %s job retry budget intact through runtime, identity and health pauses',
    async (phase) => {
      const request = phase === 'complete' ? await createSession() : input();
      if (phase === 'create') await uploads.create('actor', request);
      else await uploads.complete('actor', request.requestId);
      max.createVideoUploadSession.mockClear();
      max.getVideoDownloadUrl.mockClear();
      for (const blocker of ['runtime', 'identity', 'health'] as const) {
        const job = (await worker.getNextJob(`pause-${blocker}`))!;
        if (blocker === 'runtime')
          boundary.assertDispatchEnabled.mockImplementationOnce(() => {
            throw new PublisherDispatchDisabledError();
          });
        if (blocker === 'identity')
          identity.assertAttested.mockRejectedValueOnce(
            new PublisherIdentityAttestationError('transient_failure'),
          );
        if (blocker === 'health')
          health.assertDispatchAllowed.mockRejectedValueOnce(
            new PublisherDispatchPausedError(null),
          );
        await expect(processor.process(job, `pause-${blocker}`)).rejects.toBeInstanceOf(
          DelayedError,
        );
        expect(await job.getState()).toBe('delayed');
        expect((await queue.getJob(job.id!))!.attemptsMade).toBe(0);
        expect(max.createVideoUploadSession).not.toHaveBeenCalled();
        expect(max.getVideoDownloadUrl).not.toHaveBeenCalled();
        await job.promote();
      }
      const resumed = (await worker.getNextJob('healthy-worker'))!;
      await resumed.moveToCompleted(
        await processor.process(resumed, 'healthy-worker'),
        'healthy-worker',
        false,
      );
      expect(resumed.attemptsMade).toBe(1);
    },
  );
});
