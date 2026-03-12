export function openMaxBotLink(url: string): void {
  const bridge = window.MAX?.WebApp ?? window.WebApp;
  if (typeof bridge?.openMaxLink === 'function') {
    bridge.openMaxLink(url);
    return;
  }

  window.location.assign(url);
}
