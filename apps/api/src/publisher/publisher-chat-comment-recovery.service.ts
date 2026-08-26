import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { Job, Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { PublisherActionCredentialService } from './publisher-action-credential.service';
import { PublisherBackgroundWorkCoordinatorService } from './publisher-background-work-coordinator.service';
import {
  buildPublisherChatCommentAttachJobId,
  PUBLISHER_CHAT_COMMENT_QUEUE,
  type PublisherChatCommentAttachJob,
  type PublisherChatCommentJob,
} from './publisher-chat-comment.queue';
import { PublisherDispatchHealthService } from './publisher-dispatch-health.service';
import { PublisherReadinessService } from './publisher-readiness.service';
import { PublisherRuntimeBoundaryService } from './publisher-runtime-boundary.service';
import { PublisherIdentityAttestationService } from './publisher-identity-attestation.service';

export const PUBLISHER_CHAT_COMMENT_RECOVERY_BATCH_SIZE = 50;
export const PUBLISHER_CHAT_COMMENT_RECOVERY_MIN_AGE_MS = 60_000;
export const PUBLISHER_CHAT_COMMENT_RECOVERY_INTERVAL_MS = 60_000;
export const PUBLISHER_CHAT_COMMENT_RECOVERY_STARTUP_DELAY_MS = 15_000;

type RecoveryMarker = {
  id: string;
  chatId: string;
  messageId: string;
  lockToken: string | null;
  replacementMessageId: string | null;
  replyMessageId: string | null;
  replacementSendStartedAt: Date | null;
};

export type PublisherChatCommentRecoveryResult = {
  scanned: number;
  retried: number;
  deferred: number;
  missingJobs: number;
  skipped: number;
  races: number;
  errors: number;
  alreadyRunning: boolean;
};

@Injectable()
export class PublisherChatCommentRecoveryService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PublisherChatCommentRecoveryService.name);
  private readonly publisherBotId: string;
  private startupTimer: NodeJS.Timeout | null = null;
  private intervalTimer: NodeJS.Timeout | null = null;
  private scanCursorId: string | null = null;
  private inFlight: Promise<PublisherChatCommentRecoveryResult> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(PUBLISHER_CHAT_COMMENT_QUEUE)
    private readonly queue: Queue<PublisherChatCommentJob>,
    private readonly readiness: PublisherReadinessService,
    private readonly runtimeBoundary: PublisherRuntimeBoundaryService,
    private readonly dispatchHealth: PublisherDispatchHealthService,
    credentials: PublisherActionCredentialService,
    private readonly identityAttestation: PublisherIdentityAttestationService,
    private readonly backgroundWork: PublisherBackgroundWorkCoordinatorService,
  ) {
    this.publisherBotId = credentials.getBotId();
  }

  onModuleInit(): void {
    if (!this.runtimeBoundary.dispatchEnabled) {
      return;
    }
    this.startupTimer = setTimeout(() => {
      this.startupTimer = null;
      this.triggerScheduledRecovery();
    }, PUBLISHER_CHAT_COMMENT_RECOVERY_STARTUP_DELAY_MS);
    this.startupTimer.unref();
    this.intervalTimer = setInterval(() => {
      this.triggerScheduledRecovery();
    }, PUBLISHER_CHAT_COMMENT_RECOVERY_INTERVAL_MS);
    this.intervalTimer.unref();
  }

  onModuleDestroy(): void {
    if (this.startupTimer) {
      clearTimeout(this.startupTimer);
      this.startupTimer = null;
    }
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = null;
    }
  }

  async recoverOnce(now = new Date()): Promise<PublisherChatCommentRecoveryResult> {
    return this.recoverCoordinated(now, false);
  }

  private async recoverCoordinated(
    now: Date,
    respectGlobalPause: boolean,
  ): Promise<PublisherChatCommentRecoveryResult> {
    if (this.inFlight) {
      return {
        ...(await this.inFlight),
        alreadyRunning: true,
      };
    }

    const run = this.backgroundWork.runExclusive('chat_comment_recovery', async () => {
      if (respectGlobalPause && (await this.dispatchHealth.isGloballyPaused())) {
        return this.emptyResult();
      }
      return this.recoverBatch(now);
    });
    this.inFlight = run;
    try {
      return await run;
    } finally {
      if (this.inFlight === run) {
        this.inFlight = null;
      }
    }
  }

  private async recoverBatch(now: Date): Promise<PublisherChatCommentRecoveryResult> {
    await this.identityAttestation.assertAttested();
    const result = this.emptyResult();
    const markers = (await this.prisma.chatAutoCommentAttachMarker.findMany({
      where: {
        id: this.scanCursorId ? { gt: this.scanCursorId } : undefined,
        status: 'IN_PROGRESS',
        lockToken: { not: null },
        replacementMessageId: null,
        updatedAt: {
          lte: new Date(now.getTime() - PUBLISHER_CHAT_COMMENT_RECOVERY_MIN_AGE_MS),
        },
      },
      orderBy: { id: 'asc' },
      take: PUBLISHER_CHAT_COMMENT_RECOVERY_BATCH_SIZE,
      select: {
        id: true,
        chatId: true,
        messageId: true,
        lockToken: true,
        replacementMessageId: true,
        replyMessageId: true,
        replacementSendStartedAt: true,
      },
    })) as RecoveryMarker[];

    if (markers.length === 0) {
      this.scanCursorId = null;
      return result;
    }
    this.scanCursorId =
      markers.length === PUBLISHER_CHAT_COMMENT_RECOVERY_BATCH_SIZE
        ? (markers.at(-1)?.id ?? null)
        : null;

    for (const marker of markers) {
      result.scanned += 1;
      try {
        const outcome = await this.recoverMarker(marker);
        result[outcome] += 1;
      } catch (error: unknown) {
        result.errors += 1;
        this.logger.warn(
          {
            markerId: marker.id,
            chatId: marker.chatId,
            messageId: marker.messageId,
            err: error instanceof Error ? error.message : String(error),
          },
          'Failed to recover a publisher chat-comment job',
        );
      }
    }
    return result;
  }

  private emptyResult(): PublisherChatCommentRecoveryResult {
    return {
      scanned: 0,
      retried: 0,
      deferred: 0,
      missingJobs: 0,
      skipped: 0,
      races: 0,
      errors: 0,
      alreadyRunning: false,
    };
  }

  private async recoverMarker(
    marker: RecoveryMarker,
  ): Promise<'retried' | 'deferred' | 'missingJobs' | 'skipped' | 'races'> {
    const lockToken = marker.lockToken?.trim() ?? '';
    if (!lockToken) {
      return 'skipped';
    }
    const job = await this.queue.getJob(buildPublisherChatCommentAttachJobId(marker.id, lockToken));
    if (!job || !this.matchesMarker(job, marker, lockToken)) {
      return 'missingJobs';
    }
    if ((await job.getState()) !== 'failed') {
      return 'skipped';
    }

    const needsRemoteSend = !marker.replyMessageId && !marker.replacementSendStartedAt;
    if (needsRemoteSend && !(await this.isReadyForRemoteSend(marker.chatId, job.data))) {
      return 'deferred';
    }

    try {
      await job.retry('failed', {
        resetAttemptsMade: true,
        resetAttemptsStarted: true,
      });
      return 'retried';
    } catch (error: unknown) {
      if ((await job.getState().catch(() => 'unknown')) !== 'failed') {
        return 'races';
      }
      throw error;
    }
  }

  private matchesMarker(
    job: Job<PublisherChatCommentJob>,
    marker: RecoveryMarker,
    lockToken: string,
  ): job is Job<PublisherChatCommentAttachJob> {
    const data = job.data;
    return (
      data.version === 1 &&
      data.kind === 'attach_chat_reply' &&
      data.retryPolicyName === 'publisher-chat-comment' &&
      data.markerId === marker.id &&
      data.lockToken === lockToken &&
      data.chatId === marker.chatId &&
      data.messageId === marker.messageId &&
      data.requiredBotId === this.publisherBotId &&
      data.dialogBotId !== this.publisherBotId
    );
  }

  private async isReadyForRemoteSend(
    chatId: string,
    job: PublisherChatCommentAttachJob,
  ): Promise<boolean> {
    try {
      this.runtimeBoundary.assertDispatchEnabled();
      await this.dispatchHealth.assertDispatchAllowed();
      const route = await this.readiness.assertEntityReady(chatId, 'chat_comments');
      return (
        route.entityType === 'chat' &&
        route.requiredBotId === this.publisherBotId &&
        route.requiredBotId === job.requiredBotId
      );
    } catch {
      return false;
    }
  }

  private async runScheduledRecovery(): Promise<void> {
    if (await this.dispatchHealth.isGloballyPaused()) {
      return;
    }
    const result = await this.recoverCoordinated(new Date(), true);
    if (result.retried > 0 || result.missingJobs > 0 || result.errors > 0) {
      this.logger.log(
        {
          scanned: result.scanned,
          retried: result.retried,
          deferred: result.deferred,
          missingJobs: result.missingJobs,
          errors: result.errors,
        },
        'Publisher chat-comment recovery sweep completed',
      );
    }
  }

  private triggerScheduledRecovery(): void {
    if (this.inFlight) {
      return;
    }
    void this.runScheduledRecovery().catch((error: unknown) => {
      this.logger.warn(
        { err: error instanceof Error ? error.message : String(error) },
        'Publisher chat-comment recovery sweep failed',
      );
    });
  }
}
