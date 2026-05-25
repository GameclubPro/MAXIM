import {
  addVkParsingSourceRequestSchema,
  publishVkParsingPostRequestSchema,
  VK_PARSING_MAX_LINKS,
  VK_PARSING_MAX_PHOTOS,
  VK_PARSING_MAX_PUBLISH_TEXT_LENGTH,
  type PublishVkParsingPostResult,
  type VkParsingCapability,
  type VkParsingFeed,
  type VkParsingPost,
  type VkParsingRefreshResult,
  type VkParsingSource,
} from '@maxim/contracts';
import { InjectQueue } from '@nestjs/bullmq';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import type { Queue } from 'bullmq';
import { type AuthUser } from '../common/decorators/current-user.decorator';
import {
  MAX_API_SOURCE_TAGS,
  MaxClientService,
  type MaxAttachmentPayload,
  type MaxSendMessageOptions,
} from '../max/max-client.service';
import { MaxBotLinkService } from '../max/max-bot-link.service';
import { ChatEntityType, Prisma } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { AdminService } from './admin.service';
import {
  VK_PARSING_SYNC_QUEUE,
  type VkParsingSyncJob,
  type VkParsingSyncReason,
} from './vk-parsing.queue';
import { VkParsingRateLimitService } from './vk-parsing-rate-limit.service';

type VkParsingSourceRow = Prisma.VkParsingSourceGetPayload<Record<string, never>>;
type VkParsingPostWithSource = Prisma.VkParsingPostGetPayload<{ include: { source: true } }>;
type VkParsingMediaCacheRow = Prisma.VkParsingMediaCacheGetPayload<Record<string, never>>;

type VkWallGetResponse = {
  count?: number;
  items?: unknown[];
  groups?: unknown[];
};

type NormalizedVkSourceInput = {
  domain: string;
  url: string;
};

type NormalizedVkSourceInfo = {
  ownerId: number;
  wallOwnerId: number;
  screenName: string;
  title: string;
  url: string;
};

type NormalizedVkPost = {
  vkOwnerId: number;
  vkPostId: number;
  vkPublishedAt: Date | null;
  text: string;
  url: string;
  photoUrls: string[];
  linkUrls: string[];
  attachments: Array<Record<string, unknown>>;
  raw: Record<string, unknown>;
  contentHash: string;
};

const VK_SOURCE_STATUS_ACTIVE = 'ACTIVE';
const VK_SOURCE_STATUS_DISABLED = 'DISABLED';
const VK_SOURCE_SYNC_STATUS_IDLE = 'IDLE';
const VK_SOURCE_SYNC_STATUS_QUEUED = 'QUEUED';
const VK_SOURCE_SYNC_STATUS_SYNCING = 'SYNCING';
const VK_SOURCE_SYNC_STATUS_BACKOFF = 'BACKOFF';
const VK_SOURCE_SYNC_STATUS_ERROR = 'ERROR';
const VK_POST_STATUS_NEW = 'NEW';
const VK_POST_STATUS_PUBLISHED = 'PUBLISHED';
const VK_POST_STATUS_FAILED = 'FAILED';
const VK_POST_STATUS_CHANGED_AFTER_PUBLISH = 'CHANGED_AFTER_PUBLISH';
const VK_POST_STATUS_UNAVAILABLE = 'UNAVAILABLE';
const VK_MEDIA_STATUS_READY = 'READY';
const VK_MEDIA_STATUS_FAILED = 'FAILED';
const VK_MEDIA_STATUS_UNKNOWN = 'UNKNOWN';
const VK_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
const VK_IMAGE_FETCH_TIMEOUT_MS = 15_000;
const VK_API_RATE_LIMIT_ERROR_CODE = 6;
const VK_API_RETRYABLE_ERROR_CODES = new Set([VK_API_RATE_LIMIT_ERROR_CODE, 10]);
const VK_API_TERMINAL_ERROR_CODES = new Set([5, 14, 15, 18, 19, 100, 203]);
const VK_SYNC_JOB_NAME = 'sync-vk-source';

class VkApiRequestError extends ServiceUnavailableException {
  constructor(
    message: string,
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'VkApiRequestError';
  }
}

@Injectable()
export class VkParsingService {
  private readonly logger = new Logger(VkParsingService.name);
  private readonly allowedUserIds: ReadonlySet<string>;
  private readonly vkApiBaseUrl: string;
  private readonly vkApiVersion: string;
  private readonly vkApiTimeoutMs: number;
  private readonly vkApiMaxAttempts: number;
  private readonly syncIntervalMs: number;
  private readonly fetchCount: number;
  private readonly queueBatchSize: number;
  private readonly syncLeaseTtlMs: number;
  private readonly mediaPreflightTtlMs: number;
  private readonly mediaConcurrency: number;
  private readonly workerId = `${process.pid}-${Math.random().toString(36).slice(2, 10)}`;

