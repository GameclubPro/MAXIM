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
    description: 'Сухой системный тон без роли, эмоций и шуток.',
    iconKey: 'robot',
  },
  FRIENDLY: {
    label: 'Дружелюбный',
    subtitle: 'поддерживающий собеседник',
    description: 'Спокойный и поддерживающий тон с фокусом на помощи и ясности.',
    iconKey: 'friendly',
  },
  POLICE: {
    label: 'Полицейский',
    subtitle: 'строгий персонаж с ролью',
    description: 'Строгий ролевой образ бота с фирменной служебной подачей.',
    iconKey: 'police',
  },
  IRONIC: {
    label: 'Ироничный',
    subtitle: 'умный наблюдатель с сухими комментариями',
    description: 'Сухая ирония по ситуации, без хамства, унижения и перегиба.',
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
      greetingBotMessageText: 'Система: {user}, доступ в чат открыт.',
      linkBotMessageText: 'Система: {user}. Ссылка удалена. Причина: {reason}.',
      linkWarnMessageText: 'Система: {user}. Предупреждение. Повторная отправка ссылок запрещена.',
      requiredSubscriptionBotMessageText:
        'Система: {user}. Для сообщений в этом чате нужна подписка на {channels}. Подпишитесь и отправьте сообщение снова. Текущий статус: {message_status}.',
      requiredSubscriptionWarnMessageText:
        'Система: {user}. Предупреждение. Для сообщений в этом чате по-прежнему нужна подписка на {channels}. Причина: {reason}.',
      textFiltersBotMessageText: 'Система: {user}. Сообщение удалено. Причина: {reason}.',
      textFiltersWarnMessageText: 'Система: {user}. Предупреждение. Причина: {reason}.',
      duplicateBotMessageText: 'Система: {user}. Зафиксирован повтор сообщения. {sanction}',
      messageLimitsBotMessageText: 'Система: {user}. Сообщение отклонено. Причина: {reason}.',
      nightModeBotMessageText:
        'Система: активен ночной режим. Интервал: {night_window} ({night_timezone}). {night_status}',
      nightModeOpenMessageText: 'Система: ночной режим завершен. {opening_status}',
    },
    system: {
      linkMute: 'Система: {user}. Выдан мут за повторную отправку ссылок. Новые сообщения будут скрываться до конца ограничения.',
      requiredSubscriptionMute:
        'Система: {user}. Выдан мут за повторные сообщения без подписки на {channels}. Новые сообщения будут скрываться до конца ограничения.',
      requiredSubscriptionBan:
        'Система: {user}. Выдан бан до ручного снятия. Для сообщений требуется подписка на {channels}.',
      textFiltersMuteCommercial:
        'Система: {user}. Выдан мут за повторную коммерческую рекламу. Новые сообщения будут скрываться до конца ограничения.',
      textFiltersMuteProfanity:
        'Система: {user}. Выдан мут за повторную грубую лексику. Новые сообщения будут скрываться до конца ограничения.',
      textFiltersMuteGeneric:
        'Система: {user}. Выдан мут за повторные текстовые нарушения. Новые сообщения будут скрываться до конца ограничения.',
      topicExplainAnnouncement: 'Система: {user}. Объявление отклонено. Причина: {reason}.',
      topicExplainMessage: 'Система: {user}. Сообщение отклонено. Причина: {reason}.',
      topicWarn: 'Система: {user}. Предупреждение. Причина: {reason}.',
      topicMuteAnnouncement:
        'Система: {user}. Выдан мут за повторные объявления с неверным форматом.',
      topicMuteMessage:
        'Система: {user}. Выдан мут за повторные сообщения с неверным форматом.',
      topicBan: 'Система: {user}. Выдан бан до ручного снятия. Причина: {reason}.',
      muteNotice:
        'Система: {user}. Выдан мут на {mute_duration}. Новые сообщения будут скрываться до конца ограничения.',
      messageLimitsWarn: 'Система: {user}. Предупреждение. Причина: {reason}.',
      messageLimitsMute:
        'Система: {user}. Выдан мут за повторное нарушение ограничений. Причина: {reason}.',
      messageLimitsBan:
        'Система: {user}. Выдан бан до ручного снятия. Причина: {reason}.',
    },
  },
  FRIENDLY: {
    editable: {
      greetingBotMessageText: 'Привет, {user} 🙂 Рады видеть тебя в чате.',
      linkBotMessageText:
        '{user}, ссылку пришлось убрать. В этом чате они отключены. Если она по делу, лучше сначала уточнить у админа.',
      linkWarnMessageText:
        '{user}, это уже предупреждение. Здесь нельзя отправлять ссылки. Давайте дальше без них.',
      requiredSubscriptionBotMessageText:
        '{user}, чтобы писать в этом чате, нужна подписка на {channels}. Подпишитесь и отправьте сообщение ещё раз. Текущее сообщение: {message_status}.',
      requiredSubscriptionWarnMessageText:
        '{user}, это уже предупреждение. Чтобы писать в чате, всё ещё нужна подписка на {channels}.',
      textFiltersBotMessageText:
        '{user}, сообщение убрал. Причина: {reason}. Если поправить формулировку, можно отправить снова.',
      textFiltersWarnMessageText: '{user}, это предупреждение. Давайте дальше без такого текста.',
      duplicateBotMessageText: '{user}, такое сообщение уже было. {sanction}',
      messageLimitsBotMessageText:
        '{user}, сообщение не прошло: {reason}. Чуть поправьте и можно снова.',
      nightModeBotMessageText:
        'Сейчас тихий режим 🌙 {night_window} ({night_timezone}). {night_status}',
      nightModeOpenMessageText: 'Доброе утро ☀️ {opening_status} Можно возвращаться к разговору.',
    },
    system: {
      linkMute: '{user}, ссылки повторились несколько раз, поэтому выдан мут. Новые сообщения будут скрываться до конца ограничения.',
      requiredSubscriptionMute:
        '{user}, сообщения без подписки повторились, поэтому выдан мут. Сначала подпишитесь на {channels}.',
      requiredSubscriptionBan:
        '{user}, выдан бан до ручного разбана. Чтобы писать дальше, сначала подпишитесь на {channels}.',
      textFiltersMuteCommercial:
        '{user}, коммерческая реклама повторилась, поэтому выдан мут.',
      textFiltersMuteProfanity:
        '{user}, грубая лексика повторилась, поэтому выдан мут.',
      textFiltersMuteGeneric:
        '{user}, нарушения повторились, поэтому выдан мут.',
      topicExplainAnnouncement:
        '{user}, объявление не подошло по формату: {reason}. Поправьте и можно отправить снова.',
      topicExplainMessage:
        '{user}, сообщение не подошло по формату: {reason}. Поправьте и можно отправить снова.',
      topicWarn: '{user}, это предупреждение. Причина: {reason}.',
      topicMuteAnnouncement:
        '{user}, объявления снова были не по формату, поэтому выдан мут.',
      topicMuteMessage:
        '{user}, сообщения снова были не по формату, поэтому выдан мут.',
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
        'Здравия желаю, {user} 🤝 {bot_character_name} на месте. Осваивайтесь, но без самодеятельности.',
      linkBotMessageText:
        'Товарищ {user}, ссылочку изъял 👮‍♂️ В этом чате с ними строго. Поправьте и работаем дальше.',
      linkWarnMessageText:
        'Товарищ {user}, предупреждение за ссылки оформил 👮‍♂️ Ещё один такой заход, и разговор будет короче.',
      requiredSubscriptionBotMessageText:
        'Товарищ {user}, для доступа к переписке нужна подписка на {channels} 👮‍♂️ Сначала оформите подписку, потом подавайте сообщение заново. Текущее: {message_status}.',
      requiredSubscriptionWarnMessageText:
        'Товарищ {user}, предупреждение по подписке оформил 👮‍♂️ Для сообщений нужна подписка на {channels}.',
      textFiltersBotMessageText:
        'Товарищ {user}, сообщение изъял 👮‍♂️ Причина: {reason}. Поправьте по форме и разъедемся красиво.',
      textFiltersWarnMessageText:
        'Товарищ {user}, предупреждение на карандаш занёс 👮‍♂️ Причина: {reason}. Дальше держим порядок.',
      duplicateBotMessageText:
        'Товарищ {user}, у нас тут не ксерокс 👮‍♂️ Повтор зафиксирован. {sanction}',
      messageLimitsBotMessageText:
        'Товарищ {user}, сообщение завернул 👮‍♂️ Причина: {reason}. Подправьте и подавайте заново.',
      nightModeBotMessageText:
        'Ночной режим, граждане 🌙 Участок прикрыт на {night_window} ({night_timezone}). {night_status}',
      nightModeOpenMessageText:
        'Доброе утро, граждане ☀️ {opening_status} Возвращаемся в эфир без нарушений.',
    },
    system: {
      linkMute:
        'Товарищ {user}, со ссылками устроили повторное правонарушение. Оформляю мут.',
      requiredSubscriptionMute:
        'Товарищ {user}, без подписки на {channels} сообщения пошли по второму кругу. Оформляю мут.',
      requiredSubscriptionBan:
        'Товарищ {user}, оформляю бан до ручного разбана 👮‍♂️ Для сообщений нужна подписка на {channels}.',
      textFiltersMuteCommercial:
        'Товарищ {user}, коммерческую рекламу повторили, а у нас с этим короткий разговор. Оформляю мут.',
      textFiltersMuteProfanity: 'Товарищ {user}, по лексике пошёл рецидив. Оформляю мут.',
      textFiltersMuteGeneric:
        'Товарищ {user}, нарушения пошли по второму кругу. Оформляю мут.',
      topicExplainAnnouncement:
        'Товарищ {user}, объявление завернул 👮‍♂️ Причина: {reason}. Поправьте по форме и возвращайтесь.',
      topicExplainMessage:
        'Товарищ {user}, сообщение завернул 👮‍♂️ Причина: {reason}. Поправьте по форме и возвращайтесь.',
      topicWarn: 'Товарищ {user}, предупреждение оформил 👮‍♂️ Причина: {reason}.',
      topicMuteAnnouncement:
        'Товарищ {user}, объявления снова мимо формы. Оформляю мут.',
      topicMuteMessage:
        'Товарищ {user}, сообщения снова мимо формы. Оформляю мут.',
      topicBan: 'Товарищ {user}, оформляю бан до ручного разбана 👮‍♂️ Причина: {reason}.',
      muteNotice:
        'Товарищ {user}, оформляю мут на {mute_duration}. До конца срока новые сообщения будут скрываться.',
      messageLimitsWarn: 'Товарищ {user}, предупреждение оформил 👮‍♂️ Причина: {reason}.',
      messageLimitsMute:
        'Товарищ {user}, ограничения снова решили проверить на прочность. Оформляю мут. Причина: {reason}.',
      messageLimitsBan: 'Товарищ {user}, оформляю бан до ручного разбана 👮‍♂️ Причина: {reason}.',
    },
  },
  IRONIC: {
    editable: {
      greetingBotMessageText:
        '{user}, добро пожаловать 🙂 Осваивайтесь, правила тут тоже не бездельничают.',
      linkBotMessageText:
        '{user}, ссылку убрал. Интернет, конечно, огромный, но сюда его тащить не надо.',
      linkWarnMessageText: '{user}, со ссылками снова та же история. Это уже предупреждение.',
      requiredSubscriptionBotMessageText:
        '{user}, писать сюда можно после подписки на {channels}. Да, сначала подписка, потом реплика. Текущее сообщение: {message_status}.',
      requiredSubscriptionWarnMessageText:
        '{user}, это уже предупреждение. Без подписки на {channels} сообщения сюда всё ещё не проходят.',
      textFiltersBotMessageText:
        '{user}, сообщение убрал. Причина: {reason}. Формулировка явно просилась на пересборку.',
      textFiltersWarnMessageText:
        '{user}, это уже предупреждение за {reason}. Давайте без таких эффектов.',
      duplicateBotMessageText: '{user}, это сообщение уже было. {sanction}',
      messageLimitsBotMessageText:
        '{user}, сообщение не прошло: {reason}. Лимиты тут не для интерьера.',
      nightModeBotMessageText:
        'Ночной режим 🌙 {night_window} ({night_timezone}). {night_status} Да, чат тоже иногда выбирает тишину.',
      nightModeOpenMessageText:
        'Доброе утро ☀️ {opening_status} Тишина закончилась, можно снова писать.',
    },
    system: {
      linkMute: '{user}, со ссылками вышел небольшой сериал, поэтому выдан мут.',
      requiredSubscriptionMute:
        '{user}, попытки писать без подписки на {channels} уже выглядят как серия, поэтому выдан мут.',
      requiredSubscriptionBan:
        '{user}, бан до ручного разбана. Без подписки на {channels} писать сюда всё равно не получится.',
      textFiltersMuteCommercial:
        '{user}, коммерческая реклама решила задержаться, поэтому выдан мут.',
      textFiltersMuteProfanity:
        '{user}, запас резких слов оказался лишним, поэтому выдан мут.',
      textFiltersMuteGeneric: '{user}, текст снова пошел мимо правил, поэтому выдан мут.',
      topicExplainAnnouncement:
        '{user}, объявление убрал. Причина: {reason}. Формат тут все-таки не для декора.',
      topicExplainMessage:
        '{user}, сообщение убрал. Причина: {reason}. Формат тут, как ни странно, обязателен.',
      topicWarn:
        '{user}, это уже предупреждение. Причина: {reason}. Коллекцию таких эпизодов лучше не собирать.',
      topicMuteAnnouncement:
        '{user}, объявления снова пошли мимо формата, поэтому выдан мут.',
      topicMuteMessage: '{user}, сообщения снова пошли мимо формата, поэтому выдан мут.',
      topicBan:
        '{user}, бан до ручного разбана. Причина: {reason}. Иногда это самый полезный формат.',
      muteNotice:
        '{user}, мут на {mute_duration}. До конца срока новые сообщения будут скрываться.',
      messageLimitsWarn:
        '{user}, это уже предупреждение. Причина: {reason}. Лимиты тут правда считают.',
      messageLimitsMute:
        '{user}, ограничения снова решили проверить на прочность, поэтому выдан мут. Причина: {reason}.',
      messageLimitsBan:
        '{user}, бан до ручного разбана. Причина: {reason}. Лимитам тоже нужен отдых.',
    },
  },
};

