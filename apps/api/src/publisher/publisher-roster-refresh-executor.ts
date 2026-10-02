import { ChatBotAccessState, ChatBotMembershipStatus } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import type { MaxClientService } from '../max/max-client.service';
import { probePublisherAdminRoster, syncPublisherAdminRoster } from './publisher-admin-roster';
import type {
  PublisherBindingRefreshJob,
  PublisherBindingRefreshQueueService,
} from './publisher-binding-refresh.queue';
import { PublisherCatalogRefreshExecutor } from './publisher-catalog-refresh-executor';
import {
  PublisherAccessRefreshPolicy,
  publisherRosterRetryAt,
  type PublisherAccessProbeOutcome,
} from './publisher-access-refresh-policy';
const PUBLISHER_CATALOG_METADATA_MAX_AGE_MS = 30 * 60_000;
export class PublisherBindingMaintenanceSupersededError extends Error {
  constructor() {
    super('Publisher roster maintenance must retry with a newer bot proof');
    this.name = 'PublisherBindingMaintenanceSupersededError';
  }
}

export class PublisherRosterRefreshExecutor {
  constructor(
    private readonly prisma: PrismaService,
    private readonly maxClient: MaxClientService,
    private readonly publisherBotId: string,
    private readonly catalogRefresh: PublisherCatalogRefreshExecutor,
    private readonly policy: PublisherAccessRefreshPolicy,
    private readonly refreshQueue?: PublisherBindingRefreshQueueService,
  ) {}
  async execute(
    job: PublisherBindingRefreshJob,
    measureStage: <T>(stage: 'catalogMs' | 'rosterMs', operation: () => Promise<T>) => Promise<T>,
  ): Promise<PublisherAccessProbeOutcome> {
    const startedAt = new Date();
    try {
      return await this.refresh(job, measureStage);
    } catch (error: unknown) {
      if (this.policy.separatesMaintenance(this.publisherBotId, job.chatId)) {
        // FLAG: Backoff changes scheduling only. Never overwrite a successful newer roster
        // or access evidence; SQL remains the recovery source when a Redis job is lost.
        await this.prisma.publisherEntityBinding.updateMany({
          where: {
            chatId: job.chatId,
            publisherBotId: this.publisherBotId,
            AND: [
              { OR: [{ rosterCheckedAt: null }, { rosterCheckedAt: { lt: startedAt } }] },
              { OR: [{ rosterRefreshAfter: null }, { rosterRefreshAfter: { lte: startedAt } }] },
            ],
          },
          data: { rosterRefreshAfter: publisherRosterRetryAt(error) },
        });
      }
      throw error;
    }
  }

  private async refresh(
    job: PublisherBindingRefreshJob,
    measureStage: <T>(stage: 'catalogMs' | 'rosterMs', operation: () => Promise<T>) => Promise<T>,
  ): Promise<PublisherAccessProbeOutcome> {
    const chatId = job.chatId.trim();
    const [source, catalog] = await Promise.all([
      this.prisma.chat.findUnique({
        where: { id: chatId },
        select: { id: true, entityType: true, publisherBinding: true },
      }),
      this.prisma.managedBotChatCatalog.findUnique({
        where: { botId_chatId: { botId: this.publisherBotId, chatId } },
        select: { entityType: true, title: true, status: true, source: true, lastSeenAt: true },
      }),
    ]);
    const binding = source?.publisherBinding;
    const probeStartedAt = new Date();
    // FLAG: The lower-priority roster lane reuses only a fresh exact-bot proof from SQL.
    // Catalog/roster commits still fence lifecycle and that proof's checkedAt independently.
    if (
      !source ||
      !binding ||
      binding.publisherBotId !== this.publisherBotId ||
      binding.status !== ChatBotMembershipStatus.ACTIVE
    )
      return 'superseded';
    if (
      binding.botAccessState !== ChatBotAccessState.CONFIRMED_ADMIN &&
      binding.botAccessState !== ChatBotAccessState.CONFIRMED_OWNER
    )
      return 'denied';
    if (
      !binding.botAccessCheckedAt ||
      !binding.botAccessExpiresAt ||
      binding.botAccessExpiresAt <= probeStartedAt
    ) {
      await this.refreshQueue?.enqueue({
        chatId,
        publisherBotId: this.publisherBotId,
        reason: 'scheduled_bot_access',
        requestedAt: probeStartedAt,
        requiredBefore: binding.botAccessExpiresAt ?? probeStartedAt,
      });
      return 'deferred';
    }
    if (
      this.policy.separatesMaintenance(this.publisherBotId, chatId) &&
      binding.rosterRefreshAfter &&
      binding.rosterRefreshAfter > probeStartedAt
    )
      return 'deferred';
    const catalogAgeMs = catalog?.lastSeenAt
      ? probeStartedAt.getTime() - catalog.lastSeenAt.getTime()
      : Number.NaN;
    const reuseCatalog =
      catalog?.source === 'publisher_targeted_snapshot' &&
      catalog.status === 'ACTIVE' &&
      Boolean(catalog.title?.trim()) &&
      catalogAgeMs >= 0 &&
      catalogAgeMs < PUBLISHER_CATALOG_METADATA_MAX_AGE_MS;
    const [catalogResult, rosterResult] = await Promise.allSettled([
      measureStage('catalogMs', () =>
        reuseCatalog
          ? Promise.resolve({ entityType: catalog!.entityType, committed: true })
          : this.catalogRefresh.execute(
              chatId,
              source.entityType,
              probeStartedAt,
              binding.botAccessCheckedAt!,
              binding.botAccessState,
              false,
            ),
      ),
      measureStage('rosterMs', () =>
        probePublisherAdminRoster({
          maxClient: this.maxClient,
          chatId,
          publisherBotId: this.publisherBotId,
          probeStartedAt,
        }),
      ),
    ]);
    if (catalogResult.status === 'rejected') throw catalogResult.reason;
    if (rosterResult.status === 'rejected') throw rosterResult.reason;
    if (!catalogResult.value.committed) throw new PublisherBindingMaintenanceSupersededError();
    const committed = await measureStage('rosterMs', () =>
      syncPublisherAdminRoster(
        {
          prisma: this.prisma,
          maxClient: this.maxClient,
          chatId,
          publisherBotId: this.publisherBotId,
          entityType: catalogResult.value.entityType,
          probeStartedAt,
          botAccessCheckedAt: binding.botAccessCheckedAt!,
          botAccessState: binding.botAccessState as 'CONFIRMED_ADMIN' | 'CONFIRMED_OWNER',
        },
        rosterResult.value,
      ),
    );
    if (!committed) throw new PublisherBindingMaintenanceSupersededError();
    return 'confirmed';
  }
}
