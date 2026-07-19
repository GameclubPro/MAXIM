const INIT_DATA_PARAM_NAMES = ['WebAppData', 'init_data', 'initData'] as const;

function readParamFromNormalizedSource(source: string, names: readonly string[]): string {
  const params = new URLSearchParams(source);
  for (const key of names) {
    const candidate = params.get(key);
    if (candidate?.trim()) {
      return candidate.trim();
    }
  }

  return '';
}

function readWrappedParam(source: string, names: readonly string[]): string {
  const normalized = source.trim().replace(/^[?#]/u, '');
  if (!normalized) {
    return '';
  }

  const directValue = readParamFromNormalizedSource(normalized, names);
  if (directValue) {
    return directValue;
  }

  const queryIndex = normalized.indexOf('?');
  return queryIndex >= 0
    ? readParamFromNormalizedSource(normalized.slice(queryIndex + 1), names)
    : '';
}

function normalizeInitData(value: string): string {
  let current = value.trim();

  for (let i = 0; i < 3; i += 1) {
    const wrapped = extractWrappedInitData(current);
    if (wrapped) {
      current = wrapped;
    }

    if (current.includes('hash=')) {
      return current;
    }

    try {
      const decoded = decodeURIComponent(current);
      if (decoded === current) {
        break;
      }
      current = decoded;
    } catch {
      break;
    }
  }

  return extractWrappedInitData(current) ?? current;
}

function extractWrappedInitData(value: string): string | null {
  const normalized = value.trim();
  if (
    !normalized.includes('WebAppData=') &&
    !normalized.includes('init_data=') &&
    !normalized.includes('initData=')
  ) {
    return null;
  }

  return readWrappedParam(normalized, INIT_DATA_PARAM_NAMES) || null;
}

function readInitDataFromLocation(source: string): string {
  const candidate = readWrappedParam(source, INIT_DATA_PARAM_NAMES);
  return candidate ? normalizeInitData(candidate) : '';
}

function readUserIdValue(value: unknown): string | null {
  if (typeof value === 'string') {
    const normalized = value.trim();
    return normalized || null;
  }

  if (typeof value === 'number' && Number.isSafeInteger(value)) {
    return String(value);
  }

  return null;
}

function readUnsafeBridgeUserId(): string | null {
  const candidates = [
    (window.MAX?.WebApp?.initDataUnsafe as { user?: { id?: unknown } } | undefined)?.user?.id,
    (window.MAX?.WebApp?.init_data_unsafe as { user?: { id?: unknown } } | undefined)?.user?.id,
    (window.WebApp?.initDataUnsafe as { user?: { id?: unknown } } | undefined)?.user?.id,
    (window.WebApp?.init_data_unsafe as { user?: { id?: unknown } } | undefined)?.user?.id,
  ];

  for (const candidate of candidates) {
    const userId = readUserIdValue(candidate);
    if (userId) {
      return userId;
    }
  }

  return null;
}

export function getInitData(): string {
  const bridgeCandidates = [
    window.MAX?.WebApp?.initData,
    window.MAX?.WebApp?.init_data,
    window.WebApp?.initData,
    window.WebApp?.init_data,
  ];

  const bridgeValue = bridgeCandidates.find((value) => Boolean(value && value.trim()));
  if (bridgeValue) {
    return normalizeInitData(bridgeValue);
  }

  const hashValue = readInitDataFromLocation(window.location.hash);
  if (hashValue) {
    return hashValue;
  }

  const queryValue = readInitDataFromLocation(window.location.search);
  if (queryValue) {
    return queryValue;
  }

  return '';
}

export function readUserIdFromInitData(initData: string): string | null {
  const normalized = normalizeInitData(initData);
  if (!normalized) {
    return null;
  }

  const encodedUser = new URLSearchParams(normalized).get('user');
  if (!encodedUser?.trim()) {
    return null;
  }

  try {
    const parsed = JSON.parse(encodedUser) as { id?: unknown; user_id?: unknown };
    return readUserIdValue(parsed.id ?? parsed.user_id);
  } catch {
    return null;
  }
}

export function getInitDataUserId(): string | null {
  return readUserIdFromInitData(getInitData()) ?? readUnsafeBridgeUserId();
}

const DEFAULT_INIT_DATA_POLL_INTERVAL_MS = 150;
const DEFAULT_INIT_DATA_POLL_DURATION_MS = 5_000;

export function waitForInitData(
  onReady: (initData: string) => void,
  pollIntervalMs = DEFAULT_INIT_DATA_POLL_INTERVAL_MS,
  pollDurationMs = DEFAULT_INIT_DATA_POLL_DURATION_MS,
): () => void {
  if (typeof window === 'undefined') {
    return () => undefined;
  }

  let stopped = false;

  const stop = () => {
    if (stopped) {
      return;
    }

    stopped = true;
    window.clearInterval(pollIntervalId);
    window.clearTimeout(pollTimeoutId);
    window.removeEventListener('hashchange', flush);
  };

  const flush = () => {
    const nextValue = getInitData();
    if (!nextValue) {
      return;
    }

    stop();
    onReady(nextValue);
  };

  const pollIntervalId = window.setInterval(flush, pollIntervalMs);
  const pollTimeoutId = window.setTimeout(stop, pollDurationMs);
  window.addEventListener('hashchange', flush);
  flush();

  return () => {
    stop();
  };
}
