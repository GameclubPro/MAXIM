import { VK_PARSING_MAX_LINKS, VK_PARSING_MAX_PHOTOS } from '@maxim/contracts';
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { Prisma } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { VkApiClientService } from './vk-api-client.service';
import {
  parseVkWallPostAttachments,
  type VkParsingPhotoMediaIdentity,
  type VkParsingUnsupportedAttachmentSummary,
  type VkParsingVideoMediaIdentity,
} from './vk-parsing-attachments';
import { computeVkParsingPostContentHash } from './vk-parsing-content';
import {
  classifyVkParsingMediaPreflightError,
  classifyVkParsingSyncError,
  VkApiRequestError,
} from './vk-parsing-errors';
import { VkParsingMediaCacheService } from './vk-parsing-media-cache.service';
import {
  VkParsingPostImportRepository,
  type ExistingVkPostImportState,
  type PreparedVkPostImport,
} from './vk-parsing-post-import.repository';
import { type VkParsingSyncReason } from './vk-parsing.queue';
import { VkPublishService } from './vk-publish.service';

type VkParsingSourceRow = Prisma.VkParsingSourceGetPayload<Record<string, never>>;
type VkParsingPostWithSource = Prisma.VkParsingPostGetPayload<{ include: { source: true } }>;

type VkWallGetResponse = {
  count?: number;
  items?: unknown[];
  groups?: unknown[];
};

type NormalizedVkPost = {
  vkOwnerId: number;
  vkPostId: number;
  vkPublishedAt: Date | null;
  text: string;
  url: string;
  photoUrls: string[];
  videoUrls: string[];
  linkUrls: string[];
  attachments: Array<Record<string, unknown>>;
  attachmentTypes: string[];
  unsupportedAttachments: VkParsingUnsupportedAttachmentSummary[];
  hasUnsupportedAttachments: boolean;
  isAdvertising: boolean;
  advertisingMarkers: string[];
  photoMedia: VkParsingPhotoMediaIdentity[];
  videoMedia: VkParsingVideoMediaIdentity[];
  copyHistoryText: string[];
  raw: Record<string, unknown>;
  contentHash: string;
};

type ImportedPostsBatchResult = {
  imported: number;
  importedPosts: VkParsingPostWithSource[];
  publishCandidates: VkParsingPostWithSource[];
  mediaPreflightPosts: NormalizedVkPost[];
};

const VK_SOURCE_STATUS_ACTIVE = 'ACTIVE';
const VK_SOURCE_SYNC_STATUS_IDLE = 'IDLE';
const VK_SOURCE_SYNC_STATUS_SYNCING = 'SYNCING';
const VK_SOURCE_SYNC_STATUS_BACKOFF = 'BACKOFF';
const VK_SOURCE_SYNC_STATUS_ERROR = 'ERROR';
const VK_POST_STATUS_NEW = 'NEW';
const VK_POST_STATUS_PUBLISHED = 'PUBLISHED';
const VK_POST_STATUS_CHANGED_AFTER_PUBLISH = 'CHANGED_AFTER_PUBLISH';
const VK_POST_STATUS_UNAVAILABLE = 'UNAVAILABLE';
const VK_POST_STATUS_SKIPPED = 'SKIPPED';
const VK_PARSING_WARNING_DEDUPE_MS = 60_000;

