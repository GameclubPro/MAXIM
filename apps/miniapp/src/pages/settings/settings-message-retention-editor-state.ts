import type { MessageRetentionState, UpdateMessageRetention } from '@maxim/contracts/settings';

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
