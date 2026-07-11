import {
  DEFAULT_BOT_SPEECH_PREVIEW_PROFILE,
  type BotSpeechPreviewProfile,
} from '@maxim/contracts/bot-speech';

export type BotSpeechPreviewContext = BotSpeechPreviewProfile;

export const DEFAULT_BOT_SPEECH_PREVIEW_CONTEXT: BotSpeechPreviewContext = {
  ...DEFAULT_BOT_SPEECH_PREVIEW_PROFILE,
};

export function resolveBotSpeechPreviewContext(
  profile: BotSpeechPreviewProfile | null | undefined,
): BotSpeechPreviewContext {
  if (!profile) {
    return DEFAULT_BOT_SPEECH_PREVIEW_CONTEXT;
  }

  return {
    persona: profile.persona,
    characterName: profile.characterName.trim() || DEFAULT_BOT_SPEECH_PREVIEW_CONTEXT.characterName,
  };
}
