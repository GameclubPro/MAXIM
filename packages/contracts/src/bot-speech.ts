import { z } from 'zod';

export const BOT_SPEECH_STYLE_VALUES = ['ROBOT', 'FRIENDLY', 'POLICE', 'IRONIC'] as const;
export const botSpeechStyleSchema = z.enum(BOT_SPEECH_STYLE_VALUES);
export type BotSpeechStyle = z.infer<typeof botSpeechStyleSchema>;

export const BOT_SPEECH_EDITABLE_FIELD_KEYS = [
  'greetingBotMessageText',
  'linkBotMessageText',
  'linkWarnMessageText',
  'textFiltersBotMessageText',
  'textFiltersWarnMessageText',
  'duplicateBotMessageText',
  'messageLimitsBotMessageText',
  'nightModeBotMessageText',
] as const;
export type BotSpeechEditableFieldKey = (typeof BOT_SPEECH_EDITABLE_FIELD_KEYS)[number];
export type BotSpeechSettingsSubset = {
  botSpeechStyle: BotSpeechStyle | null;
} & Record<BotSpeechEditableFieldKey, string>;

export const BOT_SPEECH_SYSTEM_TEMPLATE_KEYS = [
  'linkKick',
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
      linkBotMessageText:
        'Система: {user}. Ссылка удалена. Причина: {reason}.',
      linkWarnMessageText:
        'Система: {user}. Предупреждение. Повторная отправка ссылок запрещена.',
      textFiltersBotMessageText:
        'Система: {user}. Сообщение удалено. Причина: {reason}.',
      textFiltersWarnMessageText:
        'Система: {user}. Предупреждение. Причина: {reason}.',
      duplicateBotMessageText:
        'Система: {user}. Зафиксирован повтор сообщения. {sanction}',
      messageLimitsBotMessageText:
        'Система: {user}. Сообщение отклонено. Причина: {reason}.',
      nightModeBotMessageText:
        'Система: активен ночной режим. Интервал: {night_window} ({night_timezone}). {night_status}',
    },
    system: {
      linkKick: 'Система: {user}. Доступ к чату ограничен за повторную отправку ссылок.',
      textFiltersKickCommercial:
        'Система: {user}. Доступ к чату ограничен за повторную рекламу.',
      textFiltersKickProfanity:
        'Система: {user}. Доступ к чату ограничен за повторную грубую лексику.',
      textFiltersKickGeneric:
        'Система: {user}. Доступ к чату ограничен за повторные текстовые нарушения.',
      topicExplainAnnouncement:
        'Система: {user}. Объявление отклонено. Причина: {reason}.',
      topicExplainMessage:
        'Система: {user}. Сообщение отклонено. Причина: {reason}.',
      topicWarn: 'Система: {user}. Предупреждение. Причина: {reason}.',
      topicKickAnnouncement:
        'Система: {user}. Доступ к чату ограничен за повторные объявления с неверным форматом.',
      topicKickMessage:
        'Система: {user}. Доступ к чату ограничен за повторные сообщения с неверным форматом.',
      topicBan:
        'Система: {user}. Установлен тайм-аут на {ban_duration}. Причина: {reason}.',
      banNotice:
        'Система: {user}. Установлен тайм-аут на {ban_duration}. Доступ будет восстановлен после окончания ограничения.',
      messageLimitsWarn:
        'Система: {user}. Предупреждение. Причина: {reason}.',
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
      textFiltersBotMessageText:
        '{user}, сообщение убрал. Причина: {reason}. Если поправить формулировку, можно отправить снова.',
      textFiltersWarnMessageText:
        '{user}, это предупреждение. Давайте дальше без такого текста.',
      duplicateBotMessageText:
        '{user}, такое сообщение уже было. {sanction}',
      messageLimitsBotMessageText:
        '{user}, сообщение не прошло: {reason}. Чуть поправьте и можно снова.',
      nightModeBotMessageText:
        'Сейчас тихий режим 🌙 {night_window} ({night_timezone}). {night_status}',
    },
    system: {
      linkKick:
        '{user}, ссылки повторились несколько раз, поэтому пришлось вывести вас из чата.',
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
      topicWarn:
        '{user}, это предупреждение. Причина: {reason}.',
      topicKickAnnouncement:
        '{user}, объявления снова были не по формату, поэтому пришлось вывести вас из чата.',
      topicKickMessage:
        '{user}, сообщения снова были не по формату, поэтому пришлось вывести вас из чата.',
      topicBan: '{user}, нужна пауза на {ban_duration}. Причина: {reason}.',
      banNotice:
        '{user}, для вас временная пауза на {ban_duration}. Возвращайтесь спокойно.',
      messageLimitsWarn:
        '{user}, это предупреждение. Причина: {reason}.',
      messageLimitsKick:
        '{user}, ограничения по сообщениям снова нарушились, поэтому пришлось вывести вас из чата. Причина: {reason}.',
      messageLimitsBan:
        '{user}, нужна пауза на {ban_duration}. Причина: {reason}.',
    },
  },
  POLICE: {
    editable: {
      greetingBotMessageText:
        'Здравия желаю, {user}. Майор Максимов на связи 🤝 Добро пожаловать в чат.',
      linkBotMessageText:
        'Товарищ {user}, Майор Максимов на связи 👮‍♂️ Сообщение {message_status}: {reason}. Поправьте и едем дальше.',
      linkWarnMessageText:
        'Товарищ {user}, {warning}. 👮‍♂️ {reason}. Без повторов, и разойдёмся по-хорошему.',
      textFiltersBotMessageText:
        'Товарищ {user}, Майор Максимов на связи 👮‍♂️ Сообщение {message_status}: {reason}. Поправьте и едем дальше.',
      textFiltersWarnMessageText:
        'Товарищ {user}, {warning}. Дальше держим порядок.',
      duplicateBotMessageText:
        'Товарищ {user}, Майор Максимов на связи 👮‍♂️ Повтор по базе: сообщение {duplicate_context}. {sanction} Дальше без серий, договорились.',
      messageLimitsBotMessageText:
        'Товарищ {user}, Майор Максимов на связи 👮‍♂️ Сообщение {message_status}: {reason}. Поправьте и едем дальше.',
      nightModeBotMessageText:
        'Ночной режим, граждане 🌙 Участок закрыт на {night_window} ({night_timezone}). {night_status}',
    },
    system: {
      linkKick:
        'Товарищ {user}, за повторные заходы со ссылками пришлось вывести вас из чата.',
      textFiltersKickCommercial:
        'Товарищ {user}, за повторную рекламу пришлось вывести вас из чата.',
      textFiltersKickProfanity:
        'Товарищ {user}, за повторную грубую лексику пришлось вывести вас из чата.',
      textFiltersKickGeneric:
        'Товарищ {user}, за повторные нарушения текстовых правил пришлось вывести вас из чата.',
      topicExplainAnnouncement:
        'Товарищ {user}, Майор Максимов на связи 👮‍♂️ Объявление {message_status}: {reason}. Поправьте и едем дальше.',
      topicExplainMessage:
        'Товарищ {user}, Майор Максимов на связи 👮‍♂️ Сообщение {message_status}: {reason}. Поправьте и едем дальше.',
      topicWarn: 'Товарищ {user}, фиксирую предупреждение. Причина: {reason}.',
      topicKickAnnouncement:
        'Товарищ {user}, за повторные объявления не по форме пришлось вывести вас из чата.',
      topicKickMessage:
        'Товарищ {user}, за повторные сообщения не по форме пришлось вывести вас из чата.',
      topicBan:
        'Товарищ {user}, оформляю тайм-аут на {ban_duration}. Причина: {reason}.',
      banNotice:
        'Товарищ {user}, оформляю тайм-аут на {ban_duration}. Возвращайтесь без нарушений.',
      messageLimitsWarn:
        'Товарищ {user}, фиксирую предупреждение. Причина: {reason}.',
      messageLimitsKick:
        'Товарищ {user}, за повторные нарушения пришлось вывести вас из чата. Причина: {reason}.',
      messageLimitsBan:
        'Товарищ {user}, оформляю тайм-аут на {ban_duration}. Причина: {reason}.',
    },
  },
  IRONIC: {
    editable: {
      greetingBotMessageText:
        '{user}, {greeting}. Правила тут тоже на месте.',
      linkBotMessageText:
        '{user}, сообщение {message_status}. Причина: {reason}. Ссылка была лишней.',
      linkWarnMessageText:
        '{user}, {warning}. Причина: {reason}. Номер с повтором уже понятен.',
      textFiltersBotMessageText:
        '{user}, сообщение {message_status}. Причина: {reason}. Формулировка пошла не туда.',
      textFiltersWarnMessageText:
        '{user}, {warning}. Давайте без внезапных выступлений.',
      duplicateBotMessageText:
        '{user}, повтор найден: сообщение {duplicate_context}. {sanction} Конвейер можно остановить.',
      messageLimitsBotMessageText:
        '{user}, сообщение {message_status}. Причина: {reason}. Лимиты тут не декоративные.',
      nightModeBotMessageText:
        'Ночной режим: {night_window} ({night_timezone}). {night_status} Да, чат тоже спит.',
    },
    system: {
      linkKick:
        '{user}, ссылки не поняли намек, поэтому дальше чат без вас.',
      textFiltersKickCommercial:
        '{user}, реклама пошла по второму кругу, поэтому дальше чат без вас.',
      textFiltersKickProfanity:
        '{user}, запас грубой лексики закончился вместе с доступом к чату.',
      textFiltersKickGeneric:
        '{user}, нарушения решили повториться, а чат решил обойтись без вас.',
      topicExplainAnnouncement:
        '{user}, объявление {message_status}. Причина: {reason}. Формат тут не для красоты.',
      topicExplainMessage:
        '{user}, сообщение {message_status}. Причина: {reason}. Формат все-таки обязателен.',
      topicWarn:
        '{user}, предупреждение зафиксировано. Причина: {reason}. Коллекцию собирать не надо.',
      topicKickAnnouncement:
        '{user}, объявления снова мимо формы, поэтому дальше чат без вас.',
      topicKickMessage:
        '{user}, сообщения снова мимо формы, поэтому дальше чат без вас.',
      topicBan:
        '{user}, тайм-аут на {ban_duration}. Причина: {reason}. Пауза тут к месту.',
      banNotice:
        '{user}, тайм-аут на {ban_duration}. Возвращайтесь без новых сюжетов.',
      messageLimitsWarn:
        '{user}, предупреждение зафиксировано. Причина: {reason}. Лимиты тут всерьез.',
      messageLimitsKick:
        '{user}, ограничения снова проигнорированы, поэтому дальше чат без вас. Причина: {reason}.',
      messageLimitsBan:
        '{user}, тайм-аут на {ban_duration}. Причина: {reason}. Пауза пойдет на пользу.',
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
