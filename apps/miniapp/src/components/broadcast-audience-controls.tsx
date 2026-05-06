import type { BroadcastTargetMode, ChatSummary } from '@maxim/contracts';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  resolveBroadcastAudienceTargetLabel,
  type BroadcastScopedTargetMode,
} from '../lib/broadcast-audience';
import {
  getHomeEntityFavoritesFallbackScope,
  mergeHomeEntityFavorites,
  readHomeEntityFavorites,
  saveHomeEntityFavorites,
} from '../lib/home-entity-favorites';
import { cn } from '../lib/cn';
import { getInitDataUserId } from '../lib/init-data';
import { BroadcastAudienceSheet } from './broadcast-audience-sheet';
import { SegmentedControl } from './ui/segmented-control';

function formatAudienceCountLabel(count: number): string {
  const normalized = Math.abs(count) % 100;
  const remainder = normalized % 10;
  if (normalized > 10 && normalized < 20) {
    return `${count} чатов`;
  }
  if (remainder === 1) {
    return `${count} чат`;
  }
  if (remainder > 1 && remainder < 5) {
    return `${count} чата`;
  }
  return `${count} чатов`;
}

type BroadcastAudienceControlsProps = {
  targetMode: BroadcastTargetMode;
  currentChatId: string;
  targetChatIds: string[];
  favoriteChatIds?: readonly string[];
  favoriteUserId?: string | null;
  choices: ChatSummary[];
  currentLabel?: string;
  selectedLabel?: string;
  allLabel?: string;
  loading?: boolean;
  refreshing?: boolean;
  remoteError?: string | null;
  validationError?: string | null;
  disabled?: boolean;
  onToggleAllChats: (enabled: boolean) => void;
  onChangeScopedMode: (mode: BroadcastScopedTargetMode) => void;
  onApplySelection: (nextSelection: string[]) => void;
  onClearValidationError: () => void;
  onRefreshChoices?: () => void;
};

