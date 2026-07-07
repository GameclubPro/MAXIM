import {
  Check,
  CheckCircle,
  Clock,
  Download,
  Lock,
  Play as PlayIcon,
  Refresh,
  Search,
  WarningTriangle,
  Xmark,
  XmarkCircle,
} from 'iconoir-react';
import {
  safetyDeskDecisionResponseSchema,
  safetyDeskQueueResponseSchema,
  supportRequestDecisionResponseSchema,
  supportRequestQueueResponseSchema,
  type SafetyDeskAuditEntry,
  type SafetyDeskDecisionResponse,
  type SafetyDeskQueueItem,
  type SafetyDeskQueueResponse,
  type SupportRequestAttachment,
  type SupportRequestDecisionResponse,
  type SupportRequestItem,
  type SupportRequestQueueResponse,
} from '@maxim/contracts';
import { useEffect, useMemo, useState } from 'react';
import { readJsonResponse } from './api-response';

type DeskView = 'review' | 'support';
type RiskLevel = 'low' | 'medium' | 'high' | 'blocked';
type QueueStatus = 'review' | 'approved' | 'rejected' | 'blocked';
type QueueSource = 'manual' | 'scheduled' | 'vk';
type SupportStatus = 'new' | 'closed';

type ModerationItem = {
  id: string;
  title: string;
  source: QueueSource;
  status: QueueStatus;
  risk: RiskLevel;
  entity: string;
  author: string;
  scheduledAt: string;
  text: string;
  domains: string[];
  photoUrls: string[];
  videoUrls: string[];
  linkUrls: string[];
  originalUrl: string | null;
  reasons: string[];
  checks: Array<{ label: string; state: 'passed' | 'warning' | 'blocked' }>;
};

type AuditEntry = {
  id: string;
  itemId: string | null;
  title: string;
  action: string;
  createdAt: string;
};

type Metrics = {
  review: number;
  approved: number;
  stopped: number;
  servicePosts: number;
};

type SupportMetrics = {
  new: number;
  closed: number;
};

type SupportTicket = {
  id: string;
  status: SupportStatus;
  userId: string;
  userName: string;
  privateChatId: string;
  botId: string;
  messageId: string;
  text: string;
  attachments: SupportRequestAttachment[];
  createdAt: string;
  closedAt: string;
};

const configuredAccessCode = import.meta.env.VITE_ADMIN_ACCESS_CODE?.trim() ?? '';
const accessCode = configuredAccessCode || (import.meta.env.DEV ? 'maxim-local' : '');
const isAccessCodeConfigured = accessCode.length > 0;
const safetyDeskApiBase = '/api/v1/safety-desk';
const supportRequestsApiBase = '/api/v1/support-requests';

const emptyMetrics: Metrics = {
  review: 0,
  approved: 0,
  stopped: 0,
  servicePosts: 0,
};

const emptySupportMetrics: SupportMetrics = {
  new: 0,
  closed: 0,
};

