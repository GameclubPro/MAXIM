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

const INTERVAL_MS = 15_000;
const LOOKAHEAD_MS = 5 * 60_000;
const TARGET_BUDGET = 100;
const OCCURRENCE_BUDGET = 4;

@Injectable()
export class PublisherPublicationAccessPreflightService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PublisherPublicationAccessPreflightService.name);
  private timer: NodeJS.Timeout | null = null;
  private inFlight = false;
  private cursor: { scheduledAt: Date; id: string } | null = null;
  private pending: { id: string; position: number } | null = null;
  private readonly botId: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly readiness: PublisherReadinessService,
    credentials: PublisherActionCredentialService,
    private readonly boundary: PublisherRuntimeBoundaryService,
    private readonly health: PublisherDispatchHealthService,
    private readonly backgroundWork: PublisherBackgroundWorkCoordinatorService,
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
  }

  async runOnce(): Promise<void> {
    if (!this.boundary.dispatchEnabled || this.inFlight) return;
    this.inFlight = true;
    try {
      await this.backgroundWork.runExclusive('publication_access_preflight', async () => {
        if (await this.health.isGloballyPaused()) return;
        const now = new Date();
        let remaining = TARGET_BUDGET;
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
              ...(this.pending
                ? { id: this.pending.id }
                : this.cursor
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
              publication: { select: { actorUserId: true } },
            },
          });
          if (!occurrence) {
            this.pending = null;
            this.cursor = null;
            break;
          }
          const targets = await this.prisma.publicationTarget.findMany({
            where: {
              publicationId: occurrence.publicationId,
              ...(this.pending ? { position: { gt: this.pending.position } } : {}),
            },
            orderBy: { position: 'asc' },
            take: remaining + 1,
            select: { targetChatId: true, entityType: true, position: true },
          });
          const page = targets.slice(0, remaining);
          const nominations = page.map((target) => ({
            chatId: target.targetChatId,
            entityType:
              target.entityType === ChatEntityType.CHANNEL
                ? ('channel' as const)
                : ('chat' as const),
          }));
          const horizonMs = Math.max(0, occurrence.scheduledAt.getTime() - now.getTime()) + 60_000;
          await this.readiness.requestBotAccessRefresh(
            nominations,
            this.botId,
            new Date(now.getTime() + horizonMs),
          );
          await this.readiness.requestActorAccessRefresh(
            nominations,
            occurrence.publication.actorUserId,
            this.botId,
            { maxAgeMs: PUBLISHER_PUBLICATION_AUTHORITY_MAX_AGE_MS - horizonMs },
          );
          remaining -= page.length;
          if (targets.length > page.length) {
            this.pending = { id: occurrence.id, position: page.at(-1)!.position };
            break;
          }
          this.pending = null;
          this.cursor = { id: occurrence.id, scheduledAt: occurrence.scheduledAt };
        }
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
}
