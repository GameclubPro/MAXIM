import {
  Suspense,
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
  type RefAttributes,
} from 'react';
import type { BroadcastLinkButton } from '@maxim/contracts/broadcast';
import {
  DELETE_BOT_MESSAGES_DELAY_ALLOWED_MINUTES,
  inferCommercialSliderPosition,
  normalizeStopWordsValue,
  resolveDuplicateFlowAllowedCount,
  resolveDuplicateFlowAllowedCountMax,
  stopWordsRuleSchema,
} from '@maxim/contracts/settings';
import type { StopWordsRule } from '@maxim/contracts/settings';
import type { NetworkSettingsChange } from '@maxim/contracts/network-settings';
import { BroadcastLinkButtonsEditor } from '../../components/broadcast-link-buttons-editor';
import type {
  MaxRichTextEditorHandle,
  MaxRichTextEditorProps,
} from '../../components/max-rich-text-editor';
import { MAX_MARKDOWN_TOOL_DEFINITIONS } from '../../lib/max-markdown-tools';
import { recoverableLazyNamedComponent } from '../../lib/recoverable-lazy';
import { Spinner } from '../../components/ui/spinner';
import type { SharedStopWordsPresetButtonsProps } from './shared-stop-words-preset-buttons';
import {
  FieldList,
  FieldMedia,
  FieldNumber,
  FieldSelect,
  FieldText,
  FieldTime,
  FieldToggle,
} from '../../features/network-settings/settings-field-controls';
import type {
  ChatMediaFieldPath,
  ChatSettingsFieldAdapter,
  ChatSettingsFieldValues,
} from '../../features/network-settings/field-model';
import {
  readCommonDuplicateFlow,
  setChatBoolean,
  setChatCommercialSensitivity,
  setChatDuplicateAllowedCount,
  setChatDuplicatePreset,
  setChatDuplicateWindowHours,
  setChatLinkPolicy,
  type ChatBooleanField,
  type ChatNumberField,
  type ChatStringField,
} from '../../features/network-settings/chat-field-intents';
import { prepareStopWordsLists } from '../../lib/stop-words-editor';
import { parseSettingsField } from '../../features/network-settings/field-registry';
import { RUSSIAN_TIMEZONE_OPTIONS } from './settings-timezones';
import type { SharedChatSettingsSectionProps } from './shared-chat-settings-section';
import './shared-chat-settings.css';
import {
  PROFANITY_SENSITIVITY_OPTIONS,
  PROFANITY_SENSITIVITY_HINTS,
} from '../settings-page.constants';

const LazyMaxRichTextEditor = recoverableLazyNamedComponent<
  MaxRichTextEditorProps & RefAttributes<MaxRichTextEditorHandle>
>(() => import('../../components/max-rich-text-editor'), 'MaxRichTextEditor');

const SharedStopWordsPresetButtons =
  recoverableLazyNamedComponent<SharedStopWordsPresetButtonsProps>(
    () => import('./shared-stop-words-preset-buttons'),
    'SharedStopWordsPresetButtons',
  );

const LazyActionConfirmSheet = recoverableLazyNamedComponent<
  ComponentProps<typeof import('../../components/ui/action-confirm-sheet').ActionConfirmSheet>
>(() => import('../../components/ui/action-confirm-sheet'), 'ActionConfirmSheet');

type BodyProps = Pick<SharedChatSettingsSectionProps, 'fields' | 'context'>;
type SpeechPath = Extract<ChatStringField, `${string}MessageText`>;
type ButtonPath = {
  [K in keyof ChatSettingsFieldValues]: ChatSettingsFieldValues[K] extends BroadcastLinkButton[]
    ? K
    : never;
}[keyof ChatSettingsFieldValues] &
  string;
const yesOrMixed = (fields: ChatSettingsFieldAdapter, path: ChatBooleanField) => {
  const state = fields.read(path);
  return state.kind !== 'common' || state.value;
};

function Group({ title, children, hint }: { title: string; children: ReactNode; hint?: string }) {
  return (
    <section className="settings-native-toggle shared-chat-settings-group">
      <h3 className="settings-subsection-title">{title}</h3>
      {hint ? <p className="field__hint">{hint}</p> : null}
      {children}
    </section>
  );
}

function controls(fields: ChatSettingsFieldAdapter) {
  const common = (path: keyof ChatSettingsFieldValues & string) => ({
    disabled: fields.readOnly,
    error: fields.error(path),
    onError: (error: string | null) => fields.setError(path, error),
  });
  return {
    toggle: (path: ChatBooleanField, label: string, description?: ReactNode, disabled = false) => (
      <FieldToggle
        key={path}
        {...common(path)}
        disabled={fields.readOnly || disabled}
        state={fields.read(path)}
        label={label}
        description={description}
        onChange={(value) => setChatBoolean(fields, path, value)}
      />
    ),
    number: (path: ChatNumberField, label: string, min: number, max: number, step = 1) => (
      <FieldNumber
        key={path}
        {...common(path)}
        state={fields.read(path)}
        label={label}
        min={min}
        max={max}
        step={step}
        onChange={(value) => fields.setScalar(path, value)}
      />
    ),
    text: (path: ChatStringField, label: string, maxLength = 1000, multiline = false) => (
      <FieldText
        key={path}
        {...common(path)}
        state={fields.read(path)}
        label={label}
        maxLength={maxLength}
        multiline={multiline}
        onChange={(value) => fields.setScalar(path, value as ChatSettingsFieldValues[typeof path])}
      />
    ),
    select: <K extends ChatStringField>(
      path: K,
      label: string,
      options: readonly { value: ChatSettingsFieldValues[K] & string; label: string }[],
      onChange?: (value: ChatSettingsFieldValues[K]) => void,
    ) => (
      <FieldSelect
        key={path}
        {...common(path)}
        state={fields.read(path)}
        label={label}
        options={options}
        onChange={(value) => (onChange ? onChange(value) : fields.setScalar(path, value))}
      />
    ),
    time: (path: ChatNumberField, label: string) => (
      <FieldTime
        key={path}
        {...common(path)}
        state={fields.read(path)}
        label={label}
        onChange={(value) => fields.setScalar(path, value)}
      />
    ),
  };
}

