export function getInitData(): string {
  const searchParam = new URLSearchParams(window.location.search).get('init_data');
  if (searchParam) {
    return searchParam;
  }

  const bridgeValue = window.MAX?.WebApp?.initData;
  if (bridgeValue) {
    return bridgeValue;
  }

  return '';
}
