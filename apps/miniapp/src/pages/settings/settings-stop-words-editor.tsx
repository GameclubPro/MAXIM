import type { ChatSettings } from '@maxim/contracts/settings';
import { lazy, Suspense, useState } from 'react';
import { SegmentedControl } from '../../components/ui/segmented-control';
import { cn } from '../../lib/cn';
import { useHintPopoverAutoPosition } from '../../lib/hint-popover';
import { recoverableLazyNamedComponent } from '../../lib/recoverable-lazy';
import { EditToggleButton } from './settings-edit-toggle-button';
import { SettingsHintAnchor } from './settings-hint-anchor';
import type {
  BotMessageEditorProps,
  HintKey,
  WarnMessageEditorProps,
} from './settings-page-helpers';
import type { SettingsStopWordsSectionProps } from './settings-stop-words-section';

const LazyMessageLimitsBlockedWordPresets = lazy(
  () => import('../../components/message-limits-blocked-word-presets'),
);
const LazyBotMessageEditor = recoverableLazyNamedComponent<BotMessageEditorProps>(
  () => import('../../components/bot-speech-message-editor'),
  'BotMessageEditor',
);
const LazyWarnMessageEditor = recoverableLazyNamedComponent<WarnMessageEditorProps>(
  () => import('../../components/bot-speech-message-editor'),
  'WarnMessageEditor',
);

