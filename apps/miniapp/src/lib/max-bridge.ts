import { getPreviewDevicePreset, type PreviewDevice } from './preview-device';

export type MaxSharePayload =
  | {
      text?: string;
      link?: string;
    }
  | {
      mid: string;
      chatType?: 'DIALOG' | 'CHAT';
    };

type MaxBackButtonHandler = () => void;
export type MaxPlatform = 'ios' | 'android' | 'desktop' | 'web' | 'unknown';

function resolveBridge() {
  return window.MAX?.WebApp ?? window.WebApp;
}

function resolveViewportSize() {
  const viewport = window.visualViewport;
  return {
    width: Math.round(viewport?.width ?? window.innerWidth),
    height: Math.round(viewport?.height ?? window.innerHeight),
  };
}

let reliableSettingsGridLayout: boolean | null = null;

function hasReliableSettingsGridLayout(): boolean {
  if (reliableSettingsGridLayout !== null) {
    return reliableSettingsGridLayout;
  }

  if (
    typeof CSS === 'undefined' ||
    typeof CSS.supports !== 'function' ||
    !CSS.supports('display', 'grid') ||
    !CSS.supports('grid-template-rows', 'minmax(0, 1fr) auto')
  ) {
    reliableSettingsGridLayout = false;
    return reliableSettingsGridLayout;
  }

  if (!document.body) {
    return true;
  }

  const host = document.createElement('div');
  const body = document.createElement('div');
  const filler = document.createElement('div');
  const footer = document.createElement('div');

  host.style.cssText = [
    'position:absolute',
    'left:-10000px',
    'top:-10000px',
    'width:100px',
    'height:100px',
    'display:grid',
    'grid-template-rows:minmax(0, 1fr) auto',
    'overflow:hidden',
    'visibility:hidden',
  ].join(';');
  body.style.cssText = 'min-height:0;overflow:auto';
  filler.style.cssText = 'height:200px';
  footer.style.cssText = 'height:20px';

  body.appendChild(filler);
  host.appendChild(body);
  host.appendChild(footer);
  document.body.appendChild(host);

  const hostRect = host.getBoundingClientRect();
  const bodyRect = body.getBoundingClientRect();
  const footerRect = footer.getBoundingClientRect();
  host.parentNode?.removeChild(host);

  reliableSettingsGridLayout =
    bodyRect.height > 70 &&
    bodyRect.height < 82 &&
    footerRect.height > 18 &&
    footerRect.bottom <= hostRect.bottom + 1;

  return reliableSettingsGridLayout;
}

function normalizePlatform(
  value: string | undefined,
  previewDevice: PreviewDevice | null | undefined,
): MaxPlatform {
  if (previewDevice) {
    return getPreviewDevicePreset(previewDevice).platform === 'ios' ? 'ios' : 'android';
  }

  const normalized = value?.trim().toLowerCase();
  if (normalized === 'ios' || normalized === 'iphone') {
    return 'ios';
  }
  if (normalized === 'android') {
    return 'android';
  }
  if (normalized === 'desktop') {
    return 'desktop';
  }
  if (normalized === 'web') {
    return 'web';
  }

  return 'unknown';
}

function applyRootEnvironment(options: { previewDevice?: PreviewDevice | null } = {}) {
  const root = document.documentElement;
  const bridge = resolveBridge();
  const { height } = resolveViewportSize();
  const previewPreset = options.previewDevice
    ? getPreviewDevicePreset(options.previewDevice)
    : null;
  const platform = normalizePlatform(bridge?.platform, options.previewDevice);

  root.dataset.maxPlatform = platform;
  root.dataset.maxClient = previewPreset ? 'preview' : bridge ? 'native' : 'browser';

  if (platform === 'android' && !hasReliableSettingsGridLayout()) {
    root.dataset.maxLegacySettingsDrilldown = 'true';
  } else {
    delete root.dataset.maxLegacySettingsDrilldown;
  }

  if (platform === 'ios') {
    root.style.setProperty('--app-shell-max-width', '560px');
    root.style.setProperty('--app-topbar-radius', '24px');
    root.style.setProperty('--app-bottom-nav-radius', '26px');
  } else if (platform === 'android') {
    root.style.setProperty('--app-shell-max-width', '520px');
    root.style.setProperty('--app-topbar-radius', '20px');
    root.style.setProperty('--app-bottom-nav-radius', '20px');
  } else {
    root.style.setProperty('--app-shell-max-width', '540px');
    root.style.setProperty('--app-topbar-radius', '22px');
    root.style.setProperty('--app-bottom-nav-radius', '24px');
  }

  if (options.previewDevice) {
    root.dataset.maxPreviewDevice = options.previewDevice;
  } else {
    delete root.dataset.maxPreviewDevice;
  }

  root.style.setProperty('--app-viewport-height', `${height}px`);
}

export function syncMaxNativeEnvironment(
  options: { previewDevice?: PreviewDevice | null } = {},
): () => void {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return () => undefined;
  }

  const apply = () => {
    applyRootEnvironment(options);
  };

  apply();

  window.addEventListener('resize', apply, { passive: true });
  window.visualViewport?.addEventListener('resize', apply);
  window.visualViewport?.addEventListener('scroll', apply);

  return () => {
    window.removeEventListener('resize', apply);
    window.visualViewport?.removeEventListener('resize', apply);
    window.visualViewport?.removeEventListener('scroll', apply);
  };
}

