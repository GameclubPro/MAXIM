import {
  bulkUpdateVkParsingSourcesRequestSchema,
  publishVkParsingPostRequestSchema,
  rollbackVkParsingRequestSchema,
  scheduleVkParsingPostRequestSchema,
  updateVkParsingSettingsRequestSchema,
  updateVkParsingSourceRequestSchema,
  VK_PARSING_DEFAULT_CHANNEL_LINK_TEXT,
  type PublishVkParsingPostResult,
  type RollbackVkParsingResult,
  type RetryVkParsingPostResult,
  type VkParsingCapability,
  type VkParsingDryRunResult,
  type VkParsingFeed,
  type VkParsingHealthSummary,
  type VkParsingRefreshResult,
} from '@maxim/contracts';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { type AuthUser } from '../common/decorators/current-user.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { VkParsingAccessService } from './vk-parsing-access.service';
import { VkParsingFeedService } from './vk-parsing-feed.service';
import { VkParsingOwnershipService } from './vk-parsing-ownership.service';
import type { VkParsingSyncReason } from './vk-parsing.queue';
import { VkPublishService } from './vk-publish.service';
import { VkSourceService } from './vk-source.service';
import { VkSyncService } from './vk-sync.service';

const VK_PARSING_AVAILABLE_CAPABILITY: VkParsingCapability = {
  enabled: true,
  canUse: true,
  reasonCode: null,
  reason: null,
};
const MAX_SEND_AMBIGUOUS_ERROR_PREFIX = '[max.send_ambiguous]';
const MAX_SEND_AMBIGUOUS_DRAFT_BLOCK_MESSAGE =
  'MAX мог уже принять эту публикацию. Сначала сверьте сообщение в MAX вручную; сохранение черновика заблокировано.';

