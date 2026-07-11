import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from 'pg';

export const WEBHOOK_LOAD_EXECUTE_CONFIRMATION = 'I_UNDERSTAND_THIS_SENDS_WEBHOOK_TRAFFIC';
export const WEBHOOK_LOAD_PUBLIC_CONFIRMATION = 'I_UNDERSTAND_THIS_SENDS_NETWORK_TRAFFIC';
export const WEBHOOK_LOAD_PRODUCTION_CONFIRMATION = 'I_UNDERSTAND_THIS_TARGETS_PRODUCTION';

const ALLOWED_MIRROR_COUNTS = [1, 2, 3, 6] as const;
const DEFAULT_DURATION_SEC = 600;
const DEFAULT_RPS = 100;
const DEFAULT_MAX_IN_FLIGHT = 256;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_ACK_P99_TARGET_MS = 2_000;
const DEFAULT_VERIFY_TIMEOUT_SEC = 60;
const DEFAULT_VERIFY_INTERVAL_MS = 1_000;
const MAX_BOTS = 6;

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

type MetricsVerification = {
  mode: 'metrics';
  metricsUrl: string;
  authorization: string | null;
};

export type WebhookLoadVerificationConfig =
  | DatabaseVerification
  | MetricsVerification
  | { mode: 'none' };

