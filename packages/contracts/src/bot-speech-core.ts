import { z } from 'zod';

export const BOT_SPEECH_STYLE_VALUES = ['ROBOT', 'FRIENDLY', 'POLICE', 'IRONIC'] as const;
export const botSpeechStyleSchema = z.enum(BOT_SPEECH_STYLE_VALUES);
export type BotSpeechStyle = z.infer<typeof botSpeechStyleSchema>;
export const updateBotSpeechStyleRequestSchema = z
  .object({ botSpeechStyle: botSpeechStyleSchema })
  .strict();
export type UpdateBotSpeechStyleRequest = z.infer<typeof updateBotSpeechStyleRequestSchema>;
export const updateBotSpeechStyleResponseSchema = z
  .object({ botSpeechStyle: botSpeechStyleSchema, settingsRevision: z.string().datetime() })
  .strict();
export type UpdateBotSpeechStyleResponse = z.infer<typeof updateBotSpeechStyleResponseSchema>;
export const BOT_SPEECH_PERSONA_VALUES = ['male', 'female', 'neutral'] as const;
export const botSpeechPersonaSchema = z.enum(BOT_SPEECH_PERSONA_VALUES);
export type BotSpeechPersona = z.infer<typeof botSpeechPersonaSchema>;
export const botSpeechPreviewProfileSchema = z.object({
  persona: botSpeechPersonaSchema,
  characterName: z.string().trim().min(1).max(128),
});
export type BotSpeechPreviewProfile = z.infer<typeof botSpeechPreviewProfileSchema>;
export const DEFAULT_BOT_SPEECH_PREVIEW_PROFILE: BotSpeechPreviewProfile = {
  persona: 'neutral',
  characterName: 'Чат-бот',
};

export const BOT_SPEECH_EDITABLE_FIELD_KEYS = [
  'greetingBotMessageText',
  'linkBotMessageText',
  'linkWarnMessageText',
  'requiredSubscriptionBotMessageText',
  'requiredSubscriptionWarnMessageText',
  'invitationAccessBotMessageText',
  'invitationAccessWarnMessageText',
  'textFiltersBotMessageText',
  'profanityBotMessageText',
  'textFiltersWarnMessageText',
  'profanityWarnMessageText',
  'duplicateBotMessageText',
  'messageLimitsBotMessageText',
  'messageLimitsWarnMessageText',
  'phoneNumbersBotMessageText',
  'nightModeBotMessageText',
  'nightModeOpenMessageText',
] as const;
export type BotSpeechEditableFieldKey = (typeof BOT_SPEECH_EDITABLE_FIELD_KEYS)[number];
export type BotSpeechSettingsSubset = {
  botSpeechStyle: BotSpeechStyle | null;
} & Record<BotSpeechEditableFieldKey, string>;

export type BotSpeechMediaFieldKey = BotSpeechEditableFieldKey;

export const BOT_SPEECH_SYSTEM_TEMPLATE_KEYS = [
  'linkEdited',
  'linkEditedWarn',
  'linkMute',
  'requiredSubscriptionMute',
  'requiredSubscriptionBan',
  'invitationAccessMute',
  'invitationAccessBan',
  'textFiltersMuteCommercial',
  'textFiltersMuteProfanity',
  'textFiltersMuteGeneric',
  'muteNotice',
  'permanentBanNotice',
  'messageLimitsWarn',
  'messageLimitsMute',
  'messageLimitsBan',
  'duplicatePhoto',
  'duplicateAlbum',
  'duplicateWarn',
  'duplicateMute',
  'duplicateBan',
  'duplicatePassiveDeleted',
  'duplicatePassiveKept',
] as const;
export type BotSpeechSystemTemplateKey = (typeof BOT_SPEECH_SYSTEM_TEMPLATE_KEYS)[number];

type BotSpeechStyleMetadata = {
  label: string;
  shortLabel: string;
  subtitle: string;
  description: string;
  iconKey: 'robot' | 'friendly' | 'police' | 'ironic';
};

export const BOT_SPEECH_STYLE_METADATA: Record<BotSpeechStyle, BotSpeechStyleMetadata> = {
  ROBOT: {
    label: 'Робот',
    shortLabel: 'Робот',
    subtitle: 'спокойно и по существу',
    description: 'Коротко и точно: что произошло и что делать дальше.',
    iconKey: 'robot',
  },
  FRIENDLY: {
    label: 'Дружелюбный',
    shortLabel: 'Друг',
    subtitle: 'тепло и с уважением',
    description: 'Вежливо, тепло и на «вы». Подсказывает, как продолжить общение.',
    iconKey: 'friendly',
  },
  POLICE: {
    label: 'Коп',
    shortLabel: 'Коп',
    subtitle: 'порядок с сухим юмором',
    description: 'Спокойный дежурный с сухим юмором. Короткие объяснения и шутки про бюрократию.',
    iconKey: 'police',
  },
  IRONIC: {
    label: 'Шут',
    shortLabel: 'Шут',
    subtitle: 'иронично, с характером',
    description: 'Живой язык, бытовой юмор и ирония по делу.',
    iconKey: 'ironic',
  },
};

export const BOT_SPEECH_STYLE_OPTIONS = BOT_SPEECH_STYLE_VALUES.map((style) => ({
  value: style,
  ...BOT_SPEECH_STYLE_METADATA[style],
}));

export function resolveBotSpeechStyle(style: BotSpeechStyle | null | undefined): BotSpeechStyle {
  return style ?? 'POLICE';
}

export function resolveBotSpeechPersona(
  persona: BotSpeechPersona | null | undefined,
): BotSpeechPersona {
  return persona ?? 'male';
}

export function hasBotSpeechEditableOverrides(settings: BotSpeechSettingsSubset): boolean {
  return BOT_SPEECH_EDITABLE_FIELD_KEYS.some((key) => hasCustomBotSpeechText(settings[key]));
}

export function hasCustomBotSpeechText(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.length > 0;
}

export function applyBotSpeechStylePreset<T extends BotSpeechSettingsSubset>(
  settings: T,
  style: BotSpeechStyle,
): T {
  return {
    ...settings,
    botSpeechStyle: style,
  };
}
