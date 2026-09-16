import { Suspense, useMemo, useState, type ReactNode } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Check, EditPencil, Plus, Search, Trash, Play, Refresh } from 'iconoir-react';
import {
  LEGACY_STOP_WORD_PHRASES,
  normalizeStopWordsValue,
  stopWordsRuleSchema,
  stopWordsPolicySchema,
  type StopWordsPolicy,
  type StopWordsRule,
} from '@maxim/contracts/settings';
import { SegmentedControl } from '../../components/ui/segmented-control';
import { SettingsDrilldownPanel } from '../../components/ui/settings-drilldown-panel';
import { ActionConfirmSheet } from '../../components/ui/action-confirm-sheet';
import { getStopWordsStatus, previewStopWords } from '../../lib/api/stop-words-client';
import { prepareStopWordsInput, replaceStopWordsRule } from '../../lib/stop-words-editor';
import { MESSAGE_LIMITS_BLOCKED_WORD_PRESETS } from '../../lib/message-limits-blocked-word-presets';
import { describeUserFacingError } from '../../lib/user-facing-error';
import type { SettingsStopWordsEditorProps } from './settings-stop-words-section';
import type { BotMessageEditorProps, WarnMessageEditorProps } from './settings-page-helpers';
import { recoverableLazyNamedComponent } from '../../lib/recoverable-lazy';
import { Spinner } from '../../components/ui/spinner';
import './stop-words-policy-editor.css';

const BotMessageEditor = recoverableLazyNamedComponent<BotMessageEditorProps>(
  () => import('../../components/bot-speech-message-editor'),
  'BotMessageEditor',
);
const WarnMessageEditor = recoverableLazyNamedComponent<WarnMessageEditorProps>(
  () => import('../../components/bot-speech-message-editor'),
  'WarnMessageEditor',
);
const OMITTED_PRESET_VALUES = new Set([
  'рулетка',
  'отливка',
  'простыезадания',
  'продвижениетоваров',
]);
const PREVIEW_SANCTIONS = stopWordsPolicySchema.parse({}).sanctions;

function matchingPolicyKey(policy: StopWordsPolicy | undefined): string {
  return JSON.stringify({
    enabled: policy?.enabled,
    rules: policy?.rules,
    domains: policy?.domains,
  });
}

function Toggle({
  label,
  checked,
  onChange,
  children,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  children?: ReactNode;
}) {
  return (
    <div className="stop-words-editor__toggle">
      <span>{label}</span>
      {children}
      <label className="settings-native-switch" aria-label={label}>
        <input
          type="checkbox"
          checked={checked}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span className="toggle-switch" aria-hidden>
          <span className="toggle-switch__thumb" />
        </span>
      </label>
    </div>
  );
}