  constructor(
    private readonly prisma: PrismaService,
    private readonly adminService: AdminService,
    private readonly maxClient: MaxClientService,
    private readonly maxBotLinkService: MaxBotLinkService,
    private readonly vkRateLimitService: VkParsingRateLimitService,
    @InjectQueue(VK_PARSING_SYNC_QUEUE)
    private readonly syncQueue: Queue<VkParsingSyncJob>,
    private readonly configService: ConfigService,
  ) {
    this.allowedUserIds = new Set(
      String(configService.get<string>('VK_PARSING_ALLOWED_USER_IDS') ?? '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean),
    );
    this.vkApiBaseUrl = this.normalizeBaseUrl(
      configService.get<string>('VK_API_BASE_URL') ?? 'https://api.vk.ru',
    );
    this.vkApiVersion = configService.get<string>('VK_API_VERSION') ?? '5.131';
    this.vkApiTimeoutMs = configService.get<number>('VK_API_TIMEOUT_MS') ?? 10_000;
    this.vkApiMaxAttempts = configService.get<number>('VK_API_MAX_ATTEMPTS') ?? 3;
    this.syncIntervalMs = configService.get<number>('VK_PARSING_SYNC_INTERVAL_MS') ?? 600_000;
    this.fetchCount = configService.get<number>('VK_PARSING_FETCH_COUNT') ?? 100;
    this.queueBatchSize = configService.get<number>('VK_PARSING_QUEUE_BATCH_SIZE') ?? 100;
    this.syncLeaseTtlMs = configService.get<number>('VK_PARSING_LEASE_TTL_MS') ?? 120_000;
    this.mediaPreflightTtlMs =
      configService.get<number>('VK_PARSING_MEDIA_PREFLIGHT_TTL_MS') ?? 86_400_000;
    this.mediaConcurrency = configService.get<number>('VK_PARSING_MEDIA_CONCURRENCY') ?? 3;
  }

  getSyncIntervalMs(): number {
    return this.syncIntervalMs;
  }

  async getCapability(chatId: string, user: AuthUser): Promise<VkParsingCapability> {
    const enabled = this.allowedUserIds.size > 0;
    if (!enabled || !this.allowedUserIds.has(user.userId)) {
      return { enabled, canUse: false };
    }

    const chat = await this.prisma.chat.findUnique({
      where: { id: chatId },
      select: { entityType: true },
    });
    if (!chat || chat.entityType !== ChatEntityType.CHANNEL) {
      return { enabled, canUse: false };
    }

    try {
      await this.adminService.assertChatAdmin(chatId, user.userId, 'channel');
    } catch {
      return { enabled, canUse: false };
    }

    return { enabled, canUse: true };
  }

  async listVkParsing(chatId: string, user: AuthUser): Promise<VkParsingFeed> {
    await this.assertVkParsingChannelAccess(chatId, user);
    return this.buildFeed(chatId, { enabled: true, canUse: true });
  }

  async addSource(chatId: string, user: AuthUser, body: unknown): Promise<VkParsingRefreshResult> {
    await this.assertVkParsingChannelAccess(chatId, user);
    const parsed = addVkParsingSourceRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }

    const normalized = this.normalizeSourceInput(parsed.data.url);
    const wall = await this.fetchWall({ domain: normalized.domain, count: 1 });
    const sourceInfo = this.resolveSourceInfo(normalized, wall);
    const source = await this.prisma.vkParsingSource.upsert({
      where: {
        chatId_wallOwnerId: {
          chatId,
          wallOwnerId: sourceInfo.wallOwnerId,
        },
      },
      create: {
        chatId,
        ownerId: sourceInfo.ownerId,
        wallOwnerId: sourceInfo.wallOwnerId,
        screenName: sourceInfo.screenName,
        title: sourceInfo.title,
        url: sourceInfo.url,
        status: VK_SOURCE_STATUS_ACTIVE,
        syncStatus: VK_SOURCE_SYNC_STATUS_QUEUED,
        nextSyncAt: new Date(),
        createdByUserId: user.userId,
      },
      update: {
        ownerId: sourceInfo.ownerId,
        screenName: sourceInfo.screenName,
        title: sourceInfo.title,
        url: sourceInfo.url,
        status: VK_SOURCE_STATUS_ACTIVE,
        syncStatus: VK_SOURCE_SYNC_STATUS_QUEUED,
        nextSyncAt: new Date(),
        lastError: null,
        lastErrorCode: null,
      },
    });

    const queued = await this.enqueueSourceSync(source.id, 'source-added');
    const feed = await this.buildFeed(chatId, { enabled: true, canUse: true });
    return { ...feed, imported: 0, queued };
  }

  async removeSource(chatId: string, sourceId: string, user: AuthUser): Promise<VkParsingFeed> {
    await this.assertVkParsingChannelAccess(chatId, user);
    const source = await this.prisma.vkParsingSource.findFirst({
      where: { id: sourceId, chatId },
    });
    if (!source) {
      throw new NotFoundException('VK-источник не найден.');
    }

    await this.prisma.vkParsingSource.update({
      where: { id: source.id },
      data: {
        status: VK_SOURCE_STATUS_DISABLED,
        syncStatus: VK_SOURCE_SYNC_STATUS_IDLE,
        nextSyncAt: null,
        syncLockedAt: null,
        syncLockedBy: null,
      },
    });
    return this.buildFeed(chatId, { enabled: true, canUse: true });
  }

  async refresh(chatId: string, user: AuthUser): Promise<VkParsingRefreshResult> {
    await this.assertVkParsingChannelAccess(chatId, user);
    const sources = await this.prisma.vkParsingSource.findMany({
      where: { chatId, status: VK_SOURCE_STATUS_ACTIVE },
      orderBy: [{ createdAt: 'asc' }],
    });

    const queued = await this.enqueueSources(sources, 'manual');

    const feed = await this.buildFeed(chatId, { enabled: true, canUse: true });
    return { ...feed, imported: 0, queued };
  }

  async syncDueSources(reason: VkParsingSyncReason = 'scheduled'): Promise<number> {
    const now = new Date();
    const staleLockBefore = new Date(now.getTime() - this.syncLeaseTtlMs);
    const sources = await this.prisma.vkParsingSource.findMany({
      where: {
        status: VK_SOURCE_STATUS_ACTIVE,
        syncStatus: { not: VK_SOURCE_SYNC_STATUS_ERROR },
        OR: [
          { nextSyncAt: null },
          { nextSyncAt: { lte: now } },
          {
            syncStatus: VK_SOURCE_SYNC_STATUS_SYNCING,
            syncLockedAt: { lt: staleLockBefore },
          },
        ],
      },
      orderBy: [{ nextSyncAt: 'asc' }, { lastSyncAt: 'asc' }, { createdAt: 'asc' }],
      take: this.queueBatchSize,
    });

    return this.enqueueSources(sources, reason);
  }

