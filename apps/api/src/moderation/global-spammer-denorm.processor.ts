import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { ConfigService } from '@nestjs/config';
import { Optional } from '@nestjs/common';
import { spammerDenormProcessorEnabled } from '../runtime/moderation-runtime';
import { GlobalSpammerIntelligenceService } from './global-spammer-intelligence.service';
import {
  GLOBAL_SPAMMER_DENORM_QUEUE,
  type GlobalSpammerDenormJob,
} from './global-spammer-denorm.queue';

@Processor(GLOBAL_SPAMMER_DENORM_QUEUE, {
  concurrency: 1,
})
export class GlobalSpammerDenormProcessor extends WorkerHost {
  constructor(
    private readonly globalSpammerIntelligence: GlobalSpammerIntelligenceService,
    @Optional() private readonly configService?: ConfigService,
  ) {
    super();
  }

  async process(job: Job<GlobalSpammerDenormJob>): Promise<void> {
    if (!spammerDenormProcessorEnabled(this.configService)) {
      return;
    }

    await this.globalSpammerIntelligence.processObservationDenormJob(job.data);
  }
}
