import {
  addVkParsingSourceRequestSchema,
  bulkUpdateVkParsingSourcesRequestSchema,
  publishVkParsingPostRequestSchema,
  publishVkParsingPostResultSchema,
  retryVkParsingPostResultSchema,
  rollbackVkParsingRequestSchema,
  rollbackVkParsingResultSchema,
  scheduleVkParsingPostRequestSchema,
  updateVkParsingSettingsRequestSchema,
  updateVkParsingSourceRequestSchema,
  vkParsingCapabilitySchema,
  vkParsingFeedQuerySchema,
  vkParsingFeedSchema,
  vkParsingHealthSummarySchema,
  vkParsingRefreshResultSchema,
  type VkParsingFeed,
  type VkParsingPost,
  type VkParsingSettings,
  type VkParsingSource,
} from '@maxim/contracts';
import {
  addDays,
  addHours,
  buildPreviewAvatarDataUrl,
  cloneJson,
  parseJsonBody,
} from './preview-transport-shared';
import type { PreviewState } from './preview-transport-state';
import {
  PREVIEW_NOT_HANDLED,
  readPreviewClock,
  resolvePreviewEntityRequest,
  type PreviewRequestHandler,
} from './preview-transport-runtime';

export function createPreviewVkParsingFeed(chatId: string, now: Date): VkParsingFeed {
  const createdAt = addDays(now, -18).toISOString();
  const syncedAt = addHours(now, -1.2).toISOString();
  const sourceOne: VkParsingSource = {
    id: 'preview-vk-source-yuzhnoe',
    chatId,
    ownerId: 200501,
    wallOwnerId: -200501,
    screenName: 'yuzhnoe_media',
    title: 'Южное медиа',
    url: 'https://vk.com/yuzhnoe_media',
    status: 'ACTIVE',
    importEnabled: true,
    autoPublishEnabled: true,
    autoPublishEnabledAt: addHours(now, -2).toISOString(),
    autoPublishPausedAt: null,
    autoPublishPausedReason: null,
    publishIntervalMinutes: 30,
    dailyLimit: 6,
    minPublishIntervalMinutes: 20,
    publishMode: 'QUEUE',
    priority: 'HIGH',
    quietHoursStart: null,
    quietHoursEnd: null,
    lastAutoPublishedAt: addHours(now, -6.8).toISOString(),
    newPostCount: 2,
    queuedPostCount: 1,
    publishedPostCount: 1,
    skippedPostCount: 1,
    failedPostCount: 1,
    syncStatus: 'IDLE',
    nextSyncAt: null,
    nextRetryAt: null,
    lastSyncAt: syncedAt,
    lastSuccessAt: syncedAt,
    syncStartedAt: null,
    consecutiveFailures: 0,
    terminalFailureCount: 0,
    circuitOpenedAt: null,
    circuitReasonCode: null,
    circuitReason: null,
    circuitRetryAt: null,
    lastErrorCode: null,
    lastImportedCount: 4,
    lastFetchedCount: 9,
    lastFetchedPages: 3,
    lastFetchedOffsets: [0, 50, 100],
    lastVkNewestPostId: 4281,
    lastVkNewestPublishedAt: addHours(now, -2.4).toISOString(),
    adaptiveIntervalMs: 600_000,
    lastSyncDurationMs: 1240,
    lastError: null,
    createdAt,
    updatedAt: syncedAt,
  };
  const sourceTwo: VkParsingSource = {
    id: 'preview-vk-source-afisha',
    chatId,
    ownerId: 200812,
    wallOwnerId: -200812,
    screenName: 'afisha_yuga',
    title: 'Афиша Юга',
    url: 'https://vk.com/afisha_yuga',
    status: 'ACTIVE',
    importEnabled: true,
    autoPublishEnabled: false,
    autoPublishEnabledAt: null,
    autoPublishPausedAt: addHours(now, -1).toISOString(),
    autoPublishPausedReason: 'manual',
    publishIntervalMinutes: 180,
    dailyLimit: 3,
    minPublishIntervalMinutes: 60,
    publishMode: 'REVIEW',
    priority: 'NORMAL',
    quietHoursStart: '23:00',
    quietHoursEnd: '08:00',
    lastAutoPublishedAt: null,
    newPostCount: 1,
    queuedPostCount: 0,
    publishedPostCount: 0,
    skippedPostCount: 0,
    failedPostCount: 0,
    syncStatus: 'BACKOFF',
    nextSyncAt: addHours(now, 1.4).toISOString(),
    nextRetryAt: addHours(now, 1.4).toISOString(),
    lastSyncAt: addHours(now, -4.5).toISOString(),
    lastSuccessAt: addHours(now, -8).toISOString(),
    syncStartedAt: null,
    consecutiveFailures: 1,
    terminalFailureCount: 0,
    circuitOpenedAt: null,
    circuitReasonCode: null,
    circuitReason: null,
    circuitRetryAt: null,
    lastErrorCode: 'RATE_LIMIT',
    lastImportedCount: 1,
    lastFetchedCount: 5,
    lastFetchedPages: 2,
    lastFetchedOffsets: [0, 50],
    lastVkNewestPostId: 119,
    lastVkNewestPublishedAt: addHours(now, -10).toISOString(),
    adaptiveIntervalMs: 1_800_000,
    lastSyncDurationMs: 1890,
    lastError: 'VK временно ограничил запросы к источнику.',
    createdAt: addDays(now, -9).toISOString(),
    updatedAt: addHours(now, -4.5).toISOString(),
  };
  const settings: VkParsingSettings = {
    chatId,
    autoPublishEnabled: true,
    autoPublishEnabledAt: addHours(now, -2).toISOString(),
    autoPublishKillSwitchEnabled: false,
    stripLinksEnabled: true,
    skipAdsEnabled: true,
    appendChannelLinkEnabled: false,
    channelLinkText: 'Подписаться на канал',
    schedulerTimezone: 'Europe/Moscow',
    quietHoursStart: '23:00',
    quietHoursEnd: '08:00',
    workHoursStart: '09:00',
    workHoursEnd: '22:00',
    distributeEvenlyEnabled: true,
    roundRobinEnabled: true,
    circuitBreakerEnabled: true,
    circuitBreakerWindowMinutes: 10,
    circuitBreakerPostLimit: 10,
    updatedAt: addHours(now, -2).toISOString(),
  };

  const feed = vkParsingFeedSchema.parse({
    capabilities: { enabled: true, canUse: true, reasonCode: null, reason: null },
    settings,
    sources: [sourceOne, sourceTwo],
    posts: [
      {
        id: 'preview-vk-post-4281',
        sourceId: sourceOne.id,
        chatId,
        sourceTitle: sourceOne.title,
        sourceUrl: sourceOne.url,
        sourcePublishMode: sourceOne.publishMode,
        vkOwnerId: sourceOne.wallOwnerId,
        vkPostId: 4281,
        vkPublishedAt: addHours(now, -2.4).toISOString(),
        text: 'На Южной площади открыли вечернюю навигацию: новые указатели, подсветка у перехода и карта маршрутов на выходные.',
        url: `${sourceOne.url}?w=wall${sourceOne.wallOwnerId}_4281`,
        photoUrls: [
          buildPreviewAvatarDataUrl('Парк', '#4d94ff', '#2b64dd'),
          buildPreviewAvatarDataUrl('Маршрут', '#3cc58b', '#0f9f70'),
        ],
        linkUrls: ['https://example.com/south-map'],
        status: 'NEW',
        contentHash: 'preview-vk-4281',
        publishedContentHash: null,
        publishedMessageId: null,
        publishedUrl: null,
        publishedAtMax: null,
        autoPublishedAt: null,
        autoPublishError: null,
        skippedAt: null,
        skipReason: null,
        lastSeenAt: addHours(now, -1.8).toISOString(),
        missingSinceAt: null,
        unavailableAt: null,
        publishQueuedAt: addHours(now, -0.3).toISOString(),
        publishScheduledAt: addHours(now, 0.8).toISOString(),
        lastError: null,
        createdAt: addHours(now, -2.4).toISOString(),
        updatedAt: addHours(now, -1.8).toISOString(),
      },
      {
        id: 'preview-vk-post-4276',
        sourceId: sourceOne.id,
        chatId,
        sourceTitle: sourceOne.title,
        sourceUrl: sourceOne.url,
        sourcePublishMode: sourceOne.publishMode,
        vkOwnerId: sourceOne.wallOwnerId,
        vkPostId: 4276,
        vkPublishedAt: addHours(now, -7).toISOString(),
        text: 'Расписание городского катка на неделю обновлено. Утренние слоты оставили для школ, вечерние доступны по живой очереди.',
        url: `${sourceOne.url}?w=wall${sourceOne.wallOwnerId}_4276`,
        photoUrls: [],
        videoUrls: ['https://vk.com/video-100200_4276'],
        linkUrls: [],
        status: 'PUBLISHED',
        contentHash: 'preview-vk-4276',
        publishedContentHash: 'preview-vk-4276',
        publishedMessageId: 'preview-max-vk-4276',
        publishedUrl: 'https://max.ru/channels/yuzhnoe-news/message/preview-vk-4276',
        publishedAtMax: addHours(now, -6.8).toISOString(),
        autoPublishedAt: addHours(now, -6.8).toISOString(),
        autoPublishError: null,
        skippedAt: null,
        skipReason: null,
        lastSeenAt: addHours(now, -6.5).toISOString(),
        missingSinceAt: null,
        unavailableAt: null,
        lastError: null,
        createdAt: addHours(now, -7).toISOString(),
        updatedAt: addHours(now, -6.8).toISOString(),
      },
      {
        id: 'preview-vk-post-119',
        sourceId: sourceTwo.id,
        chatId,
        sourceTitle: sourceTwo.title,
        sourceUrl: sourceTwo.url,
        sourcePublishMode: sourceTwo.publishMode,
        vkOwnerId: sourceTwo.wallOwnerId,
        vkPostId: 119,
        vkPublishedAt: addHours(now, -10).toISOString(),
        text: 'Промопост партнёра с маркировкой и внешним переходом.',
        url: `${sourceTwo.url}?w=wall${sourceTwo.wallOwnerId}_119`,
        photoUrls: [],
        linkUrls: ['https://example.com/promo'],
        status: 'NEW',
        contentHash: 'preview-vk-119',
        publishedContentHash: null,
        publishedMessageId: null,
        publishedUrl: null,
        publishedAtMax: null,
        autoPublishedAt: null,
        autoPublishError: null,
        skippedAt: null,
        skipReason: null,
        lastSeenAt: addHours(now, -9.8).toISOString(),
        missingSinceAt: null,
        unavailableAt: null,
        lastError: null,
        createdAt: addHours(now, -10).toISOString(),
        updatedAt: addHours(now, -9.9).toISOString(),
      },
      {
        id: 'preview-vk-post-4259',
        sourceId: sourceOne.id,
        chatId,
        sourceTitle: sourceOne.title,
        sourceUrl: sourceOne.url,
        sourcePublishMode: sourceOne.publishMode,
        vkOwnerId: sourceOne.wallOwnerId,
        vkPostId: 4259,
        vkPublishedAt: addHours(now, -19).toISOString(),
        text: 'Автор обновил исходный пост после публикации: добавил перенос площадки и новый тайминг вечерней программы.',
        url: `${sourceOne.url}?w=wall${sourceOne.wallOwnerId}_4259`,
        photoUrls: [buildPreviewAvatarDataUrl('UPD', '#f1a44b', '#ea7b4b')],
        linkUrls: [],
        status: 'CHANGED_AFTER_PUBLISH',
        contentHash: 'preview-vk-4259-v2',
        publishedContentHash: 'preview-vk-4259-v1',
        publishedMessageId: 'preview-max-vk-4259',
        publishedUrl: 'https://max.ru/channels/yuzhnoe-news/message/preview-vk-4259',
        publishedAtMax: addHours(now, -18.6).toISOString(),
        autoPublishedAt: null,
        autoPublishError: null,
        skippedAt: null,
        skipReason: null,
        lastSeenAt: addHours(now, -1.5).toISOString(),
        missingSinceAt: null,
        unavailableAt: null,
        lastError: null,
        createdAt: addHours(now, -19).toISOString(),
        updatedAt: addHours(now, -1.5).toISOString(),
      },
      {
        id: 'preview-vk-post-4244',
        sourceId: sourceTwo.id,
        chatId,
        sourceTitle: sourceTwo.title,
        sourceUrl: sourceTwo.url,
        sourcePublishMode: sourceTwo.publishMode,
        vkOwnerId: sourceTwo.wallOwnerId,
        vkPostId: 4244,
        vkPublishedAt: addDays(now, -1).toISOString(),
        text: 'Фотоподборка с фестиваля загружена, но часть медиа временно не принял MAX.',
        url: `${sourceTwo.url}?w=wall${sourceTwo.wallOwnerId}_4244`,
        photoUrls: [
          buildPreviewAvatarDataUrl('Фест', '#ff82a8', '#eb577f'),
          buildPreviewAvatarDataUrl('Сцена', '#5ab7b5', '#1b7f8a'),
        ],
        linkUrls: [],
        status: 'FAILED',
        contentHash: 'preview-vk-4244',
        publishedContentHash: null,
        publishedMessageId: null,
        publishedUrl: null,
        publishedAtMax: null,
        autoPublishedAt: null,
        autoPublishError: 'MAX временно не принял одно из вложений.',
        skippedAt: null,
        skipReason: null,
        lastSeenAt: addHours(now, -20).toISOString(),
        missingSinceAt: null,
        unavailableAt: null,
        lastError: 'MAX временно не принял одно из вложений.',
        createdAt: addDays(now, -1).toISOString(),
        updatedAt: addHours(now, -20).toISOString(),
      },
    ],
    pagination: {
      limit: 50,
      offset: 0,
      total: 5,
      hasMore: false,
      nextOffset: null,
    },
    summary: {
      chatId,
      generatedAt: now.toISOString(),
      vkApiRps: 2.1,
      vkApiErrorRate: 0.08,
      sourceCount: 2,
      staleSourceCount: 1,
      importLagSeconds: 90 * 60,
      publishLagSeconds: 12 * 60,
      publishBacklogAgeSeconds: 12 * 60,
      publishBacklog: 1,
      staleSyncLockCount: 0,
      circuitOpenSourceCount: 0,
      importSuccessRate: 0.5,
      p95SyncDurationMs: 1_890,
      mediaFailureRatio: 0.14,
      recentErrors: [{ code: 'vk_6', count: 3 }],
    },
  });
  return vkParsingFeedSchema.parse({
    ...feed,
    queue: feed.posts.filter((post) => post.publishQueuedAt),
  });
}

