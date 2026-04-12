import { z } from 'zod';

export const BOT_SPEECH_STYLE_VALUES = ['ROBOT', 'FRIENDLY', 'POLICE', 'IRONIC'] as const;
export const botSpeechStyleSchema = z.enum(BOT_SPEECH_STYLE_VALUES);
export type BotSpeechStyle = z.infer<typeof botSpeechStyleSchema>;
export const BOT_SPEECH_PERSONA_VALUES = ['male', 'female', 'neutral'] as const;
export const botSpeechPersonaSchema = z.enum(BOT_SPEECH_PERSONA_VALUES);
export type BotSpeechPersona = z.infer<typeof botSpeechPersonaSchema>;

export const BOT_SPEECH_EDITABLE_FIELD_KEYS = [
  'greetingBotMessageText',
  'linkBotMessageText',
  'linkWarnMessageText',
  'requiredSubscriptionBotMessageText',
  'requiredSubscriptionWarnMessageText',
  'textFiltersBotMessageText',
  'textFiltersWarnMessageText',
  'duplicateBotMessageText',
  'messageLimitsBotMessageText',
  'nightModeBotMessageText',
  'nightModeOpenMessageText',
] as const;
export type BotSpeechEditableFieldKey = (typeof BOT_SPEECH_EDITABLE_FIELD_KEYS)[number];
export type BotSpeechSettingsSubset = {
  botSpeechStyle: BotSpeechStyle | null;
} & Record<BotSpeechEditableFieldKey, string>;

