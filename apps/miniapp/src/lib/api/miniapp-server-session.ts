const MINIAPP_SESSION_PATH = '/auth/miniapp-session';
const MINIAPP_CSRF_HEADER = 'X-Miniapp-Csrf-Token';
const SESSION_BOOTSTRAP_TIMEOUT_MS = 2_500;
const SESSION_RETRY_COOLDOWN_MS = 30_000;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

type ServerSessionState = {
  credential: string;
  csrfToken: string | null;
  validUntilMonotonicMs: number;
  retryAtMonotonicMs: number;
  unsupported: boolean;
};

type SessionOperationOptions = {
  signal?: AbortSignal;
};

type SessionRecoveryOptions = SessionOperationOptions & {
  expectedCsrfToken: string | null;
};

export type MiniappServerSessionManager = {
  ensure: (apiBase: string, initData: string, options?: SessionOperationOptions) => Promise<void>;
  recover: (apiBase: string, initData: string, options: SessionRecoveryOptions) => Promise<boolean>;
  applyHeaders: (apiBase: string, initData: string, headers: Headers) => string | null;
};

type SessionPayload = {
  csrfToken: string;
  validUntilMonotonicMs: number;
};

function monotonicNow(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

function createAbortError(): Error {
  return typeof DOMException === 'function'
    ? new DOMException('The operation was aborted.', 'AbortError')
    : Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' });
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw createAbortError();
  }
}

function parseSessionPayload(value: unknown): SessionPayload | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const row = value as Record<string, unknown>;
  const csrfToken = typeof row.csrfToken === 'string' ? row.csrfToken : '';
  const expiresInSec =
    typeof row.expiresInSec === 'number' &&
    Number.isFinite(row.expiresInSec) &&
    row.expiresInSec > 0
      ? row.expiresInSec
      : null;
  const expiresAtMs = typeof row.expiresAt === 'string' ? Date.parse(row.expiresAt) : Number.NaN;
  const remainingMs =
    expiresInSec !== null
      ? expiresInSec * 1_000
      : Number.isFinite(expiresAtMs)
        ? expiresAtMs - Date.now()
        : Number.NaN;
  if (
    row.authenticated !== true ||
    !TOKEN_PATTERN.test(csrfToken) ||
    !Number.isFinite(remainingMs) ||
    remainingMs <= 0
  ) {
    return null;
  }

  return {
    csrfToken,
    validUntilMonotonicMs: monotonicNow() + remainingMs,
  };
}

async function readResponseCode(response: Response): Promise<string | null> {
  try {
    const payload = (await response.json()) as unknown;
    if (!payload || typeof payload !== 'object') {
      return null;
    }
    const code = (payload as Record<string, unknown>).code;
    return typeof code === 'string' ? code : null;
  } catch {
    return null;
  }
}

