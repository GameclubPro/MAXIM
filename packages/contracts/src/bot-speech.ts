import { z } from 'zod';

export const BOT_SPEECH_STYLE_VALUES = ['ROBOT', 'FRIENDLY', 'POLICE', 'IRONIC'] as const;
export const botSpeechStyleSchema = z.enum(BOT_SPEECH_STYLE_VALUES);
export type BotSpeechStyle = z.infer<typeof botSpeechStyleSchema>;

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
  'linkKick',
  'requiredSubscriptionKick',
  'requiredSubscriptionBan',
  'textFiltersKickCommercial',
  'textFiltersKickProfanity',
  'textFiltersKickGeneric',
  'topicExplainAnnouncement',
  'topicExplainMessage',
  'topicWarn',
  'topicKickAnnouncement',
  'topicKickMessage',
  'topicBan',
  'banNotice',
  'messageLimitsWarn',
  'messageLimitsKick',
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
    description: 'Текущий фирменный образ Майора Максимова без изменений.',
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
      linkKick: 'Система: {user}. Доступ к чату ограничен за повторную отправку ссылок.',
      requiredSubscriptionKick:
        'Система: {user}. Доступ к чату ограничен за повторные сообщения без подписки на {channels}.',
      requiredSubscriptionBan:
        'Система: {user}. Установлен тайм-аут на {ban_duration}. Для сообщений требуется подписка на {channels}.',
      textFiltersKickCommercial: 'Система: {user}. Доступ к чату ограничен за повторную рекламу.',
      textFiltersKickProfanity:
        'Система: {user}. Доступ к чату ограничен за повторную грубую лексику.',
      textFiltersKickGeneric:
        'Система: {user}. Доступ к чату ограничен за повторные текстовые нарушения.',
      topicExplainAnnouncement: 'Система: {user}. Объявление отклонено. Причина: {reason}.',
      topicExplainMessage: 'Система: {user}. Сообщение отклонено. Причина: {reason}.',
      topicWarn: 'Система: {user}. Предупреждение. Причина: {reason}.',
      topicKickAnnouncement:
        'Система: {user}. Доступ к чату ограничен за повторные объявления с неверным форматом.',
      topicKickMessage:
        'Система: {user}. Доступ к чату ограничен за повторные сообщения с неверным форматом.',
      topicBan: 'Система: {user}. Установлен тайм-аут на {ban_duration}. Причина: {reason}.',
      banNotice:
        'Система: {user}. Установлен тайм-аут на {ban_duration}. Доступ будет восстановлен после окончания ограничения.',
      messageLimitsWarn: 'Система: {user}. Предупреждение. Причина: {reason}.',
      messageLimitsKick:
        'Система: {user}. Доступ к чату ограничен за повторное нарушение ограничений. Причина: {reason}.',
      messageLimitsBan:
        'Система: {user}. Установлен тайм-аут на {ban_duration}. Причина: {reason}.',
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
      linkKick: '{user}, ссылки повторились несколько раз, поэтому пришлось вывести вас из чата.',
      requiredSubscriptionKick:
        '{user}, сообщения без подписки повторились, поэтому пришлось вывести вас из чата. Сначала подпишитесь на {channels}.',
      requiredSubscriptionBan:
        '{user}, нужна пауза на {ban_duration}. Чтобы писать дальше, сначала подпишитесь на {channels}.',
      textFiltersKickCommercial:
        '{user}, реклама повторилась, поэтому пришлось вывести вас из чата.',
      textFiltersKickProfanity:
        '{user}, грубая лексика повторилась, поэтому пришлось вывести вас из чата.',
      textFiltersKickGeneric:
        '{user}, нарушения повторились, поэтому пришлось вывести вас из чата.',
      topicExplainAnnouncement:
        '{user}, объявление не подошло по формату: {reason}. Поправьте и можно отправить снова.',
      topicExplainMessage:
        '{user}, сообщение не подошло по формату: {reason}. Поправьте и можно отправить снова.',
      topicWarn: '{user}, это предупреждение. Причина: {reason}.',
      topicKickAnnouncement:
        '{user}, объявления снова были не по формату, поэтому пришлось вывести вас из чата.',
      topicKickMessage:
        '{user}, сообщения снова были не по формату, поэтому пришлось вывести вас из чата.',
      topicBan: '{user}, нужна пауза на {ban_duration}. Причина: {reason}.',
      banNotice: '{user}, для вас временная пауза на {ban_duration}. Возвращайтесь спокойно.',
      messageLimitsWarn: '{user}, это предупреждение. Причина: {reason}.',
      messageLimitsKick:
        '{user}, ограничения по сообщениям снова нарушились, поэтому пришлось вывести вас из чата. Причина: {reason}.',
      messageLimitsBan: '{user}, нужна пауза на {ban_duration}. Причина: {reason}.',
    },
  },
  POLICE: {
    editable: {
      greetingBotMessageText:
        'Здравия желаю, {user} 🤝 Майор Максимов на месте. Осваивайтесь, но без самодеятельности.',
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
      linkKick:
        'Товарищ {user}, со ссылками устроили повторное правонарушение. Пришлось вывести вас из чата.',
      requiredSubscriptionKick:
        'Товарищ {user}, без подписки на {channels} сообщения пошли по второму кругу. Пришлось оформить выход из чата.',
      requiredSubscriptionBan:
        'Товарищ {user}, оформляю паузу на {ban_duration} 👮‍♂️ Для сообщений нужна подписка на {channels}.',
      textFiltersKickCommercial:
        'Товарищ {user}, рекламу повторили, а у нас с этим короткий разговор. Дальше чат без вас.',
      textFiltersKickProfanity: 'Товарищ {user}, по лексике пошёл рецидив. Дальше чат без вас.',
      textFiltersKickGeneric:
        'Товарищ {user}, нарушения пошли по второму кругу. Дальше чат без вас.',
      topicExplainAnnouncement:
        'Товарищ {user}, объявление завернул 👮‍♂️ Причина: {reason}. Поправьте по форме и возвращайтесь.',
      topicExplainMessage:
        'Товарищ {user}, сообщение завернул 👮‍♂️ Причина: {reason}. Поправьте по форме и возвращайтесь.',
      topicWarn: 'Товарищ {user}, предупреждение оформил 👮‍♂️ Причина: {reason}.',
      topicKickAnnouncement:
        'Товарищ {user}, объявления снова мимо формы. Пришлось оформить выход из чата.',
      topicKickMessage:
        'Товарищ {user}, сообщения снова мимо формы. Пришлось оформить выход из чата.',
      topicBan: 'Товарищ {user}, оформляю паузу на {ban_duration} 👮‍♂️ Причина: {reason}.',
      banNotice: 'Товарищ {user}, оформляю паузу на {ban_duration}. Возвращайтесь без приключений.',
      messageLimitsWarn: 'Товарищ {user}, предупреждение оформил 👮‍♂️ Причина: {reason}.',
      messageLimitsKick:
        'Товарищ {user}, ограничения снова решили проверить на прочность. Пришлось вывести из чата. Причина: {reason}.',
      messageLimitsBan: 'Товарищ {user}, оформляю паузу на {ban_duration} 👮‍♂️ Причина: {reason}.',
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
      linkKick: '{user}, со ссылками вышел небольшой сериал, поэтому дальше чат без вас.',
      requiredSubscriptionKick:
        '{user}, попытки писать без подписки на {channels} уже выглядят как серия, поэтому дальше чат без вас.',
      requiredSubscriptionBan:
        '{user}, пауза на {ban_duration}. Без подписки на {channels} писать сюда всё равно не получится.',
      textFiltersKickCommercial: '{user}, реклама решила задержаться, поэтому дальше чат без вас.',
      textFiltersKickProfanity:
        '{user}, запас резких слов оказался лишним, поэтому дальше чат без вас.',
      textFiltersKickGeneric: '{user}, текст снова пошел мимо правил, поэтому дальше чат без вас.',
      topicExplainAnnouncement:
        '{user}, объявление убрал. Причина: {reason}. Формат тут все-таки не для декора.',
      topicExplainMessage:
        '{user}, сообщение убрал. Причина: {reason}. Формат тут, как ни странно, обязателен.',
      topicWarn:
        '{user}, это уже предупреждение. Причина: {reason}. Коллекцию таких эпизодов лучше не собирать.',
      topicKickAnnouncement:
        '{user}, объявления снова пошли мимо формата, поэтому дальше чат без вас.',
      topicKickMessage: '{user}, сообщения снова пошли мимо формата, поэтому дальше чат без вас.',
      topicBan:
        '{user}, пауза на {ban_duration}. Причина: {reason}. Иногда это самый полезный формат.',
      banNotice: '{user}, пауза на {ban_duration}. Возвращайтесь без новых сюжетных поворотов.',
      messageLimitsWarn:
        '{user}, это уже предупреждение. Причина: {reason}. Лимиты тут правда считают.',
      messageLimitsKick:
        '{user}, ограничения снова решили проверить на прочность, поэтому дальше чат без вас. Причина: {reason}.',
      messageLimitsBan:
        '{user}, пауза на {ban_duration}. Причина: {reason}. Лимитам тоже нужен отдых.',
    },
  },
};

export function resolveBotSpeechStyle(style: BotSpeechStyle | null | undefined): BotSpeechStyle {
  return style ?? 'POLICE';
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
): string {
  return BOT_SPEECH_PRESETS[resolveBotSpeechStyle(style)].editable[fieldKey];
}

export function getBotSpeechSystemTemplate(
  style: BotSpeechStyle | null | undefined,
  templateKey: BotSpeechSystemTemplateKey,
): string {
  return BOT_SPEECH_PRESETS[resolveBotSpeechStyle(style)].system[templateKey];
}
