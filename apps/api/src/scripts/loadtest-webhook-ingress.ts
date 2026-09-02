import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Client, type QueryConfig } from 'pg';

export const WEBHOOK_LOAD_EXECUTE_CONFIRMATION = 'I_UNDERSTAND_THIS_SENDS_WEBHOOK_TRAFFIC';
export const WEBHOOK_LOAD_PUBLIC_CONFIRMATION = 'I_UNDERSTAND_THIS_SENDS_NETWORK_TRAFFIC';
export const WEBHOOK_LOAD_PRODUCTION_CONFIRMATION = 'I_UNDERSTAND_THIS_TARGETS_PRODUCTION';

const ALLOWED_MIRROR_COUNTS = [1, 2, 3, 6] as const;
const DEFAULT_DURATION_SEC = 600;
const DEFAULT_RPS = 100;
const DEFAULT_MAX_IN_FLIGHT = 256;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_ACK_P99_TARGET_MS = 2_000;
const DEFAULT_MIN_THROUGHPUT_RATIO = 0.95;
const DEFAULT_VERIFY_TIMEOUT_SEC = 60;
const DEFAULT_VERIFY_INTERVAL_MS = 1_000;
const DEFAULT_METRICS_VERIFY_INTERVAL_MS = 15_000;
const DEFAULT_DRAIN_QUEUE_LAG_TARGET_SEC = 10;
const DEFAULT_DRAIN_HEALTHY_SAMPLES = 3;
const DEFAULT_DRAIN_TIMEOUT_SEC = 120;
const DEFAULT_DRAIN_INTERVAL_MS = 5_000;
const DEFAULT_BURST_DURATION_SEC = 60;
const MAX_BOTS = 6;
const MAX_RPS = 1_000;
const OPERATIONAL_QUEUE_METRICS_PATHS = new Set([
  '/v1/system/metrics/queues/operational',
  '/api/v1/system/metrics/queues/operational',
]);

const KNOWN_PRODUCTION_HOSTS = new Set([
  'major-maksimov.ru',
  'maxim.play-team.ru',
  'api-cdn.flex-craft.ru',
  '84.201.186.244',
  '10.130.0.29',
  '94.139.246.178',
]);

type Environment = Record<string, string | undefined>;

export type WebhookLoadBot = {
  botId: string;
  secretPath: string;
  headerSecret: string;
};

type DatabaseVerification = {
  mode: 'database';
  databaseUrl: string;
};

export type MetricsVerification = {
  mode: 'metrics';
  metricsUrl: string;
  authorization: string | null;
};

export type WebhookLoadVerificationConfig =
  | DatabaseVerification
  | MetricsVerification
  | { mode: 'none' };

export type WebhookLoadProfile = 'custom' | 'steady-2x' | 'burst-4x';

export type WebhookLoadDrainConfig = {
  enabled: boolean;
  metrics: MetricsVerification | null;
  queueLagTargetSec: number;
  healthySamples: number;
  timeoutSec: number;
  intervalMs: number;
};

export type WebhookIngressLoadConfig = {
  targetUrl: URL;
  bots: WebhookLoadBot[];
  chatId: string;
  senderId: string;
  runId: string;
  durationSec: number;
  rps: number;
  profile: WebhookLoadProfile;
  baselineRps: number | null;
  maxInFlight: number;
  requestTimeoutMs: number;
  ackP99TargetMs: number;
  minThroughputRatio: number;
  mirrorCounts: number[];
  execute: boolean;
  publicTarget: boolean;
  knownProductionTarget: boolean;
  verification: WebhookLoadVerificationConfig;
  verificationTimeoutSec: number;
  verificationIntervalMs: number;
  drainVerification: WebhookLoadDrainConfig;
};

export type WebhookLoadPhasePlan = {
  mirrorCount: number;
  durationMs: number;
  semanticEvents: number;
  requests: number;
};

export type SyntheticWebhookPayload = {
  update_type: 'message_created';
  update_id: string;
  timestamp: string;
  message: {
    body: {
      mid: string;
      text: string;
    };
    recipient: {
      chat_id: string;
      chat_type: 'chat';
    };
    sender: {
      user_id: string;
      first_name: 'Ingress';
      last_name: 'LoadTest';
    };
    timestamp: string;
  };
  synthetic_load_test: {
    run_id: string;
    sequence: number;
    mirror_count: number;
    phase_index: number;
  };
};

type MutableRequestStats = {
  total: number;
  ok: number;
  latenciesMs: number[];
  statusCounts: Map<number, number>;
  transportErrors: Map<string, number>;
};

export type RequestStatsSummary = {
  total: number;
  ok: number;
  errors: number;
  errorRate: number;
  averageMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  statusCounts: Record<string, number>;
  transportErrors: Record<string, number>;
};

type VerificationCounts = {
  receipts: number;
  executionClaims: number;
};

export type VerificationResult = VerificationCounts & {
  mode: 'database' | 'metrics';
  expectedReceipts: number;
  expectedExecutionClaims: number;
  exact: boolean;
  verified: boolean;
};

export type QueueDrainMetrics = {
  queueLagSec: number;
  webhookDefaultPending: number;
  actionPending: number;
};

export type QueueDrainHealth = {
  healthy: boolean;
  queueLagHealthy: boolean;
  webhookDefaultPressureHealthy: boolean;
  actionPressureHealthy: boolean;
};

export type QueueDrainVerificationResult = {
  verified: boolean;
  timedOut: boolean;
  samples: number;
  consecutiveHealthySamples: number;
  requiredHealthySamples: number;
  queueLagTargetSec: number;
  baseline: Pick<QueueDrainMetrics, 'webhookDefaultPending' | 'actionPending'>;
  consecutiveHealthyForSec: number;
  lastSample: QueueDrainMetrics | null;
  lastHealth: QueueDrainHealth | null;
};

export type WebhookLoadAcceptance = {
  passed: boolean;
  ackPassed: boolean;
  throughputPassed: boolean;
  receiptAndClaimVerificationPassed: boolean | null;
  endToEndDrainPassed: boolean | null;
};

export type PhaseRunResult = {
  mirrorCount: number;
  configuredDurationSec: number;
  configuredRps: number;
  semanticEvents: number;
  attemptedSemanticEvents: number;
  plannedRequests: number;
  attemptedRequests: number;
  elapsedMs: number;
  achievedRps: number;
  throughputRatio: number;
  minimumThroughputRatio: number;
  throughputPassed: boolean;
  deadlineExceeded: boolean;
  ack: RequestStatsSummary;
};

function readRequired(env: Environment, key: string): string {
  const value = env[key]?.trim();
  if (!value) {
    throw new Error(`${key} is required`);
  }
  return value;
}

function withPgQueryTimeout(config: QueryConfig, queryTimeoutMs: number): QueryConfig {
  return Object.assign(config, { query_timeout: queryTimeoutMs });
}

function readPositiveNumber(
  env: Environment,
  key: string,
  fallback: number,
  options: { integer?: boolean; max?: number } = {},
): number {
  const raw = env[key]?.trim();
  const value = raw ? Number(raw) : fallback;
  if (!Number.isFinite(value) || value <= 0 || (options.integer && !Number.isInteger(value))) {
    throw new Error(`${key} must be a positive${options.integer ? ' integer' : ''}`);
  }
  if (options.max !== undefined && value > options.max) {
    throw new Error(`${key} must be at most ${options.max}`);
  }
  return value;
}

function parseTargetUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('WEBHOOK_LOAD_TARGET_URL must be a valid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('WEBHOOK_LOAD_TARGET_URL must use http or https');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('WEBHOOK_LOAD_TARGET_URL cannot contain credentials, query, or hash');
  }
  assertHttpsForCredentialUrl(url, 'WEBHOOK_LOAD_TARGET_URL');
  url.pathname = url.pathname.replace(/\/+$/u, '');
  if (!url.pathname.endsWith('/api/webhook/max')) {
    throw new Error('WEBHOOK_LOAD_TARGET_URL must end with /api/webhook/max');
  }
  return url;
}

function parseVerificationUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('WEBHOOK_LOAD_VERIFY_METRICS_URL must be a valid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('WEBHOOK_LOAD_VERIFY_METRICS_URL must use http or https');
  }
  if (url.username || url.password) {
    throw new Error('WEBHOOK_LOAD_VERIFY_METRICS_URL cannot contain credentials');
  }
  assertHttpsForCredentialUrl(url, 'WEBHOOK_LOAD_VERIFY_METRICS_URL');
  return url.toString();
}

function parseDrainMetricsUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('WEBHOOK_LOAD_VERIFY_DRAIN_METRICS_URL must be a valid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('WEBHOOK_LOAD_VERIFY_DRAIN_METRICS_URL must use http or https');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(
      'WEBHOOK_LOAD_VERIFY_DRAIN_METRICS_URL cannot contain credentials, query, or hash',
    );
  }
  assertHttpsForCredentialUrl(url, 'WEBHOOK_LOAD_VERIFY_DRAIN_METRICS_URL');
  const pathname = url.pathname.replace(/\/+$/u, '') || '/';
  if (!OPERATIONAL_QUEUE_METRICS_PATHS.has(pathname)) {
    throw new Error(
      'WEBHOOK_LOAD_VERIFY_DRAIN_METRICS_URL must target /v1/system/metrics/queues/operational',
    );
  }
  url.pathname = pathname;
  return url.toString();
}

function parseDatabaseUrl(raw: string): string {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
      throw new Error();
    }
    return raw;
  } catch {
    throw new Error('WEBHOOK_LOAD_VERIFY_DATABASE_URL must be a PostgreSQL URL');
  }
}

function isKnownProductionHost(hostname: string): boolean {
  const normalized = normalizeHostname(hostname);
  const comparableHost = readIpv4MappedAddress(normalized) ?? normalized;
  for (const productionHost of KNOWN_PRODUCTION_HOSTS) {
    if (comparableHost === productionHost || comparableHost.endsWith(`.${productionHost}`)) {
      return true;
    }
  }
  return false;
}

function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/\.+$/u, '');
}

function readIpv4MappedAddress(hostname: string): string | null {
  const address =
    hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  const match = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/u.exec(address);
  if (!match) {
    return null;
  }
  const high = Number.parseInt(match[1]!, 16);
  const low = Number.parseInt(match[2]!, 16);
  return [high >>> 8, high & 0xff, low >>> 8, low & 0xff].join('.');
}

function assertHttpsForCredentialUrl(url: URL, key: string): void {
  if (
    url.protocol !== 'https:' &&
    (isKnownProductionHost(url.hostname) || isPublicTarget(url.hostname))
  ) {
    throw new Error(`${key} must use https for public or production hosts`);
  }
}

function isPrivateOrLocalIpv4(hostname: string): boolean {
  const octets = hostname.split('.').map(Number);
  if (
    octets.length !== 4 ||
    octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return false;
  }
  return (
    octets[0] === 10 ||
    octets[0] === 127 ||
    (octets[0] === 169 && octets[1] === 254) ||
    (octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31) ||
    (octets[0] === 192 && octets[1] === 168)
  );
}

function isPublicTarget(hostname: string): boolean {
  const normalized = normalizeHostname(hostname);
  const address =
    normalized.startsWith('[') && normalized.endsWith(']') ? normalized.slice(1, -1) : normalized;
  if (address.includes(':')) {
    return address !== '::1';
  }
  if (
    normalized === 'localhost' ||
    normalized.endsWith('.localhost') ||
    normalized.endsWith('.local') ||
    normalized.endsWith('.internal') ||
    !normalized.includes('.') ||
    isPrivateOrLocalIpv4(normalized)
  ) {
    return false;
  }
  return true;
}