// FLAG: Text and image remain independent intents, including when the target values differ.
function Speech({
  fields,
  path,
  mediaPath,
  label,
}: {
  fields: ChatSettingsFieldAdapter;
  path:
    | SpeechPath
    | 'stopWordsPolicy.sanctions.botMessageText'
    | 'stopWordsPolicy.sanctions.warnMessageText';
  mediaPath?: ChatMediaFieldPath;
  label: string;
}) {
  const [open, setOpen] = useState(false);
  const editor = useRef<MaxRichTextEditorHandle>(null);
  const state = fields.read(path);
  const media = mediaPath ? fields.read(mediaPath) : { kind: 'loading' as const };
  return (
    <div className="settings-native-toggle shared-chat-settings-speech">
      <div className="settings-native-toggle__row">
        <strong>{label}</strong>
        <button
          type="button"
          className="settings-info-button"
          aria-expanded={open}
          disabled={fields.readOnly}
          onClick={() => setOpen(!open)}
        >
          {open ? 'Готово' : 'Редактировать'}
        </button>
      </div>
      <p className="field__hint">
        {state.kind === 'mixed'
          ? 'В сообществах сохранены разные тексты. Введите общий текст или выберите стандартный.'
          : state.kind === 'common' && state.value
            ? 'Сохранён собственный текст.'
            : 'Используется стандартный текст в стиле бота.'}
      </p>
      {open ? (
        <Suspense fallback={<Spinner label="Загружаем редактор" />}>
          <div role="toolbar" aria-label="Форматирование сообщения">
            {MAX_MARKDOWN_TOOL_DEFINITIONS.map((tool) => (
              <button
                type="button"
                key={tool.id}
                disabled={fields.readOnly}
                onClick={() => editor.current?.applyTool(tool.id)}
                aria-label={tool.title}
              >
                {tool.label}
              </button>
            ))}
          </div>
          <LazyMaxRichTextEditor
            ref={editor}
            value={state.kind === 'common' ? state.value : ''}
            onChange={(value) => fields.setScalar(path, value)}
            maxLength={1000}
            placeholder={state.kind === 'mixed' ? 'Введите общий текст' : 'Стандартный текст'}
            ariaLabel={label}
            disabled={fields.readOnly || state.kind === 'loading'}
            preserveCurlyBracePlaceholders
          />
          <button
            type="button"
            disabled={fields.readOnly}
            onClick={() => fields.setScalar(path, '')}
          >
            Стандартный текст
          </button>
          {fields.isDirty(path) ? (
            <button type="button" disabled={fields.readOnly} onClick={() => fields.revert(path)}>
              Отменить изменение текста
            </button>
          ) : null}
          {fields.error(path) ? <p role="alert">{fields.error(path)}</p> : null}
          {mediaPath ? (
            <FieldMedia
              label="Изображение сообщения"
              state={
                media.kind === 'common' ? { kind: 'common', value: media.value ?? null } : media
              }
              disabled={fields.readOnly}
              error={fields.error(mediaPath)}
              onError={(error) => fields.setError(mediaPath, error)}
              onChange={(value) => fields.setScalar(mediaPath, value)}
              onClear={() => fields.clearMedia(mediaPath)}
              onRevert={fields.isDirty(mediaPath) ? () => fields.revert(mediaPath) : undefined}
            />
          ) : null}
        </Suspense>
      ) : null}
    </div>
  );
}

function Buttons({
  fields,
  context,
  path,
  enabledPath,
}: BodyProps & { path: ButtonPath; enabledPath: ChatBooleanField }) {
  const c = controls(fields);
  return (
    <>
      {c.toggle(
        enabledPath,
        'Добавить кнопку',
        'Кнопки ведут на чат, канал или профиль. Сохранённый список сохраняется при выключении.',
      )}
      {yesOrMixed(fields, enabledPath) || fields.error(path) ? (
        <FieldList<BroadcastLinkButton>
          label="Кнопки сообщения"
          state={fields.read(path)}
          disabled={fields.readOnly}
          error={fields.error(path)}
          onChange={(value) => fields.replaceList(path, value)}
        >
          {(items, replace) => (
            <ButtonListDraft fields={fields} context={context} items={items} replace={replace} />
          )}
        </FieldList>
      ) : null}
    </>
  );
}

function ButtonListDraft({
  fields,
  context,
  items,
  replace,
}: BodyProps & { items: BroadcastLinkButton[]; replace: (items: BroadcastLinkButton[]) => void }) {
  const [buffer, setBuffer] = useState<BroadcastLinkButton[] | null>(null);
  const incoming = JSON.stringify(items);
  useEffect(() => setBuffer(null), [incoming]);
  return (
    <BroadcastLinkButtonsEditor
      api={context.api}
      buttons={buffer ?? items}
      disabled={fields.readOnly}
      onChange={(next) => {
        setBuffer(next);
        replace(next);
      }}
      title="Кнопки сообщения"
      subtitle="Название и ссылка"
    />
  );
}

type SanctionPrefix =
  | 'link'
  | 'profanity'
  | 'textFilters'
  | 'duplicate'
  | 'messageLimits'
  | 'phoneNumbers'
  | 'requiredSubscription'
  | 'invitationAccess';
