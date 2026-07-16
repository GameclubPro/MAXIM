import {
  getBotSpeechEditableTemplate,
  getBotSpeechSystemTemplate,
  type BotSpeechEditableFieldKey,
  type BotSpeechStyle,
  type BotSpeechSystemTemplateKey,
} from '@maxim/contracts/bot-speech';
import {
  DEFAULT_BOT_SPEECH_PREVIEW_CONTEXT,
  type BotSpeechPreviewContext,
} from './bot-speech-preview-context';

export type SpeechStylePreviewSamples = {
  greeting: string;
  explanation: string;
  warning: string;
  mute: string;
  ban: string;
};

function getEditableTemplate(
  style: BotSpeechStyle,
  fieldKey: BotSpeechEditableFieldKey,
  previewContext: BotSpeechPreviewContext,
): string {
  return getBotSpeechEditableTemplate(style, fieldKey, previewContext.persona);
}

function getSystemTemplate(
  style: BotSpeechStyle,
  templateKey: BotSpeechSystemTemplateKey,
  previewContext: BotSpeechPreviewContext,
): string {
  return getBotSpeechSystemTemplate(style, templateKey, previewContext.persona);
}

function renderPreview(
  templateText: string,
  replacements: Record<string, string>,
  previewContext: BotSpeechPreviewContext,
): string {
  let rendered = templateText;
  const mergedReplacements: Record<string, string> = {
    bot_character_name: previewContext.characterName,
    ...replacements,
  };
  for (const [key, value] of Object.entries(mergedReplacements)) {
    rendered = rendered.split(`{${key}}`).join(value);
  }

  return rendered;
}

export function buildSpeechStylePreviewSamples(
  style: BotSpeechStyle,
  previewContext: BotSpeechPreviewContext = DEFAULT_BOT_SPEECH_PREVIEW_CONTEXT,
): SpeechStylePreviewSamples {
  return {
    greeting: renderPreview(
      getEditableTemplate(style, 'greetingBotMessageText', previewContext),
      {
        user: 'Алексей',
        greeting: 'добро пожаловать в чат',
      },
      previewContext,
    ),
    explanation: renderPreview(
      getEditableTemplate(style, 'linkBotMessageText', previewContext),
      {
        user: 'Алексей',
        message_status: 'удалено',
        reason: 'эта ссылка запрещена настройками чата',
      },
      previewContext,
    ),
    warning: renderPreview(
      getEditableTemplate(style, 'textFiltersWarnMessageText', previewContext),
      {
        user: 'Алексей',
        warning: 'предупреждение за грубую лексику',
        reason: 'грубая лексика запрещена правилами чата',
      },
      previewContext,
    ),
    mute: renderPreview(
      getSystemTemplate(style, 'muteNotice', previewContext),
      {
        user: 'Алексей',
        mute_duration: '24 часа',
        ban_duration: '24 часа',
      },
      previewContext,
    ),
    ban: renderPreview(
      getSystemTemplate(style, 'permanentBanNotice', previewContext),
      { user: 'Алексей' },
      previewContext,
    ),
  };
}
