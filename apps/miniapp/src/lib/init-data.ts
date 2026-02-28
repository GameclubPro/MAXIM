export function getInitData(): string {
  const queryParams = new URLSearchParams(window.location.search);
  const queryValue = queryParams.get('init_data') ?? queryParams.get('initData');
  if (queryValue) {
    return queryValue;
  }

  const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  const hashValue = hashParams.get('init_data') ?? hashParams.get('initData');
  if (hashValue) {
    return hashValue;
  }

  const bridgeCandidates = [
    window.WebApp?.initData,
    window.WebApp?.init_data,
    window.MAX?.WebApp?.initData,
    window.MAX?.WebApp?.init_data,
  ];

  const bridgeValue = bridgeCandidates.find((value) => Boolean(value && value.trim()));
  if (bridgeValue) {
    return bridgeValue;
  }

  return '';
}
