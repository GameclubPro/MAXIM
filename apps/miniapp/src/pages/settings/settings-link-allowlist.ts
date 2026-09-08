import {
  parseStoredAllowlistEntry,
  resolveNavigationAllowlistKind,
  type AllowlistMatchType,
  type DomainAllowlistEntry,
  type NavigationAllowlistKind,
} from '@maxim/contracts/settings';

export type NavigationAllowlistTargetOption = {
  value: NavigationAllowlistKind;
  label: string;
  placeholder: string;
  ariaLabel: string;
  inputMode: 'text' | 'url';
  invalidMessage: string;
  successTitle: string;
  errorTitle: string;
};

export const NAVIGATION_ALLOWLIST_TARGET_OPTIONS: readonly NavigationAllowlistTargetOption[] = [
  {
    value: 'WEB_DOMAIN',
    label: 'Сайт целиком',
    placeholder: 'example.com',
    ariaLabel: 'Адрес разрешённого сайта',
    inputMode: 'text',
    invalidMessage: 'Введите адрес сайта, например example.com.',
    successTitle: 'Сайт добавлен в разрешённые',
    errorTitle: 'Не удалось добавить сайт',
  },
  {
    value: 'WEB_EXACT',
    label: 'Только эта ссылка',
    placeholder: 'https://site.ru/page',
    ariaLabel: 'Разрешённая ссылка',
    inputMode: 'url',
    invalidMessage: 'Введите полную ссылку, например https://site.ru/page.',
    successTitle: 'Ссылка добавлена в разрешённые',
    errorTitle: 'Не удалось добавить ссылку',
  },
  {
    value: 'MAX_PROFILE',
    label: 'Профиль MAX',
    placeholder: 'Номер профиля MAX',
    ariaLabel: 'Разрешённый профиль MAX',
    inputMode: 'text',
    invalidMessage: 'Введите номер профиля MAX, например 123456789.',
    successTitle: 'Профиль MAX добавлен в разрешённые',
    errorTitle: 'Не удалось добавить профиль MAX',
  },
  {
    value: 'MAX_ENTITY',
    label: 'Чат или канал MAX',
    placeholder: 'https://max.ru/join/...',
    ariaLabel: 'Разрешённая ссылка на чат или канал MAX',
    inputMode: 'url',
    invalidMessage: 'Введите официальную ссылку чата или канала MAX.',
    successTitle: 'Ссылка на чат или канал MAX добавлена в разрешённые',
    errorTitle: 'Не удалось добавить ссылку на чат или канал MAX',
  },
  {
    value: 'MINI_APP',
    label: 'Мини-приложение MAX',
    placeholder: '@имя_бота',
    ariaLabel: 'Разрешённое мини-приложение MAX',
    inputMode: 'text',
    invalidMessage: 'Введите имя бота или ссылку на его мини-приложение в MAX.',
    successTitle: 'Мини-приложение добавлено в разрешённые',
    errorTitle: 'Не удалось добавить мини-приложение',
  },
] as const;

export const STRICT_NAVIGATION_POLICY_DESCRIPTION =
  'Удаляются ссылки, кнопки перехода и кликабельные упоминания профилей MAX.';
export const ALLOWLIST_NAVIGATION_POLICY_DESCRIPTION =
  'Удаляются ссылки, кнопки перехода и упоминания профилей MAX, кроме добавленных в список разрешённых.';

export function getNavigationAllowlistTargetOption(
  kind: NavigationAllowlistKind,
): NavigationAllowlistTargetOption {
  return (
    NAVIGATION_ALLOWLIST_TARGET_OPTIONS.find((option) => option.value === kind) ??
    NAVIGATION_ALLOWLIST_TARGET_OPTIONS[0]
  );
}

export function resolveNavigationAllowlistEntryKind(
  entry: Pick<DomainAllowlistEntry, 'kind' | 'matchType' | 'normalizedValue'>,
): NavigationAllowlistKind {
  return (
    entry.kind ??
    parseStoredAllowlistEntry(entry.normalizedValue)?.kind ??
    resolveNavigationAllowlistKind(entry.matchType)
  );
}

export function formatNavigationAllowlistKindLabel(kind: NavigationAllowlistKind): string {
  return getNavigationAllowlistTargetOption(kind).label;
}

export function formatNavigationAllowlistEntryKindLabel(
  entry: Pick<DomainAllowlistEntry, 'kind' | 'matchType' | 'normalizedValue'>,
): string {
  const parsed = parseStoredAllowlistEntry(entry.normalizedValue);
  if (parsed?.kind === 'MAX_ENTITY' && parsed.target.startsWith('chat-id:')) {
    return 'Устаревшее правило MAX';
  }
  return formatNavigationAllowlistKindLabel(resolveNavigationAllowlistEntryKind(entry));
}

export function formatNavigationAllowlistEntryTarget(
  entry: Pick<DomainAllowlistEntry, 'domain' | 'target' | 'normalizedValue'>,
): string {
  const parsed = parseStoredAllowlistEntry(entry.normalizedValue);
  const kind = parsed?.kind;
  const target = entry.target ?? parsed?.target ?? entry.domain;

  if (kind === 'MAX_PROFILE') {
    if (target.startsWith('user-id:')) {
      return `max://user/${target.slice('user-id:'.length)}`;
    }
    if (target.startsWith('username:')) {
      return `@${target.slice('username:'.length)}`;
    }
  }
  if (kind === 'MAX_ENTITY') {
    if (target.startsWith('url:')) {
      return target.slice('url:'.length);
    }
    if (target.startsWith('chat-id:')) {
      return `Старый ID чата: ${target.slice('chat-id:'.length)}`;
    }
  }
  if (kind === 'MINI_APP') {
    if (target.startsWith('url:')) {
      return target.slice('url:'.length);
    }
    if (target.startsWith('bot:')) {
      return `Бот MAX: ${target.slice('bot:'.length)}`;
    }
    if (target.startsWith('contact-id:')) {
      return `Приложение MAX: ${target.slice('contact-id:'.length)}`;
    }
  }
  return target;
}

export function formatAllowlistModeLabel(matchType: AllowlistMatchType): string {
  return formatNavigationAllowlistKindLabel(resolveNavigationAllowlistKind(matchType));
}

export function formatAllowlistMetaLabel(
  entry: DomainAllowlistEntry,
  scheduledAtLabel: string,
): string {
  const targetLabel =
    resolveNavigationAllowlistEntryKind(entry) === 'WEB_DOMAIN'
      ? 'Сайт разрешён без ограничения срока.'
      : 'Ссылка разрешена без ограничения срока.';

  return scheduledAtLabel ? `Удаление: ${scheduledAtLabel}` : targetLabel;
}

export const ALLOWLIST_MATCH_OPTIONS: Array<{ value: AllowlistMatchType; label: string }> = [
  { value: 'DOMAIN', label: 'Сайт целиком' },
  { value: 'EXACT', label: 'Только эта ссылка' },
];
