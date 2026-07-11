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
        'Привет, {user}. Я {bot_character_name}. Подскажу правила и помогу освоиться в чате.',
      linkBotMessageText: '{user}, сообщение {message_status}: {reason}.',
      linkWarnMessageText: '{user}, предупреждение: {reason}.',
      requiredSubscriptionBotMessageText:
        '{user}, сообщение {message_status}. Для отправки нужна подписка на {channels}.',
      requiredSubscriptionWarnMessageText:
        '{user}, предупреждение: {reason}. Подпишитесь на {channels}.',
      invitationAccessBotMessageText:
        '{user}, сообщение {message_status}. Чтобы писать в чат, нужно пригласить {required_invites}. Прогресс: {invited_count}/{required_invites_count}; осталось пригласить {remaining_invites}.',
      invitationAccessWarnMessageText:
        '{user}, предупреждение: {reason}. Нужно пригласить {required_invites}; прогресс: {invited_count}/{required_invites_count}.',
      textFiltersBotMessageText: '{user}, сообщение {message_status}: {reason}.',
      textFiltersWarnMessageText: '{user}, предупреждение: {reason}.',
      duplicateBotMessageText: '{user}, сообщение распознано как повтор. {sanction}',
      messageLimitsBotMessageText: '{user}, сообщение {message_status}: {reason}.',
      messageLimitsWarnMessageText: '{user}, предупреждение: {reason}.',
      phoneNumbersBotMessageText: '{user}, сообщение {message_status}: {reason}.',
      nightModeBotMessageText:
        '🌙 Чат закрыт по расписанию: {night_window} ({night_timezone}). {night_status}',
      nightModeOpenMessageText: '{opening_status} Можно отправлять сообщения.',
    },
    system: {
      linkEdited: '{user}, сообщение {message_status}: {reason}.',
      linkEditedWarn: '{user}, предупреждение: {reason}.',
      linkMute: '{user}, за запрещённую ссылку включён мут.',
      requiredSubscriptionMute: '{user}, за сообщения без подписки на {channels} включён мут.',
      requiredSubscriptionBan:
        '{user}, включён бан до ручного снятия. Для сообщений нужна подписка на {channels}.',
      invitationAccessMute:
        '{user}, включён мут. Нужно пригласить {required_invites}; осталось пригласить {remaining_invites}.',
      invitationAccessBan:
        '{user}, включён бан до ручного снятия. Условие по приглашениям не выполнено.',
      textFiltersMuteCommercial: '{user}, за повторную рекламу включён мут.',
      textFiltersMuteProfanity: '{user}, за повторную грубую лексику включён мут.',
      textFiltersMuteGeneric: '{user}, за повторные нарушения текстовых правил включён мут.',
      topicExplainAnnouncement: '{user}, объявление {message_status}: {reason}.',
      topicExplainMessage: '{user}, сообщение {message_status}: {reason}.',
      topicWarn: '{user}, предупреждение: {reason}.',
      topicMuteAnnouncement: '{user}, за повторные объявления не по формату включён мут.',
      topicMuteMessage: '{user}, за повторные сообщения не по теме включён мут.',
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
        '{user}, сообщение {message_status}: {reason}. В следующих сообщениях учитывайте правила для ссылок.',
      linkWarnMessageText:
        '{user}, это предупреждение: {reason}. Дальше учитывайте правила для ссылок.',
      requiredSubscriptionBotMessageText:
        '{user}, сообщение {message_status}. Чтобы писать в чат, подпишитесь на {channels}.',
      requiredSubscriptionWarnMessageText:
        '{user}, это предупреждение: {reason}. Подпишитесь на {channels}.',
      invitationAccessBotMessageText:
        '{user}, сообщение {message_status}. Чтобы писать в чат, нужно пригласить {required_invites}. Уже засчитано {invited_count}/{required_invites_count}; осталось пригласить {remaining_invites}.',
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
        '{user}, сообщение {message_status}: {reason}. В следующих сообщениях не указывайте номер телефона.',
      nightModeBotMessageText:
        '🌙 В чате тихий режим: {night_window} ({night_timezone}). {night_status}',
      nightModeOpenMessageText: '{opening_status} Можно снова писать.',
    },
    system: {
      linkEdited:
        '{user}, сообщение {message_status}: {reason}. Правила для ссылок действуют и после редактирования.',
      linkEditedWarn:
        '{user}, это предупреждение: {reason}. Правила для ссылок действуют и после редактирования.',
      linkMute: '{user}, из-за нарушения правил для ссылок пришлось включить мут.',
      requiredSubscriptionMute:
        '{user}, за сообщения без подписки включён мут. Чтобы писать после его окончания, подпишитесь на {channels}.',
      requiredSubscriptionBan:
        '{user}, включён бан до ручного снятия. Для сообщений нужна подписка на {channels}.',
      invitationAccessMute:
        '{user}, мут включён: приглашений пока недостаточно. Нужно пригласить {required_invites}; осталось пригласить {remaining_invites}.',
      invitationAccessBan:
        '{user}, включён бан до ручного снятия: условие по приглашениям не выполнено.',
      textFiltersMuteCommercial: '{user}, за повторную рекламу включён мут.',
      textFiltersMuteProfanity: '{user}, за повторную грубую лексику включён мут.',
      textFiltersMuteGeneric:
        '{user}, из-за повторных нарушений текстовых правил пришлось включить мут.',
      topicExplainAnnouncement:
        '{user}, объявление {message_status}: {reason}. В следующих объявлениях соблюдайте этот формат.',
      topicExplainMessage:
        '{user}, сообщение {message_status}: {reason}. В следующих сообщениях придерживайтесь темы чата.',
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
        'Приветствую, {user}. На связи {bot_character_name}. Здесь всё просто: соблюдаем правила, остальное разберём по факту.',
      linkBotMessageText:
        '{user}, сообщение {message_status}: {reason}. Без самодеятельности.',
      linkWarnMessageText:
        '{user}, предупреждение зафиксировано: {reason}. Дальше без запрещённых ссылок.',
      requiredSubscriptionBotMessageText:
        '{user}, сообщение {message_status}. Порядок такой: сначала подписка на {channels}.',
      requiredSubscriptionWarnMessageText:
        '{user}, предупреждение зафиксировано: {reason}. Нужна подписка на {channels}.',
      invitationAccessBotMessageText:
        '{user}, доступ по приглашениям пока не открыт. Сообщение {message_status}. Нужно пригласить {required_invites}; засчитано {invited_count}/{required_invites_count}, осталось пригласить {remaining_invites}.',
      invitationAccessWarnMessageText:
        '{user}, предупреждение зафиксировано: {reason}. Нужно пригласить {required_invites}; засчитано {invited_count}/{required_invites_count}.',
      textFiltersBotMessageText:
        '{user}, сообщение {message_status}: {reason}. Дальше держимся правил.',
      textFiltersWarnMessageText:
        '{user}, предупреждение зафиксировано: {reason}. Повторять не стоит.',
      duplicateBotMessageText: '{user}, повтор зафиксирован. {sanction}',
      messageLimitsBotMessageText:
        '{user}, сообщение {message_status}: {reason}. При следующей отправке учтите ограничение.',
      messageLimitsWarnMessageText: '{user}, предупреждение зафиксировано. Основание: {reason}.',
      phoneNumbersBotMessageText:
        '{user}, сообщение {message_status}: {reason}. Дальше без номера в тексте.',
      nightModeBotMessageText:
        '🌙 Ночной режим: {night_window} ({night_timezone}). {night_status} Всё по графику.',
      nightModeOpenMessageText: '{opening_status} Возвращаемся к обычному режиму.',
    },
    system: {
      linkEdited:
        '{user}, сообщение {message_status}: {reason}. Правка правила не отменяет.',
      linkEditedWarn:
        '{user}, предупреждение зафиксировано: {reason}. Правка правила не отменяет.',
      linkMute: '{user}, за запрещённую ссылку включён мут.',
      requiredSubscriptionMute:
        '{user}, сообщения без подписки на {channels} повторились. Включён мут.',
      requiredSubscriptionBan:
        '{user}, подписка на {channels} не подтверждена. Включён бан до ручного снятия.',
      invitationAccessMute:
        '{user}, условие по приглашениям не выполнено. Включён мут. Нужно пригласить {required_invites}; осталось пригласить {remaining_invites}.',
      invitationAccessBan:
        '{user}, условие по приглашениям не выполнено. Включён бан до ручного снятия.',
      textFiltersMuteCommercial: '{user}, повторная реклама зафиксирована. Включён мут.',
      textFiltersMuteProfanity: '{user}, повторная грубая лексика зафиксирована. Включён мут.',
      textFiltersMuteGeneric: '{user}, серия текстовых нарушений зафиксирована. Включён мут.',
      topicExplainAnnouncement:
        '{user}, объявление {message_status}. Основание: {reason}. Исправьте по форме и отправьте снова.',
      topicExplainMessage:
        '{user}, сообщение {message_status}: {reason}. Разговор возвращаем в русло.',
      topicWarn: '{user}, предупреждение зафиксировано. Основание: {reason}.',
      topicMuteAnnouncement: '{user}, повторные объявления не по форме. Включён мут.',
      topicMuteMessage: '{user}, повторные сообщения не по теме. Включён мут.',
      topicBan:
        '{user}, по материалам повторных нарушений включён бан до ручного снятия. Основание: {reason}.',
      muteNotice:
        '{user}, мут включён на {mute_duration}. До конца срока новые сообщения будут удаляться.',
      permanentBanNotice: '{user}, бан включён до ручного снятия.',
      messageLimitsWarn: '{user}, предупреждение зафиксировано. Основание: {reason}.',
      messageLimitsMute:
        '{user}, включён мут. Основание: {reason}.',
      messageLimitsBan: '{user}, бан включён до ручного снятия. Основание: {reason}.',
      duplicateWarn: 'Предупреждение за повтор зафиксировано.',
      duplicateMute: 'За повторные сообщения включён мут на {mute_duration}.',
      duplicateBan: 'За повторные сообщения включён бан до ручного снятия.',
      duplicatePassiveDeleted: 'Повтор удалён. Профилактика сработала.',
      duplicatePassiveKept: 'Повтор отмечен, пока без санкции.',
    },
  },
  IRONIC: {
    editable: {
      greetingBotMessageText:
        'Привет, {user}. На связи {bot_character_name}. У правил здесь хорошая память, а у меня короткие комментарии.',
      linkBotMessageText:
        '{user}, ссылка решила пройти без пропуска. Сообщение {message_status}: {reason}.',
      linkWarnMessageText:
        '{user}, предупреждение: {reason}. У этой ссылки не сложилось с допуском.',
      requiredSubscriptionBotMessageText:
        '{user}, сообщение {message_status}. Сначала подпишитесь на {channels}: это короткий, но обязательный пункт программы.',
      requiredSubscriptionWarnMessageText:
        '{user}, предупреждение: {reason}. Подписка на {channels} — тот самый входной билет.',
      invitationAccessBotMessageText:
        '{user}, сообщение {message_status}. Для доступа нужно пригласить {required_invites}: сейчас {invited_count}/{required_invites_count}, осталось пригласить {remaining_invites}. Счётчик принимает только приглашения.',
      invitationAccessWarnMessageText:
        '{user}, предупреждение: {reason}. Нужно пригласить {required_invites}; сейчас {invited_count}/{required_invites_count}. Арифметика здесь без творческих трактовок.',
      textFiltersBotMessageText:
        '{user}, сообщение {message_status}: {reason}. Фильтр сработал без художественных допущений.',
      textFiltersWarnMessageText:
        '{user}, предупреждение: {reason}. Текст проверил фильтр на прочность; фильтр справился.',
      duplicateBotMessageText: '{user}, сообщение вышло на бис. {sanction}',
      messageLimitsBotMessageText:
        '{user}, сообщение {message_status}: {reason}. Настройки не считают себя рекомендациями.',
      messageLimitsWarnMessageText:
        '{user}, предупреждение: {reason}. У ограничений чата всё довольно буквально.',
      phoneNumbersBotMessageText:
        '{user}, сообщение {message_status}: {reason}. Номер выбрал не тот чат.',
      nightModeBotMessageText:
        '🌙 Чат взял паузу: {night_window} ({night_timezone}). {night_status} Даже ленте иногда нужен сон.',
      nightModeOpenMessageText: '{opening_status} Лента снова принимает реплики.',
    },
    system: {
      linkEdited:
        '{user}, сообщение {message_status}: {reason}. После правки правила не теряют память.',
      linkEditedWarn:
        '{user}, предупреждение: {reason}. После редактирования ссылка невидимкой не становится.',
      linkMute: '{user}, за запрещённую ссылку включён мут. Переход временно закрыт.',
      requiredSubscriptionMute:
        '{user}, за сообщения без подписки на {channels} включён мут. Входной билет всё-таки понадобился.',
      requiredSubscriptionBan:
        '{user}, включён бан до ручного снятия. Для сообщений нужна подписка на {channels}.',
      invitationAccessMute:
        '{user}, условие по приглашениям не выполнено, поэтому включён мут. Нужно пригласить {required_invites}; осталось пригласить {remaining_invites}.',
      invitationAccessBan:
        '{user}, включён бан до ручного снятия: условие по приглашениям не выполнено.',
      textFiltersMuteCommercial:
        '{user}, за повторную рекламу включён мут. Рекламная пауза затянулась.',
      textFiltersMuteProfanity:
        '{user}, за повторную грубую лексику включён мут. Словарь ушёл на перерыв.',
      textFiltersMuteGeneric:
        '{user}, за повторные нарушения текстовых правил включён мут. Текстовый эксперимент поставлен на паузу.',
      topicExplainAnnouncement:
        '{user}, объявление {message_status}: {reason}. Кодовое слово здесь не для атмосферы.',
      topicExplainMessage:
        '{user}, сообщение {message_status}: {reason}. Тема чата всё-таки была подсказкой.',
      topicWarn: '{user}, предупреждение: {reason}. Импровизация не отменяет правила.',
      topicMuteAnnouncement:
        '{user}, за повторные объявления не по формату включён мут. Импровизация берёт паузу.',
      topicMuteMessage:
        '{user}, за повторные сообщения не по теме включён мут. Побочная сюжетная линия поставлена на паузу.',
      topicBan: '{user}, включён бан до ручного снятия. Причина: {reason}.',
      muteNotice:
        '{user}, мут включён на {mute_duration}. До конца срока новые сообщения будут удаляться.',
      permanentBanNotice: '{user}, включён бан до ручного снятия.',
      messageLimitsWarn:
        '{user}, предупреждение: {reason}. У ограничений чата всё довольно буквально.',
      messageLimitsMute:
        '{user}, включён мут. Причина: {reason}. Ограничение перешло от слов к делу.',
      messageLimitsBan: '{user}, включён бан до ручного снятия. Причина: {reason}.',
      duplicateWarn: 'Предупреждение за повтор.',
      duplicateMute: 'За повторы включён мут на {mute_duration}.',
      duplicateBan: 'За повторные сообщения включён бан до ручного снятия.',
      duplicatePassiveDeleted: 'Повтор удалён.',
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
