import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { Config } from './config.js';
import { MaxError, type MaxTransport } from './max.js';
import type { CleanupRuntime } from './runtime.js';
import { Store } from './store.js';
import {
  ServiceError,
  hours,
  integer,
  parseMessage,
  record,
  validChat,
  type Protection,
  type UpdatePolicy,
} from './types.js';

function equalSecret(actual: unknown, expected: string): boolean {
  if (typeof actual !== 'string' || !expected) return false;
  return timingSafeEqual(
    createHash('sha256').update(actual).digest(),
    createHash('sha256').update(expected).digest(),
  );
}
function fail(status: number, code: string, message: string): never {
  throw new ServiceError(status, code, message);
}
async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 2_000_000) fail(413, 'BODY_TOO_LARGE', 'Слишком большой запрос.');
    chunks.push(chunk);
  }
  try {
    const value = record(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    if (!value) throw new Error();
    return value;
  } catch {
    return fail(400, 'INVALID_BODY', 'Некорректный запрос.');
  }
}
function ids(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length > 1000 ||
    value.some((item) => typeof item !== 'string' || !item || item.length > 256)
  )
    return fail(400, 'INVALID_PROTECTION', 'Некорректная защита сообщений.');
  return [...new Set(value as string[])];
}
export function protectionInput(value: Record<string, unknown>): Protection {
  if (
    !integer(value.sourceRevision) ||
    (value.complete !== undefined && typeof value.complete !== 'boolean') ||
    (value.completeThrough !== null &&
      (typeof value.completeThrough !== 'string' ||
        !Number.isFinite(Date.parse(value.completeThrough)) ||
        Date.parse(value.completeThrough) > Date.now() + 60_000)) ||
    (value.botHistoryCompleteFrom !== undefined &&
      value.botHistoryCompleteFrom !== null &&
      (typeof value.botHistoryCompleteFrom !== 'string' ||
        !Number.isFinite(Date.parse(value.botHistoryCompleteFrom)) ||
        Date.parse(value.botHistoryCompleteFrom) > Date.now() + 60_000))
  )
    return fail(400, 'INVALID_PROTECTION', 'Некорректная защита сообщений.');
  return {
    sourceRevision: value.sourceRevision,
    protectedMessageIds: ids(value.protectedMessageIds),
    protectedBotIds: ids(value.protectedBotIds),
    holdMessageIds: ids(value.holdMessageIds),
    holdAuthorIds: ids(value.holdAuthorIds ?? []),
    completeThrough: value.completeThrough as string | null,
    botHistoryCompleteFrom: (value.botHistoryCompleteFrom ?? null) as string | null,
    ...(value.complete === undefined ? {} : { complete: value.complete }),
  };
}
export function updateInput(value: Record<string, unknown>): UpdatePolicy {
  if (
    typeof value.enabled !== 'boolean' ||
    !hours(value.hours) ||
    !integer(value.expectedRevision) ||
    (value.connectWhenReady !== undefined && typeof value.connectWhenReady !== 'boolean') ||
    (value.connectWhenReady === true && value.enabled !== true) ||
    typeof value.operationId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value.operationId,
    ) ||
    typeof value.actorUserId !== 'string' ||
    !/^\d+$/.test(value.actorUserId)
  )
    return fail(400, 'INVALID_POLICY', 'Некорректные настройки удаления.');
  return {
    enabled: value.enabled,
    hours: value.hours,
    expectedRevision: value.expectedRevision,
    operationId: value.operationId,
    actorUserId: value.actorUserId,
    ...(value.connectWhenReady === true ? { connectWhenReady: true } : {}),
  };
}
export function createHttpServer(
  store: Store,
  max: MaxTransport,
  runtime: Pick<CleanupRuntime, 'health'>,
  config: Config,
  redisPing: () => Promise<unknown>,
) {
  const send = (response: ServerResponse, status: number, value: unknown) => {
    response.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    response.end(JSON.stringify(value));
  };
  return createServer((request, response) => {
    void (async () => {
      try {
        const url = new URL(request.url ?? '/', 'http://eraser.internal');
        if (request.method === 'GET' && url.pathname === '/health') {
          await store.pool.query('SELECT 1');
          await redisPing();
          const health = runtime.health();
          return send(response, health.schedulerHealthy ? 200 : 503, {
            status: health.schedulerHealthy ? 'ok' : 'degraded',
            service: 'eraser',
            commitSha: config.commitSha,
            enabled: config.enabled,
            ...health,
          });
        }
        if (request.method === 'POST' && url.pathname === '/webhook') {
          if (
            !config.enabled ||
            !equalSecret(request.headers['x-max-bot-api-secret'], config.webhookSecret)
          )
            return send(response, 403, { code: 'FORBIDDEN' });
          const value = await body(request);
          const recipient = record(record(value.message)?.recipient);
          const chatId = String(recipient?.chat_id ?? '');
          const message =
            validChat(chatId) && value.update_type === 'message_created'
              ? (parseMessage(value.message, chatId) ?? undefined)
              : undefined;
          const key = createHash('sha256').update(JSON.stringify(value)).digest('hex');
          // FLAG: No diagnostics or permission probes are ever sent to a chat from this endpoint.
          await store.ingest(value, key, message);
          return send(response, 200, { success: true });
        }
        if (!equalSecret(request.headers.authorization, `Bearer ${config.controlToken}`))
          return send(response, 403, { code: 'FORBIDDEN' });
        if (request.method === 'PUT' && url.pathname === '/internal/v1/holds') {
          const value = await body(request);
          const messages = value.holdMessages ?? [];
          if (
            !Array.isArray(messages) ||
            messages.length > 1000 ||
            messages.some((message) => {
              const item = record(message);
              return (
                !item ||
                typeof item.chatId !== 'string' ||
                !validChat(item.chatId) ||
                typeof item.messageId !== 'string' ||
                !item.messageId ||
                item.messageId.length > 256
              );
            })
          )
            fail(400, 'INVALID_HOLDS', 'Некорректная защита сообщений.');
          await store.globalHolds(
            ids(value.holdAuthorIds),
            messages as Array<{ chatId: string; messageId: string }>,
          );
          return send(response, 200, { success: true });
        }
        if (request.method === 'GET' && url.pathname === '/internal/v1/runtime') {
          const after = url.searchParams.get('after');
          if (after !== null && !validChat(after))
            fail(400, 'INVALID_CURSOR', 'Некорректный курсор.');
          const policies = (
            await store.pool.query<{ chat_id: string }>(
              'SELECT chat_id FROM eraser_policies WHERE ($1::text IS NULL OR chat_id>$1) ORDER BY chat_id LIMIT 51',
              [after],
            )
          ).rows;
          const items = [];
          for (const row of policies.slice(0, 50)) {
            const policy = (await store.policy(row.chat_id))!;
            const snapshot = await store.snapshot(row.chat_id);
            const flags = (
              await store.pool.query<{ review: boolean; uncertain: boolean }>(
                "SELECT EXISTS(SELECT 1 FROM eraser_candidates WHERE chat_id=$1 AND state='review') AS review,EXISTS(SELECT 1 FROM eraser_candidates WHERE chat_id=$1 AND state IN ('uncertain','dispatching')) AS uncertain",
                [row.chat_id],
              )
            ).rows[0]!;
            items.push({
              chatId: row.chat_id,
              chatTitle: 'Чат',
              ...snapshot,
              activationId: policy.activation_id,
              nextRunAt: policy.next_run_at.toISOString(),
              hasTerminalReview: flags.review,
              hasUnresolvedReceipt: flags.uncertain,
              updatedAt: policy.updated_at.toISOString(),
            });
          }
          return send(response, 200, {
            generatedAt: new Date().toISOString(),
            mode: config.enabled ? 'on' : 'off',
            nextAfter: policies.length > 50 ? policies[49]!.chat_id : null,
            quotas: [],
            items,
          });
        }
        const match =
          /^\/internal\/v1\/chats\/(-[1-9]\d*)\/(policy|bootstrap|protection|review|retry)$/.exec(
            url.pathname,
          );
        if (!match) return send(response, 404, { code: 'NOT_FOUND' });
        const chatId = match[1]!,
          route = match[2]!;
        if (route === 'policy' && request.method === 'GET')
          return send(response, 200, await store.snapshot(chatId));
        if (route === 'bootstrap' && request.method === 'PUT') {
          const value = await body(request);
          if (!hours(value.hours)) fail(400, 'INVALID_POLICY', 'Некорректный срок.');
          await store.bootstrap(
            chatId,
            value.hours,
            value.sourceRevision === undefined ? undefined : protectionInput(value),
          );
          return send(response, 200, await store.snapshot(chatId));
        }
        if (route === 'protection' && request.method === 'PUT') {
          await store.protect(chatId, protectionInput(await body(request)));
          return send(response, 200, { success: true });
        }
        if (route === 'policy' && request.method === 'PUT') {
          const input = updateInput(await body(request));
          const cached = await store.operation(chatId, input);
          if (cached) return send(response, 200, cached);
          if (input.enabled && !input.connectWhenReady) {
            if (!config.enabled) fail(503, 'ERASER_UNAVAILABLE', 'Ластик пока недоступен.');
            try {
              await max.rights(chatId);
              await store.connection(chatId, 'connected', true);
            } catch (error) {
              if (error instanceof MaxError && error.code === 'eraser_rights_missing') {
                await store.connection(chatId, 'no_access');
                fail(
                  409,
                  'ERASER_CONNECTION_REQUIRED',
                  'Добавьте Ластика администратором с правами чтения и удаления.',
                );
              }
              fail(
                503,
                'ERASER_ACCESS_CHECK_UNAVAILABLE',
                'Не удалось проверить права Ластика. Повторите сохранение позже.',
              );
            }
          }
          return send(response, 200, await store.update(chatId, input));
        }
        if (route === 'review' && request.method === 'GET')
          return send(response, 200, await review(store, chatId));
        if (route === 'retry' && request.method === 'POST') {
          const input = await body(request);
          const policy = await store.policy(chatId);
          if (
            !policy ||
            input.expectedRevision !== policy.revision ||
            input.activationId !== policy.activation_id ||
            typeof input.messageId !== 'string' ||
            typeof input.intentId !== 'string' ||
            typeof input.expectedIntentUpdatedAt !== 'string' ||
            !integer(input.expectedAttemptCount)
          )
            fail(409, 'ERASER_RETRY_CONFLICT', 'Состояние удаления изменилось.');
          // FLAG: An uncertain/attempted DELETE cannot be replayed by the review endpoint.
          const retried = await store.pool.query(
            "UPDATE eraser_candidates SET state='pending',next_attempt_at=CURRENT_TIMESTAMP,outcome_code=NULL WHERE chat_id=$1 AND message_id=$2 AND state='review' AND attempt_count=0 AND dispatch_id IS NULL AND updated_at=$3::timestamptz AND message_id=$4 AND attempt_count=$5",
            [
              chatId,
              input.messageId,
              input.expectedIntentUpdatedAt,
              input.intentId,
              input.expectedAttemptCount,
            ],
          );
          if (!retried.rowCount)
            fail(409, 'ERASER_RETRY_UNSAFE', 'Удаление требует проверки результата.');
          return send(response, 200, await review(store, chatId));
        }
        return send(response, 405, { code: 'METHOD_NOT_ALLOWED' });
      } catch (error) {
        if (error instanceof ServiceError)
          return send(response, error.status, { code: error.code, message: error.message });
        return send(response, 503, {
          code: 'ERASER_UNAVAILABLE',
          message: 'Ластик временно недоступен.',
        });
      }
    })();
  });
}
async function review(store: Store, chatId: string) {
  const policy = await store.policy(chatId);
  if (!policy) return fail(404, 'NOT_FOUND', 'Настройки удаления не найдены.');
  const rows = (
    await store.pool.query<{
      message_id: string;
      author_id: string;
      source_ms: string;
      state: string;
      outcome_code: string | null;
      dispatch_id: string | null;
      updated_at: Date;
      attempt_count: number;
      next_attempt_at: Date;
    }>(
      "SELECT * FROM eraser_candidates WHERE chat_id=$1 AND state IN ('review','uncertain','dispatching') ORDER BY message_id LIMIT 20",
      [chatId],
    )
  ).rows;
  return {
    chatId,
    revision: policy.revision,
    activationId: policy.activation_id,
    items: rows.map((row) => ({
      messageId: row.message_id,
      authorId: row.author_id,
      sourceAt: new Date(Number(row.source_ms)).toISOString(),
      dueAt: new Date(Number(row.source_ms) + policy.hours * 3_600_000).toISOString(),
      status: row.state,
      outcomeCode: row.outcome_code,
      intentId: row.dispatch_id ?? row.message_id,
      intentStatus:
        row.state === 'review'
          ? 'FAILED_TERMINAL'
          : row.state === 'dispatching'
            ? 'IN_PROGRESS'
            : 'AMBIGUOUS',
      intentUpdatedAt: row.updated_at.toISOString(),
      intentAttemptCount: row.attempt_count,
      reconcileAfter: row.next_attempt_at.toISOString(),
      retryAllowed: row.state === 'review' && row.attempt_count === 0,
    })),
  };
}