export function buildPreviewVkParsingPage(
  feed: VkParsingFeed,
  searchParams: URLSearchParams,
): VkParsingFeed {
  const query = vkParsingFeedQuerySchema.parse(Object.fromEntries(searchParams.entries()));
  const filteredPosts = feed.posts.filter((post) => {
    if (query.status === 'QUEUED') {
      if (!post.publishQueuedAt) {
        return false;
      }
    } else if (query.status !== 'ALL' && post.status !== query.status) {
      return false;
    }
    if (query.sourceId && post.sourceId !== query.sourceId) {
      return false;
    }

    return true;
  });
  const posts = filteredPosts.slice(query.offset, query.offset + query.limit);
  const nextOffset = query.offset + query.limit;

  return vkParsingFeedSchema.parse({
    ...feed,
    posts,
    queue: feed.posts.filter((post) => post.publishQueuedAt),
    pagination: {
      limit: query.limit,
      offset: query.offset,
      total: filteredPosts.length,
      hasMore: nextOffset < filteredPosts.length,
      nextOffset: nextOffset < filteredPosts.length ? nextOffset : null,
    },
  });
}

export type PreviewVkParsingRouteResult = { handled: false } | { handled: true; value: unknown };

export function handleVkParsingPreviewRequest(
  state: PreviewState,
  entityType: 'chat' | 'channel',
  chatId: string,
  tail: string[],
  url: URL,
  method: string,
  init?: RequestInit,
): PreviewVkParsingRouteResult {
  if (tail[0] !== 'vk-parsing') {
    return { handled: false };
  }

  const readFeed = () => (entityType === 'channel' ? state.channelVkParsing : state.chatVkParsing);
  const writeFeed = (feed: VkParsingFeed) => {
    const normalizedFeed = vkParsingFeedSchema.parse({
      ...feed,
      queue: feed.posts.filter((post) => post.publishQueuedAt),
    });
    if (entityType === 'channel') {
      state.channelVkParsing = normalizedFeed;
    } else {
      state.chatVkParsing = normalizedFeed;
    }
  };

  if (tail[1] === 'capability' && method === 'GET') {
    return {
      handled: true,
      value: vkParsingCapabilitySchema.parse({
        enabled: true,
        canUse: true,
        reasonCode: null,
        reason: null,
      }),
    };
  }

  if (tail.length === 1 && method === 'GET') {
    return {
      handled: true,
      value: cloneJson(buildPreviewVkParsingPage(readFeed(), url.searchParams)),
    };
  }

  if (tail[1] === 'summary' && method === 'GET') {
    return {
      handled: true,
      value: vkParsingHealthSummarySchema.parse(readFeed().summary),
    };
  }

  if (tail[1] === 'settings' && method === 'PATCH') {
    const payload = updateVkParsingSettingsRequestSchema.parse(parseJsonBody(init));
    const feed = vkParsingFeedSchema.parse({
      ...readFeed(),
      settings: {
        ...readFeed().settings,
        ...payload,
        chatId,
        updatedAt: readPreviewClock(state.clock).toISOString(),
      },
    });
    writeFeed(feed);
    return { handled: true, value: cloneJson(feed) };
  }

  if (tail[1] === 'autopublish' && tail[2] === 'dry-run' && method === 'GET') {
    const sourceId = url.searchParams.get('sourceId');
    const feed = readFeed();
    const sources = sourceId
      ? feed.sources.filter((source) => source.id === sourceId)
      : feed.sources;
    return {
      handled: true,
      value: {
        chatId,
        sourceId: sourceId ?? null,
        generatedAt: readPreviewClock(state.clock).toISOString(),
        globalEnabled: feed.settings.autoPublishEnabled,
        killSwitchEnabled: feed.settings.autoPublishKillSwitchEnabled,
        baselineAt: feed.settings.autoPublishEnabledAt,
        eligibleNow: 0,
        latestImportedVkPublishedAt:
          feed.posts
            .filter((post) => !sourceId || post.sourceId === sourceId)
            .map((post) => post.vkPublishedAt)
            .filter(Boolean)
            .sort()
            .at(-1) ?? null,
        sourcesWithoutSuccessfulSync: sources.filter((source) => !source.lastSuccessAt).length,
      },
    };
  }

  if (tail[1] === 'rollback' && method === 'POST') {
    const payload = rollbackVkParsingRequestSchema.parse(parseJsonBody(init));
    const posts = readFeed().posts.filter((post) => {
      if (!post.autoPublishedAt) {
        return false;
      }
      if (payload.sourceId && post.sourceId !== payload.sourceId) {
        return false;
      }
      return post.autoPublishedAt >= payload.since && post.autoPublishedAt <= payload.until;
    });
    return {
      handled: true,
      value: rollbackVkParsingResultSchema.parse({
        matched: posts.length,
        deleted: payload.deleteMessages ? posts.length : 0,
        failed: 0,
        posts,
      }),
    };
  }

  if (tail[1] === 'sources' && tail[2] === 'bulk' && method === 'POST') {
    const payload = bulkUpdateVkParsingSourcesRequestSchema.parse(parseJsonBody(init));
    const nowIso = readPreviewClock(state.clock).toISOString();
    const currentFeed = readFeed();
    const feed = vkParsingFeedSchema.parse({
      ...currentFeed,
      settings:
        payload.preset === 'CLEAN'
          ? {
              ...currentFeed.settings,
              stripLinksEnabled: true,
              skipAdsEnabled: true,
              updatedAt: nowIso,
            }
          : currentFeed.settings,
      sources: currentFeed.sources.map((source) =>
        payload.sourceIds.includes(source.id)
          ? {
              ...source,
              importEnabled: true,
              autoPublishEnabled: payload.preset !== 'REVIEW',
              autoPublishEnabledAt: payload.preset !== 'REVIEW' ? nowIso : null,
              publishMode: payload.preset === 'REVIEW' ? 'REVIEW' : 'QUEUE',
              priority: payload.preset === 'NEWS' ? 'HIGH' : 'NORMAL',
              publishIntervalMinutes:
                payload.preset === 'NEWS' ? 20 : payload.preset === 'SLOW' ? 180 : 60,
              dailyLimit: payload.preset === 'NEWS' ? 12 : 3,
              updatedAt: nowIso,
            }
          : source,
      ),
    });
    writeFeed(feed);
    return { handled: true, value: cloneJson(feed) };
  }

  if (tail[1] === 'sources' && tail.length === 2 && method === 'POST') {
    const payload = addVkParsingSourceRequestSchema.parse(parseJsonBody(init));
    const now = readPreviewClock(state.clock);
    const parsedUrl = new URL(payload.url);
    const screenName = parsedUrl.pathname.split('/').filter(Boolean)[0] ?? 'vk_source';
    const source: VkParsingSource = {
      id: `preview-vk-source-${readPreviewClock(state.clock).getTime()}`,
      chatId,
      ownerId: 200900,
      wallOwnerId: -200900,
      screenName,
      title: screenName.replace(/[_-]+/gu, ' ') || 'VK источник',
      url: parsedUrl.toString(),
      status: 'ACTIVE',
      importEnabled: true,
      autoPublishEnabled: false,
      autoPublishEnabledAt: null,
      autoPublishPausedAt: null,
      autoPublishPausedReason: null,
      publishIntervalMinutes: 60,
      dailyLimit: 3,
      minPublishIntervalMinutes: 30,
      publishMode: 'QUEUE',
      priority: 'NORMAL',
      quietHoursStart: null,
      quietHoursEnd: null,
      lastAutoPublishedAt: null,
      newPostCount: 0,
      queuedPostCount: 0,
      publishedPostCount: 0,
      skippedPostCount: 0,
      failedPostCount: 0,
      syncStatus: 'QUEUED',
      nextSyncAt: null,
      nextRetryAt: null,
      lastSyncAt: null,
      lastSuccessAt: null,
      syncStartedAt: null,
      consecutiveFailures: 0,
      terminalFailureCount: 0,
      circuitOpenedAt: null,
      circuitReasonCode: null,
      circuitReason: null,
      circuitRetryAt: null,
      lastErrorCode: null,
      lastImportedCount: 0,
      lastFetchedCount: 0,
      lastFetchedPages: 0,
      lastFetchedOffsets: [],
      lastVkNewestPostId: null,
      lastVkNewestPublishedAt: null,
      adaptiveIntervalMs: null,
      lastSyncDurationMs: null,
      lastError: null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    const feed = vkParsingFeedSchema.parse({
      ...readFeed(),
      sources: [source, ...readFeed().sources],
    });
    writeFeed(feed);
    return {
      handled: true,
      value: vkParsingRefreshResultSchema.parse({
        ...feed,
        imported: 0,
        queued: 1,
      }),
    };
  }

  if (tail[1] === 'sources' && tail[2] && tail.length === 3 && method === 'PATCH') {
    const sourceId = decodeURIComponent(tail[2]);
    const payload = updateVkParsingSourceRequestSchema.parse(parseJsonBody(init));
    const nowIso = readPreviewClock(state.clock).toISOString();
    const feed = vkParsingFeedSchema.parse({
      ...readFeed(),
      sources: readFeed().sources.map((source) =>
        source.id === sourceId
          ? {
              ...source,
              ...payload,
              autoPublishEnabledAt:
                payload.autoPublishEnabled === true
                  ? (source.autoPublishEnabledAt ?? nowIso)
                  : payload.autoPublishEnabled === false
                    ? null
                    : source.autoPublishEnabledAt,
              updatedAt: nowIso,
            }
          : source,
      ),
    });
    writeFeed(feed);
    return { handled: true, value: cloneJson(feed) };
  }

  if (tail[1] === 'sources' && tail[2] && tail[3] === 'refresh' && method === 'POST') {
    const sourceId = decodeURIComponent(tail[2]);
    const nowIso = readPreviewClock(state.clock).toISOString();
    const feed = vkParsingFeedSchema.parse({
      ...readFeed(),
      sources: readFeed().sources.map((source) =>
        source.id === sourceId
          ? {
              ...source,
              syncStatus: 'IDLE',
              lastSyncAt: nowIso,
              lastSuccessAt: nowIso,
              lastImportedCount: source.lastImportedCount + 1,
              updatedAt: nowIso,
            }
          : source,
      ),
    });
    writeFeed(feed);
    return {
      handled: true,
      value: vkParsingRefreshResultSchema.parse({ ...feed, imported: 1, queued: 1 }),
    };
  }

  if (tail[1] === 'sources' && tail[2] && method === 'DELETE') {
    const sourceId = decodeURIComponent(tail[2]);
    const feed = vkParsingFeedSchema.parse({
      ...readFeed(),
      sources: readFeed().sources.filter((source) => source.id !== sourceId),
      posts: readFeed().posts.filter((post) => post.sourceId !== sourceId),
    });
    writeFeed(feed);
    return { handled: true, value: cloneJson(feed) };
  }

  if (tail[1] === 'refresh' && method === 'POST') {
    const nowIso = readPreviewClock(state.clock).toISOString();
    const feed = vkParsingFeedSchema.parse({
      ...readFeed(),
      sources: readFeed().sources.map((source) => ({
        ...source,
        syncStatus: 'IDLE',
        lastSyncAt: nowIso,
        lastSuccessAt: nowIso,
        syncStartedAt: null,
        consecutiveFailures: 0,
        lastErrorCode: null,
        lastError: null,
        updatedAt: nowIso,
      })),
    });
    writeFeed(feed);
    return {
      handled: true,
      value: vkParsingRefreshResultSchema.parse({
        ...feed,
        imported: 2,
        queued: feed.sources.length,
      }),
    };
  }

  if (tail[1] === 'posts' && tail[2] && tail[3] === 'retry' && method === 'POST') {
    const postId = decodeURIComponent(tail[2]);
    const post = readFeed().posts.find((item) => item.id === postId);
    if (!post) {
      throw new Error(`Preview VK post not found: ${postId}`);
    }

    const nowIso = readPreviewClock(state.clock).toISOString();
    const updatedPost: VkParsingPost = {
      ...post,
      status: 'NEW',
      publishQueuedAt: nowIso,
      publishScheduledAt: addHours(readPreviewClock(state.clock), 1).toISOString(),
      publishLockedAt: null,
      publishAttemptCount: post.publishAttemptCount + 1,
      autoPublishError: null,
      lastError: null,
      updatedAt: nowIso,
    };
    const feed = vkParsingFeedSchema.parse({
      ...readFeed(),
      posts: readFeed().posts.map((item) => (item.id === updatedPost.id ? updatedPost : item)),
    });
    writeFeed(feed);
    return {
      handled: true,
      value: retryVkParsingPostResultSchema.parse({
        post: updatedPost,
        queued: 1,
      }),
    };
  }

  if (tail[1] === 'posts' && tail[2] && tail[3] === 'schedule' && method === 'PATCH') {
    const payload = scheduleVkParsingPostRequestSchema.parse(parseJsonBody(init));
    const postId = decodeURIComponent(tail[2]);
    const post = readFeed().posts.find((item) => item.id === postId);
    if (!post) {
      throw new Error(`Preview VK post not found: ${postId}`);
    }

    const nowIso = readPreviewClock(state.clock).toISOString();
    const updatedPost: VkParsingPost = {
      ...post,
      status: 'NEW',
      publishQueuedAt: post.publishQueuedAt ?? nowIso,
      publishScheduledAt: payload.scheduledAt,
      publishLockedAt: null,
      publishAttemptCount: post.publishAttemptCount,
      updatedAt: nowIso,
    };
    const feed = vkParsingFeedSchema.parse({
      ...readFeed(),
      posts: readFeed().posts.map((item) => (item.id === updatedPost.id ? updatedPost : item)),
    });
    writeFeed(feed);
    return {
      handled: true,
      value: retryVkParsingPostResultSchema.parse({ post: updatedPost, queued: 1 }),
    };
  }

  if (tail[1] === 'posts' && tail[2] && tail[3] === 'cancel' && method === 'POST') {
    const postId = decodeURIComponent(tail[2]);
    const post = readFeed().posts.find((item) => item.id === postId);
    if (!post) {
      throw new Error(`Preview VK post not found: ${postId}`);
    }
    const nowIso = readPreviewClock(state.clock).toISOString();
    const updatedPost: VkParsingPost = {
      ...post,
      publishQueuedAt: null,
      publishScheduledAt: null,
      publishLockedAt: null,
      publishCancelledAt: nowIso,
      publishCancelledByUserId: 'preview-user',
      updatedAt: nowIso,
    };
    const feed = vkParsingFeedSchema.parse({
      ...readFeed(),
      posts: readFeed().posts.map((item) => (item.id === updatedPost.id ? updatedPost : item)),
    });
    writeFeed(feed);
    return {
      handled: true,
      value: retryVkParsingPostResultSchema.parse({ post: updatedPost, queued: 0 }),
    };
  }

  if (tail[1] === 'posts' && tail[2] && tail[3] === 'publish-now' && method === 'POST') {
    const postId = decodeURIComponent(tail[2]);
    const post = readFeed().posts.find((item) => item.id === postId);
    if (!post) {
      throw new Error(`Preview VK post not found: ${postId}`);
    }
    const nowIso = readPreviewClock(state.clock).toISOString();
    const updatedPost: VkParsingPost = {
      ...post,
      status: 'NEW',
      publishQueuedAt: nowIso,
      publishScheduledAt: nowIso,
      publishLockedAt: null,
      publishCancelledAt: null,
      publishCancelledByUserId: null,
      updatedAt: nowIso,
    };
    const feed = vkParsingFeedSchema.parse({
      ...readFeed(),
      posts: readFeed().posts.map((item) => (item.id === updatedPost.id ? updatedPost : item)),
    });
    writeFeed(feed);
    return {
      handled: true,
      value: retryVkParsingPostResultSchema.parse({ post: updatedPost, queued: 1 }),
    };
  }

  if (tail[1] === 'posts' && tail[2] && tail[3] === 'review-draft' && method === 'PATCH') {
    const payload = publishVkParsingPostRequestSchema.parse(parseJsonBody(init));
    const postId = decodeURIComponent(tail[2]);
    const post = readFeed().posts.find((item) => item.id === postId);
    if (!post) {
      throw new Error(`Preview VK post not found: ${postId}`);
    }

    const nowIso = readPreviewClock(state.clock).toISOString();
    const updatedPost: VkParsingPost = {
      ...post,
      text: payload.text,
      textFormat: payload.textFormat,
      photoUrls: payload.photoUrls,
      videoUrls: payload.videoUrls,
      linkUrls: payload.linkUrls,
      status: 'NEW',
      autoPublishError: null,
      publishQueuedAt: null,
      publishScheduledAt: null,
      publishLockedAt: null,
      publishCancelledAt: null,
      publishCancelledByUserId: null,
      lastError: null,
      updatedAt: nowIso,
    };
    const feed = vkParsingFeedSchema.parse({
      ...readFeed(),
      posts: readFeed().posts.map((item) => (item.id === updatedPost.id ? updatedPost : item)),
    });
    writeFeed(feed);
    return {
      handled: true,
      value: feed,
    };
  }

  if (tail[1] === 'posts' && tail[2] && tail[3] === 'publish' && method === 'POST') {
    const payload = publishVkParsingPostRequestSchema.parse(parseJsonBody(init));
    const postId = decodeURIComponent(tail[2]);
    const post = readFeed().posts.find((item) => item.id === postId);
    if (!post) {
      throw new Error(`Preview VK post not found: ${postId}`);
    }

    const nowIso = readPreviewClock(state.clock).toISOString();
    const updatedPost: VkParsingPost = {
      ...post,
      text: payload.text,
      textFormat: payload.textFormat,
      photoUrls: payload.photoUrls,
      videoUrls: payload.videoUrls,
      linkUrls: payload.linkUrls,
      status: 'NEW',
      publishedContentHash: null,
      publishedMessageId: null,
      publishedUrl: null,
      publishedAtMax: null,
      autoPublishedAt: null,
      autoPublishError: null,
      publishQueuedAt: nowIso,
      publishScheduledAt: nowIso,
      publishLockedAt: null,
      lastError: null,
      updatedAt: nowIso,
    };
    const feed = vkParsingFeedSchema.parse({
      ...readFeed(),
      posts: readFeed().posts.map((item) => (item.id === updatedPost.id ? updatedPost : item)),
      queue: [updatedPost, ...readFeed().queue.filter((item) => item.id !== updatedPost.id)],
    });
    writeFeed(feed);
    return {
      handled: true,
      value: publishVkParsingPostResultSchema.parse({
        post: updatedPost,
        queued: 1,
      }),
    };
  }

  throw new Error(
    `Preview transport does not implement ${method} /vk-parsing/${tail.slice(1).join('/')}`,
  );
}

export const handleVkPreviewRequest: PreviewRequestHandler = (context) => {
  const entity = resolvePreviewEntityRequest(context);
  if (!entity || entity.tail[0] !== 'vk-parsing') {
    return PREVIEW_NOT_HANDLED;
  }
  const result = handleVkParsingPreviewRequest(
    context.state,
    entity.entityType,
    entity.entityId,
    entity.tail,
    context.url,
    context.method,
    context.init,
  );
  return result.handled ? result.value : PREVIEW_NOT_HANDLED;
};
