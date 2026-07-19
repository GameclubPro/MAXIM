import type {
  ApplySectionTargetPreviewResponse,
  ApplySettingsTarget,
} from '@maxim/contracts/settings';
import type { ManagedEntityFavoriteType } from '@maxim/contracts/managed-entities';
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { HOME_ENTITY_FAVORITE_ICONS, XmarkGlyph } from '../../components/ui/compact-icons';
import {
  HOME_ENTITY_FAVORITE_TITLES,
  HOME_ENTITY_FAVORITE_TYPES,
  getHomeEntityFavoritesFallbackScope,
  hydrateHomeEntityFavoriteLabels,
  readHomeEntityFavoriteLabels,
  resolveHomeEntityFavoriteLabels,
} from '../../lib/home-entity-favorites';
import { cn } from '../../lib/cn';
import { isTopmostModalDialog, useDialogFocusTrap } from '../../lib/dialog-focus';
import { getInitDataUserId } from '../../lib/init-data';
import { useNativeBackHandler } from '../../lib/native-back';
import type { ApplySectionKey } from '../settings-page-state';
import './settings-apply-target-sheet.css';

type ApplyTargetSheetState = {
  section: ApplySectionKey;
  target: ApplySettingsTarget;
};

type SettingsApplyTargetSheetProps = {
  sheet: ApplyTargetSheetState | null;
  preview: ApplySectionTargetPreviewResponse | null;
  previewLoading: boolean;
  previewError: string | null;
  sectionLabel: string;
  overlayStyle: CSSProperties | undefined;
  isApplying: boolean;
  onClose: () => void;
  onTargetChange: (target: ApplySettingsTarget) => void;
  onConfirm: () => void;
};

