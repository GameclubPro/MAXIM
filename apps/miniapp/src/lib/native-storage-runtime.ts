import { isNativeDeviceStorageAvailable } from './native-storage';

type NativeStorageRuntimeWaitOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
  pollIntervalMs?: number;
};

const NATIVE_STORAGE_DISCOVERY_TIMEOUT_MS = 8_000;
const NATIVE_STORAGE_DISCOVERY_POLL_INTERVAL_MS = 150;

export async function waitForNativeStorageRuntime(
  options: NativeStorageRuntimeWaitOptions = {},
): Promise<boolean> {
  if (typeof window === 'undefined' || options.signal?.aborted) {
    return false;
  }
  if (isNativeDeviceStorageAvailable()) {
    return true;
  }

  const bridgeScript =
    typeof document !== 'undefined' && typeof document.querySelector === 'function'
      ? document.querySelector<HTMLScriptElement>('script[src*="st.max.ru/js/max-web-app.js"]')
      : null;
  if (
    (!bridgeScript && !window.__MAXIM_VISUAL_BRIDGE__) ||
    (typeof document !== 'undefined' && document.documentElement.dataset.maxClient === 'preview')
  ) {
    return false;
  }

  const timeoutMs = Math.max(0, options.timeoutMs ?? NATIVE_STORAGE_DISCOVERY_TIMEOUT_MS);
  const pollIntervalMs = Math.max(
    10,
    options.pollIntervalMs ?? NATIVE_STORAGE_DISCOVERY_POLL_INTERVAL_MS,
  );
  if (timeoutMs === 0) {
    return false;
  }

  return new Promise<boolean>((resolve) => {
    let settled = false;
    let intervalId: ReturnType<typeof setInterval> | null = null;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    function finish(available: boolean) {
      if (settled) {
        return;
      }
      settled = true;
      if (intervalId !== null) {
        clearInterval(intervalId);
      }
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
      }
      bridgeScript?.removeEventListener('load', checkAvailability);
      options.signal?.removeEventListener('abort', handleAbort);
      resolve(available);
    }
    function checkAvailability() {
      if (options.signal?.aborted) {
        finish(false);
        return;
      }
      if (isNativeDeviceStorageAvailable()) {
        finish(true);
      }
    }
    function handleAbort() {
      finish(false);
    }

    intervalId = setInterval(checkAvailability, pollIntervalMs);
    timeoutId = setTimeout(() => finish(false), timeoutMs);
    bridgeScript?.addEventListener('load', checkAvailability);
    options.signal?.addEventListener('abort', handleAbort, { once: true });
    checkAvailability();
  });
}
