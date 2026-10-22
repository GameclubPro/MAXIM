import { useState, type ReactNode } from 'react';
import type { ChatSettingsFieldAdapter } from '../../features/network-settings/field-model';
import { setChatBoolean } from '../../features/network-settings/chat-field-intents';
import { AppIcon } from '../../components/ui/app-icon';
import { SegmentedControl } from '../../components/ui/segmented-control';
import {
  PROFANITY_SENSITIVITY_OPTIONS,
  PROFANITY_SENSITIVITY_HINTS,
} from '../settings-page.constants';
import { SharedNativeSettingsToggle } from './shared-native-settings-toggle';

export function SharedProfanitySettingsFields({
  fields,
  actions,
}: {
  fields: ChatSettingsFieldAdapter;
  actions: ReactNode;
}) {
  const [hintOpen, setHintOpen] = useState(false);
  const enabled = fields.read('russianProfanityFilterEnabled');
  const sensitivity = fields.read('profanitySensitivity');
  return (
    <div className="settings-section__collapse-inner">
      <SharedNativeSettingsToggle
        className="text-filter-card"
        title="Мат и оскорбления"
        label="Включить фильтр мата и оскорблений"
        state={enabled}
        disabled={fields.readOnly}
        onChange={(next) => setChatBoolean(fields, 'russianProfanityFilterEnabled', next)}
        hint={
          <button
            type="button"
            className={`settings-info-button${hintOpen ? ' is-open' : ''}`}
            aria-label="Пояснение для фильтра мата и оскорблений"
            aria-controls="russian-profanity-filter-enabled-hint"
            data-hint-key="textFiltersProfanity"
            aria-expanded={hintOpen}
            onClick={() => setHintOpen(!hintOpen)}
          >
            <AppIcon icon="InfoCircle" />
          </button>
        }
      >
        {hintOpen ? (
          <p id="russian-profanity-filter-enabled-hint" className="settings-native-toggle__hint">
            {sensitivity.kind === 'common'
              ? PROFANITY_SENSITIVITY_HINTS[sensitivity.value]
              : 'Чувствительность различается между выбранными чатами. Выберите общий режим, чтобы изменить её.'}
          </p>
        ) : null}
      </SharedNativeSettingsToggle>
      {enabled.kind !== 'common' || enabled.value ? (
        <>
          <div className="settings-native-toggle">
            <div className="settings-policy">
              <div className="settings-policy__label-row">
                <span className="field__label">Чувствительность</span>
              </div>
              <SegmentedControl
                value={sensitivity.kind === 'common' ? sensitivity.value : null}
                options={PROFANITY_SENSITIVITY_OPTIONS.map((option) => ({
                  ...option,
                  disabled: fields.readOnly || sensitivity.kind === 'loading',
                }))}
                onChange={(next) => {
                  if (next === 'CORE_ONLY' || next === 'BALANCED' || next === 'STRICT')
                    fields.setScalar('profanitySensitivity', next);
                }}
                className="settings-mode-segments"
                ariaLabel="Чувствительность фильтра мата и оскорблений"
              />
              {sensitivity.kind !== 'common' ? (
                <p className="field__hint">Разные значения</p>
              ) : null}
            </div>
          </div>
          <div
            className="settings-subsection-divider"
            role="separator"
            aria-label="Действия бота для нецензурной лексики"
          >
            <span>Действия бота</span>
          </div>
          {actions}
        </>
      ) : null}
    </div>
  );
}
