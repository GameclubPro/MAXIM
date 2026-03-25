import type { ChatSummary } from '@maxim/contracts';
import { useQuery } from '@tanstack/react-query';
import { useDeferredValue, useEffect, useId, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useParams } from 'react-router-dom';
import { cn } from '../lib/cn';
import { getChannels, getChats, getMe } from '../lib/api/root-client';
import type { ApiTransport } from '../lib/api/transport';
import { maxSelectionChanged } from '../lib/max-bridge';
import { SegmentedControl } from './ui/segmented-control';

type ManagedLinkPickerTab = 'chat' | 'channel';

export type ManagedLinkButtonFieldsProps = {
  api: ApiTransport;
  contextEntityType?: ManagedLinkPickerTab;
  urlValue: string;
  onUrlChange: (value: string) => void;
  textValue: string;
  onTextChange: (value: string) => void;
  urlError?: string;
  textError?: string;
  disabled?: boolean;
  urlLabel?: string;
  textLabel?: string;
  urlPlaceholder?: string;
  textPlaceholder?: string;
  textMaxLength?: number;
};

type ManagedLinkOption = {
  id: string;
  entityType: ManagedLinkPickerTab;
  title: string;
  subtitle: string;
  url: string;
};

type SelectedManagedLink =
  | {
      kind: 'profile';
      label: string;
      title: string;
      subtitle: string;
      tab: null;
    }
  | {
      kind: 'entity';
      label: string;
      title: string;
      subtitle: string;
      tab: ManagedLinkPickerTab;
    }
  | {
      kind: 'manual';
      label: string;
      title: string;
      subtitle: string;
      tab: null;
    };

const DEFAULT_BUTTON_TEXT_AUTOFILL_VALUES = new Set([
  '',
  'открыть',
  'профиль',
  'мой профиль max',
  'чат',
  'канал',
  'мой профиль',
  'мой чат',
  'мой канал',
  'открыть профиль',
  'открыть чат',
  'открыть канал',
]);

function normalizeComparableUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }

  try {
    const parsed = new URL(trimmed);
    const normalizedPath = parsed.pathname.replace(/\/+$/u, '');
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      parsed.hash = '';
      return `${parsed.origin}${normalizedPath}`.replace(/\/+$/u, '').toLowerCase();
    }

    return `${parsed.protocol}//${parsed.host}${normalizedPath}`.replace(/\/+$/u, '').toLowerCase();
  } catch {
    return trimmed.replace(/\/+$/u, '').toLowerCase();
  }
}

function formatUrlPreview(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === 'max:' && parsed.hostname.toLowerCase() === 'user') {
      const targetUserId = decodeURIComponent(parsed.pathname.replace(/^\/+/u, '').trim());
      return targetUserId ? `MAX ID ${targetUserId}` : 'MAX профиль';
    }

    const pathname = decodeURIComponent(parsed.pathname).replace(/\/+$/u, '') || '/';
    return `${parsed.hostname}${pathname}`;
  } catch {
    return trimmed;
  }
}

function formatLinkCount(count: number): string {
  const absCount = Math.abs(count) % 100;
  const lastDigit = absCount % 10;

  if (absCount > 10 && absCount < 20) {
    return `${count} ссылок`;
  }

  if (lastDigit === 1) {
    return `${count} ссылка`;
  }

  if (lastDigit >= 2 && lastDigit <= 4) {
    return `${count} ссылки`;
  }

  return `${count} ссылок`;
}

function formatManagedLinkAvailability(linkCount: number, totalCount: number): string {
  if (linkCount > 0) {
    return formatLinkCount(linkCount);
  }

  if (totalCount > 0) {
    return 'Нет публичных ссылок';
  }

  return 'Пока пусто';
}

function sortManagedLinkOptions(
  options: ManagedLinkOption[],
  currentValue: string,
): ManagedLinkOption[] {
  const currentComparable = normalizeComparableUrl(currentValue);

  return [...options].sort((left, right) => {
    const leftSelected = normalizeComparableUrl(left.url) === currentComparable ? 0 : 1;
    const rightSelected = normalizeComparableUrl(right.url) === currentComparable ? 0 : 1;
    if (leftSelected !== rightSelected) {
      return leftSelected - rightSelected;
    }

    return left.title.localeCompare(right.title, 'ru', { sensitivity: 'base' });
  });
}

function buildManagedLinkOptions(
  entities: ChatSummary[] | undefined,
  entityType: ManagedLinkPickerTab,
  currentValue: string,
): ManagedLinkOption[] {
  const source = (entities ?? [])
    .filter((entity) => entity.entityType === entityType && Boolean(entity.link?.trim()))
    .map((entity) => ({
      id: entity.id,
      entityType,
      title: entity.title,
      subtitle: formatUrlPreview(entity.link?.trim() ?? ''),
      url: entity.link?.trim() ?? '',
    }));

  return sortManagedLinkOptions(source, currentValue);
}

