import type { LegacyPublicationSummary } from '@maxim/contracts/publication';
import { NavArrowRight } from 'iconoir-react';
import { Link, useLocation } from 'react-router-dom';
import { formatRussianCountLabel } from '../../lib/broadcast-audience';
import {
  buildLegacyPublicationNavigationState,
  buildLegacyPublicationSettingsPath,
  canOpenLegacyPublication,
} from './legacy-autoposts';
import './legacy-publications-panel.css';

type LegacyPublicationsEntryProps = {
  count: number | null;
  countIncomplete: boolean;
  onOpen: () => void;
};

type LegacyPublicationsListProps = {
  items: LegacyPublicationSummary[];
};

const STATUS_LABELS: Record<LegacyPublicationSummary['status'], string> = {
  ACTIVE: 'Активен',
  PAUSED: 'Пауза',
  COMPLETED: 'Завершён',
  ERROR: 'Ошибка',
  PARTIAL: 'Частично',
  FAILED: 'Ошибка',
  CANCELED: 'Отменён',
};

export function getLegacyPublicationStatusLabel(
  status: LegacyPublicationSummary['status'],
): string {
  return STATUS_LABELS[status];
}

function getLegacyPublicationTitle(item: LegacyPublicationSummary): string {
  return item.title.trim() || item.contentPreview.trim() || item.source.title.trim() || 'Пост';
}

function formatLegacyPublicationDate(value: string, timezone: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    return 'Время не определено';
  }
  const options: Intl.DateTimeFormatOptions = {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  };
  try {
    return new Intl.DateTimeFormat('ru-RU', { ...options, timeZone: timezone }).format(date);
  } catch {
    return new Intl.DateTimeFormat('ru-RU', options).format(date);
  }
}

export function LegacyPublicationsEntry({
  count,
  countIncomplete,
  onOpen,
}: LegacyPublicationsEntryProps) {
  return (
    <button type="button" className="legacy-publications-entry" onClick={onOpen}>
      <span className="legacy-publications-entry__copy">
        <strong>Ранее созданные</strong>
        <small>Старые расписания и отправки</small>
      </span>
      <span className="legacy-publications-entry__count">
        {count === null ? '...' : `${count}${countIncomplete ? '+' : ''}`}
      </span>
      <NavArrowRight aria-hidden />
    </button>
  );
}

export function LegacyPublicationsList({ items }: LegacyPublicationsListProps) {
  const location = useLocation();
  const navigationState = buildLegacyPublicationNavigationState(location.pathname, location.search);
  return (
    <div className="legacy-publications-list">
      {items.map((item) => {
        const title = getLegacyPublicationTitle(item);
        const kindLabel = item.kind === 'autopost' ? 'Автопост' : 'Отправка';
        const sourceTitle =
          item.source.title.trim() || (item.source.entityType === 'channel' ? 'Канал' : 'Чат');
        const displayedAt = item.nextRunAt ?? item.updatedAt;
        const timingLabel = item.nextRunAt ? 'Следующая отправка' : 'Обновлено';
        const formattedAt = formatLegacyPublicationDate(displayedAt, item.scheduleTimezone);
        const content = (
          <>
            <span className={`legacy-publications-row__status is-${item.status.toLowerCase()}`}>
              {getLegacyPublicationStatusLabel(item.status)}
            </span>
            <span className="legacy-publications-row__copy">
              <strong>{title}</strong>
              <small>
                <span className="legacy-publications-row__kind">{kindLabel}</span>
                <span className="legacy-publications-row__meta">
                  {sourceTitle} ·{' '}
                  {formatRussianCountLabel(
                    item.targetCount,
                    'получатель',
                    'получателя',
                    'получателей',
                  )}
                </span>
              </small>
            </span>
            <time
              dateTime={displayedAt}
              aria-label={`${timingLabel}: ${formattedAt}`}
              title={`${timingLabel}: ${formattedAt}`}
            >
              {formattedAt}
            </time>
          </>
        );
        return canOpenLegacyPublication(item) ? (
          <Link
            key={`${item.kind}:${item.id}`}
            className="legacy-publications-row"
            to={buildLegacyPublicationSettingsPath(item)}
            state={navigationState}
          >
            {content}
            <NavArrowRight aria-hidden />
          </Link>
        ) : (
          <div key={`${item.kind}:${item.id}`} className="legacy-publications-row is-read-only">
            {content}
          </div>
        );
      })}
    </div>
  );
}
