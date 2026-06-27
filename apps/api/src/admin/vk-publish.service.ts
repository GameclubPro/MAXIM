import {
  publishVkParsingPostRequestSchema,
  rollbackVkParsingResultSchema,
  retryVkParsingPostResultSchema,
  VK_PARSING_MAX_LINKS,
  VK_PARSING_MAX_PHOTOS,
  VK_PARSING_MAX_PUBLISH_TEXT_LENGTH,
  type PublishVkParsingPostResult,
  type RollbackVkParsingRequest,
  type RollbackVkParsingResult,
  type RetryVkParsingPostResult,
  type VkParsingDryRunResult,
} from '@maxim/contracts';
import { InjectQueue } from '@nestjs/bullmq';
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import type { Queue } from 'bullmq';
import {
  MAX_API_SOURCE_TAGS,
  MaxClientService,
  type MaxAttachmentPayload,
  type MaxApiTrafficClass,
  type MaxSendMessageOptions,
} from '../max/max-client.service';
import { MaxBotLinkService } from '../max/max-bot-link.service';
import { ManagedEntityAccessLossService } from '../max/managed-entity-access-loss.service';
import { ChatEntityType, Prisma } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import {
  BackgroundRuntimeGovernorService,
  type BackgroundRuntimeGovernorDecision,
} from '../system/background-runtime-governor.service';
import { AdminService } from './admin.service';
import { VkParsingAccessService } from './vk-parsing-access.service';
import { parseVkWallPostAttachments } from './vk-parsing-attachments';
import {
  computeVkParsingPostContentHash,
  describeVkParsingSkipReason,
  prepareVkParsingPublishPayload,
  resolveVkParsingPostSkipReason,
  VK_POST_SKIP_REASON_NO_SUPPORTED_CONTENT,
  type PreparedVkPublishPayload,
  type VkParsingSkipReason,
} from './vk-parsing-content';
import {
  classifyVkParsingPublishError,
  formatVkParsingClassifiedErrorMessage,
  formatVkParsingError,
  isMaxAttachmentNotReadyError,
} from './vk-parsing-errors';
import { VkParsingFeedService } from './vk-parsing-feed.service';
import {
  VK_IMAGE_FETCH_TIMEOUT_MS,
  VK_IMAGE_MAX_BYTES,
  VK_MEDIA_STATUS_FAILED,
  VK_MEDIA_STATUS_READY,
  VkParsingMediaCacheService,
  type VkParsingMediaCacheRow,
} from './vk-parsing-media-cache.service';
import {
  VK_PARSING_PUBLISH_QUEUE,
  VK_PARSING_PUBLISH_RETRY_POLICY,
  type VkParsingPublishJob,
  type VkParsingPublishReason,
} from './vk-parsing.queue';

type VkParsingPostWithSource = Prisma.VkParsingPostGetPayload<{ include: { source: true } }>;

type VkParsingSettingsLike = {
  chatId: string;
  autoPublishEnabled: boolean;
  autoPublishEnabledAt: Date | null;
  autoPublishKillSwitchEnabled: boolean;
  stripLinksEnabled: boolean;
  skipAdsEnabled: boolean;
  schedulerTimezone: string;
  quietHoursStart: string | null;
  quietHoursEnd: string | null;
  workHoursStart: string;
  workHoursEnd: string;
  distributeEvenlyEnabled: boolean;
  roundRobinEnabled: boolean;
  circuitBreakerEnabled: boolean;
  circuitBreakerWindowMinutes: number;
  circuitBreakerPostLimit: number;
  updatedAt: Date | null;
};

type VkParsingPhotoPublishMedia = {
  mediaIdentity: string | null;
  candidateUrls: string[];
};

const VK_POST_STATUS_NEW = 'NEW';
const VK_POST_STATUS_PUBLISHED = 'PUBLISHED';
const VK_POST_STATUS_FAILED = 'FAILED';
const VK_POST_STATUS_UNAVAILABLE = 'UNAVAILABLE';
const VK_POST_STATUS_SKIPPED = 'SKIPPED';
const VK_SOURCE_STATUS_ACTIVE = 'ACTIVE';
const VK_SOURCE_PUBLISH_MODE_IMMEDIATE = 'IMMEDIATE';
const VK_SOURCE_PUBLISH_MODE_REVIEW = 'REVIEW';
const VK_PUBLISH_JOB_NAME = 'publish-vk-post';
const SAFETY_DESK_ACTOR_USER_ID = 'safety-desk-owner';
const VK_PARSING_SYSTEM_ACTOR_USER_ID = 'vk-parsing-autopost';
const VK_PARSING_SCHEDULE_STEP_MS = 15 * 60_000;
const VK_PARSING_MAX_SCHEDULE_LOOKAHEAD_STEPS = (8 * 24 * 60) / 15;