export function BroadcastAudienceControls({
  targetMode,
  currentChatId,
  targetChatIds,
  favoriteChatIds,
  favoriteUserId = null,
  choices,
  currentLabel = 'Текущий чат',
  selectedLabel = 'Выбрать',
  allLabel = 'Все чаты',
  loading = false,
  refreshing = false,
  remoteError = null,
  validationError = null,
  disabled = false,
  onToggleAllChats,
  onChangeScopedMode,
  onApplySelection,
  onClearValidationError,
  onRefreshChoices,
}: BroadcastAudienceControlsProps) {
  const [sheetOpen, setSheetOpen] = useState(false);
  const [allConfirmOpen, setAllConfirmOpen] = useState(false);
  const favoriteStorageScope = useMemo(() => {
    const normalizedUserId = favoriteUserId?.trim() || getInitDataUserId()?.trim() || '';
    return normalizedUserId ? `u:${normalizedUserId}` : getHomeEntityFavoritesFallbackScope();
  }, [favoriteUserId]);
  const [storedFavoriteChatIds, setStoredFavoriteChatIds] = useState(
    () => readHomeEntityFavorites(favoriteStorageScope).chat,
  );
  const favoriteStorageScopeRef = useRef(favoriteStorageScope);
  const scopedTargetMode: BroadcastScopedTargetMode =
    targetMode === 'selected' ? 'selected' : 'current';
  const effectiveFavoriteChatIds = favoriteChatIds ?? storedFavoriteChatIds;
  const selectedAudienceLabel = resolveBroadcastAudienceTargetLabel({
    targetMode: 'selected',
    targetChatIds,
  });
  const triggerLabel = loading
    ? 'Собираем список'
    : remoteError
      ? 'Обновить список'
      : selectedAudienceLabel;
  const currentModeActive = targetMode === 'current';
  const selectedModeActive = targetMode === 'selected';
  const allModeActive = targetMode === 'all';
  const allChoicesLabel =
    choices.length > 0 ? formatAudienceCountLabel(choices.length) : 'Все чаты';

  useEffect(() => {
    if (targetMode !== 'selected') {
      setSheetOpen(false);
    }

    if (targetMode !== 'all') {
      setAllConfirmOpen(false);
    }
  }, [targetMode]);

  useEffect(() => {
    if (targetMode === 'selected' && validationError) {
      setSheetOpen(true);
    }
  }, [targetMode, validationError]);

  useEffect(() => {
    const previousScope = favoriteStorageScopeRef.current;
    if (previousScope === favoriteStorageScope) {
      if (sheetOpen) {
        setStoredFavoriteChatIds(readHomeEntityFavorites(favoriteStorageScope).chat);
      }
      return;
    }

    const storedFavorites = readHomeEntityFavorites(favoriteStorageScope);
    const nextFavorites =
      previousScope === getHomeEntityFavoritesFallbackScope() &&
      favoriteStorageScope !== getHomeEntityFavoritesFallbackScope()
        ? mergeHomeEntityFavorites(storedFavorites, readHomeEntityFavorites(previousScope))
        : storedFavorites;

    if (nextFavorites !== storedFavorites) {
      saveHomeEntityFavorites(favoriteStorageScope, nextFavorites);
    }

    favoriteStorageScopeRef.current = favoriteStorageScope;
    setStoredFavoriteChatIds(nextFavorites.chat);
  }, [favoriteStorageScope, sheetOpen]);

  return (
    <>
      <div className="broadcast-audience-card">
        <div
          className="broadcast-audience-card__mode-grid"
          role="group"
          aria-label="Кому отправить"
        >
          <button
            type="button"
            className={cn('broadcast-audience-card__mode', currentModeActive && 'is-active')}
            aria-pressed={currentModeActive}
            disabled={disabled}
            onClick={() => {
              onToggleAllChats(false);
              setAllConfirmOpen(false);
              onChangeScopedMode('current');
            }}
          >
            <span className="broadcast-audience-card__mode-indicator" aria-hidden />
            <strong>{currentLabel}</strong>
            <small>1 чат</small>
          </button>

          <button
            type="button"
            className={cn('broadcast-audience-card__mode', selectedModeActive && 'is-active')}
            aria-pressed={selectedModeActive}
            disabled={disabled}
            onClick={() => {
              onToggleAllChats(false);
              setAllConfirmOpen(false);
              onChangeScopedMode('selected');
              onClearValidationError();
              setSheetOpen(true);
            }}
          >
            <span className="broadcast-audience-card__mode-indicator" aria-hidden />
            <strong>{selectedLabel}</strong>
            <small>{selectedModeActive ? triggerLabel : selectedAudienceLabel}</small>
          </button>

          <button
            type="button"
            className={cn('broadcast-audience-card__mode', allModeActive && 'is-active')}
            aria-pressed={allModeActive}
            disabled={disabled}
            onClick={() => {
              if (allModeActive) {
                return;
              }
              setAllConfirmOpen(true);
            }}
          >
            <span className="broadcast-audience-card__mode-indicator" aria-hidden />
            <strong>{allLabel}</strong>
            <small>{allChoicesLabel}</small>
          </button>
        </div>

        {allConfirmOpen ? (
          <div className="broadcast-audience-confirm" role="alertdialog" aria-label="Все чаты">
            <span className="broadcast-audience-confirm__copy">
              <strong>Все</strong>
              <small>{allChoicesLabel}</small>
            </span>
            <span className="broadcast-audience-confirm__actions">
              <button
                type="button"
                className="broadcast-audience-confirm__ghost"
                onClick={() => setAllConfirmOpen(false)}
                disabled={disabled}
              >
                Назад
              </button>
              <button
                type="button"
                className="broadcast-audience-confirm__primary"
                onClick={() => {
                  onToggleAllChats(true);
                  setAllConfirmOpen(false);
                }}
                disabled={disabled}
              >
                {allLabel} {choices.length > 0 ? choices.length : ''}
              </button>
            </span>
          </div>
        ) : null}

        {selectedModeActive ? (
          <button
            type="button"
            className="broadcast-audience-card__trigger"
            onClick={() => {
              onClearValidationError();
              setSheetOpen(true);
            }}
            disabled={disabled}
          >
            <span className="broadcast-audience-card__trigger-copy">
              <strong>Чаты</strong>
              <small>{triggerLabel}</small>
            </span>
            <span className="broadcast-audience-card__trigger-badge">{targetChatIds.length}</span>
          </button>
        ) : null}

        <SegmentedControl
          className="broadcast-scope-control broadcast-scope-control--legacy"
          ariaLabel="Кому отправить"
          value={scopedTargetMode}
          onChange={(value) => onChangeScopedMode(value === 'selected' ? 'selected' : 'current')}
          options={[
            { value: 'current', label: 'Текущий' },
            { value: 'selected', label: 'Выбрать' },
          ]}
        />

        {validationError ? <small className="field__hint">{validationError}</small> : null}
      </div>

      <BroadcastAudienceSheet
        open={sheetOpen}
        currentChatId={currentChatId}
        favoriteChatIds={effectiveFavoriteChatIds}
        choices={choices}
        selection={targetChatIds}
        disabled={disabled}
        loading={loading}
        refreshing={refreshing}
        error={remoteError}
        onClose={() => setSheetOpen(false)}
        onApply={(nextSelection) => {
          onApplySelection(nextSelection);
          setSheetOpen(false);
        }}
        onRefresh={onRefreshChoices}
      />
    </>
  );
}
