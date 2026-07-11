import { z } from 'zod';

export const BOT_SPEECH_STYLE_VALUES = ['ROBOT', 'FRIENDLY', 'POLICE', 'IRONIC'] as const;
export const botSpeechStyleSchema = z.enum(BOT_SPEECH_STYLE_VALUES);
export type BotSpeechStyle = z.infer<typeof botSpeechStyleSchema>;
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
  'textFiltersWarnMessageText',
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
  'topicExplainAnnouncement',
  'topicExplainMessage',
  'topicWarn',
  'topicMuteAnnouncement',
  'topicMuteMessage',
  'topicBan',
  'muteNotice',
  'permanentBanNotice',
  'messageLimitsWarn',
  'messageLimitsMute',
  'messageLimitsBan',
  'duplicateWarn',
  'duplicateMute',
  'duplicateBan',
  'duplicatePassiveDeleted',
  'duplicatePassiveKept',
] as const;
export type BotSpeechSystemTemplateKey = (typeof BOT_SPEECH_SYSTEM_TEMPLATE_KEYS)[number];

type BotSpeechStyleMetadata = {
  label: string;
  subtitle: string;
  description: string;
  iconKey: 'robot' | 'friendly' | 'police' | 'ironic';
};

type BotSpeechPreset = {
  editable: Record<BotSpeechEditableFieldKey, string>;
  system: Record<BotSpeechSystemTemplateKey, string>;
};

export const BOT_SPEECH_STYLE_METADATA: Record<BotSpeechStyle, BotSpeechStyleMetadata> = {
  ROBOT: {
    label: 'Робот',
    subtitle: 'цифровой модератор',
    description: 'Техно-подача: коротко, ясно, с причиной, статусом и без лишних слов.',
    iconKey: 'robot',
  },
  FRIENDLY: {
    label: 'Дружелюбный',
    subtitle: 'живой и тёплый помощник',
    description: 'Человечный тон: коротко, доброжелательно, с ясной причиной и мягкой подачей.',
    iconKey: 'friendly',
  },
  POLICE: {
    label: 'Коп',
    subtitle: 'спокойный опер',
    description: 'Взрослый тон: сухой юмор, жаргон по делу и порядок без перегиба.',
    iconKey: 'police',
  },
  IRONIC: {
    label: 'Шут',
    subtitle: 'лёгкая усмешка и умный подкол',
    description: 'Человечный тон: лёгкая ирония, взрослый юмор и короткие понятные реплики.',
    iconKey: 'ironic',
  },
};

export const BOT_SPEECH_STYLE_OPTIONS = BOT_SPEECH_STYLE_VALUES.map((style) => ({
  value: style,
  ...BOT_SPEECH_STYLE_METADATA[style],
}));