function parseBots(env: Environment): WebhookLoadBot[] {
  const bots: WebhookLoadBot[] = [];
  for (let index = 1; index <= MAX_BOTS; index += 1) {
    const botId = env[`WEBHOOK_LOAD_BOT_${index}_ID`]?.trim() ?? '';
    const secretPath = env[`WEBHOOK_LOAD_BOT_${index}_SECRET_PATH`]?.trim() ?? '';
    const headerSecret = env[`WEBHOOK_LOAD_BOT_${index}_HEADER_SECRET`]?.trim() ?? '';
    const configuredFields = [botId, secretPath, headerSecret].filter(Boolean).length;
    if (configuredFields === 0) {
      continue;
    }
    if (configuredFields !== 3) {
      throw new Error(`WEBHOOK_LOAD_BOT_${index} requires ID, SECRET_PATH, and HEADER_SECRET`);
    }
    if (secretPath.length < 8 || /[/?#]/u.test(secretPath)) {
      throw new Error(
        `WEBHOOK_LOAD_BOT_${index}_SECRET_PATH must be at least 8 safe path characters`,
      );
    }
    if (headerSecret.length < 8) {
      throw new Error(`WEBHOOK_LOAD_BOT_${index}_HEADER_SECRET must be at least 8 characters`);
    }
    bots.push({ botId, secretPath, headerSecret });
  }

  if (bots.length === 0) {
    throw new Error('At least one WEBHOOK_LOAD_BOT_<n> configuration is required');
  }

  assertUnique(
    bots.map((bot) => bot.botId),
    'bot ids',
  );
  assertUnique(
    bots.map((bot) => bot.secretPath),
    'webhook secret paths',
  );
  assertUnique(
    bots.map((bot) => bot.headerSecret),
    'webhook header secrets',
  );
  return bots;
}

function assertUnique(values: string[], label: string): void {
  if (new Set(values).size !== values.length) {
    throw new Error(`Webhook load-test ${label} must be unique`);
  }
}

function parseMirrorCounts(raw: string | undefined, botCount: number): number[] {
  const values = raw?.trim()
    ? raw
        .split(',')
        .map((value) => Number(value.trim()))
        .filter((value) => Number.isFinite(value))
    : ALLOWED_MIRROR_COUNTS.filter((value) => value <= botCount);
  if (
    values.length === 0 ||
    values.some(
      (value) => !Number.isInteger(value) || !ALLOWED_MIRROR_COUNTS.includes(value as never),
    )
  ) {
    throw new Error('WEBHOOK_LOAD_MIRROR_COUNTS must contain only 1,2,3,6');
  }
  if (new Set(values).size !== values.length) {
    throw new Error('WEBHOOK_LOAD_MIRROR_COUNTS cannot contain duplicates');
  }
  if (Math.max(...values) > botCount) {
    throw new Error('WEBHOOK_LOAD_MIRROR_COUNTS requires more configured bots');
  }
  return values;
}

function parseLoadProfile(env: Environment): {
  profile: WebhookLoadProfile;
  baselineRps: number | null;
  rps: number;
  defaultDurationSec: number;
} {
  const rawProfile = env.WEBHOOK_LOAD_PROFILE?.trim() || 'custom';
  if (rawProfile !== 'custom' && rawProfile !== 'steady-2x' && rawProfile !== 'burst-4x') {
    throw new Error('WEBHOOK_LOAD_PROFILE must be custom, steady-2x, or burst-4x');
  }
  const profile = rawProfile as WebhookLoadProfile;
  if (profile === 'custom') {
    if (env.WEBHOOK_LOAD_BASELINE_RPS?.trim()) {
      throw new Error('WEBHOOK_LOAD_BASELINE_RPS requires a steady-2x or burst-4x profile');
    }
    return {
      profile,
      baselineRps: null,
      rps: readPositiveNumber(env, 'WEBHOOK_LOAD_RPS', DEFAULT_RPS, { max: MAX_RPS }),
      defaultDurationSec: DEFAULT_DURATION_SEC,
    };
  }

  if (env.WEBHOOK_LOAD_RPS?.trim()) {
    throw new Error('WEBHOOK_LOAD_RPS cannot override a baseline-derived load profile');
  }
  const baselineRaw = readRequired(env, 'WEBHOOK_LOAD_BASELINE_RPS');
  const baselineRps = Number(baselineRaw);
  if (!Number.isFinite(baselineRps) || baselineRps <= 0) {
    throw new Error('WEBHOOK_LOAD_BASELINE_RPS must be a positive number');
  }
  const multiplier = profile === 'steady-2x' ? 2 : 4;
  const rps = baselineRps * multiplier;
  if (rps > MAX_RPS) {
    throw new Error(`WEBHOOK_LOAD_PROFILE produces more than ${MAX_RPS} rps`);
  }

  return {
    profile,
    baselineRps,
    rps,
    defaultDurationSec: profile === 'burst-4x' ? DEFAULT_BURST_DURATION_SEC : DEFAULT_DURATION_SEC,
  };
}

function readStrictBoolean(env: Environment, key: string, fallback: boolean): boolean {
  const raw = env[key]?.trim().toLowerCase();
  if (!raw) {
    return fallback;
  }
  if (raw === 'true') {
    return true;
  }
  if (raw === 'false') {
    return false;
  }
  throw new Error(`${key} must be true or false`);
}

function parseVerification(env: Environment): WebhookLoadVerificationConfig {
  const databaseUrl = env.WEBHOOK_LOAD_VERIFY_DATABASE_URL?.trim() ?? '';
  const metricsUrl = env.WEBHOOK_LOAD_VERIFY_METRICS_URL?.trim() ?? '';
  if (databaseUrl && metricsUrl) {
    throw new Error('Configure only one verification source: database or metrics');
  }
  if (databaseUrl) {
    return { mode: 'database', databaseUrl: parseDatabaseUrl(databaseUrl) };
  }
  if (metricsUrl) {
    return {
      mode: 'metrics',
      metricsUrl: parseVerificationUrl(metricsUrl),
      authorization: env.WEBHOOK_LOAD_VERIFY_METRICS_AUTHORIZATION?.trim() || null,
    };
  }
  return { mode: 'none' };
}

function parseDrainVerification(env: Environment): WebhookLoadDrainConfig {
  const enabled = readStrictBoolean(env, 'WEBHOOK_LOAD_VERIFY_DRAIN', false);
  const tuningKeys = [
    'WEBHOOK_LOAD_VERIFY_DRAIN_METRICS_URL',
    'WEBHOOK_LOAD_VERIFY_DRAIN_METRICS_AUTHORIZATION',
    'WEBHOOK_LOAD_VERIFY_DRAIN_LAG_TARGET_SEC',
    'WEBHOOK_LOAD_VERIFY_DRAIN_HEALTHY_SAMPLES',
    'WEBHOOK_LOAD_VERIFY_DRAIN_TIMEOUT_SEC',
    'WEBHOOK_LOAD_VERIFY_DRAIN_INTERVAL_MS',
  ] as const;
  if (!enabled && tuningKeys.some((key) => env[key]?.trim())) {
    throw new Error('Drain tuning requires WEBHOOK_LOAD_VERIFY_DRAIN=true');
  }
  const metricsUrl = enabled
    ? parseDrainMetricsUrl(readRequired(env, 'WEBHOOK_LOAD_VERIFY_DRAIN_METRICS_URL'))
    : null;
  const queueLagTargetSec = readPositiveNumber(
    env,
    'WEBHOOK_LOAD_VERIFY_DRAIN_LAG_TARGET_SEC',
    DEFAULT_DRAIN_QUEUE_LAG_TARGET_SEC,
    { max: 300 },
  );
  const healthySamples = readPositiveNumber(
    env,
    'WEBHOOK_LOAD_VERIFY_DRAIN_HEALTHY_SAMPLES',
    DEFAULT_DRAIN_HEALTHY_SAMPLES,
    { integer: true, max: 20 },
  );
  const timeoutSec = readPositiveNumber(
    env,
    'WEBHOOK_LOAD_VERIFY_DRAIN_TIMEOUT_SEC',
    DEFAULT_DRAIN_TIMEOUT_SEC,
    { max: 900 },
  );
  const intervalMs = readPositiveNumber(
    env,
    'WEBHOOK_LOAD_VERIFY_DRAIN_INTERVAL_MS',
    DEFAULT_DRAIN_INTERVAL_MS,
    { integer: true, max: 30_000 },
  );
  if (intervalMs < 1_000) {
    throw new Error('WEBHOOK_LOAD_VERIFY_DRAIN_INTERVAL_MS must be at least 1000');
  }
  const minimumObservationMs = Math.max(
    queueLagTargetSec * 1_000,
    (healthySamples - 1) * intervalMs,
  );
  if (timeoutSec * 1_000 <= minimumObservationMs) {
    throw new Error('WEBHOOK_LOAD_VERIFY_DRAIN_TIMEOUT_SEC must exceed the healthy sample window');
  }

  return {
    enabled,
    metrics: metricsUrl
      ? {
          mode: 'metrics',
          metricsUrl,
          authorization: env.WEBHOOK_LOAD_VERIFY_DRAIN_METRICS_AUTHORIZATION?.trim() || null,
        }
      : null,
    queueLagTargetSec,
    healthySamples,
    timeoutSec,
    intervalMs,
  };
}

export function loadWebhookIngressLoadConfig(env: Environment): WebhookIngressLoadConfig {
  const targetUrl = parseTargetUrl(readRequired(env, 'WEBHOOK_LOAD_TARGET_URL'));
  const bots = parseBots(env);
  const chatId = readRequired(env, 'WEBHOOK_LOAD_CHAT_ID');
  const senderId = readRequired(env, 'WEBHOOK_LOAD_SENDER_ID');
  const runId = readRequired(env, 'WEBHOOK_LOAD_RUN_ID');
  if (!/^[A-Za-z0-9_-]{4,80}$/u.test(runId)) {
    throw new Error(
      'WEBHOOK_LOAD_RUN_ID must use 4-80 ASCII letters, digits, underscores, or hyphens',
    );
  }

  const loadProfile = parseLoadProfile(env);
  const durationSec = readPositiveNumber(
    env,
    'WEBHOOK_LOAD_DURATION_SEC',
    loadProfile.defaultDurationSec,
    { max: 3_600 },
  );
  const maxInFlight = readPositiveNumber(env, 'WEBHOOK_LOAD_MAX_IN_FLIGHT', DEFAULT_MAX_IN_FLIGHT, {
    integer: true,
    max: 2_000,
  });
  const requestTimeoutMs = readPositiveNumber(
    env,
    'WEBHOOK_LOAD_REQUEST_TIMEOUT_MS',
    DEFAULT_REQUEST_TIMEOUT_MS,
    { integer: true, max: 30_000 },
  );
  const ackP99TargetMs = readPositiveNumber(
    env,
    'WEBHOOK_LOAD_ACK_P99_TARGET_MS',
    DEFAULT_ACK_P99_TARGET_MS,
    { integer: true, max: 30_000 },
  );
  const minThroughputRatio = readPositiveNumber(
    env,
    'WEBHOOK_LOAD_MIN_THROUGHPUT_RATIO',
    DEFAULT_MIN_THROUGHPUT_RATIO,
    { max: 1 },
  );
  const verificationTimeoutSec = readPositiveNumber(
    env,
    'WEBHOOK_LOAD_VERIFY_TIMEOUT_SEC',
    DEFAULT_VERIFY_TIMEOUT_SEC,
    { max: 600 },
  );
  const verification = parseVerification(env);
  const verificationIntervalMs = readPositiveNumber(
    env,
    'WEBHOOK_LOAD_VERIFY_INTERVAL_MS',
    verification.mode === 'metrics'
      ? DEFAULT_METRICS_VERIFY_INTERVAL_MS
      : DEFAULT_VERIFY_INTERVAL_MS,
    { integer: true, max: 30_000 },
  );
  if (verification.mode === 'metrics' && verificationIntervalMs < 15_000) {
    throw new Error('WEBHOOK_LOAD_VERIFY_INTERVAL_MS must be at least 15000 for metrics mode');
  }
  const drainVerification = parseDrainVerification(env);
  const mirrorCounts = parseMirrorCounts(env.WEBHOOK_LOAD_MIRROR_COUNTS, bots.length);
  if (maxInFlight < Math.max(...mirrorCounts)) {
    throw new Error('WEBHOOK_LOAD_MAX_IN_FLIGHT must be at least the largest mirror count');
  }

  const knownProductionTarget = isKnownProductionHost(targetUrl.hostname);
  const publicTarget = isPublicTarget(targetUrl.hostname) || knownProductionTarget;
  if (publicTarget && env.WEBHOOK_LOAD_ALLOW_PUBLIC?.trim() !== WEBHOOK_LOAD_PUBLIC_CONFIRMATION) {
    throw new Error(
      `Public target requires WEBHOOK_LOAD_ALLOW_PUBLIC=${WEBHOOK_LOAD_PUBLIC_CONFIRMATION}`,
    );
  }
  if (
    knownProductionTarget &&
    env.WEBHOOK_LOAD_ALLOW_PRODUCTION?.trim() !== WEBHOOK_LOAD_PRODUCTION_CONFIRMATION
  ) {
    throw new Error(
      `Known production target requires WEBHOOK_LOAD_ALLOW_PRODUCTION=${WEBHOOK_LOAD_PRODUCTION_CONFIRMATION}`,
    );
  }
  if (knownProductionTarget && loadProfile.profile !== 'custom') {
    throw new Error('Baseline-derived load profiles cannot target known production hosts');
  }
  if (knownProductionTarget && (loadProfile.rps > 100 || durationSec > 600)) {
    throw new Error('Known production targets are capped at 100 rps for 600 seconds');
  }

  const config: WebhookIngressLoadConfig = {
    targetUrl,
    bots,
    chatId,
    senderId,
    runId,
    durationSec,
    rps: loadProfile.rps,
    profile: loadProfile.profile,
    baselineRps: loadProfile.baselineRps,
    maxInFlight,
    requestTimeoutMs,
    ackP99TargetMs,
    minThroughputRatio,
    mirrorCounts,
    execute: env.WEBHOOK_LOAD_EXECUTE?.trim() === WEBHOOK_LOAD_EXECUTE_CONFIRMATION,
    publicTarget,
    knownProductionTarget,
    verification,
    verificationTimeoutSec,
    verificationIntervalMs,
    drainVerification,
  };
  buildWebhookLoadPlan(config);
  return config;
}

export function buildWebhookLoadPlan(config: WebhookIngressLoadConfig): WebhookLoadPhasePlan[] {
  const durationMs = (config.durationSec * 1_000) / config.mirrorCounts.length;
  return config.mirrorCounts.map((mirrorCount) => {
    const semanticEvents = Math.floor((durationMs * config.rps) / (1_000 * mirrorCount));
    if (semanticEvents < 1) {
      throw new Error(`Load-test phase with ${mirrorCount} bots would contain no semantic events`);
    }
    return {
      mirrorCount,
      durationMs,
      semanticEvents,
      requests: semanticEvents * mirrorCount,
    };
  });
}

export function buildSyntheticWebhookPayload(input: {
  runId: string;
  chatId: string;
  senderId: string;
  sequence: number;
  mirrorCount: number;
  phaseIndex: number;
  timestampMs: number;
}): SyntheticWebhookPayload {
  const sequence = String(input.sequence).padStart(8, '0');
  const timestamp = new Date(input.timestampMs).toISOString();
  const eventId = `ingress-load:${input.runId}:${sequence}`;
  return {
    update_type: 'message_created',
    update_id: eventId,
    timestamp,
    message: {
      body: {
        mid: eventId,
        text: `[webhook-ingress-load-test:${input.runId}:${sequence}]`,
      },
      recipient: {
        chat_id: input.chatId,
        chat_type: 'chat',
      },
      sender: {
        user_id: input.senderId,
        first_name: 'Ingress',
        last_name: 'LoadTest',
      },
      timestamp,
    },
    synthetic_load_test: {
      run_id: input.runId,
      sequence: input.sequence,
      mirror_count: input.mirrorCount,
      phase_index: input.phaseIndex,
    },
  };
}

export function percentile(values: readonly number[], ratio: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return sorted[index] ?? 0;
}

export function summarizeRequestStats(stats: MutableRequestStats): RequestStatsSummary {
  const errors = stats.total - stats.ok;
  const averageMs =
    stats.latenciesMs.length > 0
      ? stats.latenciesMs.reduce((sum, latency) => sum + latency, 0) / stats.latenciesMs.length
      : 0;
  return {
    total: stats.total,
    ok: stats.ok,
    errors,
    errorRate: stats.total > 0 ? Number((errors / stats.total).toFixed(6)) : 0,
    averageMs: Number(averageMs.toFixed(2)),
    p50Ms: percentile(stats.latenciesMs, 0.5),
    p95Ms: percentile(stats.latenciesMs, 0.95),
    p99Ms: percentile(stats.latenciesMs, 0.99),
    statusCounts: Object.fromEntries(
      [...stats.statusCounts.entries()]
        .sort(([left], [right]) => left - right)
        .map(([status, count]) => [String(status), count]),
    ),
    transportErrors: Object.fromEntries(
      [...stats.transportErrors.entries()].sort(([left], [right]) => left.localeCompare(right)),
    ),
  };
}

export function evaluatePhaseThroughput(input: {
  attemptedRequests: number;
  configuredRps: number;
  configuredDurationMs: number;
  elapsedMs: number;
  minimumThroughputRatio: number;
  deadlineExceeded: boolean;
}): { achievedRps: number; throughputRatio: number; throughputPassed: boolean } {
  const measurementWindowMs = Math.max(1, input.configuredDurationMs, input.elapsedMs);
  const achievedRps = (input.attemptedRequests * 1_000) / measurementWindowMs;
  const throughputRatio = input.configuredRps > 0 ? achievedRps / input.configuredRps : 0;
  return {
    achievedRps: Number(achievedRps.toFixed(2)),
    throughputRatio: Number(throughputRatio.toFixed(6)),
    throughputPassed: !input.deadlineExceeded && throughputRatio >= input.minimumThroughputRatio,
  };
}

export function extractVerificationCounts(payload: unknown): VerificationCounts {
  const roots = [payload, readRecord(payload)?.data].filter(
    (value): value is unknown => value !== undefined,
  );
  const paths = [
    ['canonicalExecution'],
    ['webhookSlo', 'canonicalExecution'],
    ['slo', 'canonicalExecution'],
    ['snapshot', 'canonicalExecution'],
  ];
  for (const root of roots) {
    for (const path of paths) {
      let node: unknown = root;
      for (const segment of path) {
        node = readRecord(node)?.[segment];
      }
      const record = readRecord(node);
      if (
        record &&
        typeof record.receipts === 'number' &&
        Number.isFinite(record.receipts) &&
        typeof record.executionClaims === 'number' &&
        Number.isFinite(record.executionClaims)
      ) {
        return {
          receipts: Math.trunc(record.receipts),
          executionClaims: Math.trunc(record.executionClaims),
        };
      }
    }
  }
  throw new Error('Metrics response does not contain canonical receipt and claim counts');
}

export function extractQueueDrainMetrics(payload: unknown): QueueDrainMetrics {
  const roots = [payload, readRecord(payload)?.data].filter(
    (value): value is unknown => value !== undefined,
  );
  const paths = [[], ['queues'], ['queueMetrics'], ['snapshot', 'queues']] as const;
  for (const root of roots) {
    for (const path of paths) {
      let node: unknown = root;
      for (const segment of path) {
        node = readRecord(node)?.[segment];
      }
      const queues = readRecord(node);
      const webhookDefaultShards = readRecord(queues?.webhookDefaultShards);
      const actionPending = readPendingQueueCounters(queues?.actions);
      const queueLagSec = queues?.effectiveLagSec;
      const shardPending = webhookDefaultShards
        ? Object.values(webhookDefaultShards).map(readPendingQueueCounters)
        : [];
      if (
        typeof queueLagSec === 'number' &&
        Number.isFinite(queueLagSec) &&
        queueLagSec >= 0 &&
        shardPending.length > 0 &&
        shardPending.every((value) => value !== null) &&
        actionPending !== null
      ) {
        const webhookDefaultPending = shardPending.reduce<number>(
          (sum, value) => sum + (value ?? 0),
          0,
        );
        if (Number.isSafeInteger(webhookDefaultPending)) {
          return { queueLagSec, webhookDefaultPending, actionPending };
        }
      }
    }
  }
  throw new Error('Operational metrics response does not contain queue lag and pending counters');
}

function readPendingQueueCounters(value: unknown): number | null {
  const counters = readRecord(value);
  if (!counters) {
    return null;
  }
  const values = ['waiting', 'prioritized', 'active', 'delayed'].map((field) => counters[field]);
  if (
    values.some((count) => typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0)
  ) {
    return null;
  }
  const pending = values.reduce<number>((sum, count) => sum + (count as number), 0);
  return Number.isSafeInteger(pending) ? pending : null;
}

export function evaluateQueueDrainHealth(input: {
  sample: QueueDrainMetrics;
  baseline: QueueDrainMetrics;
  queueLagTargetSec: number;
}): QueueDrainHealth {
  const queueLagHealthy = input.sample.queueLagSec <= input.queueLagTargetSec;
  const webhookDefaultPressureHealthy =
    input.sample.webhookDefaultPending <= input.baseline.webhookDefaultPending;
  const actionPressureHealthy = input.sample.actionPending <= input.baseline.actionPending;
  return {
    healthy: queueLagHealthy && webhookDefaultPressureHealthy && actionPressureHealthy,
    queueLagHealthy,
    webhookDefaultPressureHealthy,
    actionPressureHealthy,
  };
}

export async function waitForQueueDrain(input: {
  baseline: QueueDrainMetrics;
  queueLagTargetSec: number;
  requiredHealthySamples: number;
  timeoutMs: number;
  intervalMs: number;
  readSnapshot: (remainingMs: number) => Promise<QueueDrainMetrics>;
  now?: () => number;
  wait?: (durationMs: number) => Promise<unknown>;
}): Promise<QueueDrainVerificationResult> {
  const now = input.now ?? Date.now;
  const wait = input.wait ?? delay;
  const startedAtMs = now();
  const deadlineMs = startedAtMs + input.timeoutMs;
  let samples = 0;
  let consecutiveHealthySamples = 0;
  let consecutiveHealthySinceMs: number | null = null;
  let consecutiveHealthyForMs = 0;
  let lastSample: QueueDrainMetrics | null = null;
  let lastHealth: QueueDrainHealth | null = null;
  const buildResult = (verified: boolean, timedOut: boolean): QueueDrainVerificationResult => ({
    verified,
    timedOut,
    samples,
    consecutiveHealthySamples,
    requiredHealthySamples: input.requiredHealthySamples,
    queueLagTargetSec: input.queueLagTargetSec,
    baseline: {
      webhookDefaultPending: input.baseline.webhookDefaultPending,
      actionPending: input.baseline.actionPending,
    },
    consecutiveHealthyForSec: Number((consecutiveHealthyForMs / 1_000).toFixed(3)),
    lastSample,
    lastHealth,
  });

  while (true) {
    const remainingMs = deadlineMs - now();
    if (remainingMs <= 0) {
      return buildResult(false, true);
    }

    lastSample = await input.readSnapshot(remainingMs);
    samples += 1;
    lastHealth = evaluateQueueDrainHealth({
      sample: lastSample,
      baseline: input.baseline,
      queueLagTargetSec: input.queueLagTargetSec,
    });
    const sampledAtMs = now();
    if (sampledAtMs > deadlineMs) {
      return buildResult(false, true);
    }

    if (lastHealth.healthy) {
      if (consecutiveHealthySinceMs === null) {
        consecutiveHealthySinceMs = sampledAtMs;
      }
      consecutiveHealthySamples += 1;
      consecutiveHealthyForMs = sampledAtMs - consecutiveHealthySinceMs;
    } else {
      consecutiveHealthySamples = 0;
      consecutiveHealthySinceMs = null;
      consecutiveHealthyForMs = 0;
    }
    if (
      consecutiveHealthySamples >= input.requiredHealthySamples &&
      consecutiveHealthyForMs >= input.queueLagTargetSec * 1_000
    ) {
      return buildResult(true, false);
    }

    const waitMs = Math.min(input.intervalMs, Math.max(0, deadlineMs - now()));
    if (waitMs <= 0) {
      continue;
    }
    await wait(waitMs);
  }
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function createMutableStats(): MutableRequestStats {
  return {
    total: 0,
    ok: 0,
    latenciesMs: [],
    statusCounts: new Map(),
    transportErrors: new Map(),
  };
}

function mergeStats(target: MutableRequestStats, source: MutableRequestStats): void {
  target.total += source.total;
  target.ok += source.ok;
  target.latenciesMs.push(...source.latenciesMs);
  for (const [status, count] of source.statusCounts) {
    target.statusCounts.set(status, (target.statusCounts.get(status) ?? 0) + count);
  }
  for (const [error, count] of source.transportErrors) {
    target.transportErrors.set(error, (target.transportErrors.get(error) ?? 0) + count);
  }
}

function buildWebhookUrl(targetUrl: URL, bot: WebhookLoadBot): string {
  const url = new URL(targetUrl.toString());
  url.pathname = `${targetUrl.pathname}/${encodeURIComponent(bot.botId)}/${encodeURIComponent(bot.secretPath)}`;
  return url.toString();
}

function classifyTransportError(error: unknown): string {
  const row = error as { name?: unknown; code?: unknown; cause?: { code?: unknown } };
  const code = String(row.cause?.code ?? row.code ?? '').toUpperCase();
  const allowedCodes = new Set([
    'ECONNREFUSED',
    'ECONNRESET',
    'ENOTFOUND',
    'EAI_AGAIN',
    'ETIMEDOUT',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_HEADERS_TIMEOUT',
  ]);
  if (allowedCodes.has(code)) {
    return code;
  }
  const name = typeof row.name === 'string' ? row.name : '';
  if (name === 'TimeoutError' || name === 'AbortError') {
    return 'TIMEOUT';
  }
  return 'FETCH_ERROR';
}

async function sendWebhook(input: {
  url: string;
  headerSecret: string;
  payload: SyntheticWebhookPayload;
  timeoutMs: number;
  stats: MutableRequestStats;
  phaseSignal: AbortSignal;
}): Promise<void> {
  const startedAt = performance.now();
  try {
    const response = await fetch(input.url, {
      method: 'POST',
      redirect: 'error',
      headers: {
        'content-type': 'application/json',
        'x-max-bot-api-secret': input.headerSecret,
      },
      body: JSON.stringify(input.payload),
      signal: AbortSignal.any([AbortSignal.timeout(input.timeoutMs), input.phaseSignal]),
    });
    await response.arrayBuffer();
    const latencyMs = Math.max(0, Math.round(performance.now() - startedAt));
    input.stats.total += 1;
    input.stats.latenciesMs.push(latencyMs);
    input.stats.statusCounts.set(
      response.status,
      (input.stats.statusCounts.get(response.status) ?? 0) + 1,
    );
    if (response.status >= 200 && response.status < 300) {
      input.stats.ok += 1;
    }
  } catch (error: unknown) {
    const latencyMs = Math.max(0, Math.round(performance.now() - startedAt));
    const category = input.phaseSignal.aborted ? 'PHASE_DEADLINE' : classifyTransportError(error);
    input.stats.total += 1;
    input.stats.latenciesMs.push(latencyMs);
    input.stats.transportErrors.set(category, (input.stats.transportErrors.get(category) ?? 0) + 1);
  }
}

export class RequestGate {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async acquire(count: number, signal?: AbortSignal): Promise<(() => void) | null> {
    while (this.active + count > this.limit) {
      if (signal?.aborted) {
        return null;
      }
      await new Promise<void>((resolve) => {
        const wake = () => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        };
        const onAbort = () => {
          const index = this.waiters.indexOf(wake);
          if (index >= 0) {
            this.waiters.splice(index, 1);
          }
          resolve();
        };
        this.waiters.push(wake);
        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted) {
          onAbort();
        }
      });
    }
    if (signal?.aborted) {
      return null;
    }
    this.active += count;
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      this.active -= count;
      this.waiters.splice(0).forEach((resolve) => resolve());
    };
  }
}

