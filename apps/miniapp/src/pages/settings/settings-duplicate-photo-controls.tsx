import type { DuplicatePhotoEffectivePolicy } from '@maxim/contracts/settings';
import { useState } from 'react';
import { SegmentedControl } from '../../components/ui/segmented-control';
import { useHintPopoverAutoPosition } from '../../lib/hint-popover';
import { SettingsHintAnchor } from './settings-hint-anchor';
import type { HintKey } from './settings-page-helpers';
import {
  DUPLICATE_PHOTO_MATCH_OPTIONS,
  DUPLICATE_PHOTO_SCOPE_OPTIONS,
  formatDuplicatePhotoMatchPresetHint,
  type DuplicatePhotoMatchPreset,
  type DuplicatePhotoScope,
} from './settings-duplicate-photo-options';
import {
  formatDuplicatePhotoModerationHint,
  type DuplicatePhotoSanctionSettings,
} from './settings-duplicate-photo-status';

type SettingsDuplicatePhotoControlsProps = {
  actionSettings: DuplicatePhotoSanctionSettings;
  enabled: boolean;
  matchPreset: DuplicatePhotoMatchPreset;
  moderationPolicy: DuplicatePhotoEffectivePolicy;
  scope: DuplicatePhotoScope;
  onEnabledChange: (value: boolean) => void;
  onMatchPresetChange: (value: DuplicatePhotoMatchPreset) => void;
  onScopeChange: (value: DuplicatePhotoScope) => void;
};

export default function SettingsDuplicatePhotoControls({
  actionSettings,
  enabled,
  matchPreset,
  moderationPolicy,
  scope,
  onEnabledChange,
  onMatchPresetChange,
  onScopeChange,
}: SettingsDuplicatePhotoControlsProps) {
  const [openHintKey, setOpenHintKey] = useState<HintKey | null>(null);
  const toggleHint = (key: HintKey) => setOpenHintKey((current) => (current === key ? null : key));
  useHintPopoverAutoPosition(openHintKey !== null, openHintKey, () => setOpenHintKey(null));

  return (
    <>
      <div className="settings-native-toggle duplicate-photo-toggle">
        <div className="settings-native-toggle__row">
          <div className="settings-native-toggle__title-wrap">
            <span className="settings-native-toggle__title">Изображения</span>
            <SettingsHintAnchor
              hintKey="duplicatePhoto"
              openHintKey={openHintKey}
              onToggleHint={toggleHint}
              label="Как проверяются повторные фото"
            >
              Бот сравнивает фото с предыдущими изображениями за выбранный период. Количество
              разрешённых повторов настраивается ниже. Лица и содержание фотографий не распознаются.
            </SettingsHintAnchor>
          </div>

          <label className="settings-native-switch" aria-label="Включить проверку повторных фото">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(event) => onEnabledChange(event.target.checked)}
            />
            <span className="toggle-switch" aria-hidden>
              <span className="toggle-switch__thumb" />
            </span>
          </label>
        </div>
        {enabled ? (
          <p className="policy-mode-hint">
            {formatDuplicatePhotoModerationHint(moderationPolicy, actionSettings)}
          </p>
        ) : null}
      </div>

      {enabled ? (
        <div
          className="duplicate-photo-settings"
          role="group"
          aria-label="Настройки повторных фото"
        >
          <div className="settings-policy duplicate-photo-settings__policy">
            <div className="settings-policy__label-row">
              <span className="field__label">Какие фото считать повтором</span>
              <SettingsHintAnchor
                hintKey="duplicatePhotoMatch"
                openHintKey={openHintKey}
                onToggleHint={toggleHint}
                label="Какие изменения фото учитываются"
              >
                {formatDuplicatePhotoMatchPresetHint(matchPreset, moderationPolicy)}
              </SettingsHintAnchor>
            </div>
            <SegmentedControl
              value={matchPreset}
              options={DUPLICATE_PHOTO_MATCH_OPTIONS}
              onChange={onMatchPresetChange}
              className="settings-mode-segments duplicate-photo-settings__segments"
              ariaLabel="Какие фото считать повтором"
            />
          </div>

          <div className="settings-policy duplicate-photo-settings__policy">
            <div className="settings-policy__label-row">
              <span className="field__label">Где искать повтор</span>
              <SettingsHintAnchor
                hintKey="duplicatePhotoScope"
                openHintKey={openHintKey}
                onToggleHint={toggleHint}
                label="С чьими фото сравнивать"
              >
                {scope === 'CHAT'
                  ? 'Сравниваем с фото всех участников этого чата. При повторе правило применяется только к тому, кто сейчас отправил фото.'
                  : 'Сравниваем только с предыдущими фото этого же участника. Такое же фото от другого человека не считается его повтором.'}
              </SettingsHintAnchor>
            </div>
            <SegmentedControl
              value={scope}
              options={DUPLICATE_PHOTO_SCOPE_OPTIONS}
              onChange={onScopeChange}
              className="settings-mode-segments duplicate-photo-settings__segments"
              ariaLabel="Где искать повторное фото"
            />
          </div>
        </div>
      ) : null}
    </>
  );
}