export const BOT_SPEECH_PRESETS: Record<BotSpeechStyle, BotSpeechPreset> = {
  ROBOT: {
    editable: {
      greetingBotMessageText:
        'Привет, {user}. Я {bot_character_name}. Помогу с правилами и модерацией чата.',
      linkBotMessageText: '{user}, сообщение {message_status}: {reason}.',
      linkWarnMessageText: '{user}, предупреждение: {reason}.',
      requiredSubscriptionBotMessageText:
        '{user}, сообщение {message_status}. Для отправки нужна подписка на {channels}.',
      requiredSubscriptionWarnMessageText:
        '{user}, предупреждение: {reason}. Обязательные подписки: {channels}.',
      invitationAccessBotMessageText:
        '{user}, сообщение {message_status}. Для доступа нужно пригласить {required_invites}. Прогресс: {invited_count}/{required_invites_count}; осталось {remaining_invites}.',
      invitationAccessWarnMessageText:
        '{user}, предупреждение: {reason}. Условие: {required_invites}; прогресс {invited_count}/{required_invites_count}.',
      textFiltersBotMessageText: '{user}, сообщение {message_status}: {reason}.',
      textFiltersWarnMessageText: '{user}, предупреждение: {reason}.',
      duplicateBotMessageText: '{user}, сообщение распознано как повтор. {sanction}',
      messageLimitsBotMessageText: '{user}, сообщение {message_status}: {reason}.',
      messageLimitsWarnMessageText: '{user}, предупреждение: {reason}.',
      phoneNumbersBotMessageText: '{user}, сообщение {message_status}: {reason}.',
      nightModeBotMessageText:
        '🌙 Чат закрыт по расписанию: {night_window} ({night_timezone}). {night_status}',
      nightModeOpenMessageText: '{opening_status} Обычный режим восстановлен.',
    },
    system: {
      linkEdited:
        '{user}, после редактирования обнаружена ссылка. Сообщение {message_status}: {reason}.',
      linkEditedWarn: '{user}, предупреждение: {reason}.',
      linkMute: '{user}, за повторные ссылки включён мут.',
      requiredSubscriptionMute: '{user}, за сообщения без подписки на {channels} включён мут.',
      requiredSubscriptionBan:
        '{user}, включён бан до ручного снятия. Для сообщений нужна подписка на {channels}.',
      invitationAccessMute:
        '{user}, включён мут. Для доступа осталось пригласить {remaining_invites} из {required_invites}.',
      invitationAccessBan:
        '{user}, включён бан до ручного снятия. Условие по приглашениям не выполнено.',
      textFiltersMuteCommercial: '{user}, за повторную рекламу включён мут.',
      textFiltersMuteProfanity: '{user}, за повторную грубую лексику включён мут.',
      textFiltersMuteGeneric: '{user}, за повторные нарушения текста включён мут.',
      topicExplainAnnouncement: '{user}, объявление {message_status}: {reason}.',
      topicExplainMessage: '{user}, сообщение {message_status}: {reason}.',
      topicWarn: '{user}, предупреждение: {reason}.',
      topicMuteAnnouncement: '{user}, за повторные объявления не по формату включён мут.',
      topicMuteMessage: '{user}, за повторные сообщения не по тематике включён мут.',
      topicBan: '{user}, включён бан до ручного снятия. Причина: {reason}.',
      muteNotice:
        '{user}, включён мут на {mute_duration}. До конца срока новые сообщения будут удаляться.',
      permanentBanNotice: '{user}, включён бан до ручного снятия.',
      messageLimitsWarn: '{user}, предупреждение: {reason}.',
      messageLimitsMute: '{user}, включён мут. Причина: {reason}.',
      messageLimitsBan: '{user}, включён бан до ручного снятия. Причина: {reason}.',
      duplicateWarn: 'Предупреждение за повтор зафиксировано.',
      duplicateMute: 'Включён мут на {mute_duration} за повторные сообщения.',
      duplicateBan: 'Включён бан до ручного снятия за повторные сообщения.',
      duplicatePassiveDeleted: 'Повтор удалён, дополнительной санкции нет.',
      duplicatePassiveKept: 'Повтор отмечен, дополнительной санкции нет.',
    },
  },
  FRIENDLY: {
    editable: {
      greetingBotMessageText:
        'Привет, {user} 👋 На связи {bot_character_name}. Помогу освоиться и не запутаться в правилах.',
      linkBotMessageText:
        '{user}, сообщение {message_status}: {reason}. Уберите ссылку, и всё будет в порядке.',
      linkWarnMessageText: '{user}, это предупреждение: {reason}. Дальше лучше без ссылок.',
      requiredSubscriptionBotMessageText:
        '{user}, сообщение {message_status}. Сначала подпишитесь на {channels}, и можно продолжать.',
      requiredSubscriptionWarnMessageText:
        '{user}, это предупреждение: {reason}. Нужная подписка: {channels}.',
      invitationAccessBotMessageText:
        '{user}, сообщение {message_status}. Для доступа нужно пригласить {required_invites}. Уже засчитано {invited_count}/{required_invites_count}, осталось {remaining_invites}.',
      invitationAccessWarnMessageText:
        '{user}, это предупреждение: {reason}. Нужно пригласить {required_invites}; сейчас {invited_count}/{required_invites_count}.',
      textFiltersBotMessageText:
        '{user}, сообщение {message_status}: {reason}. Давайте дальше без этого.',
      textFiltersWarnMessageText: '{user}, это предупреждение: {reason}. Давайте дальше без этого.',
      duplicateBotMessageText: '{user}, сообщение повторилось. {sanction}',
      messageLimitsBotMessageText:
        '{user}, сообщение {message_status}: {reason}. Учтите это перед следующей отправкой.',
      messageLimitsWarnMessageText: '{user}, это предупреждение: {reason}.',
      phoneNumbersBotMessageText:
        '{user}, сообщение {message_status}: {reason}. Уберите номер, и его можно отправить снова.',
      nightModeBotMessageText:
        '🌙 В чате тихий режим: {night_window} ({night_timezone}). {night_status}',
      nightModeOpenMessageText: '{opening_status} Можно снова писать.',
    },
    system: {
      linkEdited:
        '{user}, после правки в сообщении появилась ссылка. Сообщение {message_status}: {reason}.',
      linkEditedWarn: '{user}, это предупреждение: {reason}. После правки ссылки тоже учитываются.',
      linkMute: '{user}, за новые ссылки включён мут.',
      requiredSubscriptionMute:
        '{user}, за сообщения без подписки включён мут. Для доступа подпишитесь на {channels}.',
      requiredSubscriptionBan:
        '{user}, включён бан до ручного снятия. Для сообщений нужна подписка на {channels}.',
      invitationAccessMute:
        '{user}, включён мут: условие по приглашениям ещё не выполнено. Осталось пригласить {remaining_invites} из {required_invites}.',
      invitationAccessBan:
        '{user}, включён бан до ручного снятия: условие по приглашениям не выполнено.',
      textFiltersMuteCommercial: '{user}, за повторную рекламу включён мут.',
      textFiltersMuteProfanity: '{user}, за повторную грубую лексику включён мут.',
      textFiltersMuteGeneric: '{user}, за повторные нарушения текста включён мут.',
      topicExplainAnnouncement:
        '{user}, объявление {message_status}: {reason}. Исправьте формат, и можно отправить снова.',
      topicExplainMessage:
        '{user}, сообщение {message_status}: {reason}. Вернитесь к теме чата и попробуйте снова.',
      topicWarn: '{user}, это предупреждение: {reason}.',
      topicMuteAnnouncement: '{user}, за повторные объявления не по формату включён мут.',
      topicMuteMessage: '{user}, за повторные сообщения не по теме включён мут.',
      topicBan: '{user}, включён бан до ручного снятия. Причина: {reason}.',
      muteNotice:
        '{user}, мут включён на {mute_duration}. До конца срока новые сообщения будут удаляться.',
      permanentBanNotice: '{user}, включён бан до ручного снятия.',
      messageLimitsWarn: '{user}, это предупреждение: {reason}.',
      messageLimitsMute: '{user}, мут включён. Причина: {reason}.',
      messageLimitsBan: '{user}, включён бан до ручного снятия. Причина: {reason}.',
      duplicateWarn: 'Это предупреждение за повтор.',
      duplicateMute: 'За повторы включён мут на {mute_duration}.',
      duplicateBan: 'За повторы включён бан до ручного снятия.',
      duplicatePassiveDeleted: 'Повтор удалён, дополнительной санкции нет.',
      duplicatePassiveKept: 'Повтор отмечен, пока без санкции.',
    },
  },
  POLICE: {
    editable: {
      greetingBotMessageText:
        'Приветствую, {user}. На связи {bot_character_name}. Правила простые: всё фиксируется по факту, без лишнего шума.',
      linkBotMessageText:
        '{user}, ссылка зафиксирована. Сообщение {message_status}: {reason}. Без самодеятельности.',
      linkWarnMessageText:
        '{user}, предупреждение зафиксировано: {reason}. Дальше без самодеятельности.',
      requiredSubscriptionBotMessageText:
        '{user}, порядок такой: сначала подписка на {channels}. Сообщение {message_status}.',
      requiredSubscriptionWarnMessageText:
        '{user}, предупреждение зафиксировано: {reason}. Нужна подписка на {channels}.',
      invitationAccessBotMessageText:
        '{user}, условие по приглашениям не закрыто. Сообщение {message_status}. Требование: {required_invites}; по учёту {invited_count}/{required_invites_count}, осталось {remaining_invites}.',
      invitationAccessWarnMessageText:
        '{user}, предупреждение зафиксировано: {reason}. Требование: {required_invites}; по учёту {invited_count}/{required_invites_count}.',
      textFiltersBotMessageText:
        '{user}, сообщение {message_status}. Основание: {reason}. Нарушение зафиксировано.',
      textFiltersWarnMessageText:
        '{user}, предупреждение зафиксировано. Основание: {reason}. Дальше без лишнего шума.',
      duplicateBotMessageText: '{user}, повтор зафиксирован. {sanction}',
      messageLimitsBotMessageText:
        '{user}, сообщение {message_status}. Основание: {reason}. Не усугубляйте.',
      messageLimitsWarnMessageText: '{user}, предупреждение зафиксировано. Основание: {reason}.',
      phoneNumbersBotMessageText:
        '{user}, сообщение {message_status}. Основание: {reason}. Номер из текста лучше убрать.',
      nightModeBotMessageText:
        '🌙 Ночной режим действует: {night_window} ({night_timezone}). {night_status} До открытия без самодеятельности.',
      nightModeOpenMessageText: '{opening_status} Работаем в обычном режиме, без самодеятельности.',
    },
    system: {
      linkEdited:
        '{user}, ссылка добавлена при редактировании. Сообщение {message_status}: {reason}. Манёвр зафиксирован.',
      linkEditedWarn:
        '{user}, предупреждение зафиксировано: {reason}. Тихая правка правила не отменяет.',
      linkMute: '{user}, повторные ссылки зафиксированы. Включён мут.',
      requiredSubscriptionMute:
        '{user}, сообщения без подписки на {channels} повторились. Включён мут.',
      requiredSubscriptionBan:
        '{user}, мера усилена: бан до ручного снятия. Для сообщений нужна подписка на {channels}.',
      invitationAccessMute:
        '{user}, условие по приглашениям не закрыто. Включён мут; осталось пригласить {remaining_invites} из {required_invites}.',
      invitationAccessBan:
        '{user}, условие по приглашениям не выполнено. Включён бан до ручного снятия.',
      textFiltersMuteCommercial: '{user}, повторная реклама зафиксирована. Включён мут.',
      textFiltersMuteProfanity: '{user}, повторная грубая лексика зафиксирована. Включён мут.',
      textFiltersMuteGeneric: '{user}, серия текстовых нарушений зафиксирована. Включён мут.',
      topicExplainAnnouncement:
        '{user}, объявление {message_status}. Основание: {reason}. Исправьте по форме и отправьте снова.',
      topicExplainMessage:
        '{user}, сообщение {message_status}. Основание: {reason}. Держитесь темы чата.',
      topicWarn: '{user}, предупреждение зафиксировано. Основание: {reason}.',
      topicMuteAnnouncement: '{user}, повторные объявления не по форме. Включён мут.',
      topicMuteMessage: '{user}, повторные сообщения не по теме. Включён мут.',
      topicBan:
        '{user}, по материалам повторных нарушений включён бан до ручного снятия. Основание: {reason}.',
      muteNotice:
        '{user}, оформлен мут на {mute_duration}. До конца срока новые сообщения будут удаляться.',
      permanentBanNotice: '{user}, оформлен бан до ручного снятия.',
      messageLimitsWarn: '{user}, предупреждение зафиксировано. Основание: {reason}.',
      messageLimitsMute:
        '{user}, нарушение ограничения зафиксировано. Включён мут. Основание: {reason}.',
      messageLimitsBan: '{user}, оформлен бан до ручного снятия. Основание: {reason}.',
      duplicateWarn: 'Предупреждение за повтор зафиксировано.',
      duplicateMute: 'За повторные сообщения оформлен мут на {mute_duration}.',
      duplicateBan: 'За повторные сообщения оформлен бан до ручного снятия.',
      duplicatePassiveDeleted: 'Повтор удалён. Профилактика сработала.',
      duplicatePassiveKept: 'Повтор отмечен, пока без санкции.',
    },
  },
  IRONIC: {
    editable: {
      greetingBotMessageText:
        'Привет, {user}. На связи {bot_character_name}. Правила не кусаются, пока их не проверяют на прочность.',
      linkBotMessageText:
        '{user}, ссылка решила пройти без пропуска. Сообщение {message_status}: {reason}.',
      linkWarnMessageText:
        '{user}, предупреждение: {reason}. У ссылок здесь стабильно не складывается.',
      requiredSubscriptionBotMessageText:
        '{user}, сообщение {message_status}. Сначала подписка на {channels}; формальность короткая, но обязательная.',
      requiredSubscriptionWarnMessageText:
        '{user}, предупреждение: {reason}. Подписка на {channels} всё ещё обязательна.',
      invitationAccessBotMessageText:
        '{user}, сообщение {message_status}. Для доступа нужно пригласить {required_invites}: сейчас {invited_count}/{required_invites_count}, осталось {remaining_invites}. Счётчик к обаянию равнодушен.',
      invitationAccessWarnMessageText:
        '{user}, предупреждение: {reason}. Нужно пригласить {required_invites}; сейчас {invited_count}/{required_invites_count}.',
      textFiltersBotMessageText:
        '{user}, сообщение {message_status}: {reason}. Правило оказалось не декоративным.',
      textFiltersWarnMessageText:
        '{user}, предупреждение: {reason}. Харизма харизмой, а правила на месте.',
      duplicateBotMessageText: '{user}, сообщение вышло на бис. {sanction}',
      messageLimitsBotMessageText:
        '{user}, сообщение {message_status}: {reason}. Настройка оказалась не декоративной.',
      messageLimitsWarnMessageText:
        '{user}, предупреждение: {reason}. Настройки чата спорить не любят.',
      phoneNumbersBotMessageText:
        '{user}, сообщение {message_status}: {reason}. Номер телефона в этот выпуск не прошёл.',
      nightModeBotMessageText:
        '🌙 Чат взял паузу: {night_window} ({night_timezone}). {night_status} Даже ленте иногда нужен сон.',
      nightModeOpenMessageText: '{opening_status} Лента снова принимает реплики.',
    },
    system: {
      linkEdited:
        '{user}, ссылка появилась уже после правки. Сообщение {message_status}: {reason}. Тихий вход не удался.',
      linkEditedWarn:
        '{user}, предупреждение: {reason}. Редактирование не выдаёт ссылкам невидимость.',
      linkMute: '{user}, за повторные ссылки включён мут. Ссылочный марафон на паузе.',
      requiredSubscriptionMute:
        '{user}, за сообщения без подписки на {channels} включён мут. Формальность всё-таки победила.',
      requiredSubscriptionBan:
        '{user}, включён бан до ручного снятия. Для сообщений нужна подписка на {channels}.',
      invitationAccessMute:
        '{user}, условие по приглашениям не выполнено, поэтому включён мут. Осталось пригласить {remaining_invites} из {required_invites}.',
      invitationAccessBan:
        '{user}, включён бан до ручного снятия: условие по приглашениям не выполнено.',
      textFiltersMuteCommercial:
        '{user}, за повторную рекламу включён мут. Рекламная пауза затянулась.',
      textFiltersMuteProfanity:
        '{user}, за повторную грубую лексику включён мут. Словарь ушёл на перерыв.',
      textFiltersMuteGeneric:
        '{user}, за повторные нарушения текста включён мут. Спор с правилами окончен.',
      topicExplainAnnouncement:
        '{user}, объявление {message_status}: {reason}. Формат оказался не декоративным.',
      topicExplainMessage:
        '{user}, сообщение {message_status}: {reason}. Тема чата всё-таки была подсказкой.',
      topicWarn: '{user}, предупреждение: {reason}. Правило всё ещё действует.',
      topicMuteAnnouncement:
        '{user}, за повторные объявления не по формату включён мут. Форма взяла реванш.',
      topicMuteMessage: '{user}, за повторные сообщения не по теме включён мут. Тема взяла реванш.',
      topicBan: '{user}, включён бан до ручного снятия. Причина: {reason}.',
      muteNotice:
        '{user}, мут включён на {mute_duration}. До конца срока новые сообщения будут удаляться. Пауза сейчас полезнее продолжения.',
      permanentBanNotice: '{user}, включён бан до ручного снятия.',
      messageLimitsWarn: '{user}, предупреждение: {reason}. Настройки чата спорить не любят.',
      messageLimitsMute:
        '{user}, включён мут. Причина: {reason}. Настройки проверены на прочность.',
      messageLimitsBan: '{user}, включён бан до ручного снятия. Причина: {reason}.',
      duplicateWarn: 'Предупреждение за повтор. Второй экземпляр убедительнее не стал.',
      duplicateMute: 'За повторы включён мут на {mute_duration}. Бис затянулся.',
      duplicateBan: 'За повторные сообщения включён бан до ручного снятия.',
      duplicatePassiveDeleted: 'Повтор удалён. На бис сегодня без аншлага.',
      duplicatePassiveKept: 'Повтор отмечен, пока без санкции.',
    },
  },
};

export function resolveBotSpeechStyle(style: BotSpeechStyle | null | undefined): BotSpeechStyle {
  return style ?? 'POLICE';
}

export function resolveBotSpeechPersona(
  persona: BotSpeechPersona | null | undefined,
): BotSpeechPersona {
  return persona ?? 'male';
}

function resolveBotSpeechPreset(
  style: BotSpeechStyle | null | undefined,
  _persona: BotSpeechPersona | null | undefined,
): BotSpeechPreset {
  return BOT_SPEECH_PRESETS[resolveBotSpeechStyle(style)];
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

export function getBotSpeechEditableTemplate(
  style: BotSpeechStyle | null | undefined,
  fieldKey: BotSpeechEditableFieldKey,
  persona?: BotSpeechPersona | null,
): string {
  return resolveBotSpeechPreset(style, persona).editable[fieldKey];
}

export function getBotSpeechSystemTemplate(
  style: BotSpeechStyle | null | undefined,
  templateKey: BotSpeechSystemTemplateKey,
  persona?: BotSpeechPersona | null,
): string {
  return resolveBotSpeechPreset(style, persona).system[templateKey];
}
