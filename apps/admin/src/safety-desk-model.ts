import type {
  SafetyDeskAuditEntry,
  SafetyDeskDeleteIntentItem,
  SafetyDeskDeleteIntentStatus,
  SafetyDeskDeleteRuntimeResponse,
  SafetyDeskQueueItem,
  SafetyDeskQueueResponse,
} from '@maxim/contracts/safety-desk';
import type {
  SupportRequestAttachment,
  SupportRequestItem,
  SupportRequestQueueResponse,
} from '@maxim/contracts/support-requests';
import {
  sanitizeExternalHttpUrl,
  sanitizeExternalHttpUrls,
  sanitizeSafetyDeskPreviewHtml,
  type SafeExternalUrl,
  type SanitizedPreviewHtml,
} from './safety-desk-preview-security';

export type DeskView = 'review' | 'support' | 'deletes';
export type RiskLevel = 'low' | 'medium' | 'high' | 'blocked';
export type QueueStatus = 'review' | 'approved' | 'rejected' | 'blocked';
export type QueueSource = 'manual' | 'scheduled' | 'vk';
export type SupportStatus = 'new' | 'closed';
export type DeleteFilter = 'attention' | 'waiting' | 'failed' | 'observed' | 'all';

export type ModerationItem = {
  id: string;
  title: string;
  source: QueueSource;
  status: QueueStatus;
  risk: RiskLevel;
  entity: string;
  author: string;
  scheduledAt: string;
  text: string;
  previewHtml: SanitizedPreviewHtml;
  domains: string[];
  photoUrls: SafeExternalUrl[];
  videoUrls: SafeExternalUrl[];
  linkUrls: SafeExternalUrl[];
  originalUrl: SafeExternalUrl | null;
  reasons: string[];
  checks: Array<{ label: string; state: 'passed' | 'warning' | 'blocked' }>;
};

export type AuditEntry = {
  id: string;
  itemId: string | null;
  title: string;
  action: string;
  createdAt: string;
};

export type Metrics = {
  review: number;
  approved: number;
  stopped: number;
  servicePosts: number;
};

export type SupportMetrics = {
  new: number;
  closed: number;
};

