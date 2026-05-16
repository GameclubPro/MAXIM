import type { ApplySectionKey } from '../settings-page-state';

type SettingsSectionSaveFooterOptions = {
  note?: string | null;
  saveLabel?: string;
  applyToAllLabel?: string;
  emphasize?: 'save' | 'apply';
};

type SettingsSectionSaveFooterProps = {
  section: ApplySectionKey;
  options?: SettingsSectionSaveFooterOptions;
  isSavingSettings: boolean;
  savingSection: ApplySectionKey | null;
  isApplyingSectionToAll: boolean;
  applyingSection: ApplySectionKey | null;
  canApplyToAllChats: boolean;
  isSectionDirty: (section: ApplySectionKey) => boolean;
  onSaveSection: (section: ApplySectionKey) => void;
  onOpenApplyTarget: (section: ApplySectionKey) => void;
};

export function SettingsSectionSaveFooter({
  section,
  options,
  isSavingSettings,
  savingSection,
  isApplyingSectionToAll,
  applyingSection,
  canApplyToAllChats,
  isSectionDirty,
  onSaveSection,
  onOpenApplyTarget,
}: SettingsSectionSaveFooterProps) {
  const isCurrentSectionSaving = isSavingSettings && savingSection === section;
  const isCurrentSectionApplying = isApplyingSectionToAll && applyingSection === section;
  const emphasize = options?.emphasize ?? 'apply';
  const saveButtonClassName =
    emphasize === 'save' ? 'button button--accent' : 'button button--ghost';
  const applyToAllButtonClassName =
    emphasize === 'save' ? 'button button--ghost' : 'button button--accent';
  const footerNote = options?.note !== undefined ? options.note : null;

  return (
    <>
      {footerNote ? <p className="settings-drilldown__footer-note">{footerNote}</p> : null}
      <div className="settings-drilldown__footer-actions">
        <button
          type="button"
          className={saveButtonClassName}
          onClick={() => onSaveSection(section)}
          disabled={isCurrentSectionSaving || isCurrentSectionApplying || !isSectionDirty(section)}
        >
          {isCurrentSectionSaving ? 'Сохраняем...' : (options?.saveLabel ?? 'Сохранить')}
        </button>
        <button
          type="button"
          className={applyToAllButtonClassName}
          onClick={() => onOpenApplyTarget(section)}
          disabled={isCurrentSectionSaving || isCurrentSectionApplying || !canApplyToAllChats}
        >
          {isCurrentSectionApplying ? 'Сохраняем...' : (options?.applyToAllLabel ?? 'Выбрать чаты')}
        </button>
      </div>
    </>
  );
}
