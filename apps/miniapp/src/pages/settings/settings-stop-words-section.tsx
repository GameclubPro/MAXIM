import type { ChatSettings } from '@maxim/contracts/settings';
import { Suspense, type Dispatch, type SetStateAction } from 'react';
import { GlassCard } from '../../components/ui/glass-card';
import { SegmentedControl, type SegmentedOption } from '../../components/ui/segmented-control';
import { SettingsDrilldownPanel } from '../../components/ui/settings-drilldown-panel';
import { SettingsSectionToggle } from '../../components/ui/settings-section-toggle';
import { cn } from '../../lib/cn';
import type { StopWordsMode } from '../settings-page.constants';
import {
  EditToggleButton,
  LazyBotMessageEditor,
  LazyMessageLimitsBlockedWordPresets,
  LazyWarnMessageEditor,
} from './settings-page-helpers';
import type {
  SettingsSectionEditorProps,
  SettingsSectionMutationProps,
  SettingsSectionShellProps,
} from './settings-section-shared';

type SettingsStopWordsSectionProps = SettingsSectionShellProps &
  SettingsSectionEditorProps &
  Pick<SettingsSectionMutationProps, 'draft' | 'setFieldValue' | 'clearFieldError'> & {
    addMessageLimitsBlockedDomains: () => void;
    addMessageLimitsBlockedWords: () => void;
    applyMessageLimitsBlockedWords: (nextWords: string[]) => void;
    hasMessageLimitsBlockedDomainsOverflow: boolean;
    hasMessageLimitsBlockedDomainsRemoveInputActions: boolean;
    hasMessageLimitsBlockedWordsOverflow: boolean;
    hasMessageLimitsBlockedWordsRemoveInputActions: boolean;
    isMessageLimitsBlockedDomainsApplyDisabled: boolean;
    isMessageLimitsBlockedWordsApplyDisabled: boolean;
    messageLimitsBlockedDomains: string[];
    messageLimitsBlockedDomainsCaption: string;
    messageLimitsBlockedDomainsError?: string;
    messageLimitsBlockedDomainsExpanded: boolean;
    messageLimitsBlockedDomainsInput: string;
    messageLimitsBlockedWords: string[];
    messageLimitsBlockedWordsCaption: string;
    messageLimitsBlockedWordsError?: string;
    messageLimitsBlockedWordsExpanded: boolean;
    messageLimitsBlockedWordsInput: string;
    messageLimitsBlockedWordsRemaining: number;
    removeMessageLimitsBlockedDomain: (domain: string) => void;
    removeMessageLimitsBlockedWord: (word: string) => void;
    setMessageLimitsBlockedDomainsExpanded: Dispatch<SetStateAction<boolean>>;
    setMessageLimitsBlockedDomainsInput: Dispatch<SetStateAction<string>>;
    setMessageLimitsBlockedWordsExpanded: Dispatch<SetStateAction<boolean>>;
    setMessageLimitsBlockedWordsInput: Dispatch<SetStateAction<string>>;
    setStopWordsMode: Dispatch<SetStateAction<StopWordsMode>>;
    stopWordsCardStatus: string;
    stopWordsError?: string;
    stopWordsHeaderSummary: string;
    stopWordsMode: StopWordsMode;
    stopWordsSegmentOptions: Array<SegmentedOption<StopWordsMode>>;
    visibleMessageLimitsBlockedDomains: string[];
    visibleMessageLimitsBlockedWords: string[];
  };

