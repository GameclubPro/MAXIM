import type {
  BroadcastHistoryCounts,
  BroadcastHistoryFilter,
} from '../lib/broadcast-history-filters';
import { SegmentedControl } from './ui/segmented-control';
import { ResetIcon } from './ui/reset-icon';

export {
  countManagedBroadcastHistoryFilters,
  filterManagedBroadcastsByHistoryFilter,
} from '../lib/broadcast-history-filters';
export type {
  BroadcastHistoryCounts,
  BroadcastHistoryFilter,
} from '../lib/broadcast-history-filters';

export type BroadcastWorkspaceView = 'compose' | 'calendar' | 'history';

type BroadcastWorkspaceTabsProps = {
  value: BroadcastWorkspaceView;
  historyCount: number;
  disabled?: boolean;
  onChange: (value: BroadcastWorkspaceView) => void;
};

type BroadcastHistoryFilterTabsProps = {
  value: BroadcastHistoryFilter;
  counts: BroadcastHistoryCounts;
  onChange: (value: BroadcastHistoryFilter) => void;
};

type BroadcastWorkspaceChromeProps = {
  showTabs: boolean;
  value: BroadcastWorkspaceView;
  historyCount: number;
  disabled?: boolean;
  showReset: boolean;
  resetLabel: string;
  resetPending?: boolean;
  onChange: (value: BroadcastWorkspaceView) => void;
  onReset: () => void;
};

export function BroadcastWorkspaceTabs({
  value,
  historyCount,
  disabled = false,
  onChange,
}: BroadcastWorkspaceTabsProps) {
  return (
    <SegmentedControl<BroadcastWorkspaceView>
      className="broadcast-studio-shell__tabs"
      value={value}
      onChange={(nextValue) => {
        if (!disabled) {
          onChange(nextValue);
        }
      }}
      ariaLabel="Раздел автопостинга"
      options={[
        { value: 'compose', label: 'Пост' },
        { value: 'calendar', label: 'План' },
        { value: 'history', label: 'История', count: historyCount },
      ]}
    />
  );
}

export function BroadcastWorkspaceChrome({
  showTabs,
  value,
  historyCount,
  disabled = false,
  showReset,
  resetLabel,
  resetPending = false,
  onChange,
  onReset,
}: BroadcastWorkspaceChromeProps) {
  if (!showTabs && !showReset) {
    return null;
  }

  const effectiveResetLabel = resetPending ? 'Сбрасываем' : resetLabel;

  return (
    <div className="broadcast-studio-shell__topbar broadcast-studio-screen__nav">
      {showTabs ? (
        <BroadcastWorkspaceTabs
          value={value}
          historyCount={historyCount}
          disabled={disabled}
          onChange={onChange}
        />
      ) : null}

      {showReset ? (
        <button
          type="button"
          className="broadcast-shell-reset"
          onClick={onReset}
          disabled={disabled}
          aria-label={effectiveResetLabel}
          title={effectiveResetLabel}
        >
          <ResetIcon />
        </button>
      ) : null}
    </div>
  );
}

export function BroadcastHistoryFilterTabs({
  value,
  counts,
  onChange,
}: BroadcastHistoryFilterTabsProps) {
  return (
    <SegmentedControl<BroadcastHistoryFilter>
      className="broadcast-history-filters"
      value={value}
      onChange={onChange}
      ariaLabel="История автопостинга"
      options={[
        { value: 'future', label: 'План', count: counts.future },
        { value: 'active', label: 'Идут', count: counts.active },
        { value: 'error', label: 'Ошибки', count: counts.error },
        { value: 'sent', label: 'Готово', count: counts.sent },
        { value: 'canceled', label: 'Стоп', count: counts.canceled },
      ]}
    />
  );
}
