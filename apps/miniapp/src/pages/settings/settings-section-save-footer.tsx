import type { ApplySectionKey } from '../settings-page-state';

type SettingsSectionSaveFooterOptions = {
  note?: string | null;
  saveLabel?: string;
};

type SettingsSectionSaveFooterProps = {
  section: ApplySectionKey;
  options?: SettingsSectionSaveFooterOptions;
  isSavingSettings: boolean;
  savingSection: ApplySectionKey | null;
  isApplyingSectionToAll: boolean;
  applyingSection: ApplySectionKey | null;
  onSaveSection: (section: ApplySectionKey) => void;
};

export function SettingsSectionSaveFooter({
  section,
  options,
  isSavingSettings,
  savingSection,
  isApplyingSectionToAll,
  applyingSection,
  onSaveSection,
}: SettingsSectionSaveFooterProps) {
  const isCurrentSectionSaving = isSavingSettings && savingSection === section;
  const isCurrentSectionApplying = isApplyingSectionToAll && applyingSection === section;
  const footerNote = options?.note !== undefined ? options.note : null;

  return (
    <>
      {footerNote ? <p className="settings-drilldown__footer-note">{footerNote}</p> : null}
      <div className="settings-drilldown__footer-actions is-single-action">
        <button
          type="button"
          className="button button--accent"
          onClick={() => onSaveSection(section)}
          disabled={isCurrentSectionSaving || isCurrentSectionApplying}
        >
          {isCurrentSectionSaving ? 'Сохраняем...' : (options?.saveLabel ?? 'Сохранить')}
        </button>
      </div>
    </>
  );
}
