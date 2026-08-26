import {
  publishVkParsingPostRequestSchema,
  publishVkParsingPostResultSchema,
  rollbackVkParsingResultSchema,
  retryVkParsingPostResultSchema,
  VK_PARSING_DEFAULT_CHANNEL_LINK_TEXT,
  VK_PARSING_MAX_CHANNEL_LINK_URL_LENGTH,
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
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import type { Queue } from 'bullmq';
import {
  containsSupportedMarkdownUrl,
  renderSupportedMarkdownAsHtml,
} from '../common/max-markdown.util';
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
import { MAX_VIDEO_UPLOAD_MAX_BYTES } from '../max/max-video-upload.constants';
import {
  MaxRoutedPublicationService,
  type MaxRoutedPublicationResult,
} from '../max/max-routed-publication.service';
import { ChatEntityType, Prisma, PublicationDispatchProfile } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { PublisherSetupRequiredException } from '../publisher/publisher-errors';
import {
  PublisherDispatchHealthService,
  type PublisherFailureClassification,
} from '../publisher/publisher-dispatch-health.service';
import {
  PublisherReadinessService,
  type PublisherReadyRoute,
} from '../publisher/publisher-readiness.service';
import { PublisherRuntimeBoundaryService } from '../publisher/publisher-runtime-boundary.service';
import {
  resolveNewPublicationDispatchRoute,
  type PublisherDispatchRoute,
} from '../publisher/publisher-route';
import {
  BackgroundRuntimeGovernorService,
  type BackgroundRuntimeGovernorDecision,
} from '../system/background-runtime-governor.service';
import { AdminService } from './admin.service';
import {
  BROADCAST_VIDEO_SEND_RETRY_DELAYS_MS,
  CHANNEL_DIALOG_ACTION_AUTO_ATTACH,
  CHAT_DIALOG_ACTION_AUTO_ATTACH,
} from './admin.service.support';
import { VkParsingAccessService } from './vk-parsing-access.service';
import { ChannelPostSignatureService } from './channel-post-signature.service';
import {
  PublisherDialogContextService,
  type PublisherPreparedDialogContext,
} from './publisher-dialog-context.service';
import { parseVkWallPostAttachments } from './vk-parsing-attachments';
import {
  computeVkParsingPostContentHash,
  describeVkParsingSkipReason,
  prepareVkParsingPublishPayload,
  resolveEffectiveVkParsingTextFormat,
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
  VK_MEDIA_CACHE_UPLOAD_BOT_ID_FIELD,
  VkParsingMediaCacheService,
  type VkParsingMediaCacheRow,
} from './vk-parsing-media-cache.service';
import {
  VK_PARSING_PUBLISH_QUEUE,
  VK_PARSING_PUBLISHER_QUEUE,
  VK_PARSING_PUBLISH_RETRY_POLICY,
  type VkParsingPublishJob,
  type VkParsingPublishReason,
  type VkParsingPublisherJob,
  type VkParsingPublisherPublishJob,
  type VkParsingPublisherRollbackJob,
} from './vk-parsing.queue';

type VkParsingPostWithSource = Prisma.VkParsingPostGetPayload<{ include: { source: true } }>;

type VkParsingSettingsLike = {
  chatId: string;
  autoPublishEnabled: boolean;
  autoPublishEnabledAt: Date | null;
  autoPublishKillSwitchEnabled: boolean;
  stripLinksEnabled: boolean;
  skipAdsEnabled: boolean;
  appendChannelLinkEnabled: boolean;
  channelLinkText: string;
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

type VkParsingMaxMessageText = {
  text: string;
  textFormat: MaxSendMessageOptions['textFormat'];
  engagementText: string;
};

type VkParsingStoredDraft = {
  text: string;
  textFormat: 'plain' | 'markdown';
  photoUrls: string[];
  videoUrls: string[];
  linkUrls: string[];
};

type VkParsingPhotoPublishMedia = {
  mediaIdentity: string | null;
  candidateUrls: string[];
};

type VkParsingVideoPublishMedia = {
  mediaIdentity: string | null;
  candidateUrls: string[];
};

type VkPublishJobRecoveryOutcome = 'missing' | 'healthy' | 'retried' | 'conflict' | 'failed';
type VkPublishJobEnqueueOutcome = Exclude<VkPublishJobRecoveryOutcome, 'missing'> | 'created';

type VkPublishRecoveryCursor = {
  publishScheduledAt: Date;
  publishQueuedAt: Date;
  updatedAt: Date;
  id: string;
};

type VkParsingDownloadedMedia = {
  buffer: Buffer;
  fileName: string;
  mimeType: string;
};

type VkPublishIntentRoute = {
  dispatchProfile: PublicationDispatchProfile;
  requiredBotId: string | null;
  dialogBotId: string | null;
  publishDialogContext: PublisherPreparedDialogContext | null;
  publicationPolicyRevision: number | null;
};

class PublisherVkDispatchBlockedError extends Error {
  constructor(
    readonly blockerCode: string,
    readonly cause: unknown,
  ) {
    super(`Publik dispatch is blocked: ${blockerCode}`, { cause });
    this.name = 'PublisherVkDispatchBlockedError';
  }
}

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
const MAX_SEND_AMBIGUOUS_ERROR_PREFIX = '[max.send_ambiguous]';
const MAX_SEND_AMBIGUOUS_RETRY_BLOCK_MESSAGE =
  'MAX мог уже принять эту публикацию. Сначала сверьте сообщение в MAX вручную; повторная отправка заблокирована.';
const VK_PARSING_SCHEDULE_STEP_MS = 15 * 60_000;
const VK_PARSING_MAX_SCHEDULE_LOOKAHEAD_STEPS = (8 * 24 * 60) / 15;
const VK_PUBLISH_SCHEDULE_DRIFT_TOLERANCE_MS = 5_000;
// FLAG: One missed daily cycle may catch up; older automatic output stays available for admin review.
const VK_AUTOPUBLISH_RECOVERY_FRESHNESS_HORIZON_MS = 24 * 60 * 60_000;
const VK_VIDEO_MAX_BYTES = MAX_VIDEO_UPLOAD_MAX_BYTES;
const VK_VIDEO_FETCH_TIMEOUT_MS = 60_000;
const VK_VIDEO_UPLOAD_TIMEOUT_MS = 120_000;
const VK_ATTACHMENT_SEND_RETRY_DELAYS_MS = [750, 1_500];
const VK_SUPPORTED_VIDEO_MIME_TYPES = new Set(['video/mp4', 'video/quicktime', 'video/webm']);

@Injectable()
export class VkPublishService {
  private readonly logger = new Logger(VkPublishService.name);
  private readonly persistedPublishFailures = new WeakSet<object>();
  private readonly queueBatchSize: number;
  private readonly publishLeaseTtlMs: number;
  private readonly mediaConcurrency: number;
  private readonly videoFailedPreflightTtlMs: number;
  private readonly newDispatchRoute: PublisherDispatchRoute | null;
  private duePublishRecoveryCursorId: string | null = null;
  private futurePublishRecoveryCursor: VkPublishRecoveryCursor | null = null;

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
    @Optional()
    private readonly maxRoutedPublicationService?: MaxRoutedPublicationService,
    @Optional()
    private readonly channelPostSignatureService?: ChannelPostSignatureService,
    @Optional()
    @InjectQueue(VK_PARSING_PUBLISHER_QUEUE)
    private readonly publisherQueue?: Queue<VkParsingPublisherJob>,
    @Optional()
    private readonly publisherReadinessService?: PublisherReadinessService,
    @Optional()
    private readonly publisherRuntimeBoundaryService?: PublisherRuntimeBoundaryService,
    @Optional()
    private readonly publisherDispatchHealthService?: PublisherDispatchHealthService,
    @Optional()
    private readonly publisherDialogContextService?: PublisherDialogContextService,
  ) {
    this.newDispatchRoute = resolveNewPublicationDispatchRoute(configService);
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

  async assertChannelLinkAvailable(
    chatId: string,
    trafficClass: MaxApiTrafficClass = 'interactive',
  ): Promise<void> {
    if (this.channelPostSignatureService) {
      return this.channelPostSignatureService.assertChannelLinkAvailable(chatId, trafficClass);
    }
    await this.resolveChannelLink(chatId, trafficClass);
  }

  async recoverStalePublishJobs(): Promise<number> {
    const now = new Date();
    const staleLockBefore = new Date(now.getTime() - this.publishLeaseTtlMs);
    const recoveredRollbacks = await this.recoverStalePublisherRollbackJobs(staleLockBefore);
    const posts = await this.findRecoverableStalePublishPosts(now, staleLockBefore);
    if (posts.length === 0) {
      return recoveredRollbacks;
    }

    const settingsByChatId = new Map<string, VkParsingSettingsLike>();
    let recovered = 0;
    let expiredAutoPublishRecoveries = 0;
    for (const post of posts) {
      const idempotencyKey = post.publishIdempotencyKey;
      if (!idempotencyKey) {
        continue;
      }
      // FLAG: Legacy rows without an explicit owner are ambiguous. Recovery must leave them
      // untouched for operator review instead of guessing autopublish and changing ownership.
      if (
        post.publishReason !== 'autopublish' &&
        post.publishReason !== 'manual-retry' &&
        post.publishReason !== 'manual-schedule'
      ) {
        this.logger.warn(
          { postId: post.id, chatId: post.chatId, publishReason: post.publishReason },
          'Quarantined VK publish recovery with ambiguous ownership',
        );
        continue;
      }
      const reason = post.publishReason;
      const recoverablePost = post;

      if (
        reason === 'autopublish' &&
        this.isBeyondAutoPublishRecoveryFreshnessHorizon(recoverablePost, now)
      ) {
        const cleared = await this.clearRecoverableQueuedAutoPublishPost(
          recoverablePost.id,
          idempotencyKey,
          recoverablePost,
        );
        if (cleared) {
          expiredAutoPublishRecoveries += 1;
        }
        continue;
      }

      let settings = settingsByChatId.get(recoverablePost.chatId);
      if (!settings) {
        settings = await this.getSettingsForChat(recoverablePost.chatId);
        settingsByChatId.set(recoverablePost.chatId, settings);
      }

      if (reason === 'autopublish' && !this.canAutoPublishPost(recoverablePost, settings)) {
        await this.clearRecoverableQueuedAutoPublishPost(
          recoverablePost.id,
          idempotencyKey,
          recoverablePost,
        );
        continue;
      }

      const outcome = await this.addPublishJob(
        recoverablePost,
        reason,
        idempotencyKey,
        now,
        recoverablePost.publishScheduledAt,
      );
      if (outcome === 'created' || outcome === 'retried') {
        recovered += 1;
      }
    }

    if (expiredAutoPublishRecoveries > 0) {
      this.logger.warn(
        { count: expiredAutoPublishRecoveries },
        'Cleared VK autopublish recoveries beyond the bounded freshness horizon',
      );
    }

    return recovered + recoveredRollbacks;
  }

  private isBeyondAutoPublishRecoveryFreshnessHorizon(
    post: Pick<VkParsingPostWithSource, 'publishQueuedAt' | 'publishScheduledAt'>,
    now: Date,
  ): boolean {
    const effectiveDueAt = post.publishScheduledAt ?? post.publishQueuedAt;
    return (
      effectiveDueAt !== null &&
      now.getTime() - effectiveDueAt.getTime() > VK_AUTOPUBLISH_RECOVERY_FRESHNESS_HORIZON_MS
    );
  }

  private async findRecoverableStalePublishPosts(
    now: Date,
    staleLockBefore: Date,
  ): Promise<VkParsingPostWithSource[]> {
    const baseWhere = {
      publishQueuedAt: { not: null },
      publishIdempotencyKey: { not: null },
      OR: [{ publishLockedAt: null }, { publishLockedAt: { lt: staleLockBefore } }],
    };
    const recoverableReasonWhere = {
      OR: [
        {
          publishReason: { in: ['manual-retry', 'manual-schedule'] },
          status: { notIn: [VK_POST_STATUS_PUBLISHED, VK_POST_STATUS_UNAVAILABLE] },
        },
        {
          publishReason: 'autopublish',
          status: { in: [VK_POST_STATUS_NEW, VK_POST_STATUS_FAILED] },
        },
      ],
    };
    const duePosts = await this.prisma.vkParsingPost.findMany({
      where: {
        ...baseWhere,
        AND: [
          recoverableReasonWhere,
          {
            OR: [{ publishScheduledAt: null }, { publishScheduledAt: { lte: now } }],
          },
          ...(this.duePublishRecoveryCursorId
            ? [{ id: { gt: this.duePublishRecoveryCursorId } }]
            : []),
        ],
      },
      include: { source: true },
      orderBy: { id: 'asc' },
      take: this.queueBatchSize,
    });
    this.duePublishRecoveryCursorId =
      duePosts.length === this.queueBatchSize ? (duePosts.at(-1)?.id ?? null) : null;
    if (duePosts.length >= this.queueBatchSize) {
      return duePosts;
    }

    const futurePosts = await this.prisma.vkParsingPost.findMany({
      where: {
        ...baseWhere,
        AND: [
          recoverableReasonWhere,
          ...(this.futurePublishRecoveryCursor
            ? [this.buildFuturePublishRecoveryCursorWhere(this.futurePublishRecoveryCursor)]
            : []),
        ],
        publishScheduledAt: { gt: now },
      },
      include: { source: true },
      orderBy: [
        { publishScheduledAt: 'asc' },
        { publishQueuedAt: 'asc' },
        { updatedAt: 'asc' },
        { id: 'asc' },
      ],
      take: this.queueBatchSize - duePosts.length,
    });
    this.advanceFuturePublishRecoveryCursor(futurePosts, this.queueBatchSize - duePosts.length);
    if (futurePosts.length === 0) {
      return duePosts;
    }

    return [...duePosts, ...futurePosts];
  }

  private buildFuturePublishRecoveryCursorWhere(
    cursor: VkPublishRecoveryCursor,
  ): Prisma.VkParsingPostWhereInput {
    return {
      OR: [
        { publishScheduledAt: { gt: cursor.publishScheduledAt } },
        {
          publishScheduledAt: cursor.publishScheduledAt,
          publishQueuedAt: { gt: cursor.publishQueuedAt },
        },
        {
          publishScheduledAt: cursor.publishScheduledAt,
          publishQueuedAt: cursor.publishQueuedAt,
          updatedAt: { gt: cursor.updatedAt },
        },
        {
          publishScheduledAt: cursor.publishScheduledAt,
          publishQueuedAt: cursor.publishQueuedAt,
          updatedAt: cursor.updatedAt,
          id: { gt: cursor.id },
        },
      ],
    };
  }

  private advanceFuturePublishRecoveryCursor(
    posts: readonly VkParsingPostWithSource[],
    requestedCount: number,
  ): void {
    const lastPost = posts.at(-1);
    if (
      posts.length < requestedCount ||
      !lastPost?.publishScheduledAt ||
      !lastPost.publishQueuedAt
    ) {
      this.futurePublishRecoveryCursor = null;
      return;
    }
    this.futurePublishRecoveryCursor = {
      publishScheduledAt: lastPost.publishScheduledAt,
      publishQueuedAt: lastPost.publishQueuedAt,
      updatedAt: lastPost.updatedAt,
      id: lastPost.id,
    };
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
    this.assertNoAmbiguousMaxSendQuarantine(post);
    this.assertReviewSourceOwnerAction(post, actorUserId);

    const storedPhotoUrls = this.readStringArray(post.photoUrls);
    const storedVideoUrls = this.readStringArray(post.videoUrls);
    const storedLinkUrls = this.readStringArray(post.linkUrls);
    const photoUrls = this.assertSelectedUrls(parsed.data.photoUrls, storedPhotoUrls, 'фото');
    const videoUrls = this.assertSelectedUrls(parsed.data.videoUrls, storedVideoUrls, 'видео');
    const linkUrls = this.assertSelectedUrls(parsed.data.linkUrls, storedLinkUrls, 'ссылку');
    const settings = await this.getSettingsForChat(chatId);
    const preservedLinkUrls = this.resolveStripPreservedLinkUrls(post);
    const storedDraft: VkParsingStoredDraft = {
      text: parsed.data.text,
      textFormat: parsed.data.textFormat,
      photoUrls,
      videoUrls,
      linkUrls,
    };
    const prepared = prepareVkParsingPublishPayload(
      {
        text: parsed.data.text,
        textFormat: parsed.data.textFormat,
        photoUrls,
        videoUrls,
        linkUrls,
      },
      settings,
      { preserveLinkUrls: preservedLinkUrls },
    );
    const skipReason = resolveVkParsingPostSkipReason(
      {
        text: parsed.data.text,
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
      throw new BadRequestException(describeVkParsingSkipReason(skipReason));
    }
    this.assertPreparedPublishPayload(prepared);
    if (this.newDispatchRoute) {
      const queued = await this.enqueuePostPublish(post, 'manual-retry', new Date(), {
        actorUserId,
        storedDraft,
      });
      const updated = await this.prisma.vkParsingPost.findFirst({
        where: { id: post.id, chatId },
        include: { source: true },
      });
      return publishVkParsingPostResultSchema.parse({
        post: this.feedService.mapPost(updated ?? { ...post, ...storedDraft }),
        queued,
      });
    }
    const publishLockAt = await this.lockManualPublishPost(post.id, chatId, storedDraft);
    if (!publishLockAt) {
      throw new BadRequestException('Этот VK-пост уже публикуется.');
    }
    let maxMessage: VkParsingMaxMessageText;
    try {
      maxMessage = await this.prepareMaxMessageText(chatId, prepared, settings, 'interactive');
    } catch (error) {
      try {
        await this.releaseManualPublishLock(post.id, chatId, publishLockAt, post.publishReason);
      } catch (releaseError) {
        this.logger.warn(
          { postId: post.id, chatId, err: releaseError },
          'Failed to release VK manual publish lock after message preparation error',
        );
      }
      throw error;
    }

    const publishIdempotencyKey = this.buildMaxPublicationIntentKey(post.id, prepared, maxMessage);
    try {
      const recoveryArmed = await this.armManualPublishRecovery(
        post,
        publishLockAt,
        publishIdempotencyKey,
      );
      if (!recoveryArmed) {
        await this.releaseManualPublishLock(post.id, chatId, publishLockAt, post.publishReason);
        throw new ServiceUnavailableException(
          'Не удалось зафиксировать отправку перед публикацией. Обновите список и повторите попытку.',
        );
      }
    } catch (error) {
      if (!(error instanceof ServiceUnavailableException)) {
        try {
          await this.releaseManualPublishLock(post.id, chatId, publishLockAt, post.publishReason);
        } catch (releaseError) {
          this.logger.warn(
            { postId: post.id, chatId, err: releaseError },
            'Failed to release VK manual publish lock after recovery persistence error',
          );
        }
      }
      throw error;
    }

    return this.publishPreparedPostToMax(
      {
        ...post,
        publishQueuedAt: publishLockAt,
        publishScheduledAt: publishLockAt,
        publishIdempotencyKey,
        publishReason: 'manual-retry',
      },
      prepared,
      maxMessage,
      {
        actorUserId,
        trafficClass: 'interactive',
        debugAction: 'publish_post',
        auto: false,
        storedDraft,
      },
    );
  }

  async retryPost(
    chatId: string,
    postId: string,
    actorUserId?: string,
  ): Promise<RetryVkParsingPostResult> {
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
    this.assertNoAmbiguousMaxSendQuarantine(post);
    this.assertReviewSourceOwnerAction(post, null);

    const queued = await this.enqueuePostPublish(post, 'manual-retry', new Date(), {
      actorUserId,
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

  async schedulePost(
    chatId: string,
    postId: string,
    scheduledAtIso: string,
    actorUserId: string,
  ): Promise<RetryVkParsingPostResult> {
    const post = await this.findSchedulablePost(chatId, postId);
    this.assertNoAmbiguousMaxSendQuarantine(post);
    this.assertReviewSourceOwnerAction(post, actorUserId);
    const scheduledAt = new Date(scheduledAtIso);
    if (!Number.isFinite(scheduledAt.getTime())) {
      throw new BadRequestException('Некорректное время публикации.');
    }
    const queued = await this.enqueuePostPublish(post, 'manual-schedule', scheduledAt, {
      actorUserId,
    });
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
    this.assertNoAmbiguousMaxSendQuarantine(post);
    this.assertReviewSourceOwnerAction(post, actorUserId);
    const queued = await this.enqueuePostPublish(post, 'manual-retry', new Date(), {
      actorUserId,
    });
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
    let queued = 0;
    let failed = 0;
    if (request.deleteMessages) {
      for (const post of posts) {
        if (!post.publishedMessageId) {
          failed += 1;
          continue;
        }
        try {
          if (post.dispatchProfile === PublicationDispatchProfile.PUBLIK_V1) {
            if (await this.enqueuePublisherRollback(post)) {
              queued += 1;
            } else {
              failed += 1;
            }
            continue;
          }
          const botId =
            post.publishedBotId ??
            (await this.maxBotLinkService.resolveBotIdForModerationAction({
              chatId: post.chatId,
              action: 'delete_message',
            }));
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
      queued,
      failed,
    });

    return rollbackVkParsingResultSchema.parse({
      matched: posts.length,
      deleted,
      queued,
      failed,
      posts: posts.map((post) => this.feedService.mapPost(post)),
    });
  }

  private async enqueuePublisherRollback(
    post: Pick<
      VkParsingPostWithSource,
      | 'id'
      | 'chatId'
      | 'dispatchProfile'
      | 'requiredBotId'
      | 'publishedBotId'
      | 'publishedMessageId'
      | 'rollbackQueuedAt'
      | 'rollbackLockedAt'
      | 'rollbackIdempotencyKey'
      | 'rollbackDeletedAt'
    >,
  ): Promise<boolean> {
    if (
      post.dispatchProfile !== PublicationDispatchProfile.PUBLIK_V1 ||
      !post.requiredBotId?.trim() ||
      post.publishedBotId !== post.requiredBotId ||
      !post.publishedMessageId?.trim() ||
      post.rollbackDeletedAt
    ) {
      return false;
    }
    if (!this.publisherQueue) {
      throw new ServiceUnavailableException('Publik VK queue is unavailable.');
    }

    const idempotencyKey = this.buildPublisherRollbackIdempotencyKey(post);
    const queuedAt = new Date();
    if (post.rollbackIdempotencyKey === idempotencyKey && post.rollbackQueuedAt) {
      return this.ensurePublisherRollbackQueueJob({
        kind: 'rollback-delete',
        postId: post.id,
        chatId: post.chatId,
        messageId: post.publishedMessageId,
        requiredBotId: post.requiredBotId,
        idempotencyKey,
        createdAt: post.rollbackQueuedAt.toISOString(),
      });
    }
    if (post.rollbackIdempotencyKey || post.rollbackLockedAt) {
      return false;
    }
    const armed = await this.prisma.vkParsingPost.updateMany({
      where: {
        id: post.id,
        chatId: post.chatId,
        dispatchProfile: PublicationDispatchProfile.PUBLIK_V1,
        requiredBotId: post.requiredBotId,
        publishedBotId: post.requiredBotId,
        publishedMessageId: post.publishedMessageId,
        rollbackDeletedAt: null,
        rollbackLockedAt: null,
        rollbackIdempotencyKey: null,
      },
      data: {
        rollbackQueuedAt: queuedAt,
        rollbackLockedAt: null,
        rollbackIdempotencyKey: idempotencyKey,
        rollbackLastError: null,
      },
    });
    if (armed.count === 0) {
      return false;
    }

    return this.ensurePublisherRollbackQueueJob({
      kind: 'rollback-delete',
      postId: post.id,
      chatId: post.chatId,
      messageId: post.publishedMessageId,
      requiredBotId: post.requiredBotId,
      idempotencyKey,
      createdAt: queuedAt.toISOString(),
    });
  }

  async processPublisherRollbackJob(params: {
    postId: string;
    chatId: string;
    messageId: string;
    requiredBotId: string;
    idempotencyKey: string;
    attemptsMade?: number;
    maxAttempts?: number;
  }): Promise<void> {
    try {
      this.assertPublisherRuntimeBeforeClaim();
      await this.assertPublisherHealthAllowed();
    } catch (error) {
      if (error instanceof PublisherVkDispatchBlockedError) {
        await this.markPublisherRollbackBlocked(params.postId, params.idempotencyKey, error);
        return;
      }
      throw error;
    }

    const lockAt = new Date();
    const staleLockBefore = new Date(lockAt.getTime() - this.publishLeaseTtlMs);
    const locked = await this.prisma.vkParsingPost.updateMany({
      where: {
        id: params.postId,
        chatId: params.chatId,
        dispatchProfile: PublicationDispatchProfile.PUBLIK_V1,
        requiredBotId: params.requiredBotId,
        publishedBotId: params.requiredBotId,
        publishedMessageId: params.messageId,
        rollbackIdempotencyKey: params.idempotencyKey,
        rollbackQueuedAt: { not: null },
        rollbackDeletedAt: null,
        OR: [{ rollbackLockedAt: null }, { rollbackLockedAt: { lt: staleLockBefore } }],
      },
      data: {
        rollbackLockedAt: lockAt,
        rollbackAttemptCount: { increment: 1 },
      },
    });
    if (locked.count === 0) {
      return;
    }

    try {
      await this.maxClient.deleteMessage(params.chatId, params.messageId, {
        immediate: true,
        botId: params.requiredBotId,
        idempotencyKey: `vk-parsing:publisher-rollback:${params.idempotencyKey}`,
        trafficClass: 'interactive',
        sourceTag: MAX_API_SOURCE_TAGS.VK_PARSING,
        beforeImmediateDeleteMutation: async () => {
          this.assertPublisherRuntimeBeforeClaim();
          await this.assertPublisherHealthAllowed();
        },
      });
      await this.recordPublisherSendSuccessSafely(params.chatId, lockAt);
      await this.prisma.vkParsingPost.updateMany({
        where: {
          id: params.postId,
          rollbackIdempotencyKey: params.idempotencyKey,
          rollbackLockedAt: lockAt,
        },
        data: {
          rollbackQueuedAt: null,
          rollbackLockedAt: null,
          rollbackDeletedAt: new Date(),
          rollbackIdempotencyKey: null,
          rollbackLastError: null,
        },
      });
    } catch (error) {
      if (error instanceof PublisherVkDispatchBlockedError) {
        await this.markPublisherRollbackBlocked(params.postId, params.idempotencyKey, error);
        return;
      }
      const healthClassification = await this.recordPublisherSendFailureSafely(
        params.chatId,
        error,
        lockAt,
      );
      await this.prisma.vkParsingPost.updateMany({
        where: {
          id: params.postId,
          rollbackIdempotencyKey: params.idempotencyKey,
          rollbackLockedAt: lockAt,
        },
        data: {
          rollbackLockedAt: null,
          rollbackLastError: formatVkParsingError(error),
        },
      });
      if (healthClassification === 'global_paused' || healthClassification === 'setup_required') {
        await this.markPublisherRollbackBlocked(
          params.postId,
          params.idempotencyKey,
          new PublisherVkDispatchBlockedError(
            healthClassification === 'global_paused'
              ? 'publisher_auth_paused'
              : 'publisher_setup_required',
            error,
          ),
        );
        return;
      }
      throw error;
    }
  }

  private async recoverStalePublisherRollbackJobs(staleLockBefore: Date): Promise<number> {
    if (!this.publisherQueue) {
      return 0;
    }
    const posts = await this.prisma.vkParsingPost.findMany({
      where: {
        dispatchProfile: PublicationDispatchProfile.PUBLIK_V1,
        rollbackQueuedAt: { not: null },
        rollbackIdempotencyKey: { not: null },
        rollbackDeletedAt: null,
        OR: [{ rollbackLockedAt: null }, { rollbackLockedAt: { lt: staleLockBefore } }],
      },
      orderBy: [{ rollbackQueuedAt: 'asc' }, { id: 'asc' }],
      take: this.queueBatchSize,
    });
    let recovered = 0;
    for (const post of posts) {
      if (
        !post.rollbackQueuedAt ||
        !post.rollbackIdempotencyKey ||
        !post.publishedMessageId ||
        !post.requiredBotId ||
        post.publishedBotId !== post.requiredBotId
      ) {
        continue;
      }
      const outcome = await this.addPublisherRollbackJob({
        kind: 'rollback-delete',
        postId: post.id,
        chatId: post.chatId,
        messageId: post.publishedMessageId,
        requiredBotId: post.requiredBotId,
        idempotencyKey: post.rollbackIdempotencyKey,
        createdAt: post.rollbackQueuedAt.toISOString(),
      });
      if (outcome === 'created' || outcome === 'retried') {
        recovered += 1;
      }
    }
    return recovered;
  }

  private async addPublisherRollbackJob(
    job: VkParsingPublisherRollbackJob,
  ): Promise<VkPublishJobEnqueueOutcome> {
    if (!this.publisherQueue) {
      return 'failed';
    }
    const jobId = this.buildPublisherRollbackJobId(job.postId, job.idempotencyKey);
    const existing = await this.publisherQueue.getJob(jobId);
    if (existing) {
      const state = await existing.getState();
      const matching =
        existing.data.kind === 'rollback-delete' &&
        existing.data.postId === job.postId &&
        existing.data.chatId === job.chatId &&
        existing.data.messageId === job.messageId &&
        existing.data.requiredBotId === job.requiredBotId &&
        existing.data.idempotencyKey === job.idempotencyKey;
      if (!matching && state === 'active') {
        return 'conflict';
      }
      if (!matching || state === 'unknown') {
        await existing.remove();
      } else if (state === 'failed' || state === 'completed') {
        await existing.updateData(job);
        await existing.retry(state, {
          resetAttemptsMade: true,
          resetAttemptsStarted: true,
        });
        return 'retried';
      } else {
        return 'healthy';
      }
    }
    await this.publisherQueue.add('rollback-vk-post', job, {
      jobId,
      ...VK_PARSING_PUBLISH_RETRY_POLICY,
    });
    return 'created';
  }

  private async ensurePublisherRollbackQueueJob(
    job: VkParsingPublisherRollbackJob,
  ): Promise<boolean> {
    try {
      const outcome = await this.addPublisherRollbackJob(job);
      if (outcome === 'conflict') {
        await this.prisma.vkParsingPost.updateMany({
          where: { id: job.postId, rollbackIdempotencyKey: job.idempotencyKey },
          data: { rollbackLastError: 'publisher_queue_ownership_conflict' },
        });
        return false;
      }
      if (outcome === 'failed') {
        await this.prisma.vkParsingPost.updateMany({
          where: { id: job.postId, rollbackIdempotencyKey: job.idempotencyKey },
          data: { rollbackLastError: 'publisher_queue_temporarily_unavailable' },
        });
      }
      return true;
    } catch (error) {
      // The armed database row remains the durable source for bounded recovery.
      await this.prisma.vkParsingPost.updateMany({
        where: { id: job.postId, rollbackIdempotencyKey: job.idempotencyKey },
        data: { rollbackLastError: 'publisher_queue_temporarily_unavailable' },
      });
      this.logger.warn(
        { postId: job.postId, chatId: job.chatId, err: error },
        'Publik VK rollback was armed but its queue add needs recovery',
      );
      return true;
    }
  }

  private async markPublisherRollbackBlocked(
    postId: string,
    idempotencyKey: string,
    error: PublisherVkDispatchBlockedError,
  ): Promise<void> {
    await this.prisma.vkParsingPost.updateMany({
      where: { id: postId, rollbackIdempotencyKey: idempotencyKey },
      data: {
        rollbackLockedAt: null,
        rollbackLastError: `[publisher.blocked] ${error.blockerCode}`,
      },
    });
  }

  private buildPublisherRollbackIdempotencyKey(
    post: Pick<VkParsingPostWithSource, 'id' | 'publishedMessageId' | 'requiredBotId'>,
  ): string {
    return createHash('sha256')
      .update(`${post.id}:${post.publishedMessageId}:${post.requiredBotId}`)
      .digest('hex')
      .slice(0, 32);
  }

  private buildPublisherRollbackJobId(postId: string, idempotencyKey: string): string {
    return `vk-parsing-rollback__${postId}__${idempotencyKey}`;
  }

  async processPublishPostJob(params: {
    postId: string;
    chatId: string;
    reason: VkParsingPublishReason;
    idempotencyKey: string;
    dispatchProfile?: 'LEGACY_ROUTED' | 'PUBLIK_V1';
    requiredBotId?: string;
    attemptsMade?: number;
    maxAttempts?: number;
  }): Promise<void> {
    const expectedDispatchProfile =
      params.dispatchProfile === 'PUBLIK_V1'
        ? PublicationDispatchProfile.PUBLIK_V1
        : PublicationDispatchProfile.LEGACY_ROUTED;
    if (expectedDispatchProfile === PublicationDispatchProfile.PUBLIK_V1) {
      if (!params.requiredBotId?.trim()) {
        throw new Error('Publik VK queue job is missing requiredBotId');
      }
      try {
        this.assertPublisherRuntimeBeforeClaim();
        await this.assertPublisherHealthAllowed();
      } catch (error) {
        if (error instanceof PublisherVkDispatchBlockedError) {
          await this.markPublisherIntentBlocked(
            {
              id: params.postId,
              dispatchProfile: PublicationDispatchProfile.PUBLIK_V1,
              requiredBotId: params.requiredBotId,
            },
            params.idempotencyKey,
            params.reason,
            error.blockerCode,
          );
          return;
        }
        throw error;
      }
    }
    const now = new Date();
    const staleLockBefore = new Date(now.getTime() - this.publishLeaseTtlMs);
    const locked = await this.prisma.vkParsingPost.updateMany({
      where: {
        id: params.postId,
        chatId: params.chatId,
        publishIdempotencyKey: params.idempotencyKey,
        publishReason: params.reason,
        dispatchProfile: expectedDispatchProfile,
        requiredBotId:
          expectedDispatchProfile === PublicationDispatchProfile.PUBLIK_V1
            ? params.requiredBotId
            : null,
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
        publishReason: params.reason,
        dispatchProfile: expectedDispatchProfile,
        requiredBotId:
          expectedDispatchProfile === PublicationDispatchProfile.PUBLIK_V1
            ? params.requiredBotId
            : null,
      },
      include: { source: true },
    });
    if (!post || post.status === VK_POST_STATUS_PUBLISHED) {
      return;
    }
    if (
      params.reason === 'autopublish' &&
      this.isBeyondAutoPublishRecoveryFreshnessHorizon(post, now)
    ) {
      const cleared = await this.clearQueuedAutoPublishPost(post.id, params.idempotencyKey, post);
      if (cleared) {
        this.logger.warn(
          { postId: post.id, chatId: post.chatId },
          'Cleared historical VK autopublish at the worker boundary',
        );
      }
      return;
    }
    if (
      params.reason === 'autopublish' &&
      post.source.publishMode === VK_SOURCE_PUBLISH_MODE_REVIEW
    ) {
      await this.clearQueuedAutoPublishPost(post.id, params.idempotencyKey, post);
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
          await this.clearQueuedAutoPublishPost(post.id, params.idempotencyKey, post);
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
      if (expectedDispatchProfile === PublicationDispatchProfile.PUBLIK_V1) {
        await this.assertPublisherIntentReady(post);
        await this.prisma.vkParsingPost.updateMany({
          where: {
            id: post.id,
            dispatchProfile: PublicationDispatchProfile.PUBLIK_V1,
            requiredBotId: post.requiredBotId,
            publishIdempotencyKey: params.idempotencyKey,
            publishReason: params.reason,
          },
          data: { dispatchBlockerCode: null, dispatchBlockedAt: null },
        });
      }
      const attemptRecorded = await this.recordPublishAttempt(
        post.id,
        params.reason,
        params.idempotencyKey,
      );
      if (!attemptRecorded) {
        return;
      }
      await this.publishQueuedPost(post, settings, params.reason, params.idempotencyKey);
    } catch (error) {
      if (error instanceof PublisherVkDispatchBlockedError) {
        await this.markPublisherIntentBlocked(
          post,
          params.idempotencyKey,
          params.reason,
          error.blockerCode,
        );
        return;
      }
      if (!this.isPublishFailurePersisted(error)) {
        const classified = classifyVkParsingPublishError(error);
        await this.markQueuedPostPublishFailed(post, classified, {
          auto: params.reason === 'autopublish',
          finalAttempt: this.isFinalPublishAttempt(params),
          idempotencyKey: params.idempotencyKey,
          reason: params.reason,
        });
      }
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
        const scheduledAt = await this.resolveInitialAutoPublishAt(post, settings);
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
        publishReason: 'autopublish',
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
        publishReason: 'autopublish',
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
    maxMessage: VkParsingMaxMessageText,
    params: {
      actorUserId: string;
      trafficClass: MaxApiTrafficClass;
      debugAction: string;
      auto: boolean;
      storedDraft?: VkParsingStoredDraft;
      queuedIdempotencyKey?: string;
    },
  ): Promise<PublishVkParsingPostResult> {
    const storedPhotoUrls = this.readStringArray(post.photoUrls);
    const storedVideoUrls = this.readStringArray(post.videoUrls);
    const storedLinkUrls = this.readStringArray(post.linkUrls);
    const baseOptions: MaxSendMessageOptions = {
      ...(maxMessage.textFormat ? { textFormat: maxMessage.textFormat } : {}),
      debugContext: {
        screen: 'vk_parsing',
        action: params.debugAction,
      },
    };
    const engagementContextByBotId = new Map<
      string,
      Awaited<ReturnType<AdminService['buildChannelPublicationEngagementContext']>>
    >();
    const photoMediaByUrl = this.resolvePhotoMediaIdentityMap({
      attachments: post.attachments,
      raw: post.raw,
      text: post.text,
    });
    const videoMediaByUrl = this.resolveVideoMediaIdentityMap({
      attachments: post.attachments,
      raw: post.raw,
      text: post.text,
    });

    let maxSendAttempted = false;
    let maxSendAttemptStartedAt: Date | null = null;
    let attemptedBotId: string | null = null;
    let entityType: ChatEntityType | null = null;
    try {
      entityType = await this.accessService.resolvePublicationEntityType(post.chatId);
      const result = await this.sendMessageWithAttachmentRetry({
        postId: post.id,
        chatId: post.chatId,
        logicalIdempotencyKey: this.buildMaxPublicationIdempotencyKey(post, payload, maxMessage),
        text: maxMessage.text,
        baseOptions,
        trafficClass: params.trafficClass,
        videoAttachment: payload.videoUrls.length > 0,
        publisherExactBotId:
          post.dispatchProfile === PublicationDispatchProfile.PUBLIK_V1 ? post.requiredBotId : null,
        beforeSendMutation:
          post.dispatchProfile === PublicationDispatchProfile.PUBLIK_V1
            ? async () => {
                await this.assertPublisherIntentReady(post);
              }
            : undefined,
        prepareAttempt: async (botId) => {
          const requestOptions = {
            botId,
            trafficClass: params.trafficClass,
            sourceTag: MAX_API_SOURCE_TAGS.VK_PARSING,
          };
          const options: MaxSendMessageOptions = { ...baseOptions };
          if (post.dispatchProfile === PublicationDispatchProfile.PUBLIK_V1) {
            const publisherDialogContext = this.readPublisherDialogContext(
              post.publishDialogContext,
              post.dialogBotId,
            );
            if (!publisherDialogContext) {
              throw new PublisherVkDispatchBlockedError(
                'dialog_context_unavailable',
                new Error('Publik VK intent is missing its main-signed dialog context'),
              );
            }
            if (publisherDialogContext.buttons.length > 0) {
              options.buttons = publisherDialogContext.buttons;
            }
          } else if (entityType === ChatEntityType.CHANNEL) {
            const engagementContext =
              await this.adminService.buildChannelPublicationEngagementContext(post.chatId, botId);
            engagementContextByBotId.set(botId, engagementContext);
            if (engagementContext.buttons.length > 0) {
              options.buttons = engagementContext.buttons;
            }
          }

          if (payload.videoUrls.length > 0) {
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
                canPublishWithoutPhotos:
                  maxMessage.text.trim().length > 0 || payload.linkUrls.length > 0,
              },
              photoMediaByUrl,
            );

            if (imagePayloads.length === 1) {
              options.imagePayload = imagePayloads[0];
            } else if (imagePayloads.length > 1) {
              options.attachments = imagePayloads.map(
                (attachmentPayload): MaxAttachmentPayload => ({
                  type: 'image',
                  payload: attachmentPayload,
                }),
              );
            }
          }
          return options;
        },
        onAttempt: (botId) => {
          maxSendAttemptStartedAt = new Date();
          attemptedBotId = botId;
          maxSendAttempted = true;
        },
      });
      const engagementContext = engagementContextByBotId.get(result.botId) ?? null;
      const publisherDialogContext =
        post.dispatchProfile === PublicationDispatchProfile.PUBLIK_V1
          ? this.readPublisherDialogContext(post.publishDialogContext, post.dialogBotId)
          : null;
      if (
        post.dispatchProfile === PublicationDispatchProfile.PUBLIK_V1 &&
        !publisherDialogContext
      ) {
        throw new PublisherVkDispatchBlockedError(
          'dialog_context_unavailable',
          new Error('Publik VK send completed without its persisted dialog context'),
        );
      }
      if (
        post.dispatchProfile !== PublicationDispatchProfile.PUBLIK_V1 &&
        !engagementContext &&
        entityType === ChatEntityType.CHANNEL
      ) {
        this.logger.warn(
          {
            postId: post.id,
            chatId: post.chatId,
            botId: result.botId,
            messageId: result.messageId,
          },
          'Skipped VK engagement binding recovery because the exact sent thread context was not persisted',
        );
      }
      if (publisherDialogContext) {
        await this.recordPublisherDialogContextSafely({
          chatId: post.chatId,
          actorUserId: params.actorUserId,
          messageId: result.messageId,
          text: maxMessage.engagementText,
          publishedUrl: result.url,
          context: publisherDialogContext,
          dispatchBotId: result.botId,
        });
      } else if (engagementContext) {
        await this.recordChannelPublicationEngagementSafely({
          chatId: post.chatId,
          actorUserId: params.actorUserId,
          messageId: result.messageId,
          text: maxMessage.engagementText,
          publishedUrl: result.url,
          engagementContext,
          botId: result.botId,
        });
      }
      const publishedAtMax = new Date();
      if (
        post.dispatchProfile === PublicationDispatchProfile.PUBLIK_V1 &&
        maxSendAttemptStartedAt
      ) {
        await this.recordPublisherSendSuccessSafely(post.chatId, maxSendAttemptStartedAt);
      }
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
        ...(params.storedDraft ?? {}),
        status: VK_POST_STATUS_PUBLISHED,
        publishedContentHash,
        publishedMessageId: result.messageId,
        publishedBotId: result.botId,
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
        dispatchBlockerCode: null,
        dispatchBlockedAt: null,
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
          ...(params.storedDraft ?? {}),
          status: VK_POST_STATUS_PUBLISHED,
          publishedContentHash,
          publishedMessageId: result.messageId,
          publishedBotId: result.botId,
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
          dispatchBlockerCode: null,
          dispatchBlockedAt: null,
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
        queued: 0,
        messageId: result.messageId,
        url: result.url,
      };
    } catch (error) {
      if (error instanceof PublisherVkDispatchBlockedError) {
        throw error;
      }
      if (post.dispatchProfile === PublicationDispatchProfile.PUBLIK_V1) {
        const healthClassification = await this.recordPublisherSendFailureSafely(
          post.chatId,
          error,
          maxSendAttemptStartedAt ?? new Date(),
        );
        if (healthClassification === 'global_paused' || healthClassification === 'setup_required') {
          throw new PublisherVkDispatchBlockedError(
            healthClassification === 'global_paused'
              ? 'publisher_auth_paused'
              : 'publisher_setup_required',
            error,
          );
        }
      }
      const classified = classifyVkParsingPublishError(error);
      const formattedError = formatVkParsingClassifiedErrorMessage(classified);
      const ambiguousMaxSend = maxSendAttempted && isAmbiguousMaxSendError(error);
      const ambiguousAutopublishSend = params.auto && ambiguousMaxSend;
      const ambiguousSafetyDeskSend =
        params.actorUserId === SAFETY_DESK_ACTOR_USER_ID && ambiguousMaxSend;
      const persistedError = ambiguousMaxSend
        ? `${MAX_SEND_AMBIGUOUS_ERROR_PREFIX} ${formattedError}. Delivery may have been accepted by MAX; ${
            ambiguousAutopublishSend
              ? 'autopublish retry is quarantined for manual verification.'
              : ambiguousSafetyDeskSend
                ? 'Safety Desk retry is blocked until manual verification.'
                : 'manual retry requires verification before resending.'
          }`.slice(0, 500)
        : formattedError;
      const routedAccessLossRecorded =
        Boolean(error) &&
        typeof error === 'object' &&
        (error as { maxManagedEntityAccessLossRecorded?: unknown })
          .maxManagedEntityAccessLossRecorded === true;
      const accessLossResult =
        post.dispatchProfile === PublicationDispatchProfile.PUBLIK_V1 ||
        routedAccessLossRecorded ||
        !maxSendAttempted ||
        entityType === null
          ? null
          : await this.managedEntityAccessLossService?.recordIfManagedEntityAccessLost?.({
              chatId: post.chatId,
              botId: attemptedBotId,
              entityType,
              source: 'vk_parsing:publish',
              operation: 'send',
              error,
              ...(maxSendAttemptStartedAt
                ? {
                    lifecycleEventAt: maxSendAttemptStartedAt,
                    lifecycleEventType: 'live_probe',
                    lifecycleSource: 'live_probe',
                  }
                : {}),
            });
      const accessLossRecorded = routedAccessLossRecorded || Boolean(accessLossResult?.recorded);
      const queueOwnsOrdinaryFailure = Boolean(params.queuedIdempotencyKey);
      if (!queueOwnsOrdinaryFailure || ambiguousMaxSend || accessLossRecorded) {
        // FLAG: A queued ordinary failure is persisted by the BullMQ boundary, which knows whether
        // this is the final attempt. Ambiguous dispatch and access loss are terminal immediately.
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
            publishQueuedAt: null,
            publishScheduledAt: null,
            publishIdempotencyKey: null,
            publishReason: null,
          },
        });
        if (failed.count === 0) {
          this.logger.warn(
            { postId: post.id, chatId: post.chatId, err: error },
            'VK parsing post disappeared before publish failure persistence',
          );
        } else if (error !== null && typeof error === 'object') {
          this.persistedPublishFailures.add(error);
        }
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

  private async recordPublisherDialogContextSafely(params: {
    chatId: string;
    actorUserId: string;
    messageId: string;
    text?: string | null;
    publishedUrl?: string | null;
    context: PublisherPreparedDialogContext;
    dispatchBotId: string;
  }): Promise<void> {
    const reference = params.context.reference;
    if (!reference) {
      return;
    }
    const commonPayload = {
      messageId: params.messageId,
      threadId: reference.threadId,
      source: 'vk_parsing',
      ...(params.text?.trim() ? { text: params.text } : {}),
      ...(params.publishedUrl ? { publishedUrl: params.publishedUrl } : {}),
      botId: params.dispatchBotId,
      dialogBotId: params.context.dialogBotId,
      ...(reference.customButtons.length > 0 ? { customButtons: reference.customButtons } : {}),
    };
    const payload =
      reference.entityType === 'channel'
        ? {
            ...commonPayload,
            includeCommentsButton: reference.includeCommentsButton,
            includeSuggestButton: reference.includeSuggestButton,
            suggestionEntryMode: reference.suggestionEntryMode,
            ...(reference.suggestButtonText
              ? { suggestButtonText: reference.suggestButtonText }
              : {}),
          }
        : commonPayload;
    try {
      await this.prisma.auditLog.create({
        data: {
          chatId: params.chatId,
          actorUserId: params.actorUserId,
          action:
            reference.entityType === 'channel'
              ? CHANNEL_DIALOG_ACTION_AUTO_ATTACH
              : CHAT_DIALOG_ACTION_AUTO_ATTACH,
          payload,
        },
      });
    } catch (error) {
      this.logger.warn(
        { chatId: params.chatId, messageId: params.messageId, err: error },
        'Failed to persist Publik VK dialog context',
      );
    }
  }

  private async sendMessageWithAttachmentRetry(params: {
    postId: string;
    chatId: string;
    logicalIdempotencyKey: string;
    text: string;
    baseOptions: MaxSendMessageOptions;
    trafficClass: MaxApiTrafficClass;
    videoAttachment: boolean;
    publisherExactBotId: string | null;
    beforeSendMutation?: () => Promise<void>;
    prepareAttempt: (botId: string) => Promise<MaxSendMessageOptions>;
    onAttempt?: (botId: string) => void;
  }): Promise<MaxRoutedPublicationResult> {
    if (params.publisherExactBotId && !this.maxRoutedPublicationService) {
      throw new ServiceUnavailableException(
        'Routed MAX publication service is required for Publik VK publications',
      );
    }
    if (!this.maxRoutedPublicationService && process.env.NODE_ENV === 'production') {
      throw new ServiceUnavailableException(
        'Routed MAX publication service is required for production VK publications',
      );
    }
    let lastError: unknown = null;
    const readinessRetryDelaysMs = params.videoAttachment
      ? BROADCAST_VIDEO_SEND_RETRY_DELAYS_MS
      : VK_ATTACHMENT_SEND_RETRY_DELAYS_MS;
    const attempts = readinessRetryDelaysMs.length + 1;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        if (this.maxRoutedPublicationService) {
          return await this.maxRoutedPublicationService.publish({
            entityId: params.chatId,
            logicalIdempotencyKey: params.logicalIdempotencyKey,
            text: params.text || ' ',
            options: params.baseOptions,
            trafficClass: params.trafficClass,
            sourceTag: MAX_API_SOURCE_TAGS.VK_PARSING,
            ...(params.publisherExactBotId
              ? { publisherExactBotId: params.publisherExactBotId }
              : {}),
            prepareAttempt: async ({ botId }) => ({
              options: await params.prepareAttempt(botId),
            }),
            onDispatchAttempt: ({ botId }) => {
              params.onAttempt?.(botId);
            },
            ...(params.beforeSendMutation
              ? {
                  beforeSendMutation: async () => {
                    await params.beforeSendMutation!();
                  },
                }
              : {}),
          });
        }

        const botId = await this.maxBotLinkService.resolveBotIdForSend({
          chatId: params.chatId,
        });
        if (!botId) {
          throw new Error('No bot with send access is available for VK publish');
        }
        const options = await params.prepareAttempt(botId);
        params.onAttempt?.(botId);
        const published = await this.maxClient.sendMessageImmediateWithResolvedLink(
          params.chatId,
          params.text || ' ',
          options,
          {
            botId,
            trafficClass: params.trafficClass,
            sourceTag: MAX_API_SOURCE_TAGS.VK_PARSING,
          },
        );
        return {
          ...published,
          botId,
          candidateBotIds: [botId],
          routingVersion: null,
        };
      } catch (error) {
        lastError = error;
        if (!isMaxAttachmentNotReadyError(error) || attempt >= attempts) {
          throw error;
        }
        await this.sleep(readinessRetryDelaysMs[attempt - 1]!);
      }
    }

    throw lastError instanceof Error ? lastError : new Error('MAX attachment is not ready.');
  }

  private async lockManualPublishPost(
    postId: string,
    chatId: string,
    storedDraft: VkParsingStoredDraft,
  ): Promise<Date | null> {
    const publishLockAt = new Date();
    const locked = await this.prisma.vkParsingPost.updateMany({
      where: {
        id: postId,
        chatId,
        status: { notIn: [VK_POST_STATUS_PUBLISHED, VK_POST_STATUS_UNAVAILABLE] },
        publishLockedAt: null,
      },
      data: {
        ...storedDraft,
        manualContentEditedAt: publishLockAt,
        publishLockedAt: publishLockAt,
      },
    });
    return locked.count > 0 ? publishLockAt : null;
  }

  private async releaseManualPublishLock(
    postId: string,
    chatId: string,
    publishLockAt: Date,
    previousPublishReason: string | null,
  ): Promise<void> {
    await this.prisma.vkParsingPost.updateMany({
      where: {
        id: postId,
        chatId,
        publishLockedAt: publishLockAt,
      },
      data: {
        publishLockedAt: null,
        publishReason: previousPublishReason,
      },
    });
  }

  private async armManualPublishRecovery(
    post: Pick<
      VkParsingPostWithSource,
      | 'id'
      | 'chatId'
      | 'publishCancelledAt'
      | 'publishIdempotencyKey'
      | 'publishQueuedAt'
      | 'publishReason'
      | 'publishScheduledAt'
    >,
    publishLockAt: Date,
    publishIdempotencyKey: string,
  ): Promise<boolean> {
    // FLAG: Persist the logical MAX send before dispatch. A stale lock with this key is replayed
    // through MaxActionLedger, which recovers the original result instead of duplicating the send.
    const armed = await this.prisma.vkParsingPost.updateMany({
      where: {
        id: post.id,
        chatId: post.chatId,
        status: { notIn: [VK_POST_STATUS_PUBLISHED, VK_POST_STATUS_UNAVAILABLE] },
        publishLockedAt: publishLockAt,
        publishQueuedAt: post.publishQueuedAt,
        publishScheduledAt: post.publishScheduledAt,
        publishIdempotencyKey: post.publishIdempotencyKey,
        publishReason: post.publishReason,
        publishCancelledAt: post.publishCancelledAt,
      },
      data: {
        publishQueuedAt: publishLockAt,
        publishScheduledAt: publishLockAt,
        publishCancelledAt: null,
        publishCancelledByUserId: null,
        publishIdempotencyKey,
        publishReason: 'manual-retry',
      },
    });
    return armed.count > 0;
  }

  private async enqueuePostPublish(
    post: VkParsingPostWithSource,
    reason: VkParsingPublishReason,
    scheduledAt: Date = new Date(),
    options: {
      actorUserId?: string;
      storedDraft?: VkParsingStoredDraft;
    } = {},
  ): Promise<number> {
    this.assertNoAmbiguousMaxSendQuarantine(post);
    const route = await this.resolvePublishIntentRoute(post);
    const idempotencyKey = this.buildPublishIdempotencyKey(post, reason, scheduledAt);
    const now = new Date();
    const expectedRoute = this.readPersistedIntentRoute(post);
    const queued = await this.prisma.vkParsingPost.updateMany({
      where: {
        id: post.id,
        publishLockedAt: null,
        status: { notIn: [VK_POST_STATUS_PUBLISHED, VK_POST_STATUS_UNAVAILABLE] },
        dispatchProfile: expectedRoute.dispatchProfile,
        requiredBotId: expectedRoute.requiredBotId,
        dialogBotId: expectedRoute.dialogBotId,
        publicationPolicyRevision: expectedRoute.publicationPolicyRevision,
        ...(reason === 'autopublish' ? { publishIdempotencyKey: null } : {}),
      },
      data: {
        ...(options.storedDraft
          ? {
              ...options.storedDraft,
              manualContentEditedAt: now,
            }
          : {}),
        status: post.status === VK_POST_STATUS_FAILED ? VK_POST_STATUS_NEW : post.status,
        publishQueuedAt: now,
        publishScheduledAt: scheduledAt,
        publishCancelledAt: null,
        publishCancelledByUserId: null,
        publishLockedAt: null,
        publishIdempotencyKey: idempotencyKey,
        publishReason: reason,
        dispatchProfile: route.dispatchProfile,
        requiredBotId: route.requiredBotId,
        dialogBotId: route.dialogBotId,
        ...(route.publishDialogContext
          ? {
              publishDialogContext: route.publishDialogContext as Prisma.InputJsonValue,
            }
          : {}),
        publicationPolicyRevision: route.publicationPolicyRevision,
        publishActorUserId:
          options.actorUserId?.trim() ||
          (reason === 'autopublish' ? VK_PARSING_SYSTEM_ACTOR_USER_ID : null),
        dispatchBlockerCode: null,
        dispatchBlockedAt: null,
        lastError: null,
        autoPublishError: reason === 'autopublish' ? null : post.autoPublishError,
      },
    });
    if (queued.count === 0) {
      return 0;
    }

    await this.addPublishJob(post, reason, idempotencyKey, now, scheduledAt, route);

    return 1;
  }

  private async resolvePublishIntentRoute(
    post: VkParsingPostWithSource,
  ): Promise<VkPublishIntentRoute> {
    const persisted = this.readPersistedIntentRoute(post);
    const hasActiveIntent = Boolean(
      post.publishIdempotencyKey?.trim() || post.publishQueuedAt || post.publishReason?.trim(),
    );
    if (hasActiveIntent || !this.newDispatchRoute) {
      return persisted;
    }
    if (!this.publisherReadinessService) {
      throw new ServiceUnavailableException('Publik readiness service is unavailable.');
    }

    const ready = await this.publisherReadinessService.assertEntityReady(post.chatId, 'vk_publish');
    try {
      if (!this.publisherDispatchHealthService) {
        throw new Error('Publisher dispatch health service is unavailable');
      }
      await this.publisherDispatchHealthService.assertDispatchAllowed();
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code === 'PUBLISHER_DISPATCH_PAUSED') {
        throw new PublisherSetupRequiredException([post.chatId], 'publisher_auth_paused');
      }
      throw new ServiceUnavailableException('Publik dispatch health is unavailable.');
    }
    if (ready.requiredBotId !== this.newDispatchRoute.requiredBotId) {
      throw new PublisherSetupRequiredException([post.chatId], 'publisher_bot_changed');
    }
    const dialogBotId = await this.maxBotLinkService.resolveBotIdForSend({ chatId: post.chatId });
    if (!dialogBotId || dialogBotId === ready.requiredBotId) {
      throw new PublisherSetupRequiredException([post.chatId], 'dialog_bot_unavailable');
    }
    if (!this.publisherDialogContextService) {
      throw new ServiceUnavailableException('Publik dialog context service is unavailable.');
    }
    const publishDialogContext = await this.publisherDialogContextService.prepare({
      chatId: post.chatId,
      entityType: ready.entityType,
      dialogBotId,
      customButtons: [],
    });
    return {
      dispatchProfile: this.newDispatchRoute.dispatchProfile,
      requiredBotId: ready.requiredBotId,
      dialogBotId,
      publishDialogContext,
      publicationPolicyRevision: ready.policyRevision,
    };
  }

  private readPersistedIntentRoute(
    post: Partial<
      Pick<
        VkParsingPostWithSource,
        | 'dispatchProfile'
        | 'requiredBotId'
        | 'dialogBotId'
        | 'publishDialogContext'
        | 'publicationPolicyRevision'
      >
    >,
  ): VkPublishIntentRoute {
    const dispatchProfile =
      post.dispatchProfile === PublicationDispatchProfile.PUBLIK_V1
        ? PublicationDispatchProfile.PUBLIK_V1
        : PublicationDispatchProfile.LEGACY_ROUTED;
    return {
      dispatchProfile,
      requiredBotId:
        dispatchProfile === PublicationDispatchProfile.PUBLIK_V1
          ? post.requiredBotId?.trim() || null
          : null,
      dialogBotId: post.dialogBotId?.trim() || null,
      publishDialogContext: this.readPublisherDialogContext(
        post.publishDialogContext,
        post.dialogBotId,
      ),
      publicationPolicyRevision:
        typeof post.publicationPolicyRevision === 'number' ? post.publicationPolicyRevision : null,
    };
  }

  private readPublisherDialogContext(
    raw: unknown,
    dialogBotId: string | null | undefined,
  ): PublisherPreparedDialogContext | null {
    const expectedDialogBotId = dialogBotId?.trim() ?? '';
    return expectedDialogBotId
      ? (this.publisherDialogContextService?.read(raw, expectedDialogBotId) ?? null)
      : null;
  }

  private assertNoAmbiguousMaxSendQuarantine(
    post: Pick<VkParsingPostWithSource, 'lastError'>,
  ): void {
    if (post.lastError?.trim().startsWith(MAX_SEND_AMBIGUOUS_ERROR_PREFIX) === true) {
      throw new BadRequestException(MAX_SEND_AMBIGUOUS_RETRY_BLOCK_MESSAGE);
    }
  }

  private async addPublishJob(
    post: Pick<VkParsingPostWithSource, 'id' | 'chatId'> &
      Partial<
        Pick<
          VkParsingPostWithSource,
          | 'dispatchProfile'
          | 'requiredBotId'
          | 'dialogBotId'
          | 'publishDialogContext'
          | 'publicationPolicyRevision'
        >
      >,
    reason: VkParsingPublishReason,
    idempotencyKey: string,
    createdAt: Date,
    scheduledAt: Date | null = null,
    route: VkPublishIntentRoute = this.readPersistedIntentRoute(post),
  ): Promise<VkPublishJobEnqueueOutcome> {
    const delay = scheduledAt ? Math.max(0, scheduledAt.getTime() - Date.now()) : 0;
    const job = this.buildPublishJob(post, reason, idempotencyKey, createdAt, route);
    const jobId = this.buildPublishJobId(post.id, idempotencyKey);
    const queue = this.resolvePublishQueue(route.dispatchProfile);
    const recoveryOutcome = await this.recoverExistingPublishJob(queue, jobId, job, scheduledAt);
    if (recoveryOutcome !== 'missing') {
      return recoveryOutcome;
    }

    await queue.add(VK_PUBLISH_JOB_NAME, job, {
      jobId,
      delay,
      ...VK_PARSING_PUBLISH_RETRY_POLICY,
    });
    return 'created';
  }

  private buildPublishJob(
    post: Pick<VkParsingPostWithSource, 'id' | 'chatId'>,
    reason: VkParsingPublishReason,
    idempotencyKey: string,
    createdAt: Date,
    route: VkPublishIntentRoute,
  ): VkParsingPublishJob | VkParsingPublisherPublishJob {
    const base: VkParsingPublishJob = {
      postId: post.id,
      chatId: post.chatId,
      reason,
      idempotencyKey,
      retryPolicyName: 'vk-parsing-publish',
      createdAt: createdAt.toISOString(),
    };
    if (route.dispatchProfile !== PublicationDispatchProfile.PUBLIK_V1) {
      return base;
    }
    if (!route.requiredBotId) {
      throw new Error(`Publik VK intent ${post.id} is missing requiredBotId`);
    }
    return {
      ...base,
      kind: 'publish',
      dispatchProfile: 'PUBLIK_V1',
      requiredBotId: route.requiredBotId,
    };
  }

  private resolvePublishQueue(dispatchProfile: PublicationDispatchProfile): Queue<unknown> {
    if (dispatchProfile === PublicationDispatchProfile.PUBLIK_V1) {
      if (!this.publisherQueue) {
        throw new ServiceUnavailableException('Publik VK queue is unavailable.');
      }
      return this.publisherQueue as unknown as Queue<unknown>;
    }
    return this.publishQueue as unknown as Queue<unknown>;
  }

  private async recoverExistingPublishJob(
    queue: Queue<unknown>,
    jobId: string,
    job: VkParsingPublishJob | VkParsingPublisherPublishJob,
    scheduledAt: Date | null,
  ): Promise<VkPublishJobRecoveryOutcome> {
    try {
      const existingJob = await queue.getJob(jobId);
      if (!existingJob) {
        return 'missing';
      }

      const state = await existingJob.getState();
      if (state === 'unknown') {
        await existingJob.remove();
        this.logger.warn(
          { jobId, postId: job.postId },
          'Removed orphaned VK parsing publish job before recovery',
        );
        return 'missing';
      }
      if (
        !this.isMatchingPublishJob(
          existingJob.data as VkParsingPublishJob | VkParsingPublisherJob,
          job,
        )
      ) {
        if (state === 'active') {
          this.logger.error(
            { jobId, postId: job.postId, state },
            'Quarantined active VK parsing publish job with mismatched ownership payload',
          );
          return 'conflict';
        }
        await existingJob.remove();
        this.logger.warn(
          { jobId, postId: job.postId, state },
          'Removed inactive VK parsing publish job with mismatched ownership payload',
        );
        return 'missing';
      }
      if (!this.isMatchingPublishJobSchedule(existingJob, state, scheduledAt)) {
        if (state === 'active') {
          this.logger.error(
            { jobId, postId: job.postId, state, scheduledAt },
            'Quarantined active VK parsing publish job with schedule drift',
          );
          return 'conflict';
        }
        await existingJob.remove();
        this.logger.warn(
          { jobId, postId: job.postId, state, scheduledAt },
          'Removed inactive VK parsing publish job with schedule drift',
        );
        return 'missing';
      }
      if (state === 'failed' || state === 'completed') {
        await existingJob.updateData(job);
        await existingJob.retry(state, {
          resetAttemptsMade: true,
          resetAttemptsStarted: true,
        });
        return 'retried';
      }

      return 'healthy';
    } catch (error: unknown) {
      this.logger.warn(
        {
          jobId,
          postId: job.postId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to recover VK parsing publish job',
      );
      return 'failed';
    }
  }

  private isMatchingPublishJob(
    actual: VkParsingPublishJob | VkParsingPublisherJob | null | undefined,
    expected: VkParsingPublishJob | VkParsingPublisherPublishJob,
  ): boolean {
    if (!actual || ('kind' in actual && actual.kind === 'rollback-delete')) {
      return false;
    }
    const baseMatches =
      actual.postId === expected.postId &&
      actual.chatId === expected.chatId &&
      actual.reason === expected.reason &&
      actual.idempotencyKey === expected.idempotencyKey;
    if (!baseMatches) {
      return false;
    }
    if ('kind' in expected) {
      return (
        'kind' in actual &&
        actual.kind === 'publish' &&
        actual.dispatchProfile === expected.dispatchProfile &&
        actual.requiredBotId === expected.requiredBotId
      );
    }
    return !('kind' in actual);
  }

  private isMatchingPublishJobSchedule(
    existingJob: {
      timestamp?: number;
      delay?: number;
      attemptsMade?: number;
      attemptsStarted?: number;
      processedOn?: number;
    },
    state: string,
    scheduledAt: Date | null,
  ): boolean {
    if (state === 'active') {
      return true;
    }
    const nowMs = Date.now();
    const expectedAtMs = scheduledAt?.getTime() ?? nowMs;
    if (state === 'delayed') {
      if (
        Number(existingJob.attemptsMade) > 0 ||
        Number(existingJob.attemptsStarted) > 0 ||
        (typeof existingJob.processedOn === 'number' && existingJob.processedOn > 0)
      ) {
        return true;
      }
      const timestamp = Number(existingJob.timestamp);
      const delay = Number(existingJob.delay);
      if (!Number.isFinite(timestamp) || !Number.isFinite(delay)) {
        return true;
      }
      return Math.abs(timestamp + delay - expectedAtMs) <= VK_PUBLISH_SCHEDULE_DRIFT_TOLERANCE_MS;
    }
    if (state === 'failed' || state === 'completed') {
      return expectedAtMs <= nowMs + 1_000;
    }
    return true;
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
      Math.max(
        settings.distributeEvenlyEnabled ? publishIntervalMinutes : 0,
        minPublishIntervalMinutes,
      ) * 60_000,
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
      sourceLastAt.getTime() + sourceSpacingMs,
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
    const nextIdempotencyKey = this.buildPublishIdempotencyKey(post, reason, scheduledAt);
    const deferred = await this.prisma.vkParsingPost.updateMany({
      where: {
        id: post.id,
        publishIdempotencyKey: currentIdempotencyKey,
        publishReason: reason,
      },
      data: {
        publishScheduledAt: scheduledAt,
        publishLockedAt: null,
        publishIdempotencyKey: nextIdempotencyKey,
        publishReason: reason,
      },
    });
    if (deferred.count === 0) {
      return;
    }
    await this.addPublishJob(post, reason, nextIdempotencyKey, new Date(), scheduledAt);
  }

  private async recordPublishAttempt(
    postId: string,
    reason: VkParsingPublishReason,
    idempotencyKey: string,
  ): Promise<boolean> {
    const updated = await this.prisma.vkParsingPost.updateMany({
      where: { id: postId, publishIdempotencyKey: idempotencyKey, publishReason: reason },
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
      throw new BadRequestException(
        'Публикация этого источника доступна только через Safety Desk.',
      );
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

  private async publishQueuedPost(
    post: VkParsingPostWithSource,
    settings: VkParsingSettingsLike,
    reason: VkParsingPublishReason,
    idempotencyKey: string,
  ): Promise<void> {
    const auto = reason === 'autopublish';
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
        textFormat: resolveEffectiveVkParsingTextFormat({
          text: post.text,
          textFormat: post.textFormat,
          manualContentEditedAt: post.manualContentEditedAt,
        }),
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
    const maxMessage = await this.prepareMaxMessageText(
      post.chatId,
      prepared,
      settings,
      'background',
    );

    await this.publishPreparedPostToMax(post, prepared, maxMessage, {
      actorUserId:
        post.publishActorUserId ??
        (!auto && post.source.publishMode === VK_SOURCE_PUBLISH_MODE_REVIEW
          ? SAFETY_DESK_ACTOR_USER_ID
          : VK_PARSING_SYSTEM_ACTOR_USER_ID),
      trafficClass: 'background',
      debugAction: auto ? 'auto_publish_post' : 'queued_manual_publish_post',
      auto,
      queuedIdempotencyKey: idempotencyKey,
    });
  }

  private assertPublisherRuntimeBeforeClaim(): void {
    try {
      if (!this.publisherRuntimeBoundaryService) {
        throw new Error('Publisher runtime boundary is unavailable');
      }
      this.publisherRuntimeBoundaryService.assertDispatchEnabled();
    } catch (error) {
      throw new PublisherVkDispatchBlockedError('publisher_runtime_unavailable', error);
    }
  }

  private async assertPublisherIntentReady(
    post: Pick<
      VkParsingPostWithSource,
      'chatId' | 'dispatchProfile' | 'requiredBotId' | 'dialogBotId' | 'publishDialogContext'
    >,
  ): Promise<PublisherReadyRoute> {
    this.assertPublisherRuntimeBeforeClaim();
    await this.assertPublisherHealthAllowed();
    if (
      post.dispatchProfile !== PublicationDispatchProfile.PUBLIK_V1 ||
      !post.requiredBotId?.trim() ||
      !post.dialogBotId?.trim() ||
      post.requiredBotId === post.dialogBotId ||
      !this.readPublisherDialogContext(post.publishDialogContext, post.dialogBotId)
    ) {
      throw new PublisherVkDispatchBlockedError(
        'publisher_route_invalid',
        new Error('Publik VK intent has an invalid immutable route'),
      );
    }
    if (!this.publisherReadinessService) {
      throw new PublisherVkDispatchBlockedError(
        'publisher_runtime_unavailable',
        new Error('Publisher readiness service is unavailable'),
      );
    }

    let ready: PublisherReadyRoute;
    try {
      ready = await this.publisherReadinessService.assertEntityReady(post.chatId, 'vk_publish');
    } catch (error) {
      throw new PublisherVkDispatchBlockedError(
        error instanceof PublisherSetupRequiredException
          ? error.blockerCode
          : 'publisher_runtime_unavailable',
        error,
      );
    }
    if (ready.requiredBotId !== post.requiredBotId) {
      throw new PublisherVkDispatchBlockedError(
        'publisher_bot_changed',
        new Error('Publik VK intent required bot no longer matches readiness'),
      );
    }
    return ready;
  }

  private async assertPublisherHealthAllowed(): Promise<void> {
    try {
      if (!this.publisherDispatchHealthService) {
        throw new Error('Publisher dispatch health service is unavailable');
      }
      await this.publisherDispatchHealthService.assertDispatchAllowed();
    } catch (error) {
      throw new PublisherVkDispatchBlockedError(
        (error as { code?: unknown } | null)?.code === 'PUBLISHER_DISPATCH_PAUSED'
          ? 'publisher_auth_paused'
          : 'publisher_runtime_unavailable',
        error,
      );
    }
  }

  private async recordPublisherSendFailureSafely(
    chatId: string,
    error: unknown,
    observedAt: Date,
  ): Promise<PublisherFailureClassification> {
    try {
      return (
        (await this.publisherDispatchHealthService?.recordSendFailure(chatId, error, observedAt)) ??
        'transient'
      );
    } catch (healthError) {
      this.logger.warn(
        { chatId, err: healthError },
        'Failed to persist Publik VK dispatch health failure',
      );
      return 'transient';
    }
  }

  private async recordPublisherSendSuccessSafely(chatId: string, attemptedAt: Date): Promise<void> {
    try {
      await this.publisherDispatchHealthService?.recordSendSuccess(chatId, attemptedAt);
    } catch (error) {
      this.logger.warn({ chatId, err: error }, 'Failed to persist Publik VK dispatch success');
    }
  }

  private async markPublisherIntentBlocked(
    post: Pick<VkParsingPostWithSource, 'id' | 'dispatchProfile' | 'requiredBotId'>,
    idempotencyKey: string,
    reason: VkParsingPublishReason,
    blockerCode: string,
  ): Promise<void> {
    const normalizedBlocker = blockerCode.trim().slice(0, 96) || 'publisher_setup_required';
    await this.prisma.vkParsingPost.updateMany({
      where: {
        id: post.id,
        dispatchProfile: PublicationDispatchProfile.PUBLIK_V1,
        requiredBotId: post.requiredBotId,
        publishIdempotencyKey: idempotencyKey,
        publishReason: reason,
        status: { notIn: [VK_POST_STATUS_PUBLISHED, VK_POST_STATUS_UNAVAILABLE] },
      },
      data: {
        publishLockedAt: null,
        dispatchBlockerCode: normalizedBlocker,
        dispatchBlockedAt: new Date(),
        lastError: `[publisher.blocked] ${normalizedBlocker}`,
      },
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
    options: {
      auto: boolean;
      finalAttempt: boolean;
      idempotencyKey: string;
      reason: VkParsingPublishReason;
    },
  ): Promise<void> {
    const message = formatVkParsingClassifiedErrorMessage(error);
    const shouldClearQueue = !error.retryable || options.finalAttempt;
    const updated = await this.prisma.vkParsingPost.updateMany({
      where: {
        id: post.id,
        publishIdempotencyKey: options.idempotencyKey,
        publishReason: options.reason,
        status: { notIn: [VK_POST_STATUS_PUBLISHED, VK_POST_STATUS_UNAVAILABLE] },
        AND: [
          {
            OR: [
              { lastError: null },
              { NOT: { lastError: { startsWith: MAX_SEND_AMBIGUOUS_ERROR_PREFIX } } },
            ],
          },
        ],
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

  private isPublishFailurePersisted(error: unknown): boolean {
    return error !== null && typeof error === 'object' && this.persistedPublishFailures.has(error);
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
    expected?: Pick<VkParsingPostWithSource, 'publishLockedAt' | 'publishScheduledAt' | 'status'>,
  ): Promise<boolean> {
    const cleared = await this.prisma.vkParsingPost.updateMany({
      where: {
        id: postId,
        publishReason: 'autopublish',
        ...(idempotencyKey ? { publishIdempotencyKey: idempotencyKey } : {}),
        ...(expected
          ? {
              publishLockedAt: expected.publishLockedAt,
              publishScheduledAt: expected.publishScheduledAt,
              status: expected.status,
            }
          : {}),
      },
      data: {
        publishQueuedAt: null,
        publishScheduledAt: null,
        publishLockedAt: null,
        publishIdempotencyKey: null,
        publishReason: null,
      },
    });
    return cleared.count > 0;
  }

  private async clearRecoverableQueuedAutoPublishPost(
    postId: string,
    idempotencyKey: string,
    expected: Pick<
      VkParsingPostWithSource,
      | 'chatId'
      | 'dispatchProfile'
      | 'requiredBotId'
      | 'publishLockedAt'
      | 'publishScheduledAt'
      | 'status'
    >,
  ): Promise<boolean> {
    const jobId = this.buildPublishJobId(postId, idempotencyKey);
    try {
      const queue = this.resolvePublishQueue(expected.dispatchProfile);
      const existingJob = await queue.getJob(jobId);
      if (!existingJob) {
        return this.clearQueuedAutoPublishPost(postId, idempotencyKey, expected);
      }
      const expectedJob: VkParsingPublishJob | VkParsingPublisherPublishJob =
        expected.dispatchProfile === PublicationDispatchProfile.PUBLIK_V1
          ? {
              kind: 'publish',
              dispatchProfile: 'PUBLIK_V1',
              requiredBotId: expected.requiredBotId ?? '',
              postId,
              chatId: expected.chatId,
              reason: 'autopublish',
              idempotencyKey,
            }
          : {
              postId,
              chatId: expected.chatId,
              reason: 'autopublish',
              idempotencyKey,
            };
      if (
        !this.isMatchingPublishJob(
          existingJob.data as VkParsingPublishJob | VkParsingPublisherJob,
          expectedJob,
        )
      ) {
        this.logger.error(
          { postId, jobId },
          'Skipped VK autopublish ownership cleanup because its queue payload does not match',
        );
        return false;
      }
      if ((await existingJob.getState()) === 'active') {
        this.logger.warn(
          { postId, jobId },
          'Skipped VK autopublish ownership cleanup because its queue job is active',
        );
        return false;
      }
      // BullMQ remove is the execution fence: it fails if a worker acquires the job after getState.
      await existingJob.remove();
    } catch (error: unknown) {
      this.logger.warn(
        {
          postId,
          jobId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Skipped VK autopublish ownership cleanup because its queue job could not be fenced',
      );
      return false;
    }
    return this.clearQueuedAutoPublishPost(postId, idempotencyKey, expected);
  }

  private buildPublishJobId(postId: string, idempotencyKey: string): string {
    return `vk-parsing-publish__${postId}__${idempotencyKey}`;
  }

  private buildPublishIdempotencyKey(
    post: VkParsingPostWithSource,
    reason: VkParsingPublishReason,
    scheduledAt: Date,
  ): string {
    return createHash('sha256')
      .update(
        JSON.stringify({
          postId: post.id,
          chatId: post.chatId,
          contentHash: post.contentHash,
          status: post.status,
          reason,
          scheduledAt: scheduledAt.toISOString(),
          stateUpdatedAt: post.updatedAt.toISOString(),
        }),
      )
      .digest('hex')
      .slice(0, 32);
  }

  private buildMaxPublicationIdempotencyKey(
    post: VkParsingPostWithSource,
    payload: PreparedVkPublishPayload,
    maxMessage: VkParsingMaxMessageText,
  ): string {
    const intentKey =
      post.publishIdempotencyKey?.trim() ||
      this.buildMaxPublicationIntentKey(post.id, payload, maxMessage);
    return `vk-parsing:publish:${post.id}:${intentKey}`;
  }

  private buildMaxPublicationIntentKey(
    postId: string,
    payload: PreparedVkPublishPayload,
    maxMessage: VkParsingMaxMessageText,
  ): string {
    return createHash('sha256')
      .update(
        JSON.stringify({
          postId,
          text: payload.text,
          textFormat: payload.textFormat,
          maxText: maxMessage.text,
          maxTextFormat: maxMessage.textFormat ?? null,
          photoUrls: payload.photoUrls,
          videoUrls: payload.videoUrls,
          linkUrls: payload.linkUrls,
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
        const cache = await this.assertMediaReadyForPublish(
          candidateUrl,
          index,
          mediaIdentity,
          requestOptions.botId ?? null,
        );
        const cachedPayload = this.readUploadPayload(cache, requestOptions.botId);
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
            maxUploadPayload: this.buildCachedUploadPayload(payload, requestOptions.botId),
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
        const cache = await this.assertVideoReadyForPublish(
          candidateUrl,
          mediaIdentity,
          requestOptions.botId ?? null,
        );
        const cachedPayload = this.readUploadPayload(cache, requestOptions.botId);
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
            maxUploadPayload: this.buildCachedUploadPayload(payload, requestOptions.botId),
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
    return [...new Set([primaryUrl, ...candidateUrls].map((url) => url.trim()).filter(Boolean))];
  }

  private shouldTryNextVideoCandidate(error: unknown): boolean {
    return this.isSkippableVideoPublishFailure(this.formatError(error));
  }

  private resolvePhotoCandidateUrls(primaryUrl: string, candidateUrls: string[]): string[] {
    return [...new Set([primaryUrl, ...candidateUrls].map((url) => url.trim()).filter(Boolean))];
  }

  private shouldTryNextPhotoCandidate(error: unknown): boolean {
    return this.isSkippablePhotoPublishFailure(this.formatError(error));
  }

  private async assertMediaReadyForPublish(
    imageUrl: string,
    index: number,
    mediaIdentity: string | null = null,
    botId: string | null = null,
  ): Promise<VkParsingMediaCacheRow> {
    const cache = await this.mediaCache.preflightMediaUrl(imageUrl, mediaIdentity, botId);
    if (this.readUploadPayload(cache, botId)) {
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
    botId: string | null = null,
  ): Promise<VkParsingMediaCacheRow> {
    const cache = await this.preflightVideoUrl(videoUrl, mediaIdentity, botId);
    if (this.readUploadPayload(cache, botId)) {
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
    botId: string | null,
  ): Promise<VkParsingMediaCacheRow> {
    const cached = await this.mediaCache.findMediaCache(videoUrl, mediaIdentity);
    if (cached?.status === VK_MEDIA_STATUS_READY && this.readUploadPayload(cached, botId)) {
      return cached;
    }
    if (
      cached?.status === VK_MEDIA_STATUS_FAILED &&
      this.canReuseFailedVideoPreflightCache(cached)
    ) {
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

  private readUploadPayload(
    cache: VkParsingMediaCacheRow,
    expectedBotId: string | null | undefined,
  ): Record<string, unknown> | null {
    const payload = this.asRecord(cache.maxUploadPayload);
    const cachedBotId = this.readString(payload?.[VK_MEDIA_CACHE_UPLOAD_BOT_ID_FIELD]);
    if (!payload || !expectedBotId?.trim() || cachedBotId !== expectedBotId.trim()) {
      return null;
    }

    const sendPayload = { ...payload };
    delete sendPayload[VK_MEDIA_CACHE_UPLOAD_BOT_ID_FIELD];
    return Object.keys(sendPayload).length > 0 ? sendPayload : null;
  }

  private buildCachedUploadPayload(
    payload: Record<string, unknown>,
    botId: string | null | undefined,
  ): Record<string, unknown> {
    const normalizedBotId = botId?.trim();
    return normalizedBotId
      ? { ...payload, [VK_MEDIA_CACHE_UPLOAD_BOT_ID_FIELD]: normalizedBotId }
      : payload;
  }

  private readUploadToken(payload: Record<string, unknown>): string | null {
    const token = this.readString(payload.token);
    return token || null;
  }

  private async downloadImage(imageUrl: string, index: number): Promise<VkParsingDownloadedMedia> {
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
    return (
      Boolean(mimeType) &&
      mimeType !== 'application/octet-stream' &&
      !mimeType.startsWith('binary/')
    );
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

  private async prepareMaxMessageText(
    chatId: string,
    payload: PreparedVkPublishPayload,
    settings: Pick<VkParsingSettingsLike, 'appendChannelLinkEnabled' | 'channelLinkText'>,
    trafficClass: MaxApiTrafficClass,
  ): Promise<VkParsingMaxMessageText> {
    const usesRichText = payload.textFormat === 'markdown';
    const renderedText = usesRichText
      ? renderSupportedMarkdownAsHtml(payload.text, { blockMode: 'raw' })
      : payload.text;
    const missingLinkUrls = usesRichText
      ? payload.linkUrls.filter((url) => !containsSupportedMarkdownUrl(payload.text, url))
      : [];
    const renderedLinkHtml = missingLinkUrls.map(
      (url) => `<a href="${escapeMaxHtmlAttribute(url)}">${escapeMaxHtmlText(url)}</a>`,
    );
    const contentHtml = usesRichText
      ? [renderedText.trim(), ...renderedLinkHtml].filter(Boolean).join('\n')
      : renderedText;
    const engagementText = usesRichText
      ? [
          payload.text.trim(),
          ...missingLinkUrls.map((url) => `[${escapeMarkdownLinkLabel(url)}](${url})`),
        ]
          .filter(Boolean)
          .join('\n')
      : payload.text;

    if (this.channelPostSignatureService) {
      const signed = await this.channelPostSignatureService.preparePostText(
        chatId,
        {
          text: contentHtml,
          ...(usesRichText ? { textFormat: 'html' as const } : {}),
          engagementText,
        },
        {
          trafficClass,
          sourceTag: MAX_API_SOURCE_TAGS.VK_PARSING,
          maxLength: VK_PARSING_MAX_PUBLISH_TEXT_LENGTH,
        },
      );
      return {
        text: signed.text,
        textFormat: signed.textFormat,
        engagementText: signed.engagementText ?? engagementText,
      };
    }

    if (!settings.appendChannelLinkEnabled) {
      this.assertMaxMessageTextLength(contentHtml);
      return {
        text: contentHtml,
        textFormat: usesRichText ? 'html' : undefined,
        engagementText,
      };
    }

    const linkText = settings.channelLinkText.trim();
    if (!linkText) {
      throw new BadRequestException('Укажите текст ссылки на канал.');
    }
    const channelLink = await this.resolveChannelLink(chatId, trafficClass);
    const baseHtml = usesRichText ? contentHtml : escapeMaxHtmlText(renderedText);
    const signatureHtml = `<a href="${escapeMaxHtmlAttribute(channelLink)}">${escapeMaxHtmlText(
      linkText,
    )}</a>`;
    const text = [baseHtml.trim(), signatureHtml].filter(Boolean).join('\n\n');
    const engagementTextWithSignature = [
      engagementText.trim(),
      `[${escapeMarkdownLinkLabel(linkText)}](${channelLink})`,
    ]
      .filter(Boolean)
      .join('\n\n');

    this.assertMaxMessageTextLength(text);
    return {
      text,
      textFormat: 'html',
      engagementText: engagementTextWithSignature,
    };
  }

  private assertMaxMessageTextLength(text: string): void {
    if (text.length > VK_PARSING_MAX_PUBLISH_TEXT_LENGTH) {
      throw new BadRequestException(
        `Текст вместе со ссылкой слишком длинный. Максимум ${VK_PARSING_MAX_PUBLISH_TEXT_LENGTH} символов.`,
      );
    }
  }

  private async resolveChannelLink(
    chatId: string,
    trafficClass: MaxApiTrafficClass,
  ): Promise<string> {
    const entityType = await this.accessService.resolvePublicationEntityType(chatId);
    if (entityType !== ChatEntityType.CHANNEL) {
      throw new BadRequestException('Ссылка в конце доступна только для канала.');
    }

    try {
      const audienceSnapshot = await this.prisma.channelAudienceSnapshot.findFirst({
        where: {
          chatId,
          link: { not: null },
        },
        orderBy: { capturedAt: 'desc' },
        select: { link: true },
      });
      const knownLink = normalizeMaxChannelLink(audienceSnapshot?.link);
      if (knownLink) {
        return knownLink;
      }
    } catch (error) {
      this.logger.warn({ chatId, err: error }, 'Failed to read cached MAX channel audience link');
    }

    const catalogDelegate = this.prisma.managedBotChatCatalog;
    if (catalogDelegate && typeof catalogDelegate.findFirst === 'function') {
      try {
        const catalogEntry = await catalogDelegate.findFirst({
          where: {
            chatId,
            entityType: ChatEntityType.CHANNEL,
            status: 'ACTIVE',
            link: { not: null },
          },
          orderBy: [{ lastSeenAt: 'desc' }, { updatedAt: 'desc' }],
          select: { link: true },
        });
        const knownLink = normalizeMaxChannelLink(catalogEntry?.link);
        if (knownLink) {
          return knownLink;
        }
      } catch (error) {
        this.logger.warn({ chatId, err: error }, 'Failed to read cached MAX channel link');
      }
    }

    try {
      const botId = await this.maxBotLinkService.resolveBotIdForSend({ chatId });
      if (!botId || typeof this.maxClient.getChatSnapshot !== 'function') {
        throw new Error('No bot can resolve the MAX channel link');
      }
      const snapshot = await this.maxClient.getChatSnapshot(chatId, {
        botId,
        trafficClass,
        sourceTag: MAX_API_SOURCE_TAGS.VK_PARSING,
      });
      const resolvedLink = normalizeMaxChannelLink(snapshot.link);
      if (snapshot.entityType === 'channel' && resolvedLink) {
        return resolvedLink;
      }
    } catch (error) {
      this.logger.warn({ chatId, err: error }, 'Failed to resolve MAX channel link for VK parsing');
      throw new ServiceUnavailableException('Не удалось получить ссылку канала. Повторите позже.');
    }

    throw new BadRequestException('У канала нет публичной ссылки MAX.');
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
      this.logger.warn({ postId, reason }, 'VK parsing post disappeared before skip persistence');
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
      appendChannelLinkEnabled: false,
      channelLinkText: VK_PARSING_DEFAULT_CHANNEL_LINK_TEXT,
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

  private readUnsupportedAttachments(value: Prisma.JsonValue | unknown): Array<{ type: string }> {
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

function normalizeMaxChannelLink(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  if (!normalized || normalized.length > VK_PARSING_MAX_CHANNEL_LINK_URL_LENGTH) {
    return null;
  }

  try {
    const parsed = new URL(normalized);
    const hostname = parsed.hostname.toLowerCase();
    if (
      (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') ||
      (hostname !== 'max.ru' && hostname !== 'www.max.ru') ||
      Boolean(parsed.username || parsed.password || parsed.port) ||
      parsed.pathname === '/'
    ) {
      return null;
    }
    parsed.protocol = 'https:';
    parsed.hostname = 'max.ru';
    parsed.hash = '';
    parsed.search = '';
    const canonical = parsed.toString();
    return escapeMaxHtmlAttribute(canonical).length <= VK_PARSING_MAX_CHANNEL_LINK_URL_LENGTH
      ? canonical
      : null;
  } catch {
    return null;
  }
}

function escapeMaxHtmlText(value: string): string {
  return value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;');
}

function escapeMaxHtmlAttribute(value: string): string {
  return escapeMaxHtmlText(value).replace(/"/gu, '&quot;');
}

function escapeMarkdownLinkLabel(value: string): string {
  return value.replace(/\\/gu, '\\\\').replace(/\[/gu, '\\[').replace(/\]/gu, '\\]');
}