function Sanctions({
  fields,
  context,
  prefix,
  warningText = false,
  buttons = false,
  thresholds = false,
  mandatoryMessage = false,
}: BodyProps & {
  prefix: SanctionPrefix;
  warningText?: boolean;
  buttons?: boolean;
  thresholds?: boolean;
  mandatoryMessage?: boolean;
}) {
  const c = controls(fields);
  const boolean = (suffix: string) => (prefix + suffix) as ChatBooleanField;
  const number = (suffix: string) => (prefix + suffix) as ChatNumberField;
  const speech = (suffix: string) => (prefix + suffix) as SpeechPath;
  const message = speech('BotMessageText');
  const adminEnabled = boolean('AdminContactButtonEnabled');
  const adminUrl = (prefix + 'AdminContactButtonUrl') as ChatStringField;
  return (
    <Group
      title="Действия бота"
      hint="Последовательные нарушения учитываются в пределах выбранного периода."
    >
      {mandatoryMessage ? (
        <p className="field__hint">
          Пояснение о подписке включается автоматически, когда задан список обязательных каналов.
        </p>
      ) : (
        c.toggle(boolean('BotMessageEnabled'), '1. Сообщение от бота')
      )}
      <Speech
        fields={fields}
        path={message}
        mediaPath={('botSpeechMedia.' + message) as ChatMediaFieldPath}
        label="Текст сообщения от бота"
      />
      {c.toggle(boolean('WarnEnabled'), '2. Предупреждение')}
      {warningText ? (
        <Speech
          fields={fields}
          path={speech('WarnMessageText')}
          mediaPath={('botSpeechMedia.' + speech('WarnMessageText')) as ChatMediaFieldPath}
          label="Текст предупреждения"
        />
      ) : null}
      {c.toggle(boolean('MuteEnabled'), '3. Ограничение')}
      {c.number(number('MuteDurationHours'), 'Срок ограничения, ч', 1, 168)}
      {c.toggle(boolean('BanEnabled'), '4. Блокировка')}
      {thresholds ? (
        <>
          {c.number(number('EscalationWindowHours'), 'Период учёта нарушений, ч', 1, 168)}
          {c.number(number('WarnMaxCount'), 'Нарушений до предупреждения', 1, 20)}
          {c.number(number('MuteMaxCount'), 'Нарушений до ограничения', 1, 20)}
          {c.number(number('BanMaxCount'), 'Нарушений до блокировки', 1, 20)}
        </>
      ) : null}
      {buttons ? (
        <Buttons
          fields={fields}
          context={context}
          path={(prefix + 'BotButtons') as ButtonPath}
          enabledPath={boolean('BotButtonEnabled')}
        />
      ) : null}
      {context.renderAdminContact ? (
        context.renderAdminContact({
          enabledPath: adminEnabled,
          urlPath: adminUrl,
          label: 'Добавить связь с админом',
        })
      ) : (
        <>
          {c.toggle(adminEnabled, 'Добавить связь с админом')}
          {c.text(adminUrl, 'Ссылка для связи с админом', 2000)}
        </>
      )}
    </Group>
  );
}

function Reports({ fields, context }: BodyProps) {
  const c = controls(fields);
  return (
    <>
      <Group
        title="Жалобы участников"
        hint="Отправьте /report или «жалоба» ответом на сообщение. Бот применит выбранные меры, когда наберётся порог голосов."
      >
        {c.toggle(
          'reportsEnabled',
          'Жалобы участников',
          undefined,
          context.reportsActivationAvailable === false,
        )}
        <div className="reports-threshold-buttons" role="group" aria-label="Сколько голосов нужно">
          {[2, 3, 4, 5, 6].map((value) => (
            <button
              type="button"
              key={value}
              disabled={fields.readOnly}
              aria-pressed={
                fields.read('reportsThreshold').kind === 'common' &&
                (fields.read('reportsThreshold') as { kind: 'common'; value: number }).value ===
                  value
              }
              onClick={() => fields.setScalar('reportsThreshold', value)}
            >
              {value}
            </button>
          ))}
        </div>
        {c.number('reportsThreshold', 'Порог жалоб', 2, 6)}
        <FieldList<string>
          label="Дополнительные команды жалобы"
          state={fields.read('reportsAliases')}
          disabled={fields.readOnly}
          error={fields.error('reportsAliases')}
          onChange={(value) => fields.replaceList('reportsAliases', value)}
        >
          {(items, replace) => (
            <StringList
              items={items}
              onChange={replace}
              disabled={fields.readOnly}
              label="Команды через запятую"
              onPending={(pending) =>
                fields.setError(
                  'reportsAliases',
                  pending ? 'Примените команды или отмените ввод.' : null,
                )
              }
            />
          )}
        </FieldList>
      </Group>
      <Group title="Меры по жалобе">
        {c.select('reportsDeleteMode', 'Удаление сообщения', [
          { value: 'MESSAGE', label: 'Сообщение с жалобами' },
          { value: 'HISTORY_24H', label: 'Сообщения автора за 24 часа' },
        ])}
        {c.toggle('reportsMuteEnabled', 'Ограничить автора сообщения')}
        {c.number('reportsMuteDurationHours', 'Срок ограничения, ч', 1, 24)}
      </Group>
    </>
  );
}

function StringList({
  items,
  onChange,
  disabled,
  label,
  onPending,
}: {
  items: string[];
  onChange: (items: string[]) => void;
  disabled: boolean;
  label: string;
  onPending?: (pending: boolean) => void;
}) {
  const [buffer, setBuffer] = useState<string | null>(null);
  const incoming = JSON.stringify(items);
  useEffect(() => setBuffer(null), [incoming]);
  return (
    <>
      <textarea
        aria-label={label}
        value={buffer ?? items.join('\n')}
        disabled={disabled}
        onChange={(event) => {
          setBuffer(event.target.value);
          onPending?.(true);
        }}
      />
      <button
        type="button"
        disabled={disabled || buffer === null}
        onClick={() => {
          onPending?.(false);
          onChange(
            (buffer ?? '')
              .split(/[,;\r\n]+/u)
              .map((value) => value.trim())
              .filter(Boolean),
          );
        }}
      >
        Применить список
      </button>
      {buffer !== null ? (
        <button
          type="button"
          disabled={disabled}
          onClick={() => {
            setBuffer(null);
            onPending?.(false);
          }}
        >
          Отменить ввод
        </button>
      ) : null}
    </>
  );
}

function DeleteDelay({
  fields,
  path,
}: {
  fields: ChatSettingsFieldAdapter;
  path: 'greetingDeleteBotMessageDelayMinutes' | 'deleteBotMessagesDelayMinutes';
}) {
  const state = fields.read(path);
  return (
    <FieldSelect
      label="Удалять через"
      state={state.kind === 'common' ? { kind: 'common', value: String(state.value) } : state}
      disabled={fields.readOnly}
      error={fields.error(path)}
      options={DELETE_BOT_MESSAGES_DELAY_ALLOWED_MINUTES.map((value) => ({
        value: String(value),
        label: value === 0.5 ? '30 секунд' : `${value} мин`,
      }))}
      onChange={(value) => fields.setScalar(path, Number(value))}
    />
  );
}

function Links(props: BodyProps) {
  const c = controls(props.fields);
  return (
    <>
      <Group
        title="Правила ссылок"
        hint="Выберите, какие ссылки могут публиковать участники. Списки разрешений редактируются отдельно от мер за нарушение."
      >
        {c.select(
          'linkPolicy',
          'Режим проверки ссылок',
          [
            { value: 'ALLOWLIST_ONLY', label: 'Разрешать только из списка' },
            { value: 'BLOCKLIST_ONLY', label: 'Блокировать из списка' },
            { value: 'ALERT_ONLY', label: 'Только предупреждать' },
          ],
          (value) => setChatLinkPolicy(props.fields, value),
        )}
        {props.context.navigationAllowlist ?? (
          <p className="field__hint">Список разрешённых источников загружается отдельно.</p>
        )}
      </Group>
      <Sanctions {...props} prefix="link" warningText buttons thresholds />
    </>
  );
}

