import { Suspense, useEffect, useRef, useState, type ReactNode } from 'react';
import type {
  ChatMediaFieldPath,
  ChatSettingsFieldAdapter,
} from '../../features/network-settings/field-model';
import {
  setChatBoolean,
  type ChatBooleanField,
} from '../../features/network-settings/chat-field-intents';
import { recoverableLazyNamedComponent } from '../../lib/recoverable-lazy';
import { Spinner } from '../../components/ui/spinner';
import { EditToggleButton } from './settings-edit-toggle-button';
import type { SharedBotSpeechEditorProps, SharedSpeechPath } from './shared-bot-speech-editor';

const LazySharedBotSpeechEditor = recoverableLazyNamedComponent<SharedBotSpeechEditorProps>(
  () => import('./shared-bot-speech-editor'),
  'SharedBotSpeechEditor',
);

const SPEECH_TITLES: Partial<Record<SharedSpeechPath, string>> = {
  linkBotMessageText: 'Объяснение о ссылках',
  linkWarnMessageText: 'Предупреждение о ссылках',
  greetingBotMessageText: 'Приветствие',
  requiredSubscriptionBotMessageText: 'Объяснение о подписке',
  requiredSubscriptionWarnMessageText: 'Предупреждение о подписке',
  invitationAccessBotMessageText: 'Объяснение о приглашениях',
  invitationAccessWarnMessageText: 'Предупреждение о приглашениях',
  textFiltersBotMessageText: 'Объяснение о коммерческой рекламе',
  textFiltersWarnMessageText: 'Предупреждение о рекламе',
  profanityBotMessageText: 'Объяснение о нецензурной лексике',
  profanityWarnMessageText: 'Предупреждение о нецензурной лексике',
  duplicateBotMessageText: 'Объяснение о дублях',
  messageLimitsBotMessageText: 'Объяснение об ограничениях',
  messageLimitsWarnMessageText: 'Предупреждение об ограничениях',
  phoneNumbersBotMessageText: 'Объяснение о телефонах',
  nightModeBotMessageText: 'Ночной режим',
  nightModeOpenMessageText: 'Открытие чата',
  'stopWordsPolicy.sanctions.botMessageText': 'Объяснение о стоп-словах',
  'stopWordsPolicy.sanctions.warnMessageText': 'Предупреждение о стоп-словах',
};
const SPEECH_EDIT_LABELS: Partial<Record<SharedSpeechPath, string>> = {
  linkBotMessageText: 'Редактировать текст сообщения о ссылках',
  linkWarnMessageText: 'Редактировать текст предупреждения за ссылки',
  greetingBotMessageText: 'Редактировать текст приветствия',
};

export function SharedSpeechField({
  fields,
  path,
  mediaPath,
  label,
  enabledPath,
  activationLabel = label,
  disableEditorWhenOff = false,
  editLabel,
  nested = false,
  titleAction,
  hint,
  className = '',
}: {
  fields: ChatSettingsFieldAdapter;
  path: SharedSpeechPath;
  mediaPath?: ChatMediaFieldPath;
  label: string;
  enabledPath?: ChatBooleanField;
  activationLabel?: string;
  disableEditorWhenOff?: boolean;
  editLabel?: string;
  nested?: boolean;
  titleAction?: ReactNode;
  hint?: ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const text = fields.read(path);
  const media = mediaPath ? fields.read(mediaPath) : null;
  const enabled = enabledPath ? fields.read(enabledPath) : null;
  const editorDisabled =
    fields.readOnly ||
    text.kind === 'loading' ||
    (disableEditorWhenOff && enabled?.kind === 'common' && !enabled.value);
  useEffect(() => {
    if (input.current) input.current.indeterminate = enabled?.kind === 'mixed';
  }, [enabled?.kind]);
  return (
    <div
      className={`settings-native-toggle${nested ? ' settings-native-toggle--nested' : ''} ${className}`}
    >
      <div className="settings-native-toggle__row">
        <div className="settings-native-toggle__title-wrap">
          <span className="settings-native-toggle__title">{label}</span>
          <div className="settings-native-toggle__title-actions">
            <EditToggleButton
              label={
                editLabel ?? SPEECH_EDIT_LABELS[path] ?? `Редактировать: ${label.toLowerCase()}`
              }
              onClick={() => setOpen(!open)}
              disabled={editorDisabled}
              isOpen={open}
            />
            {titleAction}
          </div>
        </div>
        {enabled && enabledPath ? (
          <label className="settings-native-switch" aria-label={activationLabel}>
            <input
              ref={input}
              type="checkbox"
              checked={enabled.kind === 'common' && enabled.value}
              aria-checked={
                enabled.kind === 'mixed' ? 'mixed' : enabled.kind === 'common' && enabled.value
              }
              disabled={fields.readOnly || enabled.kind === 'loading'}
              onChange={(event) => setChatBoolean(fields, enabledPath, event.target.checked)}
            />
            <span className="toggle-switch" aria-hidden="true">
              <span className="toggle-switch__thumb" />
            </span>
          </label>
        ) : null}
      </div>
      {hint}
      {enabled?.kind === 'mixed' || text.kind === 'mixed' || media?.kind === 'mixed' ? (
        <p className="field__hint">
          Разные значения. Изменятся только отредактированный текст или выбранное изображение.
        </p>
      ) : null}
      {fields.error(path) ? <p role="alert">{fields.error(path)}</p> : null}
      {mediaPath && fields.error(mediaPath) ? <p role="alert">{fields.error(mediaPath)}</p> : null}
      {open && !editorDisabled ? (
        <Suspense fallback={<Spinner label="Загружаем редактор" />}>
          <LazySharedBotSpeechEditor
            fields={fields}
            path={path}
            mediaPath={mediaPath}
            title={SPEECH_TITLES[path] ?? label}
            onClose={() => setOpen(false)}
          />
        </Suspense>
      ) : null}
    </div>
  );
}