export type WebhookIngressLoadConfig = {
  targetUrl: URL;
  bots: WebhookLoadBot[];
  chatId: string;
  senderId: string;
  runId: string;
  durationSec: number;
  rps: number;
  maxInFlight: number;
  requestTimeoutMs: number;
  ackP99TargetMs: number;
  mirrorCounts: number[];
  execute: boolean;
  publicTarget: boolean;
  knownProductionTarget: boolean;
  verification: WebhookLoadVerificationConfig;
  verificationTimeoutSec: number;
  verificationIntervalMs: number;
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

type VerificationResult = VerificationCounts & {
  mode: 'database' | 'metrics';
  expectedReceipts: number;
  expectedExecutionClaims: number;
  exact: boolean;
  verified: boolean;
};

type PhaseRunResult = {
  mirrorCount: number;
  configuredDurationSec: number;
  configuredRps: number;
  semanticEvents: number;
  attemptedRequests: number;
  elapsedMs: number;
  achievedRps: number;
  ack: RequestStatsSummary;
};

type MetricsBaseline = VerificationCounts;

function readRequired(env: Environment, key: string): string {
  const value = env[key]?.trim();
  if (!value) {
    throw new Error(`${key} is required`);
  }
  return value;
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
  const normalized = hostname.toLowerCase();
  for (const productionHost of KNOWN_PRODUCTION_HOSTS) {
    if (normalized === productionHost || normalized.endsWith(`.${productionHost}`)) {
      return true;
    }
  }
  return false;
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
  const normalized = hostname.toLowerCase();
  if (
    normalized === 'localhost' ||
    normalized === '::1' ||
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

  const durationSec = readPositiveNumber(env, 'WEBHOOK_LOAD_DURATION_SEC', DEFAULT_DURATION_SEC, {
    max: 3_600,
  });
  const rps = readPositiveNumber(env, 'WEBHOOK_LOAD_RPS', DEFAULT_RPS, { max: 1_000 });
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
  const verificationTimeoutSec = readPositiveNumber(
    env,
    'WEBHOOK_LOAD_VERIFY_TIMEOUT_SEC',
    DEFAULT_VERIFY_TIMEOUT_SEC,
    { max: 600 },
  );
  const verificationIntervalMs = readPositiveNumber(
    env,
    'WEBHOOK_LOAD_VERIFY_INTERVAL_MS',
    DEFAULT_VERIFY_INTERVAL_MS,
    { integer: true, max: 30_000 },
  );
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
  if (knownProductionTarget && (rps > 100 || durationSec > 600)) {
    throw new Error('Known production targets are capped at 100 rps for 600 seconds');
  }

  const config: WebhookIngressLoadConfig = {
    targetUrl,
    bots,
    chatId,
    senderId,
    runId,
    durationSec,
    rps,
    maxInFlight,
    requestTimeoutMs,
    ackP99TargetMs,
    mirrorCounts,
    execute: env.WEBHOOK_LOAD_EXECUTE?.trim() === WEBHOOK_LOAD_EXECUTE_CONFIRMATION,
    publicTarget,
    knownProductionTarget,
    verification: parseVerification(env),
    verificationTimeoutSec,
    verificationIntervalMs,
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
}): Promise<void> {
  const startedAt = performance.now();
  try {
    const response = await fetch(input.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-max-bot-api-secret': input.headerSecret,
      },
      body: JSON.stringify(input.payload),
      signal: AbortSignal.timeout(input.timeoutMs),
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
    const category = classifyTransportError(error);
    input.stats.total += 1;
    input.stats.latenciesMs.push(latencyMs);
    input.stats.transportErrors.set(category, (input.stats.transportErrors.get(category) ?? 0) + 1);
  }
}

class RequestGate {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async acquire(count: number): Promise<() => void> {
    while (this.active + count > this.limit) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
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

async function runPhase(input: {
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
  const pending = new Set<Promise<void>>();

  for (let eventIndex = 0; eventIndex < input.plan.semanticEvents; eventIndex += 1) {
    const scheduledAt = phaseStartedAt + eventIndex * eventIntervalMs;
    const waitMs = scheduledAt - performance.now();
    if (waitMs > 0) {
      await delay(waitMs);
    }
    const release = await input.gate.acquire(selectedBots.length);
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
  const elapsedMs = Math.max(1, performance.now() - phaseStartedAt);
  return {
    stats,
    result: {
      mirrorCount: input.plan.mirrorCount,
      configuredDurationSec: Number((input.plan.durationMs / 1_000).toFixed(3)),
      configuredRps: input.config.rps,
      semanticEvents: input.plan.semanticEvents,
      attemptedRequests: stats.total,
      elapsedMs: Math.round(elapsedMs),
      achievedRps: Number(((stats.total * 1_000) / elapsedMs).toFixed(2)),
      ack: summarizeRequestStats(stats),
    },
  };
}

async function readMetricsSnapshot(config: MetricsVerification): Promise<VerificationCounts> {
  let response: Response;
  try {
    response = await fetch(config.metricsUrl, {
      method: 'GET',
      headers: config.authorization ? { authorization: config.authorization } : undefined,
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new Error('Metrics verification request failed');
  }
  if (!response.ok) {
    await response.arrayBuffer();
    throw new Error(`Metrics verification returned HTTP ${response.status}`);
  }
  return extractVerificationCounts(await response.json());
}

async function verifyViaMetrics(input: {
  config: WebhookIngressLoadConfig;
  baseline: MetricsBaseline;
  expectedReceipts: number;
  expectedExecutionClaims: number;
}): Promise<VerificationResult> {
  if (input.config.verification.mode !== 'metrics') {
    throw new Error('Metrics verification is not configured');
  }
  const deadline = Date.now() + input.config.verificationTimeoutSec * 1_000;
  let counts: VerificationCounts = { receipts: 0, executionClaims: 0 };
  do {
    const current = await readMetricsSnapshot(input.config.verification);
    counts = {
      receipts: Math.max(0, current.receipts - input.baseline.receipts),
      executionClaims: Math.max(0, current.executionClaims - input.baseline.executionClaims),
    };
    if (
      counts.receipts >= input.expectedReceipts &&
      counts.executionClaims >= input.expectedExecutionClaims
    ) {
      break;
    }
    if (Date.now() < deadline) {
      await delay(input.config.verificationIntervalMs);
    }
  } while (Date.now() < deadline);

  return {
    mode: 'metrics',
    ...counts,
    expectedReceipts: input.expectedReceipts,
    expectedExecutionClaims: input.expectedExecutionClaims,
    exact: false,
    verified:
      counts.receipts >= input.expectedReceipts &&
      counts.executionClaims >= input.expectedExecutionClaims,
  };
}

async function verifyViaDatabase(input: {
  config: WebhookIngressLoadConfig;
  attemptedDedupKeys: string[];
  expectedExecutionClaims: number;
}): Promise<VerificationResult> {
  if (input.config.verification.mode !== 'database') {
    throw new Error('Database verification is not configured');
  }
  const client = new Client({
    connectionString: input.config.verification.databaseUrl,
    application_name: 'maxim_webhook_ingress_load_verifier',
    connectionTimeoutMillis: 10_000,
    statement_timeout: 30_000,
  });
  try {
    await client.connect();
    await client.query('BEGIN TRANSACTION READ ONLY');
    const deadline = Date.now() + input.config.verificationTimeoutSec * 1_000;
    let counts: VerificationCounts = { receipts: 0, executionClaims: 0 };
    do {
      const result = await client.query<{ receipts: number; execution_claims: number }>(
        `WITH run_receipts AS (
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
        [input.attemptedDedupKeys],
      );
      const row = result.rows[0];
      counts = {
        receipts: Number(row?.receipts ?? 0),
        executionClaims: Number(row?.execution_claims ?? 0),
      };
      if (
        counts.receipts === input.attemptedDedupKeys.length &&
        counts.executionClaims === input.expectedExecutionClaims
      ) {
        break;
      }
      if (Date.now() < deadline) {
        await delay(input.config.verificationIntervalMs);
      }
    } while (Date.now() < deadline);
    await client.query('ROLLBACK');
    return {
      mode: 'database',
      ...counts,
      expectedReceipts: input.attemptedDedupKeys.length,
      expectedExecutionClaims: input.expectedExecutionClaims,
      exact: true,
      verified:
        counts.receipts === input.attemptedDedupKeys.length &&
        counts.executionClaims === input.expectedExecutionClaims,
    };
  } catch {
    throw new Error('Read-only database verification failed');
  } finally {
    await client.end().catch(() => undefined);
  }
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
    durationSec: config.durationSec,
    aggregateReceiptRps: config.rps,
    maxInFlight: config.maxInFlight,
    requestTimeoutMs: config.requestTimeoutMs,
    ackP99TargetMs: config.ackP99TargetMs,
    mirrorCounts: config.mirrorCounts,
    plannedReceipts: plan.reduce((sum, phase) => sum + phase.requests, 0),
    plannedSemanticEvents: plan.reduce((sum, phase) => sum + phase.semanticEvents, 0),
    verification: config.verification.mode,
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

  const metricsBaseline =
    config.verification.mode === 'metrics' ? await readMetricsSnapshot(config.verification) : null;
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

  const passed =
    ack.errors === 0 && ack.p99Ms < config.ackP99TargetMs && (verification?.verified ?? true);
  const result = {
    runId: config.runId,
    passed,
    elapsedMs: Math.round(elapsedMs),
    achievedReceiptRps: Number(((aggregateStats.total * 1_000) / elapsedMs).toFixed(2)),
    attemptedReceipts: attemptedDedupKeys.size,
    semanticEvents: attemptedSemanticKeys.size,
    ack,
    phases,
    verification,
  };
  process.stdout.write(`${JSON.stringify({ result }, null, 2)}\n`);
  if (!passed) {
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
