import type {
  BroadcastHistoryCounts,
  BroadcastHistoryFilter,
} from '../lib/broadcast-history-filters';
import { resolveRequestedBroadcastWorkspace } from '../features/publications/legacy-autoposts';
import { useEffect, useRef } from 'react';
import { useLocation, useParams } from 'react-router-dom';
import { PublicationWorkspaceHandoff } from './publication-workspace-handoff';
import { SegmentedControl } from './ui/segmented-control';
import { ResetIcon } from './ui/reset-icon';
import './managed-broadcast-history-card.css';

export {
  countManagedBroadcastHistoryFilters,
  filterManagedBroadcastsByHistoryFilter,
} from '../lib/broadcast-history-filters';
export type {
  BroadcastHistoryCounts,
  BroadcastHistoryFilter,
} from '../lib/broadcast-history-filters';

export type BroadcastWorkspaceView = 'compose' | 'calendar' | 'autoposts' | 'history';

type BroadcastWorkspaceTabsProps = {
  value: BroadcastWorkspaceView;
  autopostCount: number;
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
  autopostCount: number;
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
  autopostCount,
  historyCount,
  disabled = false,
  onChange,
}: BroadcastWorkspaceTabsProps) {
  const tabListRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    tabListRef.current
      ?.querySelector<HTMLElement>('[aria-selected="true"]')
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [value]);

  return (
    <div className="broadcast-studio-shell__tabs-scroll" ref={tabListRef}>
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
          { value: 'autoposts', label: 'Автопосты', count: autopostCount },
          { value: 'history', label: 'История', count: historyCount },
        ]}
      />
    </div>
  );
}

export function BroadcastWorkspaceChrome({
  showTabs,
  value,
  autopostCount,
  historyCount,
  disabled = false,
  showReset,
  resetLabel,
  resetPending = false,
  onChange,
  onReset,
}: BroadcastWorkspaceChromeProps) {
  const { chatId = '' } = useParams();
  const location = useLocation();
  const appliedWorkspaceSearchRef = useRef('');
  const entityType = location.pathname.startsWith('/channel/') ? 'channel' : 'chat';
  const effectiveResetLabel = resetPending ? 'Сбрасываем' : resetLabel;

  useEffect(() => {
    const requestedWorkspace = resolveRequestedBroadcastWorkspace(location.search);
    const workspaceSignature = `${chatId}:${location.search}`;
    if (requestedWorkspace !== 'autoposts') {
      appliedWorkspaceSearchRef.current = '';
      return;
    }
    if (!showTabs || appliedWorkspaceSearchRef.current === workspaceSignature) {
      return;
    }
    appliedWorkspaceSearchRef.current = workspaceSignature;
    onChange('autoposts');
  }, [chatId, location.search, onChange, showTabs]);

  return (
    <>
      {chatId ? <PublicationWorkspaceHandoff entityType={entityType} entityId={chatId} /> : null}
      {showTabs || showReset ? (
        <div className="broadcast-studio-shell__topbar broadcast-studio-screen__nav">
          {showTabs ? (
            <BroadcastWorkspaceTabs
              value={value}
              autopostCount={autopostCount}
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
      ) : null}
    </>
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
        { value: 'future', label: 'Запланировано', count: counts.future },
        { value: 'active', label: 'В работе', count: counts.active },
        { value: 'error', label: 'Ошибки', count: counts.error },
        { value: 'sent', label: 'Опубликовано', count: counts.sent },
        { value: 'canceled', label: 'Стоп', count: counts.canceled },
      ]}
    />
  );
}