export function SettingsStopWordsEditor(props: SettingsStopWordsEditorProps) {
  const { api, chatId, draft, setFieldValue, mode, onModeChange: setMode } = props;
  const policy = draft.stopWordsPolicy;
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(100);
  const [selected, setSelected] = useState<string[]>([]);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmReload, setConfirmReload] = useState(false);
  const reload = useMutation({
    mutationFn: props.reloadPolicy,
    onSuccess: () => {
      setConfirmReload(false);
      setSelected([]);
    },
  });
  const [editingRule, setEditingRule] = useState<StopWordsRule | null>(null);
  const [editError, setEditError] = useState('');
  const [presetsOpen, setPresetsOpen] = useState(false);
  const [presetError, setPresetError] = useState('');
  const [speechEditor, setSpeechEditor] = useState<'explanation' | 'warning' | null>(null);
  const [testText, setTestText] = useState('');
  const status = useQuery({
    queryKey: ['stop-words-status', chatId],
    queryFn: ({ signal }) => getStopWordsStatus(api, chatId, signal),
    staleTime: 5_000,
    refetchInterval: 15_000,
    retry: false,
  });
  const tester = useMutation({
    mutationFn: (input: { policy: StopWordsPolicy; text: string }) =>
      previewStopWords(api, chatId, input.policy, input.text),
  });
  const wordsInput = props.messageLimitsBlockedWordsInput;
  const domainsInput = props.messageLimitsBlockedDomainsInput;
  const input = mode === 'words' ? wordsInput : domainsInput;
  const prepared = useMemo(
    () => (policy ? prepareStopWordsInput(policy, wordsInput, domainsInput) : null),
    [policy, wordsInput, domainsInput],
  );
  if (!policy) return <div role="alert">Не удалось загрузить стоп-слова. Обновите настройки.</div>;
  const update = (next: StopWordsPolicy) => setFieldValue('stopWordsPolicy', next);
  const sanctions = policy.sanctions;
  const updateSanctions = (patch: Partial<typeof sanctions>) =>
    update({ ...policy, sanctions: { ...sanctions, ...patch } });
  const filtered =
    mode === 'words'
      ? policy.rules
          .filter((rule) =>
            normalizeStopWordsValue(rule.value).includes(normalizeStopWordsValue(query)),
          )
          .map((rule) => ({ id: rule.id, value: rule.value, rule }))
          .reverse()
      : policy.domains
          .filter((domain) => domain.includes(query.trim().toLowerCase()))
          .map((domain) => ({ id: domain, value: domain, rule: null }))
          .reverse();
  const visible = filtered.slice(0, limit);
  const dirtyRule = editingRule
    ? JSON.stringify(editingRule) !==
      JSON.stringify(policy.rules.find((rule) => rule.id === editingRule.id))
    : false;
  const error =
    props.messageLimitsBlockedWordsError ||
    props.messageLimitsBlockedDomainsError ||
    props.stopWordsError;
  const availability = status.isError ? 'unavailable' : status.data?.imageScanStatus;
  const availabilityText =
    availability === 'ready'
      ? 'Доступна'
      : availability === 'shadow'
        ? 'Наблюдение, без удаления'
        : availability === 'off'
          ? 'Выключена на сервере'
          : availability === 'unavailable'
            ? 'Временно недоступна'
            : 'Проверяем доступность';
  const speechSettings = {
    botSpeechStyle: draft.botSpeechStyle,
    botSpeechMedia: {
      ...draft.botSpeechMedia,
      messageLimitsBotMessageText: sanctions.media.explanation,
      messageLimitsWarnMessageText: sanctions.media.warning,
    },
  };
  const previewPolicy = {
    ...(prepared?.policy ?? policy),
    imageScanEnabled: false,
    sanctions: PREVIEW_SANCTIONS,
  };
  const testCurrent =
    tester.variables?.text === testText &&
    matchingPolicyKey(tester.variables?.policy) === matchingPolicyKey(previewPolicy);

  function applyInput() {
    if (!prepared || prepared.errors.length || !input.trim()) return;
    update(prepared.policy);
    if (prepared.added.length) {
      setQuery('');
      setLimit(100);
    }
    props.setMessageLimitsBlockedWordsInput('');
    props.setMessageLimitsBlockedDomainsInput('');
    props.clearFieldError('messageLimitsBlockedWords');
    props.clearFieldError('messageLimitsBlockedDomains');
  }

  function saveRule() {
    if (!editingRule) return;
    const value = normalizeStopWordsValue(editingRule.value);
    const parsed = stopWordsRuleSchema.safeParse({
      ...editingRule,
      kind: value.includes(' ') ? 'PHRASE' : 'WORD',
    });
    if (!parsed.success) {
      setEditError(parsed.error.issues[0]?.message ?? 'Проверьте запись.');
      return;
    }
    try {
      update(replaceStopWordsRule(policy!, parsed.data));
      setEditingRule(null);
    } catch {
      setEditError('Такая запись уже есть в списке.');
    }
  }

  return (
    <fieldset className="stop-words-editor" disabled={props.busy || reload.isPending}>
      <Toggle
        label="Стоп-слова включены"
        checked={policy.enabled}
        onChange={(enabled) => update({ ...policy, enabled })}
      />
      <SegmentedControl
        value={mode}
        ariaLabel="Запрещённые слова и сайты"
        options={[
          { value: 'words', label: 'Слова и фразы', count: policy.rules.length },
          { value: 'domains', label: 'Сайты', count: policy.domains.length },
        ]}
        onChange={(value) => {
          setMode(value);
          setSelected([]);
          setQuery('');
          setLimit(100);
        }}
      />
      <div className="stop-words-editor__input">
        <textarea
          rows={2}
          value={input}
          maxLength={160_000}
          aria-label={mode === 'words' ? 'Добавить слова и фразы' : 'Добавить запрещённые сайты'}
          aria-invalid={Boolean(error || prepared?.errors.length)}
          aria-describedby="stop-words-input-result"
          placeholder={mode === 'words' ? 'Слово или фраза' : 'example.com'}
          inputMode={mode === 'domains' ? 'url' : 'text'}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          onChange={(event) => {
            (mode === 'words'
              ? props.setMessageLimitsBlockedWordsInput
              : props.setMessageLimitsBlockedDomainsInput)(event.target.value);
            props.clearFieldError('messageLimitsBlockedWords');
            props.clearFieldError('messageLimitsBlockedDomains');
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              applyInput();
            }
          }}
        />
        <button
          type="button"
          className="stop-words-editor__icon"
          title="Добавить записи"
          aria-label="Добавить записи"
          disabled={!input.trim() || Boolean(prepared?.errors.length)}
          onClick={applyInput}
        >
          <Plus />
        </button>
      </div>
      <div
        id="stop-words-input-result"
        className="stop-words-editor__input-result"
        aria-live="polite"
      >
        {error ? <p role="alert">{error}</p> : null}
        {prepared?.errors.map((message, index) => (
          <p role="alert" key={index}>
            {message}
          </p>
        ))}
        {input.trim() && prepared && !prepared.errors.length ? (
          <>
            <span>
              Добавится: {prepared.added.length}. Уже в списке: {prepared.duplicates.length}.
            </span>
            <div className="stop-words-editor__preview-values">
              {prepared.added.slice(0, 20).map((value) => (
                <span key={value}>{value}</span>
              ))}
            </div>
          </>
        ) : null}
      </div>
      <div className="stop-words-editor__toolbar">
        <label className="stop-words-editor__search">
          <Search aria-hidden />
          <input
            type="search"
            aria-label="Поиск по списку"
            placeholder="Поиск"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setLimit(100);
            }}
          />
        </label>
        {mode === 'words' ? (
          <button
            type="button"
            className="button button--ghost"
            onClick={() => setPresetsOpen(true)}
          >
            Наборы
          </button>
        ) : null}
        <button
          type="button"
          className="stop-words-editor__icon"
          title="Загрузить сохранённый список"
          aria-label="Загрузить сохранённый список"
          onClick={() => {
            if (props.isSectionDirty('stopWords')) setConfirmReload(true);
            else reload.mutate();
          }}
        >
          <Refresh />
        </button>
      </div>
      {(status.data?.revision ?? 0) > (draft.stopWordsRevision ?? 0) ? (
        <p role="status">Список изменён другим администратором.</p>
      ) : null}
      {reload.isError ? (
        <p role="alert">{describeUserFacingError(reload.error, 'Не удалось обновить список.')}</p>
      ) : null}
      <div className="stop-words-editor__selection">
        <label>
          <input
            type="checkbox"
            aria-label="Выбрать найденные записи"
            checked={filtered.length > 0 && filtered.every((item) => selected.includes(item.id))}
            onChange={(event) =>
              setSelected(event.target.checked ? filtered.map((item) => item.id) : [])
            }
          />
          {selected.length ? 'Выбрано: ' + selected.length : 'Всего: ' + filtered.length}
        </label>
        <button
          type="button"
          className="stop-words-editor__icon"
          title="Удалить выбранное"
          aria-label="Удалить выбранное"
          disabled={!selected.length}
          onClick={() => setConfirmDelete(true)}
        >
          <Trash />
        </button>
      </div>
      <div
        className="stop-words-editor__list"
        aria-label={mode === 'words' ? 'Список слов и фраз' : 'Список сайтов'}
      >
        {!filtered.length ? (
          <p className="stop-words-editor__empty">{query ? 'Совпадений нет' : 'Список пуст'}</p>
        ) : null}
        {visible.map(({ id, value, rule }) => (
          <div key={id} className="stop-words-editor__row">
            <label className="stop-words-editor__selection-box">
              <input
                type="checkbox"
                checked={selected.includes(id)}
                aria-label={'Выбрать ' + value}
                onChange={(event) =>
                  setSelected((current) =>
                    event.target.checked ? [...current, id] : current.filter((item) => item !== id),
                  )
                }
              />
            </label>
            <div className="stop-words-editor__value">
              <span>{value}</span>
              {rule ? (
                <small>
                  {rule.matchMode === 'MASKED' ? 'С маскировками' : 'Точное совпадение'}
                </small>
              ) : null}
            </div>
            {rule ? (
              <>
                <label className="settings-native-switch" aria-label={'Включить правило ' + value}>
                  <input
                    type="checkbox"
                    checked={rule.enabled}
                    onChange={(event) =>
                      update(
                        replaceStopWordsRule(policy, { ...rule, enabled: event.target.checked }),
                      )
                    }
                  />
                  <span className="toggle-switch" aria-hidden>
                    <span className="toggle-switch__thumb" />
                  </span>
                </label>
                <button
                  type="button"
                  className="stop-words-editor__icon"
                  title="Редактировать"
                  aria-label={'Редактировать ' + value}
                  onClick={() => {
                    setEditError('');
                    setEditingRule({ ...rule });
                  }}
                >
                  <EditPencil />
                </button>
              </>
            ) : (
              <button
                type="button"
                className="stop-words-editor__icon"
                title="Удалить сайт"
                aria-label={'Удалить ' + value}
                onClick={() => {
                  update({
                    ...policy,
                    domains: policy.domains.filter((domain) => domain !== value),
                  });
                  setSelected((current) => current.filter((id) => id !== value));
                }}
              >
                <Trash />
              </button>
            )}
          </div>
        ))}
        {filtered.length > limit ? (
          <button
            type="button"
            className="button button--ghost"
            onClick={() => setLimit((current) => current + 100)}
          >
            Показать ещё
          </button>
        ) : null}
      </div>
      <details className="stop-words-editor__section">
        <summary>Проверка сообщения</summary>
        <textarea
          rows={3}
          maxLength={4_000}
          value={testText}
          aria-label="Сообщение для проверки"
          onChange={(event) => setTestText(event.target.value)}
        />
        <button
          type="button"
          className="button button--accent"
          disabled={!testText.trim() || tester.isPending || Boolean(prepared?.errors.length)}
          onClick={() => tester.mutate({ policy: previewPolicy, text: testText })}
        >
          <Play aria-hidden />
          {tester.isPending ? 'Проверяем' : 'Проверить'}
        </button>
        {tester.isError ? (
          <p role="alert">
            {describeUserFacingError(tester.error, 'Не удалось проверить сообщение.')}
          </p>
        ) : null}
        {tester.data && testCurrent ? (
          <div role="status">
            {!tester.data.enabled
              ? 'Модуль выключен'
              : !tester.data.matches.length
                ? 'Совпадений нет'
                : tester.data.matches.map((match) => (
                    <p key={match.ruleId}>
                      <strong>{match.value}</strong>: <mark>{match.fragment}</mark> ·{' '}
                      {match.matchKind === 'masked'
                        ? 'маскировка'
                        : match.matchKind === 'domain'
                          ? 'запрещённый сайт'
                          : 'точное совпадение'}
                    </p>
                  ))}
          </div>
        ) : null}
      </details>
      <details className="stop-words-editor__section">
        <summary>
          Наказания и сообщения бота
          <small>
            {[
              sanctions.botMessageEnabled ? 'Объяснение' : '',
              sanctions.warnEnabled ? 'Предупреждение' : '',
              sanctions.muteEnabled ? 'Мут ' + sanctions.muteDurationHours + ' ч' : '',
              sanctions.banEnabled ? 'Бан' : '',
            ]
              .filter(Boolean)
              .join(' · ') || 'Только удаление'}
          </small>
        </summary>
        <Toggle
          label="Объяснение"
          checked={sanctions.botMessageEnabled}
          onChange={(botMessageEnabled) => updateSanctions({ botMessageEnabled })}
        >
          <button
            type="button"
            className="stop-words-editor__icon"
            title="Изменить объяснение"
            aria-label="Изменить объяснение"
            onClick={() => setSpeechEditor('explanation')}
          >
            <EditPencil />
          </button>
        </Toggle>
        <Toggle
          label="Предупреждение"
          checked={sanctions.warnEnabled}
          onChange={(warnEnabled) => updateSanctions({ warnEnabled })}
        >
          <button
            type="button"
            className="stop-words-editor__icon"
            title="Изменить предупреждение"
            aria-label="Изменить предупреждение"
            onClick={() => setSpeechEditor('warning')}
          >
            <EditPencil />
          </button>
        </Toggle>
        <Toggle
          label="Мут"
          checked={sanctions.muteEnabled}
          onChange={(muteEnabled) => updateSanctions({ muteEnabled })}
        />
        {sanctions.muteEnabled ? (
          <label className="stop-words-editor__field">
            Длительность мута, часов
            <input
              type="number"
              min={1}
              max={168}
              value={sanctions.muteDurationHours}
              onChange={(event) =>
                updateSanctions({ muteDurationHours: Number(event.target.value) })
              }
            />
          </label>
        ) : null}
        <Toggle
          label="Бан"
          checked={sanctions.banEnabled}
          onChange={(banEnabled) => updateSanctions({ banEnabled })}
        />
        <Toggle
          label="Кнопка правил"
          checked={sanctions.rulesButtonEnabled}
          onChange={(rulesButtonEnabled) => updateSanctions({ rulesButtonEnabled })}
        />
        <Toggle
          label="Связаться с администратором"
          checked={sanctions.adminContactButtonEnabled}
          onChange={(adminContactButtonEnabled) => updateSanctions({ adminContactButtonEnabled })}
        />
        {sanctions.adminContactButtonEnabled ? (
          <input
            type="url"
            value={sanctions.adminContactButtonUrl}
            aria-label="Ссылка администратора"
            onChange={(event) => updateSanctions({ adminContactButtonUrl: event.target.value })}
          />
        ) : null}
        <Toggle
          label="Кнопки сообщения"
          checked={sanctions.botButtonEnabled}
          onChange={(botButtonEnabled) => updateSanctions({ botButtonEnabled })}
        />
        {sanctions.botButtonEnabled ? (
          <div className="stop-words-editor__buttons">
            {sanctions.botButtons.map((button, index) => (
              <div key={index}>
                <input
                  aria-label={'Название кнопки ' + (index + 1)}
                  value={button.text}
                  maxLength={32}
                  onChange={(event) =>
                    updateSanctions({
                      botButtons: sanctions.botButtons.map((item, i) =>
                        i === index ? { ...item, text: event.target.value } : item,
                      ),
                    })
                  }
                />
                <input
                  type="url"
                  aria-label={'Ссылка кнопки ' + (index + 1)}
                  value={button.url}
                  onChange={(event) =>
                    updateSanctions({
                      botButtons: sanctions.botButtons.map((item, i) =>
                        i === index ? { ...item, url: event.target.value } : item,
                      ),
                    })
                  }
                />
                <button
                  type="button"
                  className="stop-words-editor__icon"
                  title="Удалить кнопку"
                  aria-label={'Удалить кнопку ' + (index + 1)}
                  onClick={() =>
                    updateSanctions({
                      botButtons: sanctions.botButtons.filter((_, i) => i !== index),
                    })
                  }
                >
                  <Trash />
                </button>
              </div>
            ))}
            <button
              type="button"
              className="button button--ghost"
              disabled={sanctions.botButtons.length >= 8}
              onClick={() =>
                updateSanctions({ botButtons: [...sanctions.botButtons, { text: '', url: '' }] })
              }
            >
              <Plus aria-hidden />
              Добавить кнопку
            </button>
          </div>
        ) : null}
      </details>
      <details className="stop-words-editor__section">
        <summary>
          Текст на изображениях<small>Только удаление</small>
        </summary>
        <Toggle
          label="Проверять изображения"
          checked={policy.imageScanEnabled}
          onChange={(imageScanEnabled) => update({ ...policy, imageScanEnabled })}
        />
        <p role="status">{availabilityText}</p>
      </details>
      <ActionConfirmSheet
        id="stop-words-delete"
        open={confirmDelete}
        title="Удалить выбранные записи?"
        summary={'Записей: ' + selected.length}
        confirmLabel="Удалить"
        onClose={() => setConfirmDelete(false)}
        onConfirm={() => {
          update(
            mode === 'words'
              ? { ...policy, rules: policy.rules.filter((rule) => !selected.includes(rule.id)) }
              : {
                  ...policy,
                  domains: policy.domains.filter((domain) => !selected.includes(domain)),
                },
          );
          setSelected([]);
          setConfirmDelete(false);
        }}
      />
      <ActionConfirmSheet
        id="stop-words-reload"
        open={confirmReload}
        title="Загрузить сохранённый список?"
        summary="Несохранённые изменения будут отменены."
        confirmLabel="Загрузить"
        isBusy={reload.isPending}
        onClose={() => setConfirmReload(false)}
        onConfirm={() => reload.mutate()}
      />
      <SettingsDrilldownPanel
        id="stop-words-rule-editor"
        open={Boolean(editingRule)}
        title="Правило"
        confirmCloseWhen={dirtyRule}
        onClose={() => setEditingRule(null)}
        onDiscardChanges={() => setEditingRule(null)}
        footer={
          <button type="button" className="button button--accent" onClick={saveRule}>
            <Check aria-hidden />
            Применить
          </button>
        }
      >
        {editingRule ? (
          <div className="stop-words-editor">
            <input
              autoFocus
              aria-label="Слово или фраза"
              value={editingRule.value}
              maxLength={160}
              onChange={(event) => setEditingRule({ ...editingRule, value: event.target.value })}
            />
            <Toggle
              label="Правило включено"
              checked={editingRule.enabled}
              onChange={(enabled) => setEditingRule({ ...editingRule, enabled })}
            />
            <Toggle
              label="Распознавать маскировки"
              checked={editingRule.matchMode === 'MASKED'}
              onChange={(masked) =>
                setEditingRule({ ...editingRule, matchMode: masked ? 'MASKED' : 'EXACT' })
              }
            />
            {editError ? <p role="alert">{editError}</p> : null}
          </div>
        ) : null}
      </SettingsDrilldownPanel>
      <SettingsDrilldownPanel
        id="stop-words-presets"
        open={presetsOpen}
        title="Наборы"
        onClose={() => setPresetsOpen(false)}
      >
        <div className="stop-words-editor">
          {MESSAGE_LIMITS_BLOCKED_WORD_PRESETS.map((preset) => {
            const values = preset.words
              .filter((word) => !OMITTED_PRESET_VALUES.has(word))
              .map((word) => LEGACY_STOP_WORD_PHRASES[word] ?? word);
            return (
              <details key={preset.id} className="stop-words-editor__section">
                <summary>{preset.title}</summary>
                <div className="stop-words-editor__preview-values">
                  {values.map((value) => (
                    <span key={value}>{value}</span>
                  ))}
                </div>
                <button
                  type="button"
                  className="button button--accent"
                  onClick={() => {
                    const result = prepareStopWordsInput(policy, values.join('\n'));
                    if (result.errors.length) {
                      setPresetError(result.errors.join(' '));
                      return;
                    }
                    update(result.policy);
                    setPresetError('');
                    setPresetsOpen(false);
                  }}
                >
                  <Plus aria-hidden />
                  Добавить набор
                </button>
              </details>
            );
          })}
          {presetError ? <p role="alert">{presetError}</p> : null}
        </div>
      </SettingsDrilldownPanel>
      <Suspense fallback={<Spinner label="Загружаем редактор сообщения" />}>
        {speechEditor === 'explanation' ? (
          <BotMessageEditor
            editorKey="stopWords"
            settings={speechSettings}
            botSpeechPreviewContext={props.botSpeechPreviewContext}
            value={sanctions.botMessageText}
            onChange={(botMessageText) => updateSanctions({ botMessageText })}
            onReset={() => updateSanctions({ botMessageText: '' })}
            onClose={() => setSpeechEditor(null)}
            onImageChange={(_, image) =>
              updateSanctions({ media: { ...sanctions.media, explanation: image ?? undefined } })
            }
          />
        ) : null}
        {speechEditor === 'warning' ? (
          <WarnMessageEditor
            editorKey="stopWordsWarn"
            settings={speechSettings}
            botSpeechPreviewContext={props.botSpeechPreviewContext}
            value={sanctions.warnMessageText}
            onChange={(warnMessageText) => updateSanctions({ warnMessageText })}
            onReset={() => updateSanctions({ warnMessageText: '' })}
            onClose={() => setSpeechEditor(null)}
            onImageChange={(_, image) =>
              updateSanctions({ media: { ...sanctions.media, warning: image ?? undefined } })
            }
          />
        ) : null}
      </Suspense>
    </fieldset>
  );
}
