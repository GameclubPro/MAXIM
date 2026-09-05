import type { ChatSettings, DuplicatePhotoEffectivePolicy } from '@maxim/contracts/settings';
import { lazy, Suspense } from 'react';
import { BroadcastLinkButtonsEditor } from '../../components/broadcast-link-buttons-editor';
import { GlassCard } from '../../components/ui/glass-card';
import { SegmentedControl } from '../../components/ui/segmented-control';
import { SettingsDrilldownPanel } from '../../components/ui/settings-drilldown-panel';
import { SettingsSectionToggle } from '../../components/ui/settings-section-toggle';
import type { ApiTransport } from '../../lib/api/transport';
import {
  createEmptyBroadcastLinkButton,
  type BroadcastLinkButtonFieldErrors,
} from '../../lib/broadcast-link-buttons';
import { cn } from '../../lib/cn';
import {
  DUPLICATE_DETECTION_OPTIONS,
  type DuplicateDetectionPreset,
} from '../settings-page.constants';
import { formatDuplicateActionSummary } from './settings-duplicate-photo-status';
import {
  ClockIcon,
  DUPLICATE_ADMIN_CONTACT_BUTTON_GROUP,
  DUPLICATE_ALLOWED_COUNT_MIN,
  DUPLICATE_BOT_BUTTON_GROUP,
  EditToggleButton,
  type FieldErrors,
  LazyBotMessageEditor,
  resolveDuplicateAllowedCountMax,
  SettingsHintAnchor,
} from './settings-page-helpers';
import type {
  SettingsMuteDurationProps,
  SettingsSectionEditorProps,
  SettingsSectionHintProps,
  SettingsSectionMutationProps,
  SettingsSectionShellProps,
} from './settings-section-shared';

type SettingsDuplicatesSectionProps = SettingsSectionShellProps &
  SettingsMuteDurationProps &
  Pick<
    SettingsSectionEditorProps,
    | 'botSpeechEditorProps'
    | 'botSpeechPreviewContext'
    | 'openBotEditorKey'
    | 'setOpenBotEditorKey'
    | 'toggleBotMessageEditor'
  > &
  Pick<SettingsSectionHintProps, 'openHintKey' | 'toggleHint'> &
  Pick<
    SettingsSectionMutationProps,
    | 'draft'
    | 'setFieldValue'
    | 'clearButtonGroupErrors'
    | 'updateDraftButtonGroup'
    | 'renderAdminContactToggle'
  > & {
    api: ApiTransport;
    adjustDuplicateAllowedCount: (currentValue: number, delta: number) => void;
    applyDuplicateDetectionPreset: (preset: DuplicateDetectionPreset) => void;
    applyDuplicateFlowConfig: (overrides: {
      allowedCount?: number;
      windowSec?: number;
      duplicateBotMessageEnabled?: boolean;
      duplicateWarnEnabled?: boolean;
      duplicateMuteEnabled?: boolean;
      duplicateBanEnabled?: boolean;
    }) => void;
    duplicateAllowedCount: number;
    duplicateBotButtonErrors: BroadcastLinkButtonFieldErrors[];
    duplicatePhotoModerationPolicy: DuplicatePhotoEffectivePolicy;
    duplicateSharedWindowHours: number;
    duplicateWindowInputValue: string;
    duplicatesCardStatus: string;
    duplicatesHeaderSummary: string;
    fieldErrors: FieldErrors;
    handleDuplicateWindowHoursBlur: () => void;
    handleDuplicateWindowHoursChange: (rawValue: string) => void;
    hasDuplicateBotButtonError: boolean;
  };

const LazySettingsDuplicatePhotoControls = lazy(
  () => import('./settings-duplicate-photo-controls'),
);

