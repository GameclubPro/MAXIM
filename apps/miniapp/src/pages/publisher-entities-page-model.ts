import type { PublisherEntity, PublisherReadinessBlockerCode } from '@maxim/contracts/publisher';

export type PublisherEntityView = 'chat' | 'channel';
export type PublisherEntityReadinessFilter = 'all' | 'ready' | 'attention';

export type PublisherEntityCapability = {
  key: 'comments' | 'posting' | 'suggestions';
  label: string;
  tone: 'available' | 'blocked' | 'external';
};

export type PublisherEntityPrimaryAction =
  | { kind: 'compose'; label: string; href: string }
  | { kind: 'max_link'; label: string; url: string }
  | { kind: 'note'; label: string };

export const PUBLISHER_ENTITY_REFRESH_POLL_DELAYS_MS = [
  750, 1_250, 2_500, 4_500, 7_500, 10_500,
] as const;
const PUBLISHER_ENTITY_REFRESH_MAX_CONSECUTIVE_READ_FAILURES = 2;

export type PublisherEntityRefreshPollResult =
  | { status: 'updated'; entity: PublisherEntity; attempts: number }
  | { status: 'timed_out'; entity: PublisherEntity; attempts: number }
  | { status: 'read_failed'; entity: PublisherEntity; attempts: number; error: unknown }
  | { status: 'cancelled'; entity: PublisherEntity; attempts: number };

const ACTION_NOTES: Record<PublisherReadinessBlockerCode, string> = {
  policy_disabled: 'Включите Публик в основном боте',
  bot_not_connected: 'Добавьте Публик в MAX',
  bot_access_unconfirmed: 'Перепроверьте доступ',
  bot_access_expired: 'Обновите проверку доступа',
  bot_not_admin: 'Выдайте Публику права администратора в MAX',
  write_permission_missing: 'Разрешите Публику читать все сообщения и публиковать в MAX',
  route_quarantined: 'Дождитесь автоматического восстановления',
  publisher_runtime_unavailable: 'Обновите список позднее',
};

const PRIMARY_ACTION_BY_BLOCKER: Record<
  PublisherReadinessBlockerCode,
  'settings' | 'publisher' | 'entity' | 'none'
> = {
  policy_disabled: 'settings',
  bot_not_connected: 'publisher',
  bot_access_unconfirmed: 'none',
  bot_access_expired: 'none',
  bot_not_admin: 'entity',
  write_permission_missing: 'entity',
  route_quarantined: 'none',
  publisher_runtime_unavailable: 'none',
};

const RECHECK_BY_BLOCKER: Record<PublisherReadinessBlockerCode, boolean> = {
  policy_disabled: false,
  bot_not_connected: true,
  bot_access_unconfirmed: true,
  bot_access_expired: true,
  bot_not_admin: true,
  write_permission_missing: true,
  route_quarantined: false,
  publisher_runtime_unavailable: false,
};

export function normalizePublisherEntityView(value: string | null): PublisherEntityView {
  return value === 'channel' ? 'channel' : 'chat';
}

export function normalizePublisherReadinessFilter(
  value: string | null,
): PublisherEntityReadinessFilter {
  return value === 'ready' || value === 'attention' ? value : 'all';
}

export function buildPublisherComposeRoute(
  entity: Pick<PublisherEntity, 'entityType' | 'id'>,
): string {
  return `/publications?compose=1&entityType=${entity.entityType}&entityId=${encodeURIComponent(
    entity.id,
  )}`;
}

export function resolvePublisherEntityPrimaryAction(
  entity: PublisherEntity,
  botDialogUrl: string | null,
): PublisherEntityPrimaryAction {
  if (entity.readiness.canPublish) {
    return {
      kind: 'compose',
      label: 'Создать пост',
      href: buildPublisherComposeRoute(entity),
    };
  }

  const blockerCode = entity.readiness.blockerCode;
  if (!blockerCode) {
    return { kind: 'note', label: 'Обновите список позднее' };
  }

  switch (PRIMARY_ACTION_BY_BLOCKER[blockerCode]) {
    case 'settings':
      return entity.settingsHandoffUrl
        ? { kind: 'max_link', label: 'Открыть настройки', url: entity.settingsHandoffUrl }
        : { kind: 'note', label: ACTION_NOTES[blockerCode] };
    case 'publisher':
      return botDialogUrl
        ? { kind: 'max_link', label: 'Открыть Публик', url: botDialogUrl }
        : { kind: 'note', label: ACTION_NOTES[blockerCode] };
    case 'entity':
      return entity.entityUrl
        ? {
            kind: 'max_link',
            label: entity.entityType === 'channel' ? 'Открыть канал' : 'Открыть чат',
            url: entity.entityUrl,
          }
        : { kind: 'note', label: ACTION_NOTES[blockerCode] };
    case 'none':
      return { kind: 'note', label: ACTION_NOTES[blockerCode] };
  }
}

