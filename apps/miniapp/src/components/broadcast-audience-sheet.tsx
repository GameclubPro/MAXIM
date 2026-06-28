import type { ChatSummary } from '@maxim/contracts';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  normalizeBroadcastAudienceTargetChatIds,
  resolveBroadcastAudienceTargetLabel,
} from '../lib/broadcast-audience';
import {
  filterBroadcastAudienceChoices,
  orderBroadcastAudienceChoices,
} from '../lib/broadcast-audience-search';
import { cn } from '../lib/cn';
import { maxSelectionChanged } from '../lib/max-bridge';
import { useNativeBackHandler } from '../lib/native-back';
import { EntityAvatar } from './ui/entity-avatar';

type BroadcastAudienceSheetProps = {
  open: boolean;
  currentChatId: string;
  favoriteChatIds?: readonly string[];
  choices: ChatSummary[];
  selection: string[];
  disabled?: boolean;
  loading?: boolean;
  refreshing?: boolean;
  error?: string | null;
  onClose: () => void;
  onApply: (nextSelection: string[]) => void;
  onRefresh?: () => void;
};

function CloseIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden>
      <path
        d="M5 5l10 10M15 5L5 15"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
      />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden>
      <circle cx="9" cy="9" r="5.75" stroke="currentColor" strokeWidth="1.7" />
      <path d="M13.5 13.5L17 17" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}

