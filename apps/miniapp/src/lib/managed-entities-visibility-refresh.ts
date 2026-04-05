export function shouldRefreshManagedEntitiesOnVisibilityReturn(options: {
  awaitingReturnRefresh: boolean;
  documentVisible: boolean;
  isLoading: boolean;
  isRefreshing: boolean;
  hasLoadedFromServer: boolean;
  isSyncComplete: boolean;
  snapshotStale: boolean | null;
  hiddenDurationMs: number | null;
  lastRefreshAtMs: number;
  nowMs: number;
  minIntervalMs: number;
  minHiddenDurationMs: number;
}): boolean {
  if (!options.awaitingReturnRefresh || !options.documentVisible) {
    return false;
  }

  if (options.isLoading || options.isRefreshing) {
    return false;
  }

  if (!options.hasLoadedFromServer || !options.isSyncComplete || options.snapshotStale !== false) {
    return true;
  }

  if (
    typeof options.hiddenDurationMs === 'number' &&
    options.hiddenDurationMs >= options.minHiddenDurationMs
  ) {
    return true;
  }

  return options.nowMs - options.lastRefreshAtMs >= options.minIntervalMs;
}
