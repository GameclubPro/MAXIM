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
      greetingBotMessageText: 'Пользователь {user}: {greeting}. Доступ открыт.',
      linkBotMessageText:
        'Пользователь {user}. Сообщение {message_status}. Причина: {reason}.',
      linkWarnMessageText:
        'Пользователь {user}. {warning}. Причина: {reason}.',
      textFiltersBotMessageText:
        'Пользователь {user}. Сообщение {message_status}. Основание: {reason}.',
      textFiltersWarnMessageText:
        'Пользователь {user}. {warning}. Основание: {reason}.',
      duplicateBotMessageText:
        'Пользователь {user}. Повтор обнаружен: сообщение {duplicate_context}. {sanction}',
      messageLimitsBotMessageText:
        'Пользователь {user}. Сообщение {message_status}. Нарушение: {reason}.',
      nightModeBotMessageText:
        'Ночной режим активен: {night_window} ({night_timezone}). {night_status}',
    },
    system: {
      linkKick: 'Пользователь {user}. Доступ к чату ограничен за повторные ссылки.',
      textFiltersKickCommercial:
        'Пользователь {user}. Доступ к чату ограничен за повторную рекламу.',
      textFiltersKickProfanity:
        'Пользователь {user}. Доступ к чату ограничен за повторную грубую лексику.',
      textFiltersKickGeneric:
        'Пользователь {user}. Доступ к чату ограничен за повторные текстовые нарушения.',
      topicExplainAnnouncement:
        'Пользователь {user}. Объявление {message_status}. Причина: {reason}.',
      topicExplainMessage:
        'Пользователь {user}. Сообщение {message_status}. Причина: {reason}.',
      topicWarn: 'Пользователь {user}. Предупреждение вынесено. Причина: {reason}.',
      topicKickAnnouncement:
        'Пользователь {user}. Доступ к чату ограничен за повторные объявления с неверным форматом.',
      topicKickMessage:
        'Пользователь {user}. Доступ к чату ограничен за повторные сообщения с неверным форматом.',
      topicBan:
        'Пользователь {user}. Применен тайм-аут на {ban_duration}. Причина: {reason}.',
      banNotice:
        'Пользователь {user}. Тайм-аут на {ban_duration}. Возвращайтесь без нарушений.',
      messageLimitsWarn:
        'Пользователь {user}. Предупреждение вынесено. Причина: {reason}.',
      messageLimitsKick:
        'Пользователь {user}. Доступ к чату ограничен за повторные нарушения ограничений. Причина: {reason}.',
      messageLimitsBan:
        'Пользователь {user}. Применен тайм-аут на {ban_duration}. Причина: {reason}.',
    },
  },
  FRIENDLY: {
    editable: {
      greetingBotMessageText: 'Привет, {user} 🙂 Рады видеть тебя в чате.',
      linkBotMessageText:
        '{user}, сообщение {message_status}: {reason}. Поправьте и можно снова.',
      linkWarnMessageText:
        '{user}, {warning}. Причина: {reason}. Давайте дальше без ссылок.',
      textFiltersBotMessageText:
        '{user}, сообщение {message_status}: {reason}. Чуть поправьте формулировку и можно снова.',
      textFiltersWarnMessageText:
        '{user}, {warning}. Давайте дальше спокойнее.',
      duplicateBotMessageText:
        '{user}, вижу повтор: сообщение {duplicate_context}. {sanction} Давайте без дублей.',
      messageLimitsBotMessageText:
        '{user}, сообщение {message_status}: {reason}. Поправьте и попробуйте еще раз.',
      nightModeBotMessageText:
        'Сейчас тихий режим 🌙 {night_window} ({night_timezone}). {night_status}',
    },
    system: {
      linkKick:
        '{user}, за повторные ссылки пришлось вывести вас из чата.',
      textFiltersKickCommercial:
        '{user}, за повторную рекламу пришлось вывести вас из чата.',
      textFiltersKickProfanity:
        '{user}, за повторную грубую лексику пришлось вывести вас из чата.',
      textFiltersKickGeneric:
        '{user}, за повторные нарушения пришлось вывести вас из чата.',
      topicExplainAnnouncement:
        '{user}, объявление {message_status}: {reason}. Поправьте формат и можно снова.',
      topicExplainMessage:
        '{user}, сообщение {message_status}: {reason}. Поправьте формат и можно снова.',
      topicWarn:
        '{user}, предупреждение: {reason}. Давайте дальше аккуратнее.',
      topicKickAnnouncement:
        '{user}, за повторные объявления не по формату пришлось вывести вас из чата.',
      topicKickMessage:
        '{user}, за повторные сообщения не по формату пришлось вывести вас из чата.',
      topicBan: '{user}, тайм-аут на {ban_duration}. Причина: {reason}.',
      banNotice:
        '{user}, тайм-аут на {ban_duration}. Возвращайтесь спокойно.',
      messageLimitsWarn:
        '{user}, предупреждение: {reason}. Давайте без повторов.',
      messageLimitsKick:
        '{user}, за повторные нарушения ограничений пришлось вывести вас из чата. Причина: {reason}.',
      messageLimitsBan:
        '{user}, тайм-аут на {ban_duration}. Причина: {reason}.',
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
