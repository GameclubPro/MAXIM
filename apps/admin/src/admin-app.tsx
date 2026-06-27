import {
  Check,
  CheckCircle,
  Clock,
  Download,
  Lock,
  Refresh,
  Search,
  WarningTriangle,
  Xmark,
  XmarkCircle,
} from 'iconoir-react';
import {
  safetyDeskDecisionResponseSchema,
  safetyDeskQueueResponseSchema,
  type SafetyDeskAuditEntry,
  type SafetyDeskDecisionResponse,
  type SafetyDeskQueueItem,
  type SafetyDeskQueueResponse,
} from '@maxim/contracts';
import { useEffect, useMemo, useState } from 'react';

type RiskLevel = 'low' | 'medium' | 'high' | 'blocked';
type QueueStatus = 'review' | 'approved' | 'rejected' | 'blocked';
type QueueSource = 'manual' | 'scheduled' | 'vk';

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

const accessCode = import.meta.env.VITE_ADMIN_ACCESS_CODE || 'maxim-local';
const safetyDeskApiBase = '/api/v1/safety-desk';

const emptyMetrics: Metrics = {
  review: 0,
  approved: 0,
  stopped: 0,
  servicePosts: 0,
};

export function AdminApp() {
  const [unlocked, setUnlocked] = useState(() => sessionStorage.getItem('maxim-admin') === '1');
  const [code, setCode] = useState('');
  const [filter, setFilter] = useState<'all' | QueueStatus>('all');
  const [query, setQuery] = useState('');
  const [queueItems, setQueueItems] = useState<ModerationItem[]>([]);
  const [auditEntries, setAuditEntries] = useState<AuditEntry[]>([]);
  const [metrics, setMetrics] = useState<Metrics>(emptyMetrics);
  const [selectedId, setSelectedId] = useState('');
  const [notice, setNotice] = useState('Готово к проверке');
  const [loading, setLoading] = useState(false);
  const [busyItemId, setBusyItemId] = useState<string | null>(null);
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

  const selectedItem = visibleItems.find((item) => item.id === selectedId) ?? visibleItems[0];

  function unlock() {
    if (code.trim() === accessCode) {
      sessionStorage.setItem('maxim-admin', '1');
      setUnlocked(true);
      setNotice('Загружаю живую очередь проверки');
    }
  }

  async function refreshQueue(successMessage = 'Очередь обновлена с сервера') {
    setLoading(true);
    try {
      const response = await fetchQueue();
      applyQueueResponse(response);
      setNotice(successMessage);
    } catch (error) {
      setNotice(readErrorMessage(error));
    } finally {
      setLoading(false);
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
            />
          </label>
          <button className="primary-action" type="button" onClick={unlock}>
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
        <div className="desk-metrics" aria-label="Сводка">
          <Metric label="К проверке" value={String(metrics.review)} tone="warning" />
          <Metric label="Ок" value={String(metrics.approved)} tone="success" />
          <Metric label="Стоп" value={String(metrics.stopped)} tone="danger" />
          <Metric label="Сервис" value={String(metrics.servicePosts)} tone="neutral" />
        </div>
        <div className="topbar__actions">
          <button
            className="primary-action"
            type="button"
            disabled={loading || bulkBusy || metrics.review === 0}
            onClick={() => void approveAllVisible()}
          >
            <Check width={18} height={18} />
            {bulkBusy ? 'Одобряю' : 'Одобрить все'}
          </button>
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

      <section className="desk-grid">
        <section className="queue-panel" id="queue" aria-label="Очередь">
          <div className="queue-toolbar">
            <label className="search-field">
              <Search width={17} height={17} />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
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
                  onClick={() => setFilter(value as 'all' | QueueStatus)}
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
                onClick={() => setSelectedId(item.id)}
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
              onApprove={approveItem}
              onReject={rejectItem}
              onRecheck={recheckItem}
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

      {(item.photoUrls.length > 0 || item.originalUrl || item.linkUrls.length > 0) && (
        <div className="attachment-preview">
          {item.photoUrls.length > 0 && <span>Фото: {item.photoUrls.length}</span>}
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

async function readJsonResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  const payload = parseJsonPayload(text);
  if (!response.ok) {
    throw new Error(readApiErrorMessage(payload, response.status));
  }

  return payload;
}

function readApiErrorMessage(payload: unknown, status: number): string {
  if (typeof payload === 'object' && payload !== null) {
    const record = payload as Record<string, unknown>;
    const message = formatApiErrorValue(record.message);
    if (message) {
      return message;
    }

    const error = formatApiErrorValue(record.error);
    if (error) {
      return error;
    }
  }

  return `Ошибка API: ${status}`;
}

function formatApiErrorValue(value: unknown): string {
  if (typeof value === 'string' && value.trim().length > 0) {
    return value.trim();
  }

  if (Array.isArray(value)) {
    return value.map(formatApiErrorValue).filter(Boolean).join('; ');
  }

  if (typeof value === 'object' && value !== null) {
    const formatted = Object.values(value as Record<string, unknown>)
      .map(formatApiErrorValue)
      .filter(Boolean)
      .join('; ');
    return formatted;
  }

  return '';
}

function parseJsonPayload(text: string): unknown {
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error('Safety Desk API недоступен или вернул некорректный ответ.');
  }
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
