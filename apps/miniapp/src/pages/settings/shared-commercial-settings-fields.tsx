import { useState, type ReactNode } from 'react';
import {
  inferCommercialSliderPosition,
  resolveCommercialSanctionAction,
} from '@maxim/contracts/settings';
import type { ChatSettingsFieldAdapter } from '../../features/network-settings/field-model';
import {
  setChatBoolean,
  setChatCommercialSensitivity,
} from '../../features/network-settings/chat-field-intents';
import { AppIcon } from '../../components/ui/app-icon';
import { SharedNativeSettingsToggle } from './shared-native-settings-toggle';

export function SharedCommercialSettingsFields({
  fields,
  actions,
}: {
  fields: ChatSettingsFieldAdapter;
  actions: ReactNode;
}) {
  const [openHint, setOpenHint] = useState<'master' | 'sensitivity' | null>(null);
  const enabled = fields.read('commercialAdsFilterEnabled');
  const sensitivity = fields.read('commercialAdsSensitivity');
  const warning = fields.read('commercialAdsWarnThreshold');
  const deletion = fields.read('commercialAdsDeleteThreshold');
  const common =
    sensitivity.kind === 'common' && warning.kind === 'common' && deletion.kind === 'common';
  const position = common
    ? inferCommercialSliderPosition({
        commercialAdsSensitivity: sensitivity.value,
        commercialAdsWarnThreshold: warning.value,
        commercialAdsDeleteThreshold: deletion.value,
      })
    : null;
  const stages = {
    warn: fields.read('textFiltersWarnEnabled'),
    mute: fields.read('textFiltersMuteEnabled'),
    ban: fields.read('textFiltersBanEnabled'),
    message: fields.read('textFiltersBotMessageEnabled'),
  };
  const ladder =
    stages.warn.kind === 'common' &&
    stages.mute.kind === 'common' &&
    stages.ban.kind === 'common' &&
    stages.message.kind === 'common'
      ? [1, 2, 3, 4]
          .map((count) => {
            const action = resolveCommercialSanctionAction(count, {
              warnEnabled: stages.warn.kind === 'common' && stages.warn.value,
              muteEnabled: stages.mute.kind === 'common' && stages.mute.value,
              banEnabled: stages.ban.kind === 'common' && stages.ban.value,
            });
            return `${count}-е: ${count === 1 && stages.message.kind === 'common' && stages.message.value ? 'объяснение' : { NONE: 'без наказания', WARN: 'предупреждение', MUTE: 'ограничение', BAN: 'блокировка' }[action]}`;
          })
          .join(' · ')
      : 'Действия различаются между выбранными чатами.';
  const infoButton = (key: 'master' | 'sensitivity', label: string, id: string) => (
    <button
      type="button"
      className={`settings-info-button${openHint === key ? ' is-open' : ''}`}
      aria-label={label}
      aria-controls={id}
      aria-expanded={openHint === key}
      data-hint-key={key === 'master' ? 'textFiltersCommercial' : 'commercialSensitivity'}
      onClick={() => setOpenHint(openHint === key ? null : key)}
    >
      <AppIcon icon="InfoCircle" />
    </button>
  );
  return (
    <div className="settings-section__collapse-inner">
      <SharedNativeSettingsToggle
        className="text-filter-card"
        title="Фильтр рекламы"
        label="Фильтровать коммерческую рекламу"
        state={enabled}
        disabled={fields.readOnly}
        onChange={(next) => setChatBoolean(fields, 'commercialAdsFilterEnabled', next)}
        hint={infoButton(
          'master',
          'Пояснение для "Фильтровать коммерческую рекламу"',
          'commercial-ads-filter-enabled-hint',
        )}
      >
        {openHint === 'master' ? (
          <p id="commercial-ads-filter-enabled-hint" className="settings-native-toggle__hint">
            Бот ищет именно рекламную подачу: массовые объявления, услуги с контактами, продажи со
            скидками, доставкой, ссылками и призывом написать или позвонить. Частные объявления и
            бытовые разовые продажи старается пропускать.
          </p>
        ) : null}
      </SharedNativeSettingsToggle>
      {enabled.kind !== 'common' || enabled.value ? (
        <>
          <div
            className="settings-subsection-divider"
            role="separator"
            aria-label="Параметры коммерческого фильтра"
          >
            <span>Фильтр коммерческой рекламы</span>
          </div>
          <div className="settings-native-toggle commercial-settings-panel">
            <div className="commercial-sensitivity-slider">
              <div className="commercial-sensitivity-slider__head">
                <div className="settings-native-toggle__title-wrap">
                  <span className="field__label">Чувствительность</span>
                  {infoButton(
                    'sensitivity',
                    'Пояснение по чувствительности коммерческого фильтра',
                    'commercial-sensitivity-hint',
                  )}
                </div>
                <span className="chip chip--warning">
                  {!common
                    ? 'Разные значения'
                    : position === null
                      ? 'Свои настройки'
                      : position < 25
                        ? 'Мягко'
                        : position < 70
                          ? 'Баланс'
                          : 'Строго'}
                </span>
              </div>
              {common ? (
                <input
                  type="range"
                  min={0}
                  max={100}
                  step={1}
                  value={position ?? 69}
                  disabled={fields.readOnly}
                  onChange={(event) =>
                    setChatCommercialSensitivity(fields, Number(event.target.value))
                  }
                  aria-label="Ползунок чувствительности коммерческого фильтра"
                />
              ) : (
                <div
                  className="settings-mode-segments"
                  role="group"
                  aria-label="Выбрать общую чувствительность"
                >
                  {[
                    { value: 20, label: 'Мягко' },
                    { value: 50, label: 'Баланс' },
                    { value: 85, label: 'Строго' },
                  ].map((option) => (
                    <button
                      type="button"
                      key={option.value}
                      className="settings-duration-editor__preset"
                      disabled={fields.readOnly}
                      onClick={() => setChatCommercialSensitivity(fields, option.value)}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              )}
              <div className="commercial-sensitivity-slider__labels" aria-hidden>
                <span>Мягко</span>
                <span>Баланс</span>
                <span>Строго</span>
              </div>
            </div>
            {position === null ? (
              <p className="settings-native-toggle__hint">
                {common
                  ? 'Настройки заданы вручную. Переместите ползунок, чтобы выбрать другую чувствительность.'
                  : 'Чувствительность различается. Выберите общий профиль, чтобы изменить её во всех выбранных чатах.'}
              </p>
            ) : null}
            {openHint === 'sensitivity' ? (
              <p id="commercial-sensitivity-hint" className="settings-native-toggle__hint">
                Чувствительность меняет оценку рекламной подачи. Подтверждённая реклама удаляется;
                спорные сообщения сохраняются без наказания.
              </p>
            ) : null}
          </div>
          <p className="settings-native-toggle__hint">
            Подтверждённая реклама удаляется. Ниже можно выбрать наказание за повторы. Повторные
            нарушения считаются за 24 часа.
          </p>
          <p className="settings-native-toggle__hint">{ladder}</p>
          <div
            className="settings-subsection-divider"
            role="separator"
            aria-label="Действия бота для коммерческих объявлений"
          >
            <span>Действия бота · Коммерческая реклама</span>
          </div>
          {actions}
        </>
      ) : null}
    </div>
  );
}
