import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import {
  ChatEntityType,
  PublicationDispatchProfile,
  PublicationLifecycle,
  PublicationOccurrenceStatus,
  PublicationScheduleStatus,
} from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { PublisherActionCredentialService } from './publisher-action-credential.service';
import { PublisherBackgroundWorkCoordinatorService } from './publisher-background-work-coordinator.service';
import { PublisherDispatchHealthService } from './publisher-dispatch-health.service';
import {
  PublisherReadinessService,
  PUBLISHER_PUBLICATION_AUTHORITY_MAX_AGE_MS,
} from './publisher-readiness.service';
import { PublisherRuntimeBoundaryService } from './publisher-runtime-boundary.service';

import { PublisherBindingRefreshQueueService } from './publisher-binding-refresh.queue';
import {
  PUBLISHER_PREFLIGHT_INTERVAL_MS,
  publicationUrgentAt,
} from './publisher-publication-access-admission';

const INTERVAL_MS = PUBLISHER_PREFLIGHT_INTERVAL_MS;
const LOOKAHEAD_MS = 5 * 60_000;
const PER_OCCURRENCE_TARGET_BUDGET = 2;
const OCCURRENCE_BUDGET = 4;

@Injectable()
export class PublisherPublicationAccessPreflightService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PublisherPublicationAccessPreflightService.name);
  private timer: NodeJS.Timeout | null = null;
  private inFlight = false;
  private cursor: { scheduledAt: Date; id: string } | null = null;
  private readonly botId: string;
  private metrics = {
    ticks: 0,
    visitedTargets: 0,
    completedCycles: 0,
    overdueTargets: 0,
    maxAdmissionDelayMs: 0,
    capacityDeferredTicks: 0,
  };
  private metricsStartedAt = Date.now();

  constructor(
    private readonly prisma: PrismaService,
    private readonly readiness: PublisherReadinessService,
    credentials: PublisherActionCredentialService,
    private readonly boundary: PublisherRuntimeBoundaryService,
    private readonly health: PublisherDispatchHealthService,
    private readonly backgroundWork: PublisherBackgroundWorkCoordinatorService,
    private readonly refreshQueue: PublisherBindingRefreshQueueService,
  ) {
    this.botId = credentials.getBotId();
  }

  async onModuleInit(): Promise<void> {
    if (!this.boundary.dispatchEnabled) return;
    this.timer = setInterval(() => {
      void this.runOnce();
    }, INTERVAL_MS);
    this.timer.unref();
    await this.runOnce();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.flushMetrics();
  }

  async runOnce(): Promise<void> {
    if (!this.boundary.dispatchEnabled || this.inFlight) return;
    this.inFlight = true;
    try {
      await this.backgroundWork.runExclusive('publication_access_preflight', async () => {
        if (await this.health.isGloballyPaused()) return;
        const now = new Date();
        let remaining = await this.refreshQueue.preparationTargetBudget();
        let visitedTargets = 0;
        let completedCycles = 0;
        let overdueTargets = 0;
        let maxAdmissionDelayMs = 0;
        const visitedOccurrences = new Set<string>();
        for (let visited = 0; visited < OCCURRENCE_BUDGET && remaining > 0; visited += 1) {
          // FLAG: Nomination uses the indexed imminent-occurrence window and bounded target pages.
          // It creates no delivery, changes no permissions and cannot authorize a MAX send.
          const occurrence = await this.prisma.publicationOccurrence.findFirst({
            where: {
              dispatchProfile: PublicationDispatchProfile.PUBLIK_V1,
              requiredBotId: this.botId,
              status: PublicationOccurrenceStatus.SCHEDULED,
              scheduledAt: {
                gte: new Date(now.getTime() - LOOKAHEAD_MS),
                lte: new Date(now.getTime() + LOOKAHEAD_MS),
              },
              publication: { lifecycle: PublicationLifecycle.ACTIVE },
              schedule: { status: PublicationScheduleStatus.ACTIVE },
              ...(this.cursor
                ? {
                    OR: [
                      { scheduledAt: { gt: this.cursor.scheduledAt } },
                      { scheduledAt: this.cursor.scheduledAt, id: { gt: this.cursor.id } },
                    ],
                  }
                : {}),
            },
            orderBy: [{ scheduledAt: 'asc' }, { id: 'asc' }],
            select: {
              id: true,
              publicationId: true,
              scheduledAt: true,
              scheduleRevision: true,
              accessPreflightPosition: true,
              accessPreflightCycleStartedAt: true,
              publication: { select: { actorUserId: true } },
            },
          });
          if (!occurrence) {
            this.cursor = null;
            continue;
          }
          this.cursor = { id: occurrence.id, scheduledAt: occurrence.scheduledAt };
          if (visitedOccurrences.has(occurrence.id)) break;
          visitedOccurrences.add(occurrence.id);
          const take = Math.min(remaining, PER_OCCURRENCE_TARGET_BUDGET);
          const targets = await this.prisma.publicationTarget.findMany({
            where: {
              publicationId: occurrence.publicationId,
              ...(occurrence.accessPreflightPosition != null
                ? { position: { gt: occurrence.accessPreflightPosition } }
                : {}),
            },
            orderBy: { position: 'asc' },
            take: take + 1,
            select: { targetChatId: true, entityType: true, position: true },
          });
          const page = targets.slice(0, take);
          const nominations = page.map((target) => ({
            chatId: target.targetChatId,
            entityType:
              target.entityType === ChatEntityType.CHANNEL
                ? ('channel' as const)
                : ('chat' as const),
          }));
          const horizonMs = Math.max(0, occurrence.scheduledAt.getTime() - now.getTime()) + 60_000;
          const urgentAt = publicationUrgentAt(occurrence.scheduledAt);
          const admissionDelayMs = Math.max(0, now.getTime() - urgentAt.getTime());
          maxAdmissionDelayMs = Math.max(maxAdmissionDelayMs, admissionDelayMs);
          overdueTargets += admissionDelayMs > 0 ? page.length : 0;
          await this.readiness.requestBotAccessRefresh(
            nominations,
            this.botId,
            new Date(now.getTime() + horizonMs),
            { publicationUrgentAt: urgentAt, strictEnqueue: true },
          );
          await this.readiness.requestActorAccessRefresh(
            nominations,
            occurrence.publication.actorUserId,
            this.botId,
            {
              maxAgeMs: PUBLISHER_PUBLICATION_AUTHORITY_MAX_AGE_MS - horizonMs,
              publicationUrgentAt: urgentAt,
              strictEnqueue: true,
            },
          );
          remaining -= page.length;
          visitedTargets += page.length;
          const complete = targets.length <= page.length;
          // FLAG: Progress follows both Redis acknowledgements. Crash/retry re-nominates
          // exact jobs; a completed cycle wraps to recover lost jobs and changed targets.
          await this.prisma.publicationOccurrence.updateMany({
            where: {
              id: occurrence.id,
              status: PublicationOccurrenceStatus.SCHEDULED,
              scheduleRevision: occurrence.scheduleRevision,
              accessPreflightPosition: occurrence.accessPreflightPosition,
            },
            data: {
              accessPreflightPosition: complete ? null : page.at(-1)!.position,
              accessPreflightCycleStartedAt: complete
                ? null
                : (occurrence.accessPreflightCycleStartedAt ?? now),
              ...(complete ? { accessPreflightLastCompletedAt: now } : {}),
            },
          });
          completedCycles += complete ? 1 : 0;
        }
        this.metrics.ticks += 1;
        this.metrics.visitedTargets += visitedTargets;
        this.metrics.completedCycles += completedCycles;
        this.metrics.overdueTargets += overdueTargets;
        this.metrics.maxAdmissionDelayMs = Math.max(
          this.metrics.maxAdmissionDelayMs,
          maxAdmissionDelayMs,
        );
        this.metrics.capacityDeferredTicks += remaining === 0 ? 1 : 0;
        if (Date.now() - this.metricsStartedAt >= 60_000) this.flushMetrics();
      });
    } catch (error: unknown) {
      this.logger.warn(
        { err: error instanceof Error ? error.message : String(error) },
        'Publisher publication access preflight deferred',
      );
    } finally {
      this.inFlight = false;
    }
  }
  private flushMetrics(): void {
    if (!this.metrics.ticks) return;
    try {
      this.logger.log(
        {
          metric: 'publisher_preflight_admission_v1',
          ...this.metrics,
          windowMs: Date.now() - this.metricsStartedAt,
          pendingInMemory: 0,
        },
        'Publisher bounded preparation',
      );
    } catch {
      /* Observability never changes admission or stored cursor. */
    }
    this.metrics = {
      ticks: 0,
      visitedTargets: 0,
      completedCycles: 0,
      overdueTargets: 0,
      maxAdmissionDelayMs: 0,
      capacityDeferredTicks: 0,
    };
    this.metricsStartedAt = Date.now();
  }
}