function formatApplyTargetCountLabel(count: number): string {
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

export function SettingsApplyTargetSheet({
  sheet,
  preview,
  previewLoading,
  previewError,
  sectionLabel,
  overlayStyle,
  isApplying,
  onClose,
  onTargetChange,
  onConfirm,
}: SettingsApplyTargetSheetProps) {
  const panelRef = useRef<HTMLElement | null>(null);
  const isOpen = Boolean(sheet);
  useDialogFocusTrap(isOpen, panelRef, panelRef);
  const favoriteStorageScope = useMemo(() => {
    const userId = getInitDataUserId()?.trim();
    return userId ? `u:${userId}` : getHomeEntityFavoritesFallbackScope();
  }, []);
  const [favoriteLabelOverrides, setFavoriteLabelOverrides] = useState(() =>
    readHomeEntityFavoriteLabels(favoriteStorageScope),
  );
  const favoriteLabels = useMemo(
    () => resolveHomeEntityFavoriteLabels(favoriteLabelOverrides),
    [favoriteLabelOverrides],
  );

  useNativeBackHandler(
    () => {
      if (isApplying) {
        return false;
      }

      onClose();
      return true;
    },
    { enabled: Boolean(sheet), priority: 690 },
  );

  useEffect(() => {
    let cancelled = false;

    void hydrateHomeEntityFavoriteLabels(favoriteStorageScope).then((labels) => {
      if (!cancelled) {
        setFavoriteLabelOverrides(labels);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [favoriteStorageScope]);

  useEffect(() => {
    if (!isOpen) {
      return undefined;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || isApplying) {
        return;
      }

      const panel = panelRef.current;
      if (!panel || !isTopmostModalDialog(panel)) {
        return;
      }

      event.preventDefault();
      event.stopImmediatePropagation();
      onClose();
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isApplying, isOpen, onClose]);

  if (!sheet) {
    return null;
  }

  const { target } = sheet;
  const canConfirm =
    !previewLoading && !previewError && !isApplying && (preview?.updatedChats ?? 0) > 0;

  function updateFavoriteType(favoriteType: ManagedEntityFavoriteType) {
    const currentTypes =
      target.mode === 'allFavorites' ? [...HOME_ENTITY_FAVORITE_TYPES] : target.favoriteTypes;
    const nextTypes = currentTypes.includes(favoriteType)
      ? currentTypes.filter((item) => item !== favoriteType)
      : [...currentTypes, favoriteType];

    if (nextTypes.length === 0) {
      return;
    }

    onTargetChange({
      mode:
        nextTypes.length === HOME_ENTITY_FAVORITE_TYPES.length ? 'allFavorites' : 'favoriteTypes',
      favoriteTypes: nextTypes,
      chatIds: [],
    });
  }

  const titleId = `settings-apply-target-${sheet.section}-title`;
  const descriptionId = `settings-apply-target-${sheet.section}-description`;
  const content = (
    <div className="settings-apply-target" style={overlayStyle}>
      <button
        type="button"
        className="settings-apply-target__backdrop"
        aria-label="Закрыть выбор чатов"
        onClick={onClose}
        disabled={isApplying}
        tabIndex={-1}
      />
      <section
        ref={panelRef}
        className="settings-apply-target__panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        tabIndex={-1}
      >
        <div className="settings-apply-target__header">
          <div>
            <strong id={titleId}>Куда применить: {sectionLabel}</strong>
            <span id={descriptionId}>Настройки заменятся в выбранных чатах.</span>
          </div>
          <button
            type="button"
            className="settings-apply-target__close"
            aria-label="Закрыть выбор чатов"
            onClick={onClose}
            disabled={isApplying}
          >
            <XmarkGlyph aria-hidden />
          </button>
        </div>

        <div className="settings-apply-target__modes" role="group" aria-label="Область применения">
          {[
            { mode: 'current' as const, title: 'Этот чат' },
            { mode: 'all' as const, title: 'Все чаты' },
            { mode: 'allFavorites' as const, title: 'Категории' },
          ].map((item) => (
            <button
              key={item.mode}
              type="button"
              className={cn(
                'settings-apply-target__mode',
                (target.mode === item.mode ||
                  (item.mode === 'allFavorites' && target.mode === 'favoriteTypes')) &&
                  'is-active',
              )}
              aria-pressed={
                target.mode === item.mode ||
                (item.mode === 'allFavorites' && target.mode === 'favoriteTypes')
              }
              onClick={() =>
                onTargetChange({
                  mode: item.mode,
                  favoriteTypes: [],
                  chatIds: [],
                })
              }
            >
              <strong>{item.title}</strong>
            </button>
          ))}
        </div>

        {target.mode === 'allFavorites' || target.mode === 'favoriteTypes' ? (
          <div
            className="settings-apply-target__favorites"
            role="group"
            aria-label="Категории избранного"
          >
            {HOME_ENTITY_FAVORITE_TYPES.map((favoriteType) => {
              const FavoriteIcon = HOME_ENTITY_FAVORITE_ICONS[favoriteType];
              const active =
                target.mode === 'allFavorites' || target.favoriteTypes.includes(favoriteType);

              return (
                <button
                  key={favoriteType}
                  type="button"
                  className={cn(
                    'settings-apply-target__favorite',
                    `is-${favoriteType}`,
                    active && 'is-active',
                  )}
                  aria-pressed={active}
                  title={HOME_ENTITY_FAVORITE_TITLES[favoriteType]}
                  onClick={() => updateFavoriteType(favoriteType)}
                >
                  <FavoriteIcon aria-hidden />
                  <span>{favoriteLabels[favoriteType]}</span>
                </button>
              );
            })}
          </div>
        ) : null}

        <div className="settings-apply-target__preview">
          {previewLoading ? (
            <span>Считаем…</span>
          ) : previewError ? (
            <span className="is-danger">{previewError}</span>
          ) : (
            <strong>{formatApplyTargetCountLabel(preview?.updatedChats ?? 0)}</strong>
          )}
        </div>

        <div className="settings-apply-target__actions">
          <button
            type="button"
            className="button button--ghost"
            onClick={onClose}
            disabled={isApplying}
          >
            Отмена
          </button>
          <button
            type="button"
            className="button button--accent"
            onClick={onConfirm}
            disabled={!canConfirm}
          >
            <span className="settings-apply-target__confirm-label">
              {isApplying ? 'Применяем…' : 'Применить'}
            </span>
          </button>
        </div>
      </section>
    </div>
  );

  if (typeof document === 'undefined') {
    return content;
  }

  return createPortal(
    content,
    document.querySelector('.design-preview__device-screen') ?? document.body,
  );
}