export const BOT_SPEECH_SYSTEM_TEMPLATE_KEYS = [
  'linkMute',
  'requiredSubscriptionMute',
  'requiredSubscriptionBan',
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
  'messageLimitsWarn',
  'messageLimitsMute',
  'messageLimitsBan',
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
    subtitle: 'безличная система',
    description: 'Короткий процедурный тон с понятным основанием и результатом.',
    iconKey: 'robot',
  },
  FRIENDLY: {
    label: 'Дружелюбный',
    subtitle: 'поддерживающий собеседник',
    description: 'Спокойный поддерживающий тон с ясной причиной и следующим шагом.',
    iconKey: 'friendly',
  },
  POLICE: {
    label: 'Полицейский',
    subtitle: 'строгий персонаж с ролью',
    description: 'Служебная ролевая подача: строго, собранно и без лишней клоунады.',
    iconKey: 'police',
  },
  IRONIC: {
    label: 'Ироничный',
    subtitle: 'умный наблюдатель с сухими комментариями',
    description: 'Сдержанная сухая ирония без хамства, унижения и перегиба.',
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
        'Система: {user}. Доступ подтвержден. Активный модератор: {bot_character_name}.',
      linkBotMessageText: 'Система: {user}. Ссылка удалена. Основание: {reason}.',
      linkWarnMessageText:
        'Система: {user}. Предупреждение зарегистрировано. Повторная отправка ссылок запрещена.',
      requiredSubscriptionBotMessageText:
        'Система: {user}. Для отправки сообщений требуется подписка на {channels}. Выполните подписку и повторите отправку. Текущий статус: {message_status}.',
      requiredSubscriptionWarnMessageText:
        'Система: {user}. Предупреждение зарегистрировано. Для отправки сообщений по-прежнему требуется подписка на {channels}. Причина: {reason}.',
      textFiltersBotMessageText: 'Система: {user}. Сообщение удалено. Основание: {reason}.',
      textFiltersWarnMessageText:
        'Система: {user}. Предупреждение зарегистрировано. Основание: {reason}.',
      duplicateBotMessageText: 'Система: {user}. Повтор сообщения подтвержден. {sanction}',
      messageLimitsBotMessageText: 'Система: {user}. Сообщение отклонено. Основание: {reason}.',
      nightModeBotMessageText:
        'Система: активен ночной режим. Период: {night_window} ({night_timezone}). {night_status}',
      nightModeOpenMessageText: 'Система: ночной режим завершен. {opening_status}',
    },
    system: {
      linkMute: 'Система: {user}. Выдан мут за повторную отправку ссылок.',
      requiredSubscriptionMute:
        'Система: {user}. Выдан мут за повторные сообщения без подписки на {channels}.',
      requiredSubscriptionBan:
        'Система: {user}. Выдан бан до ручного снятия. Для отправки сообщений требуется подписка на {channels}.',
      textFiltersMuteCommercial: 'Система: {user}. Выдан мут за повторную коммерческую рекламу.',
      textFiltersMuteProfanity: 'Система: {user}. Выдан мут за повторную грубую лексику.',
      textFiltersMuteGeneric: 'Система: {user}. Выдан мут за повторные текстовые нарушения.',
      topicExplainAnnouncement: 'Система: {user}. Объявление отклонено. Основание: {reason}.',
      topicExplainMessage: 'Система: {user}. Сообщение отклонено. Основание: {reason}.',
      topicWarn: 'Система: {user}. Предупреждение зарегистрировано. Основание: {reason}.',
      topicMuteAnnouncement:
        'Система: {user}. Выдан мут за повторные объявления с неверным форматом.',
      topicMuteMessage: 'Система: {user}. Выдан мут за повторные сообщения с неверным форматом.',
      topicBan: 'Система: {user}. Выдан бан до ручного снятия. Основание: {reason}.',
      muteNotice:
        'Система: {user}. Выдан мут на {mute_duration}. Новые сообщения будут скрываться до конца ограничения.',
      messageLimitsWarn: 'Система: {user}. Предупреждение зарегистрировано. Основание: {reason}.',
      messageLimitsMute:
        'Система: {user}. Выдан мут за повторное нарушение ограничений. Основание: {reason}.',
      messageLimitsBan: 'Система: {user}. Выдан бан до ручного снятия. Основание: {reason}.',
    },
  },
  FRIENDLY: {
    editable: {
      greetingBotMessageText:
        'Привет, {user} 🙂 На связи {bot_character_name}. Осваивайтесь спокойно, я помогу держать чат в порядке.',
      linkBotMessageText:
        '{user}, ссылку убрал: в этом чате они отключены. Если она нужна по делу, лучше сначала согласовать с админом.',
      linkWarnMessageText:
        '{user}, это уже предупреждение. Ссылки здесь всё ещё нельзя, давайте дальше без них.',
      requiredSubscriptionBotMessageText:
        '{user}, чтобы писать в этом чате, нужна подписка на {channels}. Подпишитесь и отправьте сообщение ещё раз. Текущее сообщение: {message_status}.',
      requiredSubscriptionWarnMessageText:
        '{user}, это уже предупреждение. Для сообщений в чате всё ещё нужна подписка на {channels}. Причина: {reason}.',
      textFiltersBotMessageText:
        '{user}, сообщение убрал. Причина: {reason}. Чуть переформулируйте и можно отправить снова.',
      textFiltersWarnMessageText:
        '{user}, это предупреждение. Причина: {reason}. Давайте дальше без такого текста.',
      duplicateBotMessageText: '{user}, такое сообщение уже отправлялось. {sanction}',
      messageLimitsBotMessageText: '{user}, сообщение не прошло. Причина: {reason}.',
      nightModeBotMessageText:
        'Сейчас тихий режим 🌙 {night_window} ({night_timezone}). {night_status}',
      nightModeOpenMessageText:
        'Доброе утро ☀️ {opening_status} Можно снова возвращаться к разговору.',
    },
    system: {
      linkMute: '{user}, ссылки повторились несколько раз, поэтому выдан мут.',
      requiredSubscriptionMute:
        '{user}, сообщения без подписки повторились, поэтому выдан мут. Сначала подпишитесь на {channels}.',
      requiredSubscriptionBan:
        '{user}, выдан бан до ручного разбана. Чтобы писать дальше, сначала подпишитесь на {channels}.',
      textFiltersMuteCommercial: '{user}, коммерческая реклама повторилась, поэтому выдан мут.',
      textFiltersMuteProfanity: '{user}, грубая лексика повторилась, поэтому выдан мут.',
      textFiltersMuteGeneric: '{user}, нарушения повторились, поэтому выдан мут.',
      topicExplainAnnouncement:
        '{user}, объявление не подошло по формату: {reason}. Поправьте и можно отправить снова.',
      topicExplainMessage:
        '{user}, сообщение не подошло по формату: {reason}. Поправьте и можно отправить снова.',
      topicWarn: '{user}, это предупреждение. Причина: {reason}.',
      topicMuteAnnouncement: '{user}, объявления снова были не по формату, поэтому выдан мут.',
      topicMuteMessage: '{user}, сообщения снова были не по формату, поэтому выдан мут.',
      topicBan: '{user}, выдан бан до ручного разбана. Причина: {reason}.',
      muteNotice:
        '{user}, для вас мут на {mute_duration}. До конца срока новые сообщения будут скрываться.',
      messageLimitsWarn: '{user}, это предупреждение. Причина: {reason}.',
      messageLimitsMute:
        '{user}, ограничения по сообщениям снова нарушились, поэтому выдан мут. Причина: {reason}.',
      messageLimitsBan: '{user}, выдан бан до ручного разбана. Причина: {reason}.',
    },
  },
  POLICE: {
    editable: {
      greetingBotMessageText:
        'Здравия желаю, {user} 🤝 На смене {bot_character_name}. Осваивайтесь, но порядок не нарушаем.',
      linkBotMessageText:
        'Товарищ {user}, ссылку изъял 👮‍♂️ В этом чате с ними строго. Если вопрос по делу, согласуйте с админом.',
      linkWarnMessageText:
        'Товарищ {user}, предупреждение за ссылки оформил 👮‍♂️ Следующее нарушение пойдёт со взысканием.',
      requiredSubscriptionBotMessageText:
        'Товарищ {user}, для сообщений нужна подписка на {channels} 👮‍♂️ Сначала оформите подписку, потом подавайте сообщение заново. Текущее: {message_status}.',
      requiredSubscriptionWarnMessageText:
        'Товарищ {user}, предупреждение по подписке оформил 👮‍♂️ Для сообщений нужна подписка на {channels}. Причина: {reason}.',
      textFiltersBotMessageText:
        'Товарищ {user}, сообщение изъял 👮‍♂️ Причина: {reason}. Поправьте по форме и возвращайтесь.',
      textFiltersWarnMessageText:
        'Товарищ {user}, предупреждение оформил 👮‍♂️ Причина: {reason}. Дальше держим строй.',
      duplicateBotMessageText: 'Товарищ {user}, повтор сообщения зафиксировал 👮‍♂️ {sanction}',
      messageLimitsBotMessageText:
        'Товарищ {user}, сообщение завернул 👮‍♂️ Причина: {reason}. Подправьте и подавайте заново.',
      nightModeBotMessageText:
        'Ночной режим, граждане 🌙 Участок прикрыт на {night_window} ({night_timezone}). {night_status}',
      nightModeOpenMessageText:
        'Доброе утро, граждане ☀️ {opening_status} Возвращаемся в эфир без нарушений.',
    },
    system: {
      linkMute: 'Товарищ {user}, повторную отправку ссылок зафиксировал. Оформляю мут.',
      requiredSubscriptionMute:
        'Товарищ {user}, без подписки на {channels} сообщения пошли по второму кругу. Оформляю мут.',
      requiredSubscriptionBan:
        'Товарищ {user}, оформляю бан до ручного разбана 👮‍♂️ Для сообщений нужна подписка на {channels}.',
      textFiltersMuteCommercial: 'Товарищ {user}, коммерческую рекламу повторили. Оформляю мут.',
      textFiltersMuteProfanity: 'Товарищ {user}, по лексике пошёл рецидив. Оформляю мут.',
      textFiltersMuteGeneric: 'Товарищ {user}, нарушения повторились. Оформляю мут.',
      topicExplainAnnouncement:
        'Товарищ {user}, объявление завернул 👮‍♂️ Причина: {reason}. Поправьте по форме и возвращайтесь.',
      topicExplainMessage:
        'Товарищ {user}, сообщение завернул 👮‍♂️ Причина: {reason}. Поправьте по форме и возвращайтесь.',
      topicWarn: 'Товарищ {user}, предупреждение оформил 👮‍♂️ Причина: {reason}.',
      topicMuteAnnouncement: 'Товарищ {user}, объявления снова мимо формы. Оформляю мут.',
      topicMuteMessage: 'Товарищ {user}, сообщения снова мимо формы. Оформляю мут.',
      topicBan: 'Товарищ {user}, оформляю бан до ручного разбана 👮‍♂️ Причина: {reason}.',
      muteNotice:
        'Товарищ {user}, оформляю мут на {mute_duration}. До конца срока новые сообщения будут скрываться.',
      messageLimitsWarn: 'Товарищ {user}, предупреждение оформил 👮‍♂️ Причина: {reason}.',
      messageLimitsMute:
        'Товарищ {user}, ограничения снова нарушены. Оформляю мут. Причина: {reason}.',
      messageLimitsBan: 'Товарищ {user}, оформляю бан до ручного разбана 👮‍♂️ Причина: {reason}.',
    },
  },
  IRONIC: {
    editable: {
      greetingBotMessageText:
        '{user}, добро пожаловать 🙂 На связи {bot_character_name}. Здесь можно почти всё, кроме привычки спорить с правилами.',
      linkBotMessageText:
        '{user}, ссылку убрал. Интернет и так переполнен, не будем делать филиал ещё и здесь.',
      linkWarnMessageText:
        '{user}, со ссылками вы снова решили поспорить с настройками. Это уже предупреждение.',
      requiredSubscriptionBotMessageText:
        '{user}, писать сюда можно после подписки на {channels}. Сначала формальность, потом самовыражение. Текущее сообщение: {message_status}.',
      requiredSubscriptionWarnMessageText:
        '{user}, это уже предупреждение. Без подписки на {channels} сообщения сюда всё ещё не проходят. Причина: {reason}. Правила, как назло, помнят детали.',
      textFiltersBotMessageText:
        '{user}, сообщение убрал. Причина: {reason}. Мысль можно сохранить, подачу лучше заменить.',
      textFiltersWarnMessageText:
        '{user}, это уже предупреждение. Причина: {reason}. Острый стиль хорош, пока не начинает пахнуть санкциями.',
      duplicateBotMessageText: '{user}, мысль уже была в эфире. {sanction}',
      messageLimitsBotMessageText:
        '{user}, сообщение не прошло: {reason}. У лимитов, к сожалению, хорошая память.',
      nightModeBotMessageText:
        'Ночной режим 🌙 {night_window} ({night_timezone}). {night_status} Даже чату иногда полезно помолчать.',
      nightModeOpenMessageText:
        'Доброе утро ☀️ {opening_status} Можно снова писать, но без лишнего театра.',
    },
    system: {
      linkMute: '{user}, со ссылками вы решили идти до финала. Поэтому теперь мут.',
      requiredSubscriptionMute:
        '{user}, попытки писать без подписки на {channels} стали навязчивой идеей. Поэтому теперь мут.',
      requiredSubscriptionBan:
        '{user}, бан до ручного разбана. Без подписки на {channels} этот диалог всё равно никуда не развивался.',
      textFiltersMuteCommercial:
        '{user}, коммерческая реклама снова нашла в вас энтузиаста. Поэтому теперь мут.',
      textFiltersMuteProfanity:
        '{user}, лексика упрямо шла по плохому сценарию. Поэтому теперь мут.',
      textFiltersMuteGeneric: '{user}, текст снова решил поспорить с правилами. Поэтому теперь мут.',
      topicExplainAnnouncement:
        '{user}, объявление убрал. Причина: {reason}. Формат тут не для красоты, а чтобы всем было легче жить.',
      topicExplainMessage:
        '{user}, сообщение убрал. Причина: {reason}. Формат здесь не декоративный, а обязательный.',
      topicWarn:
        '{user}, это уже предупреждение. Причина: {reason}. Коллекция таких эпизодов никого ещё не украшала.',
      topicMuteAnnouncement: '{user}, объявления снова пошли мимо формата. Поэтому теперь мут.',
      topicMuteMessage: '{user}, сообщения снова пошли мимо формата. Поэтому теперь мут.',
      topicBan:
        '{user}, бан до ручного разбана. Причина: {reason}. Иногда это самый короткий способ договориться.',
      muteNotice:
        '{user}, мут на {mute_duration}. До конца срока новые сообщения будут скрываться. Небольшая пауза иногда творит чудеса.',
      messageLimitsWarn:
        '{user}, это уже предупреждение. Причина: {reason}. Лимиты, как назло, умеют считать.',
      messageLimitsMute:
        '{user}, ограничения по сообщениям снова решили испытать чужое терпение. Поэтому теперь мут. Причина: {reason}.',
      messageLimitsBan:
        '{user}, бан до ручного разбана. Причина: {reason}. Переговоры с лимитами официально зашли в тупик.',
    },
  },
};

