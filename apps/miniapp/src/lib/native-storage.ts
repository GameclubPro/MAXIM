type NativeStorageArea = 'device' | 'secure';

type NativeStorageResult = {
  key?: string;
  value?: string | null;
  status?: string;
};

type NativeStorageBridge = {
  getItem?: (key: string) => Promise<NativeStorageResult> | NativeStorageResult;
  setItem?: (key: string, value: string) => Promise<NativeStorageResult> | NativeStorageResult;
  removeItem?: (key: string) => Promise<NativeStorageResult> | NativeStorageResult;
};

function resolveBridge() {
  if (typeof window === 'undefined') {
    return undefined;
  }

  return window.MAX?.WebApp ?? window.WebApp;
}

function hasNativeStorageRuntime(): boolean {
  const bridge = resolveBridge();
  if (!bridge) {
    return false;
  }

  if (typeof document !== 'undefined') {
    const client = document.documentElement.dataset.maxClient;
    if (client === 'preview' || client === 'browser') {
      return false;
    }
  }

  return Boolean(
    bridge.initData || bridge.init_data || bridge.initDataUnsafe || bridge.init_data_unsafe,
  );
}

function resolveNativeStorage(area: NativeStorageArea): NativeStorageBridge | undefined {
  if (!hasNativeStorageRuntime()) {
    return undefined;
  }

  const bridge = resolveBridge();
  return area === 'secure' ? bridge?.SecureStorage : bridge?.DeviceStorage;
}

export function readLocalMirrorItem(key: string): string | null {
  if (typeof window === 'undefined') {
    return null;
  }

  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeLocalMirrorItem(key: string, value: string): void {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Ignore storage failures in restrictive WebView environments.
  }
}

export function removeLocalMirrorItem(key: string): void {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    window.localStorage.removeItem(key);
  } catch {
    // Ignore storage failures in restrictive WebView environments.
  }
}

export async function readNativeStorageItem(
  key: string,
  area: NativeStorageArea = 'device',
): Promise<string | null> {
  if (typeof window === 'undefined') {
    return null;
  }

  try {
    const result = await resolveNativeStorage(area)?.getItem?.(key);
    return typeof result?.value === 'string' ? result.value : null;
  } catch {
    return null;
  }
}

export async function writeNativeStorageItem(
  key: string,
  value: string,
  area: NativeStorageArea = 'device',
): Promise<void> {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    await resolveNativeStorage(area)?.setItem?.(key, value);
  } catch {
    // Native storage is an enhancement; local mirror remains the fallback.
  }
}

export async function removeNativeStorageItem(
  key: string,
  area: NativeStorageArea = 'device',
): Promise<void> {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    await resolveNativeStorage(area)?.removeItem?.(key);
  } catch {
    // Native storage is an enhancement; local mirror remains the fallback.
  }
}

export function saveMirroredItem(key: string, value: string): void {
  writeLocalMirrorItem(key, value);
  void writeNativeStorageItem(key, value);
}

export function removeMirroredItem(key: string): void {
  removeLocalMirrorItem(key);
  void removeNativeStorageItem(key);
}

export async function hydrateMirroredItem(key: string): Promise<string | null> {
  const nativeValue = await readNativeStorageItem(key);
  if (nativeValue === null) {
    return readLocalMirrorItem(key);
  }

  writeLocalMirrorItem(key, nativeValue);
  return nativeValue;
}
