export type MaxSharePayload = {
  mid: string;
  chatType?: 'DIALOG' | 'CHAT';
};

function resolveBridge() {
  return window.MAX?.WebApp ?? window.WebApp;
}

export function openMaxBotLink(url: string): void {
  const bridge = resolveBridge();
  if (typeof bridge?.openMaxLink === 'function') {
    bridge.openMaxLink(url);
    return;
  }

  window.location.assign(url);
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
