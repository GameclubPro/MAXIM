import type {
  ApplySectionTargetPreviewResponse,
  ApplySettingsTarget,
} from '@maxim/contracts/settings';
import type { ManagedEntityFavoriteType } from '@maxim/contracts/managed-entities';
import type { CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { XmarkGlyph } from '../../components/ui/compact-icons';
import {
  HOME_ENTITY_FAVORITE_LABELS,
  HOME_ENTITY_FAVORITE_TITLES,
  HOME_ENTITY_FAVORITE_TYPES,
} from '../../lib/home-entity-favorites';
import { cn } from '../../lib/cn';
import type { ApplySectionKey } from '../settings-page-state';
import { APPLY_TARGET_FAVORITE_ICONS, SECTION_LABELS } from './settings-page-helpers';

type ApplyTargetSheetState = {
  section: ApplySectionKey;
  target: ApplySettingsTarget;
};

type SettingsApplyTargetSheetProps = {
  sheet: ApplyTargetSheetState | null;
  preview: ApplySectionTargetPreviewResponse | null;
  previewLoading: boolean;
  previewError: string | null;
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
  overlayStyle,
  isApplying,
  onClose,
  onTargetChange,
  onConfirm,
}: SettingsApplyTargetSheetProps) {
  if (!sheet) {
    return null;
  }

  const { target } = sheet;
  const canConfirm =
    !previewLoading && !previewError && !isApplying && (preview?.updatedChats ?? 0) > 0;

  function updateFavoriteType(favoriteType: ManagedEntityFavoriteType) {
    const currentTypes = target.favoriteTypes;
    const nextTypes = currentTypes.includes(favoriteType)
      ? currentTypes.filter((item) => item !== favoriteType)
      : [...currentTypes, favoriteType];

    onTargetChange({
      mode: nextTypes.length > 0 ? 'favoriteTypes' : 'allFavorites',
      favoriteTypes: nextTypes,
      chatIds: [],
    });
  }

  const content = (
    <div className="settings-apply-target" style={overlayStyle} role="dialog" aria-modal="true">
      <button
        type="button"
        className="settings-apply-target__backdrop"
        aria-label="Закрыть выбор чатов"
        onClick={onClose}
      />
      <div className="settings-apply-target__panel">
        <div className="settings-apply-target__header">
          <div>
            <strong>{SECTION_LABELS[sheet.section]}</strong>
          </div>
          <button
            type="button"
            className="settings-apply-target__close"
            aria-label="Закрыть"
            title="Закрыть"
            onClick={onClose}
          >
            <XmarkGlyph aria-hidden />
          </button>
        </div>

        <div className="settings-apply-target__modes" role="group" aria-label="Область применения">
          {[
            { mode: 'current' as const, title: 'Текущий' },
            { mode: 'all' as const, title: 'Все' },
            { mode: 'allFavorites' as const, title: 'Избранные' },
          ].map((item) => (
            <button
              key={item.mode}
              type="button"
              className={cn(
                'settings-apply-target__mode',
                target.mode === item.mode && 'is-active',
              )}
              aria-pressed={target.mode === item.mode}
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

        <div className="settings-apply-target__favorites">
          {HOME_ENTITY_FAVORITE_TYPES.map((favoriteType) => {
            const FavoriteIcon = APPLY_TARGET_FAVORITE_ICONS[favoriteType];
            const active =
              target.mode === 'favoriteTypes' && target.favoriteTypes.includes(favoriteType);

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
                <span>{HOME_ENTITY_FAVORITE_LABELS[favoriteType]}</span>
              </button>
            );
          })}
        </div>

        <div className="settings-apply-target__preview">
          {previewLoading ? (
            <span>...</span>
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
            {isApplying ? '...' : 'Применить'}
          </button>
        </div>
      </div>
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
