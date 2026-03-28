function normalizeInitData(value: string): string {
  let current = value.trim();

  for (let i = 0; i < 3; i += 1) {
    const wrapped = extractWrappedInitData(current);
    if (wrapped) {
      current = wrapped;
    }

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

  return extractWrappedInitData(current) ?? current;
}

function extractWrappedInitData(value: string): string | null {
  const normalized = value.trim().replace(/^[?#]/u, '');
  if (
    !normalized.includes('WebAppData=') &&
    !normalized.includes('init_data=') &&
    !normalized.includes('initData=')
  ) {
    return null;
  }

  const params = new URLSearchParams(normalized);
  for (const key of ['WebAppData', 'init_data', 'initData']) {
    const candidate = params.get(key);
    if (candidate?.trim()) {
      return candidate.trim();
    }
  }

  return null;
}

function readInitDataFromLocation(source: string): string {
  const params = new URLSearchParams(source.replace(/^[?#]/u, ''));
  for (const key of ['WebAppData', 'init_data', 'initData']) {
    const candidate = params.get(key);
    if (candidate?.trim()) {
      return normalizeInitData(candidate);
    }
  }

  return '';
}

export function getInitData(): string {
  const bridgeCandidates = [
    window.MAX?.WebApp?.initData,
    window.MAX?.WebApp?.init_data,
    window.WebApp?.initData,
    window.WebApp?.init_data,
  ];

  const bridgeValue = bridgeCandidates.find((value) => Boolean(value && value.trim()));
  if (bridgeValue) {
    return normalizeInitData(bridgeValue);
  }

  const hashValue = readInitDataFromLocation(window.location.hash);
  if (hashValue) {
    return hashValue;
  }

  const queryValue = readInitDataFromLocation(window.location.search);
  if (queryValue) {
    return queryValue;
  }

  return '';
}
