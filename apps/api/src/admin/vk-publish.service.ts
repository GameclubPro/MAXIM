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
import { isAmbiguousMaxSendError } from '../max/max-send-ambiguity.util';
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

type VkParsingVideoPublishMedia = {
  mediaIdentity: string | null;
  candidateUrls: string[];
};

type VkParsingDownloadedMedia = {
  buffer: Buffer;
  fileName: string;
  mimeType: string;
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
const VK_VIDEO_MAX_BYTES = 250 * 1024 * 1024;
const VK_VIDEO_FETCH_TIMEOUT_MS = 60_000;
const VK_VIDEO_UPLOAD_TIMEOUT_MS = 120_000;
const VK_SUPPORTED_VIDEO_MIME_TYPES = new Set(['video/mp4', 'video/quicktime', 'video/webm']);

@Injectable()
export class VkPublishService {
  private readonly logger = new Logger(VkPublishService.name);
  private readonly queueBatchSize: number;
  private readonly publishLeaseTtlMs: number;
  private readonly mediaConcurrency: number;
  private readonly videoFailedPreflightTtlMs: number;

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
    this.videoFailedPreflightTtlMs = Math.min(
      configService.get<number>('VK_PARSING_MEDIA_PREFLIGHT_TTL_MS') ?? 86_400_000,
      configService.get<number>('VK_PARSING_MEDIA_FAILED_PREFLIGHT_TTL_MS') ?? 120_000,
    );
  }

  async recoverStalePublishJobs(): Promise<number> {
    const now = new Date();
    const staleLockBefore = new Date(now.getTime() - this.publishLeaseTtlMs);
    const posts = await this.findRecoverableStalePublishPosts(now, staleLockBefore);
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

      const queued = await this.addPublishJob(
        post,
        reason,
        idempotencyKey,
        now,
        post.publishScheduledAt,
      );
      if (queued) {
        recovered += 1;
      }
    }

    return recovered;
  }

  private async findRecoverableStalePublishPosts(
    now: Date,
    staleLockBefore: Date,
  ): Promise<VkParsingPostWithSource[]> {
    const baseWhere = {
      publishQueuedAt: { not: null },
      publishIdempotencyKey: { not: null },
      status: { in: [VK_POST_STATUS_NEW, VK_POST_STATUS_FAILED] },
      OR: [{ publishLockedAt: null }, { publishLockedAt: { lt: staleLockBefore } }],
    };
    const duePosts = await this.prisma.vkParsingPost.findMany({
      where: {
        ...baseWhere,
        AND: [
          {
            OR: [{ publishScheduledAt: null }, { publishScheduledAt: { lte: now } }],
          },
        ],
      },
      include: { source: true },
      orderBy: [{ publishScheduledAt: 'asc' }, { publishQueuedAt: 'asc' }, { updatedAt: 'asc' }],
      take: this.queueBatchSize,
    });
    if (duePosts.length >= this.queueBatchSize) {
      return duePosts;
    }

    const futurePosts = await this.prisma.vkParsingPost.findMany({
      where: {
        ...baseWhere,
        publishScheduledAt: { gt: now },
      },
      include: { source: true },
      orderBy: [{ publishScheduledAt: 'asc' }, { publishQueuedAt: 'asc' }, { updatedAt: 'asc' }],
      take: this.queueBatchSize - duePosts.length,
    });
    if (futurePosts.length === 0) {
      return duePosts;
    }

    return [...duePosts, ...futurePosts];
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
    const storedVideoUrls = this.readStringArray(post.videoUrls);
    const storedLinkUrls = this.readStringArray(post.linkUrls);
    const photoUrls = this.assertSelectedUrls(parsed.data.photoUrls, storedPhotoUrls, 'фото');
    const videoUrls = this.assertSelectedUrls(parsed.data.videoUrls, storedVideoUrls, 'видео');
    const linkUrls = this.assertSelectedUrls(parsed.data.linkUrls, storedLinkUrls, 'ссылку');
    const settings = await this.getSettingsForChat(chatId);
    const preservedLinkUrls = this.resolveStripPreservedLinkUrls(post);
    const prepared = prepareVkParsingPublishPayload(
      {
        text: parsed.data.text,
        photoUrls,
        videoUrls,
        linkUrls,
      },
      settings,
      { preserveLinkUrls: preservedLinkUrls },
    );
    const skipReason = resolveVkParsingPostSkipReason(
      {
        text: post.text,
        photoUrls: storedPhotoUrls,
        videoUrls: storedVideoUrls,
        linkUrls: storedLinkUrls,
        attachments: this.readAttachments(post.attachments),
        raw: this.asRecord(post.raw) ?? {},
        isAdvertising: post.isAdvertising,
        advertisingMarkers: this.readStringArray(post.advertisingMarkers),
      },
      settings,
      { preserveLinkUrls: preservedLinkUrls },
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
    const cancelled = await this.prisma.vkParsingPost.updateMany({
      where: {
        id: post.id,
        chatId,
        status: { notIn: [VK_POST_STATUS_PUBLISHED, VK_POST_STATUS_UNAVAILABLE] },
        publishScheduledAt: post.publishScheduledAt,
        publishIdempotencyKey: post.publishIdempotencyKey,
        publishCancelledAt: post.publishCancelledAt,
        publishLockedAt: null,
      },
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
    if (cancelled.count === 0) {
      throw new BadRequestException('Этот VK-пост уже нельзя отменить.');
    }
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
          const botId = await this.maxBotLinkService.resolveBotIdForModerationAction({
            chatId: post.chatId,
            action: 'delete_message',
          });
          if (!botId) {
            throw new Error('No bot with delete_message access is available for VK rollback');
          }
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
    const storedVideoUrls = this.readStringArray(post.videoUrls);
    const storedLinkUrls = this.readStringArray(post.linkUrls);
    const botId = await this.maxBotLinkService.resolveBotIdForSend({ chatId: post.chatId });
    if (!botId) {
      throw new Error('No bot with send access is available for VK publish');
    }
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

    let maxSendAttempted = false;
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
      if (payload.videoUrls.length > 0) {
        const videoMediaByUrl = this.resolveVideoMediaIdentityMap({
          attachments: post.attachments,
          raw: post.raw,
          text: post.text,
        });
        const videoPayload = await this.downloadAndUploadVideo(
          payload.videoUrls[0]!,
          requestOptions,
          videoMediaByUrl.get(payload.videoUrls[0]!) ?? null,
        );
        options.attachments = [{ type: 'video', payload: videoPayload }];
      } else {
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
      }

      const result = await this.sendMessageWithAttachmentRetry(
        post.chatId,
        payload.text,
        options,
        requestOptions,
        () => {
          maxSendAttempted = true;
        },
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
      const publishedAtMax = new Date();
      const publishedContentHash =
        post.contentHash ||
        computeVkParsingPostContentHash({
          text: post.text,
          photoUrls: storedPhotoUrls,
          videoUrls: storedVideoUrls,
          linkUrls: storedLinkUrls,
        });
      const publishedPost = {
        ...post,
        status: VK_POST_STATUS_PUBLISHED,
        publishedContentHash,
        publishedMessageId: result.messageId,
        publishedUrl: result.url,
        publishedAtMax,
        autoPublishedAt: params.auto ? publishedAtMax : post.autoPublishedAt,
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
      };
      const updated = await this.prisma.vkParsingPost.updateMany({
        where: {
          id: post.id,
          status: { notIn: [VK_POST_STATUS_PUBLISHED, VK_POST_STATUS_UNAVAILABLE] },
        },
        data: {
          status: VK_POST_STATUS_PUBLISHED,
          publishedContentHash,
          publishedMessageId: result.messageId,
          publishedUrl: result.url,
          publishedAtMax,
          autoPublishedAt: publishedPost.autoPublishedAt,
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
      });
      if (updated.count === 0) {
        this.logger.warn(
          {
            postId: post.id,
            chatId: post.chatId,
            messageId: result.messageId,
          },
          'VK parsing post disappeared before publish persistence',
        );
      }
      if (params.auto) {
        await this.prisma.vkParsingSource.updateMany({
          where: { id: post.sourceId },
          data: {
            lastAutoPublishedAt: publishedPost.autoPublishedAt ?? publishedPost.publishedAtMax,
          },
        });
      }

      return {
        post: this.feedService.mapPost(publishedPost),
        messageId: result.messageId,
        url: result.url,
      };
    } catch (error) {
      const classified = classifyVkParsingPublishError(error);
      const formattedError = formatVkParsingClassifiedErrorMessage(classified);
      const ambiguousAutopublishSend =
        params.auto && maxSendAttempted && isAmbiguousMaxSendError(error);
      const persistedError = ambiguousAutopublishSend
        ? `[max.send_ambiguous] ${formattedError}. Delivery may have been accepted by MAX; autopublish retry is quarantined for manual verification.`.slice(
            0,
            500,
          )
        : formattedError;
      const accessLossResult =
        await this.managedEntityAccessLossService?.recordIfManagedEntityAccessLost?.({
          chatId: post.chatId,
          botId,
          entityType,
          source: 'vk_parsing:publish',
          operation: 'send',
          error,
        });
      const failed = await this.prisma.vkParsingPost.updateMany({
        where: {
          id: post.id,
          status: { notIn: [VK_POST_STATUS_PUBLISHED, VK_POST_STATUS_UNAVAILABLE] },
        },
        data: {
          status: VK_POST_STATUS_FAILED,
          publishLockedAt: null,
          lastError: persistedError,
          autoPublishError: params.auto ? persistedError : post.autoPublishError,
          ...(params.auto
            ? ambiguousAutopublishSend
              ? {
                  publishQueuedAt: null,
                  publishScheduledAt: null,
                  publishIdempotencyKey: null,
                  publishReason: null,
                }
              : {}
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
      if (failed.count === 0) {
        this.logger.warn(
          { postId: post.id, chatId: post.chatId, err: error },
          'VK parsing post disappeared before publish failure persistence',
        );
      }
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
    onAttempt?: () => void,
  ): Promise<Awaited<ReturnType<MaxClientService['sendMessageImmediateWithResolvedLink']>>> {
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        onAttempt?.();
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
  ): Promise<boolean> {
    const delay = scheduledAt ? Math.max(0, scheduledAt.getTime() - Date.now()) : 0;
    const job = this.buildPublishJob(post, reason, idempotencyKey, createdAt);
    const jobId = this.buildPublishJobId(post.id, idempotencyKey);
    const recovered = await this.recoverExistingPublishJob(jobId, job);
    if (recovered !== null) {
      return recovered;
    }

    await this.publishQueue.add(
      VK_PUBLISH_JOB_NAME,
      job,
      {
        jobId,
        delay,
        ...VK_PARSING_PUBLISH_RETRY_POLICY,
      },
    );
    return true;
  }

  private buildPublishJob(
    post: Pick<VkParsingPostWithSource, 'id' | 'chatId'>,
    reason: VkParsingPublishReason,
    idempotencyKey: string,
    createdAt: Date,
  ): VkParsingPublishJob {
    return {
      postId: post.id,
      chatId: post.chatId,
      reason,
      idempotencyKey,
      retryPolicyName: 'vk-parsing-publish',
      createdAt: createdAt.toISOString(),
    };
  }

  private async recoverExistingPublishJob(
    jobId: string,
    job: VkParsingPublishJob,
  ): Promise<boolean | null> {
    try {
      const existingJob = await this.publishQueue.getJob(jobId);
      if (!existingJob) {
        return null;
      }

      const state = await existingJob.getState();
      if (state === 'failed' || state === 'completed') {
        await existingJob.updateData(job);
        await existingJob.retry(state, {
          resetAttemptsMade: true,
          resetAttemptsStarted: true,
        });
      }

      return true;
    } catch (error: unknown) {
      this.logger.warn(
        {
          jobId,
          postId: job.postId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to recover VK parsing publish job',
      );
      return false;
    }
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
      post.source.autoPublishPausedAt !== null ||
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

  private resolveVideoMediaIdentityMap(post: {
    attachments: Prisma.JsonValue | unknown;
    raw: Prisma.JsonValue | unknown;
    text: string;
  }): Map<string, VkParsingVideoPublishMedia> {
    const parsed = parseVkWallPostAttachments({
      attachments: this.readAttachments(post.attachments),
      rawPost: this.asRecord(post.raw) ?? {},
      text: post.text,
      maxPhotos: VK_PARSING_MAX_PHOTOS,
      maxLinks: VK_PARSING_MAX_LINKS,
    });
    return new Map(
      parsed.videoMedia.map(({ url, mediaIdentity, candidateUrls }) => [
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
    const videoUrls = this.readStringArray(post.videoUrls);
    const linkUrls = this.readStringArray(post.linkUrls);
    const preservedLinkUrls = this.resolveStripPreservedLinkUrls(post);
    const skipReason = resolveVkParsingPostSkipReason(
      {
        text: post.text,
        photoUrls,
        videoUrls,
        linkUrls,
        attachments: this.readAttachments(post.attachments),
        raw: this.asRecord(post.raw) ?? {},
        isAdvertising: post.isAdvertising,
        advertisingMarkers: this.readStringArray(post.advertisingMarkers),
      },
      settings,
      { preserveLinkUrls: preservedLinkUrls },
    );
    if (skipReason) {
      await this.markPostSkipped(post.id, skipReason);
      return;
    }

    const prepared = prepareVkParsingPublishPayload(
      {
        text: post.text,
        photoUrls,
        videoUrls,
        linkUrls,
      },
      settings,
      { preserveLinkUrls: preservedLinkUrls },
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
      return {
        action: 'pause',
        retryAfterMs: 180_000,
        reason: 'background governor unavailable',
      };
    }
  }

  private async markQueuedPostPublishFailed(
    post: Pick<VkParsingPostWithSource, 'id' | 'autoPublishError'>,
    error: ReturnType<typeof classifyVkParsingPublishError>,
    options: { auto: boolean; finalAttempt: boolean },
  ): Promise<void> {
    const message = formatVkParsingClassifiedErrorMessage(error);
    const shouldClearQueue = !error.retryable || options.finalAttempt;
    const updated = await this.prisma.vkParsingPost.updateMany({
      where: {
        id: post.id,
        status: { notIn: [VK_POST_STATUS_PUBLISHED, VK_POST_STATUS_UNAVAILABLE] },
      },
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
    if (updated.count === 0) {
      this.logger.warn(
        { postId: post.id, errorClass: error.code },
        'VK parsing queued post disappeared before failure persistence',
      );
    }
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

  private async downloadAndUploadVideo(
    videoUrl: string,
    requestOptions: {
      botId?: string;
      trafficClass: MaxApiTrafficClass;
      sourceTag: string;
    },
    media: VkParsingVideoPublishMedia | null,
  ): Promise<Record<string, unknown>> {
    const mediaIdentity = media?.mediaIdentity ?? null;
    const candidateUrls = this.resolveVideoCandidateUrls(videoUrl, media?.candidateUrls ?? []);
    let lastError: unknown = null;

    for (const candidateUrl of candidateUrls) {
      try {
        const cache = await this.assertVideoReadyForPublish(candidateUrl, mediaIdentity);
        const cachedPayload = this.readUploadPayload(cache);
        if (cachedPayload) {
          return cachedPayload;
        }

        const video = await this.downloadVideo(candidateUrl);
        const payload = await this.maxClient.uploadVideo(
          video.buffer,
          video.fileName,
          video.mimeType,
          {
            ...requestOptions,
            timeoutMs: VK_VIDEO_UPLOAD_TIMEOUT_MS,
          },
        );
        await this.mediaCache.writeMediaCache(
          candidateUrl,
          {
            status: VK_MEDIA_STATUS_READY,
            mimeType: video.mimeType,
            contentLength: video.buffer.length,
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
        if (!this.shouldTryNextVideoCandidate(error)) {
          throw error;
        }
        await this.rememberVideoCandidateFailure(candidateUrl, mediaIdentity, error);
      }
    }

    throw lastError instanceof Error ? lastError : new BadRequestException('Видео недоступно.');
  }

  private resolveVideoCandidateUrls(primaryUrl: string, candidateUrls: string[]): string[] {
    return [
      ...new Set([primaryUrl, ...candidateUrls].map((url) => url.trim()).filter(Boolean)),
    ];
  }

  private shouldTryNextVideoCandidate(error: unknown): boolean {
    return this.isSkippableVideoPublishFailure(this.formatError(error));
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

  private async assertVideoReadyForPublish(
    videoUrl: string,
    mediaIdentity: string | null = null,
  ): Promise<VkParsingMediaCacheRow> {
    const cache = await this.preflightVideoUrl(videoUrl, mediaIdentity);
    if (this.readUploadPayload(cache)) {
      return cache;
    }
    if (cache.status === VK_MEDIA_STATUS_FAILED) {
      throw new BadRequestException(cache.lastError || 'Видео VK недоступно.');
    }
    return cache;
  }

  private async preflightVideoUrl(
    videoUrl: string,
    mediaIdentity: string | null,
  ): Promise<VkParsingMediaCacheRow> {
    const cached = await this.mediaCache.findMediaCache(videoUrl, mediaIdentity);
    if (cached?.status === VK_MEDIA_STATUS_READY && this.readUploadPayload(cached)) {
      return cached;
    }
    if (cached?.status === VK_MEDIA_STATUS_FAILED && this.canReuseFailedVideoPreflightCache(cached)) {
      return cached;
    }

    let parsed: URL;
    try {
      parsed = new URL(videoUrl);
      if (parsed.protocol !== 'https:') {
        return this.mediaCache.writeMediaCache(
          videoUrl,
          {
            status: VK_MEDIA_STATUS_FAILED,
            lastError: 'Видео VK должно быть доступно по HTTPS.',
          },
          mediaIdentity,
        );
      }
    } catch {
      return this.mediaCache.writeMediaCache(
        videoUrl,
        {
          status: VK_MEDIA_STATUS_FAILED,
          lastError: 'Некорректная ссылка на видео VK.',
        },
        mediaIdentity,
      );
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), VK_VIDEO_FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(parsed, { method: 'HEAD', signal: controller.signal });
      await response.body?.cancel().catch(() => undefined);
      if (!response.ok) {
        if (this.isSoftVideoPreflightStatus(response.status)) {
          return this.mediaCache.writeMediaCache(
            videoUrl,
            {
              status: VK_MEDIA_STATUS_READY,
              contentLength: null,
              lastError: null,
            },
            mediaIdentity,
          );
        }
        return this.mediaCache.writeMediaCache(
          videoUrl,
          {
            status: VK_MEDIA_STATUS_FAILED,
            lastError: `VK вернул статус ${response.status} для видео.`,
          },
          mediaIdentity,
        );
      }

      const headers = response.headers ?? new Headers();
      const contentLength = this.readStrictContentLength(headers);
      if (contentLength !== null && contentLength > VK_VIDEO_MAX_BYTES) {
        return this.mediaCache.writeMediaCache(
          videoUrl,
          {
            status: VK_MEDIA_STATUS_FAILED,
            contentLength,
            lastError: 'Видео из VK слишком большое. Максимум 250 МБ.',
          },
          mediaIdentity,
        );
      }

      const mimeType = this.normalizeVideoMimeType(headers.get('content-type'));
      if (!mimeType && this.hasExplicitUnsupportedVideoMimeType(headers.get('content-type'))) {
        return this.mediaCache.writeMediaCache(
          videoUrl,
          {
            status: VK_MEDIA_STATUS_FAILED,
            contentLength,
            lastError: 'VK вернул не видео.',
          },
          mediaIdentity,
        );
      }

      return this.mediaCache.writeMediaCache(
        videoUrl,
        {
          status: VK_MEDIA_STATUS_READY,
          mimeType: mimeType || null,
          contentLength,
          lastError: null,
        },
        mediaIdentity,
      );
    } catch (error) {
      return this.mediaCache.writeMediaCache(
        videoUrl,
        {
          status: VK_MEDIA_STATUS_FAILED,
          lastError:
            error instanceof Error && error.name === 'AbortError'
              ? 'VK не ответил на проверку видео вовремя.'
              : formatVkParsingError(error),
        },
        mediaIdentity,
      );
    } finally {
      clearTimeout(timeout);
    }
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

  private async rememberVideoCandidateFailure(
    videoUrl: string,
    mediaIdentity: string | null,
    error: unknown,
  ): Promise<void> {
    try {
      await this.mediaCache.writeMediaCache(
        videoUrl,
        {
          status: VK_MEDIA_STATUS_FAILED,
          lastError: this.formatError(error),
        },
        mediaIdentity,
      );
    } catch (cacheError) {
      this.logger.warn(
        { err: cacheError, videoUrl, mediaIdentity },
        'Failed to record stale VK video candidate',
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
  ): Promise<VkParsingDownloadedMedia> {
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

  private async downloadVideo(videoUrl: string): Promise<VkParsingDownloadedMedia> {
    const parsed = new URL(videoUrl);
    if (parsed.protocol !== 'https:') {
      throw new BadRequestException('Видео VK должно быть доступно по HTTPS.');
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), VK_VIDEO_FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(parsed, { signal: controller.signal });
      if (!response.ok) {
        throw new BadRequestException('Не удалось скачать видео из VK.');
      }

      const headers = response.headers ?? new Headers();
      const contentLength = this.readStrictContentLength(headers);
      if (contentLength !== null && contentLength > VK_VIDEO_MAX_BYTES) {
        throw new BadRequestException('Видео из VK слишком большое. Максимум 250 МБ.');
      }

      const contentType = headers.get('content-type');
      const mimeType = this.normalizeVideoMimeType(contentType);
      if (!mimeType && this.hasExplicitUnsupportedVideoMimeType(contentType)) {
        throw new BadRequestException('VK вернул не видео.');
      }
      const resolvedMimeType = mimeType ?? this.resolveVideoMimeTypeFromUrl(parsed);
      if (!resolvedMimeType) {
        throw new BadRequestException('VK вернул не видео.');
      }

      const buffer = await this.readResponseBufferWithLimit(response, VK_VIDEO_MAX_BYTES);
      if (buffer.length === 0) {
        throw new BadRequestException('Видео из VK оказалось пустым.');
      }
      if (contentLength !== null && buffer.length !== contentLength) {
        throw new BadRequestException('Размер скачанного видео VK не совпал с Content-Length.');
      }
      if (buffer.length > VK_VIDEO_MAX_BYTES) {
        throw new BadRequestException('Видео из VK слишком большое. Максимум 250 МБ.');
      }

      return {
        buffer,
        fileName: this.resolveVideoFileName(parsed, resolvedMimeType),
        mimeType: resolvedMimeType,
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

  private resolveVideoFileName(url: URL, mimeType: string): string {
    const rawName = decodeURIComponent(url.pathname.split('/').filter(Boolean).at(-1) ?? '');
    const safeName = rawName.replace(/[^A-Za-z0-9._-]/gu, '').slice(0, 120);
    if (safeName && /\.[A-Za-z0-9]{2,6}$/u.test(safeName)) {
      return safeName;
    }

    return mimeType === 'video/webm' ? 'vk-video.webm' : 'vk-video.mp4';
  }

  private async readResponseBufferWithLimit(response: Response, maxBytes: number): Promise<Buffer> {
    if (!response.body) {
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length > maxBytes) {
        throw new BadRequestException('Видео из VK слишком большое. Максимум 250 МБ.');
      }
      return buffer;
    }

    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    try {
      for (;;) {
        const result = await reader.read();
        if (result.done) {
          break;
        }
        const chunk = Buffer.from(result.value);
        totalBytes += chunk.length;
        if (totalBytes > maxBytes) {
          await reader.cancel().catch(() => undefined);
          throw new BadRequestException('Видео из VK слишком большое. Максимум 250 МБ.');
        }
        chunks.push(chunk);
      }
    } finally {
      reader.releaseLock();
    }

    return Buffer.concat(chunks, totalBytes);
  }

  private resolveVideoMimeTypeFromUrl(url: URL): string | null {
    const path = url.pathname.toLowerCase();
    if (path.endsWith('.webm')) {
      return 'video/webm';
    }
    if (path.endsWith('.mov') || path.endsWith('.qt')) {
      return 'video/quicktime';
    }
    if (path.endsWith('.mp4') || path.endsWith('.m4v')) {
      return 'video/mp4';
    }
    return null;
  }

  private normalizeVideoMimeType(value: string | null): string | null {
    const mimeType = (value ?? '').split(';')[0]!.trim().toLowerCase();
    return VK_SUPPORTED_VIDEO_MIME_TYPES.has(mimeType) ? mimeType : null;
  }

  private hasExplicitUnsupportedVideoMimeType(value: string | null): boolean {
    const mimeType = (value ?? '').split(';')[0]!.trim().toLowerCase();
    return Boolean(mimeType) && mimeType !== 'application/octet-stream' && !mimeType.startsWith('binary/');
  }

  private readStrictContentLength(headers: Headers): number | null {
    const rawContentLength = headers.get('content-length')?.trim();
    if (!rawContentLength || !/^\d+$/u.test(rawContentLength)) {
      return null;
    }
    const contentLength = Number(rawContentLength);
    return Number.isFinite(contentLength) && contentLength > 0 ? contentLength : null;
  }

  private isSoftVideoPreflightStatus(status: number): boolean {
    return status === 403 || status === 405 || status === 501;
  }

  private canReuseFailedVideoPreflightCache(cache: VkParsingMediaCacheRow): boolean {
    if (!cache.lastCheckedAt) {
      return false;
    }
    const ageMs = Date.now() - cache.lastCheckedAt.getTime();
    return ageMs >= 0 && ageMs < this.videoFailedPreflightTtlMs;
  }

  private assertPreparedPublishPayload(payload: PreparedVkPublishPayload): void {
    if (this.isEmptyPublishPayload(payload)) {
      throw new BadRequestException(
        'После фильтрации в посте не осталось текста, фото, видео или ссылок.',
      );
    }
    if (payload.photoUrls.length > 0 && payload.videoUrls.length > 0) {
      throw new BadRequestException('В одном VK-посте можно опубликовать либо фото, либо видео.');
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
      payload.videoUrls.length === 0 &&
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

  private isSkippableVideoPublishFailure(message: string): boolean {
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
      normalized.includes('не удалось скачать видео') ||
      normalized.includes('fetch failed') ||
      normalized.includes('terminated') ||
      normalized.includes('operation was aborted') ||
      normalized.includes('видео vk должно быть доступно по https') ||
      normalized.includes('некорректная ссылка на видео vk') ||
      normalized.includes('видео из vk слишком большое') ||
      normalized.includes('размер скачанного видео vk не совпал') ||
      normalized.includes('vk вернул не видео') ||
      normalized.includes('vk не сообщил размер видео') ||
      normalized.includes('vk не ответил')
    );
  }

  private async markPostSkipped(postId: string, reason: VkParsingSkipReason): Promise<void> {
    const updated = await this.prisma.vkParsingPost.updateMany({
      where: {
        id: postId,
        status: { notIn: [VK_POST_STATUS_PUBLISHED, VK_POST_STATUS_UNAVAILABLE] },
      },
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
    if (updated.count === 0) {
      this.logger.warn(
        { postId, reason },
        'VK parsing post disappeared before skip persistence',
      );
    }
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

  private resolveStripPreservedLinkUrls(post: VkParsingPostWithSource): string[] {
    const postUrl = this.readString(post.url);
    if (!postUrl) {
      return [];
    }
    const linkUrls = this.readStringArray(post.linkUrls);
    if (!linkUrls.includes(postUrl)) {
      return [];
    }
    if (
      this.readStringArray(post.photoUrls).length > 0 ||
      this.readStringArray(post.videoUrls).length > 0
    ) {
      return [];
    }
    const hasUnsupportedVideo = this.readUnsupportedAttachments(post.unsupportedAttachments).some(
      (item) => item.type === 'video' || item.type === 'clip',
    );
    return hasUnsupportedVideo ? [postUrl] : [];
  }

  private readUnsupportedAttachments(
    value: Prisma.JsonValue | unknown,
  ): Array<{ type: string }> {
    if (!Array.isArray(value)) {
      return [];
    }

    return value
      .map((item) => this.asRecord(item))
      .filter((item): item is Record<string, unknown> => item !== null)
      .map((item) => ({ type: this.readString(item.type).toLowerCase() }))
      .filter((item) => item.type.length > 0);
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
