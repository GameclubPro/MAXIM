export const MAX_API_SERVICE_RPS_METRICS_KEY_PREFIX = 'maxapi:rps:service:v1';

export type MaxApiMetricTrafficClass = 'critical' | 'interactive' | 'background';

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
