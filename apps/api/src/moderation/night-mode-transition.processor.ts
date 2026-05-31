import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { getAppRole, roleRunsModeration } from '../runtime/app-role';
import { ModerationExecutionService } from './moderation-execution.service';
import {
  NIGHT_MODE_TRANSITION_QUEUE,
  type NightModeTransitionJob,
} from './night-mode-transition.queue';
import { NightModeTransitionSchedulerService } from './night-mode-transition-scheduler.service';

@Processor(NIGHT_MODE_TRANSITION_QUEUE, {
  concurrency: 2,
})
export class NightModeTransitionProcessor extends WorkerHost {
  constructor(
    private readonly moderationExecutionService: ModerationExecutionService,
    private readonly scheduler: NightModeTransitionSchedulerService,
  ) {
    super();
  }

  async process(job: Job<NightModeTransitionJob>): Promise<void> {
    if (!roleRunsModeration(getAppRole())) {
      return;
    }

    const result = await this.moderationExecutionService.processNightModeTransitionJob(job.data);
    if (result.shouldEnqueueNext) {
      await this.scheduler.enqueueNextTransitionsForChat(job.data.chatId);
    }
  }
}
