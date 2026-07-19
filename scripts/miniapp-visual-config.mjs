export const LOCAL_MINIAPP_BASE_URL = 'http://127.0.0.1:3000/app/';
export const PRODUCTION_MINIAPP_BASE_URL = 'https://major-maksimov.ru/app/';
export const DEFAULT_MINIAPP_VISUAL_NOW = '2026-07-18T09:00:00.000Z';

export function resolveMiniappVisualMode(value) {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase();
  if (!normalized || normalized === 'local') {
    return 'local';
  }
  if (normalized === 'production' || normalized === 'prod') {
    return 'production';
  }

  throw new Error('Mini app visual mode must be one of: local, production');
}

export function resolveMiniappScreenshotBaseUrl(env = process.env) {
  const explicitBaseUrl = env.MINIAPP_SCREENSHOT_BASE_URL?.trim();
  if (explicitBaseUrl) {
    return explicitBaseUrl;
  }

  return resolveMiniappVisualMode(env.MINIAPP_SCREENSHOT_MODE) === 'production'
    ? PRODUCTION_MINIAPP_BASE_URL
    : LOCAL_MINIAPP_BASE_URL;
}

export function resolveMiniappVisualAuditBaseUrls(env = process.env) {
  const explicitBaseUrls = splitCommaSeparated(env.MINIAPP_VISUAL_AUDIT_BASE_URLS);
  if (explicitBaseUrls.length > 0) {
    return explicitBaseUrls;
  }

  return [
    resolveMiniappVisualMode(env.MINIAPP_VISUAL_AUDIT_MODE) === 'production'
      ? PRODUCTION_MINIAPP_BASE_URL
      : LOCAL_MINIAPP_BASE_URL,
  ];
}

export function resolveMiniappVisualNow(env = process.env) {
  const value = env.MINIAPP_SCREENSHOT_NOW?.trim() || DEFAULT_MINIAPP_VISUAL_NOW;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new Error('MINIAPP_SCREENSHOT_NOW must be a valid ISO date-time');
  }

  return new Date(timestamp);
}

export function resolveScenarioRuntime(scenario, defaultBridgeEnabled) {
  return {
    previewEnabled: scenario.preview !== false,
    bridgeEnabled:
      typeof scenario.maxBridge === 'boolean' ? scenario.maxBridge : defaultBridgeEnabled,
  };
}

export function splitCommaSeparated(value) {
  return String(value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}
