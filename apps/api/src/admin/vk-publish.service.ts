import {
  publishVkParsingPostRequestSchema,
  retryVkParsingPostResultSchema,
  VK_PARSING_MAX_LINKS,
  VK_PARSING_MAX_PHOTOS,
  VK_PARSING_MAX_PUBLISH_TEXT_LENGTH,
  type PublishVkParsingPostResult,
  type RetryVkParsingPostResult,
} from '@maxim/contracts';
import { InjectQueue } from '@nestjs/bullmq';
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
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
import { ChatEntityType, Prisma } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { AdminService } from './admin.service';
import { VkParsingAccessService } from './vk-parsing-access.service';
import { parseVkWallPostAttachments } from './vk-parsing-attachments';
import {
  computeVkParsingPostContentHash,
  describeVkParsingSkipReason,
  prepareVkParsingPublishPayload,
  resolveVkParsingPostSkipReason,
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
  stripLinksEnabled: boolean;
  skipAdsEnabled: boolean;
  updatedAt: Date | null;
};

const VK_POST_STATUS_NEW = 'NEW';
const VK_POST_STATUS_PUBLISHED = 'PUBLISHED';
const VK_POST_STATUS_FAILED = 'FAILED';
const VK_POST_STATUS_UNAVAILABLE = 'UNAVAILABLE';
const VK_POST_STATUS_SKIPPED = 'SKIPPED';
const VK_PUBLISH_JOB_NAME = 'publish-vk-post';
const VK_PARSING_SYSTEM_ACTOR_USER_ID = 'vk-parsing-autopost';

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

      if (
        reason === 'autopublish' &&
        (!settings.autoPublishEnabled ||
          !settings.autoPublishEnabledAt ||
          !this.isPostEligibleForAutoPublish(post, settings.autoPublishEnabledAt))
      ) {
        await this.clearQueuedAutoPublishPost(post.id, idempotencyKey);
        continue;
      }

      await this.addPublishJob(post, reason, idempotencyKey, now);
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

  async processPublishPostJob(params: {
    postId: string;
    chatId: string;
    reason: VkParsingPublishReason;
    idempotencyKey: string;
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
        await this.clearQueuedAutoPublishPost(post.id, params.idempotencyKey);
        return;
      }
      await this.autoPublishPost(post, settings);
    } catch (error) {
      await this.markPostAutoPublishFailed(post.id, error);
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
        ],
      },
      data: {
        publishQueuedAt: null,
        publishLockedAt: null,
        publishIdempotencyKey: null,
        publishReason: null,
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
          publishLockedAt: null,
          publishIdempotencyKey: null,
          publishReason: null,
          skippedAt: null,
          skipReason: null,
          lastError: null,
        },
        include: { source: true },
      });

      return {
        post: this.feedService.mapPost(updated),
        messageId: result.messageId,
        url: result.url,
      };
    } catch (error) {
      const classified = classifyVkParsingPublishError(error);
      const formattedError = formatVkParsingClassifiedErrorMessage(classified);
      await this.prisma.vkParsingPost.update({
        where: { id: post.id },
        data: {
          status: VK_POST_STATUS_FAILED,
          publishLockedAt: null,
          lastError: formattedError,
          autoPublishError: params.auto ? formattedError : post.autoPublishError,
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
        if (!isMaxAttachmentNotReadyError(error) || attempt >= 3) {
          throw error;
        }
        await this.sleep(750 * 2 ** (attempt - 1));
      }
    }

    throw lastError instanceof Error ? lastError : new Error('MAX attachment is not ready.');
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
        publishReason: reason,
        lastError: null,
        autoPublishError: reason === 'autopublish' ? null : post.autoPublishError,
      },
    });
    if (queued.count === 0) {
      return 0;
    }

    await this.addPublishJob(post, reason, idempotencyKey, now);

    return 1;
  }

  private async addPublishJob(
    post: Pick<VkParsingPostWithSource, 'id' | 'chatId'>,
    reason: VkParsingPublishReason,
    idempotencyKey: string,
    createdAt: Date,
  ): Promise<void> {
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
        ...VK_PARSING_PUBLISH_RETRY_POLICY,
      },
    );
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
    const message = formatVkParsingClassifiedErrorMessage(classifyVkParsingPublishError(error));
    await this.prisma.vkParsingPost.update({
      where: { id: postId },
      data: {
        status: VK_POST_STATUS_FAILED,
        lastError: message,
        autoPublishError: message,
        publishLockedAt: null,
        publishQueuedAt: null,
        publishIdempotencyKey: null,
        publishReason: null,
      },
    });
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
    return reason === 'manual-retry' ? 'manual-retry' : 'autopublish';
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
    await this.mediaCache.writeMediaCache(
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

  private async assertMediaReadyForPublish(
    imageUrl: string,
    index: number,
    mediaIdentity: string | null = null,
  ): Promise<VkParsingMediaCacheRow> {
    const cache = await this.mediaCache.preflightMediaUrl(imageUrl, mediaIdentity);
    if (cache.status === VK_MEDIA_STATUS_FAILED) {
      throw new BadRequestException(cache.lastError || `Фото ${index + 1} недоступно.`);
    }
    return cache;
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
        lastError: describeVkParsingSkipReason(reason),
        publishLockedAt: null,
        publishQueuedAt: null,
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
