import { randomUUID } from 'node:crypto';
import type {
  ManagedEntityType,
  PublisherEntitiesSummary,
  PublisherEntityReadinessFilter,
} from '@maxim/contracts/publisher';

const PUBLISHER_CURSOR_SNAPSHOT_TTL_MS = 15 * 60_000;
// Match the client stale window without hiding entities discovered by a later explicit refresh.
const PUBLISHER_CURSOR_SNAPSHOT_REUSE_MS = 15_000;
const PUBLISHER_CURSOR_SNAPSHOT_MAX_ENTRIES = 256;
const PUBLISHER_CURSOR_SNAPSHOT_MAX_ITEMS = 100_000;
const PUBLISHER_CURSOR_SNAPSHOT_MAX_ENTRIES_PER_USER = 8;
const PUBLISHER_CURSOR_SNAPSHOT_MAX_ITEMS_PER_USER = 25_000;

export type PublisherEntitiesCursorScope = {
  userId: string;
  query: string;
  entityType: ManagedEntityType | null;
  readiness: PublisherEntityReadinessFilter | null;
};

export type PublisherEntitiesCursorItem = {
  id: string;
  entityType: ManagedEntityType;
};

export type PublisherEntitiesCursorSnapshot = PublisherEntitiesCursorScope & {
  filteredTotal: number;
  summary: PublisherEntitiesSummary;
  items: PublisherEntitiesCursorItem[];
};

type StoredPublisherEntitiesCursorSnapshot = PublisherEntitiesCursorSnapshot & {
  scopeKey: string;
  createdAtMs: number;
  expiresAtMs: number;
};

export type PublisherEntitiesCursorSnapshotHandle = {
  snapshotId: string;
  snapshot: PublisherEntitiesCursorSnapshot;
  reused: boolean;
};

type PublisherEntitiesCursorStoreOptions = {
  ttlMs?: number;
  reuseMs?: number;
  maxEntries?: number;
  maxItems?: number;
  maxEntriesPerUser?: number;
  maxItemsPerUser?: number;
};

export class PublisherEntitiesCursorStore {
  private readonly snapshots = new Map<string, StoredPublisherEntitiesCursorSnapshot>();
  private readonly latestSnapshotIdByScope = new Map<string, string>();
  private readonly storedItemsByUser = new Map<string, number>();
  private readonly ttlMs: number;
  private readonly reuseMs: number;
  private readonly maxEntries: number;
  private readonly maxItems: number;
  private readonly maxEntriesPerUser: number;
  private readonly maxItemsPerUser: number;
  private storedItems = 0;

  constructor(options: PublisherEntitiesCursorStoreOptions = {}) {
    this.ttlMs = this.positiveInteger(options.ttlMs, PUBLISHER_CURSOR_SNAPSHOT_TTL_MS);
    this.reuseMs = this.nonNegativeInteger(options.reuseMs, PUBLISHER_CURSOR_SNAPSHOT_REUSE_MS);
    this.maxEntries = this.positiveInteger(
      options.maxEntries,
      PUBLISHER_CURSOR_SNAPSHOT_MAX_ENTRIES,
    );
    this.maxItems = this.positiveInteger(options.maxItems, PUBLISHER_CURSOR_SNAPSHOT_MAX_ITEMS);
    this.maxEntriesPerUser = this.positiveInteger(
      options.maxEntriesPerUser,
      PUBLISHER_CURSOR_SNAPSHOT_MAX_ENTRIES_PER_USER,
    );
    this.maxItemsPerUser = this.positiveInteger(
      options.maxItemsPerUser,
      PUBLISHER_CURSOR_SNAPSHOT_MAX_ITEMS_PER_USER,
    );
  }

  findReusable(
    scope: PublisherEntitiesCursorScope,
    nowMs = Date.now(),
  ): PublisherEntitiesCursorSnapshotHandle | null {
    this.prune(nowMs);
    const scopeKey = this.scopeKey(scope);
    const snapshotId = this.latestSnapshotIdByScope.get(scopeKey);
    if (!snapshotId) {
      return null;
    }
    const snapshot = this.snapshots.get(snapshotId);
    if (!snapshot || snapshot.createdAtMs + this.reuseMs <= nowMs) {
      return null;
    }
    this.touch(snapshotId, snapshot, nowMs);
    return this.handle(snapshotId, snapshot, true);
  }