export function createMiniappServerSessionManager(enabled: boolean): MiniappServerSessionManager {
  const states = new Map<string, ServerSessionState>();
  const queueTails = new Map<string, Promise<void>>();

  const setUnavailableState = (apiBase: string, initData: string): void => {
    states.set(apiBase, {
      credential: initData,
      csrfToken: null,
      validUntilMonotonicMs: 0,
      retryAtMonotonicMs: monotonicNow() + SESSION_RETRY_COOLDOWN_MS,
      unsupported: false,
    });
  };

  const isUsableState = (state: ServerSessionState | undefined, initData: string): boolean =>
    Boolean(
      state?.credential === initData &&
      (state.unsupported ||
        state.validUntilMonotonicMs > monotonicNow() ||
        state.retryAtMonotonicMs > monotonicNow()),
    );

  const enqueue = <T>(
    apiBase: string,
    signal: AbortSignal | undefined,
    operation: () => Promise<T>,
  ): Promise<T> => {
    const previous = queueTails.get(apiBase) ?? Promise.resolve();
    const queued = previous.then(async () => {
      throwIfAborted(signal);
      return operation();
    });
    const tail = queued.then(
      () => undefined,
      () => undefined,
    );
    queueTails.set(apiBase, tail);
    void tail.then(() => {
      if (queueTails.get(apiBase) === tail) {
        queueTails.delete(apiBase);
      }
    });
    return queued;
  };

  const requestSession = async (
    apiBase: string,
    initData: string,
    method: 'GET' | 'POST',
    callerSignal: AbortSignal | undefined,
  ): Promise<Response> => {
    throwIfAborted(callerSignal);
    const controller = new AbortController();
    const abortFromCaller = () => controller.abort();
    const timeoutId = globalThis.setTimeout(() => controller.abort(), SESSION_BOOTSTRAP_TIMEOUT_MS);
    callerSignal?.addEventListener('abort', abortFromCaller, { once: true });

    try {
      return await fetch(`${apiBase}${MINIAPP_SESSION_PATH}`, {
        method,
        credentials: 'include',
        cache: 'no-store',
        signal: controller.signal,
        headers: { Authorization: `InitData ${initData}` },
      });
    } finally {
      globalThis.clearTimeout(timeoutId);
      callerSignal?.removeEventListener('abort', abortFromCaller);
    }
  };

  const storeSessionResponse = async (
    apiBase: string,
    initData: string,
    response: Response,
  ): Promise<boolean> => {
    if (!response.ok) {
      setUnavailableState(apiBase, initData);
      return false;
    }

    const payload = parseSessionPayload(await response.json().catch(() => null));
    states.set(apiBase, {
      credential: initData,
      csrfToken: payload?.csrfToken ?? null,
      validUntilMonotonicMs: payload?.validUntilMonotonicMs ?? 0,
      retryAtMonotonicMs: payload ? 0 : monotonicNow() + SESSION_RETRY_COOLDOWN_MS,
      unsupported: false,
    });
    return payload !== null;
  };

  const bootstrap = async (
    apiBase: string,
    initData: string,
    signal: AbortSignal | undefined,
  ): Promise<void> => {
    try {
      let response = await requestSession(apiBase, initData, 'POST', signal);
      if (response.status === 401) {
        const code = await readResponseCode(response);
        if (code === 'MINIAPP_AUTH_EXPIRED') {
          response = await requestSession(apiBase, initData, 'GET', signal);
        }
      }

      if (response.status === 404 || response.status === 405) {
        states.set(apiBase, {
          credential: initData,
          csrfToken: null,
          validUntilMonotonicMs: 0,
          retryAtMonotonicMs: Number.POSITIVE_INFINITY,
          unsupported: true,
        });
        return;
      }

      await storeSessionResponse(apiBase, initData, response);
    } catch (error: unknown) {
      if (signal?.aborted) {
        throw error;
      }
      setUnavailableState(apiBase, initData);
    }
  };

  return {
    async ensure(apiBase, initData, options = {}) {
      if (!enabled || !initData || isUsableState(states.get(apiBase), initData)) {
        return;
      }

      await enqueue(apiBase, options.signal, async () => {
        if (isUsableState(states.get(apiBase), initData)) {
          return;
        }
        await bootstrap(apiBase, initData, options.signal);
      });
    },
    async recover(apiBase, initData, options) {
      if (!enabled || !initData) {
        return false;
      }

      return enqueue(apiBase, options.signal, async () => {
        const current = states.get(apiBase);
        if (current && current.credential !== initData) {
          return false;
        }
        if (
          current?.credential === initData &&
          current.csrfToken !== options.expectedCsrfToken &&
          current.csrfToken !== null &&
          current.validUntilMonotonicMs > monotonicNow()
        ) {
          return true;
        }

        try {
          const response = await requestSession(apiBase, initData, 'GET', options.signal);
          return storeSessionResponse(apiBase, initData, response);
        } catch (error: unknown) {
          if (options.signal?.aborted) {
            throw error;
          }
          setUnavailableState(apiBase, initData);
          return false;
        }
      });
    },
    applyHeaders(apiBase, initData, headers) {
      const state = states.get(apiBase);
      const csrfToken =
        state?.credential === initData && state.validUntilMonotonicMs > monotonicNow()
          ? state.csrfToken
          : null;
      if (csrfToken) {
        headers.set(MINIAPP_CSRF_HEADER, csrfToken);
      }
      return csrfToken ?? null;
    },
  };
}