export type SupportTicket = {
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

export type ReviewQueueSnapshot = {
  items: ModerationItem[];
  auditEntries: AuditEntry[];
  metrics: Metrics;
  selectedId: string;
};

export type SupportQueueSnapshot = {
  items: SupportTicket[];
  metrics: SupportMetrics;
  selectedId: string;
};

export type DeleteRuntimeSnapshot = {
  runtime: SafetyDeskDeleteRuntimeResponse;
  selectedId: string;
};

export const emptyMetrics: Metrics = {
  review: 0,
  approved: 0,
  stopped: 0,
  servicePosts: 0,
};

export const emptySupportMetrics: SupportMetrics = {
  new: 0,
  closed: 0,
};

export function buildReviewQueueSnapshot(
  response: SafetyDeskQueueResponse,
  preferredId = '',
): ReviewQueueSnapshot {
  const items = response.items.map(mapQueueItem);
  return {
    items,
    auditEntries: response.audit.map(mapAuditEntry),
    metrics: {
      review: response.summary.review,
      approved: response.summary.approved,
      stopped: response.summary.rejected + response.summary.blocked,
      servicePosts: response.summary.servicePosts,
    },
    selectedId: resolveSelectedId(items, preferredId),
  };
}

export function buildSupportQueueSnapshot(
  response: SupportRequestQueueResponse,
  preferredId = '',
): SupportQueueSnapshot {
  const items = response.items.map(mapSupportItem);
  return {
    items,
    metrics: {
      new: response.summary.new,
      closed: response.summary.closed,
    },
    selectedId: resolveSelectedId(items, preferredId),
  };
}

export function buildDeleteRuntimeSnapshot(
  runtime: SafetyDeskDeleteRuntimeResponse,
  preferredId = '',
): DeleteRuntimeSnapshot {
  return {
    runtime,
    selectedId: resolveSelectedId(runtime.items, preferredId),
  };
}

export function filterReviewItems(
  items: readonly ModerationItem[],
  filter: 'all' | QueueStatus,
  query: string,
): ModerationItem[] {
  const normalizedQuery = normalizeQuery(query);
  return items.filter((item) => {
    const matchesStatus = filter === 'all' || item.status === filter;
    const matchesQuery =
      !normalizedQuery ||
      [item.title, item.entity, item.author, item.text, ...item.domains]
        .join(' ')
        .toLowerCase()
        .includes(normalizedQuery);
    return matchesStatus && matchesQuery;
  });
}

export function filterSupportItems(
  items: readonly SupportTicket[],
  filter: 'all' | SupportStatus,
  query: string,
): SupportTicket[] {
  const normalizedQuery = normalizeQuery(query);
  return items.filter((item) => {
    const matchesStatus = filter === 'all' || item.status === filter;
    const matchesQuery =
      !normalizedQuery ||
      [item.userId, item.userName, item.privateChatId, item.botId, item.messageId, item.text]
        .join(' ')
        .toLowerCase()
        .includes(normalizedQuery);
    return matchesStatus && matchesQuery;
  });
}

export function filterDeleteItems(
  runtime: SafetyDeskDeleteRuntimeResponse | null,
  filter: DeleteFilter,
  query: string,
): SafetyDeskDeleteIntentItem[] {
  const normalizedQuery = normalizeQuery(query);
  return (runtime?.items ?? []).filter((item) => {
    const matchesStatus = matchesDeleteFilter(item.status, filter);
    const matchesQuery =
      !normalizedQuery ||
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
}

export function findSelectedItem<T extends { id: string }>(
  items: readonly T[],
  selectedId: string,
): T | undefined {
  return items.find((item) => item.id === selectedId) ?? items[0];
}

export function getApprovableReviewItems(items: readonly ModerationItem[]): ModerationItem[] {
  return items.filter((item) => item.status === 'review' && !getApproveBlockReason(item));
}

export function getApproveBlockReason(item: ModerationItem): string | null {
  if (item.status === 'approved') {
    return 'Материал уже одобрен.';
  }

  const blockedCheck = item.checks.find((check) => check.state === 'blocked');
  return blockedCheck?.label ?? null;
}

export function matchesDeleteFilter(
  status: SafetyDeskDeleteIntentStatus,
  filter: DeleteFilter,
): boolean {
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

export function deleteStatusTone(
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

export function deleteRolloutModeLabel(
  mode: SafetyDeskDeleteRuntimeResponse['rolloutMode'],
): string {
  const labels: Record<SafetyDeskDeleteRuntimeResponse['rolloutMode'], string> = {
    off: 'Выкл',
    shadow: 'Shadow',
    canary: 'Canary',
    on: 'Вкл',
  };
  return labels[mode];
}

export function ambiguousSendSourceLabel(
  source: SafetyDeskDeleteRuntimeResponse['ambiguousSends'][number]['source'],
): string {
  const labels: Record<typeof source, string> = {
    channel_auto_post: 'Копия поста канала',
    chat_auto_comment: 'Копия сообщения чата',
    chat_rules: 'Публикация правил',
  };
  return labels[source];
}

export function deleteRolloutLabel(rollout: SafetyDeskDeleteIntentItem['rollout']): string {
  if (rollout === 'execute') {
    return 'Исполнение';
  }
  if (rollout === 'observed') {
    return 'Наблюдение';
  }
  return 'Выключено';
}

export function deleteRoutingPolicyLabel(
  policy: SafetyDeskDeleteIntentItem['routingPolicy'],
): string {
  if (policy === 'delete_capable') {
    return 'Любой с правом';
  }
  if (policy === 'origin_first') {
    return 'Сначала исходный';
  }
  return 'Только исходный';
}

export function deleteCapabilityStateLabel(
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

export function deleteCapabilityReasonLabel(
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

export function sourceLabel(source: QueueSource): string {
  if (source === 'vk') {
    return 'Внешний источник';
  }
  if (source === 'scheduled') {
    return 'Запланировано';
  }
  return 'Ручная публикация';
}

export function auditActionLabel(action: string): string {
  const labels: Record<string, string> = {
    SAFETY_DESK_APPROVE: 'Одобрено',
    SAFETY_DESK_REJECT: 'Отклонено',
    SAFETY_DESK_RECHECK: 'Повторная проверка',
  };
  return labels[action] ?? action;
}

export function formatDuration(durationMs: number): string {
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

export function formatDateTime(date: Date): string {
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

export function formatTime(date: Date): string {
  return date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

export function readErrorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : 'Не удалось выполнить действие. Проверь соединение и попробуй еще раз.';
}

export type MutationLease = Readonly<{
  key: string;
  token: symbol;
}>;

export type MutationGuard = {
  acquire(key: string): MutationLease | null;
  acquireMany(keys: readonly string[]): MutationLease[] | null;
  release(lease: MutationLease): boolean;
  isActive(key: string): boolean;
};

export function createMutationGuard(): MutationGuard {
  const active = new Map<string, symbol>();
  return {
    acquire(key) {
      const normalizedKey = key.trim();
      if (!normalizedKey || active.has(normalizedKey)) {
        return null;
      }
      const token = Symbol(normalizedKey);
      active.set(normalizedKey, token);
      return Object.freeze({ key: normalizedKey, token });
    },
    acquireMany(keys) {
      const normalizedKeys = [...new Set(keys.map((key) => key.trim()).filter(Boolean))];
      if (normalizedKeys.length === 0 || normalizedKeys.some((key) => active.has(key))) {
        return null;
      }
      return normalizedKeys.map((key) => {
        const token = Symbol(key);
        active.set(key, token);
        return Object.freeze({ key, token });
      });
    },
    release(lease) {
      if (active.get(lease.key) !== lease.token) {
        return false;
      }
      return active.delete(lease.key);
    },
    isActive(key) {
      return active.has(key.trim());
    },
  };
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
    previewHtml: sanitizeSafetyDeskPreviewHtml(item.previewHtml),
    domains: item.domains,
    photoUrls: sanitizeExternalHttpUrls(item.photoUrls),
    videoUrls: sanitizeExternalHttpUrls(item.videoUrls),
    linkUrls: sanitizeExternalHttpUrls(item.linkUrls),
    originalUrl: sanitizeExternalHttpUrl(item.originalUrl),
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
  return risk === 'BLOCKED' ? 'blocked' : (risk.toLowerCase() as RiskLevel);
}

function resolveSelectedId(items: readonly { id: string }[], preferredId: string): string {
  return preferredId && items.some((item) => item.id === preferredId)
    ? preferredId
    : (items[0]?.id ?? '');
}

function normalizeQuery(query: string): string {
  return query.trim().toLowerCase();
}
