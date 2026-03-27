function normalizeInitData(value: string): string {
  let current = value.trim();

  for (let i = 0; i < 2; i += 1) {
    if (current.includes('hash=')) {
      return current;
    }

    try {
      const decoded = decodeURIComponent(current);
      if (decoded === current) {
        break;
      }
      current = decoded;
    } catch {
      break;
    }
  }

  return current;
}

export function getInitData(): string {
  const bridgeCandidates = [
    window.WebApp?.initData,
    window.WebApp?.init_data,
    window.MAX?.WebApp?.initData,
    window.MAX?.WebApp?.init_data,
  ];

  const bridgeValue = bridgeCandidates.find((value) => Boolean(value && value.trim()));
  if (bridgeValue) {
    return normalizeInitData(bridgeValue);
  }

  const queryParams = new URLSearchParams(window.location.search);
  const queryValue = queryParams.get('init_data') ?? queryParams.get('initData');
  if (queryValue) {
    return normalizeInitData(queryValue);
  }

  const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  const hashValue = hashParams.get('init_data') ?? hashParams.get('initData');
  if (hashValue) {
    return normalizeInitData(hashValue);
  }

  return '';
}