export function SettingsStopWordsEditor(props: SettingsStopWordsSectionProps) {
  const {
    addMessageLimitsBlockedDomains,
    addMessageLimitsBlockedWords,
    applyMessageLimitsBlockedWords,
    botSpeechEditorProps,
    botSpeechPreviewContext,
    clearFieldError,
    draft,
    hasMessageLimitsBlockedDomainsOverflow,
    hasMessageLimitsBlockedDomainsRemoveInputActions,
    hasMessageLimitsBlockedWordsOverflow,
    hasMessageLimitsBlockedWordsRemoveInputActions,
    isMessageLimitsBlockedDomainsApplyDisabled,
    isMessageLimitsBlockedWordsApplyDisabled,
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
    setFieldValue,
    setMessageLimitsBlockedDomainsExpanded,
    setMessageLimitsBlockedDomainsInput,
    setMessageLimitsBlockedWordsExpanded,
    setMessageLimitsBlockedWordsInput,
    setOpenBotEditorKey,
    setOpenWarnEditorKey,
    setStopWordsMode,
    stopWordsError,
    stopWordsMode,
    stopWordsSegmentOptions,
    toggleBotMessageEditor,
    toggleWarnMessageEditor,
    visibleMessageLimitsBlockedDomains,
    visibleMessageLimitsBlockedWords,
  } = props;
  const [openHintKey, setOpenHintKey] = useState<HintKey | null>(null);
  const toggleHint = (key: HintKey) => setOpenHintKey((current) => (current === key ? null : key));
  useHintPopoverAutoPosition(openHintKey !== null, openHintKey, () => setOpenHintKey(null));

  return (
    <div className="settings-section__collapse-inner">
      <div className="settings-native-toggle">
        <div className="settings-native-toggle__row">
          <div className="settings-native-toggle__title-wrap">
            <span className="settings-native-toggle__title">Проверять изображения</span>
            <SettingsHintAnchor
              hintKey="stopWordsImageText"
              openHintKey={openHintKey}
              onToggleHint={toggleHint}
              label="Как проверяется текст на изображениях"
            >
              Бот ищет запрещённые слова и адреса сайтов в тексте на фото. При уверенном совпадении
              фото удаляется. За текст на изображении бот не выдаёт предупреждение, не запрещает
              писать и не блокирует участника.
            </SettingsHintAnchor>
          </div>

          <label className="settings-native-switch" aria-label="Проверять изображения">
            <input
              type="checkbox"
              checked={draft.messageLimitsImageTextScanEnabled}
              onChange={(event) =>
                setFieldValue('messageLimitsImageTextScanEnabled', event.target.checked)
              }
            />
            <span className="toggle-switch" aria-hidden>
              <span className="toggle-switch__thumb" />
            </span>
          </label>
        </div>
      </div>

      <div
        className={cn('settings-word-banlist', stopWordsError && 'settings-word-banlist--error')}
      >
        <SegmentedControl
          value={stopWordsMode}
          options={stopWordsSegmentOptions}
          onChange={(mode) => {
            setOpenHintKey(null);
            setStopWordsMode(mode);
          }}
          className="settings-word-banlist__segments"
          ariaLabel="Запрещённые слова и сайты"
        />

        {stopWordsMode === 'words' ? (
          <div
            className="settings-word-banlist__mode-panel"
            role="tabpanel"
            aria-label="Стоп-слова"
          >
            <div className="settings-word-banlist__mode-head">
              <span className="settings-word-banlist__mode-title">Запрещённые слова</span>
              <SettingsHintAnchor
                hintKey="stopWordsText"
                openHintKey={openHintKey}
                onToggleHint={toggleHint}
                label="Как работает список запрещённых слов"
              >
                Сообщения со словами из этого списка удаляются. Предупреждение и другие действия
                берутся из раздела «Ограничения». Изменения списка начнут действовать после
                сохранения.
              </SettingsHintAnchor>
            </div>
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
                  if (
                    !event.nativeEvent.isComposing &&
                    (event.key === 'Enter' || event.key === ',')
                  ) {
                    event.preventDefault();
                    if (!isMessageLimitsBlockedWordsApplyDisabled) {
                      addMessageLimitsBlockedWords();
                    }
                  }
                }}
                placeholder="Слова через запятую"
                maxLength={240}
                aria-label="Добавить стоп-слова"
                aria-invalid={Boolean(messageLimitsBlockedWordsError)}
                aria-describedby={
                  messageLimitsBlockedWordsError ? 'settings-stop-words-error' : undefined
                }
                enterKeyHint="done"
              />
              {messageLimitsBlockedWordsInput.trim() ? (
                <button
                  type="button"
                  className="button button--accent settings-word-banlist__add-button"
                  onClick={addMessageLimitsBlockedWords}
                  disabled={isMessageLimitsBlockedWordsApplyDisabled}
                >
                  {hasMessageLimitsBlockedWordsRemoveInputActions ? 'Применить' : 'Добавить'}
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
                      onClick={() => setMessageLimitsBlockedWordsExpanded((current) => !current)}
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
              <small id="settings-stop-words-error" className="field__hint" role="alert">
                {messageLimitsBlockedWordsError}
              </small>
            ) : null}
          </div>
        ) : (
          <div
            className="settings-word-banlist__mode-panel"
            role="tabpanel"
            aria-label="Запрещённые сайты"
          >
            <div className="settings-word-banlist__mode-head">
              <span className="settings-word-banlist__mode-title">Запрещённые сайты</span>
              <SettingsHintAnchor
                hintKey="stopWordsDomains"
                openHintKey={openHintKey}
                onToggleHint={toggleHint}
                label="Как работает список запрещённых сайтов"
              >
                Укажите адрес сайта, например example.com. Бот будет удалять ссылки на этот сайт,
                включая его страницы и поддомены. Разрешённые исключения из раздела «Ссылки»
                сохраняются. Изменения начнут действовать после сохранения.
              </SettingsHintAnchor>
            </div>
            <div className="settings-word-banlist__add-row">
              <input
                type="text"
                inputMode="url"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                value={messageLimitsBlockedDomainsInput}
                onChange={(event) => {
                  setMessageLimitsBlockedDomainsInput(event.target.value);
                  clearFieldError('messageLimitsBlockedDomains');
                }}
                onKeyDown={(event) => {
                  if (
                    !event.nativeEvent.isComposing &&
                    (event.key === 'Enter' || event.key === ',')
                  ) {
                    event.preventDefault();
                    if (!isMessageLimitsBlockedDomainsApplyDisabled) {
                      addMessageLimitsBlockedDomains();
                    }
                  }
                }}
                placeholder="example.com или ссылка"
                maxLength={320}
                aria-label="Добавить запрещённый сайт"
                aria-invalid={Boolean(messageLimitsBlockedDomainsError)}
                aria-describedby={
                  messageLimitsBlockedDomainsError ? 'settings-stop-domains-error' : undefined
                }
                enterKeyHint="done"
              />
              <button
                type="button"
                className="button button--accent settings-word-banlist__add-button"
                onClick={addMessageLimitsBlockedDomains}
                disabled={isMessageLimitsBlockedDomainsApplyDisabled}
              >
                {hasMessageLimitsBlockedDomainsRemoveInputActions ? 'Применить' : 'Добавить'}
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
                      onClick={() => setMessageLimitsBlockedDomainsExpanded((current) => !current)}
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
                  aria-label="Запрещённые сайты"
                >
                  {visibleMessageLimitsBlockedDomains.map((domain) => (
                    <button
                      key={domain}
                      type="button"
                      className="settings-word-banlist__chip settings-word-banlist__chip--domain"
                      onClick={() => removeMessageLimitsBlockedDomain(domain)}
                      aria-label={`Убрать сайт ${domain} из запрещённых`}
                    >
                      <span>{domain}</span>
                      <span aria-hidden>×</span>
                    </button>
                  ))}
                </div>
              </>
            ) : null}

            {messageLimitsBlockedDomainsError ? (
              <small id="settings-stop-domains-error" className="field__hint" role="alert">
                {messageLimitsBlockedDomainsError}
              </small>
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
          <Suspense fallback={null}>
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
          </Suspense>
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
          <Suspense fallback={null}>
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
          </Suspense>
        ) : null}
      </div>
    </div>
  );
}