export async function runPhase(input: {
  config: WebhookIngressLoadConfig;
  plan: WebhookLoadPhasePlan;
  phaseIndex: number;
  firstSequence: number;
  timestampBaseMs: number;
  gate: RequestGate;
  attemptedDedupKeys: Set<string>;
  attemptedSemanticKeys: Set<string>;
}): Promise<{ result: PhaseRunResult; stats: MutableRequestStats }> {
  const stats = createMutableStats();
  const eventIntervalMs = (1_000 * input.plan.mirrorCount) / input.config.rps;
  const selectedBots = input.config.bots.slice(0, input.plan.mirrorCount);
  const phaseStartedAt = performance.now();
  const schedulingAbortController = new AbortController();
  const phaseAbortController = new AbortController();
  const schedulingDeadlineTimer = setTimeout(
    () => schedulingAbortController.abort(),
    Math.max(1, input.plan.durationMs),
  );
  const settlementGraceMs = Math.min(input.config.requestTimeoutMs, input.config.ackP99TargetMs);
  const phaseDeadlineTimer = setTimeout(
    () => phaseAbortController.abort(),
    Math.max(1, input.plan.durationMs + settlementGraceMs),
  );
  const pending = new Set<Promise<void>>();
  let attemptedSemanticEvents = 0;

  try {
    for (let eventIndex = 0; eventIndex < input.plan.semanticEvents; eventIndex += 1) {
      if (schedulingAbortController.signal.aborted) {
        break;
      }
      const scheduledAt = phaseStartedAt + eventIndex * eventIntervalMs;
      const waitMs = scheduledAt - performance.now();
      if (waitMs > 0) {
        try {
          await delay(waitMs, undefined, { signal: schedulingAbortController.signal });
        } catch (error: unknown) {
          if (schedulingAbortController.signal.aborted) {
            break;
          }
          throw error;
        }
      }
      const release = await input.gate.acquire(
        selectedBots.length,
        schedulingAbortController.signal,
      );
      if (!release) {
        break;
      }
      if (schedulingAbortController.signal.aborted) {
        release();
        break;
      }
      const sequence = input.firstSequence + eventIndex;
      const payload = buildSyntheticWebhookPayload({
        runId: input.config.runId,
        chatId: input.config.chatId,
        senderId: input.config.senderId,
        sequence,
        mirrorCount: input.plan.mirrorCount,
        phaseIndex: input.phaseIndex,
        timestampMs: input.timestampBaseMs + sequence,
      });
      attemptedSemanticEvents += 1;
      input.attemptedSemanticKeys.add(payload.update_id);
      for (const bot of selectedBots) {
        input.attemptedDedupKeys.add(`${bot.botId}:${payload.update_id}`);
      }
      const task = Promise.all(
        selectedBots.map((bot) =>
          sendWebhook({
            url: buildWebhookUrl(input.config.targetUrl, bot),
            headerSecret: bot.headerSecret,
            payload,
            timeoutMs: input.config.requestTimeoutMs,
            stats,
            phaseSignal: phaseAbortController.signal,
          }),
        ),
      )
        .then(() => undefined)
        .finally(() => {
          release();
          pending.delete(task);
        });
      pending.add(task);
    }

    await Promise.all(pending);
  } finally {
    clearTimeout(schedulingDeadlineTimer);
    clearTimeout(phaseDeadlineTimer);
  }

  const elapsedMs = Math.max(1, performance.now() - phaseStartedAt);
  const deadlineExceeded =
    attemptedSemanticEvents < input.plan.semanticEvents || phaseAbortController.signal.aborted;
  const throughput = evaluatePhaseThroughput({
    attemptedRequests: stats.total,
    configuredRps: input.config.rps,
    configuredDurationMs: input.plan.durationMs,
    elapsedMs,
    minimumThroughputRatio: input.config.minThroughputRatio,
    deadlineExceeded,
  });
  return {
    stats,
    result: {
      mirrorCount: input.plan.mirrorCount,
      configuredDurationSec: Number((input.plan.durationMs / 1_000).toFixed(3)),
      configuredRps: input.config.rps,
      semanticEvents: input.plan.semanticEvents,
      attemptedSemanticEvents,
      plannedRequests: input.plan.requests,
      attemptedRequests: stats.total,
      elapsedMs: Math.round(elapsedMs),
      ...throughput,
      minimumThroughputRatio: input.config.minThroughputRatio,
      deadlineExceeded,
      ack: summarizeRequestStats(stats),
    },
  };
}

