import {
  getBotSpeechEditableTemplate,
  type BotSpeechEditableFieldKey,
} from '@maxim/contracts/bot-speech';
import type {
  ChatMediaFieldPath,
  ChatSettingsFieldAdapter,
} from '../../features/network-settings/field-model';
import {
  BotSpeechMessageEditorSheet,
  type BotSpeechEditorFocusRequest,
} from '../../components/bot-speech-message-editor-sheet';

export type SharedSpeechPath =
  | BotSpeechEditableFieldKey
  | 'stopWordsPolicy.sanctions.botMessageText'
  | 'stopWordsPolicy.sanctions.warnMessageText';

export type SharedBotSpeechEditorProps = {
  fields: ChatSettingsFieldAdapter;
  path: SharedSpeechPath;
  mediaPath?: ChatMediaFieldPath;
  title: string;
  onClose: () => void;
  textError?: string | null;
  mediaError?: string | null;
  focusRequest?: BotSpeechEditorFocusRequest;
};

export function SharedBotSpeechEditor({
  fields,
  path,
  mediaPath,
  title,
  onClose,
  textError,
  mediaError,
  focusRequest,
}: SharedBotSpeechEditorProps) {
  const text = fields.read(path);
  const media = mediaPath ? fields.read(mediaPath) : null;
  const style = fields.read('botSpeechStyle');
  const templatePath =
    path === 'stopWordsPolicy.sanctions.botMessageText'
      ? 'messageLimitsBotMessageText'
      : path === 'stopWordsPolicy.sanctions.warnMessageText'
        ? 'messageLimitsWarnMessageText'
        : path;
  const edit = (change: () => void, field: SharedSpeechPath | ChatMediaFieldPath) => {
    if (fields.readOnly) return;
    try {
      fields.setError(field, null);
      change();
    } catch (cause) {
      fields.setError(field, cause instanceof Error ? cause.message : 'Проверьте сообщение.');
    }
  };
  return (
    <BotSpeechMessageEditorSheet
      title={title}
      ariaLabel={
        path.endsWith('WarnMessageText') || path.endsWith('.warnMessageText')
          ? 'Редактор текста предупреждения'
          : 'Редактор текста сообщения'
      }
      value={text.kind === 'common' ? text.value : ''}
      // FLAG: Unknown group style is never replaced by one recipient's template.
      defaultValue={
        style.kind === 'common' ? getBotSpeechEditableTemplate(style.value, templatePath) : ''
      }
      image={media?.kind === 'common' ? media.value : null}
      imageMixed={media?.kind === 'mixed'}
      textMixed={text.kind === 'mixed'}
      textError={textError}
      mediaError={mediaError}
      focusRequest={focusRequest}
      onChange={(value) => edit(() => fields.setScalar(path, value), path)}
      onImageChange={
        mediaPath
          ? (image) =>
              edit(
                () => (image ? fields.setScalar(mediaPath, image) : fields.clearMedia(mediaPath)),
                mediaPath,
              )
          : undefined
      }
      onReset={() =>
        edit(
          () =>
            fields.transact([
              { op: 'set', path, value: '' },
              ...(mediaPath &&
              (media?.kind === 'mixed' || (media?.kind === 'common' && media.value))
                ? [{ op: 'clear' as const, path: mediaPath }]
                : []),
            ]),
          path,
        )
      }
      onClose={onClose}
    />
  );
}
