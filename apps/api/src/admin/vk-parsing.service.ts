import {
  updateVkParsingSettingsRequestSchema,
  type PublishVkParsingPostResult,
  type RetryVkParsingPostResult,
  type VkParsingCapability,
  type VkParsingFeed,
  type VkParsingHealthSummary,
  type VkParsingRefreshResult,
} from '@maxim/contracts';
import { BadRequestException, Injectable } from '@nestjs/common';
import { type AuthUser } from '../common/decorators/current-user.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { VkParsingAccessService } from './vk-parsing-access.service';
import { VkParsingFeedService } from './vk-parsing-feed.service';
import { type VkParsingPublishReason, type VkParsingSyncReason } from './vk-parsing.queue';
import { VkPublishService } from './vk-publish.service';
import { VkSourceService } from './vk-source.service';
import { VkSyncService } from './vk-sync.service';

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
    return this.feedService.buildFeed(chatId, { enabled: true, canUse: true }, query);
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
        stripLinksEnabled: parsed.data.stripLinksEnabled ?? false,
        skipAdsEnabled: parsed.data.skipAdsEnabled ?? false,
      },
      update: updateData,
    });

    if (parsed.data.autoPublishEnabled === false) {
      await this.publishService.clearQueuedAutoPublishForChat(chatId);
    }

    return this.feedService.buildFeed(chatId, { enabled: true, canUse: true });
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
    return this.sourceService.removeSource(chatId, sourceId);
  }

  async refresh(chatId: string, user: AuthUser): Promise<VkParsingRefreshResult> {
    await this.accessService.assertAccess(chatId, user);
    return this.sourceService.refresh(chatId);
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

  async retryPost(
    chatId: string,
    postId: string,
    user: AuthUser,
  ): Promise<RetryVkParsingPostResult> {
    await this.accessService.assertAccess(chatId, user);
    return this.publishService.retryPost(chatId, postId);
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
  }): Promise<void> {
    return this.publishService.processPublishPostJob(params);
  }
}
