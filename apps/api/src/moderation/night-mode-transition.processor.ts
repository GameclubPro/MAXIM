import { Processor, WorkerHost } from '@nestjs/bullmq';
import { DelayedError, type Job } from 'bullmq';
import {
  isMaxActionNoExecutableRouteError,
  isMaxActionRouteQuarantinedError,
} from '../max/max-action-dispatch-error';
import { getAppRole, roleRunsModeration } from '../runtime/app-role';
import { ModerationExecutionService } from './moderation-execution.service';
import {
  NIGHT_MODE_TRANSITION_QUEUE,
  type NightModeTransitionJob,
  type NightModeTransitionProcessResult,
} from './night-mode-transition.queue';
import { NightModeTransitionSchedulerService } from './night-mode-transition-scheduler.service';

const NIGHT_MODE_TRANSITION_NO_ROUTE_RETRY_DELAY_MS = 5 * 60_000;
const NIGHT_MODE_TRANSITION_MIN_RETRY_DELAY_MS = 15_000;

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

  async process(job: Job<NightModeTransitionJob>, token?: string): Promise<void> {
    if (!roleRunsModeration(getAppRole())) {
      return;
    }
    if (!(await this.scheduler.shouldProcessChatTransitions(job.data.chatId))) {
      return;
    }

    let result: NightModeTransitionProcessResult;
    try {
      result = await this.moderationExecutionService.processNightModeTransitionJob(job.data);
    } catch (error: unknown) {
      const isNoRoute = isMaxActionNoExecutableRouteError(error);
      const isQuarantinedRoute = isMaxActionRouteQuarantinedError(error);
      if (!isNoRoute && !isQuarantinedRoute) {
        throw error;
      }
      if (!(await this.scheduler.shouldProcessChatTransitions(job.data.chatId))) {
        return;
      }
      const retryableError = isNoRoute ? new Error(error.message) : error;
      if (!token) {
        throw retryableError;
      }
      try {
        await job.moveToDelayed(
          isQuarantinedRoute
            ? Math.max(
                error.retryAt.getTime(),
                Date.now() + NIGHT_MODE_TRANSITION_MIN_RETRY_DELAY_MS,
              )
            : Date.now() + NIGHT_MODE_TRANSITION_NO_ROUTE_RETRY_DELAY_MS,
          token,
        );
      } catch {
        throw retryableError;
      }
      throw new DelayedError();
    }
    if (result.shouldEnqueueNext) {
      await this.scheduler.enqueueNextTransitionsForChat(job.data.chatId);
    }
  }
}
