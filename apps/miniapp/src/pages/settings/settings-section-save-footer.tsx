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
  conflict?: { viewingSaved: boolean; onToggle: () => void };
};

export function SettingsSectionSaveFooter({
  section,
  options,
  isSavingSettings,
  savingSection,
  isApplyingSectionToAll,
  applyingSection,
  onSaveSection,
  conflict,
}: SettingsSectionSaveFooterProps) {
  const isCurrentSectionSaving = isSavingSettings && savingSection === section;
  const isCurrentSectionApplying = isApplyingSectionToAll && applyingSection === section;
  const footerNote = options?.note !== undefined ? options.note : null;

  return (
    <>
      {conflict ? (
        <div
          role="status"
          className="settings-drilldown__footer-note settings-drilldown__footer-conflict"
        >
          <p>
            Настройки изменились. Ваш черновик сохранён. Сейчас показан{' '}
            {conflict.viewingSaved ? 'сохранённый вариант' : 'ваш черновик'}.
          </p>
          <button type="button" className="button button--ghost" onClick={conflict.onToggle}>
            {conflict.viewingSaved ? 'Показать мой черновик' : 'Сравнить с сохранённым'}
          </button>
        </div>
      ) : null}
      {footerNote ? <p className="settings-drilldown__footer-note">{footerNote}</p> : null}
      <div className="settings-drilldown__footer-actions is-single-action">
        <button
          type="button"
          className="button button--accent"
          onClick={() => onSaveSection(section)}
          disabled={isSavingSettings || isApplyingSectionToAll}
          aria-busy={isCurrentSectionSaving || isCurrentSectionApplying || undefined}
        >
          {isCurrentSectionSaving || isCurrentSectionApplying
            ? 'Сохраняем...'
            : conflict
              ? conflict.viewingSaved
                ? 'Оставить сохранённый вариант'
                : 'Сохранить мой вариант'
              : (options?.saveLabel ?? 'Сохранить')}
        </button>
      </div>
    </>
  );
}
