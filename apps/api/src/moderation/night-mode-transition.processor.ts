import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { DelayedError, UnrecoverableError, type Job } from 'bullmq';
import {
  isMaxActionNoExecutableRouteError,
  isMaxActionRouteQuarantinedError,
} from '../max/max-action-dispatch-error';
import { getAppRole, roleRunsModeration } from '../runtime/app-role';
import { ModerationExecutionService } from './moderation-execution.service';
import {
  NIGHT_MODE_TRANSITION_POST_EXECUTION_CLEANUP_FAILURE_PREFIX,
  NIGHT_MODE_TRANSITION_QUEUE,
  type NightModeTransitionJob,
  type NightModeTransitionProcessResult,
} from './night-mode-transition.queue';
import { NightModeTransitionSchedulerService } from './night-mode-transition-scheduler.service';

const NIGHT_MODE_TRANSITION_NO_ROUTE_RETRY_DELAY_MS = 5 * 60_000;
const NIGHT_MODE_TRANSITION_MIN_RETRY_DELAY_MS = 15_000;
const NIGHT_MODE_TRANSITION_TERMINAL_FAILURE_REQUEST_ATTEMPTS = 3;

@Processor(NIGHT_MODE_TRANSITION_QUEUE, {
  concurrency: 2,
})
export class NightModeTransitionProcessor extends WorkerHost {
  private readonly logger = new Logger(NightModeTransitionProcessor.name);

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
    if (job.data.recoveryOnly) {
      const recoveryPreflight = await this.scheduler.inspectRecoveryOnlyTransition(job.data);
      if (recoveryPreflight === 'unsafe') {
        throw new UnrecoverableError(
          `Night mode recovery-only proof is no longer valid (${job.data.chatId})`,
        );
      }
    } else {
      if (!(await this.scheduler.shouldProcessChatTransitions(job.data.chatId))) {
        return;
      }
      if (
        typeof this.scheduler.isTransitionManuallyFenced === 'function' &&
        (await this.scheduler.isTransitionManuallyFenced(job.data, job.id ?? null))
      ) {
        return;
      }
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
    if (job.data.recoveryOnly) {
      return;
    }
    if (result.shouldEnqueueNext) {
      try {
        await this.scheduler.enqueueNextTransitionsForChat(job.data.chatId);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
          `${NIGHT_MODE_TRANSITION_POST_EXECUTION_CLEANUP_FAILURE_PREFIX}: ${message}`,
          { cause: error },
        );
      }
    }
  }

  @OnWorkerEvent('completed')
  async onCompleted(job: Job<NightModeTransitionJob>): Promise<void> {
    if (job.data.recoveryOnly) {
      try {
        await this.scheduler.requestJobReconcile(job.data);
      } catch (error: unknown) {
        this.logger.warn(
          {
            chatId: job.data.chatId,
            jobId: job.id,
            error: error instanceof Error ? error.message : String(error),
          },
          'Failed to request post-recovery reconciliation; registry row remains durable',
        );
        return;
      }
    }
    try {
      await this.scheduler.completeScheduledJob(job.data, job.id ?? null);
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId: job.data.chatId,
          jobId: job.id,
          error: error instanceof Error ? error.message : String(error),
        },
        'Failed to clear completed night mode registry row; SQL overdue recovery remains active',
      );
    }
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job<NightModeTransitionJob> | undefined, error: Error): Promise<void> {
    if (!job || error instanceof DelayedError) {
      return;
    }

    for (
      let attempt = 1;
      attempt <= NIGHT_MODE_TRANSITION_TERMINAL_FAILURE_REQUEST_ATTEMPTS;
      attempt += 1
    ) {
      try {
        await this.scheduler.requestJobReconcile(job.data);
        return;
      } catch (requestError: unknown) {
        if (attempt === NIGHT_MODE_TRANSITION_TERMINAL_FAILURE_REQUEST_ATTEMPTS) {
          this.logger.error(
            {
              chatId: job.data.chatId,
              jobId: job.id,
              error: requestError instanceof Error ? requestError.message : String(requestError),
            },
            'Failed to persist terminal night mode transition reconciliation request',
          );
        }
      }
    }
  }
}
