import type {
  BroadcastHistoryCounts,
  BroadcastHistoryFilter,
} from '../lib/broadcast-history-filters';
import { cn } from '../lib/cn';
import { MaxMarkdownPreview } from './max-markdown-preview';
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

type BroadcastDraftCardProps = {
  preview: string;
  facts: string[];
  disabled?: boolean;
  onOpen: () => void;
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
        { value: 'compose', label: 'Автопост' },
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
        { value: 'future', label: 'Запланировано', count: counts.future },
        { value: 'active', label: 'В работе', count: counts.active },
        { value: 'error', label: 'Ошибки', count: counts.error },
        { value: 'sent', label: 'Опубликовано', count: counts.sent },
        { value: 'canceled', label: 'Стоп', count: counts.canceled },
      ]}
    />
  );
}

export function BroadcastDraftCard({
  preview,
  facts,
  disabled = false,
  onOpen,
  onReset,
}: BroadcastDraftCardProps) {
  const normalizedPreview = preview.trim();

  return (
    <div className={cn('managed-broadcast-card', 'is-warning', 'is-editable')}>
      <button
        type="button"
        className="managed-broadcast-card__surface"
        onClick={onOpen}
        disabled={disabled}
      >
        <div className="managed-broadcast-card__top">
          <span className="managed-broadcast-card__main">
            <span className="managed-broadcast-card__headline">
              <span className={cn('managed-broadcast-card__badge', 'is-warning')}>Черновик</span>
              <strong>Автопост не запущен</strong>
            </span>
            {normalizedPreview ? (
              <MaxMarkdownPreview
                value={normalizedPreview}
                className="managed-broadcast-card__preview max-markdown-preview--clamp-2"
                normalizeWhitespace
              />
            ) : (
              <span className="managed-broadcast-card__preview">Пусто</span>
            )}
          </span>
          <span className="managed-broadcast-card__aside">
            <span className={cn('managed-broadcast-card__metric', 'is-warning')}>
              <small>Статус</small>
              <strong>Черновик</strong>
              <span>Не запущен</span>
            </span>
          </span>
        </div>

        {facts.length > 0 ? (
          <div className="managed-broadcast-card__facts">
            {facts.map((fact) => (
              <span key={`broadcast-draft-${fact}`}>{fact}</span>
            ))}
          </div>
        ) : null}
      </button>

      <div className="managed-broadcast-card__actions">
        <button type="button" className="button button--ghost" onClick={onOpen} disabled={disabled}>
          Открыть
        </button>
        <button
          type="button"
          className="button button--ghost"
          onClick={onReset}
          disabled={disabled}
        >
          Очистить
        </button>
      </div>
    </div>
  );
}
