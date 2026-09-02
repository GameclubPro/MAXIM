import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, Optional } from '@nestjs/common';
import { DelayedError, UnrecoverableError, type Job } from 'bullmq';
import {
  isMaxActionNoExecutableRouteError,
  isMaxActionRouteQuarantinedError,
} from '../max/max-action-dispatch-error';
import { MaxChatAdminRosterSyncService } from '../max/max-chat-admin-roster-sync.service';
import { getAppRole, roleRunsModeration } from '../runtime/app-role';
import { ModerationExecutionService } from './moderation-execution.service';
import {
  NIGHT_MODE_TRANSITION_POST_EXECUTION_CLEANUP_FAILURE_PREFIX,
  NIGHT_MODE_TRANSITION_QUEUE,
  type NightModeTransitionJob,
  type NightModeTransitionProcessResult,
} from './night-mode-transition.queue';
import { NightModeTransitionSchedulerService } from './night-mode-transition-scheduler.service';

const NIGHT_MODE_TRANSITION_NO_ROUTE_RETRY_DELAY_MS = 30_000;
const NIGHT_MODE_TRANSITION_MIN_RETRY_DELAY_MS = 15_000;
const NIGHT_MODE_TRANSITION_ACCESS_REFRESH_THROTTLE_MS = 5 * 60_000;
const NIGHT_MODE_TRANSITION_TERMINAL_FAILURE_REQUEST_ATTEMPTS = 3;

@Processor(NIGHT_MODE_TRANSITION_QUEUE, {
  concurrency: 2,
})
export class NightModeTransitionProcessor extends WorkerHost {
  private readonly logger = new Logger(NightModeTransitionProcessor.name);
  private readonly accessRefreshRequestedAtMs = new Map<string, number>();
  private accessRefreshSweepAtMs = 0;

  constructor(
    private readonly moderationExecutionService: ModerationExecutionService,
    private readonly scheduler: NightModeTransitionSchedulerService,
    @Optional() private readonly maxChatAdminRosterSyncService?: MaxChatAdminRosterSyncService,
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
      if (
        typeof this.scheduler.isTransitionManuallyFenced === 'function' &&
        (await this.scheduler.isTransitionManuallyFenced(job.data, job.id ?? null))
      ) {
        return;
      }
      const disposition = await this.scheduler.inspectTransitionExecution(job.data, job.id ?? null);
      if (disposition === 'unsafe') {
        throw new UnrecoverableError(
          `Night mode transition durable proof is invalid (${job.data.chatId})`,
        );
      }
      if (disposition === 'retire') {
        return;
      }
      if (disposition === 'defer') {
        await this.requestAccessRefresh(job);
        return this.deferTransition(
          job,
          token,
          Date.now() + NIGHT_MODE_TRANSITION_NO_ROUTE_RETRY_DELAY_MS,
          new Error(`Night mode transition route is temporarily unavailable (${job.data.chatId})`),
        );
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
      if (job.data.recoveryOnly) {
        const recoveryPreflight = await this.scheduler.inspectRecoveryOnlyTransition(job.data);
        if (recoveryPreflight === 'unsafe') {
          throw new UnrecoverableError(
            `Night mode recovery-only proof is no longer valid (${job.data.chatId})`,
          );
        }
        if (recoveryPreflight === 'already_complete') {
          return;
        }
      } else {
        const disposition = await this.scheduler.inspectTransitionExecution(
          job.data,
          job.id ?? null,
        );
        if (disposition === 'unsafe') {
          throw new UnrecoverableError(
            `Night mode transition durable proof is invalid (${job.data.chatId})`,
          );
        }
        if (disposition === 'retire') {
          return;
        }
      }
      const retryableError = isNoRoute ? new Error(error.message) : error;
      if (isNoRoute) {
        await this.requestAccessRefresh(job);
      }
      return this.deferTransition(
        job,
        token,
        isQuarantinedRoute
          ? Math.max(error.retryAt.getTime(), Date.now() + NIGHT_MODE_TRANSITION_MIN_RETRY_DELAY_MS)
          : Date.now() + NIGHT_MODE_TRANSITION_NO_ROUTE_RETRY_DELAY_MS,
        retryableError,
      );
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

  private async deferTransition(
    job: Job<NightModeTransitionJob>,
    token: string | undefined,
    retryAtMs: number,
    retryableError: Error,
  ): Promise<never> {
    if (!token) {
      throw retryableError;
    }
    try {
      await job.moveToDelayed(retryAtMs, token);
    } catch {
      throw retryableError;
    }
    throw new DelayedError();
  }

  private async requestAccessRefresh(job: Job<NightModeTransitionJob>): Promise<void> {
    if (!this.maxChatAdminRosterSyncService) {
      return;
    }
    const refreshKey =
      job.id?.trim() ||
      `${job.data.chatId}:${job.data.transition}:${job.data.scheduledFor}:${job.data.sessionKey}`;
    const nowMs = Date.now();
    if (nowMs >= this.accessRefreshSweepAtMs) {
      for (const [key, requestedAtMs] of this.accessRefreshRequestedAtMs) {
        if (nowMs - requestedAtMs >= NIGHT_MODE_TRANSITION_ACCESS_REFRESH_THROTTLE_MS) {
          this.accessRefreshRequestedAtMs.delete(key);
        }
      }
      this.accessRefreshSweepAtMs = nowMs + NIGHT_MODE_TRANSITION_ACCESS_REFRESH_THROTTLE_MS;
    }
    const previousRequestAtMs = this.accessRefreshRequestedAtMs.get(refreshKey) ?? 0;
    if (nowMs - previousRequestAtMs < NIGHT_MODE_TRANSITION_ACCESS_REFRESH_THROTTLE_MS) {
      return;
    }

    try {
      const scheduled = await this.maxChatAdminRosterSyncService.scheduleChatAdminRosterSync({
        chatId: job.data.chatId,
        entityType: 'chat',
        source: 'moderation_destructive_path',
      });
      if (scheduled) {
        this.accessRefreshRequestedAtMs.set(refreshKey, nowMs);
      }
    } catch (error: unknown) {
      this.logger.debug(
        {
          chatId: job.data.chatId,
          jobId: job.id,
          error: error instanceof Error ? error.message : String(error),
        },
        'Failed to schedule night mode transition access refresh',
      );
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
