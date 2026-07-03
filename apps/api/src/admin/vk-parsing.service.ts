import {
  bulkUpdateVkParsingSourcesRequestSchema,
  publishVkParsingPostRequestSchema,
  rollbackVkParsingRequestSchema,
  scheduleVkParsingPostRequestSchema,
  updateVkParsingSettingsRequestSchema,
  updateVkParsingSourceRequestSchema,
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
import { type VkParsingPublishReason, type VkParsingSyncReason } from './vk-parsing.queue';
import { VkPublishService } from './vk-publish.service';
import { VkSourceService } from './vk-source.service';
import { VkSyncService } from './vk-sync.service';

const VK_PARSING_AVAILABLE_CAPABILITY: VkParsingCapability = {
  enabled: true,
  canUse: true,
  reasonCode: null,
  reason: null,
};

@Injectable()
export class VkParsingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly accessService: VkParsingAccessService,
    private readonly feedService: VkParsingFeedService,
    private readonly sourceService: VkSourceService,
    private readonly syncService: VkSyncService,
    private readonly publishService: VkPublishService,
  ) {}

  getSyncIntervalMs(): number {
    return this.syncService.getSyncIntervalMs();
  }

  async getCapability(chatId: string, user: AuthUser): Promise<VkParsingCapability> {
    return this.accessService.getCapability(chatId, user);
  }

  async listVkParsing(chatId: string, user: AuthUser, query: unknown = {}): Promise<VkParsingFeed> {
    await this.accessService.assertAccess(chatId, user);
    return this.feedService.buildFeed(chatId, VK_PARSING_AVAILABLE_CAPABILITY, query);
  }

  async updateSettings(chatId: string, user: AuthUser, body: unknown): Promise<VkParsingFeed> {
    await this.accessService.assertAccess(chatId, user);
    const parsed = updateVkParsingSettingsRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }

    const existingSettings = await this.prisma.vkParsingSettings.findUnique({ where: { chatId } });
    const now = new Date();
    const nextAutoPublishEnabled =
      parsed.data.autoPublishEnabled ?? existingSettings?.autoPublishEnabled ?? false;
    const autoPublishEnabledAt =
      typeof parsed.data.autoPublishEnabled === 'boolean'
        ? parsed.data.autoPublishEnabled
          ? existingSettings?.autoPublishEnabled
            ? (existingSettings.autoPublishEnabledAt ?? now)
            : now
          : null
        : undefined;
    const updateData = {
      ...parsed.data,
      ...(autoPublishEnabledAt !== undefined ? { autoPublishEnabledAt } : {}),
    };

    await this.prisma.vkParsingSettings.upsert({
      where: { chatId },
      create: {
        chatId,
        autoPublishEnabled: nextAutoPublishEnabled,
        autoPublishEnabledAt: nextAutoPublishEnabled ? (autoPublishEnabledAt ?? now) : null,
        autoPublishKillSwitchEnabled: parsed.data.autoPublishKillSwitchEnabled ?? false,
        stripLinksEnabled: parsed.data.stripLinksEnabled ?? false,
        skipAdsEnabled: parsed.data.skipAdsEnabled ?? false,
        schedulerTimezone: parsed.data.schedulerTimezone ?? 'Europe/Moscow',
        quietHoursStart: parsed.data.quietHoursStart ?? null,
        quietHoursEnd: parsed.data.quietHoursEnd ?? null,
        workHoursStart: parsed.data.workHoursStart ?? '09:00',
        workHoursEnd: parsed.data.workHoursEnd ?? '22:00',
        distributeEvenlyEnabled: parsed.data.distributeEvenlyEnabled ?? true,
        roundRobinEnabled: parsed.data.roundRobinEnabled ?? true,
        circuitBreakerEnabled: parsed.data.circuitBreakerEnabled ?? true,
        circuitBreakerWindowMinutes: parsed.data.circuitBreakerWindowMinutes ?? 10,
        circuitBreakerPostLimit: parsed.data.circuitBreakerPostLimit ?? 10,
      },
      update: updateData,
    });

    if (
      parsed.data.autoPublishEnabled === false ||
      parsed.data.autoPublishKillSwitchEnabled === true
    ) {
      await this.publishService.clearQueuedAutoPublishForChat(chatId);
    }
    await this.writeAuditLog(chatId, user.userId, 'VK_PARSING_UPDATE_SETTINGS', {
      changed: parsed.data,
    });

    return this.feedService.buildFeed(chatId, VK_PARSING_AVAILABLE_CAPABILITY);
  }

  async getHealthSummary(chatId: string, user: AuthUser): Promise<VkParsingHealthSummary> {
    await this.accessService.assertAccess(chatId, user);
    return this.feedService.buildHealthSummary(chatId);
  }

  async addSource(chatId: string, user: AuthUser, body: unknown): Promise<VkParsingRefreshResult> {
    await this.accessService.assertAccess(chatId, user);
    return this.sourceService.addSource(chatId, user, body);
  }

  async removeSource(chatId: string, sourceId: string, user: AuthUser): Promise<VkParsingFeed> {
    await this.accessService.assertAccess(chatId, user);
    await this.publishService.clearQueuedAutoPublishForSource(chatId, sourceId);
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
    const feed = await this.sourceService.updateSource(chatId, sourceId, user, parsed.data);
    if (
      parsed.data.autoPublishEnabled === false ||
      parsed.data.importEnabled === false ||
      parsed.data.publishMode === 'REVIEW'
    ) {
      await this.publishService.clearQueuedAutoPublishForSource(chatId, sourceId);
    }
    return feed;
  }

  async applySourcePreset(chatId: string, user: AuthUser, body: unknown): Promise<VkParsingFeed> {
    await this.accessService.assertAccess(chatId, user);
    const parsed = bulkUpdateVkParsingSourcesRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }
    const feed = await this.sourceService.applyBulkPreset(chatId, user, parsed.data);
    if (parsed.data.preset === 'REVIEW') {
      await this.publishService.clearQueuedAutoPublishForSources(chatId, parsed.data.sourceIds);
    }
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
      where: { id: postId, chatId },
      include: { source: true },
    });
    if (!post || post.source.publishMode !== 'REVIEW') {
      throw new NotFoundException('Пост на модерации не найден.');
    }
    if (post.status === 'PUBLISHED' || post.status === 'UNAVAILABLE' || post.status === 'SKIPPED') {
      throw new BadRequestException('Этот пост уже нельзя вернуть на модерацию.');
    }

    const storedPhotoUrls = this.readStringArray(post.photoUrls);
    const storedLinkUrls = this.readStringArray(post.linkUrls);
    const photoUrls = this.assertSelectedUrls(parsed.data.photoUrls, storedPhotoUrls, 'фото');
    const linkUrls = this.assertSelectedUrls(parsed.data.linkUrls, storedLinkUrls, 'ссылку');

    const updated = await this.prisma.vkParsingPost.updateMany({
      where: {
        id: post.id,
        chatId,
        status: { notIn: ['PUBLISHED', 'UNAVAILABLE', 'SKIPPED'] },
        updatedAt: post.updatedAt,
        publishCancelledAt: null,
        publishLockedAt: null,
        source: { publishMode: 'REVIEW' },
      },
      data: {
        status: 'NEW',
        text: parsed.data.text,
        photoUrls,
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

    return this.feedService.buildFeed(chatId, VK_PARSING_AVAILABLE_CAPABILITY);
  }

  async retryPost(
    chatId: string,
    postId: string,
    user: AuthUser,
  ): Promise<RetryVkParsingPostResult> {
    await this.accessService.assertAccess(chatId, user);
    return this.publishService.retryPost(chatId, postId);
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

  async processPublishPostJob(params: {
    postId: string;
    chatId: string;
    reason: VkParsingPublishReason;
    idempotencyKey: string;
    attemptsMade?: number;
    maxAttempts?: number;
  }): Promise<void> {
    return this.publishService.processPublishPostJob(params);
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