function parseMaxUrl(url: string): URL | null {
  try {
    return new URL(url, window.location.href);
  } catch {
    return null;
  }
}

function isMaxDeepLink(url: URL): boolean {
  return url.protocol === 'https:' && (url.hostname === 'max.ru' || url.hostname === 'www.max.ru');
}

function isMaxBotStartLink(url: URL): boolean {
  return isMaxDeepLink(url) && url.searchParams.has('start') && !url.searchParams.has('startapp');
}

function isInlinePreviewUrl(url: URL): boolean {
  return url.protocol === 'data:' || url.protocol === 'blob:';
}

function scheduleMiniAppClose(): void {
  window.setTimeout(() => {
    resolveBridge()?.close?.();
  }, 40);
}

export function readyMaxMiniApp(): void {
  resolveBridge()?.ready?.();
}

export function closeMaxMiniApp(fallback?: () => void): void {
  const bridge = resolveBridge();
  if (typeof bridge?.close === 'function') {
    bridge.close();
    return;
  }

  fallback?.();
}

export function openMaxBotLink(url: string): void {
  const normalizedUrl = url.trim();
  if (!normalizedUrl) {
    return;
  }

  const parsed = parseMaxUrl(normalizedUrl);
  const isDeepLink = Boolean(parsed && isMaxDeepLink(parsed));
  const bridge = resolveBridge();

  if (isDeepLink) {
    if (parsed && isMaxBotStartLink(parsed)) {
      // MAX Bridge link methods require a user gesture; handoff links often open after async saves.
      window.location.assign(normalizedUrl);
      return;
    }

    if (typeof bridge?.openMaxLink === 'function') {
      bridge.openMaxLink(normalizedUrl);
      return;
    }
    window.location.assign(normalizedUrl);
    return;
  }

  if (parsed && isInlinePreviewUrl(parsed)) {
    const openedWindow = window.open?.(normalizedUrl, '_blank', 'noopener,noreferrer');
    if (openedWindow) {
      return;
    }

    window.location.assign(normalizedUrl);
    return;
  }

  if (typeof bridge?.openLink === 'function') {
    bridge.openLink(normalizedUrl);
    return;
  }

  window.location.assign(normalizedUrl);
}

export function openMaxBotLinkAndClose(url: string): boolean {
  const normalizedUrl = url.trim();
  if (!normalizedUrl) {
    return false;
  }

  const parsed = parseMaxUrl(normalizedUrl);
  const shouldCloseAfterOpen = !(parsed && isMaxBotStartLink(parsed));
  openMaxBotLink(normalizedUrl);
  if (shouldCloseAfterOpen) {
    scheduleMiniAppClose();
  }
  return true;
}

export function openMaxProfileLink(url: string): boolean {
  const normalizedUrl = url.trim();
  if (!normalizedUrl) {
    return false;
  }

  const bridge = resolveBridge();
  const parsed = parseMaxUrl(normalizedUrl);
  if (!parsed || !isMaxDeepLink(parsed)) {
    return false;
  }

  if (typeof bridge?.openMaxLink === 'function') {
    bridge.openMaxLink(normalizedUrl);
    scheduleMiniAppClose();
    return true;
  }

  window.location.assign(normalizedUrl);
  return true;
}

export function canShareMaxContent(): boolean {
  const bridge = resolveBridge();
  return typeof bridge?.shareMaxContent === 'function';
}

export async function shareMaxContent(payload: MaxSharePayload): Promise<void> {
  const bridge = resolveBridge();
  if (typeof bridge?.shareMaxContent !== 'function') {
    throw new Error('Native share недоступен в этой версии MAX.');
  }

  await Promise.resolve(bridge.shareMaxContent(payload));
}

export function setMaxClosingConfirmation(enabled: boolean): void {
  const bridge = resolveBridge();
  if (!bridge) {
    return;
  }

  if (enabled) {
    bridge.enableClosingConfirmation?.();
    return;
  }

  bridge.disableClosingConfirmation?.();
}

export function setMaxBackButtonVisible(visible: boolean): void {
  const backButton = resolveBridge()?.BackButton;
  if (!backButton) {
    return;
  }

  if (visible) {
    backButton.show?.();
    return;
  }

  backButton.hide?.();
}

export function bindMaxBackButton(handler: MaxBackButtonHandler): () => void {
  const backButton = resolveBridge()?.BackButton;
  if (!backButton?.onClick) {
    return () => undefined;
  }

  backButton.onClick(handler);
  return () => {
    backButton.offClick?.(handler);
  };
}

export function maxImpact(style: 'light' | 'medium' | 'heavy' | 'rigid' | 'soft' = 'light'): void {
  resolveBridge()?.HapticFeedback?.impactOccurred?.(style);
}

export function maxNotify(type: 'error' | 'success' | 'warning'): void {
  resolveBridge()?.HapticFeedback?.notificationOccurred?.(type);
}

export function maxSelectionChanged(): void {
  resolveBridge()?.HapticFeedback?.selectionChanged?.();
}