export function shouldOfferPublisherRecheck(entity: Pick<PublisherEntity, 'readiness'>): boolean {
  const blockerCode = entity.readiness.blockerCode;
  return blockerCode ? RECHECK_BY_BLOCKER[blockerCode] : false;
}

export function isPublisherEntityRefreshObserved(
  initialEntity: Pick<PublisherEntity, 'readiness'>,
  currentEntity: Pick<PublisherEntity, 'readiness'>,
): boolean {
  const currentCheckedAt = currentEntity.readiness.checkedAt;
  if (currentCheckedAt === null) {
    return false;
  }
  const currentCheckedAtMs = Date.parse(currentCheckedAt);
  const initialCheckedAtMs = Date.parse(initialEntity.readiness.checkedAt ?? '');
  return (
    Number.isFinite(currentCheckedAtMs) &&
    (!Number.isFinite(initialCheckedAtMs) || currentCheckedAtMs > initialCheckedAtMs)
  );
}

export async function pollPublisherEntityRefresh(options: {
  initialEntity: PublisherEntity;
  readEntity: () => Promise<PublisherEntity>;
  wait: (delayMs: number) => Promise<void>;
  delaysMs?: readonly number[];
  isCancelled?: () => boolean;
}): Promise<PublisherEntityRefreshPollResult> {
  const delaysMs = options.delaysMs ?? PUBLISHER_ENTITY_REFRESH_POLL_DELAYS_MS;
  let lastEntity = options.initialEntity;
  let lastReadError: unknown = null;
  let lastReadFailed = false;
  let consecutiveReadFailures = 0;
  let attempts = 0;

  for (const delayMs of delaysMs) {
    await options.wait(delayMs);
    if (options.isCancelled?.()) {
      return { status: 'cancelled', entity: lastEntity, attempts };
    }

    attempts += 1;
    try {
      const currentEntity = await options.readEntity();
      lastEntity = currentEntity;
      lastReadFailed = false;
      consecutiveReadFailures = 0;
      if (isPublisherEntityRefreshObserved(options.initialEntity, currentEntity)) {
        return { status: 'updated', entity: currentEntity, attempts };
      }
    } catch (error: unknown) {
      if (options.isCancelled?.()) {
        return { status: 'cancelled', entity: lastEntity, attempts };
      }
      lastReadError = error;
      lastReadFailed = true;
      consecutiveReadFailures += 1;
      if (consecutiveReadFailures >= PUBLISHER_ENTITY_REFRESH_MAX_CONSECUTIVE_READ_FAILURES) {
        return { status: 'read_failed', entity: lastEntity, attempts, error: lastReadError };
      }
    }
  }

  return lastReadFailed
    ? { status: 'read_failed', entity: lastEntity, attempts, error: lastReadError }
    : { status: 'timed_out', entity: lastEntity, attempts };
}

export function getPublisherEntityCapabilities(
  entity: PublisherEntity,
): PublisherEntityCapability[] {
  const capabilities: PublisherEntityCapability[] = [
    {
      key: 'posting',
      label: entity.readiness.canPublish ? 'Постинг доступен' : 'Постинг недоступен',
      tone: entity.readiness.canPublish ? 'available' : 'blocked',
    },
  ];

  if (entity.entityType === 'chat') {
    capabilities.push({
      key: 'comments',
      label: entity.readiness.canUseChatComments
        ? 'Комментарии доступны'
        : 'Комментарии недоступны',
      tone: entity.readiness.canUseChatComments ? 'available' : 'blocked',
    });
    return capabilities;
  }

  capabilities.push(
    entity.policy.suggestionsViaPublik
      ? {
          key: 'suggestions',
          label: entity.readiness.canPublishSuggestions
            ? 'Предложки через Публик'
            : 'Предложки ждут подключения',
          tone: entity.readiness.canPublishSuggestions ? 'available' : 'blocked',
        }
      : {
          key: 'suggestions',
          label: 'Предложки в основном боте',
          tone: 'external',
        },
  );
  return capabilities;
}
