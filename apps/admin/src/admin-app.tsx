import {
  Calendar,
  Check,
  CheckCircle,
  Clock,
  Eye,
  Filter,
  Lock,
  NavArrowRight,
  Refresh,
  Search,
  SettingsProfiles,
  ShieldCheck,
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

const policySteps = [
  {
    title: 'Тихая предварительная проверка',
    body: 'Контент проверяется на сервере до отправки в MAX. Если риск низкий, публикация проходит без дополнительного шага для администратора.',
  },
  {
    title: 'Очередь только для ответственных',
    body: 'Спорные материалы остаются в закрытой панели. В чатах не появляются служебные сообщения, отметки проверки или уведомления о задержке.',
  },
  {
    title: 'Точный журнал решений',
    body: 'Для каждой проверки фиксируются автор, цель, домены, вердикт, версия политики и хэш контента. Это можно показать поддержке MAX.',
  },
  {
    title: 'Без принудительного добавления',
    body: 'Бот публикует только в управляемые чаты и каналы, куда его добавил администратор. Пользователей он не приглашает и не добавляет.',
  },
];

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
          <p className="eyebrow">MAXIM Safety Desk</p>
          <h1 id="auth-title">Закрытая проверка автопостинга</h1>
          <p className="auth-panel__copy">
            Панель предназначена для владельца проекта и команды модерации. Проверка проходит до
            публикации, поэтому обычные пользователи не видят служебных статусов.
          </p>
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
            <ShieldCheck width={18} height={18} />
            Открыть панель
          </button>
        </section>
      </main>
    );
  }

  return (
    <main className="admin-shell">
      <aside className="sidebar" aria-label="Навигация">
        <div className="brand">
          <div className="brand__mark">
            <ShieldCheck width={24} height={24} />
          </div>
          <div>
            <strong>Safety Desk</strong>
            <span>закрытая панель</span>
          </div>
        </div>
        <nav className="nav-list">
          <a className="nav-list__item is-active" href="#queue">
            <Filter width={18} height={18} />
            Очередь проверки
          </a>
          <a className="nav-list__item" href="#policy">
            <SettingsProfiles width={18} height={18} />
            Политика
          </a>
          <a className="nav-list__item" href="#audit">
            <Clock width={18} height={18} />
            Журнал
          </a>
        </nav>
        <div className="sidebar__note">
          <b>Правило UX</b>
          <span>Если материал задержан, в MAX ничего не публикуется до решения.</span>
        </div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div>
            <p className="eyebrow">pre-publication safety</p>
            <h1>Модерация автопостинга</h1>
          </div>
          <div className="topbar__actions">
            <button
              className="ghost-action"
              type="button"
              disabled={loading}
              onClick={() => void refreshQueue()}
            >
              <Refresh width={18} height={18} />
              Обновить
            </button>
            <button className="primary-action compact" type="button" onClick={exportForMax}>
              <Check width={18} height={18} />
              Экспорт для MAX
            </button>
          </div>
        </header>

        <section className="metrics" aria-label="Сводка">
          <Metric label="Ожидают" value={String(metrics.review)} tone="warning" />
          <Metric label="Одобрено" value={String(metrics.approved)} tone="success" />
          <Metric label="Остановлено" value={String(metrics.stopped)} tone="danger" />
          <Metric
            label="Служебных постов в чатах"
            value={String(metrics.servicePosts)}
            tone="neutral"
          />
        </section>

        <div className="notice-bar" role="status">
          {loading ? 'Обновляю данные...' : notice}
        </div>

        <section className="queue-layout" id="queue">
          <div className="queue-panel">
            <div className="queue-toolbar">
              <label className="search-field">
                <Search width={17} height={17} />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Поиск по тексту, домену, чату"
                />
              </label>
              <div className="segmented" aria-label="Фильтр статуса">
                {[
                  ['all', 'Все'],
                  ['review', 'Проверка'],
                  ['approved', 'Одобрено'],
                  ['rejected', 'Отклонено'],
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
                      {sourceLabel(item.source)} · {item.entity}
                    </span>
                  </span>
                  <StatusBadge status={item.status} />
                  <NavArrowRight width={18} height={18} />
                </button>
              ))}
            </div>
          </div>

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
              <h2>Очередь пуста</h2>
              <p>Под выбранный фильтр сейчас нет материалов.</p>
            </article>
          )}
        </section>

        <section className="policy-section" id="policy">
          <div className="section-heading">
            <p className="eyebrow">MAX compliance plan</p>
            <h2>План без давления на пользователей</h2>
          </div>
          <div className="policy-grid">
            {policySteps.map((step) => (
              <article className="policy-card" key={step.title}>
                <CheckCircle width={20} height={20} />
                <h3>{step.title}</h3>
                <p>{step.body}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="audit-section" id="audit">
          <div className="section-heading">
            <p className="eyebrow">decision log</p>
            <h2>Журнал решений</h2>
          </div>
          <div className="audit-list">
            {auditEntries.length > 0 ? (
              auditEntries.map((entry) => (
                <div className="audit-row" key={entry.id}>
                  <span>{entry.createdAt}</span>
                  <strong>{auditActionLabel(entry.action)}</strong>
                  <em>{entry.title}</em>
                </div>
              ))
            ) : (
              <div className="audit-row">
                <span>{formatTime(new Date())}</span>
                <strong>Ожидание</strong>
                <em>Решений пока нет</em>
              </div>
            )}
          </div>
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
  return (
    <article className="review-card" aria-label="Детали проверки">
      <header className="review-card__header">
        <div>
          <StatusBadge status={item.status} />
          <h2>{item.title}</h2>
        </div>
        <RiskBadge risk={item.risk} />
      </header>

      <div className="review-meta">
        <span>
          <Calendar width={16} height={16} />
          {item.scheduledAt}
        </span>
        <span>
          <Eye width={16} height={16} />
          {item.entity}
        </span>
      </div>

      <PublicationPreview item={item} />

      <section className="detail-block">
        <h3>Причины проверки</h3>
        <div className="reason-list">
          {item.reasons.map((reason) => (
            <span key={reason}>{reason}</span>
          ))}
        </div>
      </section>

      <section className="detail-block">
        <h3>Проверки</h3>
        <div className="check-list">
          {item.checks.map((check) => (
            <div className={`check-row is-${check.state}`} key={check.label}>
              {check.state === 'blocked' ? (
                <XmarkCircle width={18} height={18} />
              ) : check.state === 'warning' ? (
                <WarningTriangle width={18} height={18} />
              ) : (
                <CheckCircle width={18} height={18} />
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
            <span>Нет внешних ссылок</span>
          )}
        </div>
      </section>

      <footer className="review-actions">
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
          disabled={busy || item.status === 'approved'}
          onClick={() => void onApprove(item.id)}
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
      <div className="publication-preview__head">
        <div>
          <p className="eyebrow">publication preview</p>
          <h3 id="publication-preview-title">Что будет опубликовано</h3>
        </div>
        <StatusBadge status={item.status} />
      </div>

      <div className="publication-targets" aria-label="Сведения о публикации">
        <InfoCell label="Куда" value={item.entity} />
        <InfoCell label="Источник" value={sourceLabel(item.source)} />
        <InfoCell label="Автор" value={item.author} />
        <InfoCell label="Время" value={item.scheduledAt} />
      </div>

      <article className="message-preview" aria-label="Текст публикации">
        <div className="message-preview__chrome">
          <span />
          <strong>{item.entity}</strong>
        </div>
        {item.photoUrls[0] && (
          <img className="message-preview__image" src={item.photoUrls[0]} alt="" loading="lazy" />
        )}
        <p>{item.text || 'Текст отсутствует, проверь вложения и ссылку источника.'}</p>
      </article>

      {(item.photoUrls.length > 0 || item.originalUrl) && (
        <div className="attachment-preview">
          {item.photoUrls.length > 0 && <span>Фото: {item.photoUrls.length}</span>}
          {item.originalUrl && (
            <a href={item.originalUrl} target="_blank" rel="noreferrer">
              Открыть источник
            </a>
          )}
        </div>
      )}

      <div className="publication-preview__foot">
        <span>Перед одобрением проверь текст, цель публикации и домены.</span>
        <strong>{item.domains.length > 0 ? `${item.domains.length} домена` : 'Ссылок нет'}</strong>
      </div>
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
  const response = await fetch(`${safetyDeskApiBase}/items/${encodeURIComponent(itemId)}/${action}`, {
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
    const message =
      typeof payload === 'object' &&
      payload !== null &&
      'message' in payload &&
      typeof payload.message === 'string'
        ? payload.message
        : `Ошибка API: ${response.status}`;
    throw new Error(message);
  }

  return payload;
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
