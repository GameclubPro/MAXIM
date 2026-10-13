import type { ChatSummary, ManagedEntityType } from '@maxim/contracts';
import { randomUUID } from 'node:crypto';
import type {
  ChatContextCacheService,
  ManagedEntitiesPublishedSnapshot,
} from '../chat-context/chat-context-cache.service';
import {
  MAX_API_SOURCE_TAGS,
  type MaxClientService,
  type MaxChatSnapshot,
} from '../max/max-client.service';
import {
  isBotAdminLookupDeniedError,
  isFallbackTitle,
  isMaxApiThrottleError,
  isMaxApiTimeoutError,
  readTrimmedString,
} from './admin-legacy-utils';
import {
  buildManagedEntitiesPublishedSnapshotDiff,
  buildManagedEntitiesPublishedSnapshotHash,
} from './admin-managed-entities-snapshot-codec';
import {
  MANAGED_ENTITY_HEADER_HYDRATION_BATCH_SIZE,
  MANAGED_ENTITIES_PUBLISHED_SNAPSHOT_TTL_SEC,
} from './admin.service.support';

type HeaderCache = Pick<
  ChatContextCacheService,
  'getManagedEntityHeader' | 'claimManagedEntityHeaderRefresh'
>;

function readBotIds(chat: ChatSummary): Array<string | undefined> {
  const assigned = chat.assignedBots ?? [];
  if (assigned.length === 0) return [chat.primaryBotId ?? undefined];
  const active = assigned.filter(
    (bot) => bot.membershipStatus === 'active' && bot.lifecycleState === 'active',
  );
  return active
    .sort(
      (left, right) =>
        Number(right.botId === chat.primaryBotId) - Number(left.botId === chat.primaryBotId),
    )
    .map((bot) => bot.botId);
}

// FLAG: Metadata reads never activate a bot or grant actor access. The caller supplies
// only visible entities, and fallback stays within their currently active assignments.
export async function hydrateManagedEntityHeaders(params: {
  chats: ChatSummary[];
  cache: HeaderCache;
  maxClient: Pick<MaxClientService, 'getChatSnapshot'>;
  persist: (chat: ChatSummary, snapshot: MaxChatSnapshot) => Promise<void>;
}): Promise<unknown | null> {
  if (typeof params.maxClient.getChatSnapshot !== 'function') return null;
  const candidates = (
    await Promise.all(
      params.chats.map(async (chat) => {
        const header = await params.cache.getManagedEntityHeader?.(chat.id, chat.entityType);
        return !header ||
          isFallbackTitle(chat.id, header.title) ||
          !readTrimmedString(header.avatarUrl)
          ? chat
          : null;
      }),
    )
  )
    .filter((chat): chat is ChatSummary => chat !== null)
    .sort(
      (left, right) =>
        Number(right.entityType === 'channel') - Number(left.entityType === 'channel'),
    );
  let attempted = 0;
  for (const chat of candidates) {
    if (attempted >= MANAGED_ENTITY_HEADER_HYDRATION_BATCH_SIZE) break;
    const botIds = readBotIds(chat);
    if (botIds.length === 0) continue;
    // FLAG: Leave a later chat unclaimed when its assigned routes do not fit. Otherwise
    // the same failed prefix could consume its cooldown on every partial batch.
    if (attempted > 0 && botIds.length > MANAGED_ENTITY_HEADER_HYDRATION_BATCH_SIZE - attempted)
      continue;
    // A recent successful read without an icon, or a denied read, must not starve
    // later entities. The shared claim also bounds concurrent viewers' MAX traffic.
    if (
      params.cache.claimManagedEntityHeaderRefresh &&
      !(await params.cache.claimManagedEntityHeaderRefresh(chat.id, chat.entityType))
    )
      continue;
    for (const botId of botIds) {
      if (attempted >= MANAGED_ENTITY_HEADER_HYDRATION_BATCH_SIZE) break;
      attempted += 1;
      try {
        const snapshot = await params.maxClient.getChatSnapshot(chat.id, {
          trafficClass: 'background',
          actionHealthLane: 'background',
          sourceTag: MAX_API_SOURCE_TAGS.MANAGED_REFRESH,
          ignoreFailureMetricStatuses: [403, 404],
          timeoutMs: 2500,
          bypassCache: true,
          ...(botId ? { botId } : {}),
        });
        if (snapshot.entityType && snapshot.entityType !== chat.entityType) break;
        await params.persist(chat, snapshot);
        break;
      } catch (error: unknown) {
        if (isMaxApiThrottleError(error) || isMaxApiTimeoutError(error)) return error;
        if (!isBotAdminLookupDeniedError(error)) break;
      }
    }
  }
  return null;
}

// FLAG: A metadata-only CAS cannot add an entity, change its bot assignments, or
// restore a concurrently removed connection. Readers must never reuse a version
// for changed presentation: clients intentionally ignore same-version responses.
export async function publishManagedEntityHeaderChanges(params: {
  cache: Pick<
    ChatContextCacheService,
    'setManagedEntitiesPublishedSnapshot' | 'setManagedEntitiesPublishedDiff'
  >;
  userId: string;
  entityType: ManagedEntityType;
  snapshot: ManagedEntitiesPublishedSnapshot;
  visibleItems: ChatSummary[];
  writeDiff: boolean;
}): Promise<ManagedEntitiesPublishedSnapshot | null> {
  const visible = new Map(params.visibleItems.map((item) => [item.id, item]));
  let changed = false;
  const items = params.snapshot.items.map((item) => {
    const updated = visible.get(item.id);
    if (!updated || updated.entityType !== item.entityType) return item;
    const avatarUrl = updated.avatarUrl ?? item.avatarUrl;
    if (updated.title === item.title && updated.link === item.link && avatarUrl === item.avatarUrl)
      return item;
    changed = true;
    return {
      ...item,
      title: updated.title,
      link: updated.link,
      ...(avatarUrl ? { avatarUrl } : {}),
    };
  });
  if (!changed) return params.snapshot;
  const next: ManagedEntitiesPublishedSnapshot = {
    ...params.snapshot,
    items,
    version: randomUUID(),
    builtAt: new Date().toISOString(),
    itemsHash: buildManagedEntitiesPublishedSnapshotHash(items, params.snapshot.lastSyncedAt),
  };
  const committed = await params.cache.setManagedEntitiesPublishedSnapshot(
    params.userId,
    params.entityType,
    next,
    MANAGED_ENTITIES_PUBLISHED_SNAPSHOT_TTL_SEC,
    { expectedVersion: params.snapshot.version },
  );
  if (!committed) return null;
  const diff = buildManagedEntitiesPublishedSnapshotDiff(params.snapshot, next);
  if (params.writeDiff && diff && params.cache.setManagedEntitiesPublishedDiff) {
    await params.cache.setManagedEntitiesPublishedDiff(
      params.userId,
      params.entityType,
      diff.baseVersion,
      diff,
      MANAGED_ENTITIES_PUBLISHED_SNAPSHOT_TTL_SEC,
    );
  }
  return next;
}