export async function readMetricsPayload(
  config: MetricsVerification,
  timeoutMs = 10_000,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(config.metricsUrl, {
      method: 'GET',
      redirect: 'error',
      headers: config.authorization ? { authorization: config.authorization } : undefined,
      signal: AbortSignal.timeout(Math.max(1, Math.min(10_000, Math.ceil(timeoutMs)))),
    });
  } catch {
    throw new Error('Metrics verification request failed');
  }
  if (!response.ok) {
    await response.arrayBuffer();
    throw new Error(`Metrics verification returned HTTP ${response.status}`);
  }
  return response.json();
}

async function readVerificationCounts(
  config: MetricsVerification,
  timeoutMs?: number,
): Promise<VerificationCounts> {
  return extractVerificationCounts(await readMetricsPayload(config, timeoutMs));
}

async function readQueueDrainSnapshot(
  config: MetricsVerification,
  timeoutMs?: number,
): Promise<QueueDrainMetrics> {
  return extractQueueDrainMetrics(await readMetricsPayload(config, timeoutMs));
}

export async function verifyViaMetrics(input: {
  config: WebhookIngressLoadConfig;
  baseline: VerificationCounts;
  expectedReceipts: number;
  expectedExecutionClaims: number;
}): Promise<VerificationResult> {
  if (input.config.verification.mode !== 'metrics') {
    throw new Error('Metrics verification is not configured');
  }
  const deadline = Date.now() + input.config.verificationTimeoutSec * 1_000;
  let counts: VerificationCounts = { receipts: 0, executionClaims: 0 };
  let verified = false;
  do {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      break;
    }
    const current = await readVerificationCounts(input.config.verification, remainingMs);
    counts = {
      receipts: Math.max(0, current.receipts - input.baseline.receipts),
      executionClaims: Math.max(0, current.executionClaims - input.baseline.executionClaims),
    };
    if (Date.now() > deadline) {
      break;
    }
    if (
      counts.receipts >= input.expectedReceipts &&
      counts.executionClaims >= input.expectedExecutionClaims
    ) {
      verified = true;
      break;
    }
    const waitMs = Math.min(
      input.config.verificationIntervalMs,
      Math.max(0, deadline - Date.now()),
    );
    if (waitMs > 0) {
      await delay(waitMs);
    }
  } while (Date.now() < deadline);

  return {
    mode: 'metrics',
    ...counts,
    expectedReceipts: input.expectedReceipts,
    expectedExecutionClaims: input.expectedExecutionClaims,
    exact: false,
    verified,
  };
}

