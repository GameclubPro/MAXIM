import {
  addVkParsingSourceRequestSchema,
  publishVkParsingPostRequestSchema,
  retryVkParsingPostResultSchema,
  updateVkParsingSettingsRequestSchema,
  VK_PARSING_MAX_LINKS,
  VK_PARSING_MAX_PHOTOS,
  VK_PARSING_MAX_PUBLISH_TEXT_LENGTH,
  type PublishVkParsingPostResult,
  type RetryVkParsingPostResult,
  type VkParsingCapability,
  type VkParsingFeed,
  type VkParsingFeedQuery,
  type VkParsingHealthSummary,
  type VkParsingPost,
  type VkParsingRefreshResult,
  type VkParsingSettings,
  type VkParsingSource,
  vkParsingFeedQuerySchema,
} from '@maxim/contracts';
import { InjectQueue } from '@nestjs/bullmq';
import {
  BadRequestException,
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
  type MaxApiTrafficClass,
  type MaxSendMessageOptions,
} from '../max/max-client.service';
import { MaxBotLinkService } from '../max/max-bot-link.service';
import { ChatEntityType, Prisma } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { AdminService } from './admin.service';
import {
  parseVkWallPostAttachments,
  type VkParsingPhotoMediaIdentity,
  type VkParsingUnsupportedAttachmentSummary,
} from './vk-parsing-attachments';
import {
  VK_PARSING_PUBLISH_QUEUE,
  VK_PARSING_SYNC_QUEUE,
  type VkParsingPublishJob,
  type VkParsingPublishReason,
  type VkParsingSyncJob,
  type VkParsingSyncReason,
} from './vk-parsing.queue';
import { VkParsingRateLimitService } from './vk-parsing-rate-limit.service';

type VkParsingSourceRow = Prisma.VkParsingSourceGetPayload<Record<string, never>>;
type VkParsingPostWithSource = Prisma.VkParsingPostGetPayload<{ include: { source: true } }>;
type VkParsingMediaCacheRow = Prisma.VkParsingMediaCacheGetPayload<Record<string, never>>;
type VkParsingSettingsRow = Prisma.VkParsingSettingsGetPayload<Record<string, never>>;

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
  attachmentTypes: string[];
  unsupportedAttachments: VkParsingUnsupportedAttachmentSummary[];
  hasUnsupportedAttachments: boolean;
  isAdvertising: boolean;
  advertisingMarkers: string[];
  photoMedia: VkParsingPhotoMediaIdentity[];
  copyHistoryText: string[];
  raw: Record<string, unknown>;
  contentHash: string;
};

type VkParsingSettingsLike = {
  chatId: string;
  autoPublishEnabled: boolean;
  autoPublishEnabledAt: Date | null;
  stripLinksEnabled: boolean;
  skipAdsEnabled: boolean;
  updatedAt: Date | null;
};

type VkParsingSkipReason = 'AD' | 'EMPTY_AFTER_LINK_FILTER';

type ImportedPostsBatchResult = {
  imported: number;
  importedPosts: VkParsingPostWithSource[];
  publishCandidates: VkParsingPostWithSource[];
};

type ExistingVkPostImportState = {
  id: string;
  vkOwnerId: number;
  vkPostId: number;
  status: string;
  contentHash: string;
  publishedContentHash: string | null;
};

