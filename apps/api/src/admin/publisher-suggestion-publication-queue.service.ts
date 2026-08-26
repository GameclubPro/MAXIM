import { InjectQueue } from '@nestjs/bullmq';
import {
  Injectable,
  Logger,
  Optional,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import type { Queue } from 'bullmq';
import { createHash } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { getAppRole, roleRunsPublisher } from '../runtime/app-role';
import {
  PublisherBackgroundWorkCoordinatorClosedError,
  PublisherBackgroundWorkCoordinatorService,
} from '../publisher/publisher-background-work-coordinator.service';
import { PublisherDispatchHealthService } from '../publisher/publisher-dispatch-health.service';
import { PublisherRuntimeBoundaryService } from '../publisher/publisher-runtime-boundary.service';
import { readChannelSuggestionPublicationClaimV1 } from './admin-channel-suggestion-publication-protocol';
import { CHANNEL_DIALOG_ACTION_SUGGEST } from './admin.service.support';
import {
  PUBLISHER_SUGGESTION_PUBLICATION_JOB,
  PUBLISHER_SUGGESTION_PUBLICATION_QUEUE,
  PUBLISHER_SUGGESTION_PUBLICATION_RETRY_POLICY,
  type PublisherSuggestionPublicationJob,
} from './publisher-suggestion-publication.queue';

const PUBLISHER_SUGGESTION_RECOVERY_PAGE_SIZE = 100;
const PUBLISHER_SUGGESTION_RECOVERY_MAX_PAGES = 2;

type PublisherSuggestionRecoveryCursor = {
  createdAt: Date;
  id: string;
};

@Injectable()
export class PublisherSuggestionPublicationQueueService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PublisherSuggestionPublicationQueueService.name);
  private readonly recoveryEnabled = roleRunsPublisher(getAppRole());
  private recoveryTimer: NodeJS.Timeout | null = null;
  private recoveryInFlight: Promise<void> | null = null;
  private recoveryCursor: PublisherSuggestionRecoveryCursor | null = null;

  constructor(
    @InjectQueue(PUBLISHER_SUGGESTION_PUBLICATION_QUEUE)
    private readonly queue: Queue<PublisherSuggestionPublicationJob>,
    private readonly prisma: PrismaService,
    private readonly dispatchHealth: PublisherDispatchHealthService,
    private readonly backgroundWork: PublisherBackgroundWorkCoordinatorService,
    @Optional() private readonly runtimeBoundary?: PublisherRuntimeBoundaryService,
  ) {}

  onModuleInit(): void {
    if (!this.recoveryEnabled || this.runtimeBoundary?.dispatchEnabled !== true) {
      return;
    }
    this.recoveryTimer = setInterval(() => this.triggerRecovery(), 60_000);
    this.recoveryTimer.unref();
    this.triggerRecovery();
  }

  onModuleDestroy(): void {
    if (this.recoveryTimer) {
      clearInterval(this.recoveryTimer);
      this.recoveryTimer = null;
    }
  }

  async enqueue(suggestionId: string, claimToken: string): Promise<void> {
    const normalizedSuggestionId = suggestionId.trim();
    const normalizedClaimToken = claimToken.trim();
    if (!normalizedSuggestionId || !normalizedClaimToken) {
      throw new Error('Publisher suggestion queue requires a suggestion id and claim token');
    }
    const jobId = `publik-suggestion-${createHash('sha256')
      .update(`${normalizedSuggestionId}\0${normalizedClaimToken}`)
      .digest('hex')}`;
    const existing = await this.queue.getJob(jobId);
    if (existing) {
      if ((await existing.getState()) === 'failed') {
        await existing.retry();
      }
      return;
    }
    await this.queue.add(
      PUBLISHER_SUGGESTION_PUBLICATION_JOB,
      {
        suggestionId: normalizedSuggestionId,
        claimToken: normalizedClaimToken,
        createdAt: new Date().toISOString(),
      },
      {
        jobId,
        ...PUBLISHER_SUGGESTION_PUBLICATION_RETRY_POLICY,
      },
    );
  }

  private async recover(): Promise<void> {
    if (!this.recoveryEnabled || this.runtimeBoundary?.dispatchEnabled !== true) {
      return;
    }
    if (this.recoveryInFlight) {
      await this.recoveryInFlight;
      return;
    }
    const run = this.backgroundWork.runExclusive('suggestion_recovery', () =>
      this.recoverExclusive(),
    );
    this.recoveryInFlight = run;
    try {
      await run;
    } finally {
      if (this.recoveryInFlight === run) {
        this.recoveryInFlight = null;
      }
    }
  }

  private async recoverExclusive(): Promise<void> {
    try {
      if (await this.dispatchHealth.isGloballyPaused()) {
        return;
      }
      let cursor = this.recoveryCursor;
      let failedClaims = 0;
      let firstFailure: unknown = null;
      for (let page = 0; page < PUBLISHER_SUGGESTION_RECOVERY_MAX_PAGES; page += 1) {
        const rows = await this.prisma.auditLog.findMany({
          where: {
            action: CHANNEL_DIALOG_ACTION_SUGGEST,
            AND: [
              { payload: { path: ['reviewStatus'], equals: 'publishing' } },
              { payload: { path: ['reviewDispatchProfile'], equals: 'PUBLIK_V1' } },
              ...(cursor
                ? [
                    {
                      OR: [
                        { createdAt: { gt: cursor.createdAt } },
                        { createdAt: cursor.createdAt, id: { gt: cursor.id } },
                      ],
                    },
                  ]
                : []),
            ],
          },
          select: { id: true, payload: true, createdAt: true },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          take: PUBLISHER_SUGGESTION_RECOVERY_PAGE_SIZE,
        });
        if (rows.length === 0) {
          this.recoveryCursor = null;
          break;
        }
        for (const row of rows) {
          const payload =
            row.payload && typeof row.payload === 'object' && !Array.isArray(row.payload)
              ? (row.payload as Record<string, unknown>)
              : {};
          const claim = readChannelSuggestionPublicationClaimV1(payload, row.id);
          if (!claim) {
            continue;
          }
          try {
            await this.enqueue(row.id, claim.claimToken);
          } catch (error: unknown) {
            failedClaims += 1;
            firstFailure ??= error;
          }
        }

        const lastRow = rows.at(-1)!;
        cursor = { createdAt: lastRow.createdAt, id: lastRow.id };
        this.recoveryCursor =
          rows.length === PUBLISHER_SUGGESTION_RECOVERY_PAGE_SIZE ? cursor : null;
        if (!this.recoveryCursor) {
          break;
        }
      }
      if (failedClaims > 0) {
        this.logger.warn(
          {
            failedClaims,
            err: firstFailure instanceof Error ? firstFailure.message : String(firstFailure),
          },
          'Failed to recover some queued Publik suggestion publications',
        );
      }
    } catch (error: unknown) {
      this.logger.warn(
        { err: error instanceof Error ? error.message : String(error) },
        'Failed to recover queued Publik suggestion publications',
      );
    }
  }

  private triggerRecovery(): void {
    if (this.recoveryInFlight) {
      return;
    }
    void this.recover().catch((error: unknown) => {
      if (error instanceof PublisherBackgroundWorkCoordinatorClosedError) {
        return;
      }
      this.logger.warn(
        { err: error instanceof Error ? error.message : String(error) },
        'Failed to schedule Publik suggestion recovery',
      );
    });
  }
}
