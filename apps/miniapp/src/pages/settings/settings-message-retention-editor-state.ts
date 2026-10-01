import type { MessageRetentionState, UpdateMessageRetention } from '@maxim/contracts/settings';
import { ApiRequestError } from '../../lib/api-request-error';

export type RetentionDraftState = { chatId: string; draft: UpdateMessageRetention | null };
export type RetentionDraftAction =
  | { type: 'snapshot'; chatId: string; state: MessageRetentionState | undefined }
  | { type: 'edit'; chatId: string; draft: UpdateMessageRetention }
  | { type: 'discard'; chatId: string };

export function retentionDraftReducer(
  current: RetentionDraftState,
  action: RetentionDraftAction,
): RetentionDraftState {
  if (action.type === 'edit') return { chatId: action.chatId, draft: action.draft };
  if (action.type === 'discard' || current.chatId !== action.chatId)
    return { chatId: action.chatId, draft: null };
  const { draft } = current;
  if (
    draft &&
    action.state &&
    draft.enabled === action.state.enabled &&
    draft.hours === action.state.hours
  )
    return { chatId: action.chatId, draft: null };
  return current;
}

export function isRetentionRevisionConflict(error: unknown): boolean {
  return (
    error instanceof ApiRequestError &&
    error.status === 409 &&
    error.code === 'MESSAGE_RETENTION_REVISION_CONFLICT'
  );
}

export function isRetentionWriteUncertain(error: unknown): boolean {
  return !(error instanceof ApiRequestError) || error.status >= 500;
}

export function retentionEditorState(
  state: MessageRetentionState | undefined,
  draft: UpdateMessageRetention | null,
) {
  if (!state) return { current: null, dirty: false, conflict: false };
  const dirty = Boolean(draft && (draft.enabled !== state.enabled || draft.hours !== state.hours));
  const current = dirty
    ? draft!
    : { enabled: state.enabled, hours: state.hours, expectedRevision: state.revision };
  return { current, dirty, conflict: dirty && current.expectedRevision !== state.revision };
}

const counts = new Intl.NumberFormat('ru-RU', { notation: 'compact', maximumFractionDigits: 1 });
const roundedCounts = new Intl.NumberFormat('ru-RU', {
  notation: 'compact',
  maximumFractionDigits: 0,
});
const dates = new Intl.DateTimeFormat('ru-RU', {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
});
export function retentionCount(value: number): string {
  return value < 10_000
    ? value.toLocaleString('ru-RU')
    : value < 100_000
      ? counts.format(value)
      : roundedCounts.format(value);
}
export function retentionDate(value: string): string {
  return dates.format(new Date(value));
}