type PreparedVkPublishPayload = {
  text: string;
  photoUrls: string[];
  linkUrls: string[];
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
const VK_POST_STATUS_SKIPPED = 'SKIPPED';
const VK_POST_SKIP_REASON_AD: VkParsingSkipReason = 'AD';
const VK_POST_SKIP_REASON_EMPTY_AFTER_LINK_FILTER: VkParsingSkipReason = 'EMPTY_AFTER_LINK_FILTER';
const VK_MEDIA_STATUS_READY = 'READY';
const VK_MEDIA_STATUS_FAILED = 'FAILED';
const VK_MEDIA_STATUS_UNKNOWN = 'UNKNOWN';
const VK_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
const VK_IMAGE_FETCH_TIMEOUT_MS = 15_000;
const VK_API_RATE_LIMIT_ERROR_CODE = 6;
const VK_API_RETRYABLE_ERROR_CODES = new Set([VK_API_RATE_LIMIT_ERROR_CODE, 9, 10, 29]);
const VK_API_TERMINAL_ERROR_CODES = new Set([5, 14, 15, 18, 19, 30, 100, 203, 210]);
const VK_SYNC_JOB_NAME = 'sync-vk-source';
const VK_PUBLISH_JOB_NAME = 'publish-vk-post';
const VK_PARSING_SYSTEM_ACTOR_USER_ID = 'vk-parsing-autopost';
const VK_INLINE_LINK_PATTERN =
  /(?:https?:\/\/|www\.)[^\s<>()\]["'`{}]+|(?:vk\.cc|vk\.com|vk\.ru|t\.me|telegram\.me|wa\.me|max\.ru)\/[^\s<>()\]["'`{}]+/giu;

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
  private readonly vkApiBaseUrl: string;
  private readonly vkApiVersion: string;
  private readonly vkApiTimeoutMs: number;
  private readonly vkApiMaxAttempts: number;
  private readonly syncIntervalMs: number;
  private readonly minSyncIntervalMs: number;
  private readonly maxSyncIntervalMs: number;
  private readonly fetchCount: number;
  private readonly minFetchPages: number;
  private readonly maxFetchPages: number;
  private readonly missingConfirmationThreshold: number;
  private readonly queueBatchSize: number;
  private readonly syncLeaseTtlMs: number;
  private readonly mediaPreflightTtlMs: number;
  private readonly mediaFailedPreflightTtlMs: number;
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
    @InjectQueue(VK_PARSING_PUBLISH_QUEUE)
    private readonly publishQueue: Queue<VkParsingPublishJob>,
    private readonly configService: ConfigService,
  ) {
    this.vkApiBaseUrl = this.normalizeBaseUrl(
      configService.get<string>('VK_API_BASE_URL') ?? 'https://api.vk.ru',
    );
    this.vkApiVersion = configService.get<string>('VK_API_VERSION') ?? '5.199';
    this.vkApiTimeoutMs = configService.get<number>('VK_API_TIMEOUT_MS') ?? 10_000;
    this.vkApiMaxAttempts = configService.get<number>('VK_API_MAX_ATTEMPTS') ?? 3;
    this.syncIntervalMs = configService.get<number>('VK_PARSING_SYNC_INTERVAL_MS') ?? 600_000;
    this.minSyncIntervalMs =
      configService.get<number>('VK_PARSING_MIN_SYNC_INTERVAL_MS') ?? 120_000;
    this.maxSyncIntervalMs =
      configService.get<number>('VK_PARSING_MAX_SYNC_INTERVAL_MS') ?? 3_600_000;
    this.fetchCount = configService.get<number>('VK_PARSING_FETCH_COUNT') ?? 100;
    this.minFetchPages = configService.get<number>('VK_PARSING_MIN_PAGES') ?? 3;
    this.maxFetchPages = Math.max(
      this.minFetchPages,
      configService.get<number>('VK_PARSING_MAX_PAGES') ?? 5,
    );
    this.missingConfirmationThreshold =
      configService.get<number>('VK_PARSING_MISSING_CONFIRMATION_THRESHOLD') ?? 3;
    this.queueBatchSize = configService.get<number>('VK_PARSING_QUEUE_BATCH_SIZE') ?? 100;
    this.syncLeaseTtlMs = configService.get<number>('VK_PARSING_LEASE_TTL_MS') ?? 120_000;
    this.mediaPreflightTtlMs =
      configService.get<number>('VK_PARSING_MEDIA_PREFLIGHT_TTL_MS') ?? 86_400_000;
    this.mediaFailedPreflightTtlMs = Math.min(
      this.mediaPreflightTtlMs,
      configService.get<number>('VK_PARSING_MEDIA_FAILED_PREFLIGHT_TTL_MS') ?? 120_000,
    );
    this.mediaConcurrency = configService.get<number>('VK_PARSING_MEDIA_CONCURRENCY') ?? 3;
  }

  getSyncIntervalMs(): number {
    return this.syncIntervalMs;
  }

  async getCapability(chatId: string, user: AuthUser): Promise<VkParsingCapability> {
    const chat = await this.prisma.chat.findUnique({
      where: { id: chatId },
      select: { entityType: true },
    });
    if (!chat) {
      return { enabled: true, canUse: false };
    }

    try {
      await this.adminService.assertChatAdmin(
        chatId,
        user.userId,
        this.resolveAdminEntityType(chat.entityType),
      );
    } catch {
      return { enabled: true, canUse: false };
    }

    return { enabled: true, canUse: true };
  }

  async listVkParsing(chatId: string, user: AuthUser, query: unknown = {}): Promise<VkParsingFeed> {
    await this.assertVkParsingAccess(chatId, user);
    return this.buildFeed(chatId, { enabled: true, canUse: true }, query);
  }

  async updateSettings(chatId: string, user: AuthUser, body: unknown): Promise<VkParsingFeed> {
    await this.assertVkParsingAccess(chatId, user);
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
      await this.clearQueuedAutoPublishForChat(chatId);
    }

    return this.buildFeed(chatId, { enabled: true, canUse: true });
  }

  async getHealthSummary(chatId: string, user: AuthUser): Promise<VkParsingHealthSummary> {
    await this.assertVkParsingAccess(chatId, user);
    return this.buildHealthSummary(chatId);
  }

  async addSource(chatId: string, user: AuthUser, body: unknown): Promise<VkParsingRefreshResult> {
    await this.assertVkParsingAccess(chatId, user);
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
    await this.assertVkParsingAccess(chatId, user);
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
    await this.assertVkParsingAccess(chatId, user);
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
    await this.assertVkParsingAccess(chatId, user);
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
    const settings = await this.getSettingsForChat(chatId);
    const prepared = this.preparePublishPayload(
      {
        text: parsed.data.text,
        photoUrls,
        linkUrls,
      },
      settings,
    );
    const skipReason = this.resolvePostSkipReason(
      {
        text: post.text,
        photoUrls: storedPhotoUrls,
        linkUrls: storedLinkUrls,
        attachments: this.readAttachments(post.attachments),
        raw: this.asRecord(post.raw) ?? {},
        isAdvertising: this.readBooleanFlag(post.isAdvertising),
        advertisingMarkers: this.readStringArray(post.advertisingMarkers),
      },
      settings,
    );
    if (skipReason) {
      await this.markPostSkipped(post.id, skipReason);
      throw new BadRequestException(this.describeSkipReason(skipReason));
    }
    this.assertPreparedPublishPayload(prepared);

    return this.publishPreparedPostToMax(post, prepared, {
      actorUserId: user.userId,
      trafficClass: 'interactive',
      debugAction: 'publish_post',
      auto: false,
    });
  }

  async retryPost(
    chatId: string,
    postId: string,
    user: AuthUser,
  ): Promise<RetryVkParsingPostResult> {
    await this.assertVkParsingAccess(chatId, user);
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

    const queued = await this.enqueuePostPublish(post, 'manual-retry');
    const updated = await this.prisma.vkParsingPost.findFirst({
      where: { id: post.id, chatId },
      include: { source: true },
    });
    return retryVkParsingPostResultSchema.parse({
      post: this.mapPost(updated ?? post),
      queued,
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
    const entityType = await this.resolvePublicationEntityType(post.chatId);
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

      const photoMediaIdentityByUrl = this.resolvePhotoMediaIdentityMap({
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
        photoMediaIdentityByUrl,
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
            this.computePostContentHash({
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
          publishLockedAt: null,
          publishIdempotencyKey: null,
          skippedAt: null,
          skipReason: null,
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
          publishLockedAt: null,
          lastError: this.formatError(error),
          autoPublishError: params.auto ? this.formatError(error) : post.autoPublishError,
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
        if (!this.isAttachmentNotReadyError(error) || attempt >= 3) {
          throw error;
        }
        await this.sleep(750 * 2 ** (attempt - 1));
      }
    }

    throw lastError instanceof Error ? lastError : new Error('MAX attachment is not ready.');
  }

  private isAttachmentNotReadyError(error: unknown): boolean {
    const status = (error as { response?: { status?: number } })?.response?.status;
    if (typeof status === 'number' && status !== 400) {
      return false;
    }

    const responseData = (error as { response?: { data?: unknown } })?.response?.data;
    const normalized = JSON.stringify(responseData ?? error ?? '').toLowerCase();
    return normalized.includes('attachment.not.ready') || normalized.includes('not ready');
  }

  private async assertVkParsingAccess(chatId: string, user: AuthUser): Promise<ChatEntityType> {
    const chat = await this.prisma.chat.findUnique({
      where: { id: chatId },
      select: { entityType: true },
    });
    if (!chat) {
      throw new NotFoundException('Чат или канал не найден.');
    }

    await this.adminService.assertChatAdmin(
      chatId,
      user.userId,
      this.resolveAdminEntityType(chat.entityType),
    );
    return chat.entityType;
  }

  private resolveAdminEntityType(entityType: ChatEntityType): 'chat' | 'channel' {
    return entityType === ChatEntityType.CHANNEL ? 'channel' : 'chat';
  }

  private async resolvePublicationEntityType(chatId: string): Promise<ChatEntityType | null> {
    const chat = await this.prisma.chat.findUnique({
      where: { id: chatId },
      select: { entityType: true },
    });
    return chat?.entityType ?? null;
  }

  private async buildFeed(
    chatId: string,
    capabilities: VkParsingCapability = { enabled: false, canUse: false },
    rawQuery: unknown = {},
  ): Promise<VkParsingFeed> {
    const parsedQuery = vkParsingFeedQuerySchema.safeParse(rawQuery);
    const query: VkParsingFeedQuery = parsedQuery.success
      ? parsedQuery.data
      : { status: 'ALL', limit: 50, offset: 0 };
    const postWhere: Prisma.VkParsingPostWhereInput = {
      chatId,
      source: { status: VK_SOURCE_STATUS_ACTIVE },
      ...(query.status !== 'ALL' ? { status: query.status } : {}),
      ...(query.sourceId ? { sourceId: query.sourceId } : {}),
    };

    const [settings, sources, posts, total, summary] = await Promise.all([
      this.prisma.vkParsingSettings.findUnique({
        where: { chatId },
      }),
      this.prisma.vkParsingSource.findMany({
        where: { chatId, status: VK_SOURCE_STATUS_ACTIVE },
        orderBy: [{ createdAt: 'asc' }],
      }),
      this.prisma.vkParsingPost.findMany({
        where: postWhere,
        include: { source: true },
        orderBy: [{ vkPublishedAt: 'desc' }, { createdAt: 'desc' }],
        skip: query.offset,
        take: query.limit,
      }),
      this.prisma.vkParsingPost.count({ where: postWhere }),
      this.buildHealthSummary(chatId),
    ]);
    const nextOffset = query.offset + query.limit;

    return {
      capabilities,
      settings: this.mapSettings(chatId, settings),
      sources: sources.map((source) => this.mapSource(source)),
      posts: posts.map((post) => this.mapPost(post)),
      pagination: {
        limit: query.limit,
        offset: query.offset,
        total,
        hasMore: nextOffset < total,
        nextOffset: nextOffset < total ? nextOffset : null,
      },
      summary,
    };
  }

  private async buildHealthSummary(chatId: string): Promise<VkParsingHealthSummary> {
    const now = new Date();
    const staleBefore = new Date(now.getTime() - this.maxSyncIntervalMs * 2);
    const [
      sourceCount,
      staleSourceCount,
      latestSeen,
      oldestQueued,
      publishBacklog,
      mediaTotal,
      mediaFailed,
      vkApiMetrics,
    ] = await Promise.all([
      this.prisma.vkParsingSource.count({
        where: { chatId, status: VK_SOURCE_STATUS_ACTIVE },
      }),
      this.prisma.vkParsingSource.count({
        where: {
          chatId,
          status: VK_SOURCE_STATUS_ACTIVE,
          OR: [
            { syncStatus: VK_SOURCE_SYNC_STATUS_ERROR },
            { lastSuccessAt: null },
            { lastSuccessAt: { lt: staleBefore } },
          ],
        },
      }),
      this.prisma.vkParsingPost.aggregate({
        where: { chatId, lastSeenAt: { not: null } },
        _max: { lastSeenAt: true },
      }),
      this.prisma.vkParsingPost.aggregate({
        where: { chatId, publishQueuedAt: { not: null } },
        _min: { publishQueuedAt: true },
      }),
      this.prisma.vkParsingPost.count({
        where: {
          chatId,
          publishQueuedAt: { not: null },
          status: { in: [VK_POST_STATUS_NEW, VK_POST_STATUS_FAILED] },
        },
      }),
      this.prisma.vkParsingMediaCache.count(),
      this.prisma.vkParsingMediaCache.count({ where: { status: VK_MEDIA_STATUS_FAILED } }),
      this.vkRateLimitService.getRecentVkApiMetrics(300).catch(() => ({
        rps: 0,
        errorRate: 0,
        recentErrors: [],
      })),
    ]);

    const lastSeenAt = latestSeen._max.lastSeenAt;
    const firstQueuedAt = oldestQueued._min.publishQueuedAt;
    return {
      chatId,
      generatedAt: now.toISOString(),
      vkApiRps: vkApiMetrics.rps,
      vkApiErrorRate: vkApiMetrics.errorRate,
      sourceCount,
      staleSourceCount,
      importLagSeconds: lastSeenAt
        ? Math.max(0, Math.floor((now.getTime() - lastSeenAt.getTime()) / 1_000))
        : null,
      publishLagSeconds: firstQueuedAt
        ? Math.max(0, Math.floor((now.getTime() - firstQueuedAt.getTime()) / 1_000))
        : null,
      publishBacklog,
      mediaFailureRatio: mediaTotal > 0 ? Math.min(1, mediaFailed / mediaTotal) : 0,
      recentErrors: vkApiMetrics.recentErrors,
    };
  }

  async processSyncSourceJob(
    sourceId: string,
    reason: VkParsingSyncReason = 'scheduled',
  ): Promise<number> {
    const source = await this.acquireSourceLease(sourceId);
    if (!source) {
      return 0;
    }

    return this.syncSource(source, reason);
  }

  async processPublishPostJob(params: {
    postId: string;
    chatId: string;
    reason: VkParsingPublishReason;
    idempotencyKey: string;
  }): Promise<void> {
    const now = new Date();
    const staleLockBefore = new Date(now.getTime() - this.syncLeaseTtlMs);
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
        publishAttemptCount: { increment: 1 },
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

    try {
      const settings = await this.getSettingsForChat(post.chatId);
      if (
        params.reason === 'autopublish' &&
        (!settings.autoPublishEnabled ||
          !settings.autoPublishEnabledAt ||
          !this.isPostEligibleForAutoPublish(post, settings.autoPublishEnabledAt))
      ) {
        await this.clearQueuedAutoPublishPost(post.id);
        return;
      }
      await this.autoPublishPost(post, settings);
    } catch (error) {
      await this.markPostAutoPublishFailed(post.id, error);
      throw error;
    }
  }

  private async syncSource(
    source: VkParsingSourceRow,
    reason: VkParsingSyncReason,
  ): Promise<number> {
    const startedAt = new Date();
    try {
      const wallPages = await this.fetchWallPages(source, reason);
      const posts = wallPages.posts;

      const importResult = await this.upsertPostsBatch(source, posts, startedAt);
      if (this.shouldAutoPublishImportedPosts(reason)) {
        await this.enqueueAutoPublishImportedPosts(source.chatId, importResult.publishCandidates);
      }
      const completedAt = new Date();
      const adaptiveIntervalMs = this.resolveAdaptiveSyncIntervalMs(source, posts, completedAt);
      const newestPost = this.resolveNewestPost(posts);

      await this.prisma.vkParsingSource.update({
        where: { id: source.id },
        data: {
          syncStatus: VK_SOURCE_SYNC_STATUS_IDLE,
          nextSyncAt: new Date(completedAt.getTime() + adaptiveIntervalMs),
          lastSyncAt: completedAt,
          lastSuccessAt: completedAt,
          syncStartedAt: null,
          syncLockedAt: null,
          syncLockedBy: null,
          consecutiveFailures: 0,
          lastErrorCode: null,
          lastImportedCount: importResult.imported,
          lastFetchedCount: posts.length,
          lastFetchedPages: wallPages.pages,
          lastFetchedOffsets: this.toJsonInput(wallPages.offsets),
          lastVkNewestPostId: newestPost?.vkPostId ?? source.lastVkNewestPostId,
          lastVkNewestPublishedAt: newestPost?.vkPublishedAt ?? source.lastVkNewestPublishedAt,
          adaptiveIntervalMs,
          lastSyncDurationMs: Math.max(0, completedAt.getTime() - startedAt.getTime()),
          lastError: null,
        },
      });
      void this.preflightPostMediaSafely(posts);
      return importResult.imported;
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

  private async fetchWallPages(
    source: VkParsingSourceRow,
    reason: VkParsingSyncReason,
  ): Promise<{ posts: NormalizedVkPost[]; pages: number; offsets: number[] }> {
    const postsByKey = new Map<string, NormalizedVkPost>();
    const offsets: number[] = [];
    const maxPages = this.resolveFetchPageLimit(source, reason);
    const minPages = Math.min(this.minFetchPages, maxPages);

    for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
      const offset = pageIndex * this.fetchCount;
      offsets.push(offset);
      const wall = await this.fetchWall({
        ownerId: source.wallOwnerId,
        count: this.fetchCount,
        offset,
      });
      const pagePosts = (wall.items ?? [])
        .map((item) => this.normalizePost(item))
        .filter((post): post is NormalizedVkPost => post !== null);
      for (const post of pagePosts) {
        postsByKey.set(this.buildPostKey(post.vkOwnerId, post.vkPostId), post);
      }

      const fetchedPages = pageIndex + 1;
      if (fetchedPages < minPages) {
        if ((wall.items ?? []).length === 0) {
          break;
        }
        continue;
      }
      if ((wall.items ?? []).length < this.fetchCount) {
        break;
      }
      if (
        typeof source.lastVkNewestPostId === 'number' &&
        pagePosts.some((post) => post.vkPostId === source.lastVkNewestPostId)
      ) {
        break;
      }
    }

    return {
      posts: [...postsByKey.values()],
      pages: offsets.length,
      offsets,
    };
  }

  private resolveFetchPageLimit(source: VkParsingSourceRow, reason: VkParsingSyncReason): number {
    if (reason === 'source-added' || reason === 'manual' || !source.lastSuccessAt) {
      return this.maxFetchPages;
    }
    return Math.max(this.minFetchPages, Math.min(this.maxFetchPages, 3));
  }

  private resolveNewestPost(posts: NormalizedVkPost[]): NormalizedVkPost | null {
    return posts.reduce<NormalizedVkPost | null>((newest, post) => {
      if (!newest) {
        return post;
      }
      const left = post.vkPublishedAt?.getTime() ?? 0;
      const right = newest.vkPublishedAt?.getTime() ?? 0;
      return left > right || (left === right && post.vkPostId > newest.vkPostId) ? post : newest;
    }, null);
  }

  private resolveAdaptiveSyncIntervalMs(
    source: VkParsingSourceRow,
    posts: NormalizedVkPost[],
    now: Date,
  ): number {
    const newestPost = this.resolveNewestPost(posts);
    const newestAgeMs = newestPost?.vkPublishedAt
      ? Math.max(0, now.getTime() - newestPost.vkPublishedAt.getTime())
      : Number.POSITIVE_INFINITY;
    let baseMs = this.syncIntervalMs;
    if (newestAgeMs <= 60 * 60_000) {
      baseMs = this.minSyncIntervalMs;
    } else if (newestAgeMs <= 6 * 60 * 60_000) {
      baseMs = Math.max(this.minSyncIntervalMs, Math.floor(this.syncIntervalMs / 2));
    } else if (newestAgeMs >= 7 * 24 * 60 * 60_000) {
      baseMs = this.maxSyncIntervalMs;
    } else if (newestAgeMs >= 24 * 60 * 60_000) {
      baseMs = Math.min(this.maxSyncIntervalMs, this.syncIntervalMs * 3);
    }

    const bounded = Math.max(this.minSyncIntervalMs, Math.min(this.maxSyncIntervalMs, baseMs));
    return Math.max(this.minSyncIntervalMs, bounded + this.resolveSourceJitterMs(source.id));
  }

  private resolveSourceJitterMs(sourceId: string): number {
    const hash = createHash('sha256').update(sourceId).digest();
    const ratio = hash[0]! / 255;
    return Math.floor((ratio - 0.5) * Math.min(30_000, this.syncIntervalMs * 0.1));
  }

  private async upsertPostsBatch(
    source: VkParsingSourceRow,
    posts: NormalizedVkPost[],
    seenAt: Date,
  ): Promise<ImportedPostsBatchResult> {
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

    const autoPublishCandidatePostKeys = new Set<string>();
    const operations = posts.map((post) => {
      const existing = existingByPostKey.get(this.buildPostKey(post.vkOwnerId, post.vkPostId));
      const status = this.resolveImportedPostStatus(existing ?? null, post);
      const postKey = this.buildPostKey(post.vkOwnerId, post.vkPostId);
      if (!existing) {
        autoPublishCandidatePostKeys.add(postKey);
      }
      const resetTransientState =
        status === VK_POST_STATUS_NEW
          ? {
              skippedAt: null,
              skipReason: null,
              autoPublishError: null,
              lastError: null,
            }
          : {};
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
          attachmentTypes: this.toJsonInput(post.attachmentTypes),
          unsupportedAttachments: this.toJsonInput(post.unsupportedAttachments),
          hasUnsupportedAttachments: post.hasUnsupportedAttachments,
          isAdvertising: post.isAdvertising,
          advertisingMarkers: this.toJsonInput(post.advertisingMarkers),
          raw: this.toJsonInput(post.raw),
          contentHash: post.contentHash,
          status,
          lastSeenAt: seenAt,
          missingSinceAt: null,
          missingSeenCount: 0,
          lastAvailabilityCheckedAt: seenAt,
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
          attachmentTypes: this.toJsonInput(post.attachmentTypes),
          unsupportedAttachments: this.toJsonInput(post.unsupportedAttachments),
          hasUnsupportedAttachments: post.hasUnsupportedAttachments,
          isAdvertising: post.isAdvertising,
          advertisingMarkers: this.toJsonInput(post.advertisingMarkers),
          raw: this.toJsonInput(post.raw),
          contentHash: post.contentHash,
          status,
          lastSeenAt: seenAt,
          missingSinceAt: null,
          missingSeenCount: 0,
          lastAvailabilityCheckedAt: seenAt,
          unavailableAt: null,
          ...resetTransientState,
        },
      });
    });

    if (operations.length > 0) {
      await this.prisma.$transaction(operations);
    }
    await this.markMissingPostsUnavailable(source, posts, seenAt);

    const importedNormalizedPosts = posts.filter((post) =>
      autoPublishCandidatePostKeys.has(this.buildPostKey(post.vkOwnerId, post.vkPostId)),
    );
    const importedCount = posts.filter(
      (post) => !existingByPostKey.has(this.buildPostKey(post.vkOwnerId, post.vkPostId)),
    ).length;
    const importedPosts =
      importedNormalizedPosts.length > 0
        ? await this.prisma.vkParsingPost.findMany({
            where: {
              chatId: source.chatId,
              vkOwnerId: source.wallOwnerId,
              vkPostId: { in: importedNormalizedPosts.map((post) => post.vkPostId) },
              status: VK_POST_STATUS_NEW,
            },
            include: { source: true },
            orderBy: [{ vkPublishedAt: 'asc' }, { createdAt: 'asc' }],
          })
        : [];

    return {
      imported: importedCount,
      importedPosts,
      publishCandidates: importedPosts,
    };
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
    existing: ExistingVkPostImportState | null,
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

    if (existing.status === VK_POST_STATUS_SKIPPED && existing.contentHash !== post.contentHash) {
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
      return !oldest || post.vkPublishedAt.getTime() < oldest.getTime()
        ? post.vkPublishedAt
        : oldest;
    }, null);
    if (!oldestFetchedAt) {
      return;
    }

    const candidates = await this.prisma.vkParsingPost.findMany({
      where: {
        sourceId: source.id,
        vkPublishedAt: { gte: oldestFetchedAt },
        vkPostId: { notIn: posts.map((post) => post.vkPostId) },
        status: {
          in: [VK_POST_STATUS_NEW, VK_POST_STATUS_FAILED, VK_POST_STATUS_CHANGED_AFTER_PUBLISH],
        },
      },
      select: {
        id: true,
        vkOwnerId: true,
        vkPostId: true,
        missingSeenCount: true,
      },
    });
    if (candidates.length === 0) {
      return;
    }

    const belowThreshold = candidates.filter(
      (post) => post.missingSeenCount + 1 < this.missingConfirmationThreshold,
    );
    if (belowThreshold.length > 0) {
      await this.prisma.vkParsingPost.updateMany({
        where: { id: { in: belowThreshold.map((post) => post.id) } },
        data: {
          missingSeenCount: { increment: 1 },
          missingSinceAt: seenAt,
          lastAvailabilityCheckedAt: seenAt,
        },
      });
    }

    const thresholdCandidates = candidates.filter(
      (post) => post.missingSeenCount + 1 >= this.missingConfirmationThreshold,
    );
    if (thresholdCandidates.length === 0) {
      return;
    }

    const foundPostKeys = await this.spotCheckMissingPosts(thresholdCandidates);
    const updateOperations = thresholdCandidates.map((post) => {
      const postKey = this.buildPostKey(post.vkOwnerId, post.vkPostId);
      if (foundPostKeys?.has(postKey)) {
        return this.prisma.vkParsingPost.update({
          where: { id: post.id },
          data: {
            missingSeenCount: 0,
            missingSinceAt: null,
            lastAvailabilityCheckedAt: seenAt,
          },
        });
      }

      return this.prisma.vkParsingPost.update({
        where: { id: post.id },
        data: {
          status: foundPostKeys === null ? undefined : VK_POST_STATUS_UNAVAILABLE,
          missingSeenCount: { increment: 1 },
          missingSinceAt: seenAt,
          lastAvailabilityCheckedAt: seenAt,
          unavailableAt: foundPostKeys === null ? undefined : seenAt,
        },
      });
    });

    await this.prisma.$transaction(updateOperations);
  }

  private async spotCheckMissingPosts(
    posts: Array<{ vkOwnerId: number; vkPostId: number }>,
  ): Promise<Set<string> | null> {
    try {
      return await this.fetchWallPostKeySet(posts);
    } catch (error) {
      if (error instanceof VkApiRequestError && !error.retryable) {
        return new Set();
      }
      this.logger.warn({ err: error }, 'VK missing post spot-check failed');
      return null;
    }
  }

  private shouldAutoPublishImportedPosts(reason: VkParsingSyncReason): boolean {
    return reason !== 'source-added';
  }

  private async enqueueAutoPublishImportedPosts(
    chatId: string,
    posts: VkParsingPostWithSource[],
  ): Promise<void> {
    if (posts.length === 0) {
      return;
    }

    const settings = await this.getSettingsForChat(chatId);
    if (!settings.autoPublishEnabled || !settings.autoPublishEnabledAt) {
      return;
    }

    for (const post of posts) {
      if (post.status !== VK_POST_STATUS_NEW) {
        continue;
      }
      if (!this.isPostEligibleForAutoPublish(post, settings.autoPublishEnabledAt)) {
        continue;
      }

      try {
        await this.enqueuePostPublish(post, 'autopublish');
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

  private async enqueuePostPublish(
    post: VkParsingPostWithSource,
    reason: VkParsingPublishReason,
  ): Promise<number> {
    const idempotencyKey = this.buildPublishIdempotencyKey(post);
    const now = new Date();
    const queued = await this.prisma.vkParsingPost.updateMany({
      where: {
        id: post.id,
        publishQueuedAt: null,
        publishLockedAt: null,
        ...(reason === 'autopublish' ? { publishIdempotencyKey: null } : {}),
      },
      data: {
        status: post.status === VK_POST_STATUS_FAILED ? VK_POST_STATUS_NEW : post.status,
        publishQueuedAt: now,
        publishLockedAt: null,
        publishIdempotencyKey: idempotencyKey,
        lastError: null,
        autoPublishError: reason === 'autopublish' ? null : post.autoPublishError,
      },
    });
    if (queued.count === 0) {
      return 0;
    }

    await this.publishQueue.add(
      VK_PUBLISH_JOB_NAME,
      {
        postId: post.id,
        chatId: post.chatId,
        reason,
        idempotencyKey,
        retryPolicyName: 'vk-parsing-publish',
        createdAt: now.toISOString(),
      },
      {
        jobId: this.buildPublishJobId(post.id, idempotencyKey),
        attempts: 3,
        backoff: { type: 'exponential', delay: 5_000 },
        removeOnComplete: true,
        removeOnFail: 500,
      },
    );

    return 1;
  }

  private resolvePhotoMediaIdentityMap(post: {
    attachments: Prisma.JsonValue | unknown;
    raw: Prisma.JsonValue | unknown;
    text: string;
  }): Map<string, string> {
    const parsed = parseVkWallPostAttachments({
      attachments: this.readAttachments(post.attachments),
      rawPost: this.asRecord(post.raw) ?? {},
      text: post.text,
      maxPhotos: VK_PARSING_MAX_PHOTOS,
      maxLinks: VK_PARSING_MAX_LINKS,
    });
    return new Map(parsed.photoMedia.map(({ url, mediaIdentity }) => [url, mediaIdentity]));
  }

  private async autoPublishPost(
    post: VkParsingPostWithSource,
    settings: VkParsingSettingsLike,
  ): Promise<void> {
    const photoUrls = this.readStringArray(post.photoUrls);
    const linkUrls = this.readStringArray(post.linkUrls);
    const skipReason = this.resolvePostSkipReason(
      {
        text: post.text,
        photoUrls,
        linkUrls,
        attachments: this.readAttachments(post.attachments),
        raw: this.asRecord(post.raw) ?? {},
        isAdvertising: this.readBooleanFlag(post.isAdvertising),
        advertisingMarkers: this.readStringArray(post.advertisingMarkers),
      },
      settings,
    );
    if (skipReason) {
      await this.markPostSkipped(post.id, skipReason);
      return;
    }

    const prepared = this.preparePublishPayload(
      {
        text: post.text,
        photoUrls,
        linkUrls,
      },
      settings,
    );
    try {
      this.assertPreparedPublishPayload(prepared);
    } catch (error) {
      await this.markPostAutoPublishFailed(post.id, error);
      throw error;
    }

    await this.publishPreparedPostToMax(post, prepared, {
      actorUserId: VK_PARSING_SYSTEM_ACTOR_USER_ID,
      trafficClass: 'background',
      debugAction: 'auto_publish_post',
      auto: true,
    });
  }

  private async markPostAutoPublishFailed(postId: string, error: unknown): Promise<void> {
    const message = this.formatError(error);
    await this.prisma.vkParsingPost.update({
      where: { id: postId },
      data: {
        status: VK_POST_STATUS_FAILED,
        lastError: message,
        autoPublishError: message,
        publishLockedAt: null,
        publishQueuedAt: null,
        publishIdempotencyKey: null,
      },
    });
  }

  private isPostEligibleForAutoPublish(
    post: Pick<VkParsingPostWithSource, 'createdAt' | 'vkPublishedAt'>,
    enabledAt: Date,
  ): boolean {
    if (post.createdAt.getTime() < enabledAt.getTime()) {
      return false;
    }

    return !post.vkPublishedAt || post.vkPublishedAt.getTime() >= enabledAt.getTime();
  }

  private async clearQueuedAutoPublishForChat(chatId: string): Promise<void> {
    await this.prisma.vkParsingPost.updateMany({
      where: {
        chatId,
        status: { in: [VK_POST_STATUS_NEW, VK_POST_STATUS_FAILED] },
        OR: [
          { publishQueuedAt: { not: null } },
          { publishLockedAt: { not: null } },
          { publishIdempotencyKey: { not: null } },
        ],
      },
      data: {
        publishQueuedAt: null,
        publishLockedAt: null,
        publishIdempotencyKey: null,
      },
    });
  }

  private async clearQueuedAutoPublishPost(postId: string): Promise<void> {
    await this.prisma.vkParsingPost.update({
      where: { id: postId },
      data: {
        publishQueuedAt: null,
        publishLockedAt: null,
        publishIdempotencyKey: null,
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

  private buildPublishJobId(postId: string, idempotencyKey: string): string {
    return `vk-parsing-publish__${postId}__${idempotencyKey}`;
  }

  private buildPublishIdempotencyKey(post: VkParsingPostWithSource): string {
    return createHash('sha256')
      .update(
        JSON.stringify({
          postId: post.id,
          chatId: post.chatId,
          contentHash: post.contentHash,
          status: post.status,
        }),
      )
      .digest('hex')
      .slice(0, 32);
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
    const text = this.readString(post.text);
    const parsedAttachments = parseVkWallPostAttachments({
      attachments,
      rawPost: post,
      text,
      maxPhotos: VK_PARSING_MAX_PHOTOS,
      maxLinks: VK_PARSING_MAX_LINKS,
    });
    const { photoUrls, linkUrls } = parsedAttachments;
    if (
      !text.trim() &&
      photoUrls.length === 0 &&
      linkUrls.length === 0 &&
      !parsedAttachments.hasUnsupportedAttachments
    ) {
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
      attachmentTypes: parsedAttachments.attachmentTypes,
      unsupportedAttachments: parsedAttachments.unsupportedAttachments,
      hasUnsupportedAttachments: parsedAttachments.hasUnsupportedAttachments,
      isAdvertising: parsedAttachments.isAdvertising,
      advertisingMarkers: parsedAttachments.advertisingMarkers,
      photoMedia: parsedAttachments.photoMedia,
      copyHistoryText: parsedAttachments.copyHistoryText,
      raw: post,
      contentHash: this.computePostContentHash({
        text,
        photoUrls,
        linkUrls,
        attachmentTypes: parsedAttachments.attachmentTypes,
        unsupportedAttachments: parsedAttachments.unsupportedAttachments,
        copyHistoryText: parsedAttachments.copyHistoryText,
        advertisingMarkers: parsedAttachments.advertisingMarkers,
      }),
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

  private async fetchWall(options: {
    domain?: string;
    ownerId?: number;
    count: number;
    offset?: number;
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
    if (typeof options.offset === 'number' && options.offset > 0) {
      params.offset = String(Math.max(0, Math.trunc(options.offset)));
    }

    const response = await this.requestVk('wall.get', params);
    if (!this.asRecord(response)) {
      throw new BadRequestException('VK вернул пустой ответ.');
    }

    return response as VkWallGetResponse;
  }

  private async fetchWallPostKeySet(
    posts: Array<{ vkOwnerId: number; vkPostId: number }>,
  ): Promise<Set<string>> {
    if (posts.length === 0) {
      return new Set();
    }
    const response = await this.requestVk('wall.getById', {
      posts: posts.map((post) => `${post.vkOwnerId}_${post.vkPostId}`).join(','),
      extended: '0',
    });
    const record = this.asRecord(response);
    const items = Array.isArray(response)
      ? response
      : Array.isArray(record?.items)
        ? record.items
        : [];

    const found = new Set<string>();
    for (const item of items) {
      const post = this.asRecord(item);
      const ownerId = this.readNumber(post?.owner_id);
      const postId = this.readNumber(post?.id);
      if (typeof ownerId === 'number' && typeof postId === 'number') {
        found.add(this.buildPostKey(ownerId, postId));
      }
    }

    return found;
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
          const message =
            code === 14
              ? 'VK требует капчу или токен не подходит для запроса.'
              : this.readString(error.error_msg) || 'VK API отклонил запрос.';
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
      trafficClass: MaxApiTrafficClass;
      sourceTag: string;
    },
    options: {
      allowPartialFailures?: boolean;
      canPublishWithoutPhotos?: boolean;
    } = {},
    photoMediaIdentityByUrl: Map<string, string> = new Map(),
  ): Promise<Record<string, unknown>[]> {
    const payloads = new Array<Record<string, unknown> | null>(photoUrls.length).fill(null);
    const skippedErrors: string[] = [];
    const uploadConcurrency =
      requestOptions.trafficClass === 'background' ? 1 : this.mediaConcurrency;
    await this.mapWithConcurrency(photoUrls, uploadConcurrency, async (url, index) => {
      try {
        const mediaIdentity = photoMediaIdentityByUrl.get(url) ?? null;
        payloads[index] = await this.resolveUploadPayloadForMedia(
          url,
          index,
          requestOptions,
          mediaIdentity,
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
    mediaIdentity: string | null,
  ): Promise<Record<string, unknown>> {
    const cache = await this.assertMediaReadyForPublish(imageUrl, index, mediaIdentity);
    const cachedPayload = this.readUploadPayload(cache);
    if (cachedPayload) {
      return cachedPayload;
    }

    const image = await this.downloadImage(imageUrl, index);
    const payload = await this.maxClient.uploadImage(
      image.buffer,
      image.fileName,
      image.mimeType,
      requestOptions,
    );
    await this.writeMediaCache(
      imageUrl,
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
  }

  private async preflightPostMediaSafely(posts: NormalizedVkPost[]): Promise<void> {
    const photoUrls = [...new Set(posts.flatMap((post) => post.photoUrls))];
    if (photoUrls.length === 0) {
      return;
    }
    const mediaIdentityByUrl = new Map(
      posts.flatMap((post) =>
        post.photoMedia.map((item) => [item.url, item.mediaIdentity] as const),
      ),
    );

    try {
      await this.mapWithConcurrency(photoUrls, this.mediaConcurrency, async (url) => {
        await this.preflightMediaUrl(url, mediaIdentityByUrl.get(url) ?? null);
      });
    } catch (error) {
      this.logger.warn(
        { err: error },
        'VK media preflight failed unexpectedly after per-url safeguards',
      );
    }
  }

  private async assertMediaReadyForPublish(
    imageUrl: string,
    index: number,
    mediaIdentity: string | null = null,
  ): Promise<VkParsingMediaCacheRow> {
    const cache = await this.preflightMediaUrl(imageUrl, mediaIdentity);
    if (cache.status === VK_MEDIA_STATUS_FAILED) {
      throw new BadRequestException(cache.lastError || `Фото ${index + 1} недоступно.`);
    }
    return cache;
  }

  private async preflightMediaUrl(
    imageUrl: string,
    mediaIdentity: string | null = null,
  ): Promise<VkParsingMediaCacheRow> {
    const cached = await this.findMediaCache(imageUrl, mediaIdentity);
    if (cached?.lastCheckedAt) {
      const ageMs = Date.now() - cached.lastCheckedAt.getTime();
      const cacheTtlMs =
        cached.status === VK_MEDIA_STATUS_FAILED
          ? this.mediaFailedPreflightTtlMs
          : this.mediaPreflightTtlMs;
      if (ageMs >= 0 && ageMs < cacheTtlMs && cached.status !== VK_MEDIA_STATUS_UNKNOWN) {
        return cached;
      }
    }

    let parsed: URL;
    try {
      parsed = new URL(imageUrl);
      if (parsed.protocol !== 'https:') {
        return this.writeMediaCache(
          imageUrl,
          {
            status: VK_MEDIA_STATUS_FAILED,
            lastError: 'Фото VK должно быть доступно по HTTPS.',
          },
          mediaIdentity,
        );
      }
    } catch {
      return this.writeMediaCache(
        imageUrl,
        {
          status: VK_MEDIA_STATUS_FAILED,
          lastError: 'Некорректная ссылка на фото VK.',
        },
        mediaIdentity,
      );
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), VK_IMAGE_FETCH_TIMEOUT_MS);
    try {
      const response = await this.fetchMediaPreflightResponse(parsed, controller.signal);
      if (!response.ok) {
        return this.writeMediaCache(
          imageUrl,
          {
            status: VK_MEDIA_STATUS_FAILED,
            lastError: `VK вернул статус ${response.status} для фото.`,
          },
          mediaIdentity,
        );
      }

      const headers = response.headers ?? new Headers();
      const contentLength = this.readMediaContentLength(headers, response.status);
      if ((contentLength ?? 0) > VK_IMAGE_MAX_BYTES) {
        return this.writeMediaCache(
          imageUrl,
          {
            status: VK_MEDIA_STATUS_FAILED,
            contentLength,
            lastError: 'Фото из VK слишком большое.',
          },
          mediaIdentity,
        );
      }

      const mimeType = (headers.get('content-type') ?? '').split(';')[0]!.trim();
      if (mimeType && !mimeType.toLowerCase().startsWith('image/')) {
        return this.writeMediaCache(
          imageUrl,
          {
            status: VK_MEDIA_STATUS_FAILED,
            mimeType,
            contentLength: contentLength || null,
            lastError: 'VK вернул не изображение.',
          },
          mediaIdentity,
        );
      }

      return this.writeMediaCache(
        imageUrl,
        {
          status: VK_MEDIA_STATUS_READY,
          mimeType: mimeType || null,
          contentLength,
          lastError: null,
        },
        mediaIdentity,
      );
    } catch (error) {
      return this.writeMediaCache(
        imageUrl,
        {
          status: VK_MEDIA_STATUS_FAILED,
          lastError:
            error instanceof Error && error.name === 'AbortError'
              ? 'VK не ответил на проверку фото вовремя.'
              : this.formatError(error),
        },
        mediaIdentity,
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  private async fetchMediaPreflightResponse(url: URL, signal: AbortSignal): Promise<Response> {
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
      maxUploadPayload?: Record<string, unknown> | null;
      maxUploadToken?: string | null;
      maxUploadedAt?: Date | null;
    },
    mediaIdentity: string | null = null,
  ): Promise<VkParsingMediaCacheRow> {
    const lastCheckedAt = new Date();
    const updateData: Prisma.VkParsingMediaCacheUpdateInput = {
      status: data.status,
      mimeType: data.mimeType ?? null,
      contentLength: data.contentLength ?? null,
      lastCheckedAt,
      lastError: data.lastError ?? null,
      ...(mediaIdentity ? { mediaIdentity } : {}),
      ...(data.maxUploadPayload
        ? { maxUploadPayload: this.toJsonInput(data.maxUploadPayload) }
        : {}),
      ...(typeof data.maxUploadToken === 'string' ? { maxUploadToken: data.maxUploadToken } : {}),
      ...(data.maxUploadedAt ? { maxUploadedAt: data.maxUploadedAt } : {}),
      ...(data.maxUploadPayload ? { uploadAttemptCount: { increment: 1 } } : {}),
    };
    const createData: Prisma.VkParsingMediaCacheCreateInput = {
      url,
      mediaIdentity,
      status: data.status,
      mimeType: data.mimeType ?? null,
      contentLength: data.contentLength ?? null,
      lastCheckedAt,
      lastError: data.lastError ?? null,
      ...(data.maxUploadPayload
        ? { maxUploadPayload: this.toJsonInput(data.maxUploadPayload) }
        : {}),
      ...(typeof data.maxUploadToken === 'string' ? { maxUploadToken: data.maxUploadToken } : {}),
      ...(data.maxUploadedAt ? { maxUploadedAt: data.maxUploadedAt } : {}),
      uploadAttemptCount: data.maxUploadPayload ? 1 : 0,
    };

    if (mediaIdentity) {
      const existing = await this.prisma.vkParsingMediaCache.findFirst({
        where: { OR: [{ mediaIdentity }, { url }] },
      });
      if (existing) {
        return this.prisma.vkParsingMediaCache.update({
          where: { id: existing.id },
          data: {
            url,
            ...updateData,
          },
        });
      }
    }

    return this.prisma.vkParsingMediaCache.upsert({
      where: { url },
      create: createData,
      update: updateData,
    });
  }

  private async findMediaCache(
    url: string,
    mediaIdentity: string | null,
  ): Promise<VkParsingMediaCacheRow | null> {
    if (mediaIdentity) {
      const cached = await this.prisma.vkParsingMediaCache.findFirst({
        where: { OR: [{ mediaIdentity }, { url }] },
      });
      if (cached) {
        return cached;
      }
    }

    return this.prisma.vkParsingMediaCache.findUnique({ where: { url } });
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

  private composePublishText(text: string, linkUrls: string[]): string {
    const base = text.trim();
    const missingLinks = linkUrls.filter((url) => !base.includes(url));
    return [base, ...missingLinks].filter(Boolean).join('\n');
  }

  private preparePublishPayload(
    payload: PreparedVkPublishPayload,
    settings: VkParsingSettingsLike,
  ): PreparedVkPublishPayload {
    const text = settings.stripLinksEnabled ? this.stripLinksFromText(payload.text) : payload.text;
    const linkUrls = settings.stripLinksEnabled ? [] : payload.linkUrls;
    return {
      text: this.composePublishText(text, linkUrls),
      photoUrls: payload.photoUrls,
      linkUrls,
    };
  }

  private assertPreparedPublishPayload(payload: PreparedVkPublishPayload): void {
    if (
      payload.text.trim().length === 0 &&
      payload.photoUrls.length === 0 &&
      payload.linkUrls.length === 0
    ) {
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

  private stripLinksFromText(text: string): string {
    VK_INLINE_LINK_PATTERN.lastIndex = 0;
    return text
      .replace(VK_INLINE_LINK_PATTERN, '')
      .replace(/[ \t]+\n/gu, '\n')
      .replace(/\n[ \t]+/gu, '\n')
      .replace(/[ \t]{2,}/gu, ' ')
      .replace(/\n{3,}/gu, '\n\n')
      .trim();
  }

  private resolvePostSkipReason(
    post: {
      text: string;
      photoUrls: string[];
      linkUrls: string[];
      attachments: Array<Record<string, unknown>>;
      raw: Record<string, unknown>;
      isAdvertising?: boolean;
      advertisingMarkers?: string[];
    },
    settings: VkParsingSettingsLike,
  ): VkParsingSkipReason | null {
    if (settings.skipAdsEnabled && this.isAdvertisingPost(post)) {
      return VK_POST_SKIP_REASON_AD;
    }

    if (
      settings.stripLinksEnabled &&
      post.photoUrls.length === 0 &&
      this.stripLinksFromText(post.text).length === 0 &&
      (post.linkUrls.length > 0 || this.hasInlineLinks(post.text))
    ) {
      return VK_POST_SKIP_REASON_EMPTY_AFTER_LINK_FILTER;
    }

    return null;
  }

  private hasInlineLinks(text: string): boolean {
    VK_INLINE_LINK_PATTERN.lastIndex = 0;
    return VK_INLINE_LINK_PATTERN.test(text);
  }

  private isAdvertisingPost(post: {
    text: string;
    attachments: Array<Record<string, unknown>>;
    raw: Record<string, unknown>;
    isAdvertising?: boolean;
    advertisingMarkers?: string[];
  }): boolean {
    if (post.isAdvertising) {
      return true;
    }

    const markers = post.advertisingMarkers?.length
      ? post.advertisingMarkers
      : parseVkWallPostAttachments({
          attachments: post.attachments,
          rawPost: post.raw,
          text: post.text,
          maxPhotos: 0,
          maxLinks: 0,
        }).advertisingMarkers;
    return markers.length > 0 || this.readBooleanFlag(post.raw.marked_as_ads);
  }

  private describeSkipReason(reason: VkParsingSkipReason): string {
    return reason === VK_POST_SKIP_REASON_AD
      ? 'Пост пропущен фильтром рекламы.'
      : 'Пост пропущен: после удаления ссылок не осталось содержимого.';
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
        lastError: this.describeSkipReason(reason),
        publishLockedAt: null,
        publishQueuedAt: null,
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

  private computePostContentHash(params: {
    text: string;
    photoUrls: string[];
    linkUrls: string[];
    attachmentTypes?: string[];
    unsupportedAttachments?: VkParsingUnsupportedAttachmentSummary[];
    copyHistoryText?: string[];
    advertisingMarkers?: string[];
  }): string {
    return createHash('sha256')
      .update(
        JSON.stringify({
          text: params.text.trim(),
          photoUrls: params.photoUrls,
          linkUrls: params.linkUrls,
          attachmentTypes: params.attachmentTypes ?? [],
          unsupportedAttachments: params.unsupportedAttachments ?? [],
          copyHistoryText: params.copyHistoryText ?? [],
          advertisingMarkers: params.advertisingMarkers ?? [],
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

  private mapSettings(
    chatId: string,
    settings: VkParsingSettingsRow | VkParsingSettingsLike | null,
  ): VkParsingSettings {
    return {
      chatId,
      autoPublishEnabled: settings?.autoPublishEnabled ?? false,
      autoPublishEnabledAt: settings?.autoPublishEnabledAt
        ? settings.autoPublishEnabledAt.toISOString()
        : null,
      stripLinksEnabled: settings?.stripLinksEnabled ?? false,
      skipAdsEnabled: settings?.skipAdsEnabled ?? false,
      updatedAt: settings?.updatedAt ? settings.updatedAt.toISOString() : null,
    };
  }

  private getDefaultSettings(chatId: string): VkParsingSettingsLike {
    return {
      chatId,
      autoPublishEnabled: false,
      autoPublishEnabledAt: null,
      stripLinksEnabled: false,
      skipAdsEnabled: false,
      updatedAt: null,
    };
  }

  private async getSettingsForChat(chatId: string): Promise<VkParsingSettingsLike> {
    const settings = await this.prisma.vkParsingSettings.findUnique({ where: { chatId } });
    return settings ?? this.getDefaultSettings(chatId);
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
      lastFetchedPages: Math.max(0, source.lastFetchedPages ?? 0),
      lastFetchedOffsets: this.readNumberArray(source.lastFetchedOffsets),
      lastVkNewestPostId: source.lastVkNewestPostId ?? null,
      lastVkNewestPublishedAt: source.lastVkNewestPublishedAt
        ? source.lastVkNewestPublishedAt.toISOString()
        : null,
      adaptiveIntervalMs:
        typeof source.adaptiveIntervalMs === 'number' && source.adaptiveIntervalMs >= 0
          ? source.adaptiveIntervalMs
          : null,
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
              : post.status === VK_POST_STATUS_SKIPPED
                ? 'SKIPPED'
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
      attachmentTypes: this.readStringArray(post.attachmentTypes),
      unsupportedAttachments: this.readUnsupportedAttachments(post.unsupportedAttachments),
      hasUnsupportedAttachments: Boolean(post.hasUnsupportedAttachments),
      isAdvertising: Boolean(post.isAdvertising),
      advertisingMarkers: this.readStringArray(post.advertisingMarkers),
      status,
      contentHash: post.contentHash,
      publishedContentHash: post.publishedContentHash,
      publishedMessageId: post.publishedMessageId,
      publishedUrl: post.publishedUrl,
      publishedAtMax: post.publishedAtMax ? post.publishedAtMax.toISOString() : null,
      autoPublishedAt: post.autoPublishedAt ? post.autoPublishedAt.toISOString() : null,
      autoPublishError: post.autoPublishError,
      skippedAt: post.skippedAt ? post.skippedAt.toISOString() : null,
      skipReason:
        post.skipReason === VK_POST_SKIP_REASON_AD ||
        post.skipReason === VK_POST_SKIP_REASON_EMPTY_AFTER_LINK_FILTER
          ? post.skipReason
          : null,
      lastSeenAt: post.lastSeenAt ? post.lastSeenAt.toISOString() : null,
      missingSinceAt: post.missingSinceAt ? post.missingSinceAt.toISOString() : null,
      missingSeenCount: Math.max(0, post.missingSeenCount ?? 0),
      lastAvailabilityCheckedAt: post.lastAvailabilityCheckedAt
        ? post.lastAvailabilityCheckedAt.toISOString()
        : null,
      unavailableAt: post.unavailableAt ? post.unavailableAt.toISOString() : null,
      publishQueuedAt: post.publishQueuedAt ? post.publishQueuedAt.toISOString() : null,
      publishLockedAt: post.publishLockedAt ? post.publishLockedAt.toISOString() : null,
      publishAttemptCount: Math.max(0, post.publishAttemptCount ?? 0),
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

  private readNumberArray(value: Prisma.JsonValue | unknown): number[] {
    if (!Array.isArray(value)) {
      return [];
    }

    return value.filter(
      (item): item is number => typeof item === 'number' && Number.isFinite(item) && item >= 0,
    );
  }

  private readUnsupportedAttachments(
    value: Prisma.JsonValue | unknown,
  ): VkParsingUnsupportedAttachmentSummary[] {
    if (!Array.isArray(value)) {
      return [];
    }

    return value
      .map((item) => this.asRecord(item))
      .filter((item): item is Record<string, unknown> => item !== null)
      .map((item) => ({
        type: this.readString(item.type) || 'unknown',
        label: this.readString(item.label) || this.readString(item.type) || 'unknown',
        title: this.readString(item.title) || null,
        url: this.normalizeHttpUrl(this.readString(item.url)) ?? null,
        count: Math.max(1, this.readNumber(item.count) ?? 1),
        reason: this.readString(item.reason) || null,
      }));
  }

  private toJsonInput(value: unknown): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(value ?? null)) as Prisma.InputJsonValue;
  }

  private normalizeBaseUrl(value: string): string {
    return value.replace(/\/+$/u, '');
  }

  private normalizeHttpUrl(value: string): string | null {
    if (!value) {
      return null;
    }
    try {
      const url = new URL(value.startsWith('//') ? `https:${value}` : value);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        return null;
      }
      return url.toString();
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

  private readBooleanFlag(value: unknown): boolean {
    if (typeof value === 'boolean') {
      return value;
    }
    if (typeof value === 'number') {
      return value === 1;
    }
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      return normalized === '1' || normalized === 'true' || normalized === 'yes';
    }
    return false;
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
