import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Queue } from 'bullmq';
import {
  buildPhotoDuplicateJobId,
  PHOTO_DUPLICATE_ALGORITHM_VERSION,
  PHOTO_DUPLICATE_JOB_ATTEMPTS,
  PHOTO_DUPLICATE_JOB_BACKOFF_MS,
  PHOTO_DUPLICATE_JOB_NAME,
  PHOTO_DUPLICATE_ORDERING_GRACE_MS,
  PHOTO_DUPLICATE_QUEUE,
  type PhotoDuplicateJob,
} from './photo-duplicate.queue';
import { resolvePhotoDuplicateRolloutMode } from './photo-duplicate.runtime';
import { PhotoDuplicateOrderingStore } from './photo-duplicate-ordering.store';

export type PhotoDuplicateEnqueueResult = 'queued' | 'skipped' | 'failed';

@Injectable()
export class PhotoDuplicateEnqueueService {
  private readonly logger = new Logger(PhotoDuplicateEnqueueService.name);

  constructor(
    @Optional()
    @InjectQueue(PHOTO_DUPLICATE_QUEUE)
    private readonly queue?: Queue<PhotoDuplicateJob>,
    @Optional() private readonly configService?: ConfigService,
    @Optional() private readonly orderingStore?: PhotoDuplicateOrderingStore,
  ) {}

  async enqueue(params: {
    webhookEventId: string;
    chatId: string;
    messageId: string;
    sourceCreatedAt: string;
  }): Promise<PhotoDuplicateEnqueueResult> {
    if (!this.queue || resolvePhotoDuplicateRolloutMode(this.configService) === 'off') {
      return 'skipped';
    }

    const jobId = buildPhotoDuplicateJobId(params);
    try {
      const ordering = await this.orderingStore?.announce({
        jobId,
        chatId: params.chatId,
        sourceCreatedAt: params.sourceCreatedAt,
      });
      if (ordering === 'completed') {
        return 'queued';
      }
      await this.queue.add(
        PHOTO_DUPLICATE_JOB_NAME,
        {
          ...params,
          algorithmVersion: PHOTO_DUPLICATE_ALGORITHM_VERSION,
          createdAt: new Date().toISOString(),
          idempotencyKey: jobId,
          retryPolicyName: 'photo-duplicate',
          sourceTag: 'photo-duplicate',
        },
        {
          jobId,
          delay: PHOTO_DUPLICATE_ORDERING_GRACE_MS,
          attempts: PHOTO_DUPLICATE_JOB_ATTEMPTS,
          backoff: {
            type: 'exponential',
            delay: PHOTO_DUPLICATE_JOB_BACKOFF_MS,
          },
          removeOnComplete: {
            age: 7 * 24 * 60 * 60,
            count: 250_000,
          },
          removeOnFail: {
            age: 7 * 24 * 60 * 60,
            count: 50_000,
          },
        },
      );
      return 'queued';
    } catch (error: unknown) {
      await this.orderingStore
        ?.abandon({
          jobId,
          chatId: params.chatId,
          sourceCreatedAt: params.sourceCreatedAt,
        })
        .catch(() => undefined);
      this.logger.warn(
        {
          jobId,
          error: error instanceof Error ? error.message : String(error),
        },
        'Failed to enqueue photo duplicate analysis; moderation continues fail-open',
      );
      return 'failed';
    }
  }
}
