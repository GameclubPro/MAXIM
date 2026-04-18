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
        '🤖 {user}, доступ открыт. На линии {bot_character_name}. Работаем чисто и по правилам.',
      linkBotMessageText: '🔗 {user}, сообщение {message_status}. Причина: {reason}.',
      linkWarnMessageText:
        '⚠️ {user}, это предупреждение. Причина: {reason}.',
      requiredSubscriptionBotMessageText:
        '📡 {user}, для сообщений нужна подписка на {channels}. Подпишитесь и отправьте еще раз. Статус: {message_status}.',
      requiredSubscriptionWarnMessageText:
        '⚠️ {user}, это предупреждение. Для сообщений нужна подписка на {channels}. Причина: {reason}.',
      textFiltersBotMessageText: '🛡️ {user}, сообщение {message_status}. Причина: {reason}.',
      textFiltersWarnMessageText:
        '⚠️ {user}, это предупреждение. Причина: {reason}.',
      duplicateBotMessageText: '♻️ {user}, дубль найден. {sanction}',
      messageLimitsBotMessageText: '📏 {user}, сообщение {message_status}. Причина: {reason}.',
      nightModeBotMessageText:
        '🌙 Ночной режим активен: {night_window} ({night_timezone}). {night_status}',
      nightModeOpenMessageText: '☀️ Ночной режим завершен. {opening_status}',
    },
    system: {
      linkMute: '🔒 {user}, за повторные ссылки включен мут.',
      requiredSubscriptionMute:
        '🔒 {user}, за повторные сообщения без подписки на {channels} включен мут.',
      requiredSubscriptionBan:
        '⛔ {user}, включен бан до ручного снятия. Для сообщений нужна подписка на {channels}.',
      textFiltersMuteCommercial: '🔒 {user}, за повторную рекламу включен мут.',
      textFiltersMuteProfanity: '🔒 {user}, за повторную грубую лексику включен мут.',
      textFiltersMuteGeneric: '🔒 {user}, за повторные нарушения текста включен мут.',
      topicExplainAnnouncement: '🧾 {user}, объявление не прошло. Причина: {reason}.',
      topicExplainMessage: '🧾 {user}, сообщение не прошло. Причина: {reason}.',
      topicWarn: '⚠️ {user}, это предупреждение. Причина: {reason}.',
      topicMuteAnnouncement:
        '🔒 {user}, за повторные объявления не по формату включен мут.',
      topicMuteMessage: '🔒 {user}, за повторные сообщения не по формату включен мут.',
      topicBan: '⛔ {user}, включен бан до ручного снятия. Причина: {reason}.',
      muteNotice:
        '🔒 {user}, включен мут на {mute_duration}. Новые сообщения будут скрываться до конца ограничения.',
      messageLimitsWarn: '⚠️ {user}, это предупреждение. Причина: {reason}.',
      messageLimitsMute:
        '🔒 {user}, за повторное нарушение ограничений включен мут. Причина: {reason}.',
      messageLimitsBan: '⛔ {user}, включен бан до ручного снятия. Причина: {reason}.',
    },
  },
  FRIENDLY: {
    editable: {
      greetingBotMessageText:
        'Привет, {user} 🫶 На связи {bot_character_name}. Помогу освоиться и держать чат в порядке.',
      linkBotMessageText:
        '🔗 {user}, ссылку убрал. Здесь они отключены. Если она по делу, лучше согласовать с админом.',
      linkWarnMessageText:
        '⚠️ {user}, это предупреждение. Ссылки здесь всё ещё нельзя.',
      requiredSubscriptionBotMessageText:
        '📡 {user}, чтобы писать сюда, нужна подписка на {channels}. Подпишитесь и попробуйте снова. Сейчас оно: {message_status}.',
      requiredSubscriptionWarnMessageText:
        '⚠️ {user}, это предупреждение. Для сообщений всё ещё нужна подписка на {channels}. Причина: {reason}.',
      textFiltersBotMessageText:
        '🧹 {user}, сообщение убрал. Причина: {reason}. Поправьте и можно отправить снова ✨',
      textFiltersWarnMessageText:
        '⚠️ {user}, это предупреждение. Причина: {reason}. Давайте дальше без этого 🙌',
      duplicateBotMessageText: '♻️ {user}, это уже повтор. {sanction}',
      messageLimitsBotMessageText: '📏 {user}, сообщение не прошло. Причина: {reason}.',
      nightModeBotMessageText:
        '🌙 Сейчас тихий режим: {night_window} ({night_timezone}). {night_status}',
      nightModeOpenMessageText:
        '☀️ Доброе утро. {opening_status} Можно снова писать ✨',
    },
    system: {
      linkMute: '🔒 {user}, ссылки повторились, поэтому включил мут.',
      requiredSubscriptionMute:
        '🔒 {user}, сообщения без подписки повторились, поэтому включил мут. Сначала подпишитесь на {channels}.',
      requiredSubscriptionBan:
        '⛔ {user}, пришлось выдать бан до ручного разбана. Чтобы писать дальше, сначала подпишитесь на {channels}.',
      textFiltersMuteCommercial: '🔒 {user}, реклама повторилась, поэтому включил мут.',
      textFiltersMuteProfanity: '🔒 {user}, грубая лексика повторилась, поэтому включил мут.',
      textFiltersMuteGeneric: '🔒 {user}, нарушения повторились, поэтому включил мут.',
      topicExplainAnnouncement:
        '🧾 {user}, объявление не прошло: {reason}. Поправьте и отправьте ещё раз ✨',
      topicExplainMessage:
        '🧾 {user}, сообщение не прошло: {reason}. Поправьте и отправьте ещё раз ✨',
      topicWarn: '⚠️ {user}, это предупреждение. Причина: {reason}.',
      topicMuteAnnouncement: '🔒 {user}, объявления снова были не по формату, поэтому включил мут.',
      topicMuteMessage: '🔒 {user}, сообщения снова были не по формату, поэтому включил мут.',
      topicBan: '⛔ {user}, пришлось выдать бан до ручного разбана. Причина: {reason}.',
      muteNotice:
        '🔒 {user}, включил мут на {mute_duration}. До конца срока новые сообщения будут скрываться.',
      messageLimitsWarn: '⚠️ {user}, это предупреждение. Причина: {reason}.',
      messageLimitsMute:
        '🔒 {user}, ограничения по сообщениям снова нарушились, поэтому включил мут. Причина: {reason}.',
      messageLimitsBan: '⛔ {user}, пришлось выдать бан до ручного разбана. Причина: {reason}.',
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
