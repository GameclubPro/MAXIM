import type { ChatSettings } from '@maxim/contracts/settings';
import {
  getBotSpeechEditableTemplate,
  type BotSpeechEditableFieldKey,
} from '@maxim/contracts/bot-speech';
import type {
  BotMessageEditorKey,
  BotMessageEditorProps,
  BotSpeechPreviewContext,
  WarnMessageEditorKey,
  WarnMessageEditorProps,
} from '../pages/settings/settings-page-helpers';
import { BotSpeechMessageEditorSheet } from './bot-speech-message-editor-sheet';

const BOT_MESSAGE_EDITOR_FIELD_KEYS: Record<BotMessageEditorKey, BotSpeechEditableFieldKey> = {
  link: 'linkBotMessageText',
  greeting: 'greetingBotMessageText',
  requiredSubscription: 'requiredSubscriptionBotMessageText',
  invitationAccess: 'invitationAccessBotMessageText',
  textFilters: 'textFiltersBotMessageText',
  duplicate: 'duplicateBotMessageText',
  messageLimits: 'messageLimitsBotMessageText',
  stopWords: 'messageLimitsBotMessageText',
  phoneNumbers: 'phoneNumbersBotMessageText',
  night: 'nightModeBotMessageText',
  nightOpen: 'nightModeOpenMessageText',
};

const WARN_MESSAGE_EDITOR_FIELD_KEYS: Record<WarnMessageEditorKey, BotSpeechEditableFieldKey> = {
  linkWarn: 'linkWarnMessageText',
  requiredSubscriptionWarn: 'requiredSubscriptionWarnMessageText',
  invitationAccessWarn: 'invitationAccessWarnMessageText',
  textFiltersWarn: 'textFiltersWarnMessageText',
  stopWordsWarn: 'messageLimitsWarnMessageText',
};

const BOT_MESSAGE_EDITOR_SHEET_TITLES: Record<BotMessageEditorKey, string> = {
  link: 'Объяснение о ссылках',
  greeting: 'Приветствие',
  requiredSubscription: 'Объяснение о подписке',
  invitationAccess: 'Объяснение о приглашениях',
  textFilters: 'Объяснение о тексте',
  duplicate: 'Объяснение о дублях',
  messageLimits: 'Объяснение об ограничениях',
  stopWords: 'Объяснение о стоп-словах',
  phoneNumbers: 'Объяснение о телефонах',
  night: 'Ночной режим',
  nightOpen: 'Открытие чата',
};

const WARN_MESSAGE_EDITOR_SHEET_TITLES: Record<WarnMessageEditorKey, string> = {
  linkWarn: 'Предупреждение о ссылках',
  requiredSubscriptionWarn: 'Предупреждение о подписке',
  invitationAccessWarn: 'Предупреждение о приглашениях',
  textFiltersWarn: 'Предупреждение о тексте',
  stopWordsWarn: 'Предупреждение о стоп-словах',
};

function getSpeechTemplateFallback(
  style: ChatSettings['botSpeechStyle'],
  fieldKey: BotSpeechEditableFieldKey,
  previewContext: BotSpeechPreviewContext,
): string {
  return getBotSpeechEditableTemplate(style, fieldKey, previewContext.persona);
}

function renderBotSpeechMessageEditor(
  props: Omit<BotMessageEditorProps, 'editorKey'>,
  fieldKey: BotSpeechEditableFieldKey,
  title: string,
  ariaLabel: string,
) {
  return (
    <BotSpeechMessageEditorSheet
      title={title}
      value={props.value}
      defaultValue={getSpeechTemplateFallback(
        props.settings.botSpeechStyle,
        fieldKey,
        props.botSpeechPreviewContext,
      )}
      image={props.settings.botSpeechMedia[fieldKey] ?? null}
      ariaLabel={ariaLabel}
      onChange={props.onChange}
      onImageChange={
        props.onImageChange ? (image) => props.onImageChange?.(fieldKey, image) : undefined
      }
      onReset={props.onReset}
      onClose={props.onClose}
    />
  );
}

export function BotMessageEditor(props: BotMessageEditorProps) {
  const fieldKey = BOT_MESSAGE_EDITOR_FIELD_KEYS[props.editorKey];
  return renderBotSpeechMessageEditor(
    props,
    fieldKey,
    BOT_MESSAGE_EDITOR_SHEET_TITLES[props.editorKey],
    'Редактор текста сообщения',
  );
}

export function WarnMessageEditor(props: WarnMessageEditorProps) {
  const fieldKey = WARN_MESSAGE_EDITOR_FIELD_KEYS[props.editorKey];
  return renderBotSpeechMessageEditor(
    props,
    fieldKey,
    WARN_MESSAGE_EDITOR_SHEET_TITLES[props.editorKey],
    'Редактор текста предупреждения',
  );
}