  async publishPost(
    chatId: string,
    postId: string,
    user: AuthUser,
    body: unknown,
  ): Promise<PublishVkParsingPostResult> {
    await this.assertVkParsingChannelAccess(chatId, user);
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

    const storedPhotoUrls = this.readStringArray(post.photoUrls);
    const storedLinkUrls = this.readStringArray(post.linkUrls);
    const photoUrls = this.assertSelectedUrls(parsed.data.photoUrls, storedPhotoUrls, 'фото');
    const linkUrls = this.assertSelectedUrls(parsed.data.linkUrls, storedLinkUrls, 'ссылку');
    const text = this.composePublishText(parsed.data.text, linkUrls);
    if (text.length > VK_PARSING_MAX_PUBLISH_TEXT_LENGTH) {
      throw new BadRequestException(
        `Текст публикации слишком длинный. Максимум ${VK_PARSING_MAX_PUBLISH_TEXT_LENGTH} символов.`,
      );
    }

    const botId = await this.maxBotLinkService.resolveBotId({ chatId });
    const requestOptions = {
      botId,
      trafficClass: 'interactive' as const,
      sourceTag: MAX_API_SOURCE_TAGS.VK_PARSING,
    };
    const options: MaxSendMessageOptions = {
      debugContext: {
        screen: 'vk_parsing',
        action: 'publish_post',
      },
    };

    try {
      const engagementContext = await this.adminService.buildChannelPublicationEngagementContext(
        chatId,
        botId,
      );
      if (engagementContext.buttons.length > 0) {
        options.buttons = engagementContext.buttons;
      }

      const imagePayloads = await this.downloadAndUploadImages(photoUrls, requestOptions);

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

      const result = await this.maxClient.sendMessageImmediateWithResolvedLink(
        chatId,
        text || ' ',
        options,
        requestOptions,
      );
      await this.recordChannelPublicationEngagementSafely({
        chatId,
        actorUserId: user.userId,
        messageId: result.messageId,
        engagementContext,
        botId,
      });
      const updated = await this.prisma.vkParsingPost.update({
        where: { id: post.id },
        data: {
          status: VK_POST_STATUS_PUBLISHED,
          publishedContentHash:
            post.contentHash ||
            this.computePostContentHash({
              text: post.text,
              photoUrls: storedPhotoUrls,
              linkUrls: storedLinkUrls,
            }),
          publishedMessageId: result.messageId,
          publishedUrl: result.url,
          publishedAtMax: new Date(),
          lastError: null,
        },
        include: { source: true },
      });

      return {
        post: this.mapPost(updated),
        messageId: result.messageId,
        url: result.url,
      };
    } catch (error) {
      await this.prisma.vkParsingPost.update({
        where: { id: post.id },
        data: {
          status: VK_POST_STATUS_FAILED,
          lastError: this.formatError(error),
        },
      });
      throw error;
    }
  }

