export type MaxSharePayload = {
  mid: string;
  chatType?: 'DIALOG' | 'CHAT';
};

type MaxBackButtonHandler = () => void;

function resolveBridge() {
  return window.MAX?.WebApp ?? window.WebApp;
}

function isMaxDeepLink(url: string): boolean {
  try {
    const parsed = new URL(url, window.location.href);
    return (
      parsed.protocol === 'https:' &&
      (parsed.hostname === 'max.ru' || parsed.hostname === 'www.max.ru')
    );
  } catch {
    return false;
  }
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

  const bridge = resolveBridge();
  if (isMaxDeepLink(normalizedUrl)) {
    if (typeof bridge?.openMaxLink === 'function') {
      bridge.openMaxLink(normalizedUrl);
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
