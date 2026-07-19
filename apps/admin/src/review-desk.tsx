import {
  Check,
  CheckCircle,
  Clock,
  Play as PlayIcon,
  Refresh,
  Search,
  WarningTriangle,
  Xmark,
  XmarkCircle,
} from 'iconoir-react';
import {
  auditActionLabel,
  formatTime,
  getApproveBlockReason,
  sourceLabel,
  type AuditEntry,
  type ModerationItem,
  type QueueStatus,
  type RiskLevel,
} from './safety-desk-model';
import { formatExternalUrlLabel } from './safety-desk-preview-security';
import { InfoCell } from './safety-desk-ui';

export function ReviewDesk({
  auditEntries,
  busyItemId,
  filter,
  query,
  selectedItem,
  visibleItems,
  onApprove,
  onFilterChange,
  onQueryChange,
  onRecheck,
  onReject,
  onSelect,
}: {
  auditEntries: AuditEntry[];
  busyItemId: string | null;
  filter: 'all' | QueueStatus;
  query: string;
  selectedItem: ModerationItem | undefined;
  visibleItems: ModerationItem[];
  onApprove: (itemId: string) => void;
  onFilterChange: (filter: 'all' | QueueStatus) => void;
  onQueryChange: (query: string) => void;
  onRecheck: (itemId: string) => void;
  onReject: (itemId: string) => void;
  onSelect: (itemId: string) => void;
}) {
  return (
    <section className="desk-grid">
      <section className="queue-panel" id="queue" aria-label="Очередь">
        <div className="queue-toolbar">
          <label className="search-field">
            <Search width={17} height={17} />
            <input
              value={query}
              onChange={(event) => onQueryChange(event.target.value)}
              placeholder="Поиск"
            />
          </label>
          <div className="segmented" aria-label="Фильтр статуса">
            {[
              ['all', 'Все'],
              ['review', 'Новые'],
              ['approved', 'Ок'],
              ['rejected', 'Стоп'],
              ['blocked', 'Блок'],
            ].map(([value, label]) => (
              <button
                key={value}
                className={filter === value ? 'is-active' : ''}
                type="button"
                onClick={() => onFilterChange(value as 'all' | QueueStatus)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="queue-list">
          {visibleItems.map((item) => (
            <button
              key={item.id}
              className={`queue-item ${selectedItem?.id === item.id ? 'is-selected' : ''}`}
              type="button"
              onClick={() => onSelect(item.id)}
            >
              <span className={`risk-dot is-${item.risk}`} />
              <span className="queue-item__body">
                <span className="queue-item__title">{item.title}</span>
                <span className="queue-item__meta">
                  {item.entity} · {sourceLabel(item.source)}
                </span>
              </span>
              <StatusBadge status={item.status} />
            </button>
          ))}
        </div>
      </section>

      <section className="detail-column" aria-label="Публикация">
        {selectedItem ? (
          <ReviewDetails
            item={selectedItem}
            busy={busyItemId === selectedItem.id}
            onApprove={onApprove}
            onReject={onReject}
            onRecheck={onRecheck}
          />
        ) : (
          <article className="empty-card">
            <h2>Пусто</h2>
            <p>Под выбранный фильтр ничего нет.</p>
          </article>
        )}

        <section className="audit-section" id="audit">
          <div className="audit-head">
            <Clock width={16} height={16} />
            <strong>Журнал</strong>
          </div>
          <div className="audit-list">
            {auditEntries.length > 0 ? (
              auditEntries.slice(0, 6).map((entry) => (
                <div className="audit-row" key={entry.id}>
                  <span>{entry.createdAt}</span>
                  <strong>{auditActionLabel(entry.action)}</strong>
                  <em>{entry.title}</em>
                </div>
              ))
            ) : (
              <div className="audit-row">
                <span>{formatTime(new Date())}</span>
                <strong>Нет действий</strong>
                <em />
              </div>
            )}
          </div>
        </section>
      </section>
    </section>
  );
}

function ReviewDetails({
  item,
  busy,
  onApprove,
  onReject,
  onRecheck,
}: {
  item: ModerationItem;
  busy: boolean;
  onApprove: (itemId: string) => void;
  onReject: (itemId: string) => void;
  onRecheck: (itemId: string) => void;
}) {
  const approveBlockReason = getApproveBlockReason(item);
  const canApprove = !approveBlockReason && item.status !== 'approved';

  return (
    <article className="review-card" aria-label="Детали проверки">
      <header className="review-card__header">
        <div className="review-card__title">
          <div className="badge-row">
            <StatusBadge status={item.status} />
            <RiskBadge risk={item.risk} />
          </div>
          <h2>{item.title}</h2>
        </div>
      </header>

      <div className="review-meta">
        <InfoCell label="Куда" value={item.entity} />
        <InfoCell label="Источник" value={sourceLabel(item.source)} />
        <InfoCell label="Автор" value={item.author} />
        <InfoCell label="Время" value={item.scheduledAt} />
      </div>

      <PublicationPreview item={item} />

      <div className="review-inspector">
        <section className="detail-block">
          <h3>Триггеры</h3>
          <div className="reason-list">
            {item.reasons.length > 0 ? (
              item.reasons.map((reason) => <span key={reason}>{reason}</span>)
            ) : (
              <span>Нет</span>
            )}
          </div>
        </section>

        <section className="detail-block">
          <h3>Проверки</h3>
          <div className="check-list">
            {item.checks.map((check) => (
              <div className={`check-row is-${check.state}`} key={check.label}>
                {check.state === 'blocked' ? (
                  <XmarkCircle width={16} height={16} />
                ) : check.state === 'warning' ? (
                  <WarningTriangle width={16} height={16} />
                ) : (
                  <CheckCircle width={16} height={16} />
                )}
                <span>{check.label}</span>
              </div>
            ))}
          </div>
        </section>

        <section className="detail-block">
          <h3>Домены</h3>
          <div className="domain-list">
            {item.domains.length > 0 ? (
              item.domains.map((domain) => <span key={domain}>{domain}</span>)
            ) : (
              <span>Нет</span>
            )}
          </div>
        </section>
      </div>

      <footer className="review-actions">
        <div className="action-status" aria-live="polite">
          {busy ? 'Выполняю действие...' : (approveBlockReason ?? 'Готово')}
        </div>
        <button
          className="secondary-action"
          type="button"
          disabled={busy}
          onClick={() => void onReject(item.id)}
        >
          <Xmark width={18} height={18} />
          Отклонить
        </button>
        <button
          className="ghost-action"
          type="button"
          disabled={busy}
          onClick={() => void onRecheck(item.id)}
        >
          <Refresh width={18} height={18} />
          Проверить снова
        </button>
        <button
          className="primary-action"
          type="button"
          disabled={busy || !canApprove}
          onClick={() => void onApprove(item.id)}
          title={approveBlockReason ?? 'Одобрить и опубликовать'}
        >
          <Check width={18} height={18} />
          {busy ? 'Выполняю' : 'Одобрить'}
        </button>
      </footer>
    </article>
  );
}

function PublicationPreview({ item }: { item: ModerationItem }) {
  return (
    <section className="publication-preview" aria-labelledby="publication-preview-title">
      <h3 id="publication-preview-title">Публикация</h3>

      <article className="message-preview" aria-label="Текст публикации">
        <div className="message-preview__chrome">
          <span />
          <strong>{item.entity}</strong>
        </div>
        {item.previewHtml ? (
          <div
            className="message-preview__body"
            dangerouslySetInnerHTML={{ __html: item.previewHtml }}
          />
        ) : (
          <p>{item.text || 'Текст отсутствует.'}</p>
        )}
      </article>

      {item.photoUrls.length > 0 && (
        <div className="media-grid" aria-label="Фото публикации">
          {item.photoUrls.map((photoUrl, index) => (
            <a
              className="media-tile"
              href={photoUrl}
              key={`${photoUrl}-${index}`}
              target="_blank"
              rel="noreferrer"
              aria-label={`Открыть фото ${index + 1}`}
            >
              <img src={photoUrl} alt="" loading="lazy" />
              <span>{index + 1}</span>
            </a>
          ))}
        </div>
      )}

      {item.videoUrls.length > 0 && (
        <div className="media-grid" aria-label="Видео публикации">
          {item.videoUrls.map((videoUrl, index) => (
            <a
              className="media-tile media-tile--video"
              href={videoUrl}
              key={`${videoUrl}-${index}`}
              target="_blank"
              rel="noreferrer"
              aria-label={`Открыть видео ${index + 1}`}
            >
              <PlayIcon />
              <span>{index + 1}</span>
            </a>
          ))}
        </div>
      )}

      {(item.photoUrls.length > 0 ||
        item.videoUrls.length > 0 ||
        item.originalUrl ||
        item.linkUrls.length > 0) && (
        <div className="attachment-preview">
          {item.photoUrls.length > 0 && <span>Фото: {item.photoUrls.length}</span>}
          {item.videoUrls.length > 0 && <span>Видео: {item.videoUrls.length}</span>}
          {item.linkUrls.map((linkUrl) => (
            <a href={linkUrl} key={linkUrl} target="_blank" rel="noreferrer">
              {formatExternalUrlLabel(linkUrl)}
            </a>
          ))}
          {item.originalUrl && (
            <a href={item.originalUrl} target="_blank" rel="noreferrer">
              Открыть источник
            </a>
          )}
        </div>
      )}
    </section>
  );
}

function StatusBadge({ status }: { status: QueueStatus }) {
  const labels: Record<QueueStatus, string> = {
    review: 'На проверке',
    approved: 'Одобрено',
    rejected: 'Отклонено',
    blocked: 'Блок',
  };

  return <span className={`status-badge is-${status}`}>{labels[status]}</span>;
}

function RiskBadge({ risk }: { risk: RiskLevel }) {
  const labels: Record<RiskLevel, string> = {
    low: 'Низкий риск',
    medium: 'Средний риск',
    high: 'Высокий риск',
    blocked: 'Заблокировано',
  };

  return <span className={`risk-badge is-${risk}`}>{labels[risk]}</span>;
}
