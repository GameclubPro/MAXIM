import type { BroadcastTargetMode, ChatSummary } from '@maxim/contracts';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  resolveBroadcastAudienceTargetLabel,
  type BroadcastScopedTargetMode,
} from '../lib/broadcast-audience';
import {
  buildBroadcastAudiencePresentation,
  buildBroadcastAudiencePreviewBundle,
  toManagedBroadcastTargetPreview,
} from '../lib/broadcast-audience-presentation';
import {
  getHomeEntityFavoriteIds,
  getHomeEntityFavoritesFallbackScope,
  mergeHomeEntityFavorites,
  readHomeEntityFavorites,
  saveHomeEntityFavorites,
} from '../lib/home-entity-favorites';
import { cn } from '../lib/cn';
import { getInitDataUserId } from '../lib/init-data';
import { useNativeBackHandler } from '../lib/native-back';
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
  const [storedFavoriteChatIds, setStoredFavoriteChatIds] = useState(() =>
    getHomeEntityFavoriteIds(readHomeEntityFavorites(favoriteStorageScope), 'chat'),
  );
  const favoriteStorageScopeRef = useRef(favoriteStorageScope);
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
  const selectedModeActive = targetMode === 'selected';
  const allModeActive = targetMode === 'all';
  const allChoicesLabel =
    choices.length > 0 ? formatAudienceCountLabel(choices.length) : 'Все чаты';
  const currentChatChoice = choices.find((chat) => chat.id === currentChatId);
  const currentChatPreview = currentChatChoice
    ? toManagedBroadcastTargetPreview(currentChatChoice)
    : currentChatId
      ? {
          id: currentChatId,
          title: currentLabel,
          entityType: 'chat' as const,
          link: null,
          avatarUrl: null,
        }
      : null;

  useNativeBackHandler(
    () => {
      setAllConfirmOpen(false);
      return true;
    },
    { enabled: allConfirmOpen, priority: 640 },
  );
  const selectedPreviewBundle = buildBroadcastAudiencePreviewBundle({
    targetChatIds,
    choices,
    currentChat: currentChatPreview,
  });
  const currentAudiencePresentation = buildBroadcastAudiencePresentation({
    targetMode: 'current',
    targetChatIds: currentChatId ? [currentChatId] : [],
    targetPreviews: currentChatPreview ? [currentChatPreview] : [],
    currentLabel,
    currentTitle: currentChatPreview?.title ?? currentLabel,
  });
  const selectedAudiencePresentation = buildBroadcastAudiencePresentation({
    targetMode: 'selected',
    targetChatIds,
    targetPreviews: selectedPreviewBundle.previews,
    targetOverflowCount: selectedPreviewBundle.overflowCount,
    currentLabel,
  });
  const allAudiencePresentation = buildBroadcastAudiencePresentation({
    targetMode: 'all',
    targetChatIds: choices.map((chat) => chat.id),
    targetPreviews: choices.slice(0, 3).map((chat) => toManagedBroadcastTargetPreview(chat)),
    targetOverflowCount: Math.max(0, choices.length - 3),
    targetChats: choices.length,
    allLabel,
  });
  const currentTabLabel = currentLabel.startsWith('Текущий') ? 'Текущий' : currentLabel;
  const allTabLabel = allLabel.startsWith('Все') ? 'Все' : allLabel;
  const audienceSummary =
    targetMode === 'all'
      ? allAudiencePresentation.label
      : targetMode === 'selected'
        ? selectedAudiencePresentation.label
        : currentAudiencePresentation.label;
  const audienceSummaryMeta =
    targetMode === 'all'
      ? allChoicesLabel
      : targetMode === 'selected'
        ? selectedAudiencePresentation.compactLabel
        : currentAudiencePresentation.compactLabel;
  const audienceTriggerContent = (
    <>
      <span className="broadcast-audience-card__trigger-copy">
        <strong>
          {targetMode === 'all' ? 'Все чаты' : targetMode === 'selected' ? 'Чаты' : 'Получатель'}
        </strong>
        <small>
          {remoteError || loading
            ? triggerLabel
            : audienceSummary || audienceSummaryMeta || selectedAudienceLabel}
        </small>
      </span>
      <span className="broadcast-audience-card__trigger-badge">
        {targetMode === 'all'
          ? choices.length
          : targetMode === 'selected'
            ? targetChatIds.length
            : 1}
      </span>
    </>
  );

  function handleTargetModeChange(nextMode: BroadcastTargetMode) {
    if (disabled) {
      return;
    }

    if (nextMode === 'current') {
      onToggleAllChats(false);
      setAllConfirmOpen(false);
      onChangeScopedMode('current');
      return;
    }

    if (nextMode === 'selected') {
      onToggleAllChats(false);
      setAllConfirmOpen(false);
      onChangeScopedMode('selected');
      onClearValidationError();
      setSheetOpen(true);
      return;
    }

    if (!allModeActive) {
      setAllConfirmOpen(true);
    }
  }

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
        setStoredFavoriteChatIds(
          getHomeEntityFavoriteIds(readHomeEntityFavorites(favoriteStorageScope), 'chat'),
        );
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
    setStoredFavoriteChatIds(getHomeEntityFavoriteIds(nextFavorites, 'chat'));
  }, [favoriteStorageScope, sheetOpen]);

  return (
    <>
      <div className="broadcast-audience-card">
        <SegmentedControl<BroadcastTargetMode>
          className="broadcast-audience-card__mode-tabs"
          ariaLabel="Кому отправить"
          value={targetMode}
          onChange={handleTargetModeChange}
          options={[
            { value: 'current', label: currentTabLabel },
            { value: 'selected', label: selectedLabel },
            { value: 'all', label: allTabLabel },
          ]}
        />

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
                Отмена
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
                Отправить во все
              </button>
            </span>
          </div>
        ) : null}

        {targetMode && selectedModeActive ? (
          <button
            type="button"
            className={cn('broadcast-audience-card__trigger', remoteError && 'is-warning')}
            onClick={() => {
              onClearValidationError();
              setSheetOpen(true);
            }}
            disabled={disabled}
          >
            {audienceTriggerContent}
          </button>
        ) : null}

        {targetMode && !selectedModeActive ? (
          <div
            className={cn(
              'broadcast-audience-card__trigger',
              'is-static',
              remoteError && 'is-warning',
            )}
          >
            {audienceTriggerContent}
          </div>
        ) : null}

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
