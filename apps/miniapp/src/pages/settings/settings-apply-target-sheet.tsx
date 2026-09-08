import type {
  ApplySectionTargetPreviewResponse,
  ApplySettingsTarget,
} from '@maxim/contracts/settings';
import type { ManagedEntityFavoriteType } from '@maxim/contracts/managed-entities';
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { HOME_ENTITY_FAVORITE_ICONS, XmarkGlyph } from '../../components/ui/compact-icons';
import { getMe } from '../../lib/api/me-client';
import type { ApiTransport } from '../../lib/api/transport';
import {
  HOME_ENTITY_FAVORITE_TYPES,
  resolveHomeEntityFavoriteLabels,
  type HomeEntityFavoriteLabelOverrides,
} from '../../lib/home-entity-favorites';
import { cn } from '../../lib/cn';
import { isTopmostModalDialog, useDialogFocusTrap } from '../../lib/dialog-focus';
import { useNativeBackHandler } from '../../lib/native-back';
import type { ApplySectionKey } from '../settings-page-state';
import {
  formatApplyTargetCountLabel,
  isApplySettingsTargetPreviewCurrent,
} from './settings-apply-target';
import './settings-apply-target-sheet.css';

type ApplyTargetSheetState = {
  section: ApplySectionKey;
  target: ApplySettingsTarget;
};

type FavoriteLabelsLoadStatus = 'loading' | 'ready' | 'error';

const HOME_ENTITY_FAVORITE_TITLES: Record<ManagedEntityFavoriteType, string> = {
  important: 'Важные чаты',
  watch: 'Чаты, за которыми нужно следить',
  broadcast: 'Чаты для публикаций',
  test: 'Чаты для проверки настроек',
  partner: 'Чаты партнёров и клиентов',
  service: 'Рабочие чаты',
};

type SettingsApplyTargetSheetProps = {
  api: ApiTransport;
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

export function SettingsApplyTargetSheet({
  api,
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
  const [favoriteLabelOverrides, setFavoriteLabelOverrides] =
    useState<HomeEntityFavoriteLabelOverrides>({});
  const [favoriteLabelsStatus, setFavoriteLabelsStatus] =
    useState<FavoriteLabelsLoadStatus>('loading');
  const favoriteLabels = useMemo(
    () => resolveHomeEntityFavoriteLabels(favoriteLabelOverrides),
    [favoriteLabelOverrides],
  );

  useNativeBackHandler(
    () => {
      if (isApplying) {
        return true;
      }

      onClose();
      return true;
    },
    { enabled: Boolean(sheet), priority: 690 },
  );

  useEffect(() => {
    const controller = new AbortController();
    setFavoriteLabelOverrides({});
    setFavoriteLabelsStatus('loading');

    void import('../../lib/home-entity-favorite-label-sync')
      .then(async (runtime) => {
        const [me, server] = await Promise.all([
          getMe(api, { signal: controller.signal }),
          runtime.loadManagedEntityFavoriteLabels(api, controller.signal),
        ]);
        const userId = me.userId.trim();
        if (!userId) {
          throw new Error('Invalid favorite label profile identity');
        }

        const labels = server.initialized
          ? server.labels
          : await runtime.hydrateHomeEntityFavoriteLabelMigrationCandidate(`u:${userId}`, {
              signal: controller.signal,
              waitForNativeStorage: true,
            });
        if (controller.signal.aborted) {
          return;
        }

        setFavoriteLabelOverrides(labels);
        setFavoriteLabelsStatus('ready');
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setFavoriteLabelsStatus('error');
        }
      });

    return () => controller.abort();
  }, [api]);

  useEffect(() => {
    if (!isOpen) {
      return undefined;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') {
        return;
      }

      const panel = panelRef.current;
      if (!panel || !isTopmostModalDialog(panel)) {
        return;
      }

      event.preventDefault();
      event.stopImmediatePropagation();
      if (!isApplying) {
        onClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isApplying, isOpen, onClose]);

  if (!sheet) {
    return null;
  }

  const { target } = sheet;
  const favoriteTargetSelected = target.mode === 'allFavorites' || target.mode === 'favoriteTypes';
  const previewMatchesTarget = isApplySettingsTargetPreviewCurrent(target, preview);
  const canConfirm =
    previewMatchesTarget &&
    !previewLoading &&
    !previewError &&
    !isApplying &&
    (!favoriteTargetSelected || favoriteLabelsStatus === 'ready') &&
    (preview?.updatedChats ?? 0) > 0;
  const visibleChats = previewMatchesTarget ? (preview?.sampleChats.slice(0, 4) ?? []) : [];
  const remainingChats = Math.max(0, (preview?.updatedChats ?? 0) - visibleChats.length);

  function updateFavoriteType(favoriteType: ManagedEntityFavoriteType) {
    if (isApplying) {
      return;
    }
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
            <strong id={titleId}>{sectionLabel}</strong>
            <span id={descriptionId}>
              {target.mode === 'current'
                ? 'Сохраним настройки этого раздела только в текущем чате.'
                : 'Сохраним этот чат и заменим настройки раздела в выбранных чатах.'}
            </span>
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
              disabled={isApplying}
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

        {favoriteTargetSelected ? (
          <div
            className="settings-apply-target__favorites"
            role="group"
            aria-label="Категории избранного"
            aria-busy={favoriteLabelsStatus === 'loading' || undefined}
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
                  disabled={isApplying || favoriteLabelsStatus !== 'ready'}
                  onClick={() => updateFavoriteType(favoriteType)}
                >
                  <FavoriteIcon aria-hidden />
                  <span>{favoriteLabels[favoriteType]}</span>
                </button>
              );
            })}
          </div>
        ) : null}

        <div
          className="settings-apply-target__preview"
          aria-live="polite"
          aria-busy={previewLoading || (!previewError && !previewMatchesTarget) || undefined}
        >
          {favoriteTargetSelected && favoriteLabelsStatus === 'loading' ? (
            <span>Загружаем категории…</span>
          ) : favoriteTargetSelected && favoriteLabelsStatus === 'error' ? (
            <span className="is-danger">Названия категорий временно недоступны.</span>
          ) : previewLoading || (!previewError && !previewMatchesTarget) ? (
            <span>Проверяем выбранные чаты…</span>
          ) : previewError ? (
            <span className="is-danger">{previewError}</span>
          ) : (
            <>
              <strong>
                {preview?.updatedChats
                  ? formatApplyTargetCountLabel(preview.updatedChats)
                  : 'Нет подходящих чатов'}
              </strong>
              {visibleChats.length > 0 ? (
                <ul className="settings-apply-target__chat-list" aria-label="Выбранные чаты">
                  {visibleChats.map((chat) => (
                    <li key={chat.id}>{chat.title}</li>
                  ))}
                  {remainingChats > 0 ? <li>И ещё {remainingChats}</li> : null}
                </ul>
              ) : null}
            </>
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
            onClick={() => {
              if (canConfirm) {
                onConfirm();
              }
            }}
            disabled={!canConfirm}
          >
            <span className="settings-apply-target__confirm-label">
              {isApplying ? 'Сохраняем…' : target.mode === 'current' ? 'Сохранить' : 'Применить'}
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
