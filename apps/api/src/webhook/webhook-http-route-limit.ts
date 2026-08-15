import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { MaxWebhookRouteOutcome, MaxWebhookRouteOutcomeMetric } from './webhook-route-outcome';

export const MAX_WEBHOOK_ROUTE_CONFIG_KEY = 'maximWebhookIngress';
export const DEFAULT_MAX_WEBHOOK_BODY_LIMIT_BYTES = 1_048_576;
export const MAX_MAX_WEBHOOK_BODY_LIMIT_BYTES = 4_194_304;
export const DEFAULT_MAX_WEBHOOK_ACK_DEADLINE_MS = 18_000;
export const MAX_MAX_WEBHOOK_ACK_DEADLINE_MS = 18_000;
export const MAX_WEBHOOK_ACK_RESPONSE_GRACE_MS = 1_000;

const MAX_WEBHOOK_ACK_DEADLINE_AT_MS = Symbol('maximWebhookAckDeadlineAtMs');
const MAX_WEBHOOK_REQUEST_STATE = Symbol('maximWebhookRequestState');

export type MaxWebhookEarlyAdmissionDecision =
  | {
      accepted: true;
      botId: string;
    }
  | {
      accepted: false;
      botId: string | null;
      outcome: 'authentication_rejected' | 'admission_rejected';
      statusCode: 403 | 503;
    };

export type MaxWebhookHttpRouteLimitOptions = {
  bodyLimit: number;
  ackDeadlineMs: number;
  admitRequest?: (
    request: FastifyRequest,
    ackDeadlineAtMs: number | null,
  ) => Promise<MaxWebhookEarlyAdmissionDecision>;
  recordRouteOutcome?: (metric: MaxWebhookRouteOutcomeMetric) => void;
};

type MutableFastifyRouteOptions = {
  bodyLimit?: number;
  handlerTimeout?: number;
  config?: unknown;
};

type MutableFastifyWebhookRequest = {
  routeOptions?: {
    config?: unknown;
  };
  [MAX_WEBHOOK_ACK_DEADLINE_AT_MS]?: number;
  [MAX_WEBHOOK_REQUEST_STATE]?: MaxWebhookRequestState;
};

type MaxWebhookRequestState = {
  admittedBotId: string | null;
  metricBotId: string | null;
  outcome: MaxWebhookRouteOutcome | null;
  metricRecorded: boolean;
};

export function registerMaxWebhookHttpRouteLimits(
  fastify: FastifyInstance,
  options: MaxWebhookHttpRouteLimitOptions,
): void {
  const bodyLimit = normalizeMaxWebhookBodyLimit(options.bodyLimit);
  const handlerTimeoutMs = normalizeMaxWebhookAckDeadlineMs(options.ackDeadlineMs);
  const workDeadlineMs = resolveMaxWebhookAckWorkDeadlineMs(handlerTimeoutMs);

  fastify.addHook('onRoute', (routeOptions) => {
    applyMaxWebhookBodyLimit(routeOptions, bodyLimit);
    applyMaxWebhookHandlerTimeout(routeOptions, handlerTimeoutMs);
  });
  fastify.addHook('onRequest', async (request, reply) => {
    applyMaxWebhookAckDeadline(request, workDeadlineMs);
    if (!isMaxWebhookRouteConfig(request.routeOptions?.config) || !options.admitRequest) {
      return;
    }

    let decision: MaxWebhookEarlyAdmissionDecision;
    try {
      decision = await options.admitRequest(request, readMaxWebhookAckDeadlineAtMs(request));
    } catch {
      setMaxWebhookRouteOutcome(request, 'failed');
      reply.code(503).send({ statusCode: 503, message: 'Service Unavailable' });
      return;
    }

    const state = getOrCreateMaxWebhookRequestState(request);
    state.metricBotId = normalizeBotId(decision.botId);
    if (decision.accepted) {
      if (!state.metricBotId) {
        state.outcome = 'failed';
        reply.code(503).send({ statusCode: 503, message: 'Service Unavailable' });
        return;
      }
      state.admittedBotId = state.metricBotId;
      return;
    }

    state.outcome = decision.outcome;
    reply.code(decision.statusCode).send({
      statusCode: decision.statusCode,
      message: decision.statusCode === 403 ? 'Forbidden' : 'Service Unavailable',
    });
  });
  fastify.addHook('onError', (request, _reply, error, done) => {
    if (isMaxWebhookRouteConfig(request.routeOptions?.config)) {
      setMaxWebhookRouteOutcome(request, classifyMaxWebhookRouteError(error));
    }
    done();
  });
  fastify.addHook('onResponse', (request, reply, done) => {
    if (isMaxWebhookRouteConfig(request.routeOptions?.config)) {
      recordMaxWebhookRouteOutcome(request, reply.statusCode, options.recordRouteOutcome);
    }
    done();
  });
}

export function applyMaxWebhookBodyLimit(
  routeOptions: MutableFastifyRouteOptions,
  bodyLimit: number,
): void {
  const config =
    typeof routeOptions.config === 'object' && routeOptions.config !== null
      ? (routeOptions.config as Record<string, unknown>)
      : null;
  if (config?.[MAX_WEBHOOK_ROUTE_CONFIG_KEY] !== true) {
    return;
  }
  routeOptions.bodyLimit = normalizeMaxWebhookBodyLimit(bodyLimit);
}

export function applyMaxWebhookHandlerTimeout(
  routeOptions: MutableFastifyRouteOptions,
  deadlineMs: number,
): void {
  if (!isMaxWebhookRouteConfig(routeOptions.config)) {
    return;
  }
  routeOptions.handlerTimeout = normalizeMaxWebhookAckDeadlineMs(deadlineMs);
}