  createOrReuse(
    snapshot: PublisherEntitiesCursorSnapshot,
    nowMs = Date.now(),
  ): PublisherEntitiesCursorSnapshotHandle | null {
    const reusable = this.findReusable(snapshot, nowMs);
    if (reusable) {
      return reusable;
    }
    if (snapshot.items.length > this.maxItems || snapshot.items.length > this.maxItemsPerUser) {
      return null;
    }

    const snapshotId = randomUUID();
    const scopeKey = this.scopeKey(snapshot);
    const stored: StoredPublisherEntitiesCursorSnapshot = {
      ...snapshot,
      scopeKey,
      createdAtMs: nowMs,
      expiresAtMs: nowMs + this.ttlMs,
    };
    this.snapshots.set(snapshotId, stored);
    this.latestSnapshotIdByScope.set(scopeKey, snapshotId);
    this.storedItems += snapshot.items.length;
    this.storedItemsByUser.set(
      snapshot.userId,
      (this.storedItemsByUser.get(snapshot.userId) ?? 0) + snapshot.items.length,
    );
    this.enforceUserBounds(snapshot.userId);
    this.enforceGlobalBounds();

    return this.snapshots.has(snapshotId) ? this.handle(snapshotId, stored, false) : null;
  }

  read(
    snapshotId: string,
    scope: PublisherEntitiesCursorScope,
    nowMs = Date.now(),
  ): PublisherEntitiesCursorSnapshot | null {
    this.prune(nowMs);
    const snapshot = this.snapshots.get(snapshotId);
    if (!snapshot || !this.matchesScope(snapshot, scope)) {
      return null;
    }
    this.touch(snapshotId, snapshot, nowMs);
    return snapshot;
  }

  complete(snapshotId: string, scope: PublisherEntitiesCursorScope): boolean {
    const snapshot = this.snapshots.get(snapshotId);
    if (!snapshot || !this.matchesScope(snapshot, scope)) {
      return false;
    }
    this.delete(snapshotId, snapshot);
    return true;
  }

  private handle(
    snapshotId: string,
    snapshot: StoredPublisherEntitiesCursorSnapshot,
    reused: boolean,
  ): PublisherEntitiesCursorSnapshotHandle {
    return { snapshotId, snapshot, reused };
  }

  private matchesScope(
    snapshot: PublisherEntitiesCursorSnapshot,
    scope: PublisherEntitiesCursorScope,
  ): boolean {
    return (
      snapshot.userId === scope.userId &&
      snapshot.query === scope.query &&
      snapshot.entityType === scope.entityType &&
      snapshot.readiness === scope.readiness
    );
  }

  private touch(
    snapshotId: string,
    snapshot: StoredPublisherEntitiesCursorSnapshot,
    nowMs: number,
  ): void {
    snapshot.expiresAtMs = nowMs + this.ttlMs;
    this.snapshots.delete(snapshotId);
    this.snapshots.set(snapshotId, snapshot);
  }

  private prune(nowMs: number): void {
    for (const [snapshotId, snapshot] of this.snapshots) {
      if (snapshot.expiresAtMs <= nowMs) {
        this.delete(snapshotId, snapshot);
      }
    }
  }

  private enforceUserBounds(userId: string): void {
    while (
      this.countUserSnapshots(userId) > this.maxEntriesPerUser ||
      (this.storedItemsByUser.get(userId) ?? 0) > this.maxItemsPerUser
    ) {
      const oldest = [...this.snapshots].find(([, snapshot]) => snapshot.userId === userId);
      if (!oldest) {
        return;
      }
      this.delete(oldest[0], oldest[1]);
    }
  }

  private enforceGlobalBounds(): void {
    while (this.snapshots.size > this.maxEntries || this.storedItems > this.maxItems) {
      const oldest = this.snapshots.entries().next().value as
        | [string, StoredPublisherEntitiesCursorSnapshot]
        | undefined;
      if (!oldest) {
        return;
      }
      this.delete(oldest[0], oldest[1]);
    }
  }

  private countUserSnapshots(userId: string): number {
    let count = 0;
    for (const snapshot of this.snapshots.values()) {
      if (snapshot.userId === userId) {
        count += 1;
      }
    }
    return count;
  }

  private delete(snapshotId: string, snapshot: StoredPublisherEntitiesCursorSnapshot): void {
    if (!this.snapshots.delete(snapshotId)) {
      return;
    }
    this.storedItems -= snapshot.items.length;
    const userItems = (this.storedItemsByUser.get(snapshot.userId) ?? 0) - snapshot.items.length;
    if (userItems > 0) {
      this.storedItemsByUser.set(snapshot.userId, userItems);
    } else {
      this.storedItemsByUser.delete(snapshot.userId);
    }
    if (this.latestSnapshotIdByScope.get(snapshot.scopeKey) === snapshotId) {
      this.latestSnapshotIdByScope.delete(snapshot.scopeKey);
    }
  }

  private scopeKey(scope: PublisherEntitiesCursorScope): string {
    return JSON.stringify([scope.userId, scope.query, scope.entityType, scope.readiness]);
  }

  private positiveInteger(value: number | undefined, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 1
      ? Math.trunc(value)
      : fallback;
  }

  private nonNegativeInteger(value: number | undefined, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0
      ? Math.trunc(value)
      : fallback;
  }
}