  private async recordChannelPublicationEngagementSafely(params: {
    chatId: string;
    actorUserId: string;
    messageId: string;
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

  private async assertVkParsingChannelAccess(chatId: string, user: AuthUser): Promise<void> {
    if (!this.allowedUserIds.has(user.userId)) {
      throw new ForbiddenException('ВК-парсинг недоступен для этого пользователя.');
    }

    const chat = await this.prisma.chat.findUnique({
      where: { id: chatId },
      select: { entityType: true },
    });
    if (!chat) {
      throw new NotFoundException('Канал не найден.');
    }
    if (chat.entityType !== ChatEntityType.CHANNEL) {
      throw new BadRequestException('ВК-парсинг доступен только для каналов.');
    }

    await this.adminService.assertChatAdmin(chatId, user.userId, 'channel');
  }

  private async buildFeed(
    chatId: string,
    capabilities: VkParsingCapability = { enabled: false, canUse: false },
  ): Promise<VkParsingFeed> {
    const [sources, posts] = await Promise.all([
      this.prisma.vkParsingSource.findMany({
        where: { chatId, status: VK_SOURCE_STATUS_ACTIVE },
        orderBy: [{ createdAt: 'asc' }],
      }),
      this.prisma.vkParsingPost.findMany({
        where: { chatId, source: { status: VK_SOURCE_STATUS_ACTIVE } },
        include: { source: true },
        orderBy: [{ vkPublishedAt: 'desc' }, { createdAt: 'desc' }],
        take: 50,
      }),
    ]);

    return {
      capabilities,
      sources: sources.map((source) => this.mapSource(source)),
      posts: posts.map((post) => this.mapPost(post)),
    };
  }

  async processSyncSourceJob(
    sourceId: string,
    _reason: VkParsingSyncReason = 'scheduled',
  ): Promise<number> {
    const source = await this.acquireSourceLease(sourceId);
    if (!source) {
      return 0;
    }

    return this.syncSource(source);
  }

  private async syncSource(source: VkParsingSourceRow): Promise<number> {
    const startedAt = new Date();
    try {
      const wall = await this.fetchWall({ ownerId: source.wallOwnerId, count: this.fetchCount });
      const posts = (wall.items ?? [])
        .map((item) => this.normalizePost(item))
        .filter((post): post is NormalizedVkPost => post !== null);

      const imported = await this.upsertPostsBatch(source, posts, startedAt);
      await this.preflightPostMediaSafely(posts);
      const completedAt = new Date();

      await this.prisma.vkParsingSource.update({
        where: { id: source.id },
        data: {
          syncStatus: VK_SOURCE_SYNC_STATUS_IDLE,
          nextSyncAt: new Date(completedAt.getTime() + this.syncIntervalMs),
          lastSyncAt: completedAt,
          lastSuccessAt: completedAt,
          syncStartedAt: null,
          syncLockedAt: null,
          syncLockedBy: null,
          consecutiveFailures: 0,
          lastErrorCode: null,
          lastImportedCount: imported,
          lastFetchedCount: posts.length,
          lastSyncDurationMs: Math.max(0, completedAt.getTime() - startedAt.getTime()),
          lastError: null,
        },
      });
      return imported;
    } catch (error) {
      const completedAt = new Date();
      const classified = this.classifySyncError(error);
      const failureCount = source.consecutiveFailures + 1;
      const backoffMs = classified.retryable ? this.resolveSyncBackoffMs(failureCount) : null;
      await this.prisma.vkParsingSource.update({
        where: { id: source.id },
        data: {
          syncStatus: classified.retryable
            ? VK_SOURCE_SYNC_STATUS_BACKOFF
            : VK_SOURCE_SYNC_STATUS_ERROR,
          nextSyncAt: backoffMs === null ? null : new Date(completedAt.getTime() + backoffMs),
          lastSyncAt: completedAt,
          syncStartedAt: null,
          syncLockedAt: null,
          syncLockedBy: null,
          consecutiveFailures: failureCount,
          lastErrorCode: classified.code,
          lastImportedCount: 0,
          lastFetchedCount: 0,
          lastSyncDurationMs: Math.max(0, completedAt.getTime() - startedAt.getTime()),
          lastError: classified.message,
        },
      });
      this.logger.warn(
        {
          sourceId: source.id,
          chatId: source.chatId,
          reason: classified.code,
          retryable: classified.retryable,
          err: error,
        },
        'VK sync failed',
      );
      return 0;
    }
  }

  private async upsertPostsBatch(
    source: VkParsingSourceRow,
    posts: NormalizedVkPost[],
    seenAt: Date,
  ): Promise<number> {
    const existingRows = posts.length
      ? await this.prisma.vkParsingPost.findMany({
          where: {
            chatId: source.chatId,
            vkOwnerId: source.wallOwnerId,
            vkPostId: { in: posts.map((post) => post.vkPostId) },
          },
          select: {
            id: true,
            vkOwnerId: true,
            vkPostId: true,
            status: true,
            contentHash: true,
            publishedContentHash: true,
          },
        })
      : [];
    const existingByPostKey = new Map(
      existingRows.map((row) => [this.buildPostKey(row.vkOwnerId, row.vkPostId), row]),
    );

    const operations = posts.map((post) => {
      const existing = existingByPostKey.get(this.buildPostKey(post.vkOwnerId, post.vkPostId));
      const status = this.resolveImportedPostStatus(existing ?? null, post);
      return this.prisma.vkParsingPost.upsert({
        where: {
          chatId_vkOwnerId_vkPostId: {
            chatId: source.chatId,
            vkOwnerId: post.vkOwnerId,
            vkPostId: post.vkPostId,
          },
        },
        create: {
          sourceId: source.id,
          chatId: source.chatId,
          vkOwnerId: post.vkOwnerId,
          vkPostId: post.vkPostId,
          vkPublishedAt: post.vkPublishedAt,
          text: post.text,
          url: post.url,
          photoUrls: post.photoUrls,
          linkUrls: post.linkUrls,
          attachments: this.toJsonInput(post.attachments),
          raw: this.toJsonInput(post.raw),
          contentHash: post.contentHash,
          status,
          lastSeenAt: seenAt,
          missingSinceAt: null,
          unavailableAt: null,
        },
        update: {
          sourceId: source.id,
          vkPublishedAt: post.vkPublishedAt,
          text: post.text,
          url: post.url,
          photoUrls: post.photoUrls,
          linkUrls: post.linkUrls.slice(0, VK_PARSING_MAX_LINKS),
          attachments: this.toJsonInput(post.attachments),
          raw: this.toJsonInput(post.raw),
          contentHash: post.contentHash,
          status,
          lastSeenAt: seenAt,
          missingSinceAt: null,
          unavailableAt: null,
        },
      });
    });

    if (operations.length > 0) {
      await this.prisma.$transaction(operations);
    }
    await this.markMissingPostsUnavailable(source, posts, seenAt);

    return posts.filter(
      (post) => !existingByPostKey.has(this.buildPostKey(post.vkOwnerId, post.vkPostId)),
    ).length;
  }

  private async enqueueSources(
    sources: VkParsingSourceRow[],
    reason: VkParsingSyncReason,
  ): Promise<number> {
    let queued = 0;
    for (const source of sources) {
      queued += await this.enqueueSourceSync(source.id, reason);
    }

    return queued;
  }

  private async enqueueSourceSync(sourceId: string, reason: VkParsingSyncReason): Promise<number> {
    await this.prisma.vkParsingSource.update({
      where: { id: sourceId },
      data: {
        syncStatus: VK_SOURCE_SYNC_STATUS_QUEUED,
        nextSyncAt: new Date(),
      },
    });

    await this.syncQueue.add(
      VK_SYNC_JOB_NAME,
      {
        sourceId,
        reason,
        retryPolicyName: 'vk-parsing-sync',
        createdAt: new Date().toISOString(),
      },
      {
        jobId: this.buildSyncJobId(sourceId),
        attempts: 1,
        removeOnComplete: true,
        removeOnFail: 500,
      },
    );

    return 1;
  }

  private async acquireSourceLease(sourceId: string): Promise<VkParsingSourceRow | null> {
    const now = new Date();
    const staleLockBefore = new Date(now.getTime() - this.syncLeaseTtlMs);
    const updated = await this.prisma.vkParsingSource.updateMany({
      where: {
        id: sourceId,
        status: VK_SOURCE_STATUS_ACTIVE,
        OR: [{ syncLockedAt: null }, { syncLockedAt: { lt: staleLockBefore } }],
      },
      data: {
        syncStatus: VK_SOURCE_SYNC_STATUS_SYNCING,
        syncStartedAt: now,
        syncLockedAt: now,
        syncLockedBy: this.workerId,
        syncAttemptCount: { increment: 1 },
      },
    });

    if (updated.count === 0) {
      return null;
    }

    const source = await this.prisma.vkParsingSource.findUnique({ where: { id: sourceId } });
    if (!source) {
      return null;
    }

    return source;
  }

  private resolveImportedPostStatus(
    existing: {
      status: string;
      contentHash: string;
      publishedContentHash: string | null;
    } | null,
    post: NormalizedVkPost,
  ): string {
    if (!existing) {
      return VK_POST_STATUS_NEW;
    }

    const publishedHash =
      existing.publishedContentHash ||
      (existing.status === VK_POST_STATUS_PUBLISHED ? existing.contentHash : null);
    if (
      publishedHash &&
      publishedHash !== post.contentHash &&
      (existing.status === VK_POST_STATUS_PUBLISHED ||
        existing.status === VK_POST_STATUS_CHANGED_AFTER_PUBLISH)
    ) {
      return VK_POST_STATUS_CHANGED_AFTER_PUBLISH;
    }

    if (existing.status === VK_POST_STATUS_UNAVAILABLE) {
      return VK_POST_STATUS_NEW;
    }

    return existing.status || VK_POST_STATUS_NEW;
  }

  private async markMissingPostsUnavailable(
    source: VkParsingSourceRow,
    posts: NormalizedVkPost[],
    seenAt: Date,
  ): Promise<void> {
    if (posts.length === 0) {
      return;
    }

    const oldestFetchedAt = posts.reduce<Date | null>((oldest, post) => {
      if (!post.vkPublishedAt) {
        return oldest;
      }
      return !oldest || post.vkPublishedAt.getTime() < oldest.getTime() ? post.vkPublishedAt : oldest;
    }, null);
    if (!oldestFetchedAt) {
      return;
    }

    await this.prisma.vkParsingPost.updateMany({
      where: {
        sourceId: source.id,
        vkPublishedAt: { gte: oldestFetchedAt },
        vkPostId: { notIn: posts.map((post) => post.vkPostId) },
        status: {
          in: [
            VK_POST_STATUS_NEW,
            VK_POST_STATUS_FAILED,
            VK_POST_STATUS_CHANGED_AFTER_PUBLISH,
          ],
        },
      },
      data: {
        status: VK_POST_STATUS_UNAVAILABLE,
        missingSinceAt: seenAt,
        unavailableAt: seenAt,
      },
    });
  }

  private classifySyncError(error: unknown): {
    code: string;
    message: string;
    retryable: boolean;
  } {
    if (error instanceof VkApiRequestError) {
      return {
        code: error.code,
        message: error.message,
        retryable: error.retryable,
      };
    }

    return {
      code: 'unknown',
      message: this.formatError(error),
      retryable: true,
    };
  }

  private resolveSyncBackoffMs(failureCount: number): number {
    const baseMs = 60_000;
    const cappedFailureCount = Math.max(0, Math.min(6, failureCount - 1));
    const jitterMs = Math.floor(Math.random() * 5_000);
    return Math.min(60 * 60_000, baseMs * 2 ** cappedFailureCount + jitterMs);
  }

  private buildSyncJobId(sourceId: string): string {
    return `vk-parsing-sync__${sourceId}`;
  }

  private buildPostKey(ownerId: number, postId: number): string {
    return `${ownerId}:${postId}`;
  }

  private normalizeSourceInput(input: string): NormalizedVkSourceInput {
    const trimmed = input.trim();
    if (!trimmed) {
      throw new BadRequestException('Укажите ссылку на VK-сообщество.');
    }

    let sourcePath = trimmed;
    if (/^https?:\/\//iu.test(trimmed) || /^(?:www\.|m\.)?(?:vk\.com|vk\.ru)\//iu.test(trimmed)) {
      const url = new URL(/^https?:\/\//iu.test(trimmed) ? trimmed : `https://${trimmed}`);
      const host = url.hostname
        .replace(/^www\./iu, '')
        .replace(/^m\./iu, '')
        .toLowerCase();
      if (host !== 'vk.com' && host !== 'vk.ru') {
        throw new BadRequestException('Поддерживаются только ссылки vk.ru и vk.com.');
      }

      const segment = url.pathname
        .split('/')
        .map((part) => part.trim())
        .filter(Boolean)[0];
      if (!segment) {
        throw new BadRequestException('Укажите ссылку на VK-сообщество.');
      }
      sourcePath = segment;
    }

    const domain = sourcePath.replace(/^@/u, '').trim();
    if (/^(?:wall|photo|video|album|topic)-?\d+/iu.test(domain)) {
      throw new BadRequestException('Нужна ссылка на сообщество, не на отдельный материал.');
    }
    if (!/^[A-Za-z0-9_.-]{2,80}$/u.test(domain)) {
      throw new BadRequestException('Некорректная ссылка на VK-сообщество.');
    }

    return {
      domain,
      url: `https://vk.ru/${domain}`,
    };
  }

  private resolveSourceInfo(
    input: NormalizedVkSourceInput,
    wall: VkWallGetResponse,
  ): NormalizedVkSourceInfo {
    const group = (wall.groups ?? [])
      .map((item) => this.asRecord(item))
      .find((item): item is Record<string, unknown> => item !== null);
    const firstPost = (wall.items ?? [])
      .map((item) => this.asRecord(item))
      .find((item): item is Record<string, unknown> => item !== null);
    const groupId = this.readNumber(group?.id) ?? this.resolveGroupIdFromPost(firstPost ?? null);
    if (!groupId) {
      throw new BadRequestException('VK-сообщество не найдено или недоступно.');
    }

    const screenName = this.readString(group?.screen_name) || input.domain;
    const title = this.readString(group?.name) || screenName;
    return {
      ownerId: groupId,
      wallOwnerId: -Math.abs(groupId),
      screenName,
      title,
      url: `https://vk.ru/${screenName}`,
    };
  }

  private resolveGroupIdFromPost(post: Record<string, unknown> | null): number | null {
    const ownerId = this.readNumber(post?.owner_id);
    if (typeof ownerId !== 'number' || ownerId >= 0) {
      return null;
    }

    return Math.abs(ownerId);
  }

  private normalizePost(value: unknown): NormalizedVkPost | null {
    const post = this.asRecord(value);
    if (!post) {
      return null;
    }

    const vkOwnerId = this.readNumber(post.owner_id);
    const vkPostId = this.readNumber(post.id);
    if (typeof vkOwnerId !== 'number' || typeof vkPostId !== 'number') {
      return null;
    }

    const attachments = this.readAttachments(post.attachments);
    const photoUrls = this.extractPhotoUrls(attachments);
    const linkUrls = this.extractLinkUrls(attachments);
    const text = this.readString(post.text);
    if (!text.trim() && photoUrls.length === 0 && linkUrls.length === 0) {
      return null;
    }

    const publishedSeconds = this.readNumber(post.date);
    const vkPublishedAt =
      typeof publishedSeconds === 'number' && publishedSeconds > 0
        ? new Date(publishedSeconds * 1_000)
        : null;

    return {
      vkOwnerId,
      vkPostId,
      vkPublishedAt,
      text,
      url: `https://vk.ru/wall${vkOwnerId}_${vkPostId}`,
      photoUrls,
      linkUrls,
      attachments,
      raw: post,
      contentHash: this.computePostContentHash({ text, photoUrls, linkUrls }),
    };
  }

  private readAttachments(value: unknown): Array<Record<string, unknown>> {
    if (!Array.isArray(value)) {
      return [];
    }

    return value
      .map((item) => this.asRecord(item))
      .filter((item): item is Record<string, unknown> => item !== null);
  }

  private extractPhotoUrls(attachments: Array<Record<string, unknown>>): string[] {
    const urls = new Set<string>();
    for (const attachment of attachments) {
      if (this.readString(attachment.type) !== 'photo') {
        continue;
      }

      const photo = this.asRecord(attachment.photo);
      const sizes = Array.isArray(photo?.sizes) ? photo.sizes : [];
      const best = sizes
        .map((item) => this.asRecord(item))
        .filter((item): item is Record<string, unknown> => item !== null)
        .map((size) => ({
          url: this.normalizeHttpUrl(this.readString(size.url)),
          area:
            Math.max(0, this.readNumber(size.width) ?? 0) *
            Math.max(0, this.readNumber(size.height) ?? 0),
        }))
        .filter((size): size is { url: string; area: number } => Boolean(size.url))
        .sort((left, right) => right.area - left.area)[0];

      if (best?.url) {
        urls.add(best.url);
      }
    }

    return [...urls].slice(0, VK_PARSING_MAX_PHOTOS);
  }

  private extractLinkUrls(attachments: Array<Record<string, unknown>>): string[] {
    const urls = new Set<string>();
    for (const attachment of attachments) {
      if (this.readString(attachment.type) !== 'link') {
        continue;
      }

      const link = this.asRecord(attachment.link);
      const url = this.normalizeHttpUrl(this.readString(link?.url));
      if (url) {
        urls.add(url);
      }
    }

    return [...urls].slice(0, VK_PARSING_MAX_LINKS);
  }

  private async fetchWall(options: {
    domain?: string;
    ownerId?: number;
    count: number;
  }): Promise<VkWallGetResponse> {
    const params: Record<string, string> = {
      count: String(Math.max(1, Math.min(options.count, 100))),
      filter: 'owner',
      extended: '1',
    };
    if (options.domain) {
      params.domain = options.domain;
    }
    if (typeof options.ownerId === 'number') {
      params.owner_id = String(options.ownerId);
    }

    const response = await this.requestVk('wall.get', params);
    if (!this.asRecord(response)) {
      throw new BadRequestException('VK вернул пустой ответ.');
    }

    return response as VkWallGetResponse;
  }

  private async requestVk(method: string, params: Record<string, string>): Promise<unknown> {
    const token = this.configService.get<string>('VK_SERVICE_TOKEN')?.trim();
    if (!token) {
      throw new ServiceUnavailableException('VK_SERVICE_TOKEN не настроен.');
    }

    for (let attempt = 1; attempt <= this.vkApiMaxAttempts; attempt += 1) {
      try {
        await this.vkRateLimitService.reserveVkApiSlot(method);
        const response = await this.fetchVkApi(method, params, token);
        const payload = await this.readVkResponsePayload(response);
        const record = this.asRecord(payload);

        if (!response.ok) {
          throw new VkApiRequestError(
            `VK API вернул статус ${response.status}.`,
            `http_${response.status}`,
            response.status === 429 || response.status >= 500,
          );
        }

        const error = this.asRecord(record?.error);
        if (error) {
          const code = this.readNumber(error.error_code);
          const message = this.readString(error.error_msg) || 'VK API отклонил запрос.';
          throw new VkApiRequestError(
            code ? `VK API: ${message} (${code})` : `VK API: ${message}`,
            code ? `vk_${code}` : 'vk_unknown',
            code ? this.isRetryableVkApiErrorCode(code) : false,
          );
        }

        await this.vkRateLimitService.recordVkApiOutcome({ method, outcome: 'success' });
        return record?.response;
      } catch (error) {
        const classified = this.classifyVkRequestError(error);
        await this.vkRateLimitService.recordVkApiOutcome({
          method,
          outcome: 'error',
          code: classified.code,
        });
        if (!classified.retryable || attempt >= this.vkApiMaxAttempts) {
          throw classified.error;
        }

        await this.sleep(this.resolveVkRequestRetryDelayMs(attempt, classified.code));
      }
    }

    throw new VkApiRequestError('VK API временно недоступен.', 'retry_exhausted', true);
  }

  private async fetchVkApi(
    method: string,
    params: Record<string, string>,
    token: string,
  ): Promise<Response> {
    const search = new URLSearchParams({
      ...params,
      v: this.vkApiVersion,
    });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.vkApiTimeoutMs);
    try {
      return await fetch(`${this.vkApiBaseUrl}/method/${method}?${search.toString()}`, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
        signal: controller.signal,
      });
    } catch (error) {
      const aborted =
        error instanceof Error &&
        (error.name === 'AbortError' || /abort|timeout/iu.test(error.message));
      throw new VkApiRequestError(
        aborted ? 'VK API не ответил вовремя.' : 'VK API временно недоступен.',
        aborted ? 'timeout' : 'network',
        true,
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  private async readVkResponsePayload(response: Response): Promise<unknown> {
    try {
      return await response.json();
    } catch {
      throw new VkApiRequestError('VK API вернул нечитаемый ответ.', 'invalid_json', true);
    }
  }

  private classifyVkRequestError(error: unknown): {
    error: VkApiRequestError;
    code: string;
    retryable: boolean;
  } {
    if (error instanceof VkApiRequestError) {
      return { error, code: error.code, retryable: error.retryable };
    }

    const wrapped = new VkApiRequestError(this.formatError(error), 'unknown', true);
    return { error: wrapped, code: wrapped.code, retryable: wrapped.retryable };
  }

  private isRetryableVkApiErrorCode(code: number): boolean {
    if (VK_API_RETRYABLE_ERROR_CODES.has(code)) {
      return true;
    }
    if (VK_API_TERMINAL_ERROR_CODES.has(code)) {
      return false;
    }

    return false;
  }

  private resolveVkRequestRetryDelayMs(attempt: number, code: string): number {
    const rateLimitDelayMs = code === `vk_${VK_API_RATE_LIMIT_ERROR_CODE}` ? 1_000 : 0;
    const baseMs = Math.max(250, rateLimitDelayMs);
    return Math.min(5_000, baseMs * 2 ** Math.max(0, attempt - 1));
  }

  private async downloadAndUploadImages(
    photoUrls: string[],
    requestOptions: {
      botId?: string;
      trafficClass: 'interactive';
      sourceTag: string;
    },
  ): Promise<Record<string, unknown>[]> {
    const payloads = new Array<Record<string, unknown>>(photoUrls.length);
    await this.mapWithConcurrency(photoUrls, this.mediaConcurrency, async (url, index) => {
      try {
        await this.assertMediaReadyForPublish(url, index);
        const image = await this.downloadImage(url, index);
        payloads[index] = await this.maxClient.uploadImage(
          image.buffer,
          image.fileName,
          image.mimeType,
          requestOptions,
        );
      } catch (error) {
        throw new BadRequestException(`Фото ${index + 1}: ${this.formatError(error)}`);
      }
    });

    return payloads;
  }

  private async preflightPostMediaSafely(posts: NormalizedVkPost[]): Promise<void> {
    const photoUrls = [...new Set(posts.flatMap((post) => post.photoUrls))];
    if (photoUrls.length === 0) {
      return;
    }

    try {
      await this.mapWithConcurrency(photoUrls, this.mediaConcurrency, async (url) => {
        await this.preflightMediaUrl(url);
      });
    } catch (error) {
      this.logger.warn(
        { err: error },
        'VK media preflight failed unexpectedly after per-url safeguards',
      );
    }
  }

  private async assertMediaReadyForPublish(imageUrl: string, index: number): Promise<void> {
    const cache = await this.preflightMediaUrl(imageUrl);
    if (cache.status === VK_MEDIA_STATUS_FAILED) {
      throw new BadRequestException(cache.lastError || `Фото ${index + 1} недоступно.`);
    }
  }

  private async preflightMediaUrl(imageUrl: string): Promise<VkParsingMediaCacheRow> {
    const cached = await this.prisma.vkParsingMediaCache.findUnique({ where: { url: imageUrl } });
    if (cached?.lastCheckedAt) {
      const ageMs = Date.now() - cached.lastCheckedAt.getTime();
      if (ageMs >= 0 && ageMs < this.mediaPreflightTtlMs && cached.status !== VK_MEDIA_STATUS_UNKNOWN) {
        return cached;
      }
    }

    let parsed: URL;
    try {
      parsed = new URL(imageUrl);
      if (parsed.protocol !== 'https:') {
        return this.writeMediaCache(imageUrl, {
          status: VK_MEDIA_STATUS_FAILED,
          lastError: 'Фото VK должно быть доступно по HTTPS.',
        });
      }
    } catch {
      return this.writeMediaCache(imageUrl, {
        status: VK_MEDIA_STATUS_FAILED,
        lastError: 'Некорректная ссылка на фото VK.',
      });
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), VK_IMAGE_FETCH_TIMEOUT_MS);
    try {
      const response = await this.fetchMediaPreflightResponse(parsed, controller.signal);
      if (!response.ok) {
        return this.writeMediaCache(imageUrl, {
          status: VK_MEDIA_STATUS_FAILED,
          lastError: `VK вернул статус ${response.status} для фото.`,
        });
      }

      const headers = response.headers ?? new Headers();
      const contentLength = this.readMediaContentLength(headers, response.status);
      if ((contentLength ?? 0) > VK_IMAGE_MAX_BYTES) {
        return this.writeMediaCache(imageUrl, {
          status: VK_MEDIA_STATUS_FAILED,
          contentLength,
          lastError: 'Фото из VK слишком большое.',
        });
      }

      const mimeType = (headers.get('content-type') ?? '').split(';')[0]!.trim();
      if (mimeType && !mimeType.toLowerCase().startsWith('image/')) {
        return this.writeMediaCache(imageUrl, {
          status: VK_MEDIA_STATUS_FAILED,
          mimeType,
          contentLength: contentLength || null,
          lastError: 'VK вернул не изображение.',
        });
      }

      return this.writeMediaCache(imageUrl, {
        status: VK_MEDIA_STATUS_READY,
        mimeType: mimeType || null,
        contentLength,
        lastError: null,
      });
    } catch (error) {
      return this.writeMediaCache(imageUrl, {
        status: VK_MEDIA_STATUS_FAILED,
        lastError:
          error instanceof Error && error.name === 'AbortError'
            ? 'VK не ответил на проверку фото вовремя.'
            : this.formatError(error),
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  private async fetchMediaPreflightResponse(
    url: URL,
    signal: AbortSignal,
  ): Promise<Response> {
    const headResponse = await fetch(url, { method: 'HEAD', signal });
    if (headResponse.ok || !this.shouldFallbackMediaPreflight(headResponse.status)) {
      return headResponse;
    }

    await headResponse.body?.cancel().catch(() => undefined);
    const rangeResponse = await fetch(url, {
      method: 'GET',
      headers: { Range: 'bytes=0-0' },
      signal,
    });
    await rangeResponse.body?.cancel().catch(() => undefined);
    return rangeResponse;
  }

  private shouldFallbackMediaPreflight(status: number): boolean {
    return status === 403 || status === 405 || status === 501;
  }

  private readMediaContentLength(headers: Headers, status: number): number | null {
    const contentRangeTotal = this.readContentRangeTotal(headers.get('content-range'));
    if (contentRangeTotal !== null) {
      return contentRangeTotal;
    }

    if (status === 206) {
      return null;
    }

    const contentLength = Number(headers.get('content-length') ?? 0);
    return Number.isFinite(contentLength) && contentLength > 0 ? contentLength : null;
  }

  private readContentRangeTotal(value: string | null): number | null {
    const match = value?.match(/\/(\d+)$/u);
    if (!match) {
      return null;
    }

    const total = Number(match[1]);
    return Number.isFinite(total) && total >= 0 ? total : null;
  }

  private async writeMediaCache(
    url: string,
    data: {
      status: string;
      mimeType?: string | null;
      contentLength?: number | null;
      lastError?: string | null;
    },
  ): Promise<VkParsingMediaCacheRow> {
    return this.prisma.vkParsingMediaCache.upsert({
      where: { url },
      create: {
        url,
        status: data.status,
        mimeType: data.mimeType ?? null,
        contentLength: data.contentLength ?? null,
        lastCheckedAt: new Date(),
        lastError: data.lastError ?? null,
      },
      update: {
        status: data.status,
        mimeType: data.mimeType ?? null,
        contentLength: data.contentLength ?? null,
        lastCheckedAt: new Date(),
        lastError: data.lastError ?? null,
      },
    });
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

  private composePublishText(text: string, linkUrls: string[]): string {
    const base = text.trim();
    const missingLinks = linkUrls.filter((url) => !base.includes(url));
    return [base, ...missingLinks].filter(Boolean).join('\n');
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

  private computePostContentHash(params: {
    text: string;
    photoUrls: string[];
    linkUrls: string[];
  }): string {
    return createHash('sha256')
      .update(
        JSON.stringify({
          text: params.text.trim(),
          photoUrls: params.photoUrls,
          linkUrls: params.linkUrls,
        }),
      )
      .digest('hex');
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

  private mapSource(source: VkParsingSourceRow): VkParsingSource {
    return {
      id: source.id,
      chatId: source.chatId,
      ownerId: source.ownerId,
      wallOwnerId: source.wallOwnerId,
      screenName: source.screenName,
      title: source.title,
      url: source.url,
      status: source.status === VK_SOURCE_STATUS_DISABLED ? 'DISABLED' : 'ACTIVE',
      syncStatus: this.mapSourceSyncStatus(source.syncStatus),
      nextSyncAt: source.nextSyncAt ? source.nextSyncAt.toISOString() : null,
      lastSyncAt: source.lastSyncAt ? source.lastSyncAt.toISOString() : null,
      lastSuccessAt: source.lastSuccessAt ? source.lastSuccessAt.toISOString() : null,
      syncStartedAt: source.syncStartedAt ? source.syncStartedAt.toISOString() : null,
      consecutiveFailures: Math.max(0, source.consecutiveFailures),
      lastErrorCode: source.lastErrorCode,
      lastImportedCount: Math.max(0, source.lastImportedCount),
      lastFetchedCount: Math.max(0, source.lastFetchedCount),
      lastSyncDurationMs:
        typeof source.lastSyncDurationMs === 'number' && source.lastSyncDurationMs >= 0
          ? source.lastSyncDurationMs
          : null,
      lastError: source.lastError,
      createdAt: source.createdAt.toISOString(),
      updatedAt: source.updatedAt.toISOString(),
    };
  }

  private mapPost(post: VkParsingPostWithSource): VkParsingPost {
    const status =
      post.status === VK_POST_STATUS_PUBLISHED
        ? 'PUBLISHED'
        : post.status === VK_POST_STATUS_FAILED
          ? 'FAILED'
          : post.status === VK_POST_STATUS_CHANGED_AFTER_PUBLISH
            ? 'CHANGED_AFTER_PUBLISH'
            : post.status === VK_POST_STATUS_UNAVAILABLE
              ? 'UNAVAILABLE'
              : 'NEW';
    return {
      id: post.id,
      sourceId: post.sourceId,
      chatId: post.chatId,
      sourceTitle: post.source.title,
      sourceUrl: post.source.url,
      vkOwnerId: post.vkOwnerId,
      vkPostId: post.vkPostId,
      vkPublishedAt: post.vkPublishedAt ? post.vkPublishedAt.toISOString() : null,
      text: post.text,
      url: post.url,
      photoUrls: this.readStringArray(post.photoUrls),
      linkUrls: this.readStringArray(post.linkUrls),
      status,
      contentHash: post.contentHash,
      publishedContentHash: post.publishedContentHash,
      publishedMessageId: post.publishedMessageId,
      publishedUrl: post.publishedUrl,
      publishedAtMax: post.publishedAtMax ? post.publishedAtMax.toISOString() : null,
      lastSeenAt: post.lastSeenAt ? post.lastSeenAt.toISOString() : null,
      missingSinceAt: post.missingSinceAt ? post.missingSinceAt.toISOString() : null,
      unavailableAt: post.unavailableAt ? post.unavailableAt.toISOString() : null,
      lastError: post.lastError,
      createdAt: post.createdAt.toISOString(),
      updatedAt: post.updatedAt.toISOString(),
    };
  }

  private mapSourceSyncStatus(value: string): VkParsingSource['syncStatus'] {
    return value === VK_SOURCE_SYNC_STATUS_QUEUED
      ? 'QUEUED'
      : value === VK_SOURCE_SYNC_STATUS_SYNCING
        ? 'SYNCING'
        : value === VK_SOURCE_SYNC_STATUS_BACKOFF
          ? 'BACKOFF'
          : value === VK_SOURCE_SYNC_STATUS_ERROR
            ? 'ERROR'
            : 'IDLE';
  }

  private readStringArray(value: Prisma.JsonValue | unknown): string[] {
    if (!Array.isArray(value)) {
      return [];
    }

    return value.filter((item): item is string => typeof item === 'string' && item.length > 0);
  }

  private toJsonInput(value: unknown): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(value ?? null)) as Prisma.InputJsonValue;
  }

  private normalizeBaseUrl(value: string): string {
    return value.replace(/\/+$/u, '');
  }

  private normalizeHttpUrl(value: string): string | null {
    try {
      const url = new URL(value);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        return null;
      }
      return url.href;
    } catch {
      return null;
    }
  }

  private asRecord(value: unknown): Record<string, unknown> | null {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  }

  private readString(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
  }

  private readNumber(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === 'string' && value.trim()) {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private formatError(error: unknown): string {
    if (error instanceof Error && error.message.trim()) {
      return error.message.trim().slice(0, 500);
    }

    return 'Неизвестная ошибка VK-парсинга.';
  }
}