export function normalizeMaxWebhookBodyLimit(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.min(MAX_MAX_WEBHOOK_BODY_LIMIT_BYTES, Math.max(1, Math.trunc(parsed)))
    : DEFAULT_MAX_WEBHOOK_BODY_LIMIT_BYTES;
}

export function applyMaxWebhookAckDeadline(
  request: MutableFastifyWebhookRequest,
  deadlineMs: number,
  nowMs = Date.now(),
): void {
  if (!isMaxWebhookRouteConfig(request.routeOptions?.config)) {
    return;
  }

  request[MAX_WEBHOOK_ACK_DEADLINE_AT_MS] = nowMs + normalizeMaxWebhookAckDeadlineMs(deadlineMs);
}

export function readMaxWebhookAckDeadlineAtMs(
  request: MutableFastifyWebhookRequest,
): number | null {
  const value = request[MAX_WEBHOOK_ACK_DEADLINE_AT_MS];
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : null;
}

export function readMaxWebhookAdmittedBotId(request: object): string | null {
  return (
    (request as MutableFastifyWebhookRequest)[MAX_WEBHOOK_REQUEST_STATE]?.admittedBotId ?? null
  );
}

export function normalizeMaxWebhookAckDeadlineMs(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.min(MAX_MAX_WEBHOOK_ACK_DEADLINE_MS, Math.max(1, Math.trunc(parsed)))
    : DEFAULT_MAX_WEBHOOK_ACK_DEADLINE_MS;
}

export function resolveMaxWebhookAckWorkDeadlineMs(value: unknown): number {
  const handlerTimeoutMs = normalizeMaxWebhookAckDeadlineMs(value);
  const responseGraceMs = Math.min(
    MAX_WEBHOOK_ACK_RESPONSE_GRACE_MS,
    Math.max(1, Math.trunc(handlerTimeoutMs / 4)),
  );
  return Math.max(1, handlerTimeoutMs - responseGraceMs);
}

function isMaxWebhookRouteConfig(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<string, unknown>)[MAX_WEBHOOK_ROUTE_CONFIG_KEY] === true
  );
}

function getOrCreateMaxWebhookRequestState(
  request: MutableFastifyWebhookRequest,
): MaxWebhookRequestState {
  const existing = request[MAX_WEBHOOK_REQUEST_STATE];
  if (existing) {
    return existing;
  }
  const created: MaxWebhookRequestState = {
    admittedBotId: null,
    metricBotId: null,
    outcome: null,
    metricRecorded: false,
  };
  request[MAX_WEBHOOK_REQUEST_STATE] = created;
  return created;
}

function setMaxWebhookRouteOutcome(
  request: MutableFastifyWebhookRequest,
  outcome: MaxWebhookRouteOutcome,
): void {
  const state = getOrCreateMaxWebhookRequestState(request);
  if (!state.outcome) {
    state.outcome = outcome;
  }
}

function classifyMaxWebhookRouteError(error: unknown): MaxWebhookRouteOutcome {
  const code = readErrorField(error, 'code');
  const statusCode = readErrorStatusCode(error);
  if (code === 'FST_ERR_CTP_BODY_TOO_LARGE' || statusCode === 413) {
    return 'payload_too_large';
  }
  if (code === 'FST_ERR_CTP_INVALID_JSON_BODY') {
    return 'invalid_json';
  }
  if (code === 'FST_ERR_HANDLER_TIMEOUT' || statusCode === 408 || statusCode === 504) {
    return 'timed_out';
  }
  if (statusCode === 400) {
    return 'invalid_payload';
  }
  if (statusCode === 401 || statusCode === 403) {
    return 'authentication_rejected';
  }
  return 'failed';
}

function recordMaxWebhookRouteOutcome(
  request: MutableFastifyWebhookRequest,
  statusCode: number,
  recorder: MaxWebhookHttpRouteLimitOptions['recordRouteOutcome'],
): void {
  const state = getOrCreateMaxWebhookRequestState(request);
  if (state.metricRecorded) {
    return;
  }
  state.metricRecorded = true;
  const outcome = state.outcome ?? classifyMaxWebhookResponseStatus(statusCode);
  try {
    recorder?.({
      botId: state.metricBotId,
      outcome,
    });
  } catch {
    // Observability must not alter the webhook response lifecycle.
  }
}

function classifyMaxWebhookResponseStatus(statusCode: number): MaxWebhookRouteOutcome {
  if (statusCode >= 200 && statusCode < 300) {
    return 'accepted';
  }
  if (statusCode === 400) {
    return 'invalid_payload';
  }
  if (statusCode === 401 || statusCode === 403) {
    return 'authentication_rejected';
  }
  if (statusCode === 408 || statusCode === 504) {
    return 'timed_out';
  }
  if (statusCode === 413) {
    return 'payload_too_large';
  }
  return 'failed';
}

function readErrorField(error: unknown, field: string): unknown {
  return typeof error === 'object' && error !== null
    ? (error as Record<string, unknown>)[field]
    : undefined;
}

function readErrorStatusCode(error: unknown): number {
  const directStatus = readErrorField(error, 'statusCode') ?? readErrorField(error, 'status');
  const parsedDirectStatus = Number(directStatus);
  if (Number.isFinite(parsedDirectStatus)) {
    return Math.trunc(parsedDirectStatus);
  }

  const getStatus = readErrorField(error, 'getStatus');
  if (typeof getStatus !== 'function') {
    return Number.NaN;
  }
  try {
    const parsedGetterStatus = Number(Reflect.apply(getStatus, error, []));
    return Number.isFinite(parsedGetterStatus) ? Math.trunc(parsedGetterStatus) : Number.NaN;
  } catch {
    return Number.NaN;
  }
}

function normalizeBotId(value: unknown): string | null {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized || null;
}