function Greeting({ fields, context }: BodyProps) {
  const c = controls(fields);
  return (
    <>
      <Group
        title="Приветствие"
        hint="Бот приветствует новых участников. В тексте можно использовать подстановки имени участника и названия чата."
      >
        {c.toggle('greetingEnabled', 'Приветствовать новых участников')}
        <Speech
          fields={fields}
          path="greetingBotMessageText"
          mediaPath="botSpeechMedia.greetingBotMessageText"
          label="Текст приветствия"
        />
        <Buttons
          fields={fields}
          context={context}
          path="greetingBotButtons"
          enabledPath="greetingBotButtonEnabled"
        />
        {c.toggle(
          'greetingRulesButtonEnabled',
          'Добавить кнопку правил',
          'Кнопка использует опубликованные правила каждого чата. Сохранённая настройка не зависит от доступности предпросмотра правил.',
        )}
      </Group>
      <Group title="Удаление приветствия">
        {c.toggle('greetingDeleteBotMessageEnabled', 'Удалять приветствие бота')}
        <DeleteDelay fields={fields} path="greetingDeleteBotMessageDelayMinutes" />
      </Group>
    </>
  );
}

function Profanity(props: BodyProps) {
  const c = controls(props.fields);
  const sensitivity = props.fields.read('profanitySensitivity');
  return (
    <>
      <Group
        title="Фильтр мата"
        hint="Проверка русскоязычной ненормативной лексики с выбранной чувствительностью."
      >
        {c.toggle('russianProfanityFilterEnabled', 'Фильтр мата')}
        {c.select('profanitySensitivity', 'Чувствительность', PROFANITY_SENSITIVITY_OPTIONS)}
        {sensitivity.kind === 'common' ? (
          <p className="field__hint">{PROFANITY_SENSITIVITY_HINTS[sensitivity.value]}</p>
        ) : null}
      </Group>
      <Sanctions {...props} prefix="profanity" warningText />
    </>
  );
}

