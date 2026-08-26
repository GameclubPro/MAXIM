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

@Injectable()
export class PublisherSuggestionPublicationQueueService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PublisherSuggestionPublicationQueueService.name);
  private readonly recoveryEnabled = roleRunsPublisher(getAppRole());
  private recoveryTimer: NodeJS.Timeout | null = null;

  constructor(
    @InjectQueue(PUBLISHER_SUGGESTION_PUBLICATION_QUEUE)
    private readonly queue: Queue<PublisherSuggestionPublicationJob>,
    private readonly prisma: PrismaService,
    private readonly dispatchHealth: PublisherDispatchHealthService,
    @Optional() private readonly runtimeBoundary?: PublisherRuntimeBoundaryService,
  ) {}

  onModuleInit(): void {
    if (!this.recoveryEnabled || this.runtimeBoundary?.dispatchEnabled !== true) {
      return;
    }
    this.recoveryTimer = setInterval(() => void this.recover(), 60_000);
    this.recoveryTimer.unref();
    void this.recover();
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
    try {
      if (await this.dispatchHealth.isGloballyPaused()) {
        return;
      }
      const rows = await this.prisma.auditLog.findMany({
        where: {
          action: CHANNEL_DIALOG_ACTION_SUGGEST,
          AND: [
            { payload: { path: ['reviewStatus'], equals: 'publishing' } },
            { payload: { path: ['reviewDispatchProfile'], equals: 'PUBLIK_V1' } },
          ],
        },
        select: { id: true, payload: true },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: 100,
      });
      for (const row of rows) {
        const payload =
          row.payload && typeof row.payload === 'object' && !Array.isArray(row.payload)
            ? (row.payload as Record<string, unknown>)
            : {};
        const claim = readChannelSuggestionPublicationClaimV1(payload, row.id);
        if (claim) {
          await this.enqueue(row.id, claim.claimToken);
        }
      }
    } catch (error: unknown) {
      this.logger.warn(
        { err: error instanceof Error ? error.message : String(error) },
        'Failed to recover queued Publik suggestion publications',
      );
    }
  }
}
