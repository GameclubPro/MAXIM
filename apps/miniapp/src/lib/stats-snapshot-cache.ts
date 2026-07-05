import { hydrateMirroredItem, readLocalMirrorItem, saveMirroredItem } from './native-storage';

type StatsSnapshotEnvelope<T> = {
  savedAt: number;
  value: T;
};

type ParsedSnapshotCacheEntry = {
  raw: string;
  envelope: StatsSnapshotEnvelope<unknown> | null;
};

type PendingStatsSnapshotWrite = {
  envelope: StatsSnapshotEnvelope<unknown>;
  handle: number | null;
  scheduler: 'idle' | 'timeout' | null;
};

type WindowWithIdleCallback = Window &
  typeof globalThis & {
    requestIdleCallback?: (callback: () => void, options?: { timeout?: number }) => number;
    cancelIdleCallback?: (handle: number) => void;
  };

const STATS_SNAPSHOT_VERSION = 'v7';
const STATS_SNAPSHOT_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const STATS_SNAPSHOT_WRITE_IDLE_TIMEOUT_MS = 1_500;
const STATS_SNAPSHOT_PARSE_CACHE_LIMIT = 24;

const parsedSnapshotCache = new Map<string, ParsedSnapshotCacheEntry>();
const pendingSnapshotWrites = new Map<string, PendingStatsSnapshotWrite>();

function buildStatsSnapshotKey(scope: string, parts: readonly string[]): string {
  return ['maxim', 'stats-snapshot', STATS_SNAPSHOT_VERSION, scope, ...parts].join(':');
}

function readFreshEnvelopeValue<T>(envelope: StatsSnapshotEnvelope<unknown> | null): T | null {
  if (
    !envelope ||
    typeof envelope.savedAt !== 'number' ||
    !Number.isFinite(envelope.savedAt) ||
    Date.now() - envelope.savedAt > STATS_SNAPSHOT_MAX_AGE_MS ||
    envelope.value === undefined ||
    envelope.value === null
  ) {
    return null;
  }

  return envelope.value as T;
}

function pruneParsedSnapshotCache(): void {
  while (parsedSnapshotCache.size > STATS_SNAPSHOT_PARSE_CACHE_LIMIT) {
    const oldestKey = parsedSnapshotCache.keys().next().value as string | undefined;
    if (!oldestKey) {
      return;
    }
    parsedSnapshotCache.delete(oldestKey);
  }
}

function parseStatsSnapshot<T>(key: string, raw: string | null): T | null {
  if (!raw) {
    return null;
  }

  const cached = parsedSnapshotCache.get(key);
  if (cached?.raw === raw) {
    return readFreshEnvelopeValue<T>(cached.envelope);
  }

  try {
    const parsed = JSON.parse(raw) as StatsSnapshotEnvelope<unknown>;
    parsedSnapshotCache.set(key, { raw, envelope: parsed });
    pruneParsedSnapshotCache();
    return readFreshEnvelopeValue<T>(parsed);
  } catch {
    parsedSnapshotCache.set(key, { raw, envelope: null });
    pruneParsedSnapshotCache();
    return null;
  }
}

function readPendingStatsSnapshot<T>(key: string): T | null | undefined {
  if (!pendingSnapshotWrites.has(key)) {
    return undefined;
  }

  return readFreshEnvelopeValue<T>(pendingSnapshotWrites.get(key)?.envelope ?? null);
}

function cancelPendingStatsSnapshotWrite(write: PendingStatsSnapshotWrite): void {
  if (write.handle === null || typeof window === 'undefined') {
    return;
  }

  const idleWindow = window as WindowWithIdleCallback;
  if (write.scheduler === 'idle' && typeof idleWindow.cancelIdleCallback === 'function') {
    idleWindow.cancelIdleCallback(write.handle);
    return;
  }

  if (write.scheduler === 'timeout') {
    window.clearTimeout(write.handle);
  }
}

function flushStatsSnapshotWrite(key: string, envelope: StatsSnapshotEnvelope<unknown>): void {
  const pending = pendingSnapshotWrites.get(key);
  if (pending?.envelope !== envelope) {
    return;
  }

  pendingSnapshotWrites.delete(key);

  try {
    const raw = JSON.stringify(envelope);
    parsedSnapshotCache.set(key, { raw, envelope });
    pruneParsedSnapshotCache();
    saveMirroredItem(key, raw);
  } catch {
    // Stats snapshots are a startup speed hint; ignore serialization failures.
  }
}

function scheduleStatsSnapshotWrite(key: string, envelope: StatsSnapshotEnvelope<unknown>): void {
  const previous = pendingSnapshotWrites.get(key);
  if (previous) {
    cancelPendingStatsSnapshotWrite(previous);
  }

  const write: PendingStatsSnapshotWrite = {
    envelope,
    handle: null,
    scheduler: null,
  };
  pendingSnapshotWrites.set(key, write);

  if (typeof window === 'undefined') {
    flushStatsSnapshotWrite(key, envelope);
    return;
  }

  const idleWindow = window as WindowWithIdleCallback;
  if (typeof idleWindow.requestIdleCallback === 'function') {
    write.scheduler = 'idle';
    write.handle = idleWindow.requestIdleCallback(() => flushStatsSnapshotWrite(key, envelope), {
      timeout: STATS_SNAPSHOT_WRITE_IDLE_TIMEOUT_MS,
    });
    return;
  }

  write.scheduler = 'timeout';
  write.handle = window.setTimeout(() => flushStatsSnapshotWrite(key, envelope), 0);
}

export async function readStatsSnapshot<T>(
  scope: string,
  parts: readonly string[],
): Promise<T | null> {
  const key = buildStatsSnapshotKey(scope, parts);
  const pending = readPendingStatsSnapshot<T>(key);
  if (pending !== undefined) {
    return pending;
  }

  return parseStatsSnapshot<T>(key, await hydrateMirroredItem(key));
}

export function readStatsSnapshotMirror<T>(scope: string, parts: readonly string[]): T | null {
  const key = buildStatsSnapshotKey(scope, parts);
  const pending = readPendingStatsSnapshot<T>(key);
  if (pending !== undefined) {
    return pending;
  }

  return parseStatsSnapshot<T>(key, readLocalMirrorItem(key));
}

export function saveStatsSnapshot<T>(scope: string, parts: readonly string[], value: T): void {
  scheduleStatsSnapshotWrite(buildStatsSnapshotKey(scope, parts), {
    savedAt: Date.now(),
    value,
  } satisfies StatsSnapshotEnvelope<T>);
}