export function SettingsDuplicatesSection(props: SettingsDuplicatesSectionProps) {
  const {
    adjustDuplicateAllowedCount,
    api,
    applyDuplicateDetectionPreset,
    applyDuplicateFlowConfig,
    botSpeechEditorProps,
    botSpeechPreviewContext,
    clearButtonGroupErrors,
    discardSectionChanges,
    draft,
    duplicateAllowedCount,
    duplicateBotButtonErrors,
    duplicatePhotoModerationPolicy,
    duplicateSharedWindowHours,
    duplicateWindowInputValue,
    duplicatesCardStatus,
    duplicatesHeaderSummary,
    expanded,
    fieldErrors,
    formatMuteDurationCompact,
    handleDuplicateWindowHoursBlur,
    handleDuplicateWindowHoursChange,
    hasDuplicateBotButtonError,
    isSectionDirty,
    openBotEditorKey,
    openHintKey,
    openMuteDurationKey,
    renderAdminContactToggle,
    renderApplyTargetHeaderAction,
    renderMuteDurationEditor,
    renderSectionSaveFooter,
    setFieldValue,
    setOpenBotEditorKey,
    toggleBotMessageEditor,
    toggleHint,
    toggleMuteDurationEditor,
    toggleSection,
    updateDraftButtonGroup,
  } = props;
  const duplicateActionSummary = formatDuplicateActionSummary(
    draft,
    duplicateAllowedCount,
    duplicatePhotoModerationPolicy,
  );

  return (
    <GlassCard
      className="settings-section settings-home-entry settings-home-entry--list stagger-in"
      style={{ animationDelay: '180ms', order: 15 }}
      aria-label="Антидубль"
    >
      <div className={cn('settings-section__head', 'settings-section__head--interactive')}>
        <SettingsSectionToggle
          title="Антидубль"
          summary={duplicatesHeaderSummary}
          status={duplicatesCardStatus}
          icon="repeat"
          tone="rose"
          open={expanded}
          controls="settings-duplicates-content"
          onClick={() => toggleSection('duplicates')}
        />
      </div>

      <SettingsDrilldownPanel
        id="settings-duplicates-content"
        open={expanded}
        title="Антидубль"
        summary={duplicatesHeaderSummary}
        tone="rose"
        className="settings-drilldown__panel--ladder settings-drilldown__panel--duplicates"
        onClose={() => toggleSection('duplicates')}
        headerAction={renderApplyTargetHeaderAction('duplicates')}
        confirmCloseWhen={isSectionDirty('duplicates')}
        onDiscardChanges={() => discardSectionChanges('duplicates')}
        footer={renderSectionSaveFooter('duplicates')}
      >
        <div
          id="settings-duplicates-content"
          className={cn('settings-section__collapse', expanded && 'is-open')}
        >
          {expanded ? (
            <div className="settings-section__collapse-inner">
              <div className="settings-native-toggle">
                <div className="settings-native-toggle__row">
                  <div className="settings-native-toggle__title-wrap">
                    <span className="settings-native-toggle__title">Включить антидубль</span>
                    <SettingsHintAnchor
                      hintKey="antiDuplicate"
                      openHintKey={openHintKey}
                      onToggleHint={toggleHint}
                      label="Пояснение для антидубля"
                    >
                      Находит повторный текст и изображения. Действия зависят от выбранных правил и
                      доступного режима фото.
                    </SettingsHintAnchor>
                  </div>
                  <label className="settings-native-switch" aria-label="Включить антидубль">
                    <input
                      type="checkbox"
                      checked={draft.antiDuplicateEnabled}
                      onChange={(event) =>
                        setFieldValue('antiDuplicateEnabled', event.target.checked)
                      }
                    />
                    <span className="toggle-switch" aria-hidden>
                      <span className="toggle-switch__thumb" />
                    </span>
                  </label>
                </div>
              </div>

              {draft.antiDuplicateEnabled ? (
                <>
                  <h3 className="duplicate-settings-group__title">Что проверять</h3>

                  <div className="settings-policy">
                    <div className="settings-policy__label-row">
                      <span className="field__label">Текст</span>
                    </div>
                    <SegmentedControl
                      value={draft.duplicateDetectionPreset}
                      options={DUPLICATE_DETECTION_OPTIONS}
                      onChange={applyDuplicateDetectionPreset}
                      className="settings-mode-segments"
                      ariaLabel="Как сравнивать текст"
                    />
                  </div>
                </>
              ) : null}

              {draft.antiDuplicateEnabled && draft.duplicateDetectionPreset === 'CUSTOM' ? (
                <>
                  <div className="settings-native-toggle settings-native-toggle--nested">
                    <div className="settings-native-toggle__row">
                      <div className="settings-native-toggle__title-wrap">
                        <span className="settings-native-toggle__title">Одинаковая ссылка</span>
                        <SettingsHintAnchor
                          hintKey="duplicateIgnoreLinks"
                          openHintKey={openHintKey}
                          onToggleHint={toggleHint}
                          label="Пояснение для одинаковой ссылки в дублях"
                        >
                          Остальной текст может отличаться.
                        </SettingsHintAnchor>
                      </div>

                      <label
                        className="settings-native-switch"
                        aria-label="Считать одинаковую ссылку дублем"
                      >
                        <input
                          type="checkbox"
                          checked={draft.duplicateIgnoreLinksEnabled}
                          onChange={(event) =>
                            setFieldValue('duplicateIgnoreLinksEnabled', event.target.checked)
                          }
                        />
                        <span className="toggle-switch" aria-hidden>
                          <span className="toggle-switch__thumb" />
                        </span>
                      </label>
                    </div>
                  </div>

                  <div className="settings-native-toggle settings-native-toggle--nested">
                    <div className="settings-native-toggle__row">
                      <div className="settings-native-toggle__title-wrap">
                        <span className="settings-native-toggle__title">Одинаковый номер</span>
                        <SettingsHintAnchor
                          hintKey="duplicateIgnorePhones"
                          openHintKey={openHintKey}
                          onToggleHint={toggleHint}
                          label="Пояснение для одинакового номера в дублях"
                        >
                          Остальной текст может отличаться.
                        </SettingsHintAnchor>
                      </div>

                      <label
                        className="settings-native-switch"
                        aria-label="Считать одинаковый номер дублем"
                      >
                        <input
                          type="checkbox"
                          checked={draft.duplicateIgnorePhonesEnabled}
                          onChange={(event) =>
                            setFieldValue('duplicateIgnorePhonesEnabled', event.target.checked)
                          }
                        />
                        <span className="toggle-switch" aria-hidden>
                          <span className="toggle-switch__thumb" />
                        </span>
                      </label>
                    </div>
                  </div>

                  <div className="settings-native-toggle settings-native-toggle--nested">
                    <div className="settings-native-toggle__row">
                      <div className="settings-native-toggle__title-wrap">
                        <span className="settings-native-toggle__title">Близкие совпадения</span>
                        <SettingsHintAnchor
                          hintKey="duplicateNearMatch"
                          openHintKey={openHintKey}
                          onToggleHint={toggleHint}
                          label="Пояснение для близких совпадений дублей"
                        >
                          Только для длинных сообщений.
                        </SettingsHintAnchor>
                      </div>

                      <label
                        className="settings-native-switch"
                        aria-label="Включить близкие совпадения дублей"
                      >
                        <input
                          type="checkbox"
                          checked={draft.duplicateNearMatchEnabled}
                          onChange={(event) =>
                            setFieldValue('duplicateNearMatchEnabled', event.target.checked)
                          }
                        />
                        <span className="toggle-switch" aria-hidden>
                          <span className="toggle-switch__thumb" />
                        </span>
                      </label>
                    </div>
                  </div>
                </>
              ) : null}

              {draft.antiDuplicateEnabled ? (
                <Suspense fallback={null}>
                  <LazySettingsDuplicatePhotoControls
                    actionSettings={draft}
                    enabled={draft.duplicatePhotoEnabled}
                    matchPreset={draft.duplicatePhotoMatchPreset}
                    moderationPolicy={duplicatePhotoModerationPolicy}
                    scope={draft.duplicatePhotoScope}
                    onEnabledChange={(value) => setFieldValue('duplicatePhotoEnabled', value)}
                    onMatchPresetChange={(value) =>
                      setFieldValue('duplicatePhotoMatchPreset', value)
                    }
                    onScopeChange={(value) => setFieldValue('duplicatePhotoScope', value)}
                  />
                </Suspense>
              ) : null}

              {draft.antiDuplicateEnabled ? (
                <>
                  <h3 className="duplicate-settings-group__title">Когда срабатывать</h3>

                  <article
                    className={cn(
                      'duplicate-stage',
                      (fieldErrors.duplicateWarnWindowSec || fieldErrors.duplicateWarnMaxCount) &&
                        'field--error',
                    )}
                  >
                    <div className="duplicate-stage__top">
                      <div className="settings-native-toggle__title-wrap">
                        <span className="duplicate-stage__title">Условия удаления</span>
                        <SettingsHintAnchor
                          hintKey="duplicateModerationStart"
                          openHintKey={openHintKey}
                          onToggleHint={toggleHint}
                          label="Пояснение для условий удаления дублей"
                        >
                          За какой срок искать повторы и сколько дублей разрешить до удаления.
                        </SettingsHintAnchor>
                      </div>
                    </div>

                    <div className="duplicate-stage__controls">
                      <label
                        className={cn(
                          'duplicate-stage__field',
                          fieldErrors.duplicateWarnWindowSec && 'field--error',
                        )}
                      >
                        <span className="duplicate-stage__field-label">Период проверки</span>
                        <div className="duplicate-stage__input-wrap">
                          <input
                            type="number"
                            min={1}
                            max={168}
                            step={1}
                            value={duplicateWindowInputValue || String(duplicateSharedWindowHours)}
                            onChange={(event) =>
                              handleDuplicateWindowHoursChange(event.target.value)
                            }
                            onBlur={handleDuplicateWindowHoursBlur}
                            aria-label="Период проверки дублей, часы"
                            aria-invalid={Boolean(fieldErrors.duplicateWarnWindowSec) || undefined}
                            aria-describedby={
                              fieldErrors.duplicateWarnWindowSec
                                ? 'duplicate-window-hours-error'
                                : undefined
                            }
                          />
                          <span className="duplicate-stage__suffix" aria-hidden>
                            часы
                          </span>
                        </div>
                      </label>

                      <div
                        className={cn(
                          'duplicate-stage__field',
                          fieldErrors.duplicateWarnMaxCount && 'field--error',
                        )}
                      >
                        <span className="duplicate-stage__field-label">Разрешить дублей</span>
                        <div
                          className="duplicate-count-stepper"
                          role="group"
                          aria-label="Количество разрешённых дублей"
                          aria-invalid={Boolean(fieldErrors.duplicateWarnMaxCount) || undefined}
                          aria-describedby={
                            fieldErrors.duplicateWarnMaxCount
                              ? 'duplicate-allowed-count-error'
                              : undefined
                          }
                        >
                          <button
                            type="button"
                            className="duplicate-count-stepper__button"
                            onClick={() => adjustDuplicateAllowedCount(duplicateAllowedCount, -1)}
                            disabled={duplicateAllowedCount <= DUPLICATE_ALLOWED_COUNT_MIN}
                            aria-label="Разрешить меньше дублей"
                          >
                            -
                          </button>

                          <output className="duplicate-count-stepper__value" aria-live="polite">
                            {duplicateAllowedCount}
                          </output>

                          <button
                            type="button"
                            className="duplicate-count-stepper__button"
                            onClick={() => adjustDuplicateAllowedCount(duplicateAllowedCount, 1)}
                            disabled={
                              duplicateAllowedCount >= resolveDuplicateAllowedCountMax(draft)
                            }
                            aria-label="Разрешить больше дублей"
                          >
                            +
                          </button>
                        </div>
                      </div>
                    </div>

                    {fieldErrors.duplicateWarnWindowSec || fieldErrors.duplicateWarnMaxCount ? (
                      <div className="duplicate-stage__errors" aria-live="polite">
                        {fieldErrors.duplicateWarnWindowSec ? (
                          <small id="duplicate-window-hours-error" className="field__hint">
                            {fieldErrors.duplicateWarnWindowSec}
                          </small>
                        ) : null}
                        {fieldErrors.duplicateWarnMaxCount ? (
                          <small id="duplicate-allowed-count-error" className="field__hint">
                            {fieldErrors.duplicateWarnMaxCount}
                          </small>
                        ) : null}
                      </div>
                    ) : null}
                  </article>

                  <h3 className="duplicate-settings-group__title">Что делать</h3>
                </>
              ) : null}

              {draft.antiDuplicateEnabled ? (
                <div className="settings-native-toggle">
                  <div className="settings-native-toggle__row">
                    <div className="settings-native-toggle__title-wrap">
                      <span className="settings-native-toggle__title">Объяснить удаление</span>
                      <div className="settings-native-toggle__title-actions">
                        <EditToggleButton
                          label="Текст о дублях"
                          onClick={() => toggleBotMessageEditor('duplicate')}
                          disabled={!draft.duplicateBotMessageEnabled}
                          isOpen={openBotEditorKey === 'duplicate'}
                        />
                      </div>
                    </div>

                    <label className="settings-native-switch" aria-label="Сообщение о дублях">
                      <input
                        type="checkbox"
                        checked={draft.duplicateBotMessageEnabled}
                        onChange={(event) => {
                          const enabled = event.target.checked;
                          applyDuplicateFlowConfig({
                            duplicateBotMessageEnabled: enabled,
                          });
                          if (!enabled) {
                            setFieldValue('duplicateBotButtonEnabled', false);
                            clearButtonGroupErrors(DUPLICATE_BOT_BUTTON_GROUP);
                          }
                        }}
                      />
                      <span className="toggle-switch" aria-hidden>
                        <span className="toggle-switch__thumb" />
                      </span>
                    </label>
                  </div>

                  {draft.duplicateBotMessageEnabled && openBotEditorKey === 'duplicate' ? (
                    <LazyBotMessageEditor
                      editorKey="duplicate"
                      {...botSpeechEditorProps!}
                      botSpeechPreviewContext={botSpeechPreviewContext}
                      value={draft.duplicateBotMessageText}
                      onChange={(nextValue) =>
                        setFieldValue(
                          'duplicateBotMessageText',
                          nextValue as ChatSettings['duplicateBotMessageText'],
                        )
                      }
                      onReset={() => setFieldValue('duplicateBotMessageText', '')}
                      onClose={() => setOpenBotEditorKey(null)}
                    />
                  ) : null}
                </div>
              ) : null}

              {draft.antiDuplicateEnabled && draft.duplicateBotMessageEnabled ? (
                <>
                  <div
                    className={cn(
                      'settings-native-toggle',
                      'settings-native-toggle--nested',
                      hasDuplicateBotButtonError && 'field--error',
                    )}
                  >
                    <div className="settings-native-toggle__row">
                      <div className="settings-native-toggle__title-wrap">
                        <span className="settings-native-toggle__title">Добавить кнопку</span>
                      </div>

                      <label
                        className="settings-native-switch"
                        aria-label="Кнопка в сообщении о дублях"
                      >
                        <input
                          type="checkbox"
                          checked={draft.duplicateBotButtonEnabled}
                          onChange={(event) => {
                            const enabled = event.target.checked;
                            updateDraftButtonGroup(DUPLICATE_BOT_BUTTON_GROUP, {
                              enabled,
                              ...(enabled && draft.duplicateBotButtons.length === 0
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

                    {draft.duplicateBotButtonEnabled ? (
                      <BroadcastLinkButtonsEditor
                        api={api}
                        buttons={draft.duplicateBotButtons}
                        errors={duplicateBotButtonErrors}
                        onChange={(nextButtons) =>
                          updateDraftButtonGroup(DUPLICATE_BOT_BUTTON_GROUP, {
                            buttons: nextButtons,
                            enabled: nextButtons.length > 0,
                          })
                        }
                        urlPlaceholder="https://max.ru/profile/..."
                        textPlaceholder="Открыть"
                        title="Кнопки сообщения"
                        subtitle="Название и ссылка"
                      />
                    ) : null}
                  </div>

                  {renderAdminContactToggle(
                    DUPLICATE_ADMIN_CONTACT_BUTTON_GROUP,
                    'Добавить связь с админом в сообщения о дублях',
                  )}
                </>
              ) : null}

              {draft.antiDuplicateEnabled ? (
                <>
                  <div className="settings-native-toggle settings-native-toggle--nested">
                    <div className="settings-native-toggle__row">
                      <span className="settings-native-toggle__title">Предупредить</span>

                      <label
                        className="settings-native-switch"
                        aria-label="Включить предупреждение за повторы"
                      >
                        <input
                          type="checkbox"
                          checked={draft.duplicateWarnEnabled}
                          onChange={(event) =>
                            applyDuplicateFlowConfig({
                              duplicateWarnEnabled: event.target.checked,
                            })
                          }
                        />
                        <span className="toggle-switch" aria-hidden>
                          <span className="toggle-switch__thumb" />
                        </span>
                      </label>
                    </div>
                  </div>

                  <div
                    className={cn(
                      'settings-native-toggle',
                      'settings-native-toggle--nested',
                      fieldErrors.duplicateMuteDurationHours && 'field--error',
                    )}
                  >
                    <div className="settings-native-toggle__row">
                      <div className="settings-native-toggle__title-wrap">
                        <span className="settings-native-toggle__title">Ограничить отправку</span>
                        <div className="settings-native-toggle__title-actions">
                          <button
                            type="button"
                            className={cn(
                              'settings-duration-editor__preset settings-duration-editor__preset--trigger',
                              openMuteDurationKey === 'duplicateMuteDurationHours' && 'is-active',
                            )}
                            onClick={() => toggleMuteDurationEditor('duplicateMuteDurationHours')}
                            aria-label={`Срок: ${formatMuteDurationCompact(
                              Number(draft.duplicateMuteDurationHours),
                            )}`}
                            aria-expanded={openMuteDurationKey === 'duplicateMuteDurationHours'}
                          >
                            <ClockIcon />
                            <span>
                              {formatMuteDurationCompact(Number(draft.duplicateMuteDurationHours))}
                            </span>
                          </button>
                        </div>
                      </div>

                      <label
                        className="settings-native-switch"
                        aria-label="Включить ограничение сообщений за повторы"
                      >
                        <input
                          type="checkbox"
                          checked={draft.duplicateMuteEnabled}
                          onChange={(event) =>
                            applyDuplicateFlowConfig({
                              duplicateMuteEnabled: event.target.checked,
                            })
                          }
                        />
                        <span className="toggle-switch" aria-hidden>
                          <span className="toggle-switch__thumb" />
                        </span>
                      </label>
                    </div>

                    {renderMuteDurationEditor('duplicateMuteDurationHours', 'Срок ограничения')}

                    {fieldErrors.duplicateMuteDurationHours ? (
                      <small className="field__hint">
                        {fieldErrors.duplicateMuteDurationHours}
                      </small>
                    ) : null}
                  </div>

                  <div className="settings-native-toggle settings-native-toggle--nested">
                    <div className="settings-native-toggle__row">
                      <span className="settings-native-toggle__title">Заблокировать</span>

                      <label
                        className="settings-native-switch"
                        aria-label="Включить блокировку за повторы"
                      >
                        <input
                          type="checkbox"
                          checked={draft.duplicateBanEnabled}
                          onChange={(event) =>
                            applyDuplicateFlowConfig({
                              duplicateBanEnabled: event.target.checked,
                            })
                          }
                        />
                        <span className="toggle-switch" aria-hidden>
                          <span className="toggle-switch__thumb" />
                        </span>
                      </label>
                    </div>
                  </div>

                  <article className="duplicate-stage" aria-label="Итог действий антидубля">
                    <div className="duplicate-stage__top">
                      <span className="duplicate-stage__title">Итог</span>
                    </div>
                    <p className="settings-native-toggle__hint">{duplicateActionSummary}</p>
                  </article>
                </>
              ) : null}
            </div>
          ) : null}
        </div>
      </SettingsDrilldownPanel>
    </GlassCard>
  );
}