const BOT_SPEECH_POLICE_FEMALE_PRESET: BotSpeechPreset = {
  editable: {
    greetingBotMessageText:
      'Здравия желаю, {user} 🤝 На смене {bot_character_name}. Осваивайтесь, но порядок не нарушаем.',
    linkBotMessageText:
      'Товарищ {user}, ссылку изъяла 👮‍♀️ В этом чате с ними строго. Если вопрос по делу, согласуйте с админом.',
    linkWarnMessageText:
      'Товарищ {user}, предупреждение за ссылки оформила 👮‍♀️ Следующее нарушение пойдёт со взысканием.',
    requiredSubscriptionBotMessageText:
      'Товарищ {user}, для сообщений нужна подписка на {channels} 👮‍♀️ Сначала оформите подписку, потом подавайте сообщение заново. Текущее: {message_status}.',
    requiredSubscriptionWarnMessageText:
      'Товарищ {user}, предупреждение по подписке оформила 👮‍♀️ Для сообщений нужна подписка на {channels}. Причина: {reason}.',
    textFiltersBotMessageText:
      'Товарищ {user}, сообщение изъяла 👮‍♀️ Причина: {reason}. Поправьте по форме и возвращайтесь.',
    textFiltersWarnMessageText:
      'Товарищ {user}, предупреждение оформила 👮‍♀️ Причина: {reason}. Дальше держим строй.',
    duplicateBotMessageText: 'Товарищ {user}, повтор сообщения зафиксировала 👮‍♀️ {sanction}',
    messageLimitsBotMessageText:
      'Товарищ {user}, сообщение завернула 👮‍♀️ Причина: {reason}. Подправьте и подавайте заново.',
    nightModeBotMessageText:
      'Ночной режим, граждане 🌙 Участок прикрыт на {night_window} ({night_timezone}). {night_status}',
    nightModeOpenMessageText:
      'Доброе утро, граждане ☀️ {opening_status} Возвращаемся в эфир без нарушений.',
  },
  system: {
    linkMute: 'Товарищ {user}, повторную отправку ссылок зафиксировала. Оформляю мут.',
    requiredSubscriptionMute:
      'Товарищ {user}, без подписки на {channels} сообщения пошли по второму кругу. Оформляю мут.',
    requiredSubscriptionBan:
      'Товарищ {user}, оформляю бан до ручного разбана 👮‍♀️ Для сообщений нужна подписка на {channels}.',
    textFiltersMuteCommercial: 'Товарищ {user}, коммерческую рекламу повторили. Оформляю мут.',
    textFiltersMuteProfanity: 'Товарищ {user}, по лексике пошёл рецидив. Оформляю мут.',
    textFiltersMuteGeneric: 'Товарищ {user}, нарушения повторились. Оформляю мут.',
    topicExplainAnnouncement:
      'Товарищ {user}, объявление завернула 👮‍♀️ Причина: {reason}. Поправьте по форме и возвращайтесь.',
    topicExplainMessage:
      'Товарищ {user}, сообщение завернула 👮‍♀️ Причина: {reason}. Поправьте по форме и возвращайтесь.',
    topicWarn: 'Товарищ {user}, предупреждение оформила 👮‍♀️ Причина: {reason}.',
    topicMuteAnnouncement: 'Товарищ {user}, объявления снова мимо формы. Оформляю мут.',
    topicMuteMessage: 'Товарищ {user}, сообщения снова мимо формы. Оформляю мут.',
    topicBan: 'Товарищ {user}, оформляю бан до ручного разбана 👮‍♀️ Причина: {reason}.',
    muteNotice:
      'Товарищ {user}, оформляю мут на {mute_duration}. До конца срока новые сообщения будут скрываться.',
    messageLimitsWarn: 'Товарищ {user}, предупреждение оформила 👮‍♀️ Причина: {reason}.',
    messageLimitsMute:
      'Товарищ {user}, ограничения снова нарушены. Оформляю мут. Причина: {reason}.',
    messageLimitsBan: 'Товарищ {user}, оформляю бан до ручного разбана 👮‍♀️ Причина: {reason}.',
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
  persona: BotSpeechPersona | null | undefined,
): BotSpeechPreset {
  const resolvedStyle = resolveBotSpeechStyle(style);
  const resolvedPersona = resolveBotSpeechPersona(persona);

  if (resolvedStyle === 'POLICE' && resolvedPersona === 'female') {
    return BOT_SPEECH_POLICE_FEMALE_PRESET;
  }

  return BOT_SPEECH_PRESETS[resolvedStyle];
}

export function hasBotSpeechEditableOverrides(settings: BotSpeechSettingsSubset): boolean {
  return BOT_SPEECH_EDITABLE_FIELD_KEYS.some((key) => settings[key].trim().length > 0);
}

export function applyBotSpeechStylePreset<T extends BotSpeechSettingsSubset>(
  settings: T,
  style: BotSpeechStyle,
): T {
  const nextSettings = {
    ...settings,
    botSpeechStyle: style,
  };

  for (const key of BOT_SPEECH_EDITABLE_FIELD_KEYS) {
    nextSettings[key] = '';
  }

  return nextSettings;
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