export function BroadcastAudienceSheet({
  open,
  currentChatId,
  favoriteChatIds = [],
  choices,
  selection,
  disabled = false,
  loading = false,
  refreshing = false,
  error = null,
  onClose,
  onApply,
  onRefresh,
}: BroadcastAudienceSheetProps) {
  const [draftSelection, setDraftSelection] = useState<string[]>(() =>
    normalizeBroadcastAudienceTargetChatIds(selection),
  );
  const [searchValue, setSearchValue] = useState('');
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useNativeBackHandler(
    () => {
      onClose();
      return true;
    },
    { enabled: open, priority: 680 },
  );

  useEffect(() => {
    if (!open) {
      return;
    }

    setDraftSelection(normalizeBroadcastAudienceTargetChatIds(selection));
    setSearchValue('');
  }, [open, selection]);

  useEffect(() => {
    if (!open || typeof document === 'undefined') {
      return;
    }

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [open]);

  useEffect(() => {
    if (!open || !scrollRef.current) {
      return;
    }

    scrollRef.current.scrollTop = 0;
  }, [open, searchValue]);

  const orderedChoices = useMemo(
    () =>
      orderBroadcastAudienceChoices(choices, {
        currentChatId,
        favoriteChatIds,
      }),
    [choices, currentChatId, favoriteChatIds],
  );
  const filteredChoices = useMemo(
    () => filterBroadcastAudienceChoices(orderedChoices, searchValue),
    [orderedChoices, searchValue],
  );
  const visibleChoices = useMemo(
    () =>
      [...filteredChoices].sort((left, right) => {
        const leftSelected = draftSelection.includes(left.id);
        const rightSelected = draftSelection.includes(right.id);

        if (leftSelected === rightSelected) {
          return 0;
        }

        return leftSelected ? -1 : 1;
      }),
    [draftSelection, filteredChoices],
  );
  const selectedPreviewChoices = useMemo(
    () => orderedChoices.filter((chat) => draftSelection.includes(chat.id)).slice(0, 3),
    [draftSelection, orderedChoices],
  );
  const favoriteSelection = useMemo(() => {
    const favoriteIds = new Set(normalizeBroadcastAudienceTargetChatIds(favoriteChatIds));
    return orderedChoices.filter((chat) => favoriteIds.has(chat.id)).map((chat) => chat.id);
  }, [favoriteChatIds, orderedChoices]);

  if (!open || typeof document === 'undefined') {
    return null;
  }

  const hasSelection = draftSelection.length > 0;
  const hasSearchQuery = searchValue.trim().length > 0;
  const selectedLabel = hasSelection
    ? resolveBroadcastAudienceTargetLabel({
        targetMode: 'selected',
        targetChatIds: draftSelection,
      })
    : 'Выберите чат';
  const totalChoicesLabel = resolveBroadcastAudienceTargetLabel({
    targetMode: 'selected',
    targetChatIds: orderedChoices.map((chat) => chat.id),
  });
  const canRefresh = typeof onRefresh === 'function';

  function toggleSelection(chatId: string) {
    maxSelectionChanged();
    setDraftSelection((current) =>
      current.includes(chatId) ? current.filter((item) => item !== chatId) : [...current, chatId],
    );
  }

  return createPortal(
    <div className="broadcast-audience-sheet" aria-hidden={!open}>
      <button
        type="button"
        className="broadcast-audience-sheet__backdrop"
        aria-label="Закрыть выбор активных чатов"
        onClick={onClose}
      />

      <section
        className="broadcast-audience-sheet__panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="broadcast-audience-sheet-title"
      >
        <div className="broadcast-audience-sheet__grabber" aria-hidden />

        <div className="broadcast-audience-sheet__sheet">
          <div className="broadcast-audience-sheet__sticky">
            <div className="broadcast-audience-sheet__hero">
              <div className="broadcast-audience-sheet__hero-copy">
                <strong id="broadcast-audience-sheet-title">Чаты</strong>
                <span>
                  {hasSearchQuery
                    ? `${filteredChoices.length}/${orderedChoices.length}`
                    : totalChoicesLabel}
                </span>
              </div>

              <button
                type="button"
                className="broadcast-audience-sheet__close"
                aria-label="Закрыть"
                onClick={onClose}
              >
                <CloseIcon />
              </button>
            </div>

            {hasSelection ? (
              <div className="broadcast-audience-sheet__selected-strip" aria-label={selectedLabel}>
                {selectedPreviewChoices.map((chat) => (
                  <span key={`selected-${chat.id}`}>{chat.title}</span>
                ))}
                {draftSelection.length > selectedPreviewChoices.length ? (
                  <span>+{draftSelection.length - selectedPreviewChoices.length}</span>
                ) : null}
                <span className="broadcast-audience-sheet__badge">{draftSelection.length}</span>
              </div>
            ) : null}

            <div className="broadcast-audience-sheet__search-shell">
              <span className="broadcast-audience-sheet__search-icon" aria-hidden>
                <SearchIcon />
              </span>

              <input
                id="broadcast-audience-search"
                type="text"
                inputMode="search"
                placeholder="Поиск чата"
                aria-label="Поиск чата"
                value={searchValue}
                onInput={(event) => setSearchValue(event.currentTarget.value)}
                onChange={(event) => setSearchValue(event.currentTarget.value)}
                autoComplete="off"
                spellCheck={false}
                disabled={disabled}
              />

              {hasSearchQuery ? (
                <button
                  type="button"
                  className="broadcast-audience-sheet__search-clear"
                  aria-label="Очистить поиск"
                  onClick={() => setSearchValue('')}
                >
                  <CloseIcon />
                </button>
              ) : null}
            </div>

            <div className="broadcast-audience-sheet__quick-actions">
              <button
                type="button"
                className="broadcast-audience-sheet__quick-pill"
                disabled={disabled || !currentChatId}
                onClick={() => setDraftSelection(currentChatId ? [currentChatId] : [])}
              >
                Текущий
              </button>
              {favoriteSelection.length > 0 ? (
                <button
                  type="button"
                  className="broadcast-audience-sheet__quick-pill"
                  disabled={disabled}
                  onClick={() => setDraftSelection(favoriteSelection)}
                >
                  Избранные {favoriteSelection.length}
                </button>
              ) : null}
              <button
                type="button"
                className="broadcast-audience-sheet__quick-pill"
                disabled={disabled || draftSelection.length === 0}
                onClick={() => setDraftSelection([])}
              >
                Сброс
              </button>
              {canRefresh ? (
                <button
                  type="button"
                  className="broadcast-audience-sheet__quick-pill"
                  disabled={disabled || loading || refreshing}
                  onClick={onRefresh}
                  aria-label="Обновить список"
                  title="Обновить список"
                >
                  {refreshing ? '...' : '↻'}
                </button>
              ) : null}
            </div>
          </div>

          {loading ? (
            <div className="broadcast-audience-sheet__state-shell">
              <div className="broadcast-audience-sheet__state">
                <strong>Загружаем</strong>
              </div>
            </div>
          ) : null}

          {!loading && error ? (
            <div className="broadcast-audience-sheet__state-shell">
              <div className="broadcast-audience-sheet__state is-danger">{error}</div>
            </div>
          ) : null}

          {!loading && !error && filteredChoices.length === 0 ? (
            <div className="broadcast-audience-sheet__state-shell">
              <div className="broadcast-audience-sheet__state">
                <strong>{searchValue.trim() ? 'Ничего не найдено' : 'Активных чатов нет'}</strong>
                {canRefresh ? (
                  <button
                    type="button"
                    className="broadcast-audience-sheet__state-action"
                    disabled={disabled || refreshing}
                    onClick={onRefresh}
                  >
                    {refreshing ? 'Обновляем' : 'Обновить'}
                  </button>
                ) : null}
              </div>
            </div>
          ) : null}

          {!loading && !error && filteredChoices.length > 0 ? (
            <div className="broadcast-audience-sheet__scroll" ref={scrollRef}>
              <div className="broadcast-audience-sheet__list" aria-label="Список активных чатов">
                {visibleChoices.map((chat) => {
                  const checked = draftSelection.includes(chat.id);
                  const isCurrentChat = chat.id === currentChatId;

                  return (
                    <button
                      key={`broadcast-audience-${chat.id}`}
                      type="button"
                      className={cn(
                        'broadcast-audience-sheet__option',
                        checked && 'is-selected',
                        isCurrentChat && 'is-current',
                      )}
                      aria-pressed={checked}
                      disabled={disabled}
                      onClick={() => toggleSelection(chat.id)}
                    >
                      <span className="broadcast-audience-sheet__option-glow" aria-hidden />
                      <EntityAvatar
                        title={chat.title}
                        entityType="chat"
                        avatarUrl={chat.avatarUrl ?? null}
                        className="broadcast-audience-sheet__avatar"
                      />

                      <span className="broadcast-audience-sheet__option-copy">
                        <span className="broadcast-audience-sheet__option-row">
                          <strong>{chat.title}</strong>
                          <span className="broadcast-audience-sheet__checkbox" aria-hidden>
                            {checked ? '✓' : ''}
                          </span>
                        </span>

                        <span className="broadcast-audience-sheet__option-row broadcast-audience-sheet__option-row--meta">
                          <small>{chat.link?.trim() || chat.id}</small>

                          <span className="broadcast-audience-sheet__option-meta" />
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}

          <div className="broadcast-audience-sheet__action-dock">
            <div className="broadcast-audience-sheet__action-copy">
              <strong>{selectedLabel}</strong>
            </div>

            <div className="broadcast-audience-sheet__actions">
              <button
                type="button"
                className="button button--ghost"
                onClick={onClose}
                disabled={disabled}
              >
                Назад
              </button>
              <button
                type="button"
                className="button button--accent"
                disabled={disabled || !hasSelection}
                onClick={() => onApply(normalizeBroadcastAudienceTargetChatIds(draftSelection))}
              >
                Готово
              </button>
            </div>
          </div>
        </div>
      </section>
    </div>,
    document.body,
  );
}