export function SettingsStopWordsSection(props: SettingsStopWordsSectionProps) {
  const {
    addMessageLimitsBlockedDomains,
    addMessageLimitsBlockedWords,
    applyMessageLimitsBlockedWords,
    botSpeechEditorProps,
    botSpeechPreviewContext,
    clearFieldError,
    discardSectionChanges,
    draft,
    expanded,
    hasMessageLimitsBlockedDomainsOverflow,
    hasMessageLimitsBlockedDomainsRemoveInputActions,
    hasMessageLimitsBlockedWordsOverflow,
    hasMessageLimitsBlockedWordsRemoveInputActions,
    isMessageLimitsBlockedDomainsApplyDisabled,
    isMessageLimitsBlockedWordsApplyDisabled,
    isSectionDirty,
    messageLimitsBlockedDomains,
    messageLimitsBlockedDomainsCaption,
    messageLimitsBlockedDomainsError,
    messageLimitsBlockedDomainsExpanded,
    messageLimitsBlockedDomainsInput,
    messageLimitsBlockedWords,
    messageLimitsBlockedWordsCaption,
    messageLimitsBlockedWordsError,
    messageLimitsBlockedWordsExpanded,
    messageLimitsBlockedWordsInput,
    messageLimitsBlockedWordsRemaining,
    openBotEditorKey,
    openWarnEditorKey,
    removeMessageLimitsBlockedDomain,
    removeMessageLimitsBlockedWord,
    renderApplyTargetHeaderAction,
    renderSectionSaveFooter,
    setFieldValue,
    setMessageLimitsBlockedDomainsExpanded,
    setMessageLimitsBlockedDomainsInput,
    setMessageLimitsBlockedWordsExpanded,
    setMessageLimitsBlockedWordsInput,
    setOpenBotEditorKey,
    setOpenWarnEditorKey,
    setStopWordsMode,
    stopWordsCardStatus,
    stopWordsError,
    stopWordsHeaderSummary,
    stopWordsMode,
    stopWordsSegmentOptions,
    toggleBotMessageEditor,
    toggleSection,
    toggleWarnMessageEditor,
    visibleMessageLimitsBlockedDomains,
    visibleMessageLimitsBlockedWords,
  } = props;

  return (
    <GlassCard
      className="settings-section settings-home-entry settings-home-entry--list stagger-in"
      style={{ animationDelay: '214ms', order: 13 }}
      aria-label="Стоп-слова"
    >
      <div className={cn('settings-section__head', 'settings-section__head--interactive')}>
        <SettingsSectionToggle
          title="Стоп-слова"
          summary={stopWordsHeaderSummary}
          status={stopWordsCardStatus}
          icon="keywords"
          tone="rose"
          open={expanded}
          controls="settings-stop-words-content"
          onClick={() => toggleSection('stopWords')}
        />
      </div>

      <SettingsDrilldownPanel
        id="settings-stop-words-content"
        open={expanded}
        title="Стоп-слова"
        summary={stopWordsHeaderSummary}
        tone="rose"
        className="settings-drilldown__panel--board settings-drilldown__panel--stop-words"
        onClose={() => toggleSection('stopWords')}
        headerAction={renderApplyTargetHeaderAction('stopWords')}
        confirmCloseWhen={isSectionDirty('stopWords')}
        onDiscardChanges={() => discardSectionChanges('stopWords')}
        footer={renderSectionSaveFooter('stopWords')}
      >
        <div
          id="settings-stop-words-content"
          className={cn('settings-section__collapse', expanded && 'is-open')}
        >
          {expanded ? (
            <div className="settings-section__collapse-inner">
              <div
                className={cn(
                  'settings-word-banlist',
                  stopWordsError && 'settings-word-banlist--error',
                )}
              >
                <SegmentedControl
                  value={stopWordsMode}
                  options={stopWordsSegmentOptions}
                  onChange={setStopWordsMode}
                  className="settings-word-banlist__segments"
                  ariaLabel="Список стоп-фильтра"
                />

                {stopWordsMode === 'words' ? (
                  <div
                    className="settings-word-banlist__mode-panel"
                    role="tabpanel"
                    aria-label="Стоп-слова"
                  >
                    <Suspense fallback={null}>
                      <LazyMessageLimitsBlockedWordPresets
                        selectedWords={draft.messageLimitsBlockedWords}
                        remainingSlots={messageLimitsBlockedWordsRemaining}
                        onApplyWords={applyMessageLimitsBlockedWords}
                      />
                    </Suspense>

                    <div className="settings-word-banlist__add-row">
                      <input
                        type="text"
                        value={messageLimitsBlockedWordsInput}
                        onChange={(event) => {
                          setMessageLimitsBlockedWordsInput(event.target.value);
                          clearFieldError('messageLimitsBlockedWords');
                        }}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' || event.key === ',') {
                            event.preventDefault();
                            addMessageLimitsBlockedWords();
                          }
                        }}
                        placeholder="Слова через запятую"
                        maxLength={240}
                        aria-label="Добавить стоп-слова"
                      />
                      {messageLimitsBlockedWordsInput.trim() ? (
                        <button
                          type="button"
                          className="button button--accent settings-word-banlist__add-button"
                          onClick={addMessageLimitsBlockedWords}
                          disabled={isMessageLimitsBlockedWordsApplyDisabled}
                        >
                          {hasMessageLimitsBlockedWordsRemoveInputActions
                            ? 'Применить'
                            : 'Добавить'}
                        </button>
                      ) : null}
                    </div>

                    {messageLimitsBlockedWords.length > 0 ? (
                      <>
                        {hasMessageLimitsBlockedWordsOverflow ? (
                          <div className="settings-word-banlist__chips-head">
                            <small className="settings-word-banlist__chips-caption">
                              {messageLimitsBlockedWordsCaption}
                            </small>
                            <button
                              type="button"
                              className="settings-word-banlist__toggle"
                              onClick={() =>
                                setMessageLimitsBlockedWordsExpanded((current) => !current)
                              }
                              aria-expanded={messageLimitsBlockedWordsExpanded}
                              aria-controls="settings-stop-words-list"
                            >
                              {messageLimitsBlockedWordsExpanded
                                ? 'Свернуть'
                                : `Показать все ${messageLimitsBlockedWords.length}`}
                            </button>
                          </div>
                        ) : null}

                        <div
                          className="settings-word-banlist__chips"
                          id="settings-stop-words-list"
                          aria-label="Стоп-слова"
                        >
                          {visibleMessageLimitsBlockedWords.map((word) => (
                            <button
                              key={word}
                              type="button"
                              className="settings-word-banlist__chip"
                              onClick={() => removeMessageLimitsBlockedWord(word)}
                              aria-label={`Удалить слово ${word}`}
                            >
                              <span>{word}</span>
                              <span aria-hidden>×</span>
                            </button>
                          ))}
                        </div>
                      </>
                    ) : null}

                    {messageLimitsBlockedWordsError ? (
                      <small className="field__hint">{messageLimitsBlockedWordsError}</small>
                    ) : null}
                  </div>
                ) : (
                  <div
                    className="settings-word-banlist__mode-panel"
                    role="tabpanel"
                    aria-label="Запрещенные домены"
                  >
                    <div className="settings-word-banlist__add-row">
                      <input
                        type="text"
                        value={messageLimitsBlockedDomainsInput}
                        onChange={(event) => {
                          setMessageLimitsBlockedDomainsInput(event.target.value);
                          clearFieldError('messageLimitsBlockedDomains');
                        }}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' || event.key === ',') {
                            event.preventDefault();
                            addMessageLimitsBlockedDomains();
                          }
                        }}
                        placeholder="site.com или ссылка целиком"
                        maxLength={320}
                        aria-label="Изменить запрещенные домены"
                      />
                      <button
                        type="button"
                        className="button button--accent settings-word-banlist__add-button"
                        onClick={addMessageLimitsBlockedDomains}
                        disabled={isMessageLimitsBlockedDomainsApplyDisabled}
                      >
                        {hasMessageLimitsBlockedDomainsRemoveInputActions
                          ? 'Применить'
                          : 'Добавить'}
                      </button>
                    </div>

                    {messageLimitsBlockedDomains.length > 0 ? (
                      <>
                        <div className="settings-word-banlist__chips-head">
                          <small className="settings-word-banlist__chips-caption">
                            {messageLimitsBlockedDomainsCaption}
                          </small>
                          {hasMessageLimitsBlockedDomainsOverflow ? (
                            <button
                              type="button"
                              className="settings-word-banlist__toggle"
                              onClick={() =>
                                setMessageLimitsBlockedDomainsExpanded((current) => !current)
                              }
                              aria-expanded={messageLimitsBlockedDomainsExpanded}
                              aria-controls="settings-stop-domains-list"
                            >
                              {messageLimitsBlockedDomainsExpanded
                                ? 'Свернуть'
                                : `Показать все ${messageLimitsBlockedDomains.length}`}
                            </button>
                          ) : null}
                        </div>

                        <div
                          className="settings-word-banlist__chips"
                          id="settings-stop-domains-list"
                          aria-label="Запрещенные домены"
                        >
                          {visibleMessageLimitsBlockedDomains.map((domain) => (
                            <button
                              key={domain}
                              type="button"
                              className="settings-word-banlist__chip settings-word-banlist__chip--domain"
                              onClick={() => removeMessageLimitsBlockedDomain(domain)}
                              aria-label={`Удалить домен ${domain}`}
                            >
                              <span>{domain}</span>
                              <span aria-hidden>×</span>
                            </button>
                          ))}
                        </div>
                      </>
                    ) : null}

                    {messageLimitsBlockedDomainsError ? (
                      <small className="field__hint">{messageLimitsBlockedDomainsError}</small>
                    ) : null}
                  </div>
                )}
              </div>

              <div
                className="settings-subsection-divider"
                role="separator"
                aria-label="Сообщения бота для стоп-слов"
              >
                <span>Сообщения бота</span>
              </div>

              <div className="settings-native-toggle">
                <div className="settings-native-toggle__row">
                  <div className="settings-native-toggle__title-wrap">
                    <span className="settings-native-toggle__title">1. Объяснение</span>
                    <div className="settings-native-toggle__title-actions">
                      <EditToggleButton
                        label="Редактировать текст объяснения о стоп-словах"
                        onClick={() => toggleBotMessageEditor('stopWords')}
                        isOpen={openBotEditorKey === 'stopWords'}
                      />
                    </div>
                  </div>
                </div>

                {openBotEditorKey === 'stopWords' ? (
                  <LazyBotMessageEditor
                    editorKey="stopWords"
                    {...botSpeechEditorProps!}
                    botSpeechPreviewContext={botSpeechPreviewContext}
                    value={draft.messageLimitsBotMessageText}
                    onChange={(nextValue) =>
                      setFieldValue(
                        'messageLimitsBotMessageText',
                        nextValue as ChatSettings['messageLimitsBotMessageText'],
                      )
                    }
                    onReset={() => setFieldValue('messageLimitsBotMessageText', '')}
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
                        label="Редактировать текст предупреждения о стоп-словах"
                        onClick={() => toggleWarnMessageEditor('stopWordsWarn')}
                        isOpen={openWarnEditorKey === 'stopWordsWarn'}
                      />
                    </div>
                  </div>
                </div>

                {openWarnEditorKey === 'stopWordsWarn' ? (
                  <LazyWarnMessageEditor
                    editorKey="stopWordsWarn"
                    {...botSpeechEditorProps!}
                    botSpeechPreviewContext={botSpeechPreviewContext}
                    value={draft.messageLimitsWarnMessageText}
                    onChange={(nextValue) =>
                      setFieldValue(
                        'messageLimitsWarnMessageText',
                        nextValue as ChatSettings['messageLimitsWarnMessageText'],
                      )
                    }
                    onReset={() => setFieldValue('messageLimitsWarnMessageText', '')}
                    onClose={() => setOpenWarnEditorKey(null)}
                  />
                ) : null}
              </div>
            </div>
          ) : null}
        </div>
      </SettingsDrilldownPanel>
    </GlassCard>
  );
}