export function ManagedLinkButtonFields({
  api,
  contextEntityType = 'chat',
  urlValue,
  onUrlChange,
  textValue,
  onTextChange,
  urlError,
  textError,
  disabled = false,
  urlLabel = 'Ссылка кнопки',
  textLabel = 'Название кнопки',
  urlPlaceholder = 'https://max.ru/channel/...',
  textPlaceholder = 'Открыть',
  textMaxLength = 32,
}: ManagedLinkButtonFieldsProps) {
  const { chatId: routeChatId } = useParams();
  const contextChatId = routeChatId?.trim() ?? '';
  const sheetTitleId = useId();
  const [sheetOpen, setSheetOpen] = useState(false);
  const [sheetTab, setSheetTab] = useState<ManagedLinkPickerTab>('chat');
  const [searchValue, setSearchValue] = useState('');
  const deferredSearchValue = useDeferredValue(searchValue);
  const comparableUrlValue = useMemo(() => normalizeComparableUrl(urlValue), [urlValue]);

  const meQuery = useQuery({
    queryKey: ['me', 'managed-link-picker', contextEntityType, contextChatId || null],
    queryFn: () =>
      getMe(api, { chatId: contextChatId || undefined, entityType: contextEntityType }),
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
  const chatsQuery = useQuery({
    queryKey: ['chats', 'managed-link-picker', 'refresh'],
    queryFn: () => getChats(api, { refresh: true }),
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
  const channelsQuery = useQuery({
    queryKey: ['channels', 'managed-link-picker', 'refresh'],
    queryFn: () => getChannels(api, { refresh: true }),
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });

  const profileUsername = meQuery.data?.username?.trim() ?? '';
  const profileSubtitle = profileUsername ? `@${profileUsername}` : 'Публичная ссылка недоступна';
  const profileQuickActionSubtitle = profileUsername
    ? `@${profileUsername}`
    : 'Нужен публичный username';
  const profileUnavailableHint =
    'Быстрая вставка доступна только если в профиле MAX задан публичный username. Иначе вставьте ссылку вручную.';
  const profileDisplayName =
    meQuery.data?.displayName?.trim() || (profileUsername ? `@${profileUsername}` : 'Профиль');
  const profileUrl = meQuery.data?.profileUrl?.trim() ?? '';
  const chatOptions = useMemo(
    () => buildManagedLinkOptions(chatsQuery.data, 'chat', urlValue),
    [chatsQuery.data, urlValue],
  );
  const channelOptions = useMemo(
    () => buildManagedLinkOptions(channelsQuery.data, 'channel', urlValue),
    [channelsQuery.data, urlValue],
  );
  const chatEntityCount = useMemo(
    () => (chatsQuery.data ?? []).filter((entity) => entity.entityType === 'chat').length,
    [chatsQuery.data],
  );
  const channelEntityCount = useMemo(
    () => (channelsQuery.data ?? []).filter((entity) => entity.entityType === 'channel').length,
    [channelsQuery.data],
  );

  const availableTabs = useMemo(() => {
    const tabs: ManagedLinkPickerTab[] = [];
    if (chatOptions.length > 0) {
      tabs.push('chat');
    }
    if (channelOptions.length > 0) {
      tabs.push('channel');
    }
    return tabs;
  }, [channelOptions.length, chatOptions.length]);

  useEffect(() => {
    if (availableTabs.length === 0) {
      return;
    }

    if (!availableTabs.includes(sheetTab)) {
      setSheetTab(availableTabs[0] ?? 'chat');
    }
  }, [availableTabs, sheetTab]);

  useEffect(() => {
    if (!sheetOpen) {
      setSearchValue('');
    }
  }, [sheetOpen]);

  const activeOptions = sheetTab === 'channel' ? channelOptions : chatOptions;
  const filteredOptions = useMemo(() => {
    const normalizedSearch = deferredSearchValue.trim().toLowerCase();
    if (!normalizedSearch) {
      return activeOptions;
    }

    return activeOptions.filter((option) => {
      const haystack = `${option.title} ${option.subtitle} ${option.id}`.toLowerCase();
      return haystack.includes(normalizedSearch);
    });
  }, [activeOptions, deferredSearchValue]);

  const selectedEntity = useMemo(() => {
    return [...chatOptions, ...channelOptions].find(
      (option) => normalizeComparableUrl(option.url) === comparableUrlValue,
    );
  }, [channelOptions, chatOptions, comparableUrlValue]);

  const selectedManagedLink = useMemo<SelectedManagedLink | null>(() => {
    if (profileUrl && normalizeComparableUrl(profileUrl) === comparableUrlValue) {
      return {
        kind: 'profile',
        label: 'Мой профиль MAX',
        title: profileDisplayName,
        subtitle: profileSubtitle,
        tab: null,
      };
    }

    if (selectedEntity) {
      return {
        kind: 'entity',
        label: selectedEntity.entityType === 'channel' ? 'Канал' : 'Чат',
        title: selectedEntity.title,
        subtitle: selectedEntity.subtitle,
        tab: selectedEntity.entityType,
      };
    }

    if (urlValue.trim()) {
      return {
        kind: 'manual',
        label: 'Своя ссылка',
        title: formatUrlPreview(urlValue),
        subtitle: 'Вставлена вручную',
        tab: null,
      };
    }

    return null;
  }, [
    comparableUrlValue,
    profileDisplayName,
    profileSubtitle,
    profileUrl,
    selectedEntity,
    urlValue,
  ]);

  const hasEntityLinks = chatOptions.length > 0 || channelOptions.length > 0;
  const isSheetLoading =
    (sheetTab === 'chat' && chatsQuery.isLoading) ||
    (sheetTab === 'channel' && channelsQuery.isLoading);
  const sheetError = sheetTab === 'chat' ? chatsQuery.error : channelsQuery.error;
  const isProfileActive = Boolean(
    profileUrl && normalizeComparableUrl(profileUrl) === comparableUrlValue,
  );
  const isChatActive = selectedEntity?.entityType === 'chat';
  const isChannelActive = selectedEntity?.entityType === 'channel';

  function maybeAutofillButtonText(nextValue: string) {
    const normalizedCurrentValue = textValue.trim().toLowerCase();
    if (DEFAULT_BUTTON_TEXT_AUTOFILL_VALUES.has(normalizedCurrentValue)) {
      onTextChange(nextValue);
    }
  }

  function applyPreset(url: string, suggestedText: string) {
    onUrlChange(url);
    maybeAutofillButtonText(suggestedText);
    setSheetOpen(false);
    setSearchValue('');
    maxSelectionChanged();
  }

  function openSheet(nextTab: ManagedLinkPickerTab) {
    setSheetTab(nextTab);
    setSheetOpen(true);
    maxSelectionChanged();
  }

  const quickActions = (
    <div className="managed-link-picker__quick-grid" aria-label="Быстрый выбор ссылки">
      <button
        type="button"
        className={cn('managed-link-picker__quick-action', isProfileActive && 'is-active')}
        onClick={() => applyPreset(profileUrl, 'Профиль')}
        disabled={disabled || !profileUrl}
      >
        <strong>Мой профиль MAX</strong>
        <small>{profileQuickActionSubtitle}</small>
      </button>

      <button
        type="button"
        className={cn('managed-link-picker__quick-action', isChatActive && 'is-active')}
        onClick={() => openSheet('chat')}
        disabled={disabled || (!chatsQuery.isLoading && chatOptions.length === 0)}
      >
        <strong>Чаты</strong>
        <small>
          {chatsQuery.isLoading
            ? 'Загрузка...'
            : formatManagedLinkAvailability(chatOptions.length, chatEntityCount)}
        </small>
      </button>

      <button
        type="button"
        className={cn('managed-link-picker__quick-action', isChannelActive && 'is-active')}
        onClick={() => openSheet('channel')}
        disabled={disabled || (!channelsQuery.isLoading && channelOptions.length === 0)}
      >
        <strong>Каналы</strong>
        <small>
          {channelsQuery.isLoading
            ? 'Загрузка...'
            : formatManagedLinkAvailability(channelOptions.length, channelEntityCount)}
        </small>
      </button>
    </div>
  );

  return (
    <>
      <div className="settings-button-fields">
        <div className="managed-link-picker">
          {quickActions}

          {!profileUrl ? (
            <p className="field__hint" role="note">
              {profileUnavailableHint}
            </p>
          ) : null}

          {selectedManagedLink ? (
            <div className="managed-link-picker__selection">
              <div className="managed-link-picker__selection-copy">
                <span className="managed-giveaway__badge is-muted">
                  {selectedManagedLink.label}
                </span>
                <strong>{selectedManagedLink.title}</strong>
                <small>{selectedManagedLink.subtitle}</small>
              </div>

              {selectedManagedLink.kind === 'entity' && selectedManagedLink.tab ? (
                <button
                  type="button"
                  className="broadcast-planner__clear-button"
                  onClick={() => openSheet(selectedManagedLink.tab!)}
                  disabled={disabled}
                >
                  Сменить
                </button>
              ) : null}
            </div>
          ) : null}

          <label className={cn('field settings-url-field', urlError && 'field--error')}>
            <span className="field__label">{urlLabel}</span>
            <input
              type="url"
              inputMode="url"
              value={urlValue}
              onChange={(event) => onUrlChange(event.target.value)}
              placeholder={urlPlaceholder}
              disabled={disabled}
            />
            {urlError ? (
              <small className="field__hint">{urlError}</small>
            ) : (
              <small className="field__hint">
                {profileUrl
                  ? 'Можно выбрать вариант сверху или вставить свою ссылку max.ru.'
                  : profileUnavailableHint}
              </small>
            )}
          </label>

          <label className={cn('field settings-text-field', textError && 'field--error')}>
            <span className="field__label">{textLabel}</span>
            <input
              type="text"
              maxLength={textMaxLength}
              value={textValue}
              onChange={(event) => onTextChange(event.target.value)}
              placeholder={textPlaceholder}
              disabled={disabled}
            />
            {textError ? (
              <small className="field__hint">{textError}</small>
            ) : (
              <small className="field__hint">Текст кнопки можно задать вручную.</small>
            )}
          </label>
        </div>
      </div>

      {typeof document !== 'undefined' && sheetOpen
        ? createPortal(
            <div className="managed-giveaway-modal" aria-hidden={!sheetOpen}>
              <button
                type="button"
                className="managed-giveaway-modal__backdrop"
                aria-label="Закрыть выбор ссылки"
                onClick={() => setSheetOpen(false)}
              />

              <section
                className="managed-giveaway-modal__panel"
                role="dialog"
                aria-modal="true"
                aria-labelledby={sheetTitleId}
              >
                <div className="managed-giveaway-modal__grabber" aria-hidden />

                <div className="managed-giveaway-modal__sheet">
                  <div className="managed-giveaway-modal__head">
                    <div>
                      <strong id={sheetTitleId}>Выберите ссылку</strong>
                      <small>
                        {hasEntityLinks
                          ? 'Только ваши чаты и каналы с рабочей ссылкой.'
                          : 'Сначала нужен хотя бы один чат или канал с доступной ссылкой.'}
                      </small>
                    </div>

                    <button
                      type="button"
                      className="broadcast-planner__clear-button"
                      onClick={() => setSheetOpen(false)}
                    >
                      Готово
                    </button>
                  </div>

                  <SegmentedControl
                    value={sheetTab}
                    options={[
                      { value: 'chat', label: 'Чаты', count: chatOptions.length },
                      { value: 'channel', label: 'Каналы', count: channelOptions.length },
                    ]}
                    onChange={(value) => setSheetTab(value)}
                  />

                  <label className="field">
                    <span className="field__label">Поиск</span>
                    <input
                      type="search"
                      inputMode="search"
                      value={searchValue}
                      onChange={(event) => setSearchValue(event.target.value)}
                      placeholder={sheetTab === 'chat' ? 'Найти чат' : 'Найти канал'}
                      autoComplete="off"
                    />
                  </label>

                  {isSheetLoading ? (
                    <div className="managed-giveaway__empty managed-giveaway__empty--soft">
                      <strong>Загружаем ваши ссылки</strong>
                    </div>
                  ) : null}

                  {!isSheetLoading && sheetError ? (
                    <div className="managed-giveaway__error-inline">
                      Не удалось загрузить список.
                    </div>
                  ) : null}

                  {!isSheetLoading && !sheetError && filteredOptions.length === 0 ? (
                    <div className="managed-giveaway__empty managed-giveaway__empty--soft">
                      <strong>
                        {activeOptions.length === 0
                          ? 'Нет сущностей с доступной ссылкой'
                          : 'Ничего не найдено'}
                      </strong>
                      <span>
                        {activeOptions.length === 0
                          ? 'Откройте чат или канал в MAX и убедитесь, что у него есть публичная или join-ссылка.'
                          : 'Попробуйте другой запрос или вставьте ссылку вручную.'}
                      </span>
                    </div>
                  ) : null}

                  {!isSheetLoading && !sheetError && filteredOptions.length > 0 ? (
                    <div className="managed-giveaway-modal__list">
                      {filteredOptions.map((option) => {
                        const selected = normalizeComparableUrl(option.url) === comparableUrlValue;

                        return (
                          <button
                            key={`${option.entityType}-${option.id}`}
                            type="button"
                            className={cn(
                              'managed-giveaway-modal__option',
                              selected && 'is-selected',
                            )}
                            aria-pressed={selected}
                            onClick={() =>
                              applyPreset(
                                option.url,
                                option.entityType === 'channel' ? 'Канал' : 'Чат',
                              )
                            }
                          >
                            <span className="managed-giveaway-modal__checkbox" aria-hidden>
                              {selected ? '✓' : ''}
                            </span>

                            <div className="managed-giveaway-modal__option-copy">
                              <span className="managed-giveaway__badge is-muted">
                                {option.entityType === 'channel' ? 'Канал' : 'Чат'}
                              </span>
                              <strong>{option.title}</strong>
                              <small>{option.subtitle}</small>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  ) : null}
                </div>
              </section>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

export default ManagedLinkButtonFields;
