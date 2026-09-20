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

export const handlePreviewMessageRetention: PreviewRequestHandler = ({
  state,
  segments,
  method,
  init,
}) => {
  if (segments[0] !== 'chats' || segments[2] !== 'message-retention') return PREVIEW_NOT_HANDLED;
  const chatId = decodeURIComponent(segments[1] ?? '');
  if (!state.chats.some((chat) => chat.id === chatId)) throw new Error('Чат недоступен');
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
  };
  if (method === 'GET') return structuredClone(current);
  if (method !== 'PUT' || segments.length !== 3) return PREVIEW_NOT_HANDLED;
  const input = updateMessageRetentionSchema.parse(JSON.parse(String(init.body)));
  if (input.expectedRevision !== current.revision)
    throw new ApiRequestError(
      409,
      '{"code":"MESSAGE_RETENTION_REVISION_CONFLICT"}',
      'Настройки уже изменены.',
    );
  const now = readPreviewClock(state.clock).toISOString();
  const next: MessageRetentionState = {
    ...current,
    enabled: input.enabled,
    hours: input.hours,
    revision: current.revision + 1,
    status: input.enabled ? 'running' : 'off',
    enabledAt: input.enabled && !current.enabled ? now : current.enabledAt,
    captureAfter: !input.enabled ? null : !current.enabled ? now : current.captureAfter,
  };
  chats.set(chatId, next);
  return structuredClone(next);
};
