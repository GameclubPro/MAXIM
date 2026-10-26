import {
  updateMessageRetentionSchema,
  type MessageRetentionState,
} from '@maxim/contracts/settings';
import { ApiRequestError } from '../api-request-error';
import {
  PREVIEW_NOT_HANDLED,
  readPreviewClock,
  type PreviewRequestHandler,
} from './preview-transport-runtime';
import type { PreviewState } from './preview-transport-state';

const policies = new WeakMap<PreviewState, Map<string, MessageRetentionState>>();
const attempts = new WeakMap<PreviewState, { read: number; write: number }>();
const operations = new WeakMap<
  PreviewState,
  Map<string, { body: string; result: MessageRetentionState }>
>();

export function getPreviewMessageRetention(
  state: PreviewState,
  chatId: string,
): MessageRetentionState {
  let chats = policies.get(state);
  if (!chats) {
    chats = new Map();
    policies.set(state, chats);
  }
  const current: MessageRetentionState = chats.get(chatId) ?? {
    enabled: false,
    hours: 48,
    revision: 0,
    enabledAt: null,
    captureAfter: null,
    pausedAt: null,
    status: 'off',
    pendingCount: 0,
    deletedCount: 0,
    skippedCount: 0,
    oldestDueAt: null,
    connectionStatus: 'connected',
    historyStatus: 'off',
    historyScannedCount: 0,
  };
  if (!chats.has(chatId)) {
    const now = readPreviewClock(state.clock).getTime();
    if (state.retentionScenario === 'unavailable') current.status = 'unavailable';
    if (state.retentionScenario.startsWith('connection-')) {
      current.connectionStatus = 'missing';
      if (['connection-pending', 'connection-expired'].includes(state.retentionScenario))
        current.connectionRequest = {
          status: state.retentionScenario === 'connection-pending' ? 'pending' : 'expired',
          expiresAt: new Date(
            now + (state.retentionScenario === 'connection-pending' ? 3_600_000 : -1000),
          ).toISOString(),
        };
    }
    if (['large', 'paused'].includes(state.retentionScenario))
      Object.assign(current, {
        enabled: true,
        status: state.retentionScenario === 'paused' ? 'capacity_paused' : 'delayed',
        pendingCount: 2_000_000,
        deletedCount: 987_654_321,
        skippedCount: 123_456,
        captureAfter: new Date(now - 3 * 86_400_000).toISOString(),
        enabledAt: new Date(now - 3 * 86_400_000).toISOString(),
        oldestDueAt: new Date(now - 3_600_000).toISOString(),
        pausedAt:
          state.retentionScenario === 'paused' ? new Date(now - 60_000).toISOString() : null,
      });
    chats.set(chatId, current);
  }
  return structuredClone(current);
}

export const handlePreviewMessageRetention: PreviewRequestHandler = async ({
  state,
  segments,
  method,
  init,
}) => {
  if (segments[0] !== 'chats' || segments[2] !== 'message-retention') return PREVIEW_NOT_HANDLED;
  const chatId = decodeURIComponent(segments[1] ?? '');
  if (!state.chats.some((chat) => chat.id === chatId)) throw new Error('Чат недоступен');
  const current = getPreviewMessageRetention(state, chatId);
  const chats = policies.get(state)!;
  const count = attempts.get(state) ?? { read: 0, write: 0 };
  attempts.set(state, count);
  if (state.retentionScenario === 'slow') await new Promise((resolve) => setTimeout(resolve, 700));
  if (method === 'GET' && ++count.read <= 2 && state.retentionScenario === 'load-error')
    throw new Error('Соединение прервано.');
  if (method === 'GET') return structuredClone(current);
  if (method !== 'PUT' || segments.length !== 3) return PREVIEW_NOT_HANDLED;
  const input = updateMessageRetentionSchema.parse(JSON.parse(String(init.body)));
  const operationKey = input.operationId ? `${chatId}:${input.operationId}` : undefined;
  let completed = operations.get(state);
  if (!completed) {
    completed = new Map();
    operations.set(state, completed);
  }
  const body = JSON.stringify(input);
  const previous = operationKey ? completed.get(operationKey) : undefined;
  if (previous) {
    if (previous.body !== body)
      throw new ApiRequestError(
        409,
        '{"code":"MESSAGE_RETENTION_OPERATION_CONFLICT"}',
        'Операция уже использована для других настроек.',
      );
    return structuredClone(previous.result);
  }
  if (++count.write === 1) {
    if (state.retentionScenario === 'write-error')
      throw new Error('Не удалось сохранить изменения.');
    if (state.retentionScenario === 'conflict') {
      chats.set(chatId, { ...current, revision: current.revision + 1 });
      throw new ApiRequestError(
        409,
        '{"code":"MESSAGE_RETENTION_REVISION_CONFLICT"}',
        'Настройки уже изменены.',
      );
    }
  }
  if (input.expectedRevision !== current.revision)
    throw new ApiRequestError(
      409,
      '{"code":"MESSAGE_RETENTION_REVISION_CONFLICT"}',
      'Настройки уже изменены.',
    );
  const now = readPreviewClock(state.clock).toISOString();
  const next: MessageRetentionState = {
    ...current,
    enabled: input.connectWhenReady ? false : input.enabled,
    hours: input.hours,
    revision: current.revision + 1,
    status: input.enabled && !input.connectWhenReady ? 'running' : 'off',
    enabledAt:
      input.enabled && !input.connectWhenReady && !current.enabled ? now : current.enabledAt,
    captureAfter: null,
    historyStatus: input.enabled && !input.connectWhenReady ? 'running' : 'off',
    connectionRequest: input.connectWhenReady
      ? {
          status: 'pending',
          expiresAt: new Date(Date.parse(now) + 3_600_000).toISOString(),
        }
      : null,
    ...(input.operationId ? { lastOperationId: input.operationId } : {}),
  };
  chats.set(chatId, next);
  if (operationKey) completed.set(operationKey, { body, result: structuredClone(next) });
  return structuredClone(next);
};
