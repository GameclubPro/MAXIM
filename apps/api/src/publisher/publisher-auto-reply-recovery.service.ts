import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import {
  PublisherAutoReplyAssetUploadStatus,
  PublisherAutoReplyDeliveryStatus,
} from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { PublisherBackgroundWorkCoordinatorService } from './publisher-background-work-coordinator.service';
import { PublisherDispatchHealthService } from './publisher-dispatch-health.service';
import { PublisherIdentityAttestationService } from './publisher-identity-attestation.service';
import { PublisherRuntimeBoundaryService } from './publisher-runtime-boundary.service';
import { PublisherAutoReplyQueueService } from './publisher-auto-reply.queue';

const RECOVERY_STARTUP_DELAY_MS = 8_000;
const RECOVERY_INTERVAL_MS = 30_000;
const STALE_LEASE_MS = 2 * 60_000;
const RECOVERY_BATCH_SIZE = 100;

export type PublisherAutoReplyRecoveryResult = {
  scanned: number;
  enqueued: number;
  reset: number;
  ambiguous: number;
  uploadsReset: number;
  errors: number;
  alreadyRunning: boolean;
};

@Injectable()
export class PublisherAutoReplyRecoveryService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PublisherAutoReplyRecoveryService.name);
  private startupTimer: NodeJS.Timeout | null = null;
  private intervalTimer: NodeJS.Timeout | null = null;
  private inFlight: Promise<PublisherAutoReplyRecoveryResult> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: PublisherAutoReplyQueueService,
    private readonly runtimeBoundary: PublisherRuntimeBoundaryService,
    private readonly dispatchHealth: PublisherDispatchHealthService,
    private readonly identityAttestation: PublisherIdentityAttestationService,
    private readonly backgroundWork: PublisherBackgroundWorkCoordinatorService,
  ) {}

  onModuleInit(): void {
    if (!this.runtimeBoundary.dispatchEnabled) return;
    this.startupTimer = setTimeout(() => {
      this.startupTimer = null;
      this.trigger();
    }, RECOVERY_STARTUP_DELAY_MS);
    this.startupTimer.unref();
    this.intervalTimer = setInterval(() => this.trigger(), RECOVERY_INTERVAL_MS);
    this.intervalTimer.unref();
  }

  onModuleDestroy(): void {
    if (this.startupTimer) clearTimeout(this.startupTimer);
    if (this.intervalTimer) clearInterval(this.intervalTimer);
    this.startupTimer = null;
    this.intervalTimer = null;
  }

  async recoverOnce(now = new Date()): Promise<PublisherAutoReplyRecoveryResult> {
    if (this.inFlight) {
      return { ...(await this.inFlight), alreadyRunning: true };
    }
    const run = this.backgroundWork.runExclusive('auto_reply_recovery', () =>
      this.recoverBatch(now),
    );
    this.inFlight = run;
    try {
      return await run;
    } finally {
      if (this.inFlight === run) this.inFlight = null;
    }
  }

  private async recoverBatch(now: Date): Promise<PublisherAutoReplyRecoveryResult> {
    const result: PublisherAutoReplyRecoveryResult = {
      scanned: 0,
      enqueued: 0,
      reset: 0,
      ambiguous: 0,
      uploadsReset: 0,
      errors: 0,
      alreadyRunning: false,
    };
    const staleBefore = new Date(now.getTime() - STALE_LEASE_MS);
    const deliveries = await this.prisma.publisherAutoReplyDelivery.findMany({
      where: {
        OR: [
          { status: PublisherAutoReplyDeliveryStatus.PENDING, dueAt: { lte: now } },
          {
            status: PublisherAutoReplyDeliveryStatus.SENDING,
            OR: [{ lockedAt: null }, { lockedAt: { lte: staleBefore } }],
          },
        ],
      },
      orderBy: [{ dueAt: 'asc' }, { id: 'asc' }],
      take: RECOVERY_BATCH_SIZE,
      select: {
        id: true,
        status: true,
        dueAt: true,
        lockToken: true,
        dispatchStartedAt: true,
      },
    });

    for (const delivery of deliveries) {
      result.scanned += 1;
      try {
        if (
          delivery.status === PublisherAutoReplyDeliveryStatus.SENDING &&
          delivery.dispatchStartedAt
        ) {
          const updated = await this.prisma.publisherAutoReplyDelivery.updateMany({
            where: {
              id: delivery.id,
              status: PublisherAutoReplyDeliveryStatus.SENDING,
              dispatchStartedAt: delivery.dispatchStartedAt,
            },
            data: {
              status: PublisherAutoReplyDeliveryStatus.AMBIGUOUS,
              lockedAt: null,
              lockToken: null,
              failureCode: 'STALE_SEND_FENCE',
              failureMessage: null,
            },
          });
          result.ambiguous += updated.count;
          continue;
        }
        if (delivery.status === PublisherAutoReplyDeliveryStatus.SENDING) {
          const reset = await this.prisma.publisherAutoReplyDelivery.updateMany({
            where: {
              id: delivery.id,
              status: PublisherAutoReplyDeliveryStatus.SENDING,
              dispatchStartedAt: null,
              lockToken: delivery.lockToken,
            },
            data: {
              status: PublisherAutoReplyDeliveryStatus.PENDING,
              lockedAt: null,
              lockToken: null,
              failureCode: 'STALE_PREPARATION_LEASE',
              failureMessage: null,
            },
          });
          if (reset.count !== 1) continue;
          result.reset += 1;
        }
        await this.queue.ensureDeliveryJob(delivery.id, delivery.dueAt);
        result.enqueued += 1;
      } catch (error: unknown) {
        result.errors += 1;
        this.logger.warn(
          { deliveryId: delivery.id, code: this.errorCode(error) },
          'Failed to recover Publisher auto-reply delivery',
        );
      }
    }

    const uploads = await this.prisma.publisherAutoReplyAssetUpload.updateMany({
      where: {
        status: PublisherAutoReplyAssetUploadStatus.UPLOADING,
        OR: [{ lockedAt: null }, { lockedAt: { lte: staleBefore } }],
      },
      data: {
        status: PublisherAutoReplyAssetUploadStatus.PENDING,
        lockedAt: null,
        lockToken: null,
        failureCode: 'STALE_UPLOAD_LEASE',
      },
    });
    result.uploadsReset = uploads.count;
    return result;
  }

  private async runScheduled(): Promise<void> {
    if (await this.dispatchHealth.isGloballyPaused()) return;
    await this.identityAttestation.assertAttested();
    const result = await this.recoverOnce();
    if (
      result.enqueued ||
      result.reset ||
      result.ambiguous ||
      result.uploadsReset ||
      result.errors
    ) {
      this.logger.log(
        {
          scanned: result.scanned,
          enqueued: result.enqueued,
          reset: result.reset,
          ambiguous: result.ambiguous,
          uploadsReset: result.uploadsReset,
          errors: result.errors,
        },
        'Publisher auto-reply recovery sweep completed',
      );
    }
  }

  private trigger(): void {
    if (this.inFlight) return;
    void this.runScheduled().catch((error: unknown) => {
      this.logger.warn(
        { code: this.errorCode(error) },
        'Publisher auto-reply recovery sweep failed',
      );
    });
  }

  private errorCode(error: unknown): string {
    const code = (error as { code?: unknown } | null)?.code;
    return typeof code === 'string' && code.trim() ? code.trim().slice(0, 80) : 'UNKNOWN';
  }
}
