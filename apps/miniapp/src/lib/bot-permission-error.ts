import { ApiRequestError, type ApiErrorPayloadValue } from './api-request-error';

const BOT_PERMISSION_ERROR_CODES = new Set([
  'BOT_PERMISSIONS_REQUIRED',
  'BOT_CAPABILITY_REQUIRED',
  'PUBLISHER_SETUP_REQUIRED',
]);
const MAX_BLOCKER_ITEMS = 24;
const MAX_BLOCKER_FEATURES = 128;
const MAX_BLOCKER_ITEM_LENGTH = 160;

export type BotPermissionBlocker = {
  code: 'BOT_PERMISSIONS_REQUIRED' | 'BOT_CAPABILITY_REQUIRED' | 'PUBLISHER_SETUP_REQUIRED';
  missingPermissions: readonly string[];
  stale: boolean;
  canRecheck: boolean;
  features: readonly string[];
  affectedEntities: readonly { id: string; title: string }[];
};

function normalizeStringList(
  value: ApiErrorPayloadValue | undefined,
  maxItems = MAX_BLOCKER_ITEMS,
): readonly string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const normalized = value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item.length > 0 && item.length <= MAX_BLOCKER_ITEM_LENGTH);

  return Object.freeze(Array.from(new Set(normalized)).slice(0, maxItems));
}

function resolvePublisherBlockerPermissions(
  blockerCode: ApiErrorPayloadValue | undefined,
): readonly string[] {
  if (blockerCode === 'write_permission_missing') {
    return ['write'];
  }
  if (blockerCode === 'bot_not_admin') {
    return ['administrator'];
  }
  if (blockerCode === 'bot_not_connected') {
    return ['bot_connection'];
  }
  if (blockerCode === 'bot_access_unconfirmed' || blockerCode === 'bot_access_expired') {
    return ['fresh_access'];
  }
  return [];
}

function normalizeAffectedEntities(
  value: ApiErrorPayloadValue | undefined,
): readonly { id: string; title: string }[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const entities = new Map<string, { id: string; title: string }>();
  for (const item of value.slice(0, 20)) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      continue;
    }
    const id = typeof item.id === 'string' ? item.id.trim().slice(0, 128) : '';
    const title = typeof item.title === 'string' ? item.title.trim().slice(0, 160) : '';
    if (!id || entities.has(id)) {
      continue;
    }
    entities.set(id, { id, title: title || id });
  }
  return Object.freeze([...entities.values()]);
}

export function parseBotPermissionBlocker(error: unknown): BotPermissionBlocker | null {
  if (
    !(error instanceof ApiRequestError) ||
    (error.status !== 403 && error.status !== 409) ||
    !error.code ||
    !BOT_PERMISSION_ERROR_CODES.has(error.code)
  ) {
    return null;
  }

  const code = error.code as BotPermissionBlocker['code'];
  const missingPermissions = normalizeStringList(error.payload?.missingPermissions);
  return Object.freeze({
    code,
    missingPermissions:
      missingPermissions.length > 0
        ? missingPermissions
        : resolvePublisherBlockerPermissions(error.payload?.blockerCode),
    stale: error.payload?.stale === true,
    canRecheck: error.payload?.canRecheck !== false,
    features: normalizeStringList(
      error.payload?.featureKeys ?? error.payload?.features,
      MAX_BLOCKER_FEATURES,
    ),
    affectedEntities: normalizeAffectedEntities(error.payload?.affectedEntities),
  });
}

const BOT_PERMISSION_LABELS: Readonly<Record<string, string>> = Object.freeze({
  all: 'Полный доступ бота',
  read: 'Читать сообщения',
  read_messages: 'Читать сообщения',
  write: 'Отправлять сообщения',
  send: 'Отправлять сообщения',
  send_message: 'Отправлять сообщения',
  send_messages: 'Отправлять сообщения',
  delete: 'Удалять сообщения',
  delete_message: 'Удалять сообщения',
  delete_messages: 'Удалять сообщения',
  edit: 'Редактировать сообщения',
  edit_message: 'Редактировать сообщения',
  edit_messages: 'Редактировать сообщения',
  manage_members: 'Управлять участниками',
  manage_participants: 'Управлять участниками',
  restrict_members: 'Ограничивать участников',
  mute_members: 'Ограничивать участников',
  ban_members: 'Удалять и блокировать участников',
  add_remove_members: 'Управлять участниками',
  can_add_remove_members: 'Управлять участниками',
  administrator: 'Права администратора',
  admin: 'Права администратора',
  bot_connection: 'Подключить бота к чату или каналу',
  fresh_access: 'Актуальная проверка доступа',
});

export function formatBotPermissionLabel(permission: string): string {
  const trimmed = permission.trim();
  const normalized = trimmed.toLowerCase().replace(/[.\s-]+/gu, '_');
  const knownLabel = BOT_PERMISSION_LABELS[normalized];
  if (knownLabel) {
    return knownLabel;
  }

  const readable = trimmed
    .replace(/[._-]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  return readable ? `${readable[0]?.toUpperCase() ?? ''}${readable.slice(1)}` : 'Права бота в MAX';
}

export function getBotPermissionBlockerLabels(blocker: BotPermissionBlocker): readonly string[] {
  const labels = blocker.missingPermissions.map(formatBotPermissionLabel);
  return labels.length > 0 ? Object.freeze(Array.from(new Set(labels))) : ['Права бота в MAX'];
}

export function revertRejectedFeatureChanges<T extends object>(
  draft: T,
  persisted: T,
  scopeKeys: readonly (keyof T)[] = Object.keys(draft) as (keyof T)[],
  rejectedFeatures: readonly string[] = [],
): T {
  const featureKeys = new Set(rejectedFeatures);
  const next = { ...draft };
  const nextRecord = next as Record<keyof T, unknown>;
  const draftRecord = draft as Record<keyof T, unknown>;
  const persistedRecord = persisted as Record<keyof T, unknown>;
  let changed = false;
  let matchedExplicitFeature = false;

  for (const key of scopeKeys) {
    if (!featureKeys.has(String(key)) || draftRecord[key] === persistedRecord[key]) {
      continue;
    }
    nextRecord[key] = persistedRecord[key];
    matchedExplicitFeature = true;
    changed = true;
  }

  if (!matchedExplicitFeature) {
    for (const key of scopeKeys) {
      if (draftRecord[key] !== true || persistedRecord[key] !== false) {
        continue;
      }
      nextRecord[key] = false;
      changed = true;
    }
  }

  return changed ? next : draft;
}
