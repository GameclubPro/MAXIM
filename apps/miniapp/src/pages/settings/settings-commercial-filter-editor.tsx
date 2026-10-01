import { InfoCircle } from 'iconoir-react';
import { resolveCommercialSanctionAction, type ChatSettings } from '@maxim/contracts/settings';
import { Suspense } from 'react';
import { BroadcastLinkButtonsEditor } from '../../components/broadcast-link-buttons-editor';
import { createEmptyBroadcastLinkButton } from '../../lib/broadcast-link-buttons';
import { cn } from '../../lib/cn';
import { recoverableLazyNamedComponent } from '../../lib/recoverable-lazy';
import { enableDefaultSanctionStages } from '../settings-page-state';
import { EditToggleButton } from './settings-edit-toggle-button';
import {
  COMMERCIAL_SENSITIVITY_MAX,
  COMMERCIAL_SENSITIVITY_MIN,
  TEXT_FILTERS_ADMIN_CONTACT_BUTTON_GROUP,
  TEXT_FILTERS_BOT_BUTTON_GROUP,
} from './settings-commercial-filter-controls';
import type { BotMessageEditorProps, WarnMessageEditorProps } from './settings-page-helpers';
import type { SettingsCommercialFilterSectionProps } from './settings-commercial-filter-section';

const LazyBotMessageEditorModule = recoverableLazyNamedComponent<BotMessageEditorProps>(
  () => import('../../components/bot-speech-message-editor'),
  'BotMessageEditor',
);
const LazyWarnMessageEditorModule = recoverableLazyNamedComponent<WarnMessageEditorProps>(
  () => import('../../components/bot-speech-message-editor'),
  'WarnMessageEditor',
);

function LazyBotMessageEditor(props: BotMessageEditorProps) {
  return (
    <Suspense fallback={null}>
      <LazyBotMessageEditorModule {...props} />
    </Suspense>
  );
}

function LazyWarnMessageEditor(props: WarnMessageEditorProps) {
  return (
    <Suspense fallback={null}>
      <LazyWarnMessageEditorModule {...props} />
    </Suspense>
  );
}