function Commercial(props: BodyProps) {
  const c = controls(props.fields);
  const sensitivity = props.fields.read('commercialAdsSensitivity');
  const warning = props.fields.read('commercialAdsWarnThreshold');
  const deletion = props.fields.read('commercialAdsDeleteThreshold');
  const position =
    sensitivity.kind === 'common' && warning.kind === 'common' && deletion.kind === 'common'
      ? inferCommercialSliderPosition({
          commercialAdsSensitivity: sensitivity.value,
          commercialAdsWarnThreshold: warning.value,
          commercialAdsDeleteThreshold: deletion.value,
        })
      : null;
  return (
    <>
      <Group
        title="Коммерческая реклама"
        hint="Чувствительность задаёт пороги предупреждения и удаления рекламных сообщений."
      >
        {c.toggle('commercialAdsFilterEnabled', 'Фильтр рекламы')}
        {position === null ? (
          <p className="field__hint">
            Чувствительность задана отдельно или различается между чатами. Выберите общий профиль
            либо настройте пороги ниже.
          </p>
        ) : null}
        {position !== null ? (
          <input
            type="range"
            min={0}
            max={100}
            value={position}
            disabled={props.fields.readOnly}
            aria-label="Ползунок чувствительности коммерческого фильтра"
            onChange={(event) =>
              setChatCommercialSensitivity(props.fields, Number(event.target.value))
            }
          />
        ) : (
          <div role="group" aria-label="Выбрать общую чувствительность">
            {[
              { value: 20, label: 'Мягкая' },
              { value: 50, label: 'Обычная' },
              { value: 85, label: 'Строгая' },
            ].map((option) => (
              <button
                type="button"
                key={option.value}
                disabled={props.fields.readOnly}
                onClick={() => setChatCommercialSensitivity(props.fields, option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
        )}
        <FieldNumber
          label="Общая чувствительность, %"
          min={0}
          max={100}
          state={position === null ? { kind: 'mixed' } : { kind: 'common', value: position }}
          disabled={props.fields.readOnly}
          onError={(error) => props.fields.setError('commercialAdsSensitivity', error)}
          error={props.fields.error('commercialAdsSensitivity')}
          onChange={(value) => setChatCommercialSensitivity(props.fields, value)}
        />
        {c.select('commercialAdsSensitivity', 'Чувствительность распознавания', [
          { value: 'BALANCED', label: 'Обычная' },
          { value: 'STRICT', label: 'Строгая' },
        ])}
        {c.number('commercialAdsWarnThreshold', 'Порог предупреждения', 10, 90)}
        {c.number('commercialAdsDeleteThreshold', 'Порог удаления', 20, 100)}
      </Group>
      <Sanctions {...props} prefix="textFilters" warningText buttons />
    </>
  );
}

function Duplicates(props: BodyProps) {
  const { fields } = props;
  const c = controls(fields);
  return (
    <>
      <Group
        title="Антидубль"
        hint="Повторные сообщения учитываются в заданном интервале или ежедневном окне."
      >
        {c.toggle('antiDuplicateEnabled', 'Проверять повторы сообщений')}
        {c.select(
          'duplicateDetectionPreset',
          'Режим сравнения',
          [
            { value: 'STANDARD', label: 'Обычный' },
            { value: 'STRICT', label: 'Строгий' },
            { value: 'CUSTOM', label: 'Свой' },
          ],
          (value) => setChatDuplicatePreset(fields, value),
        )}
        {c.select('duplicateCompareMode', 'Что сравнивать', [
          { value: 'MESSAGE', label: 'Сообщение целиком' },
          { value: 'TEXT', label: 'Только текст' },
        ])}
        {c.toggle('duplicateIgnoreLinksEnabled', 'Не учитывать ссылки')}
        {c.toggle('duplicateIgnorePhonesEnabled', 'Не учитывать телефоны')}
        {c.toggle('duplicateNearMatchEnabled', 'Учитывать похожие тексты')}
      </Group>
      <DuplicateFlowControls fields={fields} />
      <Group title="Период проверки">
        {c.select('duplicateWindowMode', 'Когда проверять', [
          { value: 'INTERVAL', label: 'За интервал' },
          { value: 'DAILY', label: 'Ежедневное окно' },
        ])}
        {c.time('duplicateStartTimeMinutes', 'Начало окна')}
        {c.time('duplicateEndTimeMinutes', 'Конец окна')}
        {c.select('duplicateTimezone', 'Часовой пояс', RUSSIAN_TIMEZONE_OPTIONS)}
        {c.number('duplicateWarnWindowSec', 'Период предупреждений, сек', 3600, 172800)}
        {c.number('duplicateMuteWindowSec', 'Период ограничений, сек', 3600, 172800)}
        {c.number('duplicateBanWindowSec', 'Период блокировок, сек', 3600, 172800)}
        {c.number('duplicateWarnMaxCount', 'Повторов до предупреждения', 1, 20)}
        {c.number('duplicateMuteMaxCount', 'Повторов до ограничения', 1, 20)}
        {c.number('duplicateBanMaxCount', 'Повторов до блокировки', 1, 20)}
      </Group>
      <Group title="Повторы фото">
        {c.toggle('duplicatePhotoEnabled', 'Проверять повторы фото')}
        {c.select('duplicatePhotoMatchPreset', 'Сходство фото', [
          { value: 'SAME_IMAGE', label: 'То же изображение' },
          { value: 'MINOR_EDITS', label: 'С небольшими изменениями' },
        ])}
        {c.select('duplicatePhotoScope', 'Где искать повторы', [
          { value: 'SAME_AUTHOR', label: 'У того же автора' },
          { value: 'CHAT', label: 'Во всём чате' },
        ])}
      </Group>
      <Sanctions {...props} prefix="duplicate" buttons />
    </>
  );
}

function DuplicateFlowControls({ fields }: { fields: ChatSettingsFieldAdapter }) {
  const flow = readCommonDuplicateFlow(fields);
  const windows = ['duplicateWarnWindowSec', 'duplicateMuteWindowSec', 'duplicateBanWindowSec'].map(
    (path) => fields.read(path as ChatNumberField),
  );
  const commonWindow =
    windows.every(
      (state) =>
        state.kind === 'common' && windows[0].kind === 'common' && state.value === windows[0].value,
    ) && windows[0].kind === 'common'
      ? windows[0].value / 3600
      : null;
  return (
    <Group title="Последовательность действий">
      <FieldNumber
        label="Разрешить повторов"
        state={
          flow
            ? { kind: 'common', value: resolveDuplicateFlowAllowedCount(flow) }
            : { kind: 'mixed' }
        }
        min={0}
        max={flow ? resolveDuplicateFlowAllowedCountMax(flow) : 20}
        disabled={fields.readOnly || !flow}
        error={fields.error('duplicateWarnMaxCount')}
        onError={(error) => fields.setError('duplicateWarnMaxCount', error)}
        onChange={(value) => setChatDuplicateAllowedCount(fields, value)}
      />
      {!flow ? (
        <p className="field__hint">
          Этапы или пороги различаются. Их можно настроить отдельно ниже; общий счётчик станет
          доступен после выбора одинаковых значений.
        </p>
      ) : null}
      <FieldNumber
        label="Общий период проверки, ч"
        state={commonWindow === null ? { kind: 'mixed' } : { kind: 'common', value: commonWindow }}
        min={1}
        max={48}
        disabled={fields.readOnly}
        error={fields.error('duplicateWarnWindowSec')}
        onError={(error) => fields.setError('duplicateWarnWindowSec', error)}
        onChange={(value) => setChatDuplicateWindowHours(fields, value)}
      />
    </Group>
  );
}

function Limits(props: BodyProps) {
  const c = controls(props.fields);
  return (
    <>
      <Group title="Частота сообщений">
        {c.toggle('slowModeEnabled', 'Медленный режим')}
        {c.number('slowModeIntervalSeconds', 'Интервал сообщений, сек', 10, 86400)}
        {c.toggle('mediaMessageCooldownEnabled', 'Интервал медиасообщений')}
        {c.number('mediaMessageCooldownSeconds', 'Интервал медиа, сек', 10, 86400)}
        {c.toggle('antiSpamEnabled', 'Защита от спама')}
        {c.toggle('deleteSpammersEnabled', 'Удалять спамеров')}
        {c.toggle('messageCountLimitEnabled', 'Ограничить число сообщений')}
        {c.number('messageCountLimitMessages', 'Сообщений за период', 1, 10)}
        {c.number('messageCountLimitWindowHours', 'Период, ч', 1, 24)}
        {c.toggle('maxMessageLengthEnabled', 'Ограничить длину сообщения')}
        {c.number('maxMessageLength', 'Максимум символов', 50, 1500)}
        {c.toggle('photoMessageCooldownEnabled', 'Ограничить отправку фото по времени')}
        {c.number('photoMessageCooldownHours', 'Интервал фото, ч', 1, 24)}
        {c.toggle('stickerMessageCooldownEnabled', 'Ограничить отправку стикеров по времени')}
        {c.number('stickerMessageCooldownMinutes', 'Интервал стикеров, мин', 1, 60)}
      </Group>
      <Group title="Разрешённые типы сообщений">
        {c.toggle('stickerMessagesEnabled', 'Разрешить стикеры')}
        {c.toggle('photoMessagesEnabled', 'Разрешить фото')}
        {c.toggle('videoMessagesEnabled', 'Разрешить видео')}
        {c.toggle('fileMessagesEnabled', 'Разрешить файлы')}
        {c.toggle('voiceMessagesEnabled', 'Разрешить голосовые')}
        {c.toggle('forwardedMessagesEnabled', 'Разрешить пересланные сообщения')}
        {c.toggle('phoneNumbersEnabled', 'Разрешить телефоны')}
      </Group>
      <Sanctions {...props} prefix="messageLimits" warningText buttons />
    </>
  );
}

function StopRules({
  items,
  replace,
  disabled,
  onPending,
}: {
  items: StopWordsRule[];
  replace: (items: StopWordsRule[]) => void;
  disabled: boolean;
  onPending: (error: string | null) => void;
}) {
  const [presetsOpen, setPresetsOpen] = useState(false);
  const [buffer, setBuffer] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(100);
  const [selected, setSelected] = useState<string[]>([]);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [editing, setEditing] = useState<StopWordsRule | null>(null);
  const filtered = items.filter((rule) =>
    normalizeStopWordsValue(rule.value).includes(normalizeStopWordsValue(query)),
  );
  const saveRule = () => {
    if (!editing) return;
    const parsed = stopWordsRuleSchema.safeParse({
      ...editing,
      kind: normalizeStopWordsValue(editing.value).includes(' ') ? 'PHRASE' : 'WORD',
    });
    const failure = !parsed.success
      ? (parsed.error.issues[0]?.message ?? 'Проверьте запись.')
      : items.some(
            (rule) =>
              rule.id !== editing.id &&
              normalizeStopWordsValue(rule.value) === normalizeStopWordsValue(parsed.data.value),
          )
        ? 'Такая запись уже есть в списке.'
        : null;
    if (failure || !parsed.success) {
      setError(failure);
      onPending(failure);
      return;
    }
    replace(items.map((rule) => (rule.id === editing.id ? parsed.data : rule)));
    setEditing(null);
    setError(null);
    onPending(null);
  };
  const commitBuffer = () => {
    if (!buffer.trim() || disabled || editing) return;
    const parsed = prepareStopWordsLists({ rules: items, domains: [] }, buffer);
    if (parsed.errors.length) {
      setError(parsed.errors.join(' '));
      onPending(parsed.errors[0]);
      return;
    }
    replace(parsed.lists.rules);
    setBuffer('');
    setError(null);
    onPending(null);
  };
  return (
    <>
      <label className="field">
        <span>Слова и фразы через запятую или с новой строки</span>
        <textarea
          value={buffer}
          disabled={disabled || Boolean(editing)}
          onChange={(event) => {
            setBuffer(event.target.value);
            onPending(
              event.target.value.trim()
                ? 'Добавьте введённые слова в список или отмените ввод.'
                : null,
            );
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              commitBuffer();
            }
          }}
        />
      </label>
      <button type="button" disabled={disabled || !buffer.trim()} onClick={commitBuffer}>
        Добавить слова и фразы
      </button>
      {buffer ? (
        <button
          type="button"
          disabled={disabled}
          onClick={() => {
            setBuffer('');
            setError(null);
            onPending(null);
          }}
        >
          Отменить ввод
        </button>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
      <details onToggle={(event) => setPresetsOpen(event.currentTarget.open)}>
        <summary>Готовые наборы</summary>
        {presetsOpen ? (
          <Suspense fallback={<Spinner label="Загружаем готовые наборы" />}>
            <SharedStopWordsPresetButtons
              items={items}
              disabled={disabled || Boolean(buffer) || Boolean(editing)}
              replace={replace}
              onError={setError}
            />
          </Suspense>
        ) : null}
      </details>
      <label className="field">
        <span>Поиск по списку</span>
        <input
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setLimit(100);
          }}
        />
      </label>
      <p className="field__hint">
        Записей: {items.length}. Показано: {Math.min(limit, filtered.length)} из {filtered.length}.
      </p>
      {filtered.slice(0, limit).map((rule) => (
        <div className="settings-native-toggle" key={rule.id}>
          <label>
            <input
              type="checkbox"
              aria-label={`Выбрать ${rule.value}`}
              checked={selected.includes(rule.id)}
              disabled={disabled}
              onChange={(event) =>
                setSelected((current) =>
                  event.target.checked
                    ? [...current, rule.id]
                    : current.filter((id) => id !== rule.id),
                )
              }
            />
            Выбрать
          </label>
          <FieldToggle
            label={rule.value}
            disabled={disabled || Boolean(buffer) || Boolean(editing)}
            state={{ kind: 'common', value: rule.enabled }}
            onChange={(enabled) =>
              replace(items.map((item) => (item.id === rule.id ? { ...item, enabled } : item)))
            }
          />
          <FieldSelect
            label={`Совпадение: ${rule.value}`}
            state={{ kind: 'common', value: rule.matchMode }}
            disabled={disabled || Boolean(buffer) || Boolean(editing)}
            options={[
              { value: 'EXACT', label: 'Точное' },
              { value: 'MASKED', label: 'С маскировкой' },
            ]}
            onChange={(matchMode) =>
              replace(items.map((item) => (item.id === rule.id ? { ...item, matchMode } : item)))
            }
          />
          <button
            type="button"
            disabled={disabled || Boolean(buffer) || Boolean(editing)}
            aria-label={`Редактировать ${rule.value}`}
            onClick={() => setEditing({ ...rule })}
          >
            Редактировать
          </button>
          <button
            type="button"
            disabled={disabled || Boolean(buffer) || Boolean(editing)}
            aria-label={`Удалить ${rule.value}`}
            onClick={() => replace(items.filter((item) => item.id !== rule.id))}
          >
            Удалить
          </button>
        </div>
      ))}
      {limit < filtered.length ? (
        <button type="button" onClick={() => setLimit(limit + 100)}>
          Показать ещё
        </button>
      ) : null}
      {selected.length ? (
        <button
          type="button"
          disabled={disabled || Boolean(buffer) || Boolean(editing)}
          onClick={() => setConfirmDelete(true)}
        >
          Удалить выбранные ({selected.length})
        </button>
      ) : null}
      {editing ? (
        <div className="settings-native-toggle">
          <label>
            Слово или фраза
            <input
              value={editing.value}
              disabled={disabled}
              onChange={(event) => {
                setEditing({ ...editing, value: event.target.value });
                onPending('Примените изменение записи или отмените ввод.');
              }}
            />
          </label>
          <button type="button" disabled={disabled} onClick={saveRule}>
            Применить запись
          </button>
          <button
            type="button"
            disabled={disabled}
            onClick={() => {
              setEditing(null);
              setError(null);
              onPending(null);
            }}
          >
            Отменить изменение записи
          </button>
        </div>
      ) : null}
      {confirmDelete ? (
        <Suspense fallback={<Spinner />}>
          <LazyActionConfirmSheet
            id="shared-stop-words-delete"
            open
            title="Удалить выбранные записи?"
            summary={`Записей: ${selected.length}`}
            confirmLabel="Удалить"
            onClose={() => setConfirmDelete(false)}
            onConfirm={() => {
              replace(items.filter((rule) => !selected.includes(rule.id)));
              setSelected([]);
              setConfirmDelete(false);
            }}
          />
        </Suspense>
      ) : null}
    </>
  );
}

function StopWords({ fields, context }: BodyProps) {
  const c = controls(fields);
  return (
    <>
      <Group
        title="Стоп-слова"
        hint="Слова и фразы проверяются как отдельные правила. Фраза с пробелами сохраняется целиком."
      >
        {c.toggle('stopWordsPolicy.enabled', 'Включить стоп-слова')}
        <FieldList<StopWordsRule>
          label="Слова и фразы"
          state={fields.read('stopWordsPolicy.rules')}
          disabled={fields.readOnly}
          error={fields.error('stopWordsPolicy.rules')}
          onChange={(rules) => fields.replaceList('stopWordsPolicy.rules', rules)}
        >
          {(items, replace) => (
            <StopRules
              key={JSON.stringify(items)}
              items={items}
              replace={replace}
              disabled={fields.readOnly}
              onPending={(error) => fields.setError('stopWordsPolicy.rules', error)}
            />
          )}
        </FieldList>
        <FieldList<string>
          label="Заблокированные сайты"
          state={fields.read('stopWordsPolicy.domains')}
          disabled={fields.readOnly}
          error={fields.error('stopWordsPolicy.domains')}
          onChange={(domains) => fields.replaceList('stopWordsPolicy.domains', domains)}
        >
          {(items, replace) => <DomainList items={items} replace={replace} fields={fields} />}
        </FieldList>
        {c.toggle(
          'stopWordsPolicy.imageScanEnabled',
          'Проверять текст на изображениях',
          'Работа распознавания зависит от доступности сервиса в каждом чате.',
        )}
      </Group>
      <Group title="Действия бота">
        {c.toggle('stopWordsPolicy.sanctions.botMessageEnabled', 'Сообщение от бота')}
        <Speech
          fields={fields}
          path="stopWordsPolicy.sanctions.botMessageText"
          mediaPath="stopWordsPolicy.sanctions.media.explanation"
          label="Пояснение о стоп-словах"
        />
        {c.toggle('stopWordsPolicy.sanctions.warnEnabled', 'Предупреждение')}
        <Speech
          fields={fields}
          path="stopWordsPolicy.sanctions.warnMessageText"
          mediaPath="stopWordsPolicy.sanctions.media.warning"
          label="Текст предупреждения"
        />
        {c.toggle('stopWordsPolicy.sanctions.muteEnabled', 'Ограничение')}
        {c.number('stopWordsPolicy.sanctions.muteDurationHours', 'Срок ограничения, ч', 1, 168)}
        {c.toggle('stopWordsPolicy.sanctions.banEnabled', 'Блокировка')}
        <Buttons
          fields={fields}
          context={context}
          path="stopWordsPolicy.sanctions.botButtons"
          enabledPath="stopWordsPolicy.sanctions.botButtonEnabled"
        />
        {c.toggle('stopWordsPolicy.sanctions.rulesButtonEnabled', 'Добавить кнопку правил')}
        {context.renderAdminContact ? (
          context.renderAdminContact({
            enabledPath: 'stopWordsPolicy.sanctions.adminContactButtonEnabled',
            urlPath: 'stopWordsPolicy.sanctions.adminContactButtonUrl',
            label: 'Добавить связь с админом',
          })
        ) : (
          <>
            {c.toggle(
              'stopWordsPolicy.sanctions.adminContactButtonEnabled',
              'Добавить связь с админом',
            )}
            {c.text(
              'stopWordsPolicy.sanctions.adminContactButtonUrl',
              'Ссылка для связи с админом',
              2000,
            )}
          </>
        )}
      </Group>
    </>
  );
}

function DomainList({
  items,
  replace,
  fields,
}: {
  items: string[];
  replace: (items: string[]) => void;
  fields: ChatSettingsFieldAdapter;
}) {
  return (
    <StringList
      items={items}
      disabled={fields.readOnly}
      label="Сайты через запятую или с новой строки"
      onPending={(pending) =>
        fields.setError(
          'stopWordsPolicy.domains',
          pending ? 'Примените введённый список или отмените ввод.' : null,
        )
      }
      onChange={(domains) => {
        const parsed = prepareStopWordsLists({ rules: [], domains: [] }, '', domains.join('\n'));
        fields.setError('stopWordsPolicy.domains', parsed.errors[0] ?? null);
        if (!parsed.errors.length) replace(parsed.lists.domains);
      }}
    />
  );
}

function Phones(props: BodyProps) {
  const c = controls(props.fields);
  return (
    <>
      <Group
        title="Номера телефонов"
        hint="Когда номера запрещены, бот проверяет текст сообщений и применяет выбранные меры."
      >
        {c.toggle('phoneNumbersEnabled', 'Разрешить номера телефонов')}
      </Group>
      <Sanctions {...props} prefix="phoneNumbers" thresholds />
    </>
  );
}

function Night({ fields, context }: BodyProps) {
  const c = controls(fields);
  return (
    <>
      <Group
        title="Ночной режим"
        hint="Время задаётся в выбранном часовом поясе. Закрытие через полночь заканчивается на следующий день."
      >
        {c.toggle('nightModeEnabled', 'Закрывать чат по расписанию')}
        {c.time('nightModeStartTimeMinutes', 'Закрыть чат в')}
        {c.time('nightModeEndTimeMinutes', 'Открыть чат в')}
        {c.select('nightModeTimezone', 'Часовой пояс', RUSSIAN_TIMEZONE_OPTIONS)}
      </Group>
      <Group title="Сообщения и кнопки">
        {c.toggle('nightModeBotMessageEnabled', 'Сообщение о закрытии')}
        <Speech
          fields={fields}
          path="nightModeBotMessageText"
          mediaPath="botSpeechMedia.nightModeBotMessageText"
          label="Сообщение о закрытии чата"
        />
        {c.toggle('nightModeCommentsEnabled', 'Комментарии к сообщению о закрытии')}
        {c.toggle('nightModeOpenMessageEnabled', 'Сообщение об открытии')}
        <Speech
          fields={fields}
          path="nightModeOpenMessageText"
          mediaPath="botSpeechMedia.nightModeOpenMessageText"
          label="Сообщение об открытии чата"
        />
        <Buttons
          fields={fields}
          context={context}
          path="nightModeBotButtons"
          enabledPath="nightModeBotButtonEnabled"
        />
        {c.toggle('nightModeRulesButtonEnabled', 'Добавить кнопку правил')}
      </Group>
      <Group
        title="Закрыть чат вручную"
        hint="Запланированное закрытие и ручное закрытие настраиваются отдельно. Текущее состояние чата показывается только при наличии свежих данных."
      >
        {c.toggle('nightModeForceCloseEnabled', 'Закрыть чат сейчас')}
        {c.toggle('nightModeForceCloseForever', 'Без срока')}
        {c.number('nightModeForceCloseDays', 'Дней', 0, 30)}
        {c.number('nightModeForceCloseHours', 'Часов', 0, 23)}
      </Group>
    </>
  );
}

function RequiredSubscription(props: BodyProps) {
  const c = controls(props.fields);
  return (
    <>
      <Group
        title="Обязательная подписка"
        hint="Проверка включается при заданном списке каналов. Уже сохранённые источники сохраняются при ошибке поиска."
      >
        {props.context.requiredSubscriptionSources ?? (
          <p className="field__hint">Выбор обязательных каналов загружается отдельно.</p>
        )}
        {c.text('requiredSubscriptionButtonText', 'Текст кнопки подписки', 32)}
      </Group>
      <Sanctions {...props} prefix="requiredSubscription" warningText mandatoryMessage />
    </>
  );
}

function Invitation(props: BodyProps) {
  const c = controls(props.fields);
  return (
    <>
      <Group
        title="Доступ за приглашения"
        hint="Активация этой функции пока недоступна. Параметры можно подготовить и сохранить для будущего включения."
      >
        {c.toggle(
          'invitationAccessEnabled',
          'Включить доступ за приглашения',
          undefined,
          !props.context.invitationActivationAvailable,
        )}
        {c.number('invitationAccessRequiredCount', 'Сколько участников пригласить', 1, 10)}
      </Group>
      <Sanctions {...props} prefix="invitationAccess" warningText />
    </>
  );
}

function Commands({ fields }: BodyProps) {
  const c = controls(fields);
  return (
    <>
      <Group
        title="Модерация"
        hint="Команды доступны администраторам. Названия вводятся без начального слеша."
      >
        {c.text('adminBanCommandName', 'Заблокировать', 32)}
        {c.text('adminBanAllCommandName', 'Заблокировать во всех чатах', 32)}
        {c.text('adminMuteCommandName', 'Ограничить', 32)}
        {c.text('adminPermanentMuteCommandName', 'Ограничить навсегда', 32)}
      </Group>
      <Group title="Управление чатом">
        {c.text('adminRulesCommandName', 'Правила', 32)}
        {c.text('adminSilenceCommandName', 'Закрыть чат', 32)}
        {c.text('adminOpenChatCommandName', 'Открыть чат', 32)}
      </Group>
    </>
  );
}

function Storefront({ fields }: BodyProps) {
  const c = controls(fields);
  const textPaths = [
    'karavanStorefrontMessageText',
    'karavanStorefrontOpenButtonText',
    'karavanStorefrontCatalogButtonText',
    'karavanStorefrontCreateButtonText',
  ] as const;
  return (
    <>
      <Group title="Витрина Каравана" hint="Участники открывают каталог через бота Караван.">
        {c.toggle('karavanStorefrontEnabled', 'Включить витрину')}
        {c.toggle('karavanStorefrontAdminsOnly', 'Только для администраторов')}
      </Group>
      <Group title="Текст и кнопки витрины">
        {c.text('karavanStorefrontMessageText', 'Сообщение витрины', 1000, true)}
        {c.text('karavanStorefrontOpenButtonText', 'Кнопка открытия', 64)}
        {c.text('karavanStorefrontCatalogButtonText', 'Кнопка каталога', 64)}
        {c.text('karavanStorefrontCreateButtonText', 'Кнопка создания витрины', 64)}
        <button
          type="button"
          disabled={fields.readOnly}
          onClick={() => fields.transact(textPaths.map((path) => ({ op: 'set', path, value: '' })))}
        >
          Стандартные тексты витрины
        </button>
      </Group>
    </>
  );
}

function Extra({ fields }: BodyProps) {
  const c = controls(fields);
  return (
    <Group title="Сообщения и боты">
      {c.toggle('deleteBotMessagesEnabled', 'Удалять сообщения бота')}
      <DeleteDelay fields={fields} path="deleteBotMessagesDelayMinutes" />
      {c.toggle(
        'removeBotsFromGroupEnabled',
        'Удалять других ботов',
        'Бот удаляет новых ботов из группы при наличии необходимых прав.',
      )}
    </Group>
  );
}

const SECTION_BODIES = {
  reports: Reports,
  links: Links,
  greeting: Greeting,
  profanityFilter: Profanity,
  commercialFilter: Commercial,
  duplicates: Duplicates,
  limits: Limits,
  stopWords: StopWords,
  phones: Phones,
  night: Night,
  requiredSubscription: RequiredSubscription,
  invitationAccess: Invitation,
  commands: Commands,
  storefront: Storefront,
  extra: Extra,
} satisfies Record<SharedChatSettingsSectionProps['section'], (props: BodyProps) => ReactNode>;

export function SharedChatSettingsFields({
  section,
  fields,
  context,
}: SharedChatSettingsSectionProps) {
  const Body = SECTION_BODIES[section];
  const publish = (changes: Parameters<ChatSettingsFieldAdapter['transact']>[0]) => {
    let currentPath = changes[0]?.path;
    try {
      const checked: NetworkSettingsChange[] = changes.map((change) => {
        currentPath = change.path;
        if (change.op === 'clear') return change;
        const value = parseSettingsField('chat', section, change.path, change.value);
        if (change.op === 'replace') {
          if (!Array.isArray(value)) throw new Error('Для списка требуется явная замена.');
          return { op: 'replace', path: change.path, value };
        }
        return { op: 'set', path: change.path, value };
      });
      fields.transact(checked);
      for (const change of changes)
        fields.setError(change.path as keyof ChatSettingsFieldValues, null);
    } catch (cause) {
      if (currentPath)
        fields.setError(
          currentPath as keyof ChatSettingsFieldValues,
          cause instanceof Error ? cause.message : 'Проверьте значение поля.',
        );
    }
  };
  const guarded: ChatSettingsFieldAdapter = {
    ...fields,
    setScalar: (path, value) => publish([{ op: 'set', path, value }]),
    replaceList: (path, value) => publish([{ op: 'replace', path, value }]),
    transact: publish,
  };
  return (
    <div className="shared-chat-settings-fields" data-settings-section={section}>
      {context.runtimeNotes?.[section]}
      <Body fields={guarded} context={context} />
      {context.sectionTools?.[section]}
    </div>
  );
}