@Injectable()
export class VkPublishService {
  private readonly logger = new Logger(VkPublishService.name);
  private readonly queueBatchSize: number;
  private readonly publishLeaseTtlMs: number;
  private readonly mediaConcurrency: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly accessService: VkParsingAccessService,
    private readonly adminService: AdminService,
    private readonly maxClient: MaxClientService,
    private readonly maxBotLinkService: MaxBotLinkService,
    private readonly mediaCache: VkParsingMediaCacheService,
    private readonly feedService: VkParsingFeedService,
    @InjectQueue(VK_PARSING_PUBLISH_QUEUE)
    private readonly publishQueue: Queue<VkParsingPublishJob>,
    configService: ConfigService,
    @Optional()
    private readonly backgroundRuntimeGovernorService?: BackgroundRuntimeGovernorService,
    @Optional()
    private readonly managedEntityAccessLossService?: ManagedEntityAccessLossService,
  ) {
    this.queueBatchSize = configService.get<number>('VK_PARSING_QUEUE_BATCH_SIZE') ?? 100;
    this.publishLeaseTtlMs =
      configService.get<number>('VK_PARSING_PUBLISH_LEASE_TTL_MS') ??
      configService.get<number>('VK_PARSING_LEASE_TTL_MS') ??
      120_000;
    this.mediaConcurrency = configService.get<number>('VK_PARSING_MEDIA_CONCURRENCY') ?? 3;
  }

  async recoverStalePublishJobs(): Promise<number> {
    const now = new Date();
    const staleLockBefore = new Date(now.getTime() - this.publishLeaseTtlMs);
    const posts = await this.prisma.vkParsingPost.findMany({
      where: {
        publishQueuedAt: { not: null },
        publishIdempotencyKey: { not: null },
        status: { in: [VK_POST_STATUS_NEW, VK_POST_STATUS_FAILED] },
        OR: [{ publishLockedAt: null }, { publishLockedAt: { lt: staleLockBefore } }],
      },
      include: { source: true },
      orderBy: [{ publishQueuedAt: 'asc' }, { updatedAt: 'asc' }],
      take: this.queueBatchSize,
    });
    if (posts.length === 0) {
      return 0;
    }

    const settingsByChatId = new Map<string, VkParsingSettingsLike>();
    let recovered = 0;
    for (const post of posts) {
      const idempotencyKey = post.publishIdempotencyKey;
      if (!idempotencyKey) {
        continue;
      }
      const reason = this.resolveRecoveredPublishReason(post.publishReason);

      let settings = settingsByChatId.get(post.chatId);
      if (!settings) {
        settings = await this.getSettingsForChat(post.chatId);
        settingsByChatId.set(post.chatId, settings);
      }

      if (reason === 'autopublish' && !this.canAutoPublishPost(post, settings)) {
        await this.clearQueuedAutoPublishPost(post.id, idempotencyKey);
        continue;
      }

      await this.addPublishJob(post, reason, idempotencyKey, now, post.publishScheduledAt);
      recovered += 1;
    }

    return recovered;
  }

  async publishPost(
    chatId: string,
    postId: string,
    actorUserId: string,
    body: unknown,
  ): Promise<PublishVkParsingPostResult> {
    const parsed = publishVkParsingPostRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }

    const post = await this.prisma.vkParsingPost.findFirst({
      where: { id: postId, chatId },
      include: { source: true },
    });
    if (!post) {
      throw new NotFoundException('VK-пост не найден.');
    }
    if (post.status === VK_POST_STATUS_PUBLISHED) {
      throw new BadRequestException('Этот VK-пост уже опубликован.');
    }
    this.assertReviewSourceOwnerAction(post, actorUserId);

    const storedPhotoUrls = this.readStringArray(post.photoUrls);
    const storedLinkUrls = this.readStringArray(post.linkUrls);
    const photoUrls = this.assertSelectedUrls(parsed.data.photoUrls, storedPhotoUrls, 'фото');
    const linkUrls = this.assertSelectedUrls(parsed.data.linkUrls, storedLinkUrls, 'ссылку');
    const settings = await this.getSettingsForChat(chatId);
    const prepared = prepareVkParsingPublishPayload(
      {
        text: parsed.data.text,
        photoUrls,
        linkUrls,
      },
      settings,
    );
    const skipReason = resolveVkParsingPostSkipReason(
      {
        text: post.text,
        photoUrls: storedPhotoUrls,
        linkUrls: storedLinkUrls,
        attachments: this.readAttachments(post.attachments),
        raw: this.asRecord(post.raw) ?? {},
        isAdvertising: post.isAdvertising,
        advertisingMarkers: this.readStringArray(post.advertisingMarkers),
      },
      settings,
    );
    if (skipReason) {
      await this.markPostSkipped(post.id, skipReason);
      throw new BadRequestException(describeVkParsingSkipReason(skipReason));
    }
    this.assertPreparedPublishPayload(prepared);
    const locked = await this.lockManualPublishPost(post.id, chatId);
    if (!locked) {
      throw new BadRequestException('Этот VK-пост уже публикуется.');
    }

    return this.publishPreparedPostToMax(post, prepared, {
      actorUserId,
      trafficClass: 'interactive',
      debugAction: 'publish_post',
      auto: false,
    });
  }

  async retryPost(chatId: string, postId: string): Promise<RetryVkParsingPostResult> {
    const post = await this.prisma.vkParsingPost.findFirst({
      where: { id: postId, chatId },
      include: { source: true },
    });
    if (!post) {
      throw new NotFoundException('VK-пост не найден.');
    }
    if (post.status === VK_POST_STATUS_PUBLISHED) {
      throw new BadRequestException('Этот VK-пост уже опубликован.');
    }
    if (post.status === VK_POST_STATUS_UNAVAILABLE) {
      throw new BadRequestException('VK-пост недоступен в исходном источнике.');
    }
    this.assertReviewSourceOwnerAction(post, null);

    const queued = await this.enqueuePostPublish(post, 'manual-retry');
    const updated = await this.prisma.vkParsingPost.findFirst({
      where: { id: post.id, chatId },
      include: { source: true },
    });
    return retryVkParsingPostResultSchema.parse({
      post: this.feedService.mapPost(updated ?? post),
      queued,
    });
  }

  async schedulePost(
    chatId: string,
    postId: string,
    scheduledAtIso: string,
    actorUserId: string,
  ): Promise<RetryVkParsingPostResult> {
    const post = await this.findSchedulablePost(chatId, postId);
    this.assertReviewSourceOwnerAction(post, actorUserId);
    const scheduledAt = new Date(scheduledAtIso);
    if (!Number.isFinite(scheduledAt.getTime())) {
      throw new BadRequestException('Некорректное время публикации.');
    }
    const reason = post.publishReason === 'autopublish' ? 'autopublish' : 'manual-schedule';
    const queued = await this.enqueuePostPublish(post, reason, scheduledAt);
    await this.writeAuditLog(chatId, actorUserId, 'VK_PARSING_SCHEDULE_POST', {
      postId,
      sourceId: post.sourceId,
      scheduledAt: scheduledAt.toISOString(),
    });
    const updated = await this.prisma.vkParsingPost.findFirst({
      where: { id: post.id, chatId },
      include: { source: true },
    });
    return retryVkParsingPostResultSchema.parse({
      post: this.feedService.mapPost(updated ?? post),
      queued,
    });
  }

  async cancelScheduledPost(
    chatId: string,
    postId: string,
    actorUserId: string,
  ): Promise<RetryVkParsingPostResult> {
    const post = await this.findSchedulablePost(chatId, postId);
    const now = new Date();
    await this.prisma.vkParsingPost.update({
      where: { id: post.id },
      data: {
        publishQueuedAt: null,
        publishScheduledAt: null,
        publishLockedAt: null,
        publishIdempotencyKey: null,
        publishReason: null,
        publishCancelledAt: now,
        publishCancelledByUserId: actorUserId,
      },
    });
    await this.writeAuditLog(chatId, actorUserId, 'VK_PARSING_CANCEL_POST', {
      postId,
      sourceId: post.sourceId,
    });
    const updated = await this.prisma.vkParsingPost.findFirst({
      where: { id: post.id, chatId },
      include: { source: true },
    });
    return retryVkParsingPostResultSchema.parse({
      post: this.feedService.mapPost(updated ?? post),
      queued: 0,
    });
  }

  async publishPostNow(
    chatId: string,
    postId: string,
    actorUserId: string,
  ): Promise<RetryVkParsingPostResult> {
    const post = await this.findSchedulablePost(chatId, postId);
    this.assertReviewSourceOwnerAction(post, actorUserId);
    const queued = await this.enqueuePostPublish(post, 'manual-retry', new Date());
    await this.writeAuditLog(chatId, actorUserId, 'VK_PARSING_PUBLISH_NOW', {
      postId,
      sourceId: post.sourceId,
    });
    const updated = await this.prisma.vkParsingPost.findFirst({
      where: { id: post.id, chatId },
      include: { source: true },
    });
    return retryVkParsingPostResultSchema.parse({
      post: this.feedService.mapPost(updated ?? post),
      queued,
    });
  }

  async dryRunAutoPublish(chatId: string, query: unknown): Promise<VkParsingDryRunResult> {
    const sourceId =
      this.asRecord(query)?.sourceId && typeof this.asRecord(query)?.sourceId === 'string'
        ? String(this.asRecord(query)?.sourceId).trim()
        : null;
    const now = new Date();
    const settings = await this.getSettingsForChat(chatId);
    const sources = await this.prisma.vkParsingSource.findMany({
      where: {
        chatId,
        status: VK_SOURCE_STATUS_ACTIVE,
        ...(sourceId ? { id: sourceId } : {}),
      },
    });

    let eligibleNow = 0;
    let latestImportedVkPublishedAt: Date | null = null;
    let sourcesWithoutSuccessfulSync = 0;
    let baselineAt: Date | null = settings.autoPublishEnabledAt;
    if (settings.autoPublishEnabled && !settings.autoPublishKillSwitchEnabled) {
      for (const source of sources) {
        if (!source.lastSuccessAt) {
          sourcesWithoutSuccessfulSync += 1;
        }
        const sourceBaseline = this.resolveAutoPublishBaseline(settings, source);
        if (!sourceBaseline || !source.autoPublishEnabled || source.publishMode === 'REVIEW') {
          continue;
        }
        baselineAt =
          baselineAt && baselineAt.getTime() > sourceBaseline.getTime()
            ? baselineAt
            : sourceBaseline;
        const [count, latest] = await Promise.all([
          this.prisma.vkParsingPost.count({
            where: {
              chatId,
              sourceId: source.id,
              status: VK_POST_STATUS_NEW,
              publishQueuedAt: null,
              publishCancelledAt: null,
              createdAt: { gte: sourceBaseline },
              vkPublishedAt: { gte: sourceBaseline },
            },
          }),
          this.prisma.vkParsingPost.aggregate({
            where: { chatId, sourceId: source.id, status: VK_POST_STATUS_NEW },
            _max: { vkPublishedAt: true },
          }),
        ]);
        eligibleNow += count;
        const latestAt = latest._max.vkPublishedAt;
        if (
          latestAt &&
          (!latestImportedVkPublishedAt ||
            latestAt.getTime() > latestImportedVkPublishedAt.getTime())
        ) {
          latestImportedVkPublishedAt = latestAt;
        }
      }
    }

    return {
      chatId,
      sourceId,
      generatedAt: now.toISOString(),
      globalEnabled: settings.autoPublishEnabled,
      killSwitchEnabled: settings.autoPublishKillSwitchEnabled,
      baselineAt: baselineAt ? baselineAt.toISOString() : null,
      eligibleNow,
      latestImportedVkPublishedAt: latestImportedVkPublishedAt
        ? latestImportedVkPublishedAt.toISOString()
        : null,
      sourcesWithoutSuccessfulSync,
    };
  }

  async rollbackAutoPublished(
    chatId: string,
    actorUserId: string,
    request: RollbackVkParsingRequest,
  ): Promise<RollbackVkParsingResult> {
    const since = new Date(request.since);
    const until = new Date(request.until);
    if (!Number.isFinite(since.getTime()) || !Number.isFinite(until.getTime())) {
      throw new BadRequestException('Некорректный период rollback.');
    }
    if (until.getTime() < since.getTime()) {
      throw new BadRequestException('Конец периода раньше начала.');
    }
    const posts = await this.prisma.vkParsingPost.findMany({
      where: {
        chatId,
        autoPublishedAt: { gte: since, lte: until },
        ...(request.sourceId ? { sourceId: request.sourceId } : {}),
      },
      include: { source: true },
      orderBy: [{ autoPublishedAt: 'desc' }],
      take: 100,
    });

    let deleted = 0;
    let failed = 0;
    if (request.deleteMessages) {
      for (const post of posts) {
        if (!post.publishedMessageId) {
          failed += 1;
          continue;
        }
        try {
          const botId = await this.maxBotLinkService.resolveBotId({ chatId: post.chatId });
          await this.maxClient.deleteMessage(post.chatId, post.publishedMessageId, {
            immediate: true,
            botId,
            trafficClass: 'interactive',
            sourceTag: MAX_API_SOURCE_TAGS.VK_PARSING,
          });
          deleted += 1;
        } catch (error) {
          failed += 1;
          this.logger.warn({ postId: post.id, chatId, err: error }, 'VK rollback delete failed');
        }
      }
    }

    await this.writeAuditLog(chatId, actorUserId, 'VK_PARSING_ROLLBACK', {
      since: since.toISOString(),
      until: until.toISOString(),
      sourceId: request.sourceId ?? null,
      deleteMessages: request.deleteMessages,
      matched: posts.length,
      deleted,
      failed,
    });

    return rollbackVkParsingResultSchema.parse({
      matched: posts.length,
      deleted,
      failed,
      posts: posts.map((post) => this.feedService.mapPost(post)),
    });
  }

  async processPublishPostJob(params: {
    postId: string;
    chatId: string;
    reason: VkParsingPublishReason;
    idempotencyKey: string;
    attemptsMade?: number;
    maxAttempts?: number;
  }): Promise<void> {
    const now = new Date();
    const staleLockBefore = new Date(now.getTime() - this.publishLeaseTtlMs);
    const locked = await this.prisma.vkParsingPost.updateMany({
      where: {
        id: params.postId,
        chatId: params.chatId,
        publishIdempotencyKey: params.idempotencyKey,
        status: { notIn: [VK_POST_STATUS_PUBLISHED, VK_POST_STATUS_UNAVAILABLE] },
        OR: [{ publishLockedAt: null }, { publishLockedAt: { lt: staleLockBefore } }],
      },
      data: {
        publishLockedAt: now,
        publishReason: params.reason,
      },
    });
    if (locked.count === 0) {
      return;
    }

    const post = await this.prisma.vkParsingPost.findFirst({
      where: {
        id: params.postId,
        chatId: params.chatId,
        publishIdempotencyKey: params.idempotencyKey,
      },
      include: { source: true },
    });
    if (!post || post.status === VK_POST_STATUS_PUBLISHED) {
      return;
    }
    if (post.source.publishMode === VK_SOURCE_PUBLISH_MODE_REVIEW) {
      await this.clearQueuedAutoPublishPost(post.id, params.idempotencyKey);
      return;
    }

    try {
      if (params.reason === 'autopublish') {
        const governorDecision = await this.decideBackgroundAutoPublish();
        if (governorDecision?.action === 'pause') {
          await this.deferQueuedPost(
            post,
            params.reason,
            params.idempotencyKey,
            new Date(now.getTime() + governorDecision.retryAfterMs),
          );
          return;
        }
      }

      const settings = await this.getSettingsForChat(post.chatId);
      if (params.reason === 'autopublish') {
        if (!this.canAutoPublishPost(post, settings)) {
          await this.clearQueuedAutoPublishPost(post.id, params.idempotencyKey);
          return;
        }
        const deferredUntil = await this.resolveDeferredPublishAt(post, settings, now);
        if (deferredUntil.getTime() > now.getTime() + 1_000) {
          await this.deferQueuedPost(post, params.reason, params.idempotencyKey, deferredUntil);
          return;
        }
      }
      if (
        params.reason === 'manual-schedule' &&
        post.publishScheduledAt &&
        post.publishScheduledAt.getTime() > now.getTime() + 1_000
      ) {
        await this.deferQueuedPost(
          post,
          params.reason,
          params.idempotencyKey,
          post.publishScheduledAt,
        );
        return;
      }
      const attemptRecorded = await this.recordPublishAttempt(post.id, params.idempotencyKey);
      if (!attemptRecorded) {
        return;
      }
      await this.autoPublishPost(post, settings);
    } catch (error) {
      const classified = classifyVkParsingPublishError(error);
      await this.markQueuedPostPublishFailed(post, classified, {
        auto: params.reason === 'autopublish',
        finalAttempt: this.isFinalPublishAttempt(params),
      });
      throw error;
    }
  }

  async enqueueAutoPublishImportedPosts(
    chatId: string,
    posts: VkParsingPostWithSource[],
  ): Promise<void> {
    if (posts.length === 0) {
      return;
    }

    const settings = await this.getSettingsForChat(chatId);
    if (
      !settings.autoPublishEnabled ||
      !settings.autoPublishEnabledAt ||
      settings.autoPublishKillSwitchEnabled
    ) {
      return;
    }

    const queuedBySourceId = new Map<string, number>();
    for (const post of this.sortAutoPublishCandidates(posts)) {
      if (post.status !== VK_POST_STATUS_NEW) {
        continue;
      }
      if (!this.canAutoPublishPost(post, settings)) {
        continue;
      }
      if (post.source.publishMode === VK_SOURCE_PUBLISH_MODE_REVIEW) {
        continue;
      }
      const queuedForSource = queuedBySourceId.get(post.sourceId) ?? 0;
      const circuitOpen = await this.shouldOpenAutoPublishCircuit(
        post,
        settings,
        queuedForSource + 1,
      );
      if (circuitOpen) {
        await this.pauseSourceAutoPublishForCircuit(post.source, settings);
        queuedBySourceId.set(post.sourceId, 0);
        continue;
      }

      try {
        const scheduledAt = await this.resolveInitialAutoPublishAt(post, settings, queuedForSource);
        const queued = await this.enqueuePostPublish(post, 'autopublish', scheduledAt);
        queuedBySourceId.set(post.sourceId, queuedForSource + queued);
      } catch (error) {
        this.logger.warn(
          {
            postId: post.id,
            chatId: post.chatId,
            sourceId: post.sourceId,
            err: error,
          },
          'VK post autopublish enqueue failed',
        );
      }
    }
  }

  async clearQueuedAutoPublishForChat(chatId: string): Promise<void> {
    await this.prisma.vkParsingPost.updateMany({
      where: {
        chatId,
        status: { in: [VK_POST_STATUS_NEW, VK_POST_STATUS_FAILED] },
        OR: [
          { publishQueuedAt: { not: null } },
          { publishLockedAt: { not: null } },
          { publishIdempotencyKey: { not: null } },
          { publishReason: { not: null } },
          { publishScheduledAt: { not: null } },
        ],
      },
      data: {
        publishQueuedAt: null,
        publishLockedAt: null,
        publishIdempotencyKey: null,
        publishReason: null,
        publishScheduledAt: null,
      },
    });
  }

  async clearQueuedAutoPublishForSource(chatId: string, sourceId: string): Promise<void> {
    await this.clearQueuedAutoPublishForSources(chatId, [sourceId]);
  }

  async clearQueuedAutoPublishForSources(chatId: string, sourceIds: string[]): Promise<void> {
    const uniqueSourceIds = [...new Set(sourceIds.filter(Boolean))];
    if (uniqueSourceIds.length === 0) {
      return;
    }
    await this.prisma.vkParsingPost.updateMany({
      where: {
        chatId,
        sourceId: { in: uniqueSourceIds },
        status: { in: [VK_POST_STATUS_NEW, VK_POST_STATUS_FAILED] },
        OR: [
          { publishQueuedAt: { not: null } },
          { publishLockedAt: { not: null } },
          { publishIdempotencyKey: { not: null } },
          { publishReason: { not: null } },
          { publishScheduledAt: { not: null } },
        ],
      },
      data: {
        publishQueuedAt: null,
        publishLockedAt: null,
        publishIdempotencyKey: null,
        publishReason: null,
        publishScheduledAt: null,
      },
    });
  }

  private async publishPreparedPostToMax(
    post: VkParsingPostWithSource,
    payload: PreparedVkPublishPayload,
    params: {
      actorUserId: string;
      trafficClass: MaxApiTrafficClass;
      debugAction: string;
      auto: boolean;
    },
  ): Promise<PublishVkParsingPostResult> {
    const storedPhotoUrls = this.readStringArray(post.photoUrls);
    const storedLinkUrls = this.readStringArray(post.linkUrls);
    const botId = await this.maxBotLinkService.resolveBotId({ chatId: post.chatId });
    const entityType = await this.accessService.resolvePublicationEntityType(post.chatId);
    const requestOptions = {
      botId,
      trafficClass: params.trafficClass,
      sourceTag: MAX_API_SOURCE_TAGS.VK_PARSING,
    };
    const options: MaxSendMessageOptions = {
      debugContext: {
        screen: 'vk_parsing',
        action: params.debugAction,
      },
    };

    try {
      let engagementContext: Awaited<
        ReturnType<AdminService['buildChannelPublicationEngagementContext']>
      > | null = null;
      if (entityType === ChatEntityType.CHANNEL) {
        engagementContext = await this.adminService.buildChannelPublicationEngagementContext(
          post.chatId,
          botId,
        );
        if (engagementContext.buttons.length > 0) {
          options.buttons = engagementContext.buttons;
        }
      }

      const photoMediaByUrl = this.resolvePhotoMediaIdentityMap({
        attachments: post.attachments,
        raw: post.raw,
        text: post.text,
      });
      const imagePayloads = await this.downloadAndUploadImages(
        payload.photoUrls,
        requestOptions,
        {
          allowPartialFailures: params.auto,
          canPublishWithoutPhotos: payload.text.trim().length > 0 || payload.linkUrls.length > 0,
        },
        photoMediaByUrl,
      );

      if (imagePayloads.length === 1) {
        options.imagePayload = imagePayloads[0];
      } else if (imagePayloads.length > 1) {
        options.attachments = imagePayloads.map(
          (payload): MaxAttachmentPayload => ({
            type: 'image',
            payload,
          }),
        );
      }

      const result = await this.sendMessageWithAttachmentRetry(
        post.chatId,
        payload.text,
        options,
        requestOptions,
      );
      if (engagementContext) {
        await this.recordChannelPublicationEngagementSafely({
          chatId: post.chatId,
          actorUserId: params.actorUserId,
          messageId: result.messageId,
          text: payload.text,
          publishedUrl: result.url,
          engagementContext,
          botId,
        });
      }
      const updated = await this.prisma.vkParsingPost.update({
        where: { id: post.id },
        data: {
          status: VK_POST_STATUS_PUBLISHED,
          publishedContentHash:
            post.contentHash ||
            computeVkParsingPostContentHash({
              text: post.text,
              photoUrls: storedPhotoUrls,
              linkUrls: storedLinkUrls,
            }),
          publishedMessageId: result.messageId,
          publishedUrl: result.url,
          publishedAtMax: new Date(),
          autoPublishedAt: params.auto ? new Date() : post.autoPublishedAt,
          autoPublishError: null,
          publishQueuedAt: null,
          publishScheduledAt: null,
          publishCancelledAt: null,
          publishCancelledByUserId: null,
          publishLockedAt: null,
          publishIdempotencyKey: null,
          publishReason: null,
          skippedAt: null,
          skipReason: null,
          lastError: null,
        },
        include: { source: true },
      });
      if (params.auto) {
        await this.prisma.vkParsingSource.updateMany({
          where: { id: post.sourceId },
          data: { lastAutoPublishedAt: updated.autoPublishedAt ?? updated.publishedAtMax },
        });
      }

      return {
        post: this.feedService.mapPost(updated),
        messageId: result.messageId,
        url: result.url,
      };
    } catch (error) {
      const classified = classifyVkParsingPublishError(error);
      const formattedError = formatVkParsingClassifiedErrorMessage(classified);
      const accessLossResult =
        await this.managedEntityAccessLossService?.recordIfManagedEntityAccessLost?.({
          chatId: post.chatId,
          botId,
          entityType,
          source: 'vk_parsing:publish',
          operation: 'send',
          error,
        });
      await this.prisma.vkParsingPost.update({
        where: { id: post.id },
        data: {
          status: VK_POST_STATUS_FAILED,
          publishLockedAt: null,
          lastError: formattedError,
          autoPublishError: params.auto ? formattedError : post.autoPublishError,
          ...(params.auto
            ? {}
            : {
                publishQueuedAt: null,
                publishScheduledAt: null,
                publishIdempotencyKey: null,
                publishReason: null,
              }),
          ...(accessLossResult?.recorded
            ? {
                publishQueuedAt: null,
                publishScheduledAt: null,
                publishIdempotencyKey: null,
                publishReason: null,
              }
            : {}),
        },
      });
      throw error;
    }
  }

  private async recordChannelPublicationEngagementSafely(params: {
    chatId: string;
    actorUserId: string;
    messageId: string;
    text?: string | null;
    publishedUrl?: string | null;
    engagementContext: Awaited<
      ReturnType<AdminService['buildChannelPublicationEngagementContext']>
    >;
    botId?: string | null;
  }): Promise<void> {
    try {
      await this.adminService.recordChannelPublicationEngagement({
        chatId: params.chatId,
        actorUserId: params.actorUserId,
        messageId: params.messageId,
        text: params.text,
        publishedUrl: params.publishedUrl,
        context: params.engagementContext,
        source: 'vk_parsing',
        botId: params.botId,
      });
    } catch (error) {
      this.logger.warn(
        {
          chatId: params.chatId,
          messageId: params.messageId,
          err: error,
        },
        'Failed to record VK parsing channel engagement binding',
      );
    }
  }

  private async sendMessageWithAttachmentRetry(
    chatId: string,
    text: string,
    options: MaxSendMessageOptions,
    requestOptions: {
      botId?: string;
      trafficClass: MaxApiTrafficClass;
      sourceTag: string;
    },
  ): Promise<Awaited<ReturnType<MaxClientService['sendMessageImmediateWithResolvedLink']>>> {
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return await this.maxClient.sendMessageImmediateWithResolvedLink(
          chatId,
          text || ' ',
          options,
          requestOptions,
        );
      } catch (error) {
        lastError = error;
        if (!isMaxAttachmentNotReadyError(error) || attempt >= 3) {
          throw error;
        }
        await this.sleep(750 * 2 ** (attempt - 1));
      }
    }

    throw lastError instanceof Error ? lastError : new Error('MAX attachment is not ready.');
  }

  private async lockManualPublishPost(postId: string, chatId: string): Promise<boolean> {
    const locked = await this.prisma.vkParsingPost.updateMany({
      where: {
        id: postId,
        chatId,
        status: { notIn: [VK_POST_STATUS_PUBLISHED, VK_POST_STATUS_UNAVAILABLE] },
        publishLockedAt: null,
      },
      data: {
        publishLockedAt: new Date(),
        publishReason: 'manual-retry',
      },
    });
    return locked.count > 0;
  }

  private async enqueuePostPublish(
    post: VkParsingPostWithSource,
    reason: VkParsingPublishReason,
    scheduledAt: Date = new Date(),
  ): Promise<number> {
    const idempotencyKey = this.buildPublishIdempotencyKey(post, scheduledAt);
    const now = new Date();
    const queued = await this.prisma.vkParsingPost.updateMany({
      where: {
        id: post.id,
        publishLockedAt: null,
        status: { notIn: [VK_POST_STATUS_PUBLISHED, VK_POST_STATUS_UNAVAILABLE] },
        ...(reason === 'autopublish' ? { publishIdempotencyKey: null } : {}),
      },
      data: {
        status: post.status === VK_POST_STATUS_FAILED ? VK_POST_STATUS_NEW : post.status,
        publishQueuedAt: now,
        publishScheduledAt: scheduledAt,
        publishCancelledAt: null,
        publishCancelledByUserId: null,
        publishLockedAt: null,
        publishIdempotencyKey: idempotencyKey,
        publishReason: reason,
        lastError: null,
        autoPublishError: reason === 'autopublish' ? null : post.autoPublishError,
      },
    });
    if (queued.count === 0) {
      return 0;
    }

    await this.addPublishJob(post, reason, idempotencyKey, now, scheduledAt);

    return 1;
  }

  private async addPublishJob(
    post: Pick<VkParsingPostWithSource, 'id' | 'chatId'>,
    reason: VkParsingPublishReason,
    idempotencyKey: string,
    createdAt: Date,
    scheduledAt: Date | null = null,
  ): Promise<void> {
    const delay = scheduledAt ? Math.max(0, scheduledAt.getTime() - Date.now()) : 0;
    await this.publishQueue.add(
      VK_PUBLISH_JOB_NAME,
      {
        postId: post.id,
        chatId: post.chatId,
        reason,
        idempotencyKey,
        retryPolicyName: 'vk-parsing-publish',
        createdAt: createdAt.toISOString(),
      },
      {
        jobId: this.buildPublishJobId(post.id, idempotencyKey),
        delay,
        ...VK_PARSING_PUBLISH_RETRY_POLICY,
      },
    );
  }

  private sortAutoPublishCandidates(posts: VkParsingPostWithSource[]): VkParsingPostWithSource[] {
    const priorityRank = new Map([
      ['HIGH', 0],
      ['NORMAL', 1],
      ['LOW', 2],
    ]);
    return [...posts].sort((left, right) => {
      const byPriority =
        (priorityRank.get(left.source.priority) ?? 1) -
        (priorityRank.get(right.source.priority) ?? 1);
      if (byPriority !== 0) {
        return byPriority;
      }
      const leftTime = left.vkPublishedAt?.getTime() ?? left.createdAt.getTime();
      const rightTime = right.vkPublishedAt?.getTime() ?? right.createdAt.getTime();
      return leftTime - rightTime;
    });
  }

  private canAutoPublishPost(
    post: VkParsingPostWithSource,
    settings: VkParsingSettingsLike,
  ): boolean {
    if (
      !settings.autoPublishEnabled ||
      !settings.autoPublishEnabledAt ||
      settings.autoPublishKillSwitchEnabled
    ) {
      return false;
    }
    if (
      post.source.status !== VK_SOURCE_STATUS_ACTIVE ||
      post.source.importEnabled === false ||
      post.source.autoPublishEnabled === false ||
      post.source.publishMode === VK_SOURCE_PUBLISH_MODE_REVIEW
    ) {
      return false;
    }
    const baseline = this.resolveAutoPublishBaseline(settings, post.source);
    return baseline ? this.isPostEligibleForAutoPublish(post, baseline) : false;
  }

  private resolveAutoPublishBaseline(
    settings: VkParsingSettingsLike,
    source: Pick<VkParsingPostWithSource['source'], 'autoPublishEnabledAt'>,
  ): Date | null {
    const globalBaseline = settings.autoPublishEnabledAt;
    const sourceBaseline = source.autoPublishEnabledAt ?? globalBaseline;
    if (!globalBaseline || !sourceBaseline) {
      return null;
    }

    return globalBaseline.getTime() >= sourceBaseline.getTime() ? globalBaseline : sourceBaseline;
  }

  private async shouldOpenAutoPublishCircuit(
    post: VkParsingPostWithSource,
    settings: VkParsingSettingsLike,
    pendingInBatch: number,
  ): Promise<boolean> {
    if (!settings.circuitBreakerEnabled) {
      return false;
    }
    const windowMinutes = Math.max(1, settings.circuitBreakerWindowMinutes);
    const windowStart = new Date(Date.now() - windowMinutes * 60_000);
    const recent = await this.prisma.vkParsingPost.count({
      where: {
        chatId: post.chatId,
        sourceId: post.sourceId,
        OR: [
          { publishQueuedAt: { gte: windowStart }, publishReason: 'autopublish' },
          { autoPublishedAt: { gte: windowStart } },
        ],
      },
    });

    return (recent ?? 0) + pendingInBatch > settings.circuitBreakerPostLimit;
  }

  private async pauseSourceAutoPublishForCircuit(
    source: VkParsingPostWithSource['source'],
    settings: VkParsingSettingsLike,
  ): Promise<void> {
    const now = new Date();
    await this.prisma.vkParsingSource.update({
      where: { id: source.id },
      data: {
        autoPublishEnabled: false,
        autoPublishEnabledAt: null,
        autoPublishPausedAt: now,
        autoPublishPausedReason: 'circuit_breaker',
      },
    });
    await this.writeAuditLog(
      source.chatId,
      VK_PARSING_SYSTEM_ACTOR_USER_ID,
      'VK_PARSING_CIRCUIT_OPEN',
      {
        sourceId: source.id,
        windowMinutes: settings.circuitBreakerWindowMinutes,
        limit: settings.circuitBreakerPostLimit,
      },
    );
  }

  private async resolveInitialAutoPublishAt(
    post: VkParsingPostWithSource,
    settings: VkParsingSettingsLike,
    queuedForSource: number,
  ): Promise<Date> {
    const now = new Date();
    if (post.source.publishMode === VK_SOURCE_PUBLISH_MODE_IMMEDIATE) {
      return this.resolveAllowedScheduleAt(now, settings, post.source);
    }

    const latestQueued = await this.prisma.vkParsingPost.aggregate({
      where: {
        chatId: post.chatId,
        sourceId: post.sourceId,
        publishQueuedAt: { not: null },
        status: { in: [VK_POST_STATUS_NEW, VK_POST_STATUS_FAILED] },
      },
      _max: { publishScheduledAt: true },
    });
    const sourceLastAt =
      latestQueued?._max?.publishScheduledAt ??
      post.source.lastAutoPublishedAt ??
      post.source.autoPublishEnabledAt ??
      now;
    const publishIntervalMinutes =
      typeof post.source.publishIntervalMinutes === 'number' &&
      post.source.publishIntervalMinutes > 0
        ? post.source.publishIntervalMinutes
        : 60;
    const minPublishIntervalMinutes =
      typeof post.source.minPublishIntervalMinutes === 'number' &&
      post.source.minPublishIntervalMinutes >= 0
        ? post.source.minPublishIntervalMinutes
        : 30;
    const sourceSpacingMs = Math.max(
      5 * 60_000,
      Math.max(publishIntervalMinutes, minPublishIntervalMinutes) * 60_000,
    );
    const chatSpacingMs = settings.roundRobinEnabled ? 60_000 : 0;
    const latestChatQueued = settings.roundRobinEnabled
      ? await this.prisma.vkParsingPost.aggregate({
          where: {
            chatId: post.chatId,
            publishQueuedAt: { not: null },
            status: { in: [VK_POST_STATUS_NEW, VK_POST_STATUS_FAILED] },
          },
          _max: { publishScheduledAt: true },
        })
      : null;
    const baseMs = Math.max(
      now.getTime(),
      sourceLastAt.getTime() + sourceSpacingMs * Math.max(1, queuedForSource + 1),
      latestChatQueued?._max.publishScheduledAt
        ? latestChatQueued._max.publishScheduledAt.getTime() + chatSpacingMs
        : 0,
    );
    return this.resolveAllowedScheduleAt(new Date(baseMs), settings, post.source);
  }

  private async resolveDeferredPublishAt(
    post: VkParsingPostWithSource,
    settings: VkParsingSettingsLike,
    now: Date,
  ): Promise<Date> {
    let candidate =
      post.publishScheduledAt && post.publishScheduledAt > now ? post.publishScheduledAt : now;
    const dayStart = new Date(candidate);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60_000);
    const publishedToday = await this.prisma.vkParsingPost.count({
      where: {
        chatId: post.chatId,
        sourceId: post.sourceId,
        autoPublishedAt: { gte: dayStart, lt: dayEnd },
      },
    });
    const dailyLimit =
      typeof post.source.dailyLimit === 'number' && post.source.dailyLimit > 0
        ? post.source.dailyLimit
        : 3;
    if (publishedToday >= dailyLimit) {
      candidate = new Date(dayEnd.getTime() + 9 * 60 * 60_000);
    }
    const lastAutoPublishedAt = post.source.lastAutoPublishedAt;
    if (lastAutoPublishedAt) {
      const minPublishIntervalMinutes =
        typeof post.source.minPublishIntervalMinutes === 'number' &&
        post.source.minPublishIntervalMinutes >= 0
          ? post.source.minPublishIntervalMinutes
          : 30;
      const minNextAt = new Date(
        lastAutoPublishedAt.getTime() + minPublishIntervalMinutes * 60_000,
      );
      if (minNextAt > candidate) {
        candidate = minNextAt;
      }
    }

    return this.resolveAllowedScheduleAt(candidate, settings, post.source);
  }

  private async deferQueuedPost(
    post: VkParsingPostWithSource,
    reason: VkParsingPublishReason,
    currentIdempotencyKey: string,
    scheduledAt: Date,
  ): Promise<void> {
    const nextIdempotencyKey = this.buildPublishIdempotencyKey(post, scheduledAt);
    await this.prisma.vkParsingPost.updateMany({
      where: { id: post.id, publishIdempotencyKey: currentIdempotencyKey },
      data: {
        publishScheduledAt: scheduledAt,
        publishLockedAt: null,
        publishIdempotencyKey: nextIdempotencyKey,
        publishReason: reason,
      },
    });
    await this.addPublishJob(post, reason, nextIdempotencyKey, new Date(), scheduledAt);
  }

  private async recordPublishAttempt(postId: string, idempotencyKey: string): Promise<boolean> {
    const updated = await this.prisma.vkParsingPost.updateMany({
      where: { id: postId, publishIdempotencyKey: idempotencyKey },
      data: { publishAttemptCount: { increment: 1 } },
    });
    return updated.count > 0;
  }

  private resolveAllowedScheduleAt(
    candidate: Date,
    settings: VkParsingSettingsLike,
    source: Pick<VkParsingPostWithSource['source'], 'quietHoursStart' | 'quietHoursEnd'>,
  ): Date {
    let current = new Date(candidate);
    for (let index = 0; index < VK_PARSING_MAX_SCHEDULE_LOOKAHEAD_STEPS; index += 1) {
      if (this.isAllowedPublishTime(current, settings, source)) {
        return current;
      }
      current = new Date(current.getTime() + VK_PARSING_SCHEDULE_STEP_MS);
    }

    return candidate;
  }

  private isAllowedPublishTime(
    date: Date,
    settings: VkParsingSettingsLike,
    source: Pick<VkParsingPostWithSource['source'], 'quietHoursStart' | 'quietHoursEnd'>,
  ): boolean {
    const minute = this.getTimeOfDayMinute(date, settings.schedulerTimezone);
    return (
      this.isMinuteInsideRange(minute, settings.workHoursStart, settings.workHoursEnd) &&
      !this.isMinuteInsideOptionalRange(minute, settings.quietHoursStart, settings.quietHoursEnd) &&
      !this.isMinuteInsideOptionalRange(minute, source.quietHoursStart, source.quietHoursEnd)
    );
  }

  private isMinuteInsideOptionalRange(
    minute: number,
    start: string | null,
    end: string | null,
  ): boolean {
    return Boolean(start && end && this.isMinuteInsideRange(minute, start, end));
  }

  private isMinuteInsideRange(minute: number, start: string, end: string): boolean {
    const startMinute = this.parseTimeOfDay(start);
    const endMinute = this.parseTimeOfDay(end);
    if (startMinute === endMinute) {
      return true;
    }
    if (startMinute < endMinute) {
      return minute >= startMinute && minute < endMinute;
    }
    return minute >= startMinute || minute < endMinute;
  }

  private parseTimeOfDay(value: string): number {
    const [hoursRaw, minutesRaw] = value.split(':');
    const hours = Number(hoursRaw);
    const minutes = Number(minutesRaw);
    if (!Number.isFinite(hours) || !Number.isFinite(minutes)) {
      return 0;
    }
    return (
      Math.max(0, Math.min(23, Math.trunc(hours))) * 60 +
      Math.max(0, Math.min(59, Math.trunc(minutes)))
    );
  }

  private getTimeOfDayMinute(date: Date, timeZone: string): number {
    try {
      const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone,
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).formatToParts(date);
      const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? 0);
      const minute = Number(parts.find((part) => part.type === 'minute')?.value ?? 0);
      return hour * 60 + minute;
    } catch {
      return date.getHours() * 60 + date.getMinutes();
    }
  }

  private async findSchedulablePost(
    chatId: string,
    postId: string,
  ): Promise<VkParsingPostWithSource> {
    const post = await this.prisma.vkParsingPost.findFirst({
      where: { id: postId, chatId },
      include: { source: true },
    });
    if (!post) {
      throw new NotFoundException('VK-пост не найден.');
    }
    if (post.status === VK_POST_STATUS_PUBLISHED) {
      throw new BadRequestException('Этот VK-пост уже опубликован.');
    }
    if (post.status === VK_POST_STATUS_UNAVAILABLE) {
      throw new BadRequestException('VK-пост недоступен в исходном источнике.');
    }
    return post;
  }

  private assertReviewSourceOwnerAction(
    post: VkParsingPostWithSource,
    actorUserId: string | null,
  ): void {
    if (
      post.source.publishMode === VK_SOURCE_PUBLISH_MODE_REVIEW &&
      actorUserId !== SAFETY_DESK_ACTOR_USER_ID
    ) {
      throw new BadRequestException('Публикация этого источника доступна только через Safety Desk.');
    }
  }

  private resolvePhotoMediaIdentityMap(post: {
    attachments: Prisma.JsonValue | unknown;
    raw: Prisma.JsonValue | unknown;
    text: string;
  }): Map<string, VkParsingPhotoPublishMedia> {
    const parsed = parseVkWallPostAttachments({
      attachments: this.readAttachments(post.attachments),
      rawPost: this.asRecord(post.raw) ?? {},
      text: post.text,
      maxPhotos: VK_PARSING_MAX_PHOTOS,
      maxLinks: VK_PARSING_MAX_LINKS,
    });
    return new Map(
      parsed.photoMedia.map(({ url, mediaIdentity, candidateUrls }) => [
        url,
        {
          mediaIdentity,
          candidateUrls,
        },
      ]),
    );
  }

  private async autoPublishPost(
    post: VkParsingPostWithSource,
    settings: VkParsingSettingsLike,
  ): Promise<void> {
    const photoUrls = this.readStringArray(post.photoUrls);
    const linkUrls = this.readStringArray(post.linkUrls);
    const skipReason = resolveVkParsingPostSkipReason(
      {
        text: post.text,
        photoUrls,
        linkUrls,
        attachments: this.readAttachments(post.attachments),
        raw: this.asRecord(post.raw) ?? {},
        isAdvertising: post.isAdvertising,
        advertisingMarkers: this.readStringArray(post.advertisingMarkers),
      },
      settings,
    );
    if (skipReason) {
      await this.markPostSkipped(post.id, skipReason);
      return;
    }

    const prepared = prepareVkParsingPublishPayload(
      {
        text: post.text,
        photoUrls,
        linkUrls,
      },
      settings,
    );
    if (this.isEmptyPublishPayload(prepared)) {
      await this.markPostSkipped(post.id, VK_POST_SKIP_REASON_NO_SUPPORTED_CONTENT);
      return;
    }
    this.assertPreparedPublishPayload(prepared);

    await this.publishPreparedPostToMax(post, prepared, {
      actorUserId: VK_PARSING_SYSTEM_ACTOR_USER_ID,
      trafficClass: 'background',
      debugAction: 'auto_publish_post',
      auto: true,
    });
  }

  private async decideBackgroundAutoPublish(): Promise<BackgroundRuntimeGovernorDecision | null> {
    if (!this.backgroundRuntimeGovernorService) {
      return null;
    }

    try {
      return await this.backgroundRuntimeGovernorService.decide({
        component: 'vk_parsing_autopublish',
        sourceTag: MAX_API_SOURCE_TAGS.VK_PARSING,
      });
    } catch (error) {
      this.logger.warn({ err: error }, 'VK autopublish governor check failed');
      return null;
    }
  }

  private async markQueuedPostPublishFailed(
    post: Pick<VkParsingPostWithSource, 'id' | 'autoPublishError'>,
    error: ReturnType<typeof classifyVkParsingPublishError>,
    options: { auto: boolean; finalAttempt: boolean },
  ): Promise<void> {
    const message = formatVkParsingClassifiedErrorMessage(error);
    const shouldClearQueue = !error.retryable || options.finalAttempt;
    await this.prisma.vkParsingPost.update({
      where: { id: post.id },
      data: {
        status: VK_POST_STATUS_FAILED,
        lastError: message,
        autoPublishError: options.auto ? message : post.autoPublishError,
        publishLockedAt: null,
        ...(shouldClearQueue
          ? {
              publishQueuedAt: null,
              publishScheduledAt: null,
              publishIdempotencyKey: null,
              publishReason: null,
            }
          : {}),
      },
    });
  }

  private isFinalPublishAttempt(params: { attemptsMade?: number; maxAttempts?: number }): boolean {
    const maxAttempts =
      typeof params.maxAttempts === 'number' && params.maxAttempts > 0
        ? Math.trunc(params.maxAttempts)
        : VK_PARSING_PUBLISH_RETRY_POLICY.attempts;
    const attemptsMade =
      typeof params.attemptsMade === 'number' && params.attemptsMade > 0
        ? Math.trunc(params.attemptsMade)
        : 0;
    return attemptsMade + 1 >= maxAttempts;
  }

  private isPostEligibleForAutoPublish(
    post: Pick<VkParsingPostWithSource, 'createdAt' | 'vkPublishedAt'>,
    enabledAt: Date,
  ): boolean {
    if (!post.vkPublishedAt) {
      return false;
    }
    if (post.createdAt.getTime() < enabledAt.getTime()) {
      return false;
    }

    return post.vkPublishedAt.getTime() >= enabledAt.getTime();
  }

  private async clearQueuedAutoPublishPost(
    postId: string,
    idempotencyKey?: string | null,
  ): Promise<void> {
    await this.prisma.vkParsingPost.updateMany({
      where: {
        id: postId,
        ...(idempotencyKey ? { publishIdempotencyKey: idempotencyKey } : {}),
      },
      data: {
        publishQueuedAt: null,
        publishScheduledAt: null,
        publishLockedAt: null,
        publishIdempotencyKey: null,
        publishReason: null,
      },
    });
  }

  private buildPublishJobId(postId: string, idempotencyKey: string): string {
    return `vk-parsing-publish__${postId}__${idempotencyKey}`;
  }

  private resolveRecoveredPublishReason(reason: string | null | undefined): VkParsingPublishReason {
    if (reason === 'manual-retry' || reason === 'manual-schedule') {
      return reason;
    }
    return 'autopublish';
  }

  private buildPublishIdempotencyKey(post: VkParsingPostWithSource, scheduledAt: Date): string {
    return createHash('sha256')
      .update(
        JSON.stringify({
          postId: post.id,
          chatId: post.chatId,
          contentHash: post.contentHash,
          status: post.status,
          scheduledAt: scheduledAt.toISOString(),
        }),
      )
      .digest('hex')
      .slice(0, 32);
  }

  private async downloadAndUploadImages(
    photoUrls: string[],
    requestOptions: {
      botId?: string;
      trafficClass: MaxApiTrafficClass;
      sourceTag: string;
    },
    options: {
      allowPartialFailures?: boolean;
      canPublishWithoutPhotos?: boolean;
    } = {},
    photoMediaByUrl: Map<string, VkParsingPhotoPublishMedia> = new Map(),
  ): Promise<Record<string, unknown>[]> {
    const payloads = new Array<Record<string, unknown> | null>(photoUrls.length).fill(null);
    const skippedErrors: string[] = [];
    const uploadConcurrency =
      requestOptions.trafficClass === 'background' ? 1 : this.mediaConcurrency;
    await this.mapWithConcurrency(photoUrls, uploadConcurrency, async (url, index) => {
      try {
        const media = photoMediaByUrl.get(url) ?? null;
        payloads[index] = await this.resolveUploadPayloadForMedia(
          url,
          index,
          requestOptions,
          media,
        );
      } catch (error) {
        const message = `Фото ${index + 1}: ${this.formatError(error)}`;
        if (!options.allowPartialFailures || !this.isSkippablePhotoPublishFailure(message)) {
          throw new BadRequestException(message);
        }
        skippedErrors.push(message);
      }
    });

    const uploadedPayloads = payloads.filter(
      (payload): payload is Record<string, unknown> => payload !== null,
    );
    if (
      photoUrls.length > 0 &&
      uploadedPayloads.length === 0 &&
      skippedErrors.length > 0 &&
      !options.canPublishWithoutPhotos
    ) {
      throw new BadRequestException(skippedErrors[0]);
    }

    return uploadedPayloads;
  }

  private async resolveUploadPayloadForMedia(
    imageUrl: string,
    index: number,
    requestOptions: {
      botId?: string;
      trafficClass: MaxApiTrafficClass;
      sourceTag: string;
    },
    media: VkParsingPhotoPublishMedia | null,
  ): Promise<Record<string, unknown>> {
    const mediaIdentity = media?.mediaIdentity ?? null;
    const candidateUrls = this.resolvePhotoCandidateUrls(imageUrl, media?.candidateUrls ?? []);
    let lastError: unknown = null;

    for (const candidateUrl of candidateUrls) {
      try {
        const cache = await this.assertMediaReadyForPublish(candidateUrl, index, mediaIdentity);
        const cachedPayload = this.readUploadPayload(cache);
        if (cachedPayload) {
          return cachedPayload;
        }

        const image = await this.downloadImage(candidateUrl, index);
        const payload = await this.maxClient.uploadImage(
          image.buffer,
          image.fileName,
          image.mimeType,
          requestOptions,
        );
        await this.mediaCache.writeMediaCache(
          candidateUrl,
          {
            status: VK_MEDIA_STATUS_READY,
            mimeType: image.mimeType,
            contentLength: image.buffer.length,
            lastError: null,
            maxUploadPayload: payload,
            maxUploadToken: this.readUploadToken(payload),
            maxUploadedAt: new Date(),
          },
          mediaIdentity,
        );

        return payload;
      } catch (error) {
        lastError = error;
        if (!this.shouldTryNextPhotoCandidate(error)) {
          throw error;
        }
        await this.rememberPhotoCandidateFailure(candidateUrl, mediaIdentity, error);
      }
    }

    throw lastError instanceof Error ? lastError : new BadRequestException('Фото недоступно.');
  }

  private resolvePhotoCandidateUrls(primaryUrl: string, candidateUrls: string[]): string[] {
    return [
      ...new Set([primaryUrl, ...candidateUrls].map((url) => url.trim()).filter(Boolean)),
    ];
  }

  private shouldTryNextPhotoCandidate(error: unknown): boolean {
    return this.isSkippablePhotoPublishFailure(this.formatError(error));
  }

  private async assertMediaReadyForPublish(
    imageUrl: string,
    index: number,
    mediaIdentity: string | null = null,
  ): Promise<VkParsingMediaCacheRow> {
    const cache = await this.mediaCache.preflightMediaUrl(imageUrl, mediaIdentity);
    if (this.readUploadPayload(cache)) {
      return cache;
    }
    if (cache.status === VK_MEDIA_STATUS_FAILED) {
      throw new BadRequestException(cache.lastError || `Фото ${index + 1} недоступно.`);
    }
    return cache;
  }

  private async rememberPhotoCandidateFailure(
    imageUrl: string,
    mediaIdentity: string | null,
    error: unknown,
  ): Promise<void> {
    try {
      await this.mediaCache.writeMediaCache(
        imageUrl,
        {
          status: VK_MEDIA_STATUS_FAILED,
          lastError: this.formatError(error),
        },
        mediaIdentity,
      );
    } catch (cacheError) {
      this.logger.warn(
        { err: cacheError, imageUrl, mediaIdentity },
        'Failed to record stale VK photo candidate',
      );
    }
  }

  private readUploadPayload(cache: VkParsingMediaCacheRow): Record<string, unknown> | null {
    const payload = this.asRecord(cache.maxUploadPayload);
    if (!payload || Object.keys(payload).length === 0) {
      return null;
    }

    return payload;
  }

  private readUploadToken(payload: Record<string, unknown>): string | null {
    const token = this.readString(payload.token);
    return token || null;
  }

  private async downloadImage(
    imageUrl: string,
    index: number,
  ): Promise<{ buffer: Buffer; fileName: string; mimeType: string }> {
    const parsed = new URL(imageUrl);
    if (parsed.protocol !== 'https:') {
      throw new BadRequestException('Фото VK должно быть доступно по HTTPS.');
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), VK_IMAGE_FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(parsed, { signal: controller.signal });
      if (!response.ok) {
        throw new BadRequestException('Не удалось скачать фото из VK.');
      }

      const headers = response.headers ?? new Headers();
      const contentLength = Number(headers.get('content-length') ?? 0);
      if (contentLength > VK_IMAGE_MAX_BYTES) {
        throw new BadRequestException('Фото из VK слишком большое.');
      }

      const mimeType = (headers.get('content-type') ?? 'image/jpeg').split(';')[0]!.trim();
      if (!mimeType.toLowerCase().startsWith('image/')) {
        throw new BadRequestException('VK вернул не изображение.');
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length > VK_IMAGE_MAX_BYTES) {
        throw new BadRequestException('Фото из VK слишком большое.');
      }

      return {
        buffer,
        fileName: this.resolveImageFileName(parsed, index),
        mimeType,
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  private resolveImageFileName(url: URL, index: number): string {
    const rawName = decodeURIComponent(url.pathname.split('/').filter(Boolean).at(-1) ?? '');
    const safeName = rawName.replace(/[^A-Za-z0-9._-]/gu, '').slice(0, 120);
    if (safeName && /\.[A-Za-z0-9]{2,6}$/u.test(safeName)) {
      return safeName;
    }

    return `vk-photo-${index + 1}.jpg`;
  }

  private assertPreparedPublishPayload(payload: PreparedVkPublishPayload): void {
    if (this.isEmptyPublishPayload(payload)) {
      throw new BadRequestException(
        'После фильтрации в посте не осталось текста, фото или ссылок.',
      );
    }
    if (payload.text.length > VK_PARSING_MAX_PUBLISH_TEXT_LENGTH) {
      throw new BadRequestException(
        `Текст публикации слишком длинный. Максимум ${VK_PARSING_MAX_PUBLISH_TEXT_LENGTH} символов.`,
      );
    }
  }

  private isEmptyPublishPayload(payload: PreparedVkPublishPayload): boolean {
    return (
      payload.text.trim().length === 0 &&
      payload.photoUrls.length === 0 &&
      payload.linkUrls.length === 0
    );
  }

  private isSkippablePhotoPublishFailure(message: string): boolean {
    const normalized = message.toLowerCase();
    if (
      normalized.includes('rate limit exceeded') ||
      normalized.includes('circuit breaker') ||
      normalized.includes('max api')
    ) {
      return false;
    }

    return (
      normalized.includes('vk вернул статус') ||
      normalized.includes('не удалось скачать фото') ||
      normalized.includes('fetch failed') ||
      normalized.includes('terminated') ||
      normalized.includes('operation was aborted') ||
      normalized.includes('фото vk должно быть доступно по https') ||
      normalized.includes('некорректная ссылка на фото vk') ||
      normalized.includes('фото из vk слишком большое') ||
      normalized.includes('vk вернул не изображение') ||
      normalized.includes('vk не ответил')
    );
  }

  private async markPostSkipped(postId: string, reason: VkParsingSkipReason): Promise<void> {
    await this.prisma.vkParsingPost.update({
      where: { id: postId },
      data: {
        status: VK_POST_STATUS_SKIPPED,
        skippedAt: new Date(),
        skipReason: reason,
        autoPublishError: null,
        lastError: describeVkParsingSkipReason(reason),
        publishLockedAt: null,
        publishQueuedAt: null,
        publishScheduledAt: null,
        publishIdempotencyKey: null,
        publishReason: null,
      },
    });
  }

  private assertSelectedUrls(selected: string[], stored: string[], label: string): string[] {
    const storedSet = new Set(stored);
    const normalized = [...new Set(selected.map((url) => url.trim()).filter(Boolean))];
    const forbidden = normalized.find((url) => !storedSet.has(url));
    if (forbidden) {
      throw new BadRequestException(`Нельзя опубликовать неизвестную ${label}.`);
    }

    return normalized;
  }

  private async mapWithConcurrency<T>(
    items: T[],
    concurrency: number,
    worker: (item: T, index: number) => Promise<void>,
  ): Promise<void> {
    const workerCount = Math.max(1, Math.min(concurrency, items.length));
    let nextIndex = 0;
    await Promise.all(
      Array.from({ length: workerCount }, async () => {
        while (nextIndex < items.length) {
          const index = nextIndex;
          nextIndex += 1;
          await worker(items[index]!, index);
        }
      }),
    );
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
        payload: this.toJsonInput(payload),
      },
    });
  }

  private toJsonInput(value: unknown): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(value ?? null)) as Prisma.InputJsonValue;
  }

  private getDefaultSettings(chatId: string): VkParsingSettingsLike {
    return {
      chatId,
      autoPublishEnabled: false,
      autoPublishEnabledAt: null,
      autoPublishKillSwitchEnabled: false,
      stripLinksEnabled: false,
      skipAdsEnabled: false,
      schedulerTimezone: 'Europe/Moscow',
      quietHoursStart: null,
      quietHoursEnd: null,
      workHoursStart: '09:00',
      workHoursEnd: '22:00',
      distributeEvenlyEnabled: true,
      roundRobinEnabled: true,
      circuitBreakerEnabled: true,
      circuitBreakerWindowMinutes: 10,
      circuitBreakerPostLimit: 10,
      updatedAt: null,
    };
  }

  private async getSettingsForChat(chatId: string): Promise<VkParsingSettingsLike> {
    const settings = await this.prisma.vkParsingSettings.findUnique({ where: { chatId } });
    const defaults = this.getDefaultSettings(chatId);
    const legacySchedulerDefaults =
      settings && !Object.prototype.hasOwnProperty.call(settings, 'workHoursStart')
        ? { workHoursStart: '00:00', workHoursEnd: '00:00' }
        : {};
    return {
      ...defaults,
      ...legacySchedulerDefaults,
      ...(settings ?? {}),
    };
  }

  private readStringArray(value: Prisma.JsonValue | unknown): string[] {
    if (!Array.isArray(value)) {
      return [];
    }

    return value.filter((item): item is string => typeof item === 'string' && item.length > 0);
  }

  private readAttachments(value: unknown): Array<Record<string, unknown>> {
    if (!Array.isArray(value)) {
      return [];
    }

    return value
      .map((item) => this.asRecord(item))
      .filter((item): item is Record<string, unknown> => item !== null);
  }

  private asRecord(value: unknown): Record<string, unknown> | null {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  }

  private readString(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private formatError(error: unknown): string {
    return formatVkParsingError(error);
  }
}