@Injectable()
export class VkParsingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly accessService: VkParsingAccessService,
    private readonly feedService: VkParsingFeedService,
    private readonly sourceService: VkSourceService,
    private readonly syncService: VkSyncService,
    private readonly publishService: VkPublishService,
    private readonly ownership: VkParsingOwnershipService,
  ) {}

  getSyncIntervalMs(): number {
    return this.syncService.getSyncIntervalMs();
  }

  async getCapability(chatId: string, user: AuthUser): Promise<VkParsingCapability> {
    return this.accessService.getCapability(chatId, user);
  }

  async listVkParsing(chatId: string, user: AuthUser, query: unknown = {}): Promise<VkParsingFeed> {
    await this.accessService.assertAccess(chatId, user);
    return this.feedService.buildFeed(
      chatId,
      VK_PARSING_AVAILABLE_CAPABILITY,
      query,
      this.ownership.getPublisherScope(),
    );
  }

  async updateSettings(chatId: string, user: AuthUser, body: unknown): Promise<VkParsingFeed> {
    await this.accessService.assertAccess(chatId, user);
    const parsed = updateVkParsingSettingsRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }

    const ownerScope = this.ownership.getPublisherScope();
    const { autoPublishMode, ...rawSettingsPatch } = parsed.data;
    const resolvedAutoPublishMode =
      autoPublishMode ??
      (typeof rawSettingsPatch.autoPublishEnabled === 'boolean'
        ? rawSettingsPatch.autoPublishEnabled
          ? rawSettingsPatch.autoPublishKillSwitchEnabled === true
            ? 'PAUSED'
            : 'AUTO'
          : 'MANUAL'
        : undefined);
    const settingsPatch = {
      ...rawSettingsPatch,
      ...(resolvedAutoPublishMode === 'AUTO'
        ? { autoPublishEnabled: true, autoPublishKillSwitchEnabled: false }
        : resolvedAutoPublishMode === 'MANUAL'
          ? { autoPublishEnabled: false, autoPublishKillSwitchEnabled: false }
          : resolvedAutoPublishMode === 'PAUSED'
            ? { autoPublishKillSwitchEnabled: true }
            : {}),
    };
    if (settingsPatch.appendChannelLinkEnabled === true) {
      await this.publishService.assertChannelLinkAvailable(chatId, 'interactive');
    }
    await this.prisma.$transaction(async (tx) => {
      const lockedChats = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT chat."id"
        FROM "chats" AS chat
        WHERE chat."id" = ${chatId}
        FOR UPDATE OF chat
      `;
      if (lockedChats.length !== 1) {
        throw new NotFoundException('Чат или канал не найден.');
      }

      const existingSettings = await tx.vkParsingSettings.findUnique({
        where: {
          chatId_ownerProfile_ownerBotId: {
            chatId,
            ...ownerScope,
          },
        },
      });
      const now = new Date();
      const nextAutoPublishEnabled =
        settingsPatch.autoPublishEnabled ?? existingSettings?.autoPublishEnabled ?? false;
      const nextAppendChannelLinkEnabled =
        settingsPatch.appendChannelLinkEnabled ??
        existingSettings?.appendChannelLinkEnabled ??
        false;
      const nextChannelLinkText =
        settingsPatch.channelLinkText ??
        existingSettings?.channelLinkText ??
        VK_PARSING_DEFAULT_CHANNEL_LINK_TEXT;
      if (nextAppendChannelLinkEnabled && !nextChannelLinkText.trim()) {
        throw new BadRequestException('Укажите текст ссылки на канал.');
      }
      const autoPublishEnabledAt =
        typeof settingsPatch.autoPublishEnabled === 'boolean'
          ? settingsPatch.autoPublishEnabled
            ? existingSettings?.autoPublishEnabled
              ? (existingSettings.autoPublishEnabledAt ?? now)
              : now
            : null
          : undefined;
      const updateData = {
        ...settingsPatch,
        ...(autoPublishEnabledAt !== undefined ? { autoPublishEnabledAt } : {}),
      };

      await tx.vkParsingSettings.upsert({
        where: {
          chatId_ownerProfile_ownerBotId: {
            chatId,
            ...ownerScope,
          },
        },
        create: {
          chatId,
          ...ownerScope,
          autoPublishEnabled: nextAutoPublishEnabled,
          autoPublishEnabledAt: nextAutoPublishEnabled ? (autoPublishEnabledAt ?? now) : null,
          autoPublishKillSwitchEnabled: settingsPatch.autoPublishKillSwitchEnabled ?? false,
          stripLinksEnabled: settingsPatch.stripLinksEnabled ?? false,
          skipAdsEnabled: settingsPatch.skipAdsEnabled ?? false,
          appendChannelLinkEnabled: nextAppendChannelLinkEnabled,
          channelLinkText: nextChannelLinkText,
          schedulerTimezone: settingsPatch.schedulerTimezone ?? 'Europe/Moscow',
          quietHoursStart: settingsPatch.quietHoursStart ?? null,
          quietHoursEnd: settingsPatch.quietHoursEnd ?? null,
          workHoursStart: settingsPatch.workHoursStart ?? '09:00',
          workHoursEnd: settingsPatch.workHoursEnd ?? '22:00',
          distributeEvenlyEnabled: settingsPatch.distributeEvenlyEnabled ?? true,
          roundRobinEnabled: settingsPatch.roundRobinEnabled ?? true,
          circuitBreakerEnabled: settingsPatch.circuitBreakerEnabled ?? true,
          circuitBreakerWindowMinutes: settingsPatch.circuitBreakerWindowMinutes ?? 10,
          circuitBreakerPostLimit: settingsPatch.circuitBreakerPostLimit ?? 10,
        },
        update: updateData,
      });

      if (
        resolvedAutoPublishMode === 'AUTO' &&
        !(
          existingSettings?.autoPublishEnabled === true &&
          existingSettings.autoPublishKillSwitchEnabled === true
        )
      ) {
        await tx.vkParsingSource.updateMany({
          where: {
            chatId,
            ...ownerScope,
            status: 'ACTIVE',
            importEnabled: true,
            autoPublishEnabled: false,
            publishMode: { not: 'REVIEW' },
            syncStatus: { not: 'ERROR' },
            terminalFailureCount: 0,
            circuitOpenedAt: null,
            OR: [
              { autoPublishPausedReason: null },
              { autoPublishPausedReason: { in: ['manual', 'preset'] } },
            ],
          },
          data: {
            autoPublishEnabled: true,
            autoPublishEnabledAt: now,
            autoPublishPausedAt: null,
            autoPublishPausedReason: null,
          },
        });
      } else if (resolvedAutoPublishMode === 'MANUAL') {
        await tx.vkParsingSource.updateMany({
          where: {
            chatId,
            ...ownerScope,
            status: 'ACTIVE',
          },
          data: {
            autoPublishEnabled: false,
            autoPublishEnabledAt: null,
            autoPublishPausedAt: now,
            autoPublishPausedReason: 'manual',
          },
        });
      }

      if (
        resolvedAutoPublishMode === 'MANUAL' ||
        (resolvedAutoPublishMode === undefined && settingsPatch.autoPublishEnabled === false)
      ) {
        await this.publishService.clearQueuedAutoPublishForChat(chatId, ownerScope, tx);
      }

      await tx.auditLog.create({
        data: {
          chatId,
          actorUserId: user.userId,
          action: 'VK_PARSING_UPDATE_SETTINGS',
          payload: JSON.parse(JSON.stringify({ ...ownerScope, changed: parsed.data })),
        },
      });
    });

    return this.feedService.buildFeed(chatId, VK_PARSING_AVAILABLE_CAPABILITY, {}, ownerScope);
  }

  async getHealthSummary(chatId: string, user: AuthUser): Promise<VkParsingHealthSummary> {
    await this.accessService.assertAccess(chatId, user);
    return this.feedService.buildHealthSummary(chatId, this.ownership.getPublisherScope());
  }

  async addSource(chatId: string, user: AuthUser, body: unknown): Promise<VkParsingRefreshResult> {
    await this.accessService.assertAccess(chatId, user);
    return this.sourceService.addSource(chatId, user, body);
  }

  async removeSource(chatId: string, sourceId: string, user: AuthUser): Promise<VkParsingFeed> {
    await this.accessService.assertAccess(chatId, user);
    return this.sourceService.removeSource(chatId, sourceId);
  }

  async updateSource(
    chatId: string,
    sourceId: string,
    user: AuthUser,
    body: unknown,
  ): Promise<VkParsingFeed> {
    await this.accessService.assertAccess(chatId, user);
    const parsed = updateVkParsingSourceRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }
    return this.sourceService.updateSource(chatId, sourceId, user, parsed.data);
  }

  async applySourcePreset(chatId: string, user: AuthUser, body: unknown): Promise<VkParsingFeed> {
    await this.accessService.assertAccess(chatId, user);
    const parsed = bulkUpdateVkParsingSourcesRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }
    const feed = await this.sourceService.applyBulkPreset(chatId, user, parsed.data);
    if (parsed.data.preset === 'CLEAN') {
      return this.updateSettings(chatId, user, {
        stripLinksEnabled: true,
        skipAdsEnabled: true,
      });
    }
    return feed;
  }

  async refresh(chatId: string, user: AuthUser): Promise<VkParsingRefreshResult> {
    await this.accessService.assertAccess(chatId, user);
    return this.sourceService.refresh(chatId);
  }

  async refreshSource(
    chatId: string,
    sourceId: string,
    user: AuthUser,
  ): Promise<VkParsingRefreshResult> {
    await this.accessService.assertAccess(chatId, user);
    return this.sourceService.refreshSource(chatId, sourceId);
  }

  async syncDueSources(reason: VkParsingSyncReason = 'scheduled'): Promise<number> {
    return this.sourceService.syncDueSources(reason);
  }

  async recoverStalePublishJobs(): Promise<number> {
    return this.publishService.recoverStalePublishJobs();
  }

  async recoverStalePublisherRollbackJobs(): Promise<number> {
    return this.publishService.recoverStalePublisherRollbackJobs();
  }

  async publishPost(
    chatId: string,
    postId: string,
    user: AuthUser,
    body: unknown,
  ): Promise<PublishVkParsingPostResult> {
    await this.accessService.assertAccess(chatId, user);
    return this.publishService.publishPost(chatId, postId, user.userId, body);
  }

  async updateReviewPostDraft(
    chatId: string,
    postId: string,
    user: AuthUser,
    body: unknown,
  ): Promise<VkParsingFeed> {
    await this.accessService.assertAccess(chatId, user);
    const parsed = publishVkParsingPostRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }

    const post = await this.prisma.vkParsingPost.findFirst({
      where: {
        id: postId,
        chatId,
        ...this.ownership.getPublisherScope(),
        source: this.ownership.getPublisherScope(),
      },
      include: { source: true },
    });
    if (!post || post.source.publishMode !== 'REVIEW') {
      throw new NotFoundException('Пост на модерации не найден.');
    }
    if (post.status === 'PUBLISHED' || post.status === 'UNAVAILABLE' || post.status === 'SKIPPED') {
      throw new BadRequestException('Этот пост уже нельзя вернуть на модерацию.');
    }
    if (post.lastError?.trim().startsWith(MAX_SEND_AMBIGUOUS_ERROR_PREFIX) === true) {
      throw new BadRequestException(MAX_SEND_AMBIGUOUS_DRAFT_BLOCK_MESSAGE);
    }

    const storedPhotoUrls = this.readStringArray(post.photoUrls);
    const storedVideoUrls = this.readStringArray(post.videoUrls);
    const storedLinkUrls = this.readStringArray(post.linkUrls);
    const photoUrls = this.assertSelectedUrls(parsed.data.photoUrls, storedPhotoUrls, 'фото');
    const videoUrls = this.assertSelectedUrls(parsed.data.videoUrls, storedVideoUrls, 'видео');
    const linkUrls = this.assertSelectedUrls(parsed.data.linkUrls, storedLinkUrls, 'ссылку');

    const updated = await this.prisma.vkParsingPost.updateMany({
      where: {
        id: post.id,
        chatId,
        ...this.ownership.getPublisherScope(),
        status: { notIn: ['PUBLISHED', 'UNAVAILABLE', 'SKIPPED'] },
        updatedAt: post.updatedAt,
        publishCancelledAt: null,
        publishLockedAt: null,
        source: { ...this.ownership.getPublisherScope(), publishMode: 'REVIEW' },
      },
      data: {
        status: 'NEW',
        text: parsed.data.text,
        textFormat: parsed.data.textFormat,
        manualContentEditedAt: new Date(),
        photoUrls,
        videoUrls,
        linkUrls,
        publishLockedAt: null,
        publishQueuedAt: null,
        publishScheduledAt: null,
        publishIdempotencyKey: null,
        publishReason: null,
        lastError: null,
        autoPublishError: null,
      },
    });
    if (updated.count === 0) {
      throw new NotFoundException('Пост на модерации уже обработан или недоступен.');
    }

    return this.feedService.buildFeed(
      chatId,
      VK_PARSING_AVAILABLE_CAPABILITY,
      {},
      this.ownership.getPublisherScope(),
    );
  }

  async retryPost(
    chatId: string,
    postId: string,
    user: AuthUser,
  ): Promise<RetryVkParsingPostResult> {
    await this.accessService.assertAccess(chatId, user);
    return this.publishService.retryPost(chatId, postId, user.userId);
  }

  async schedulePost(
    chatId: string,
    postId: string,
    user: AuthUser,
    body: unknown,
  ): Promise<RetryVkParsingPostResult> {
    await this.accessService.assertAccess(chatId, user);
    const parsed = scheduleVkParsingPostRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }
    return this.publishService.schedulePost(chatId, postId, parsed.data.scheduledAt, user.userId);
  }

  async cancelScheduledPost(
    chatId: string,
    postId: string,
    user: AuthUser,
  ): Promise<RetryVkParsingPostResult> {
    await this.accessService.assertAccess(chatId, user);
    return this.publishService.cancelScheduledPost(chatId, postId, user.userId);
  }

  async publishPostNow(
    chatId: string,
    postId: string,
    user: AuthUser,
  ): Promise<RetryVkParsingPostResult> {
    await this.accessService.assertAccess(chatId, user);
    return this.publishService.publishPostNow(chatId, postId, user.userId);
  }

  async dryRunAutoPublish(
    chatId: string,
    user: AuthUser,
    query: unknown,
  ): Promise<VkParsingDryRunResult> {
    await this.accessService.assertAccess(chatId, user);
    return this.publishService.dryRunAutoPublish(chatId, query);
  }

  async rollbackAutoPublished(
    chatId: string,
    user: AuthUser,
    body: unknown,
  ): Promise<RollbackVkParsingResult> {
    await this.accessService.assertAccess(chatId, user);
    const parsed = rollbackVkParsingRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }
    return this.publishService.rollbackAutoPublished(chatId, user.userId, parsed.data);
  }

  async processSyncSourceJob(
    sourceId: string,
    reason: VkParsingSyncReason = 'scheduled',
  ): Promise<number> {
    return this.syncService.processSyncSourceJob(sourceId, reason);
  }

  async processPublishPostJob(
    params: Parameters<VkPublishService['processPublishPostJob']>[0],
  ): Promise<void> {
    return this.publishService.processPublishPostJob(params);
  }

  async processPublisherRollbackJob(
    params: Parameters<VkPublishService['processPublisherRollbackJob']>[0],
  ): Promise<void> {
    return this.publishService.processPublisherRollbackJob(params);
  }

  private async writeAuditLog(
    chatId: string,
    actorUserId: string,
    action: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    if (!this.prisma.auditLog?.create) {
      return;
    }
    await this.prisma.auditLog.create({
      data: {
        chatId,
        actorUserId,
        action,
        payload: JSON.parse(JSON.stringify(payload ?? null)),
      },
    });
  }

  private assertSelectedUrls(selected: string[], stored: string[], label: string): string[] {
    const storedSet = new Set(stored);
    const normalized = [...new Set(selected.map((url) => url.trim()).filter(Boolean))];
    const forbidden = normalized.find((url) => !storedSet.has(url));
    if (forbidden) {
      throw new BadRequestException(`Нельзя сохранить неизвестную ${label}.`);
    }

    return normalized;
  }

  private readStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) {
      return [];
    }

    return value.filter((item): item is string => typeof item === 'string' && item.length > 0);
  }
}
