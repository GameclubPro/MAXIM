import type { ChatSummary } from '@maxim/contracts';
import {
  cloneManagedEntitySummarySnapshotValue,
  mergeManagedEntityGroups,
} from './admin-managed-entities-snapshot-codec';
import {
  MANAGED_ENTITIES_ALLOWLIST_CACHE_TTL_MS,
  MANAGED_ENTITIES_LAST_SUCCESS_SNAPSHOT_TTL_MS,
  type ManagedEntityTypeFilter,
  type TimedPromiseCacheEntry,
  type TimedValueCacheEntry,
} from './admin.service.support';

export type AdminManagedEntitiesSnapshotContext = {
  filterToRuntimeScope(chats: readonly ChatSummary[]): ChatSummary[];
  loadAllowlist(userId: string, entityType: ManagedEntityTypeFilter): Promise<ChatSummary[]>;
};

export class AdminManagedEntitiesSnapshotRuntime {
  private readonly managedEntitiesAllowlistCache = new Map<
    string,
    TimedPromiseCacheEntry<ChatSummary[]>
  >();
  private readonly managedEntitiesLastSuccessCache = new Map<
    string,
    TimedValueCacheEntry<ChatSummary[]>
  >();
  constructor(private readonly context: AdminManagedEntitiesSnapshotContext) {}
  private buildManagedEntitiesAllowlistCacheKey(
    userId: string,
    entityType: ManagedEntityTypeFilter,
  ): string {
    return `${userId}:${entityType}:allowlist`;
  }

  private buildManagedEntitiesLastSuccessCacheKey(
    userId: string,
    entityType: ManagedEntityTypeFilter,
  ): string {
    return `${userId}:${entityType}:last-success`;
  }

  private readManagedEntitiesLastSuccessSnapshotExact(
    userId: string,
    entityType: ManagedEntityTypeFilter,
  ): ChatSummary[] {
    const key = this.buildManagedEntitiesLastSuccessCacheKey(userId, entityType);
    const entry = this.managedEntitiesLastSuccessCache.get(key);
    if (!entry) {
      return [];
    }
    if (entry.expiresAtMs <= Date.now()) {
      this.managedEntitiesLastSuccessCache.delete(key);
      return [];
    }

    return entry.value.map((chat) => cloneManagedEntitySummarySnapshotValue(chat));
  }

  readManagedEntitiesLastSuccessSnapshot(
    userId: string,
    entityType: ManagedEntityTypeFilter,
  ): ChatSummary[] {
    const direct = this.context.filterToRuntimeScope(
      this.readManagedEntitiesLastSuccessSnapshotExact(userId, entityType),
    );
    if (direct.length > 0 || entityType === 'all') {
      return direct;
    }

    return this.context
      .filterToRuntimeScope(this.readManagedEntitiesLastSuccessSnapshotExact(userId, 'all'))
      .filter((chat) => chat.entityType === entityType);
  }

  private rememberManagedEntitiesLastSuccessSnapshot(
    userId: string,
    entityType: ManagedEntityTypeFilter,
    chats: readonly ChatSummary[],
  ): void {
    if (chats.length === 0) {
      return;
    }

    const key = this.buildManagedEntitiesLastSuccessCacheKey(userId, entityType);
    this.managedEntitiesLastSuccessCache.set(key, {
      expiresAtMs: Date.now() + MANAGED_ENTITIES_LAST_SUCCESS_SNAPSHOT_TTL_MS,
      value: chats.map((chat) => cloneManagedEntitySummarySnapshotValue(chat)),
    });
  }

  private mergeManagedEntitiesLastSuccessSnapshot(
    userId: string,
    entityType: ManagedEntityTypeFilter,
    chats: readonly ChatSummary[],
  ): void {
    if (chats.length === 0) {
      return;
    }

    const merged = mergeManagedEntityGroups(
      chats.map((chat) => cloneManagedEntitySummarySnapshotValue(chat)),
      this.readManagedEntitiesLastSuccessSnapshotExact(userId, entityType),
    );
    this.rememberManagedEntitiesLastSuccessSnapshot(userId, entityType, merged);
  }

  rememberManagedEntitiesLastSuccessChats(userId: string, chats: readonly ChatSummary[]): void {
    if (chats.length === 0) {
      return;
    }

    this.mergeManagedEntitiesLastSuccessSnapshot(userId, 'all', chats);

    const chatsOnly = chats.filter((chat) => chat.entityType === 'chat');
    if (chatsOnly.length > 0) {
      this.mergeManagedEntitiesLastSuccessSnapshot(userId, 'chat', chatsOnly);
    }

    const channelsOnly = chats.filter((chat) => chat.entityType === 'channel');
    if (channelsOnly.length > 0) {
      this.mergeManagedEntitiesLastSuccessSnapshot(userId, 'channel', channelsOnly);
    }
  }

  forgetManagedEntitiesLastSuccessChat(userId: string, chatId: string): void {
    const prefix = `${userId}:`;
    for (const [key, entry] of this.managedEntitiesLastSuccessCache.entries()) {
      if (!key.startsWith(prefix)) {
        continue;
      }

      const remaining = entry.value.filter((chat) => chat.id !== chatId);
      if (remaining.length === 0) {
        this.managedEntitiesLastSuccessCache.delete(key);
        continue;
      }

      this.managedEntitiesLastSuccessCache.set(key, {
        expiresAtMs: entry.expiresAtMs,
        value: remaining.map((chat) => cloneManagedEntitySummarySnapshotValue(chat)),
      });
    }
  }

  invalidateManagedEntitiesAllowlistCache(userId: string): void {
    const prefix = `${userId}:`;
    for (const key of this.managedEntitiesAllowlistCache.keys()) {
      if (key.startsWith(prefix)) {
        this.managedEntitiesAllowlistCache.delete(key);
      }
    }
  }

  async listChatsFromAllowlist(
    userId: string,
    entityType: ManagedEntityTypeFilter,
  ): Promise<ChatSummary[]> {
    const cacheKey = this.buildManagedEntitiesAllowlistCacheKey(userId, entityType);
    const cachedEntry = this.managedEntitiesAllowlistCache.get(cacheKey);
    if (cachedEntry && cachedEntry.expiresAtMs > Date.now()) {
      return cachedEntry.promise;
    }

    const pending = this.context.loadAllowlist(userId, entityType).catch((error) => {
      if (this.managedEntitiesAllowlistCache.get(cacheKey)?.promise === pending) {
        this.managedEntitiesAllowlistCache.delete(cacheKey);
      }
      throw error;
    });
    this.managedEntitiesAllowlistCache.set(cacheKey, {
      expiresAtMs: Date.now() + MANAGED_ENTITIES_ALLOWLIST_CACHE_TTL_MS,
      promise: pending,
    });

    return pending;
  }
}