async function verifyQueueDrainViaMetrics(input: {
  config: WebhookIngressLoadConfig;
  baseline: QueueDrainMetrics;
}): Promise<QueueDrainVerificationResult> {
  const metricsVerification = input.config.drainVerification.metrics;
  if (!metricsVerification) {
    throw new Error('Queue drain verification metrics are not configured');
  }
  return waitForQueueDrain({
    baseline: input.baseline,
    queueLagTargetSec: input.config.drainVerification.queueLagTargetSec,
    requiredHealthySamples: input.config.drainVerification.healthySamples,
    timeoutMs: input.config.drainVerification.timeoutSec * 1_000,
    intervalMs: input.config.drainVerification.intervalMs,
    readSnapshot: (remainingMs) => readQueueDrainSnapshot(metricsVerification, remainingMs),
  });
}

export async function verifyViaDatabase(
  input: {
    config: WebhookIngressLoadConfig;
    attemptedDedupKeys: string[];
    expectedExecutionClaims: number;
  },
  runtime: {
    client?: Client;
    now?: () => number;
    wait?: (durationMs: number) => Promise<unknown>;
  } = {},
): Promise<VerificationResult> {
  if (input.config.verification.mode !== 'database') {
    throw new Error('Database verification is not configured');
  }
  const now = runtime.now ?? Date.now;
  const wait = runtime.wait ?? delay;
  const timeoutMs = Math.max(1, Math.ceil(input.config.verificationTimeoutSec * 1_000));
  const deadline = now() + timeoutMs;
  const client =
    runtime.client ??
    new Client({
      connectionString: input.config.verification.databaseUrl,
      application_name: 'maxim_webhook_ingress_load_verifier',
      connectionTimeoutMillis: Math.min(10_000, timeoutMs),
      statement_timeout: Math.min(30_000, timeoutMs),
      query_timeout: Math.min(30_000, timeoutMs),
    });
  const remainingBudgetMs = () => Math.max(0, Math.ceil(deadline - now()));
  let counts: VerificationCounts = { receipts: 0, executionClaims: 0 };
  let verified = false;
  let transactionStarted = false;
  try {
    await client.connect();
    let operationBudgetMs = remainingBudgetMs();
    if (operationBudgetMs > 0) {
      await client.query(
        withPgQueryTimeout({ text: 'BEGIN TRANSACTION READ ONLY' }, operationBudgetMs),
      );
      transactionStarted = true;
    }
    while (transactionStarted && remainingBudgetMs() > 0) {
      operationBudgetMs = remainingBudgetMs();
      await client.query(
        withPgQueryTimeout(
          {
            text: "SELECT set_config('statement_timeout', $1, true)",
            values: [`${operationBudgetMs}ms`],
          },
          operationBudgetMs,
        ),
      );
      operationBudgetMs = remainingBudgetMs();
      if (operationBudgetMs <= 0) {
        break;
      }
      const result = await client.query<{ receipts: number; execution_claims: number }>(
        withPgQueryTimeout(
          {
            text: `WITH run_receipts AS (
           SELECT id
           FROM webhook_events
           WHERE dedup_key = ANY($1::text[])
         )
         SELECT
           COUNT(DISTINCT run_receipts.id)::integer AS receipts,
           COUNT(DISTINCT claims.id)::integer AS execution_claims
         FROM run_receipts
         LEFT JOIN webhook_execution_claims AS claims
           ON claims.webhook_event_id = run_receipts.id
          AND claims.kind = 'EXECUTION'`,
            values: [input.attemptedDedupKeys],
          },
          operationBudgetMs,
        ),
      );
      const row = result.rows[0];
      counts = {
        receipts: Number(row?.receipts ?? 0),
        executionClaims: Number(row?.execution_claims ?? 0),
      };
      if (now() > deadline) {
        break;
      }
      if (
        counts.receipts === input.attemptedDedupKeys.length &&
        counts.executionClaims === input.expectedExecutionClaims
      ) {
        verified = true;
        break;
      }
      const waitMs = Math.min(input.config.verificationIntervalMs, remainingBudgetMs());
      if (waitMs > 0) {
        await wait(waitMs);
      }
    }
    if (transactionStarted) {
      await client.query(
        withPgQueryTimeout(
          { text: 'ROLLBACK' },
          Math.max(1, Math.min(1_000, remainingBudgetMs() || 1_000)),
        ),
      );
    }
    return {
      mode: 'database',
      ...counts,
      expectedReceipts: input.attemptedDedupKeys.length,
      expectedExecutionClaims: input.expectedExecutionClaims,
      exact: true,
      verified,
    };
  } catch {
    throw new Error('Read-only database verification failed');
  } finally {
    await client.end().catch(() => undefined);
  }
}