@Injectable()
export class VkSyncService {
  private readonly logger = new Logger(VkSyncService.name);
  private readonly syncIntervalMs: number;
  private readonly minSyncIntervalMs: number;
  private readonly maxSyncIntervalMs: number;
  private readonly fetchCount: number;
  private readonly minFetchPages: number;
  private readonly maxFetchPages: number;
  private readonly missingConfirmationThreshold: number;
  private readonly syncLeaseTtlMs: number;
  private readonly mediaConcurrency: number;
  private readonly sourceCircuitTerminalFailureThreshold: number;
  private readonly workerId = `${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
  private readonly warningDedupe = new Map<string, { loggedAtMs: number; suppressed: number }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly vkApiClient: VkApiClientService,
    private readonly publishService: VkPublishService,
    private readonly mediaCache: VkParsingMediaCacheService,
    private readonly postImportRepository: VkParsingPostImportRepository,
    configService: ConfigService,
  ) {
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
    this.syncLeaseTtlMs = configService.get<number>('VK_PARSING_LEASE_TTL_MS') ?? 120_000;
    this.mediaConcurrency = configService.get<number>('VK_PARSING_MEDIA_CONCURRENCY') ?? 3;
    this.sourceCircuitTerminalFailureThreshold = Math.max(
      1,
      configService.get<number>('VK_PARSING_SOURCE_CIRCUIT_TERMINAL_FAILURE_THRESHOLD') ?? 1,
    );
  }

  getSyncIntervalMs(): number {
    return this.syncIntervalMs;
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

  private async syncSource(
    source: VkParsingSourceRow,
    reason: VkParsingSyncReason,
  ): Promise<number> {
    const startedAt = new Date();
    try {
      const wallPages = await this.fetchWallPages(source, reason);
      if (wallPages.leaseLost) {
        return 0;
      }
      const posts = wallPages.posts;

      if (!(await this.recordSourceHeartbeat(source.id))) {
        return 0;
      }
      const importResult = await this.upsertPostsBatch(source, posts, startedAt);
      if (!(await this.recordSourceHeartbeat(source.id))) {
        return 0;
      }
      if (this.shouldAutoPublishImportedPosts(source, reason)) {
        await this.publishService.enqueueAutoPublishImportedPosts(
          source.chatId,
          importResult.publishCandidates,
        );
      }
      const completedAt = new Date();
      const adaptiveIntervalMs = this.resolveAdaptiveSyncIntervalMs(source, posts, completedAt);
      const newestPost = this.resolveNewestPost(posts);

      const completed = await this.prisma.vkParsingSource.updateMany({
        where: this.buildOwnedSourceLeaseWhere(source.id),
        data: {
          syncStatus: VK_SOURCE_SYNC_STATUS_IDLE,
          nextSyncAt: new Date(completedAt.getTime() + adaptiveIntervalMs),
          lastSyncAt: completedAt,
          lastSuccessAt: completedAt,
          syncStartedAt: null,
          syncLockedAt: null,
          syncLockedBy: null,
          syncLockDeadlineAt: null,
          syncHeartbeatAt: null,
          consecutiveFailures: 0,
          terminalFailureCount: 0,
          circuitOpenedAt: null,
          circuitReasonCode: null,
          circuitReason: null,
          circuitRetryAt: null,
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
      if (completed.count === 0) {
        return 0;
      }
      if (reason !== 'source-added') {
        void this.preflightPostMediaSafely(source, importResult.mediaPreflightPosts);
      }
      return importResult.imported;
    } catch (error) {
      const completedAt = new Date();
      const classified = classifyVkParsingSyncError(error);
      const failureCount = source.consecutiveFailures + 1;
      const isCircuitBreakerFailure = this.isSourceCircuitBreakerFailure(classified);
      const terminalFailureCount = isCircuitBreakerFailure ? source.terminalFailureCount + 1 : 0;
      const openCircuit =
        isCircuitBreakerFailure &&
        terminalFailureCount >= this.sourceCircuitTerminalFailureThreshold;
      const retryTerminalBeforeCircuit = isCircuitBreakerFailure && !openCircuit;
      const backoffMs =
        classified.retryable || retryTerminalBeforeCircuit
          ? this.resolveSyncBackoffMs(failureCount)
          : null;
      const nextRetryAt = backoffMs === null ? null : new Date(completedAt.getTime() + backoffMs);
      const failed = await this.prisma.vkParsingSource.updateMany({
        where: this.buildOwnedSourceLeaseWhere(source.id),
        data: {
          syncStatus:
            backoffMs !== null ? VK_SOURCE_SYNC_STATUS_BACKOFF : VK_SOURCE_SYNC_STATUS_ERROR,
          nextSyncAt: nextRetryAt,
          lastSyncAt: completedAt,
          syncStartedAt: null,
          syncLockedAt: null,
          syncLockedBy: null,
          syncLockDeadlineAt: null,
          syncHeartbeatAt: null,
          consecutiveFailures: failureCount,
          terminalFailureCount,
          circuitOpenedAt: openCircuit ? completedAt : null,
          circuitReasonCode: openCircuit ? classified.code : null,
          circuitReason: openCircuit ? classified.message : null,
          circuitRetryAt: retryTerminalBeforeCircuit ? nextRetryAt : null,
          lastErrorCode: classified.code,
          lastImportedCount: 0,
          lastFetchedCount: 0,
          lastSyncDurationMs: Math.max(0, completedAt.getTime() - startedAt.getTime()),
          lastError: classified.message,
        },
      });
      if (failed.count === 0) {
        return 0;
      }
      this.logDedupedWarning(
        `vk-sync:${source.id}:${classified.code}`,
        {
          sourceId: source.id,
          chatId: source.chatId,
          reason: classified.code,
          retryable: classified.retryable,
          circuitOpen: openCircuit,
          terminalFailureCount,
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
  ): Promise<{
    posts: NormalizedVkPost[];
    pages: number;
    offsets: number[];
    leaseLost: boolean;
  }> {
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
      if (!(await this.recordSourceHeartbeat(source.id))) {
        return { posts: [], pages: offsets.length, offsets, leaseLost: true };
      }
      const pagePosts = (wall.items ?? [])
        .map((item) => this.normalizePost(item))
        .filter(
          (post): post is NormalizedVkPost =>
            post !== null && post.vkOwnerId === source.wallOwnerId,
        );
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
      leaseLost: false,
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
    const sourceIntervalMs =
      typeof source.publishIntervalMinutes === 'number' && source.publishIntervalMinutes > 0
        ? source.publishIntervalMinutes * 60_000
        : this.syncIntervalMs;
    let baseMs = sourceIntervalMs;
    if (newestAgeMs <= 60 * 60_000) {
      baseMs = this.minSyncIntervalMs;
    } else if (newestAgeMs <= 6 * 60 * 60_000) {
      baseMs = Math.max(this.minSyncIntervalMs, Math.floor(sourceIntervalMs / 2));
    } else if (newestAgeMs >= 7 * 24 * 60 * 60_000) {
      baseMs = this.maxSyncIntervalMs;
    } else if (newestAgeMs >= 24 * 60 * 60_000) {
      baseMs = Math.min(this.maxSyncIntervalMs, sourceIntervalMs * 3);
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
    const existingRows = await this.postImportRepository.findExistingPosts(source, posts);
    const existingByPostKey = new Map(
      existingRows.map((row) => [this.buildPostKey(row.vkOwnerId, row.vkPostId), row]),
    );

    const autoPublishCandidatePostKeys = new Set<string>();
    const mediaPreflightPosts: NormalizedVkPost[] = [];
    const preparedPosts = posts.map((post): PreparedVkPostImport => {
      const existing = existingByPostKey.get(this.buildPostKey(post.vkOwnerId, post.vkPostId));
      const status = this.resolveImportedPostStatus(existing ?? null, post);
      const postKey = this.buildPostKey(post.vkOwnerId, post.vkPostId);
      if (!existing) {
        autoPublishCandidatePostKeys.add(postKey);
      }
      if (!existing || existing.contentHash !== post.contentHash) {
        mediaPreflightPosts.push(post);
      }
      return { post, status };
    });

    await this.postImportRepository.persistImportedPosts(source, preparedPosts, seenAt);
    await this.postImportRepository.markMissingPostsUnavailable(source, posts, seenAt, {
      missingConfirmationThreshold: this.missingConfirmationThreshold,
      spotCheckMissingPosts: (missingPosts) => this.spotCheckMissingPosts(missingPosts),
    });

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
      mediaPreflightPosts,
    };
  }

  private async acquireSourceLease(sourceId: string): Promise<VkParsingSourceRow | null> {
    const now = new Date();
    const staleLockBefore = new Date(now.getTime() - this.syncLeaseTtlMs);
    const syncLockDeadlineAt = new Date(now.getTime() + this.syncLeaseTtlMs);
    const updated = await this.prisma.vkParsingSource.updateMany({
      where: {
        id: sourceId,
        status: VK_SOURCE_STATUS_ACTIVE,
        importEnabled: true,
        circuitOpenedAt: null,
        OR: [
          { syncLockedAt: null },
          { syncLockDeadlineAt: { lt: now } },
          {
            syncLockDeadlineAt: null,
            syncLockedAt: { lt: staleLockBefore },
          },
        ],
      },
      data: {
        syncStatus: VK_SOURCE_SYNC_STATUS_SYNCING,
        syncStartedAt: now,
        syncLockedAt: now,
        syncLockedBy: this.workerId,
        syncLockDeadlineAt,
        syncHeartbeatAt: now,
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

  private async recordSourceHeartbeat(sourceId: string): Promise<boolean> {
    const now = new Date();
    const updated = await this.prisma.vkParsingSource.updateMany({
      where: this.buildOwnedSourceLeaseWhere(sourceId),
      data: {
        syncHeartbeatAt: now,
        syncLockDeadlineAt: new Date(now.getTime() + this.syncLeaseTtlMs),
      },
    });
    return updated.count > 0;
  }

  private buildOwnedSourceLeaseWhere(sourceId: string): Prisma.VkParsingSourceWhereInput {
    return {
      id: sourceId,
      syncStatus: VK_SOURCE_SYNC_STATUS_SYNCING,
      syncLockedBy: this.workerId,
    };
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

  private shouldAutoPublishImportedPosts(
    source: Pick<VkParsingSourceRow, 'lastSuccessAt'>,
    reason: VkParsingSyncReason,
  ): boolean {
    return reason !== 'source-added' && Boolean(source.lastSuccessAt);
  }

  private resolveSyncBackoffMs(failureCount: number): number {
    const baseMs = 60_000;
    const cappedFailureCount = Math.max(0, Math.min(6, failureCount - 1));
    const jitterMs = Math.floor(Math.random() * 5_000);
    return Math.min(60 * 60_000, baseMs * 2 ** cappedFailureCount + jitterMs);
  }

  private isSourceCircuitBreakerFailure(classified: { code: string; retryable: boolean }): boolean {
    return !classified.retryable && classified.code.startsWith('vk_api.');
  }

  private buildPostKey(ownerId: number, postId: number): string {
    return `${ownerId}:${postId}`;
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
    const { videoUrls, linkUrls } = parsedAttachments;
    const photoUrls = videoUrls.length > 0 ? [] : parsedAttachments.photoUrls;
    const photoMedia = videoUrls.length > 0 ? [] : parsedAttachments.photoMedia;
    if (
      !text.trim() &&
      photoUrls.length === 0 &&
      videoUrls.length === 0 &&
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
      videoUrls,
      linkUrls,
      attachments,
      attachmentTypes: parsedAttachments.attachmentTypes,
      unsupportedAttachments: parsedAttachments.unsupportedAttachments,
      hasUnsupportedAttachments: parsedAttachments.hasUnsupportedAttachments,
      isAdvertising: parsedAttachments.isAdvertising,
      advertisingMarkers: parsedAttachments.advertisingMarkers,
      photoMedia,
      videoMedia: parsedAttachments.videoMedia,
      copyHistoryText: parsedAttachments.copyHistoryText,
      raw: post,
      contentHash: computeVkParsingPostContentHash({
        text,
        photoUrls,
        videoUrls,
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

    const response = await this.vkApiClient.request('wall.get', params);
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
    const response = await this.vkApiClient.request('wall.getById', {
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

  private async preflightPostMediaSafely(
    source: Pick<VkParsingSourceRow, 'id' | 'chatId'>,
    posts: NormalizedVkPost[],
  ): Promise<void> {
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
        await this.mediaCache.preflightMediaUrl(url, mediaIdentityByUrl.get(url) ?? null);
      });
    } catch (error) {
      const classified = classifyVkParsingMediaPreflightError(error);
      this.logDedupedWarning(
        `vk-media-preflight:${source.id}:${classified.code}`,
        {
          sourceId: source.id,
          chatId: source.chatId,
          reason: classified.code,
          retryable: classified.retryable,
          err: error,
        },
        'VK media preflight failed unexpectedly after per-url safeguards',
      );
    }
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

  private toJsonInput(value: unknown): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(value ?? null)) as Prisma.InputJsonValue;
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

  private logDedupedWarning(key: string, context: Record<string, unknown>, message: string): void {
    const now = Date.now();
    const current = this.warningDedupe.get(key);
    if (current && now - current.loggedAtMs < VK_PARSING_WARNING_DEDUPE_MS) {
      current.suppressed += 1;
      return;
    }

    const suppressedSimilarWarnings = current?.suppressed ?? 0;
    this.warningDedupe.set(key, { loggedAtMs: now, suppressed: 0 });
    this.logger.warn(
      {
        ...context,
        ...(suppressedSimilarWarnings > 0 ? { suppressedSimilarWarnings } : {}),
      },
      message,
    );
  }
}
