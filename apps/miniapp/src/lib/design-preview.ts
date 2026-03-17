export const PREVIEW_CHAT_ID = 'preview-chat';
export const PREVIEW_CHANNEL_ID = 'preview-channel';
export const PREVIEW_CHAT_TITLE = 'Садоводы Южного';
export const PREVIEW_CHANNEL_TITLE = 'Новости Южного';

const PREVIEW_SESSION_KEY = 'maxim:design-preview';
const PREVIEW_DEVICE_KEY = 'maxim:design-preview-device';

export type PreviewDevice = 'android' | 'iphone';

export type PreviewBootstrap = {
  enabled: boolean;
  device: PreviewDevice;
};

function readSession(key: string): string | null {
  try {
    return window.sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeSession(key: string, value: string): void {
  try {
    window.sessionStorage.setItem(key, value);
  } catch {
    // Ignore unavailable storage in preview helpers.
  }
}

function removeSession(key: string): void {
  try {
    window.sessionStorage.removeItem(key);
  } catch {
    // Ignore unavailable storage in preview helpers.
  }
}

function readLocal(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeLocal(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Ignore unavailable storage in preview helpers.
  }
}

export function normalizePreviewDevice(value: string | null | undefined): PreviewDevice {
  return value === 'iphone' ? 'iphone' : 'android';
}

export function getPreviewBootstrap(initData: string): PreviewBootstrap {
  const params = new URLSearchParams(window.location.search);
  const queryEnabled = params.get('preview') === '1';
  const queryDevice = params.get('device');
  const hasInitData = initData.trim().length > 0;

  if (queryEnabled) {
    writeSession(PREVIEW_SESSION_KEY, '1');
  }

  const sessionEnabled = !hasInitData && readSession(PREVIEW_SESSION_KEY) === '1';
  const enabled = queryEnabled || sessionEnabled;
  const device = normalizePreviewDevice(queryDevice ?? readLocal(PREVIEW_DEVICE_KEY));

  if (enabled) {
    writeLocal(PREVIEW_DEVICE_KEY, device);
  }

  return {
    enabled,
    device,
  };
}

export function persistPreviewDevice(device: PreviewDevice): void {
  writeLocal(PREVIEW_DEVICE_KEY, device);
}

export function disablePreviewMode(): void {
  removeSession(PREVIEW_SESSION_KEY);
}

export function buildPreviewSearch(search: string, device: PreviewDevice): string {
  const params = new URLSearchParams(search);
  params.set('preview', '1');
  params.set('device', device);

  const next = params.toString();
  return next ? `?${next}` : '';
}

export function stripPreviewSearch(search: string): string {
  const params = new URLSearchParams(search);
  params.delete('preview');
  params.delete('device');

  const next = params.toString();
  return next ? `?${next}` : '';
}
