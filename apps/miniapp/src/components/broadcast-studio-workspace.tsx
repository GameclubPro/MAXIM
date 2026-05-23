import type { ManagedBroadcastSummary } from '@maxim/contracts';
import { SegmentedControl } from './ui/segmented-control';
import { ResetIcon } from './ui/reset-icon';

export type BroadcastWorkspaceView = 'compose' | 'calendar' | 'history';
export type BroadcastHistoryFilter = 'future' | 'active' | 'error' | 'sent' | 'canceled';

export type BroadcastHistoryCounts = Record<BroadcastHistoryFilter, number>;

const EMPTY_HISTORY_COUNTS: BroadcastHistoryCounts = {
  future: 0,
  active: 0,
  error: 0,
  sent: 0,
  canceled: 0,
};

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

function isFutureBroadcast(broadcast: ManagedBroadcastSummary): boolean {
  return (
    (broadcast.status === 'ACTIVE' || broadcast.status === 'PARTIAL') &&
    Boolean(broadcast.nextSendAt)
  );
}

function isActiveBroadcast(broadcast: ManagedBroadcastSummary): boolean {
  return (
    (broadcast.status === 'ACTIVE' || broadcast.status === 'PARTIAL') &&
    !isFutureBroadcast(broadcast)
  );
}

function isErrorBroadcast(broadcast: ManagedBroadcastSummary): boolean {
  return (
    broadcast.status === 'FAILED' ||
    broadcast.status === 'PARTIAL' ||
    broadcast.failedChats > 0 ||
    Boolean(broadcast.lastError) ||
    broadcast.canRetry
  );
}

export function filterManagedBroadcastsByHistoryFilter<T extends ManagedBroadcastSummary>(
  broadcasts: T[],
  filter: BroadcastHistoryFilter,
): T[] {
  return broadcasts.filter((broadcast) => {
    if (filter === 'future') {
      return isFutureBroadcast(broadcast);
    }

    if (filter === 'active') {
      return isActiveBroadcast(broadcast);
    }

    if (filter === 'error') {
      return isErrorBroadcast(broadcast);
    }

    if (filter === 'sent') {
      return broadcast.status === 'COMPLETED';
    }

    return broadcast.status === 'CANCELED';
  });
}

export function countManagedBroadcastHistoryFilters(
  broadcasts: ManagedBroadcastSummary[],
): BroadcastHistoryCounts {
  return broadcasts.reduce<BroadcastHistoryCounts>(
    (counts, broadcast) => {
      if (isFutureBroadcast(broadcast)) {
        counts.future += 1;
      }

      if (isActiveBroadcast(broadcast)) {
        counts.active += 1;
      }

      if (isErrorBroadcast(broadcast)) {
        counts.error += 1;
      }

      if (broadcast.status === 'COMPLETED') {
        counts.sent += 1;
      }

      if (broadcast.status === 'CANCELED') {
        counts.canceled += 1;
      }

      return counts;
    },
    { ...EMPTY_HISTORY_COUNTS },
  );
}

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
        { value: 'compose', label: 'Создать' },
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
