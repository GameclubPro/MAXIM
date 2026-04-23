import type { ChatSummary } from '@maxim/contracts';
import { useDeferredValue, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { filterBroadcastAudienceChoices, normalizeBroadcastAudienceTargetChatIds } from '../lib/broadcast-audience';
import { cn } from '../lib/cn';
import { EntityAvatar } from './ui/entity-avatar';

type BroadcastAudienceSheetProps = {
  open: boolean;
  currentChatId: string;
  choices: ChatSummary[];
  selection: string[];
  disabled?: boolean;
  loading?: boolean;
  error?: string | null;
  onClose: () => void;
  onApply: (nextSelection: string[]) => void;
};

function dedupeAudienceChoices(choices: readonly ChatSummary[], currentChatId: string): ChatSummary[] {
  const byId = new Map<string, ChatSummary>();
  for (const choice of choices) {
    byId.set(choice.id, choice);
  }

  const current = byId.get(currentChatId);
  const ordered = [...choices.filter((choice) => choice.id !== currentChatId)];
  return current ? [current, ...ordered] : ordered;
}

export function BroadcastAudienceSheet({
  open,
  currentChatId,
  choices,
  selection,
  disabled = false,
  loading = false,
  error = null,
  onClose,
  onApply,
}: BroadcastAudienceSheetProps) {
  const [draftSelection, setDraftSelection] = useState<string[]>(() =>
    normalizeBroadcastAudienceTargetChatIds(selection),
  );
  const [searchValue, setSearchValue] = useState('');
  const deferredSearchValue = useDeferredValue(searchValue);

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

  const orderedChoices = useMemo(
    () => dedupeAudienceChoices(choices, currentChatId),
    [choices, currentChatId],
  );
  const filteredChoices = useMemo(
    () => filterBroadcastAudienceChoices(orderedChoices, deferredSearchValue),
    [deferredSearchValue, orderedChoices],
  );

  if (!open || typeof document === 'undefined') {
    return null;
  }

  const hasSelection = draftSelection.length > 0;

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
            <div className="broadcast-audience-sheet__head">
              <div>
                <strong id="broadcast-audience-sheet-title">Активные чаты</strong>
              </div>
              <span className="broadcast-audience-sheet__badge">{draftSelection.length}</span>
            </div>

            <label
              className="field field--search broadcast-audience-sheet__search"
              htmlFor="broadcast-audience-search"
            >
              <span className="field__label">Поиск чата</span>
              <input
                id="broadcast-audience-search"
                type="search"
                placeholder="Поиск чата"
                value={searchValue}
                onChange={(event) => setSearchValue(event.target.value)}
                autoComplete="off"
                disabled={disabled}
              />
            </label>
          </div>

          {loading ? (
            <div className="broadcast-audience-sheet__state">
              <strong>Загружаем</strong>
            </div>
          ) : null}

          {!loading && error ? (
            <div className="broadcast-audience-sheet__state is-danger">{error}</div>
          ) : null}

          {!loading && !error && filteredChoices.length === 0 ? (
            <div className="broadcast-audience-sheet__state">
              <strong>{searchValue.trim() ? 'Ничего не найдено' : 'Активных чатов нет'}</strong>
            </div>
          ) : null}

          {!loading && !error && filteredChoices.length > 0 ? (
            <div className="broadcast-audience-sheet__list" aria-label="Список активных чатов">
              {filteredChoices.map((chat) => {
                const checked = draftSelection.includes(chat.id);
                return (
                  <label
                    key={`broadcast-audience-${chat.id}`}
                    className={cn('broadcast-audience-sheet__option', checked && 'is-selected')}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={disabled}
                      onChange={() => {
                        setDraftSelection((current) =>
                          current.includes(chat.id)
                            ? current.filter((item) => item !== chat.id)
                            : [...current, chat.id],
                        );
                      }}
                    />
                    <EntityAvatar
                      title={chat.title}
                      entityType="chat"
                      avatarUrl={chat.avatarUrl ?? null}
                      className="broadcast-audience-sheet__avatar"
                    />
                    <span className="broadcast-audience-sheet__option-copy">
                      <strong>{chat.title}</strong>
                      <small>{chat.link?.trim() || chat.id}</small>
                    </span>
                    <span className="broadcast-audience-sheet__option-meta">
                      {chat.id === currentChatId ? (
                        <span className="broadcast-audience-sheet__option-chip">Этот чат</span>
                      ) : null}
                      <span className="broadcast-audience-sheet__checkbox" aria-hidden>
                        {checked ? '✓' : ''}
                      </span>
                    </span>
                  </label>
                );
              })}
            </div>
          ) : null}

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
              Выбрать
            </button>
          </div>
        </div>
      </section>
    </div>,
    document.body,
  );
}
