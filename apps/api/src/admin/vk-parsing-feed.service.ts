import {
  type VkParsingCapability,
  type VkParsingFeed,
  type VkParsingFeedQuery,
  type VkParsingHealthSummary,
  type VkParsingPost,
  type VkParsingSettings,
  type VkParsingSource,
  vkParsingFeedQuerySchema,
} from '@maxim/contracts';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { VK_MEDIA_STATUS_FAILED } from './vk-parsing-media-cache.service';
import { VkParsingRateLimitService } from './vk-parsing-rate-limit.service';
import type { VkParsingUnsupportedAttachmentSummary } from './vk-parsing-attachments';

type VkParsingSourceRow = Prisma.VkParsingSourceGetPayload<Record<string, never>>;
type VkParsingPostWithSource = Prisma.VkParsingPostGetPayload<{ include: { source: true } }>;
type VkParsingSettingsRow = Prisma.VkParsingSettingsGetPayload<Record<string, never>>;

type VkParsingSettingsLike = {
  chatId: string;
  autoPublishEnabled: boolean;
  autoPublishEnabledAt: Date | null;
  stripLinksEnabled: boolean;
  skipAdsEnabled: boolean;
  updatedAt: Date | null;
};

type VkParsingSkipReason = 'AD' | 'EMPTY_AFTER_LINK_FILTER';

const VK_SOURCE_STATUS_ACTIVE = 'ACTIVE';
const VK_SOURCE_STATUS_DISABLED = 'DISABLED';
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

@Injectable()
export class VkParsingFeedService {
  private readonly maxSyncIntervalMs: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly vkRateLimitService: VkParsingRateLimitService,
    configService: ConfigService,
  ) {
    this.maxSyncIntervalMs =
      configService.get<number>('VK_PARSING_MAX_SYNC_INTERVAL_MS') ?? 3_600_000;
  }

  async buildFeed(
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

  async buildHealthSummary(chatId: string): Promise<VkParsingHealthSummary> {
    const now = new Date();
    const staleBefore = new Date(now.getTime() - this.maxSyncIntervalMs * 2);
    const [
      sourceCount,
      staleSourceCount,
      latestSeen,
      oldestQueued,
      publishBacklog,
      staleSyncLockCount,
      sourceRuntimeStats,
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
      this.prisma.vkParsingSource.count({
        where: {
          chatId,
          status: VK_SOURCE_STATUS_ACTIVE,
          syncStatus: VK_SOURCE_SYNC_STATUS_SYNCING,
          OR: [
            { syncLockDeadlineAt: { lt: now } },
            {
              syncLockDeadlineAt: null,
              syncLockedAt: { lt: staleBefore },
            },
          ],
        },
      }),
      this.loadSourceRuntimeStats(chatId),
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
    const attemptedSources = this.readNumber(sourceRuntimeStats.attemptedSources) ?? 0;
    const successfulSources = this.readNumber(sourceRuntimeStats.successfulSources) ?? 0;
    const p95SyncDurationMs = this.readNumber(sourceRuntimeStats.p95SyncDurationMs) ?? 0;
    const publishLagSeconds = firstQueuedAt
      ? Math.max(0, Math.floor((now.getTime() - firstQueuedAt.getTime()) / 1_000))
      : null;
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
      publishLagSeconds,
      publishBacklogAgeSeconds: publishLagSeconds,
      publishBacklog,
      staleSyncLockCount,
      circuitOpenSourceCount: this.readNumber(sourceRuntimeStats.circuitOpenSourceCount) ?? 0,
      importSuccessRate:
        attemptedSources > 0 ? Math.min(1, successfulSources / attemptedSources) : 1,
      p95SyncDurationMs: p95SyncDurationMs > 0 ? Math.round(p95SyncDurationMs) : null,
      mediaFailureRatio: mediaTotal > 0 ? Math.min(1, mediaFailed / mediaTotal) : 0,
      recentErrors: vkApiMetrics.recentErrors,
    };
  }

  private async loadSourceRuntimeStats(chatId: string): Promise<Record<string, unknown>> {
    const rows = await this.prisma.$queryRaw<Array<Record<string, unknown>>>`
      select
        count(*) filter (where last_sync_at is not null)::int as "attemptedSources",
        count(*) filter (
          where sync_status = 'IDLE'
            and last_error_code is null
            and last_success_at is not null
        )::int as "successfulSources",
        count(*) filter (where circuit_opened_at is not null)::int as "circuitOpenSourceCount",
        percentile_cont(0.95) within group (order by last_sync_duration_ms) filter (
          where last_sync_duration_ms is not null
        ) as "p95SyncDurationMs"
      from vk_parsing_sources
      where chat_id = ${chatId}
        and status = ${VK_SOURCE_STATUS_ACTIVE}
    `;
    return rows[0] ?? {};
  }

  mapPost(post: VkParsingPostWithSource): VkParsingPost {
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

  private mapSource(source: VkParsingSourceRow): VkParsingSource {
    const syncStatus = this.mapSourceSyncStatus(source.syncStatus);
    const nextSyncAt = source.nextSyncAt ? source.nextSyncAt.toISOString() : null;
    return {
      id: source.id,
      chatId: source.chatId,
      ownerId: source.ownerId,
      wallOwnerId: source.wallOwnerId,
      screenName: source.screenName,
      title: source.title,
      url: source.url,
      status: source.status === VK_SOURCE_STATUS_DISABLED ? 'DISABLED' : 'ACTIVE',
      syncStatus,
      nextSyncAt,
      nextRetryAt: syncStatus === VK_SOURCE_SYNC_STATUS_BACKOFF ? nextSyncAt : null,
      lastSyncAt: source.lastSyncAt ? source.lastSyncAt.toISOString() : null,
      lastSuccessAt: source.lastSuccessAt ? source.lastSuccessAt.toISOString() : null,
      syncStartedAt: source.syncStartedAt ? source.syncStartedAt.toISOString() : null,
      consecutiveFailures: Math.max(0, source.consecutiveFailures),
      terminalFailureCount: Math.max(0, source.terminalFailureCount ?? 0),
      circuitOpenedAt: source.circuitOpenedAt ? source.circuitOpenedAt.toISOString() : null,
      circuitReasonCode: source.circuitReasonCode,
      circuitReason: source.circuitReason,
      circuitRetryAt: source.circuitRetryAt ? source.circuitRetryAt.toISOString() : null,
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
}
