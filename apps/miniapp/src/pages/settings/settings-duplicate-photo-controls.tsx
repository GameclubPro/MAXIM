import type { DuplicatePhotoEffectivePolicy } from '@maxim/contracts/settings';
import { SegmentedControl } from '../../components/ui/segmented-control';
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
  return (
    <>
      <div className="settings-native-toggle duplicate-photo-toggle">
        <div className="settings-native-toggle__row">
          <div className="settings-native-toggle__title-wrap">
            <span className="settings-native-toggle__title">Изображения</span>
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
        <p className="settings-native-toggle__hint">
          Находит ту же картинку после пересылки, сжатия или изменения размера. Содержание и лица не
          распознаются.
        </p>
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
            </div>
            <SegmentedControl
              value={matchPreset}
              options={DUPLICATE_PHOTO_MATCH_OPTIONS}
              onChange={onMatchPresetChange}
              className="settings-mode-segments duplicate-photo-settings__segments"
              ariaLabel="Какие фото считать повтором"
            />
            <p className="policy-mode-hint">
              {formatDuplicatePhotoMatchPresetHint(matchPreset, moderationPolicy)}
            </p>
          </div>

          <div className="settings-policy duplicate-photo-settings__policy">
            <div className="settings-policy__label-row">
              <span className="field__label">Где искать повтор</span>
            </div>
            <SegmentedControl
              value={scope}
              options={DUPLICATE_PHOTO_SCOPE_OPTIONS}
              onChange={onScopeChange}
              className="settings-mode-segments duplicate-photo-settings__segments"
              ariaLabel="Где искать повторное фото"
            />
            <p className="policy-mode-hint">
              {scope === 'CHAT'
                ? 'Сравниваем с фото всех участников. Совпадение относится только к текущему автору.'
                : 'Сравниваем только с предыдущими фото этого же участника.'}
            </p>
          </div>
        </div>
      ) : null}
    </>
  );
}