export function evaluateWebhookLoadAcceptance(input: {
  ack: Pick<RequestStatsSummary, 'errors' | 'p99Ms'>;
  ackP99TargetMs: number;
  phases: ReadonlyArray<Pick<PhaseRunResult, 'throughputPassed'>>;
  verification: { verified: boolean } | null;
  drainVerification: { verified: boolean } | null;
}): WebhookLoadAcceptance {
  const ackPassed = input.ack.errors === 0 && input.ack.p99Ms < input.ackP99TargetMs;
  const throughputPassed =
    input.phases.length > 0 && input.phases.every((phase) => phase.throughputPassed);
  const receiptAndClaimVerificationPassed = input.verification?.verified ?? null;
  const endToEndDrainPassed = input.drainVerification?.verified ?? null;
  return {
    passed:
      ackPassed &&
      throughputPassed &&
      (receiptAndClaimVerificationPassed ?? true) &&
      (endToEndDrainPassed ?? true),
    ackPassed,
    throughputPassed,
    receiptAndClaimVerificationPassed,
    endToEndDrainPassed,
  };
}

function fingerprint(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

export function renderSafeConfig(config: WebhookIngressLoadConfig): Record<string, unknown> {
  const plan = buildWebhookLoadPlan(config);
  return {
    execute: config.execute,
    target: `${config.targetUrl.origin}${config.targetUrl.pathname}`,
    publicTarget: config.publicTarget,
    knownProductionTarget: config.knownProductionTarget,
    botCount: config.bots.length,
    chatFingerprint: fingerprint(config.chatId),
    senderFingerprint: fingerprint(config.senderId),
    runId: config.runId,
    profile: config.profile,
    baselineRps: config.baselineRps,
    durationSec: config.durationSec,
    aggregateReceiptRps: config.rps,
    maxInFlight: config.maxInFlight,
    requestTimeoutMs: config.requestTimeoutMs,
    ackP99TargetMs: config.ackP99TargetMs,
    minimumThroughputRatio: config.minThroughputRatio,
    mirrorCounts: config.mirrorCounts,
    plannedReceipts: plan.reduce((sum, phase) => sum + phase.requests, 0),
    plannedSemanticEvents: plan.reduce((sum, phase) => sum + phase.semanticEvents, 0),
    verification: config.verification.mode,
    drainVerification: {
      enabled: config.drainVerification.enabled,
      queueLagTargetSec: config.drainVerification.queueLagTargetSec,
      healthySamples: config.drainVerification.healthySamples,
      timeoutSec: config.drainVerification.timeoutSec,
      intervalMs: config.drainVerification.intervalMs,
    },
  };
}

async function run(): Promise<void> {
  const config = loadWebhookIngressLoadConfig(process.env);
  process.stdout.write(`${JSON.stringify({ config: renderSafeConfig(config) }, null, 2)}\n`);
  if (!config.execute) {
    process.stdout.write(
      `Dry run only. Set WEBHOOK_LOAD_EXECUTE=${WEBHOOK_LOAD_EXECUTE_CONFIRMATION} to send traffic.\n`,
    );
    return;
  }

  const [metricsBaseline, drainBaseline] = await Promise.all([
    config.verification.mode === 'metrics'
      ? readVerificationCounts(config.verification)
      : Promise.resolve(null),
    config.drainVerification.metrics
      ? readQueueDrainSnapshot(config.drainVerification.metrics)
      : Promise.resolve(null),
  ]);
  const plan = buildWebhookLoadPlan(config);
  const gate = new RequestGate(config.maxInFlight);
  const aggregateStats = createMutableStats();
  const attemptedDedupKeys = new Set<string>();
  const attemptedSemanticKeys = new Set<string>();
  const phases: PhaseRunResult[] = [];
  const timestampBaseMs = Date.now();
  const startedAt = performance.now();
  let firstSequence = 0;

  for (let phaseIndex = 0; phaseIndex < plan.length; phaseIndex += 1) {
    const phasePlan = plan[phaseIndex]!;
    const phase = await runPhase({
      config,
      plan: phasePlan,
      phaseIndex,
      firstSequence,
      timestampBaseMs,
      gate,
      attemptedDedupKeys,
      attemptedSemanticKeys,
    });
    firstSequence += phasePlan.semanticEvents;
    mergeStats(aggregateStats, phase.stats);
    phases.push(phase.result);
  }

  const elapsedMs = Math.max(1, performance.now() - startedAt);
  const ack = summarizeRequestStats(aggregateStats);
  let verification: VerificationResult | null = null;
  if (config.verification.mode === 'database') {
    verification = await verifyViaDatabase({
      config,
      attemptedDedupKeys: [...attemptedDedupKeys],
      expectedExecutionClaims: attemptedSemanticKeys.size,
    });
  } else if (config.verification.mode === 'metrics' && metricsBaseline) {
    verification = await verifyViaMetrics({
      config,
      baseline: metricsBaseline,
      expectedReceipts: attemptedDedupKeys.size,
      expectedExecutionClaims: attemptedSemanticKeys.size,
    });
  }

  let drainVerification: QueueDrainVerificationResult | null = null;
  if (config.drainVerification.enabled) {
    if (!drainBaseline) {
      throw new Error('Queue drain verification metrics baseline is unavailable');
    }
    drainVerification = await verifyQueueDrainViaMetrics({
      config,
      baseline: drainBaseline,
    });
  }

  const acceptance = evaluateWebhookLoadAcceptance({
    ack,
    ackP99TargetMs: config.ackP99TargetMs,
    phases,
    verification,
    drainVerification,
  });
  const result = {
    runId: config.runId,
    passed: acceptance.passed,
    ackPassed: acceptance.ackPassed,
    throughputPassed: acceptance.throughputPassed,
    receiptAndClaimVerificationPassed: acceptance.receiptAndClaimVerificationPassed,
    endToEndDrainPassed: acceptance.endToEndDrainPassed,
    elapsedMs: Math.round(elapsedMs),
    achievedReceiptRps: Number(((aggregateStats.total * 1_000) / elapsedMs).toFixed(2)),
    attemptedReceipts: attemptedDedupKeys.size,
    semanticEvents: attemptedSemanticKeys.size,
    ack,
    phases,
    verification,
    drainVerification,
  };
  process.stdout.write(`${JSON.stringify({ result }, null, 2)}\n`);
  if (!acceptance.passed) {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  void run().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'Webhook ingress load test failed';
    process.stderr.write(
      `${message.replace(/postgres(?:ql)?:\/\/[^\s]+/giu, '[redacted-database-url]')}\n`,
    );
    process.exitCode = 1;
  });
}
