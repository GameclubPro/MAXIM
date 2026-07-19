import { Check, Search } from 'iconoir-react';
import type { SupportStatus, SupportTicket } from './safety-desk-model';
import { resolveSupportAttachmentUrl } from './safety-desk-preview-security';
import { InfoCell } from './safety-desk-ui';

export function SupportDesk({
  busyItemId,
  filter,
  query,
  selectedItem,
  visibleItems,
  onClose,
  onFilterChange,
  onQueryChange,
  onSelect,
}: {
  busyItemId: string | null;
  filter: 'all' | SupportStatus;
  query: string;
  selectedItem: SupportTicket | undefined;
  visibleItems: SupportTicket[];
  onClose: (itemId: string) => void;
  onFilterChange: (filter: 'all' | SupportStatus) => void;
  onQueryChange: (query: string) => void;
  onSelect: (itemId: string) => void;
}) {
  return (
    <section className="desk-grid support-grid">
      <section className="queue-panel" aria-label="Обращения">
        <div className="queue-toolbar">
          <label className="search-field">
            <Search width={17} height={17} />
            <input
              value={query}
              onChange={(event) => onQueryChange(event.target.value)}
              placeholder="Поиск"
            />
          </label>
          <div className="segmented" aria-label="Фильтр обращений">
            {[
              ['new', 'Новые'],
              ['closed', 'Закрытые'],
              ['all', 'Все'],
            ].map(([value, label]) => (
              <button
                key={value}
                className={filter === value ? 'is-active' : ''}
                type="button"
                onClick={() => onFilterChange(value as 'all' | SupportStatus)}
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
              <span className={`risk-dot is-${item.status === 'new' ? 'medium' : 'low'}`} />
              <span className="queue-item__body">
                <span className="queue-item__title">{item.userName || item.userId}</span>
                <span className="queue-item__meta">
                  {item.createdAt} · {item.attachments.length > 0 ? 'есть фото' : 'текст'}
                </span>
              </span>
              <SupportStatusBadge status={item.status} />
            </button>
          ))}
        </div>
      </section>

      <section className="support-detail-column" aria-label="Обращение">
        {selectedItem ? (
          <SupportDetails
            item={selectedItem}
            busy={busyItemId === selectedItem.id}
            onClose={onClose}
          />
        ) : (
          <article className="empty-card">
            <h2>Пусто</h2>
            <p>Новых обращений нет.</p>
          </article>
        )}
      </section>
    </section>
  );
}

function SupportDetails({
  item,
  busy,
  onClose,
}: {
  item: SupportTicket;
  busy: boolean;
  onClose: (itemId: string) => void;
}) {
  return (
    <article className="review-card support-card" aria-label="Детали обращения">
      <header className="review-card__header">
        <div className="review-card__title">
          <div className="badge-row">
            <SupportStatusBadge status={item.status} />
            <span className="risk-badge is-low">{item.createdAt}</span>
          </div>
          <h2>{item.userName || item.userId}</h2>
        </div>
      </header>

      <div className="review-meta support-meta">
        <InfoCell label="Пользователь" value={item.userId} />
        <InfoCell label="Чат" value={item.privateChatId} />
        <InfoCell label="Бот" value={item.botId || 'Не указан'} />
        <InfoCell label="Сообщение" value={item.messageId || 'Не указано'} />
      </div>

      <section className="publication-preview support-preview" aria-label="Текст обращения">
        <article className="message-preview">
          <div className="message-preview__chrome">
            <span />
            <strong>Обращение</strong>
          </div>
          <p>{item.text || 'Текст отсутствует.'}</p>
        </article>

        {item.attachments.length > 0 && (
          <div className="media-grid" aria-label="Вложения обращения">
            {item.attachments.map((attachment, index) => (
              <SupportAttachmentTile
                attachment={attachment}
                index={index}
                key={`${attachment.url ?? attachment.fileName ?? attachment.type}-${index}`}
              />
            ))}
          </div>
        )}
      </section>

      <footer className="review-actions">
        <div className="action-status" aria-live="polite">
          {busy ? 'Закрываю...' : item.status === 'closed' ? 'Закрыто' : 'Новое обращение'}
        </div>
        <button
          className="primary-action"
          type="button"
          disabled={busy || item.status === 'closed'}
          onClick={() => void onClose(item.id)}
        >
          <Check width={18} height={18} />
          {busy ? 'Закрываю' : 'Закрыть'}
        </button>
      </footer>
    </article>
  );
}

function SupportAttachmentTile({
  attachment,
  index,
}: {
  attachment: SupportTicket['attachments'][number];
  index: number;
}) {
  const imageUrl = resolveSupportAttachmentUrl(attachment);
  const label = attachment.fileName || attachment.mimeType || attachment.type;

  if (imageUrl) {
    return (
      <a
        className="media-tile"
        href={imageUrl}
        target="_blank"
        rel="noreferrer"
        aria-label={`Открыть вложение ${index + 1}`}
      >
        <img src={imageUrl} alt="" loading="lazy" />
        <span>{index + 1}</span>
      </a>
    );
  }

  return (
    <div className="media-tile media-tile--file">
      <strong>{index + 1}</strong>
      <span>{label}</span>
    </div>
  );
}

function SupportStatusBadge({ status }: { status: SupportStatus }) {
  const labels: Record<SupportStatus, string> = {
    new: 'Новое',
    closed: 'Закрыто',
  };

  return <span className={`status-badge is-${status}`}>{labels[status]}</span>;
}
