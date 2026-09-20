import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { PHOTO_DUPLICATE_QUEUE, type PhotoDuplicateJob } from './photo-duplicate.queue';
import { PhotoDuplicateOrderingStore } from './photo-duplicate-ordering.store';

@Processor(PHOTO_DUPLICATE_QUEUE, { concurrency: 2 })
export class PhotoDuplicateProcessor extends WorkerHost {
  constructor(private readonly orderingStore: PhotoDuplicateOrderingStore) {
    super();
  }

  async process(job: Job<PhotoDuplicateJob>): Promise<void> {
    // FLAG: Drain only the retired queue's ordering record. Never reinterpret an old photo
    // job as an exact-image job, download its media or execute its previous action binding.
    const jobId = job.data.idempotencyKey ?? job.id;
    if (!jobId) return;
    await this.orderingStore.abandon({
      jobId,
      chatId: job.data.chatId,
      sourceCreatedAt: job.data.sourceCreatedAt,
    });
  }
}
