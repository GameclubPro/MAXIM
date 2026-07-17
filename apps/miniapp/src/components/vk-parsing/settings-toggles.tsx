import { Filter, Flash, InfoCircleSolid, ShieldCheck } from 'iconoir-react';
import type { VkParsingSettings } from '@maxim/contracts';
import { cn } from '../../lib/cn';
import {
  VK_PARSING_SETTING_TOGGLES,
  type VkParsingHintKey,
  type VkParsingSettingKey,
} from './types';

type SettingsTogglesProps = {
  settings: VkParsingSettings;
  openHintKey: VkParsingHintKey | null;
  isSaving: boolean;
  onToggleHint: (key: VkParsingHintKey) => void;
  onToggleSetting: (key: VkParsingSettingKey, checked: boolean) => void;
};

function renderSettingIcon(key: VkParsingSettingKey) {
  if (key === 'autoPublishEnabled') {
    return <Flash aria-hidden />;
  }
  if (key === 'stripLinksEnabled') {
    return <Filter aria-hidden />;
  }

  return <ShieldCheck aria-hidden />;
}

export function SettingsToggles({
  settings,
  openHintKey,
  isSaving,
  onToggleHint,
  onToggleSetting,
}: SettingsTogglesProps) {
  return (
    <div className="vk-parsing-settings" aria-label="Настройки импорта из VK">
      {VK_PARSING_SETTING_TOGGLES.map((item) => (
        <div
          key={item.key}
          className={cn('vk-parsing-setting-toggle', settings[item.key] && 'is-on')}
        >
          <div className="vk-parsing-setting-toggle__copy">
            <span className="vk-parsing-setting-toggle__icon">{renderSettingIcon(item.key)}</span>
            <span>{item.label}</span>
            <button
              type="button"
              className={cn('vk-parsing-info-button', openHintKey === item.key && 'is-active')}
              aria-label={`Подробнее: ${item.label}`}
              aria-expanded={openHintKey === item.key}
              aria-controls={`vk-parsing-setting-hint-${item.key}`}
              title={`Подробнее: ${item.label}`}
              onClick={() => onToggleHint(item.key)}
            >
              <InfoCircleSolid aria-hidden />
            </button>
          </div>
          <label className="settings-native-switch" aria-label={item.label}>
            <input
              type="checkbox"
              checked={settings[item.key]}
              disabled={isSaving}
              onChange={(event) => onToggleSetting(item.key, event.target.checked)}
            />
            <span className="toggle-switch" aria-hidden>
              <span className="toggle-switch__thumb" />
            </span>
          </label>
          {openHintKey === item.key ? (
            <div
              id={`vk-parsing-setting-hint-${item.key}`}
              className="vk-parsing-hint-popover vk-parsing-hint-popover--setting"
              role="status"
            >
              {item.hint}
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}