export function AdminApp() {
  const [unlocked, setUnlocked] = useState(
    () => isAccessCodeConfigured && sessionStorage.getItem('maxim-admin') === '1',
  );
  const [code, setCode] = useState('');
  const [view, setView] = useState<DeskView>('review');
  const [filter, setFilter] = useState<'all' | QueueStatus>('all');
  const [supportFilter, setSupportFilter] = useState<'all' | SupportStatus>('new');
  const [query, setQuery] = useState('');
  const [supportQuery, setSupportQuery] = useState('');
  const [queueItems, setQueueItems] = useState<ModerationItem[]>([]);
  const [supportItems, setSupportItems] = useState<SupportTicket[]>([]);
  const [auditEntries, setAuditEntries] = useState<AuditEntry[]>([]);
  const [metrics, setMetrics] = useState<Metrics>(emptyMetrics);
  const [supportMetrics, setSupportMetrics] = useState<SupportMetrics>(emptySupportMetrics);
  const [selectedId, setSelectedId] = useState('');
  const [supportSelectedId, setSupportSelectedId] = useState('');
  const [notice, setNotice] = useState('Готово к проверке');
  const [loading, setLoading] = useState(false);
  const [busyItemId, setBusyItemId] = useState<string | null>(null);
  const [busySupportId, setBusySupportId] = useState<string | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);

  useEffect(() => {
    if (!unlocked) {
      return;
    }

    void refreshQueue('Очередь загружена');
  }, [unlocked]);

  const visibleItems = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return queueItems.filter((item) => {
      const matchesStatus = filter === 'all' || item.status === filter;
      const matchesQuery =
        normalizedQuery.length === 0 ||
        [item.title, item.entity, item.author, item.text, ...item.domains]
          .join(' ')
          .toLowerCase()
          .includes(normalizedQuery);

      return matchesStatus && matchesQuery;
    });
  }, [filter, query, queueItems]);

  const visibleSupportItems = useMemo(() => {
    const normalizedQuery = supportQuery.trim().toLowerCase();
    return supportItems.filter((item) => {
      const matchesStatus = supportFilter === 'all' || item.status === supportFilter;
      const matchesQuery =
        normalizedQuery.length === 0 ||
        [item.userId, item.userName, item.privateChatId, item.botId, item.messageId, item.text]
          .join(' ')
          .toLowerCase()
          .includes(normalizedQuery);

      return matchesStatus && matchesQuery;
    });
  }, [supportFilter, supportItems, supportQuery]);

  const selectedItem = visibleItems.find((item) => item.id === selectedId) ?? visibleItems[0];
  const selectedSupportItem =
    visibleSupportItems.find((item) => item.id === supportSelectedId) ?? visibleSupportItems[0];

  function unlock() {
    if (!isAccessCodeConfigured) {
      setNotice('Код доступа не настроен');
      return;
    }

    if (code.trim() === accessCode) {
      sessionStorage.setItem('maxim-admin', '1');
      setUnlocked(true);
      setNotice('Загружаю живую очередь проверки');
      return;
    }

    setNotice('Неверный код доступа');
  }

  async function refreshQueue(successMessage = 'Очередь обновлена с сервера') {
    setLoading(true);
    try {
      const [queueResponse, supportResponse] = await Promise.all([
        fetchQueue(),
        fetchSupportQueue(),
      ]);
      applyQueueResponse(queueResponse);
      applySupportQueueResponse(supportResponse);
      setNotice(successMessage);
    } catch (error) {
      setNotice(readErrorMessage(error));
    } finally {
      setLoading(false);
    }
  }

  async function closeSupportItem(itemId: string) {
    setBusySupportId(itemId);
    setNotice('Закрываю обращение');
    try {
      const response = await postSupportDecision(itemId, 'close');
      applySupportQueueResponse(response.queue, response.item?.id ?? itemId);
      setNotice(response.message);
    } catch (error) {
      setNotice(readErrorMessage(error));
    } finally {
      setBusySupportId(null);
    }
  }

  async function approveItem(itemId: string) {
    await runDecision(itemId, 'approve', 'Публикую материал после одобрения');
  }

  async function rejectItem(itemId: string) {
    await runDecision(itemId, 'reject', 'Отклоняю материал без отправки в MAX');
  }

  async function recheckItem(itemId: string) {
    await runDecision(itemId, 'recheck', 'Возвращаю материал на повторную проверку');
  }

  async function approveAllVisible() {
    const reviewCount = metrics.review;
    if (reviewCount === 0) {
      setNotice('Нет материалов для массового одобрения');
      return;
    }

    if (!window.confirm(`Одобрить всю очередь проверки? Материалов: ${reviewCount}.`)) {
      return;
    }

    setBulkBusy(true);
    setNotice('Одобряю материалы из очереди');
    try {
      const response = await postApproveAll();
      applyQueueResponse(response.queue);
      setNotice(response.message);
    } catch (error) {
      setNotice(readErrorMessage(error));
    } finally {
      setBulkBusy(false);
    }
  }

  async function runDecision(
    itemId: string,
    action: 'approve' | 'reject' | 'recheck',
    progressMessage: string,
  ) {
    setBusyItemId(itemId);
    setNotice(progressMessage);
    try {
      const response = await postDecision(itemId, action);
      applyQueueResponse(response.queue, response.item?.id ?? itemId);
      setNotice(response.message);
    } catch (error) {
      setNotice(readErrorMessage(error));
    } finally {
      setBusyItemId(null);
    }
  }

  function applyQueueResponse(response: SafetyDeskQueueResponse, preferredId = selectedId) {
    const nextItems = response.items.map(mapQueueItem);
    setQueueItems(nextItems);
    setAuditEntries(response.audit.map(mapAuditEntry));
    setMetrics({
      review: response.summary.review,
      approved: response.summary.approved,
      stopped: response.summary.rejected + response.summary.blocked,
      servicePosts: response.summary.servicePosts,
    });

    const hasPreferred = preferredId && nextItems.some((item) => item.id === preferredId);
    setSelectedId(hasPreferred ? preferredId : (nextItems[0]?.id ?? ''));
  }

  function applySupportQueueResponse(
    response: SupportRequestQueueResponse,
    preferredId = supportSelectedId,
  ) {
    const nextItems = response.items.map(mapSupportItem);
    setSupportItems(nextItems);
    setSupportMetrics({
      new: response.summary.new,
      closed: response.summary.closed,
    });

    const hasPreferred = preferredId && nextItems.some((item) => item.id === preferredId);
    setSupportSelectedId(hasPreferred ? preferredId : (nextItems[0]?.id ?? ''));
  }

  function exportForMax() {
    const payload = {
      exportedAt: new Date().toISOString(),
      summary: metrics,
      queue: queueItems,
      audit: auditEntries,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `maxim-safety-desk-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(url);
    setNotice('Экспорт текущей очереди подготовлен и скачан');
  }

  if (!unlocked) {
    return (
      <main className="auth-shell">
        <section className="auth-panel" aria-labelledby="auth-title">
          <div className="auth-panel__mark">
            <Lock width={24} height={24} />
          </div>
          <h1 id="auth-title">Safety Desk</h1>
          {!isAccessCodeConfigured && (
            <p className="auth-alert" role="alert">
              Код доступа не настроен.
            </p>
          )}
          <label className="auth-field">
            <span>Код доступа</span>
            <input
              value={code}
              onChange={(event) => setCode(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  unlock();
                }
              }}
              type="password"
              autoComplete="current-password"
              placeholder="Введите код"
              disabled={!isAccessCodeConfigured}
            />
          </label>
          <button
            className="primary-action"
            type="button"
            disabled={!isAccessCodeConfigured}
            onClick={unlock}
          >
            <Check width={18} height={18} />
            Войти
          </button>
        </section>
      </main>
    );
  }

  return (
    <main className="desk-shell">
      <header className="desk-topbar">
        <div className="desk-title">
          <strong>Safety Desk</strong>
          <span>{loading ? 'Обновляю...' : notice}</span>
        </div>
        <div className="view-switch" aria-label="Раздел">
          <button
            className={view === 'review' ? 'is-active' : ''}
            type="button"
            onClick={() => setView('review')}
          >
            Публикации
          </button>
          <button
            className={view === 'support' ? 'is-active' : ''}
            type="button"
            onClick={() => setView('support')}
          >
            Обращения
          </button>
        </div>
        <div className="desk-metrics" aria-label="Сводка">
          {view === 'review' ? (
            <>
              <Metric label="К проверке" value={String(metrics.review)} tone="warning" />
              <Metric label="Ок" value={String(metrics.approved)} tone="success" />
              <Metric label="Стоп" value={String(metrics.stopped)} tone="danger" />
              <Metric label="Сервис" value={String(metrics.servicePosts)} tone="neutral" />
            </>
          ) : (
            <>
              <Metric label="Новые" value={String(supportMetrics.new)} tone="warning" />
              <Metric label="Закрытые" value={String(supportMetrics.closed)} tone="success" />
            </>
          )}
        </div>
        <div className="topbar__actions">
          {view === 'review' && (
            <button
              className="primary-action"
              type="button"
              disabled={loading || bulkBusy || metrics.review === 0}
              onClick={() => void approveAllVisible()}
            >
              <Check width={18} height={18} />
              {bulkBusy ? 'Одобряю' : 'Одобрить все'}
            </button>
          )}
          <button
            className="ghost-action icon-action"
            type="button"
            disabled={loading || bulkBusy}
            onClick={() => void refreshQueue()}
            title="Обновить"
            aria-label="Обновить"
          >
            <Refresh width={18} height={18} />
          </button>
          <button className="ghost-action" type="button" onClick={exportForMax}>
            <Download width={18} height={18} />
            Экспорт
          </button>
        </div>
      </header>

      {view === 'review' ? (
        <ReviewDesk
          auditEntries={auditEntries}
          busyItemId={busyItemId}
          filter={filter}
          query={query}
          selectedItem={selectedItem}
          visibleItems={visibleItems}
          onApprove={approveItem}
          onFilterChange={setFilter}
          onQueryChange={setQuery}
          onRecheck={recheckItem}
          onReject={rejectItem}
          onSelect={setSelectedId}
        />
      ) : (
        <SupportDesk
          busyItemId={busySupportId}
          filter={supportFilter}
          query={supportQuery}
          selectedItem={selectedSupportItem}
          visibleItems={visibleSupportItems}
          onClose={closeSupportItem}
          onFilterChange={setSupportFilter}
          onQueryChange={setSupportQuery}
          onSelect={setSupportSelectedId}
        />
      )}
    </main>
  );
}

function Metric({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: 'success' | 'warning' | 'danger' | 'neutral';
}) {
  return (
    <article className={`metric-card is-${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
  );
}

function ReviewDesk({
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

function SupportDesk({
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
  attachment: SupportRequestAttachment;
  index: number;
}) {
  const imageUrl = resolveAttachmentUrl(attachment);
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

function PublicationPreview({ item }: { item: ModerationItem }) {
  return (
    <section className="publication-preview" aria-labelledby="publication-preview-title">
      <h3 id="publication-preview-title">Публикация</h3>

      <article className="message-preview" aria-label="Текст публикации">
        <div className="message-preview__chrome">
          <span />
          <strong>{item.entity}</strong>
        </div>
        <p>{item.text || 'Текст отсутствует.'}</p>
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
              {formatLinkLabel(linkUrl)}
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

function InfoCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="info-cell">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
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

function SupportStatusBadge({ status }: { status: SupportStatus }) {
  const labels: Record<SupportStatus, string> = {
    new: 'Новое',
    closed: 'Закрыто',
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

function sourceLabel(source: QueueSource) {
  if (source === 'vk') {
    return 'Внешний источник';
  }

  if (source === 'scheduled') {
    return 'Запланировано';
  }

  return 'Ручная публикация';
}

async function fetchQueue(): Promise<SafetyDeskQueueResponse> {
  const response = await fetch(`${safetyDeskApiBase}/queue`, {
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
  });
  return safetyDeskQueueResponseSchema.parse(await readJsonResponse(response));
}

async function fetchSupportQueue(): Promise<SupportRequestQueueResponse> {
  const response = await fetch(`${supportRequestsApiBase}/queue`, {
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
  });
  return supportRequestQueueResponseSchema.parse(await readJsonResponse(response));
}

async function postDecision(
  itemId: string,
  action: 'approve' | 'reject' | 'recheck',
): Promise<SafetyDeskDecisionResponse> {
  const response = await fetch(
    `${safetyDeskApiBase}/items/${encodeURIComponent(itemId)}/${action}`,
    {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    },
  );
  return safetyDeskDecisionResponseSchema.parse(await readJsonResponse(response));
}

async function postApproveAll(): Promise<SafetyDeskDecisionResponse> {
  const response = await fetch(`${safetyDeskApiBase}/queue/approve-all`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({}),
  });
  return safetyDeskDecisionResponseSchema.parse(await readJsonResponse(response));
}

async function postSupportDecision(
  itemId: string,
  action: 'close',
): Promise<SupportRequestDecisionResponse> {
  const response = await fetch(
    `${supportRequestsApiBase}/items/${encodeURIComponent(itemId)}/${action}`,
    {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    },
  );
  return supportRequestDecisionResponseSchema.parse(await readJsonResponse(response));
}

function mapQueueItem(item: SafetyDeskQueueItem): ModerationItem {
  return {
    id: item.id,
    title: item.title,
    source: item.source === 'VK_REVIEW' ? 'vk' : 'scheduled',
    status: mapStatus(item.status),
    risk: mapRisk(item.risk),
    entity: item.entityTitle,
    author: item.author || item.sourceTitle,
    scheduledAt: item.scheduledAt
      ? formatDateTime(new Date(item.scheduledAt))
      : `Импортировано ${formatDateTime(new Date(item.createdAt))}`,
    text: item.text,
    domains: item.domains,
    photoUrls: item.photoUrls,
    videoUrls: item.videoUrls,
    linkUrls: item.linkUrls,
    originalUrl: item.originalUrl,
    reasons: item.reasons,
    checks: item.checks.map((check) => ({
      label: check.label,
      state: check.state.toLowerCase() as 'passed' | 'warning' | 'blocked',
    })),
  };
}

function mapAuditEntry(entry: SafetyDeskAuditEntry): AuditEntry {
  return {
    id: entry.id,
    itemId: entry.itemId,
    title: entry.title,
    action: entry.action,
    createdAt: formatTime(new Date(entry.createdAt)),
  };
}

function mapSupportItem(item: SupportRequestItem): SupportTicket {
  return {
    id: item.id,
    status: item.status === 'CLOSED' ? 'closed' : 'new',
    userId: item.userId,
    userName: item.userName ?? '',
    privateChatId: item.privateChatId,
    botId: item.botId ?? '',
    messageId: item.messageId ?? '',
    text: item.text,
    attachments: item.attachments,
    createdAt: formatDateTime(new Date(item.createdAt)),
    closedAt: item.closedAt ? formatDateTime(new Date(item.closedAt)) : '',
  };
}

function mapStatus(status: SafetyDeskQueueItem['status']): QueueStatus {
  if (status === 'APPROVED') {
    return 'approved';
  }
  if (status === 'REJECTED') {
    return 'rejected';
  }
  if (status === 'BLOCKED') {
    return 'blocked';
  }
  return 'review';
}

function mapRisk(risk: SafetyDeskQueueItem['risk']): RiskLevel {
  if (risk === 'BLOCKED') {
    return 'blocked';
  }
  return risk.toLowerCase() as RiskLevel;
}

function getApproveBlockReason(item: ModerationItem): string | null {
  if (item.status === 'approved') {
    return 'Материал уже одобрен.';
  }

  const blockedCheck = item.checks.find((check) => check.state === 'blocked');
  if (blockedCheck) {
    return blockedCheck.label;
  }

  return null;
}

function formatDateTime(date: Date): string {
  if (!Number.isFinite(date.getTime())) {
    return 'Время не указано';
  }

  return date.toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

function formatLinkLabel(linkUrl: string): string {
  try {
    const parsed = new URL(linkUrl);
    return parsed.hostname || linkUrl;
  } catch {
    return linkUrl;
  }
}

function resolveAttachmentUrl(attachment: SupportRequestAttachment): string | null {
  if (attachment.url) {
    return attachment.url;
  }

  const payload = attachment.payload;
  if (!payload) {
    return null;
  }

  const candidates = [
    payload.url,
    payload.preview_url,
    payload.previewUrl,
    payload.thumbnail_url,
    payload.thumbnailUrl,
    payload.src,
    payload.href,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && /^https?:\/\//i.test(candidate.trim())) {
      return candidate.trim();
    }
  }

  return null;
}

function auditActionLabel(action: string): string {
  const labels: Record<string, string> = {
    SAFETY_DESK_APPROVE: 'Одобрено',
    SAFETY_DESK_REJECT: 'Отклонено',
    SAFETY_DESK_RECHECK: 'Повторная проверка',
  };

  return labels[action] ?? action;
}

function readErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return 'Не удалось выполнить действие. Проверь соединение и попробуй еще раз.';
}
