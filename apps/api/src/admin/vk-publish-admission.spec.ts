import { ServiceUnavailableException } from '@nestjs/common';
import { MediaByteAdmission } from '../common/media-byte-admission';
import { MAX_VIDEO_UPLOAD_MAX_BYTES } from '../max/max-video-upload.constants';
import { VkPublishService } from './vk-publish.service';

type Harness = {
  prepareBotReviewMedia: VkPublishService['prepareBotReviewMedia'];
  processPublishPostJobUnderSourceFence(params: Record<string, unknown>): Promise<unknown>;
  mapWithConcurrency<T>(
    items: T[],
    concurrency: number,
    worker: (item: T) => Promise<void>,
  ): Promise<void>;
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function fixture() {
  const admission = new MediaByteAdmission(768 * 1_024 * 1_024, 32);
  const scope = { ownerProfile: 'PUBLISHER', ownerBotId: 'publisher-bot' };
  const post = {
    id: 'post',
    chatId: 'chat',
    ...scope,
    requiredBotId: scope.ownerBotId,
    source: { ...scope, publishMode: 'IMMEDIATE' },
    status: 'NEW',
    dispatchProfile: 'PUBLIK_V1',
    photoUrls: [],
    videoUrls: ['https://vk.example/video.mp4'],
    publishAttemptCount: 0,
    publishIdempotencyKey: 'original-intent',
    publishReason: 'manual-retry',
    publishLockedAt: new Date(),
    lastError: null,
  };
  const updateMany = jest.fn().mockResolvedValue({ count: 1 });
  const publish = jest.fn().mockResolvedValue(undefined);
  const service = Object.assign(Object.create(VkPublishService.prototype), {
    mediaByteAdmission: admission,
    mediaConcurrency: 3,
    publishLeaseTtlMs: 120_000,
    ownership: { fromRow: () => scope },
    prisma: { vkParsingPost: { updateMany, findFirst: jest.fn().mockResolvedValue(post) } },
    getPublisherOwnerScope: () => scope,
    isExactOwnerScope: (row: typeof scope) =>
      row.ownerProfile === scope.ownerProfile && row.ownerBotId === scope.ownerBotId,
    isConfirmedPublishPersistencePending: () => false,
    assertPublisherRuntimeBeforeClaim: jest.fn(),
    assertPublisherHealthAllowed: jest.fn().mockResolvedValue(undefined),
    getSettingsForChat: jest.fn().mockResolvedValue({}),
    assertPublisherIntentReady: jest.fn().mockResolvedValue(undefined),
    publishQueuedPost: publish,
    isPublishFailurePersisted: () => false,
    markQueuedPostPublishFailed: jest.fn().mockResolvedValue(null),
    resolveVideoMediaIdentityMap: () => new Map(),
    resolvePhotoMediaIdentityMap: () => new Map(),
    downloadAndUploadVideo: jest.fn().mockResolvedValue({ token: 'uploaded-video' }),
  }) as Harness;
  const params = {
    postId: post.id,
    chatId: post.chatId,
    requiredBotId: scope.ownerBotId,
    dispatchProfile: 'PUBLIK_V1',
    reason: 'manual-retry',
    idempotencyKey: 'original-intent',
    attemptsMade: 4,
    maxAttempts: 5,
  };
  const review = {
    payload: { text: '', photoUrls: [], videoUrls: post.videoUrls, linkUrls: [] },
    maxMessage: { text: '' },
  } as unknown as Parameters<VkPublishService['prepareBotReviewMedia']>[1];
  return { admission, service, publish, post, params, updateMany, review };
}

describe('VK encoded media admission boundaries', () => {
  afterEach(() => jest.useRealTimers());

  it('registers only a fixed scalar process-local snapshot with existing runtime metrics', () => {
    const register = jest.fn();
    const service = new VkPublishService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { get: (_key: string, fallback?: unknown) => fallback } as never,
      {} as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { registerVkMediaAdmissionSnapshot: register } as never,
    );
    expect(register).toHaveBeenCalledTimes(1);
    expect(register.mock.calls[0]![0]()).toEqual({
      budgetBytes: 768 * 1_024 * 1_024,
      reservedBytes: 0,
      active: 0,
      waiting: 0,
      peakReservedBytes: 0,
      peakWaiting: 0,
      stopping: false,
    });
    service.onModuleDestroy();
    expect(register.mock.calls[0]![0]().stopping).toBe(true);
  });

  it('defers queued saturation before dispatch without consuming the final attempt or changing its intent', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-01T12:00:00Z'));
    const { service, admission, publish, params, updateMany, post } = fixture();
    const held = admission.tryAcquire(2 * MAX_VIDEO_UPLOAD_MAX_BYTES)!;
    await expect(service.processPublishPostJobUnderSourceFence(params)).resolves.toEqual({
      deferUntil: new Date('2026-10-01T12:00:02Z'),
    });
    expect(publish).not.toHaveBeenCalled();
    expect(updateMany).toHaveBeenLastCalledWith({
      where: {
        id: post.id,
        publishIdempotencyKey: 'original-intent',
        publishReason: 'manual-retry',
        publishLockedAt: post.publishLockedAt,
        publishAttemptCount: 0,
        lastError: null,
      },
      data: {
        publishScheduledAt: new Date('2026-10-01T12:00:02Z'),
        publishLockedAt: null,
        publishIdempotencyKey: 'original-intent',
        publishReason: 'manual-retry',
      },
    });
    expect(admission.getSnapshot()).toMatchObject({
      reservedBytes: 2 * MAX_VIDEO_UPLOAD_MAX_BYTES,
      active: 1,
    });
    held.release();
  });

  it.each(['success', 'failure'] as const)(
    'holds the queued reservation through %s and releases it once',
    async (outcome) => {
      const { service, admission, publish, params } = fixture();
      const work = deferred<void>();
      const started = deferred<void>();
      publish.mockImplementation(() => {
        expect(admission.getSnapshot()).toMatchObject({
          active: 1,
          reservedBytes: 2 * MAX_VIDEO_UPLOAD_MAX_BYTES,
        });
        started.resolve();
        return work.promise;
      });
      const execution = service.processPublishPostJobUnderSourceFence(params);
      const observed = execution.then(
        () => 'success',
        () => 'failure',
      );
      await started.promise;
      expect(publish).toHaveBeenCalledTimes(1);
      expect(admission.getSnapshot().active).toBe(1);
      if (outcome === 'success') work.resolve();
      else work.reject(new Error('upload failed before dispatch'));
      expect(await observed).toBe(outcome);
      expect(admission.getSnapshot()).toMatchObject({ active: 0, reservedBytes: 0 });
    },
  );

  it('waits with metadata only for bot review and releases on a preparation failure', async () => {
    const { service, admission, review } = fixture();
    const held = admission.tryAcquire(2 * MAX_VIDEO_UPLOAD_MAX_BYTES)!;
    const download = (service as unknown as { downloadAndUploadVideo: jest.Mock })
      .downloadAndUploadVideo;
    download.mockRejectedValue(new Error('download aborted'));
    const execution = service.prepareBotReviewMedia('post', review);
    const rejection = expect(execution).rejects.toThrow('download aborted');
    await Promise.resolve();
    expect(download).not.toHaveBeenCalled();
    expect(admission.getSnapshot().waiting).toBe(1);
    held.release();
    await rejection;
    expect(admission.getSnapshot()).toMatchObject({ active: 0, waiting: 0, reservedBytes: 0 });
  });

  it('returns a temporary busy result after the review deadline before any download', async () => {
    jest.useFakeTimers();
    const { service, admission, review } = fixture();
    const held = admission.tryAcquire(2 * MAX_VIDEO_UPLOAD_MAX_BYTES)!;
    const execution = service.prepareBotReviewMedia('post', review);
    const rejection = expect(execution).rejects.toBeInstanceOf(ServiceUnavailableException);
    await jest.advanceTimersByTimeAsync(15_000);
    await rejection;
    expect(
      (service as unknown as { downloadAndUploadVideo: jest.Mock }).downloadAndUploadVideo,
    ).not.toHaveBeenCalled();
    expect(admission.getSnapshot()).toMatchObject({ active: 1, waiting: 0 });
    held.release();
  });

  it('settles active image siblings and stops new required-photo work before releasing admission', async () => {
    const { service, admission } = fixture();
    const permit = admission.tryAcquire(100)!;
    const siblings = [deferred<void>(), deferred<void>()];
    const started: number[] = [];
    const worker = service
      .mapWithConcurrency([0, 1, 2, 3], 2, async (index) => {
        started.push(index);
        await siblings[index]!.promise;
      })
      .finally(() => permit.release());
    const rejection = expect(worker).rejects.toThrow('photo failed');
    siblings[0]!.reject(new Error('photo failed'));
    await Promise.resolve();
    await Promise.resolve();
    expect(started).toEqual([0, 1]);
    expect(admission.getSnapshot().active).toBe(1);
    siblings[1]!.resolve();
    await rejection;
    expect(started).toEqual([0, 1]);
    expect(admission.getSnapshot()).toMatchObject({ active: 0, reservedBytes: 0 });
  });

  it('keeps permitted partial failures inside their lanes and completes the remaining photos', async () => {
    const { service } = fixture();
    const processed: number[] = [];
    await service.mapWithConcurrency([0, 1, 2, 3], 2, async (index) => {
      try {
        if (index === 1) throw new Error('permitted expired photo');
        processed.push(index);
      } catch {
        // Same boundary as allowPartialFailures: a handled photo failure is not a lane failure.
      }
    });
    expect(processed.sort()).toEqual([0, 2, 3]);
  });
});
