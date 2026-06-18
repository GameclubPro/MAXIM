import { hydrateMirroredItem, saveMirroredItem } from './native-storage';

type StatsSnapshotEnvelope<T> = {
  savedAt: number;
  value: T;
};

const STATS_SNAPSHOT_VERSION = 'v2';
const STATS_SNAPSHOT_MAX_AGE_MS = 6 * 60 * 60 * 1000;

function buildStatsSnapshotKey(scope: string, parts: readonly string[]): string {
  return ['maxim', 'stats-snapshot', STATS_SNAPSHOT_VERSION, scope, ...parts].join(':');
}

function parseStatsSnapshot<T>(raw: string | null): T | null {
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<StatsSnapshotEnvelope<T>>;
    if (
      typeof parsed.savedAt !== 'number' ||
      !Number.isFinite(parsed.savedAt) ||
      Date.now() - parsed.savedAt > STATS_SNAPSHOT_MAX_AGE_MS ||
      parsed.value === undefined ||
      parsed.value === null
    ) {
      return null;
    }

    return parsed.value as T;
  } catch {
    return null;
  }
}

export async function readStatsSnapshot<T>(
  scope: string,
  parts: readonly string[],
): Promise<T | null> {
  return parseStatsSnapshot<T>(await hydrateMirroredItem(buildStatsSnapshotKey(scope, parts)));
}

export function saveStatsSnapshot<T>(scope: string, parts: readonly string[], value: T): void {
  saveMirroredItem(
    buildStatsSnapshotKey(scope, parts),
    JSON.stringify({
      savedAt: Date.now(),
      value,
    } satisfies StatsSnapshotEnvelope<T>),
  );
}
