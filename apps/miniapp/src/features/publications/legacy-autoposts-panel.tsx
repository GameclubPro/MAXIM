import type { ManagedAutopostHubRuleSummary, ManagedAutopostRuleStatus } from '@maxim/contracts';
import { NavArrowDown, NavArrowRight } from 'iconoir-react';
import { Link } from 'react-router-dom';
import { buildLegacyAutopostSettingsPath } from './legacy-autoposts';
import './legacy-autoposts-panel.css';

type LegacyAutopostsPanelProps = {
  rules: ManagedAutopostHubRuleSummary[];
};

const STATUS_LABELS: Record<ManagedAutopostRuleStatus, string> = {
  ACTIVE: 'Активен',
  PAUSED: 'Пауза',
  COMPLETED: 'Завершён',
  ERROR: 'Ошибка',
  DISABLED: 'Выключен',
};

function formatNextSendAt(value: string | null): string {
  if (!value) {
    return 'Без даты';
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    return 'Без даты';
  }
  return new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

export function LegacyAutopostsPanel({ rules }: LegacyAutopostsPanelProps) {
  if (rules.length === 0) {
    return null;
  }

  return (
    <details className="legacy-autoposts">
      <summary>
        <span>
          <strong>Ранее созданные</strong>
          <small>{rules.length}</small>
        </span>
        <NavArrowDown aria-hidden />
      </summary>
      <div className="legacy-autoposts__list">
        {rules.map((rule) => {
          const sourceTitle =
            rule.sourcePreview.title.trim() || (rule.entityType === 'channel' ? 'Канал' : 'Чат');
          const title = rule.title.trim() || sourceTitle;
          return (
            <Link
              key={rule.id}
              className="legacy-autoposts__row"
              to={buildLegacyAutopostSettingsPath(rule)}
              aria-label={`Открыть автопост «${title}»`}
            >
              <span className={`legacy-autoposts__status is-${rule.status.toLowerCase()}`}>
                {STATUS_LABELS[rule.status]}
              </span>
              <span className="legacy-autoposts__copy">
                <strong>{title}</strong>
                <small>{sourceTitle}</small>
              </span>
              <time dateTime={rule.nextSendAt ?? undefined}>
                {formatNextSendAt(rule.nextSendAt)}
              </time>
              <NavArrowRight aria-hidden />
            </Link>
          );
        })}
      </div>
    </details>
  );
}