export function SettingsCommercialFilterEditor(props: SettingsCommercialFilterSectionProps) {
  const {
    api,
    botSpeechEditorProps,
    botSpeechPreviewContext,
    clearButtonGroupErrors,
    commercialSensitivityLabel,
    commercialSensitivitySliderValue,
    commercialPhotoModerationMode,
    draft,
    handleCommercialSensitivitySliderChange,
    hasTextFiltersBotButtonError,
    isSectionDirty,
    openBotEditorKey,
    openHintKey,
    openWarnEditorKey,
    renderAdminContactToggle,
    renderInlineHint,
    renderMuteStageToggle,
    setFieldValue,
    setOpenBotEditorKey,
    setOpenWarnEditorKey,
    textFiltersBotButtonErrors,
    toggleBotMessageEditor,
    toggleHint,
    toggleWarnMessageEditor,
    updateDraftButtonGroup,
  } = props;

  const sanctionLabels = {
    NONE: 'без наказания',
    WARN: 'предупреждение',
    MUTE: 'ограничение',
    BAN: 'блокировка',
  };
  const ladder = [1, 2, 3, 4]
    .map((count) => {
      const action = resolveCommercialSanctionAction(count, {
        warnEnabled: draft.textFiltersWarnEnabled,
        muteEnabled: draft.textFiltersMuteEnabled,
        banEnabled: draft.textFiltersBanEnabled,
      });
      return `${count}-е: ${count === 1 && draft.textFiltersBotMessageEnabled ? 'объяснение' : sanctionLabels[action]}`;
    })
    .join(' · ');
  const photoCoverage = {
    OFF: 'Фильтр фото: выключен.',
    OBSERVE: 'Фильтр фото: выключен.',
    FULL: 'Фильтр фото: включён.',
    UNKNOWN: 'Фильтр фото: недоступен.',
  }[commercialPhotoModerationMode];

  return (
    <div className="settings-section__collapse-inner">
      <div className="settings-native-toggle text-filter-card">
        <div className="settings-native-toggle__row">
          <div className="settings-native-toggle__title-wrap">
            <span className="settings-native-toggle__title">Фильтр рекламы</span>
            <button
              type="button"
              className={cn(
                'settings-info-button',
                openHintKey === 'textFiltersCommercial' && 'is-open',
              )}
              aria-label='Пояснение для "Фильтровать коммерческую рекламу"'
              aria-controls="commercial-ads-filter-enabled-hint"
              aria-expanded={openHintKey === 'textFiltersCommercial'}
              data-hint-key="textFiltersCommercial"
              onClick={() => toggleHint('textFiltersCommercial')}
            >
              <InfoCircle aria-hidden />
            </button>
          </div>

          <label className="settings-native-switch" aria-label="Фильтровать коммерческую рекламу">
            <input
              type="checkbox"
              checked={draft.commercialAdsFilterEnabled}
              onChange={(event) => {
                const enabled = event.target.checked;
                setFieldValue('commercialAdsFilterEnabled', enabled);
                if (enabled) {
                  enableDefaultSanctionStages(setFieldValue, 'textFilters');
                }
              }}
            />
            <span className="toggle-switch" aria-hidden>
              <span className="toggle-switch__thumb" />
            </span>
          </label>
        </div>

        {openHintKey === 'textFiltersCommercial' ? (
          <p id="commercial-ads-filter-enabled-hint" className="settings-native-toggle__hint">
            Бот ищет именно рекламную подачу: массовые объявления, услуги с контактами, продажи со
            скидками, доставкой, ссылками и призывом написать или позвонить. Частные объявления и
            бытовые разовые продажи старается пропускать.
          </p>
        ) : null}
      </div>

      {draft.commercialAdsFilterEnabled ? (
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
                  <button
                    type="button"
                    className={cn(
                      'settings-info-button',
                      openHintKey === 'commercialSensitivity' && 'is-open',
                    )}
                    aria-label="Пояснение по чувствительности коммерческого фильтра"
                    aria-controls="commercial-sensitivity-hint"
                    aria-expanded={openHintKey === 'commercialSensitivity'}
                    data-hint-key="commercialSensitivity"
                    onClick={() => toggleHint('commercialSensitivity')}
                  >
                    <InfoCircle aria-hidden />
                  </button>
                </div>
                <span className="chip chip--warning">
                  {commercialSensitivitySliderValue === null
                    ? 'Свои настройки'
                    : commercialSensitivityLabel}
                </span>
              </div>

              <input
                type="range"
                min={COMMERCIAL_SENSITIVITY_MIN}
                max={COMMERCIAL_SENSITIVITY_MAX}
                step={1}
                value={commercialSensitivitySliderValue ?? 69}
                onChange={(event) =>
                  handleCommercialSensitivitySliderChange(Number(event.target.value))
                }
                aria-label="Ползунок чувствительности коммерческого фильтра"
              />

              <div className="commercial-sensitivity-slider__labels" aria-hidden>
                <span>Мягко</span>
                <span>Баланс</span>
                <span>Строго</span>
              </div>
            </div>

            {commercialSensitivitySliderValue === null ? (
              <p className="settings-native-toggle__hint">
                Настройки заданы вручную. Переместите ползунок, чтобы выбрать другую
                чувствительность.
              </p>
            ) : null}

            {openHintKey === 'commercialSensitivity' ? (
              <p id="commercial-sensitivity-hint" className="settings-native-toggle__hint">
                Чувствительность меняет оценку рекламной подачи. Подтверждённая реклама удаляется;
                спорные сообщения сохраняются без наказания.
              </p>
            ) : null}
          </div>

          <p className="settings-native-toggle__hint">
            Подтверждённая реклама удаляется. Ниже можно выбрать наказание за повторы. Повторные
            нарушения считаются за 24 часа. {photoCoverage}
            {isSectionDirty('commercialFilter')
              ? ' Для фото показаны последние сохранённые настройки.'
              : ''}
          </p>
          <p className="settings-native-toggle__hint">{ladder}</p>

          <div
            className="settings-subsection-divider"
            role="separator"
            aria-label="Действия бота для коммерческих объявлений"
          >
            <span>Действия бота · Коммерческая реклама</span>
          </div>

          <div className="settings-native-toggle">
            <div className="settings-native-toggle__row">
              <div className="settings-native-toggle__title-wrap">
                <span className="settings-native-toggle__title">1. Объяснение</span>
                <div className="settings-native-toggle__title-actions">
                  <EditToggleButton
                    label="Редактировать текст сообщения об удалении рекламы"
                    onClick={() => toggleBotMessageEditor('textFilters')}
                    disabled={!draft.textFiltersBotMessageEnabled}
                    isOpen={openBotEditorKey === 'textFilters'}
                  />
                  <button
                    type="button"
                    className={cn(
                      'settings-info-button',
                      openHintKey === 'textFiltersBotMessage' && 'is-open',
                    )}
                    aria-label="Пояснение для тумблера сообщений о коммерческих объявлениях"
                    aria-controls="text-filters-bot-message-hint"
                    aria-expanded={openHintKey === 'textFiltersBotMessage'}
                    data-hint-key="textFiltersBotMessage"
                    onClick={() => toggleHint('textFiltersBotMessage')}
                  >
                    <InfoCircle aria-hidden />
                  </button>
                </div>
              </div>

              <label
                className="settings-native-switch"
                aria-label="Включить сообщение от бота для коммерческих объявлений"
              >
                <input
                  type="checkbox"
                  checked={draft.textFiltersBotMessageEnabled}
                  onChange={(event) => {
                    const enabled = event.target.checked;
                    setFieldValue('textFiltersBotMessageEnabled', enabled);
                    if (!enabled) {
                      setFieldValue('textFiltersBotButtonEnabled', false);
                      clearButtonGroupErrors(TEXT_FILTERS_BOT_BUTTON_GROUP);
                    }
                  }}
                />
                <span className="toggle-switch" aria-hidden>
                  <span className="toggle-switch__thumb" />
                </span>
              </label>
            </div>

            {openHintKey === 'textFiltersBotMessage' ? (
              <p id="text-filters-bot-message-hint" className="settings-native-toggle__hint">
                При повторных нарушениях действие бота усиливается.
              </p>
            ) : null}

            {draft.textFiltersBotMessageEnabled && openBotEditorKey === 'textFilters' ? (
              <LazyBotMessageEditor
                editorKey="textFilters"
                {...botSpeechEditorProps!}
                botSpeechPreviewContext={botSpeechPreviewContext}
                value={draft.textFiltersBotMessageText}
                onChange={(nextValue) =>
                  setFieldValue(
                    'textFiltersBotMessageText',
                    nextValue as ChatSettings['textFiltersBotMessageText'],
                  )
                }
                onReset={() => setFieldValue('textFiltersBotMessageText', '')}
                onClose={() => setOpenBotEditorKey(null)}
              />
            ) : null}
          </div>

          <div className="settings-native-toggle settings-native-toggle--nested">
            <div className="settings-native-toggle__row">
              <div className="settings-native-toggle__title-wrap">
                <span className="settings-native-toggle__title">2. Предупреждение</span>
                <div className="settings-native-toggle__title-actions">
                  <EditToggleButton
                    label="Редактировать текст предупреждения об удалении рекламы"
                    onClick={() => toggleWarnMessageEditor('textFiltersWarn')}
                    isOpen={openWarnEditorKey === 'textFiltersWarn'}
                  />
                  <button
                    type="button"
                    className={cn(
                      'settings-info-button',
                      openHintKey === 'textFiltersWarnMessage' && 'is-open',
                    )}
                    aria-label="Пояснение для предупреждения о коммерческих объявлениях"
                    aria-controls="text-filters-warn-message-hint"
                    aria-expanded={openHintKey === 'textFiltersWarnMessage'}
                    data-hint-key="textFiltersWarnMessage"
                    onClick={() => toggleHint('textFiltersWarnMessage')}
                  >
                    <InfoCircle aria-hidden />
                  </button>
                </div>
              </div>

              <label
                className="settings-native-switch"
                aria-label="Включить предупреждение за второе нарушение коммерческого фильтра"
              >
                <input
                  type="checkbox"
                  checked={draft.textFiltersWarnEnabled}
                  onChange={(event) => {
                    const enabled = event.target.checked;
                    setFieldValue('textFiltersWarnEnabled', enabled);
                    if (enabled) {
                      setFieldValue('textFiltersBotMessageEnabled', true);
                    }
                  }}
                />
                <span className="toggle-switch" aria-hidden>
                  <span className="toggle-switch__thumb" />
                </span>
              </label>
            </div>

            {openHintKey === 'textFiltersWarnMessage' ? (
              <p id="text-filters-warn-message-hint" className="settings-native-toggle__hint">
                Текст отправляется при 2-м нарушении коммерческого фильтра за 24 часа.
              </p>
            ) : null}

            {openWarnEditorKey === 'textFiltersWarn' ? (
              <LazyWarnMessageEditor
                editorKey="textFiltersWarn"
                {...botSpeechEditorProps!}
                botSpeechPreviewContext={botSpeechPreviewContext}
                value={draft.textFiltersWarnMessageText}
                onChange={(nextValue) =>
                  setFieldValue(
                    'textFiltersWarnMessageText',
                    nextValue as ChatSettings['textFiltersWarnMessageText'],
                  )
                }
                onReset={() => setFieldValue('textFiltersWarnMessageText', '')}
                onClose={() => setOpenWarnEditorKey(null)}
              />
            ) : null}
          </div>

          {renderMuteStageToggle({
            enabledKey: 'textFiltersMuteEnabled',
            durationKey: 'textFiltersMuteDurationHours',
            title: draft.textFiltersMuteEnabled ? '3. Ограничение' : 'Ограничение',
            onEnable: () => {
              setFieldValue('textFiltersWarnEnabled', true);
              setFieldValue('textFiltersBotMessageEnabled', true);
            },
          })}

          <div className="settings-native-toggle settings-native-toggle--nested">
            <div className="settings-native-toggle__row">
              <span className="settings-native-toggle__title">
                {draft.textFiltersBanEnabled
                  ? `${draft.textFiltersMuteEnabled ? '4' : '3'}. Блокировка`
                  : 'Блокировка'}
              </span>

              <label
                className="settings-native-switch"
                aria-label="Включить блокировку за повторную рекламу"
              >
                <input
                  type="checkbox"
                  checked={draft.textFiltersBanEnabled}
                  onChange={(event) => {
                    const enabled = event.target.checked;
                    setFieldValue('textFiltersBanEnabled', enabled);
                    if (enabled) {
                      setFieldValue('textFiltersWarnEnabled', true);
                      setFieldValue('textFiltersBotMessageEnabled', true);
                    }
                  }}
                />
                <span className="toggle-switch" aria-hidden>
                  <span className="toggle-switch__thumb" />
                </span>
              </label>
            </div>
          </div>

          {draft.textFiltersBotMessageEnabled ? (
            <div
              className={cn(
                'settings-native-toggle',
                'settings-native-toggle--nested',
                hasTextFiltersBotButtonError && 'field--error',
              )}
            >
              <div className="settings-native-toggle__row">
                <div className="settings-native-toggle__title-wrap">
                  <span className="settings-native-toggle__title">Добавить кнопку</span>
                  <button
                    type="button"
                    className={cn(
                      'settings-info-button',
                      openHintKey === 'textFiltersBotButton' && 'is-open',
                    )}
                    aria-label="Пояснение для кнопки в сообщении о коммерции"
                    aria-controls="text-filters-bot-button-hint"
                    aria-expanded={openHintKey === 'textFiltersBotButton'}
                    data-hint-key="textFiltersBotButton"
                    onClick={() => toggleHint('textFiltersBotButton')}
                  >
                    <InfoCircle aria-hidden />
                  </button>
                </div>

                <label
                  className="settings-native-switch"
                  aria-label="Добавить кнопку в сообщение бота о коммерческих объявлениях"
                >
                  <input
                    type="checkbox"
                    checked={draft.textFiltersBotButtonEnabled}
                    onChange={(event) => {
                      const enabled = event.target.checked;
                      updateDraftButtonGroup(TEXT_FILTERS_BOT_BUTTON_GROUP, {
                        enabled,
                        ...(enabled && draft.textFiltersBotButtons.length === 0
                          ? { buttons: [createEmptyBroadcastLinkButton()] }
                          : {}),
                      });
                    }}
                  />
                  <span className="toggle-switch" aria-hidden>
                    <span className="toggle-switch__thumb" />
                  </span>
                </label>
              </div>

              {renderInlineHint(
                'textFiltersBotButton',
                'text-filters-bot-button-hint',
                'Добавляет кнопку в сообщение бота о коммерческом нарушении.',
                hasTextFiltersBotButtonError,
              )}

              {draft.textFiltersBotButtonEnabled ? (
                <BroadcastLinkButtonsEditor
                  api={api}
                  buttons={draft.textFiltersBotButtons}
                  errors={textFiltersBotButtonErrors}
                  onChange={(nextButtons) =>
                    updateDraftButtonGroup(TEXT_FILTERS_BOT_BUTTON_GROUP, {
                      buttons: nextButtons,
                      enabled: nextButtons.length > 0,
                    })
                  }
                  urlPlaceholder="https://max.ru/channel/rules"
                  textPlaceholder="Правила чата"
                  title="Кнопки сообщения"
                  subtitle="Название и ссылка"
                />
              ) : null}
            </div>
          ) : null}

          {renderAdminContactToggle(
            TEXT_FILTERS_ADMIN_CONTACT_BUTTON_GROUP,
            'Добавить связь с админом в сообщения о коммерческих объявлениях',
          )}
        </>
      ) : null}
    </div>
  );
}