const BOT_SPEECH_POLICE_FEMALE_PRESET: BotSpeechPreset = {
  editable: {
    greetingBotMessageText:
      'Здравия желаю, {user} 🤝 {bot_character_name} на месте. Осваивайтесь, но без самодеятельности.',
    linkBotMessageText:
      'Товарищ {user}, ссылочку изъяла 👮‍♀️ В этом чате с ними строго. Поправьте и работаем дальше.',
    linkWarnMessageText:
      'Товарищ {user}, предупреждение за ссылки оформила 👮‍♀️ Ещё один такой заход, и разговор будет короче.',
    requiredSubscriptionBotMessageText:
      'Товарищ {user}, для доступа к переписке нужна подписка на {channels} 👮‍♀️ Сначала оформите подписку, потом подавайте сообщение заново. Текущее: {message_status}.',
    requiredSubscriptionWarnMessageText:
      'Товарищ {user}, предупреждение по подписке оформила 👮‍♀️ Для сообщений нужна подписка на {channels}.',
    textFiltersBotMessageText:
      'Товарищ {user}, сообщение изъяла 👮‍♀️ Причина: {reason}. Поправьте по форме и разъедемся красиво.',
    textFiltersWarnMessageText:
      'Товарищ {user}, предупреждение на карандаш занесла 👮‍♀️ Причина: {reason}. Дальше держим порядок.',
    duplicateBotMessageText:
      'Товарищ {user}, у нас тут не ксерокс 👮‍♀️ Повтор зафиксировала. {sanction}',
    messageLimitsBotMessageText:
      'Товарищ {user}, сообщение завернула 👮‍♀️ Причина: {reason}. Подправьте и подавайте заново.',
    nightModeBotMessageText:
      'Ночной режим, граждане 🌙 Участок прикрыт на {night_window} ({night_timezone}). {night_status}',
    nightModeOpenMessageText:
      'Доброе утро, граждане ☀️ {opening_status} Возвращаемся в эфир без нарушений.',
  },
  system: {
    linkMute:
      'Товарищ {user}, со ссылками устроили повторное правонарушение. Оформляю мут.',
    requiredSubscriptionMute:
      'Товарищ {user}, без подписки на {channels} сообщения пошли по второму кругу. Оформляю мут.',
    requiredSubscriptionBan:
      'Товарищ {user}, оформляю бан до ручного разбана 👮‍♀️ Для сообщений нужна подписка на {channels}.',
    textFiltersMuteCommercial:
      'Товарищ {user}, коммерческую рекламу повторили, а у нас с этим короткий разговор. Оформляю мут.',
    textFiltersMuteProfanity: 'Товарищ {user}, по лексике пошёл рецидив. Оформляю мут.',
    textFiltersMuteGeneric:
      'Товарищ {user}, нарушения пошли по второму кругу. Оформляю мут.',
    topicExplainAnnouncement:
      'Товарищ {user}, объявление завернула 👮‍♀️ Причина: {reason}. Поправьте по форме и возвращайтесь.',
    topicExplainMessage:
      'Товарищ {user}, сообщение завернула 👮‍♀️ Причина: {reason}. Поправьте по форме и возвращайтесь.',
    topicWarn: 'Товарищ {user}, предупреждение оформила 👮‍♀️ Причина: {reason}.',
    topicMuteAnnouncement:
      'Товарищ {user}, объявления снова мимо формы. Оформляю мут.',
    topicMuteMessage:
      'Товарищ {user}, сообщения снова мимо формы. Оформляю мут.',
    topicBan: 'Товарищ {user}, оформляю бан до ручного разбана 👮‍♀️ Причина: {reason}.',
    muteNotice:
      'Товарищ {user}, оформляю мут на {mute_duration}. До конца срока новые сообщения будут скрываться.',
    messageLimitsWarn: 'Товарищ {user}, предупреждение оформила 👮‍♀️ Причина: {reason}.',
    messageLimitsMute:
      'Товарищ {user}, ограничения снова решили проверить на прочность. Оформляю мут. Причина: {reason}.',
    messageLimitsBan:
      'Товарищ {user}, оформляю бан до ручного разбана 👮‍♀️ Причина: {reason}.',
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
