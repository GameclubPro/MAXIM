export const MAX_API_SERVICE_RPS_METRICS_KEY_PREFIX = 'maxapi:rps:service:v1';
export const MAX_API_SOURCE_RPS_METRICS_KEY_PREFIX = 'maxapi:rps:source:v1';
export const MAX_API_SOURCE_DIMENSION_CATALOG_KEY = 'maxapi:rps:source-dimensions:v1';
export const MAX_API_SOURCE_DIMENSION_BOOTSTRAP_COMPLETE_KEY =
  'maxapi:rps:source-dimensions-bootstrap:v1:complete';
export const MAX_API_SOURCE_DIMENSION_BOOTSTRAP_LOCK_KEY =
  'maxapi:rps:source-dimensions-bootstrap:v1:lock';

export type MaxApiMetricTrafficClass = 'critical' | 'interactive' | 'background';

export type MaxApiSourceMetricDimension = {
  botId: string;
  trafficClass: MaxApiMetricTrafficClass;
  sourceTag: string;
};

export type MaxApiSourceMetricEntry = MaxApiSourceMetricDimension & {
  key: string;
  sec: number;
};

const MAX_API_METRIC_TRAFFIC_CLASSES = new Set<MaxApiMetricTrafficClass>([
  'critical',
  'interactive',
  'background',
]);

export function normalizeMaxApiRateLimitServiceScope(value: unknown): string {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gu, '_')
    .replace(/^_+|_+$/gu, '')
    .slice(0, 64);
  return normalized || 'api';
}

export function buildMaxApiServiceBotClassMetricKey(params: {
  serviceScope: string;
  botId: string;
  trafficClass: MaxApiMetricTrafficClass;
  sec: number;
}): string {
  return `${MAX_API_SERVICE_RPS_METRICS_KEY_PREFIX}:${params.serviceScope}:bot:${params.botId}:${params.trafficClass}:${params.sec}`;
}

export function buildMaxApiServiceStackClassMetricKey(params: {
  serviceScope: string;
  trafficClass: MaxApiMetricTrafficClass;
  sec: number;
}): string {
  return `${MAX_API_SERVICE_RPS_METRICS_KEY_PREFIX}:${params.serviceScope}:stack:${params.trafficClass}:${params.sec}`;
}

export function buildMaxApiSourceMetricKey(
  params: MaxApiSourceMetricDimension & { sec: number },
): string {
  return `${MAX_API_SOURCE_RPS_METRICS_KEY_PREFIX}:${params.botId}:${params.trafficClass}:${params.sourceTag}:${params.sec}`;
}

export function serializeMaxApiSourceMetricDimension(
  dimension: MaxApiSourceMetricDimension,
): string {
  return JSON.stringify([dimension.botId, dimension.trafficClass, dimension.sourceTag]);
}

export function parseMaxApiSourceMetricDimension(
  value: string,
): MaxApiSourceMetricDimension | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 3 ||
      typeof parsed[0] !== 'string' ||
      parsed[0].length === 0 ||
      typeof parsed[1] !== 'string' ||
      !MAX_API_METRIC_TRAFFIC_CLASSES.has(parsed[1] as MaxApiMetricTrafficClass) ||
      typeof parsed[2] !== 'string' ||
      parsed[2].length === 0
    ) {
      return null;
    }

    return {
      botId: parsed[0],
      trafficClass: parsed[1] as MaxApiMetricTrafficClass,
      sourceTag: parsed[2],
    };
  } catch {
    return null;
  }
}

export function parseMaxApiSourceMetricKey(key: string): MaxApiSourceMetricEntry | null {
  const prefix = `${MAX_API_SOURCE_RPS_METRICS_KEY_PREFIX}:`;
  if (!key.startsWith(prefix)) {
    return null;
  }

  const [botId, trafficClassRaw, sourceTag, secRaw, ...rest] = key.slice(prefix.length).split(':');
  const sec = Number.parseInt(secRaw ?? '', 10);
  if (
    !botId ||
    !sourceTag ||
    rest.length > 0 ||
    !MAX_API_METRIC_TRAFFIC_CLASSES.has(trafficClassRaw as MaxApiMetricTrafficClass) ||
    !Number.isSafeInteger(sec) ||
    sec < 0
  ) {
    return null;
  }

  return {
    key,
    botId,
    trafficClass: trafficClassRaw as MaxApiMetricTrafficClass,
    sourceTag,
    sec,
  };
}
