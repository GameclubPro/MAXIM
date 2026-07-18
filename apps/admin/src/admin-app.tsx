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
  safetyDeskDeleteRuntimeResponseSchema,
  safetyDeskQueueResponseSchema,
  supportRequestDecisionResponseSchema,
  supportRequestQueueResponseSchema,
  type SafetyDeskAuditEntry,
  type SafetyDeskDecisionResponse,
  type SafetyDeskDeleteIntentItem,
  type SafetyDeskDeleteIntentStatus,
  type SafetyDeskDeleteRuntimeResponse,
  type SafetyDeskGiveawayWinnerNotificationDeadEndItem,
  type SafetyDeskQueueItem,
  type SafetyDeskQueueResponse,
  type SupportRequestAttachment,
  type SupportRequestDecisionResponse,
  type SupportRequestItem,
  type SupportRequestQueueResponse,
} from '@maxim/contracts';
import { useMemo, useState } from 'react';
import { createAdminRequestHeaders } from './admin-request';
import { readJsonResponse } from './api-response';
import {
  giveawayWinnerNotificationEventAt,
  giveawayWinnerNotificationStatusLabel,
  matchesGiveawayWinnerNotificationQuery,
} from './giveaway-notification-observability';

type DeskView = 'review' | 'support' | 'deletes';
type RiskLevel = 'low' | 'medium' | 'high' | 'blocked';
type QueueStatus = 'review' | 'approved' | 'rejected' | 'blocked';
type QueueSource = 'manual' | 'scheduled' | 'vk';
type SupportStatus = 'new' | 'closed';
type DeleteFilter = 'attention' | 'waiting' | 'failed' | 'observed' | 'all';

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
  previewHtml: string;
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
  const [unlocked, setUnlocked] = useState(false);
  const [code, setCode] = useState('');
  const [verifiedAccessCode, setVerifiedAccessCode] = useState('');
  const [view, setView] = useState<DeskView>('review');
  const [filter, setFilter] = useState<'all' | QueueStatus>('all');
  const [supportFilter, setSupportFilter] = useState<'all' | SupportStatus>('new');
  const [deleteFilter, setDeleteFilter] = useState<DeleteFilter>('attention');
  const [query, setQuery] = useState('');
  const [supportQuery, setSupportQuery] = useState('');
  const [deleteQuery, setDeleteQuery] = useState('');
  const [queueItems, setQueueItems] = useState<ModerationItem[]>([]);
  const [supportItems, setSupportItems] = useState<SupportTicket[]>([]);
  const [deleteRuntime, setDeleteRuntime] = useState<SafetyDeskDeleteRuntimeResponse | null>(null);
  const [auditEntries, setAuditEntries] = useState<AuditEntry[]>([]);
  const [metrics, setMetrics] = useState<Metrics>(emptyMetrics);
  const [supportMetrics, setSupportMetrics] = useState<SupportMetrics>(emptySupportMetrics);
  const [selectedId, setSelectedId] = useState('');
  const [supportSelectedId, setSupportSelectedId] = useState('');
  const [deleteSelectedId, setDeleteSelectedId] = useState('');
  const [notice, setNotice] = useState('Готово к проверке');
  const [loading, setLoading] = useState(false);
  const [busyItemId, setBusyItemId] = useState<string | null>(null);
  const [busySupportId, setBusySupportId] = useState<string | null>(null);
  const [busyAmbiguousSendId, setBusyAmbiguousSendId] = useState<string | null>(null);
  const [busyDeleteIntentId, setBusyDeleteIntentId] = useState<string | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);

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

  const visibleDeleteItems = useMemo(() => {
    const normalizedQuery = deleteQuery.trim().toLowerCase();
    return (deleteRuntime?.items ?? []).filter((item) => {
      const matchesStatus = matchesDeleteFilter(item.status, deleteFilter);
      const matchesQuery =
        normalizedQuery.length === 0 ||
        [
          item.id,
          item.chatId,
          item.chatTitle,
          item.messageId,
          item.subjectUserId ?? '',
          item.originBotId ?? '',
          item.effectiveRoutingPolicy,
          item.lastBotId ?? '',
          item.deleteDispatchStartedBotId ?? '',
          item.remoteDeleteSucceededBotId ?? '',
          item.lastErrorCode ?? '',
          item.lastError ?? '',
          ...item.reasons.flatMap((reason) => [reason.reasonKey, reason.ruleCode]),
          ...item.capability.memberships.flatMap((membership) => [
            membership.botId,
            membership.reason,
          ]),
        ]
          .join(' ')
          .toLowerCase()
          .includes(normalizedQuery);

      return matchesStatus && matchesQuery;
    });
  }, [deleteFilter, deleteQuery, deleteRuntime]);

  const selectedItem = visibleItems.find((item) => item.id === selectedId) ?? visibleItems[0];
  const selectedSupportItem =
    visibleSupportItems.find((item) => item.id === supportSelectedId) ?? visibleSupportItems[0];
  const selectedDeleteItem =
    visibleDeleteItems.find((item) => item.id === deleteSelectedId) ?? visibleDeleteItems[0];
  const isReviewScopeFiltered = filter !== 'all' || query.trim().length > 0;
  const visibleReviewItems = useMemo(
    () => visibleItems.filter((item) => item.status === 'review' && !getApproveBlockReason(item)),
    [visibleItems],
  );
  const bulkReviewCount = visibleReviewItems.length;

  async function unlock() {
    const candidate = code.trim();
    if (!candidate) {
      setNotice('Введите код доступа');
      return;
    }

    const loaded = await refreshQueue('Очередь загружена', candidate);
    if (loaded) {
      setVerifiedAccessCode(candidate);
      setUnlocked(true);
      setCode('');
      return;
    }

    setNotice('Неверный код доступа или API недоступен');
  }

  async function refreshQueue(
    successMessage = 'Очередь обновлена с сервера',
    requestAccessCode = verifiedAccessCode,
  ): Promise<boolean> {
    if (!requestAccessCode) {
      setNotice('Введите код доступа');
      return false;
    }
    setLoading(true);
    try {
      const [queueResult, supportResult, deleteResult] = await Promise.allSettled([
        fetchQueue(requestAccessCode),
        fetchSupportQueue(requestAccessCode),
        fetchDeleteRuntime(requestAccessCode),
      ]);
      if (queueResult.status === 'fulfilled') {
        applyQueueResponse(queueResult.value);
      }
      if (supportResult.status === 'fulfilled') {
        applySupportQueueResponse(supportResult.value);
      }
      if (deleteResult.status === 'fulfilled') {
        applyDeleteRuntimeResponse(deleteResult.value);
      }

      if (
        queueResult.status === 'fulfilled' &&
        supportResult.status === 'fulfilled' &&
        deleteResult.status === 'fulfilled'
      ) {
        setNotice(successMessage);
        return true;
      }

      const errors = [queueResult, supportResult, deleteResult]
        .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .map((result) => readErrorMessage(result.reason));
      const loaded = [
        queueResult.status === 'fulfilled' ? 'публикации' : null,
        supportResult.status === 'fulfilled' ? 'обращения' : null,
        deleteResult.status === 'fulfilled' ? 'удаления' : null,
      ].filter(Boolean);
      setNotice(
        loaded.length > 0
          ? `Частично обновлено: ${loaded.join(', ')}. ${errors.join('; ')}`
          : errors.join('; '),
      );
      return loaded.length > 0;
    } catch (error) {
      setNotice(readErrorMessage(error));
      return false;
    } finally {
      setLoading(false);
    }
  }

  async function closeSupportItem(itemId: string) {
    setBusySupportId(itemId);
    setNotice('Закрываю обращение');
    try {
      const response = await postSupportDecision(itemId, 'close', verifiedAccessCode);
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

  async function allowAmbiguousSendRetry(
    item: SafetyDeskDeleteRuntimeResponse['ambiguousSends'][number],
  ) {
    if (
      !window.confirm(
        'Разрешить повторную публикацию? Сначала убедитесь в MAX, что предыдущая отправка не появилась.',
      )
    ) {
      return;
    }
    if (!item.messageId) {
      setNotice('У операции отсутствует идентификатор отправки');
      return;
    }
    setBusyAmbiguousSendId(item.id);
    setNotice('Снимаю блокировку повторной публикации');
    try {
      applyDeleteRuntimeResponse(await postAllowAmbiguousSendRetry(item, verifiedAccessCode));
      setNotice('Повторная публикация правил разрешена');
    } catch (error) {
      setNotice(readErrorMessage(error));
    } finally {
      setBusyAmbiguousSendId(null);
    }
  }

  async function retryDeleteIntent(item: SafetyDeskDeleteIntentItem) {
    if (item.status !== 'EXPIRED' && item.status !== 'FAILED_TERMINAL') {
      return;
    }
    if (
      !window.confirm(
        'Поставить удаление в очередь повторно? Действие будет записано в аудит и не обходит проверку MAX.',
      )
    ) {
      return;
    }
    setBusyDeleteIntentId(item.id);
    setNotice('Возвращаю удаление в безопасную очередь');
    try {
      applyDeleteRuntimeResponse(
        await postRetryDeleteIntent(
          item.id,
          item.status,
          item.updatedAt,
          item.attemptCount,
          verifiedAccessCode,
        ),
      );
      setNotice('Удаление возвращено в очередь');
    } catch (error) {
      setNotice(readErrorMessage(error));
    } finally {
      setBusyDeleteIntentId(null);
    }
  }

  async function approveAllVisible() {
    const reviewCount = bulkReviewCount;
    if (reviewCount === 0) {
      setNotice('Нет материалов для массового одобрения');
      return;
    }

    const itemIds = visibleReviewItems.map((item) => item.id);
    const scopeLabel = isReviewScopeFiltered ? 'видимые материалы' : 'загруженную очередь проверки';
    if (!window.confirm(`Одобрить ${scopeLabel}? Материалов: ${reviewCount}.`)) {
      return;
    }

    setBulkBusy(true);
    setNotice(isReviewScopeFiltered ? 'Одобряю видимые материалы' : 'Одобряю материалы из очереди');
    try {
      const response = await postApproveAll(itemIds, verifiedAccessCode);
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
      const response = await postDecision(itemId, action, verifiedAccessCode);
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

  function applyDeleteRuntimeResponse(
    response: SafetyDeskDeleteRuntimeResponse,
    preferredId = deleteSelectedId,
  ) {
    setDeleteRuntime(response);
    const hasPreferred = preferredId && response.items.some((item) => item.id === preferredId);
    setDeleteSelectedId(hasPreferred ? preferredId : (response.items[0]?.id ?? ''));
  }

  function exportForMax() {
    const exportedAt = new Date().toISOString();
    const payload =
      view === 'deletes'
        ? { exportedAt, deleteRuntime }
        : view === 'support'
          ? { exportedAt, summary: supportMetrics, queue: supportItems }
          : { exportedAt, summary: metrics, queue: queueItems, audit: auditEntries };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `maxim-safety-desk-${view}-${new Date().toISOString().slice(0, 10)}.json`;
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
          {notice !== 'Готово к проверке' && (
            <p className="auth-alert" aria-live="polite">
              {notice}
            </p>
          )}
          <label className="auth-field">
            <span>Код доступа</span>
            <input
              value={code}
              onChange={(event) => setCode(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  void unlock();
                }
              }}
              type="password"
              autoComplete="current-password"
              placeholder="Введите код"
              disabled={loading}
            />
          </label>
          <button
            className="primary-action"
            type="button"
            disabled={loading}
            onClick={() => void unlock()}
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
            aria-pressed={view === 'review'}
            onClick={() => setView('review')}
          >
            Публикации
          </button>
          <button
            className={view === 'support' ? 'is-active' : ''}
            type="button"
            aria-pressed={view === 'support'}
            onClick={() => setView('support')}
          >
            Обращения
          </button>
          <button
            className={view === 'deletes' ? 'is-active' : ''}
            type="button"
            aria-pressed={view === 'deletes'}
            onClick={() => setView('deletes')}
          >
            Удаления
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
          ) : view === 'support' ? (
            <>
              <Metric label="Новые" value={String(supportMetrics.new)} tone="warning" />
              <Metric label="Закрытые" value={String(supportMetrics.closed)} tone="success" />
            </>
          ) : (
            <>
              <Metric
                label="Режим"
                value={deleteRolloutModeLabel(deleteRuntime?.rolloutMode ?? 'off')}
                tone="neutral"
              />
              <Metric
                label="Открыто"
                value={String(deleteRuntime?.summary.open ?? 0)}
                tone="warning"
              />
              <Metric
                label="Просрочено"
                value={String(deleteRuntime?.summary.due.count ?? 0)}
                tone="danger"
              />
              <Metric
                label="Зависло"
                value={String(deleteRuntime?.summary.staleLeases.count ?? 0)}
                tone="danger"
              />
              <Metric
                label="Неясные отправки"
                value={String(deleteRuntime?.summary.ambiguousSends.count ?? 0)}
                tone="danger"
              />
              <Metric
                label="DM победителям"
                value={String(deleteRuntime?.summary.giveawayWinnerNotificationDeadEnds.count ?? 0)}
                tone="danger"
              />
              <Metric
                label="Ошибки"
                value={String(deleteRuntime?.summary.failed ?? 0)}
                tone="danger"
              />
              <Metric
                label="Старейшее"
                value={
                  deleteRuntime?.summary.oldestOpen.ageMs === null ||
                  deleteRuntime?.summary.oldestOpen.ageMs === undefined
                    ? 'Нет'
                    : formatDuration(deleteRuntime.summary.oldestOpen.ageMs)
                }
                tone="neutral"
              />
            </>
          )}
        </div>
        <div className="topbar__actions">
          {view === 'review' && (
            <button
              className="primary-action"
              type="button"
              disabled={loading || bulkBusy || bulkReviewCount === 0}
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
      ) : view === 'support' ? (
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
      ) : (
        <DeleteDesk
          busyAmbiguousSendId={busyAmbiguousSendId}
          busyDeleteIntentId={busyDeleteIntentId}
          filter={deleteFilter}
          query={deleteQuery}
          runtime={deleteRuntime}
          selectedItem={selectedDeleteItem}
          visibleItems={visibleDeleteItems}
          onFilterChange={setDeleteFilter}
          onAllowAmbiguousSendRetry={allowAmbiguousSendRetry}
          onQueryChange={setDeleteQuery}
          onSelect={setDeleteSelectedId}
          onRetryDeleteIntent={retryDeleteIntent}
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

function DeleteDesk({
  busyAmbiguousSendId,
  busyDeleteIntentId,
  filter,
  query,
  runtime,
  selectedItem,
  visibleItems,
  onFilterChange,
  onAllowAmbiguousSendRetry,
  onQueryChange,
  onRetryDeleteIntent,
  onSelect,
}: {
  busyAmbiguousSendId: string | null;
  busyDeleteIntentId: string | null;
  filter: DeleteFilter;
  query: string;
  runtime: SafetyDeskDeleteRuntimeResponse | null;
  selectedItem: SafetyDeskDeleteIntentItem | undefined;
  visibleItems: SafetyDeskDeleteIntentItem[];
  onFilterChange: (filter: DeleteFilter) => void;
  onAllowAmbiguousSendRetry: (
    item: SafetyDeskDeleteRuntimeResponse['ambiguousSends'][number],
  ) => void;
  onQueryChange: (query: string) => void;
  onRetryDeleteIntent: (item: SafetyDeskDeleteIntentItem) => void;
  onSelect: (itemId: string) => void;
}) {
  const giveawayWinnerNotificationDeadEnds = (
    runtime?.giveawayWinnerNotificationDeadEnds ?? []
  ).filter((item) => matchesGiveawayWinnerNotificationQuery(item, query));

  return (
    <section className="desk-grid delete-grid">
      <section className="queue-panel" aria-label="Диагностика удалений">
        <div className="queue-toolbar delete-toolbar">
          <label className="search-field">
            <Search width={17} height={17} />
            <input
              value={query}
              onChange={(event) => onQueryChange(event.target.value)}
              placeholder="Чат, сообщение, ошибка"
            />
          </label>
          <div className="segmented" aria-label="Фильтр удалений">
            {[
              ['attention', 'Открытые'],
              ['waiting', 'Права'],
              ['failed', 'Ошибки'],
              ['observed', 'Shadow'],
              ['all', 'Все'],
            ].map(([value, label]) => (
              <button
                key={value}
                className={filter === value ? 'is-active' : ''}
                type="button"
                aria-pressed={filter === value}
                onClick={() => onFilterChange(value as DeleteFilter)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="queue-list">
          {runtime && runtime.summary.giveawayWinnerNotificationDeadEnds.count > 0 && (
            <section
              className="ambiguous-send-strip giveaway-notification-strip"
              aria-label="Сбои уведомлений победителям"
            >
              <header>
                <strong>Уведомления победителям</strong>
                <span>{runtime.summary.giveawayWinnerNotificationDeadEnds.count}</span>
              </header>
              <div>
                {giveawayWinnerNotificationDeadEnds.map((item) => (
                  <article
                    className="ambiguous-send-row giveaway-notification-row"
                    key={item.notificationId}
                    title={item.lastError ?? undefined}
                  >
                    <span className="risk-dot is-high" />
                    <span>
                      <strong>{item.giveawayTitle || item.giveawayId}</strong>
                      <small>
                        Чат {item.sourceChatId} · пользователь {item.userId}
                      </small>
                      <small>
                        notification {item.notificationId} · winner {item.winnerId}
                      </small>
                      <small>{item.lastError || 'Ошибка не зафиксирована'}</small>
                    </span>
                    <span className="giveaway-notification-row__meta">
                      <GiveawayWinnerNotificationStatusBadge status={item.status} />
                      <code>{item.botId || 'bot неизвестен'}</code>
                      <small>
                        попыток {item.attemptCount} ·{' '}
                        {formatDateTime(new Date(giveawayWinnerNotificationEventAt(item)))}
                      </small>
                    </span>
                  </article>
                ))}
                {giveawayWinnerNotificationDeadEnds.length === 0 && (
                  <div className="delete-empty-line">Под строку поиска уведомлений нет.</div>
                )}
              </div>
            </section>
          )}
          {runtime && runtime.ambiguousSends.length > 0 && (
            <section className="ambiguous-send-strip" aria-label="Неясные отправки MAX">
              <header>
                <strong>Неясные отправки MAX</strong>
                <span>{runtime.ambiguousSends.length}</span>
              </header>
              <div>
                {runtime.ambiguousSends.slice(0, 10).map((item) => (
                  <article className="ambiguous-send-row" key={item.id} title={item.lastError}>
                    <span className="risk-dot is-high" />
                    <span>
                      <strong>{item.chatTitle || item.chatId}</strong>
                      <small>
                        {ambiguousSendSourceLabel(item.source)} ·{' '}
                        {item.messageId || 'ID не получен'}
                      </small>
                    </span>
                    <span className="ambiguous-send-row__actions">
                      <code>{item.botId || 'bot неизвестен'}</code>
                      {item.source === 'chat_rules' && (
                        <button
                          className="icon-action"
                          type="button"
                          disabled={busyAmbiguousSendId === item.id || !item.messageId}
                          title="Разрешить повторную публикацию после проверки MAX"
                          aria-label="Разрешить повторную публикацию после проверки MAX"
                          onClick={() => onAllowAmbiguousSendRetry(item)}
                        >
                          <Refresh width={15} height={15} />
                        </button>
                      )}
                    </span>
                  </article>
                ))}
              </div>
            </section>
          )}
          {visibleItems.map((item) => (
            <button
              key={item.id}
              className={`queue-item delete-queue-item ${selectedItem?.id === item.id ? 'is-selected' : ''}`}
              type="button"
              aria-pressed={selectedItem?.id === item.id}
              onClick={() => onSelect(item.id)}
            >
              <span className={`risk-dot is-${deleteStatusTone(item.status)}`} />
              <span className="queue-item__body">
                <span className="queue-item__title">{item.chatTitle || item.chatId}</span>
                <span className="queue-item__meta">
                  {formatDuration(item.ageMs)} · попыток {item.attemptCount}
                </span>
              </span>
              <DeleteStatusBadge status={item.status} />
            </button>
          ))}
          {visibleItems.length === 0 && (
            <div className="queue-empty">
              {runtime ? 'Под выбранный фильтр записей нет.' : 'Диагностика загружается.'}
            </div>
          )}
        </div>
      </section>

      <section className="delete-detail-column" aria-label="Состояние удаления">
        {selectedItem ? (
          <DeleteDetails
            item={selectedItem}
            busy={busyDeleteIntentId === selectedItem.id}
            onRetry={onRetryDeleteIntent}
          />
        ) : (
          <article className="empty-card">
            <h2>Пусто</h2>
            <p>Открытых или завершившихся ошибкой удалений нет.</p>
          </article>
        )}
      </section>
    </section>
  );
}

function DeleteDetails({
  item,
  busy,
  onRetry,
}: {
  item: SafetyDeskDeleteIntentItem;
  busy: boolean;
  onRetry: (item: SafetyDeskDeleteIntentItem) => void;
}) {
  const terminal = item.status === 'EXPIRED' || item.status === 'FAILED_TERMINAL';
  return (
    <article className="review-card delete-card" aria-label="Детали удаления">
      <header className="review-card__header">
        <div className="review-card__title">
          <div className="badge-row">
            <DeleteStatusBadge status={item.status} />
            <span className={`risk-badge ${item.capability.confirmed ? 'is-low' : 'is-high'}`}>
              {item.capability.confirmed ? 'Право подтверждено' : 'Нет подтвержденного права'}
            </span>
            <span className="risk-badge is-neutral">{deleteRolloutLabel(item.rollout)}</span>
          </div>
          <h2>{item.chatTitle || item.chatId}</h2>
        </div>
      </header>

      <div className="review-meta delete-meta">
        <InfoCell label="Чат" value={item.chatId} />
        <InfoCell label="Сообщение" value={item.messageId} />
        <InfoCell label="Возраст" value={formatDuration(item.ageMs)} />
        <InfoCell label="Попытки" value={String(item.attemptCount)} />
        <InfoCell label="Тип" value={item.entityType ?? 'Не определен'} />
        <InfoCell label="Маршрут" value={item.routingState} />
        <InfoCell
          label="Эффективная политика"
          value={deleteRoutingPolicyLabel(item.effectiveRoutingPolicy)}
        />
        <InfoCell label="Заданная политика" value={deleteRoutingPolicyLabel(item.routingPolicy)} />
        <InfoCell label="Cross-bot" value={item.crossBotEnabled ? 'Разрешён' : 'Выключен'} />
        <InfoCell label="Исходный бот" value={item.originBotId || 'Не указан'} />
      </div>

      <div className="delete-detail-scroll">
        <section className="delete-section">
          <div className="delete-section__head">
            <h3>Активные боты</h3>
            <span>{item.capability.activeMembershipCount}</span>
          </div>
          <div className="delete-capability-list">
            {item.capability.memberships.length > 0 ? (
              item.capability.memberships.map((membership) => (
                <div className="delete-capability-row" key={membership.botId}>
                  <div>
                    <strong>{membership.botId}</strong>
                    <span>{membership.role === 'PRIMARY' ? 'Основной' : 'Резервный'}</span>
                  </div>
                  <div>
                    <strong>{deleteCapabilityStateLabel(membership.state)}</strong>
                    <span>{deleteCapabilityReasonLabel(membership.reason)}</span>
                  </div>
                  <div>
                    <strong>{membership.accessState}</strong>
                    <span>
                      Runtime {membership.botRuntimeState} ·{' '}
                      {membership.checkedAt
                        ? `проверено ${formatDateTime(new Date(membership.checkedAt))}`
                        : 'время проверки неизвестно'}
                    </span>
                  </div>
                  <code>{membership.permissions.join(', ') || 'нет permissions'}</code>
                </div>
              ))
            ) : (
              <div className="delete-empty-line">Активных membership нет.</div>
            )}
          </div>
        </section>

        <section className="delete-section delete-section--split">
          <div>
            <div className="delete-section__head">
              <h3>Причины</h3>
              <span>{item.reasons.length}</span>
            </div>
            <div className="delete-reason-list">
              {item.reasons.length > 0 ? (
                item.reasons.map((reason) => (
                  <div key={`${reason.reasonKey}-${reason.createdAt}`}>
                    <strong>{reason.ruleCode}</strong>
                    <span>{reason.reasonKey}</span>
                  </div>
                ))
              ) : (
                <div className="delete-empty-line">Причины не записаны.</div>
              )}
            </div>
          </div>
          <div>
            <div className="delete-section__head">
              <h3>Последняя ошибка</h3>
              {item.lastStatusCode !== null && <span>HTTP {item.lastStatusCode}</span>}
            </div>
            <div className="delete-error">
              <strong>{item.lastErrorCode || 'Нет кода ошибки'}</strong>
              <p>{item.lastError || 'Ошибка не зафиксирована.'}</p>
            </div>
          </div>
        </section>

        <section className="delete-section">
          <div className="delete-section__head">
            <h3>Временная шкала</h3>
          </div>
          <dl className="delete-timeline">
            <div>
              <dt>Создано</dt>
              <dd>{formatDateTime(new Date(item.createdAt))}</dd>
            </div>
            <div>
              <dt>Следующая попытка</dt>
              <dd>{formatDateTime(new Date(item.nextAttemptAt))}</dd>
            </div>
            <div>
              <dt>Повторять до</dt>
              <dd>{formatDateTime(new Date(item.retryUntilAt))}</dd>
            </div>
            <div>
              <dt>Последняя попытка</dt>
              <dd>
                {item.lastAttemptAt ? formatDateTime(new Date(item.lastAttemptAt)) : 'Еще не было'}
              </dd>
            </div>
            <div>
              <dt>Lease до</dt>
              <dd>
                {item.leaseExpiresAt
                  ? formatDateTime(new Date(item.leaseExpiresAt))
                  : 'Нет активного lease'}
              </dd>
            </div>
            <div>
              <dt>Незакрытый dispatch</dt>
              <dd>
                {item.deleteDispatchStartedAt
                  ? `${formatDateTime(new Date(item.deleteDispatchStartedAt))} · ${item.deleteDispatchStartedBotId || 'бот неизвестен'}`
                  : 'Нет'}
              </dd>
            </div>
            <div>
              <dt>Подтверждение MAX</dt>
              <dd>
                {item.remoteDeleteSucceededAt
                  ? `${formatDateTime(new Date(item.remoteDeleteSucceededAt))} · ${item.remoteDeleteSucceededBotId || 'бот неизвестен'}`
                  : 'Не зафиксировано'}
              </dd>
            </div>
            <div>
              <dt>Последний бот</dt>
              <dd>{item.lastBotId || 'Не выбран'}</dd>
            </div>
          </dl>
        </section>
      </div>
      {terminal && (
        <footer className="review-actions">
          <div className="action-status" aria-live="polite">
            {item.rollout === 'execute'
              ? busy
                ? 'Возвращаю в очередь...'
                : 'Повтор сохранит историю попыток и dispatch fence.'
              : 'Сначала включите chat в canary или global rollout.'}
          </div>
          <button
            className="primary-action"
            type="button"
            disabled={busy || item.rollout !== 'execute'}
            onClick={() => onRetry(item)}
          >
            <Refresh width={18} height={18} />
            {busy ? 'Возвращаю' : 'Повторить удаление'}
          </button>
        </footer>
      )}
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
      <strong title={value}>{value}</strong>
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

function DeleteStatusBadge({ status }: { status: SafetyDeskDeleteIntentStatus }) {
  const labels: Record<SafetyDeskDeleteIntentStatus, string> = {
    OBSERVED: 'Shadow',
    PENDING: 'Ожидает',
    IN_PROGRESS: 'Выполняется',
    RETRYABLE: 'Повтор',
    WAITING_CAPABILITY: 'Нет права',
    AMBIGUOUS: 'Неясно',
    SUCCEEDED: 'Удалено',
    ALREADY_ABSENT: 'Уже отсутствует',
    EXPIRED: 'Истекло',
    FAILED_TERMINAL: 'Ошибка',
  };
  const statusClass = status.toLowerCase().replaceAll('_', '-');

  return <span className={`status-badge is-delete-${statusClass}`}>{labels[status]}</span>;
}

function GiveawayWinnerNotificationStatusBadge({
  status,
}: {
  status: SafetyDeskGiveawayWinnerNotificationDeadEndItem['status'];
}) {
  const statusClass = status.toLowerCase().replaceAll('_', '-');
  return (
    <span className={`status-badge is-delete-${statusClass}`}>
      {giveawayWinnerNotificationStatusLabel(status)}
    </span>
  );
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

async function fetchQueue(accessCode: string): Promise<SafetyDeskQueueResponse> {
  const response = await fetch(`${safetyDeskApiBase}/queue`, {
    credentials: 'same-origin',
    headers: createAdminRequestHeaders(accessCode),
  });
  return safetyDeskQueueResponseSchema.parse(await readJsonResponse(response));
}

async function fetchDeleteRuntime(accessCode: string): Promise<SafetyDeskDeleteRuntimeResponse> {
  const response = await fetch(`${safetyDeskApiBase}/runtime/deletes`, {
    credentials: 'same-origin',
    headers: createAdminRequestHeaders(accessCode),
  });
  return safetyDeskDeleteRuntimeResponseSchema.parse(await readJsonResponse(response));
}

async function postAllowAmbiguousSendRetry(
  item: SafetyDeskDeleteRuntimeResponse['ambiguousSends'][number],
  accessCode: string,
): Promise<SafetyDeskDeleteRuntimeResponse> {
  const response = await fetch(
    `${safetyDeskApiBase}/runtime/ambiguous-sends/${encodeURIComponent(item.id)}/allow-retry`,
    {
      method: 'POST',
      credentials: 'same-origin',
      headers: createAdminRequestHeaders(accessCode, { json: true }),
      body: JSON.stringify({
        expectedOperationId: item.messageId,
        expectedStartedAt: item.startedAt,
      }),
    },
  );
  return safetyDeskDeleteRuntimeResponseSchema.parse(await readJsonResponse(response));
}

async function postRetryDeleteIntent(
  intentId: string,
  expectedStatus: 'EXPIRED' | 'FAILED_TERMINAL',
  expectedUpdatedAt: string,
  expectedAttemptCount: number,
  accessCode: string,
): Promise<SafetyDeskDeleteRuntimeResponse> {
  const response = await fetch(
    `${safetyDeskApiBase}/runtime/deletes/${encodeURIComponent(intentId)}/retry`,
    {
      method: 'POST',
      credentials: 'same-origin',
      headers: createAdminRequestHeaders(accessCode, { json: true }),
      body: JSON.stringify({
        expectedStatus,
        expectedUpdatedAt,
        expectedAttemptCount,
      }),
    },
  );
  return safetyDeskDeleteRuntimeResponseSchema.parse(await readJsonResponse(response));
}

async function fetchSupportQueue(accessCode: string): Promise<SupportRequestQueueResponse> {
  const response = await fetch(`${supportRequestsApiBase}/queue`, {
    credentials: 'same-origin',
    headers: createAdminRequestHeaders(accessCode),
  });
  return supportRequestQueueResponseSchema.parse(await readJsonResponse(response));
}

async function postDecision(
  itemId: string,
  action: 'approve' | 'reject' | 'recheck',
  accessCode: string,
): Promise<SafetyDeskDecisionResponse> {
  const response = await fetch(
    `${safetyDeskApiBase}/items/${encodeURIComponent(itemId)}/${action}`,
    {
      method: 'POST',
      credentials: 'same-origin',
      headers: createAdminRequestHeaders(accessCode, { json: true }),
      body: JSON.stringify({}),
    },
  );
  return safetyDeskDecisionResponseSchema.parse(await readJsonResponse(response));
}

async function postApproveAll(
  itemIds: string[],
  accessCode: string,
): Promise<SafetyDeskDecisionResponse> {
  const response = await fetch(`${safetyDeskApiBase}/queue/approve-all`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: createAdminRequestHeaders(accessCode, { json: true }),
    body: JSON.stringify({ itemIds }),
  });
  return safetyDeskDecisionResponseSchema.parse(await readJsonResponse(response));
}

async function postSupportDecision(
  itemId: string,
  action: 'close',
  accessCode: string,
): Promise<SupportRequestDecisionResponse> {
  const response = await fetch(
    `${supportRequestsApiBase}/items/${encodeURIComponent(itemId)}/${action}`,
    {
      method: 'POST',
      credentials: 'same-origin',
      headers: createAdminRequestHeaders(accessCode, { json: true }),
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
    previewHtml: item.previewHtml,
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

function matchesDeleteFilter(status: SafetyDeskDeleteIntentStatus, filter: DeleteFilter): boolean {
  if (filter === 'all') {
    return true;
  }
  if (filter === 'observed') {
    return status === 'OBSERVED';
  }
  if (filter === 'waiting') {
    return status === 'WAITING_CAPABILITY';
  }
  if (filter === 'failed') {
    return status === 'EXPIRED' || status === 'FAILED_TERMINAL';
  }
  return ['PENDING', 'IN_PROGRESS', 'RETRYABLE', 'WAITING_CAPABILITY', 'AMBIGUOUS'].includes(
    status,
  );
}

function deleteStatusTone(
  status: SafetyDeskDeleteIntentStatus,
): 'low' | 'medium' | 'high' | 'neutral' {
  if (status === 'SUCCEEDED' || status === 'ALREADY_ABSENT') {
    return 'low';
  }
  if (status === 'OBSERVED') {
    return 'neutral';
  }
  if (status === 'PENDING' || status === 'IN_PROGRESS' || status === 'RETRYABLE') {
    return 'medium';
  }
  return 'high';
}

function deleteRolloutModeLabel(mode: SafetyDeskDeleteRuntimeResponse['rolloutMode']): string {
  const labels: Record<SafetyDeskDeleteRuntimeResponse['rolloutMode'], string> = {
    off: 'Выкл',
    shadow: 'Shadow',
    canary: 'Canary',
    on: 'Вкл',
  };
  return labels[mode];
}

function ambiguousSendSourceLabel(
  source: SafetyDeskDeleteRuntimeResponse['ambiguousSends'][number]['source'],
): string {
  const labels: Record<typeof source, string> = {
    channel_auto_post: 'Копия поста канала',
    chat_auto_comment: 'Копия сообщения чата',
    chat_rules: 'Публикация правил',
  };
  return labels[source];
}

function deleteRolloutLabel(rollout: SafetyDeskDeleteIntentItem['rollout']): string {
  if (rollout === 'execute') {
    return 'Исполнение';
  }
  if (rollout === 'observed') {
    return 'Наблюдение';
  }
  return 'Выключено';
}

function deleteRoutingPolicyLabel(policy: SafetyDeskDeleteIntentItem['routingPolicy']): string {
  if (policy === 'delete_capable') {
    return 'Любой с правом';
  }
  if (policy === 'origin_first') {
    return 'Сначала исходный';
  }
  return 'Только исходный';
}

function deleteCapabilityStateLabel(
  state: SafetyDeskDeleteIntentItem['capability']['memberships'][number]['state'],
): string {
  if (state === 'confirmed_capable') {
    return 'Может удалить';
  }
  if (state === 'explicitly_incapable') {
    return 'Не может удалить';
  }
  return 'Нужна свежая проверка';
}

function deleteCapabilityReasonLabel(
  reason: SafetyDeskDeleteIntentItem['capability']['memberships'][number]['reason'],
): string {
  const labels: Record<
    SafetyDeskDeleteIntentItem['capability']['memberships'][number]['reason'],
    string
  > = {
    confirmed: 'Права подтверждены',
    snapshot_missing: 'Нет снимка прав',
    snapshot_stale: 'Снимок прав устарел',
    access_denied: 'Доступ потерян или запрещен',
    access_state_unconfirmed: 'Статус администратора не подтвержден',
    bot_not_actionable: 'Бот не исполняет действия',
    not_admin_or_owner: 'Бот не администратор',
    missing_chat_delete_permission: 'Нет write для чата',
    missing_channel_delete_permission: 'Нет delete для канала',
  };
  return labels[reason];
}

function formatDuration(durationMs: number): string {
  const seconds = Math.max(0, Math.floor(durationMs / 1_000));
  if (seconds < 60) {
    return `${seconds} сек`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes} мин`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours} ч ${minutes % 60} мин`;
  }
  const days = Math.floor(hours / 24);
  return `${days} д ${hours % 24} ч`;
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
