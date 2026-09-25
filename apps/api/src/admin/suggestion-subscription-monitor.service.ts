import {
  Injectable,
  Logger,
  Optional,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { MAX_API_SOURCE_TAGS } from '../max/max-client.service';
import { ModerationDeleteIntentService } from '../moderation/moderation-delete-intent.service';
import {
  type SuggestionSubscriptionPublication,
  type SuggestionSubscriptionWatch,
} from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { PublisherBackgroundWorkCoordinatorService } from '../publisher/publisher-background-work-coordinator.service';
import { PublisherDispatchHealthService } from '../publisher/publisher-dispatch-health.service';
import { PublisherIdentityAttestationService } from '../publisher/publisher-identity-attestation.service';
import { PublisherRuntimeBoundaryService } from '../publisher/publisher-runtime-boundary.service';
import { getAppRole, roleRunsAction, roleRunsPublisher } from '../runtime/app-role';
import { BackgroundRuntimeGovernorService } from '../system/background-runtime-governor.service';
import {
  SuggestionSubscriptionService,
  SUGGESTION_SUBSCRIPTION_CONFIRM_MS,
  SUGGESTION_SUBSCRIPTION_DELETE_RULE,
  SUGGESTION_SUBSCRIPTION_INTERVAL_MS,
} from '../suggestions/suggestion-subscription.service';

const POLL_MS = 30_000;
const LEASE_MS = 120_000;
const SWEEP_MS = 10_000;
const BATCH_SIZE = 25;
const POSTS_PER_AUTHOR = 10;

@Injectable()
export class SuggestionSubscriptionMonitorService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SuggestionSubscriptionMonitorService.name);
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<void> | null = null;
  private closing = false;
  private readonly profile = roleRunsPublisher(getAppRole()) ? 'publisher' : 'moderation';

  constructor(
    private readonly prisma: PrismaService,
    private readonly subscriptions: SuggestionSubscriptionService,
    private readonly deletes: ModerationDeleteIntentService,
    private readonly governor: BackgroundRuntimeGovernorService,
    private readonly background: PublisherBackgroundWorkCoordinatorService,
    @Optional() private readonly boundary?: PublisherRuntimeBoundaryService,
    @Optional() private readonly identity?: PublisherIdentityAttestationService,
    @Optional() private readonly health?: PublisherDispatchHealthService,
  ) {}

  onModuleInit(): void {
    if (!this.ownsRuntime() || (this.profile === 'publisher' && !this.boundary?.dispatchEnabled))
      return;
    this.timer = setInterval(() => {
      if (this.closing || this.inFlight) return;
      this.inFlight = this.processDue()
        .catch(() => {
          this.logger.warn('Suggestion subscription sweep deferred; durable work retained');
        })
        .finally(() => {
          this.inFlight = null;
        });
    }, POLL_MS);
    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    this.closing = true;
    if (this.timer) clearInterval(this.timer);
    await this.inFlight;
  }

  async processDue(): Promise<void> {
    if (this.closing || !this.ownsRuntime()) return;
    if (this.profile === 'publisher') {
      if (
        !this.boundary?.dispatchEnabled ||
        !this.identity ||
        !this.health ||
        (await this.health.isGloballyPaused())
      )
        return;
      await this.background.runExclusive('suggestion_subscriptions', async () => {
        await this.identity!.assertAttested();
        await this.sweep();
      });
    } else {
      await this.sweep();
    }
  }

  private ownsRuntime(): boolean {
    return this.profile === 'publisher'
      ? getAppRole() === 'publisher' && process.env.APP_SERVICE_NAME === 'api-publisher'
      : roleRunsAction(getAppRole()) &&
          (!process.env.APP_SERVICE_NAME || process.env.APP_SERVICE_NAME === 'api-action');
  }

  private async sweep(): Promise<void> {
    const decision = await this.governor.decide({
      component: 'suggestion-subscriptions',
      sourceTag: MAX_API_SOURCE_TAGS.SUGGESTION_DELIVERY,
      allowMaxApiCapacitySlowPath: true,
    });
    if (decision.action === 'pause') return;
    const started = Date.now();
    const rows = await this.prisma.suggestionSubscriptionWatch.findMany({
      where: { profile: this.profile, nextCheckAt: { lte: new Date() } },
      orderBy: [{ nextCheckAt: 'asc' }, { id: 'asc' }],
      take: decision.action === 'slow' ? 1 : BATCH_SIZE,
    });
    const groups = new Map<string, SuggestionSubscriptionWatch[]>();
    for (const row of rows) {
      if (this.closing || Date.now() - started >= SWEEP_MS) break;
      const token = randomUUID();
      const leaseUntil = new Date(Date.now() + LEASE_MS);
      const claimed = await this.prisma.suggestionSubscriptionWatch.updateMany({
        where: {
          id: row.id,
          revision: row.revision,
          nextCheckAt: row.nextCheckAt,
          OR: [{ leaseUntil: null }, { leaseUntil: { lte: new Date() } }],
        },
        data: { leaseToken: token, leaseUntil, nextCheckAt: leaseUntil },
      });
      if (!claimed.count) continue;
      row.leaseToken = token;
      row.leaseUntil = leaseUntil;
      const key = JSON.stringify([row.chatId, row.botId]);
      const group = groups.get(key) ?? [];
      group.push(row);
      groups.set(key, group);
    }
    for (const group of groups.values()) {
      if (this.closing || Date.now() - started >= SWEEP_MS) break;
      try {
        const policy = await this.subscriptions.policy(group[0]!.chatId, this.profile);
        const active: SuggestionSubscriptionWatch[] = [];
        for (const row of group) {
          const post =
            policy.deleteOnLeave &&
            (await this.prisma.suggestionSubscriptionPublication.findFirst({
              where: { watchId: row.id, deletedAt: null },
              select: { id: true },
            }));
          if (post) active.push(row);
          else await this.release(row, SUGGESTION_SUBSCRIPTION_INTERVAL_MS, true);
        }
        if (!active.length) continue;
        const probeStartedAt = new Date();
        const members = await this.subscriptions.probe(
          active[0]!.chatId,
          active.map((row) => row.authorUserId),
          active[0]!.botId,
          'background',
        );
        for (const row of active) {
          if (this.closing || Date.now() - started >= SWEEP_MS) break;
          const now = new Date();
          const member = members.has(row.authorUserId);
          const changed = await this.prisma.suggestionSubscriptionWatch.updateMany({
            where: { id: row.id, leaseToken: row.leaseToken, revision: row.revision },
            data: {
              checkedAt: probeStartedAt,
              missingSince: member ? null : (row.missingSince ?? now),
            },
          });
          if (!changed.count) continue;
          if (member) {
            await this.release(row, SUGGESTION_SUBSCRIPTION_INTERVAL_MS, true);
            continue;
          }
          if (
            row.missingSince &&
            now.getTime() - row.missingSince.getTime() >= SUGGESTION_SUBSCRIPTION_CONFIRM_MS
          ) {
            const posts = await this.prisma.suggestionSubscriptionPublication.findMany({
              where: {
                watchId: row.id,
                deletedAt: null,
                ...(row.publicationCursor ? { id: { gt: row.publicationCursor } } : {}),
              },
              orderBy: { id: 'asc' },
              take: POSTS_PER_AUTHOR,
            });
            let cursor = row.publicationCursor;
            for (const post of posts) {
              if (this.closing || Date.now() - started >= SWEEP_MS) break;
              try {
                await this.processPost(row, post);
              } catch {
                this.logger.warn('Suggestion subscription post deferred; source binding retained');
              }
              cursor = post.id;
            }
            await this.prisma.suggestionSubscriptionWatch.updateMany({
              where: { id: row.id, leaseToken: row.leaseToken, revision: row.revision },
              data: {
                publicationCursor:
                  posts.length === 0 ||
                  (posts.length < POSTS_PER_AUTHOR && cursor === posts.at(-1)?.id)
                    ? null
                    : cursor,
              },
            });
          }
          await this.release(row, SUGGESTION_SUBSCRIPTION_CONFIRM_MS);
        }
      } catch {
        for (const row of group) await this.release(row, 5 * 60_000, true);
      }
    }
  }

  private async release(
    row: SuggestionSubscriptionWatch,
    delay: number,
    reset = false,
  ): Promise<void> {
    const changed = await this.prisma.suggestionSubscriptionWatch.updateMany({
      where: { id: row.id, leaseToken: row.leaseToken, revision: row.revision },
      data: {
        leaseToken: null,
        leaseUntil: null,
        nextCheckAt: new Date(Date.now() + delay),
        ...(reset ? { missingSince: null, checkedAt: null } : {}),
      },
    });
    if (!changed.count)
      await this.prisma.suggestionSubscriptionWatch.updateMany({
        where: { id: row.id, leaseToken: row.leaseToken },
        data: { leaseToken: null, leaseUntil: null },
      });
  }

  private async processPost(
    watch: SuggestionSubscriptionWatch,
    post: SuggestionSubscriptionPublication,
  ): Promise<void> {
    if (this.profile === 'publisher') {
      await this.armPublisherPost(watch, post);
      return;
    }
    if (!post.messageId) return;
    if (post.deleteIntentId) {
      // FLAG: Rearm only our expired, non-dispatched intent after a new confirmed absence.
      await this.prisma.moderationDeleteIntent.updateMany({
        where: {
          id: post.deleteIntentId,
          suggestionSubscriptionId: post.id,
          status: 'EXPIRED',
          deleteDispatchStartedAt: null,
          remoteDeleteSucceededAt: null,
        },
        data: {
          status: 'PENDING',
          nextAttemptAt: new Date(),
          retryUntilAt: new Date(Date.now() + 86_400_000),
          completedAt: null,
        },
      });
    }
    const result = await this.deletes.ensureAndAttempt({
      chatId: watch.chatId,
      messageId: post.messageId,
      reasonKey: `${SUGGESTION_SUBSCRIPTION_DELETE_RULE}:${post.id}`,
      ruleCode: SUGGESTION_SUBSCRIPTION_DELETE_RULE,
      suggestionSubscriptionId: post.id,
      subjectUserId: watch.authorUserId,
      sourceMessageAt: post.publishedAt,
      entityType: 'CHANNEL',
      messageAuthorKind: 'bot',
      originBotId: watch.botId,
      routingPolicy: 'origin_only',
      retryUntilAt: new Date(Date.now() + 86_400_000),
    });
    await this.prisma.suggestionSubscriptionPublication.updateMany({
      where: { id: post.id, deletedAt: null },
      data: {
        deleteIntentId: result.intentId,
        ...(result.confirmed ? { deletedAt: new Date() } : {}),
      },
    });
  }

  private async armPublisherPost(
    watch: SuggestionSubscriptionWatch,
    post: SuggestionSubscriptionPublication,
  ): Promise<void> {
    if (!post.publicationId) return;
    const occurrence = await this.prisma.publicationOccurrence.findFirst({
      where: { publicationId: post.publicationId },
      orderBy: [{ scheduledAt: 'asc' }, { id: 'asc' }],
      select: { id: true },
    });
    if (!occurrence) return;
    const delivery = await this.prisma.managedBroadcastDelivery.findFirst({
      where: {
        publicationOccurrenceId: occurrence.id,
        targetChatId: watch.chatId,
        dispatchProfile: 'PUBLIK_V1',
        requiredBotId: watch.botId,
      },
      select: {
        id: true,
        botId: true,
        status: true,
        remoteMessageId: true,
        sentAt: true,
        deletedAt: true,
        deleteStatus: true,
      },
    });
    if (
      !delivery ||
      delivery.status !== 'SENT' ||
      delivery.botId !== watch.botId ||
      !delivery.remoteMessageId ||
      !delivery.sentAt
    )
      return;
    if (delivery.deletedAt || delivery.deleteStatus === 'DONE') {
      await this.prisma.suggestionSubscriptionPublication.update({
        where: { id: post.id },
        data: { deletedAt: delivery.deletedAt ?? new Date() },
      });
      return;
    }
    await this.prisma.suggestionSubscriptionPublication.update({
      where: { id: post.id },
      data: {
        messageId: delivery.remoteMessageId,
        deliveryId: delivery.id,
        publishedAt: delivery.sentAt,
      },
    });
    await this.subscriptions.prepareDeletion(post.id, watch.botId);
    await this.prisma.managedBroadcastDelivery.updateMany({
      where: {
        id: delivery.id,
        status: 'SENT',
        botId: watch.botId,
        remoteMessageId: delivery.remoteMessageId,
        deleteStatus: 'NONE',
        postActionsToken: null,
        deleteAt: null,
      },
      data: {
        subscriptionDeleteId: post.id,
        deleteStatus: 'PENDING',
        deleteAt: new Date(),
        postActionsNextAt: new Date(),
      },
    });
  }
}
