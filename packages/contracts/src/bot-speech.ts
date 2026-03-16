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
      greetingBotMessageText: 'Пользователь {user}, доступ в чат предоставлен. {greeting}.',
      linkBotMessageText:
        'Пользователь {user}, сообщение {message_status}. Причина: {reason}. Исправьте сообщение и отправьте повторно.',
      linkWarnMessageText:
        'Пользователь {user}, {warning}. Причина: {reason}. Повтор приведет к ограничению.',
      textFiltersBotMessageText:
        'Пользователь {user}, сообщение {message_status}. Причина: {reason}. Исправьте сообщение и отправьте повторно.',
      textFiltersWarnMessageText:
        'Пользователь {user}, {warning}. Нарушение зафиксировано. Следующее нарушение приведет к ограничению.',
      duplicateBotMessageText:
        'Пользователь {user}, обнаружен повтор: сообщение {duplicate_context}. {sanction} Повторяющиеся сообщения в этом чате запрещены.',
      messageLimitsBotMessageText:
        'Пользователь {user}, сообщение {message_status}. Причина: {reason}. Исправьте сообщение и отправьте повторно.',
      nightModeBotMessageText:
        'Ночной режим активен. Интервал: {night_window} ({night_timezone}). {night_status}',
    },
    system: {
      linkKick: 'Пользователь {user}, за повторную отправку ссылок доступ к чату ограничен.',
      textFiltersKickCommercial:
        'Пользователь {user}, за повторную рекламу доступ к чату ограничен.',
      textFiltersKickProfanity:
        'Пользователь {user}, за повторную грубую лексику доступ к чату ограничен.',
      textFiltersKickGeneric:
        'Пользователь {user}, за повторное нарушение текстовых правил доступ к чату ограничен.',
      topicExplainAnnouncement:
        'Пользователь {user}, объявление {message_status}. Причина: {reason}. Исправьте формат и отправьте снова.',
      topicExplainMessage:
        'Пользователь {user}, сообщение {message_status}. Причина: {reason}. Исправьте формат и отправьте снова.',
      topicWarn: 'Пользователь {user}, вынесено предупреждение. Причина: {reason}.',
      topicKickAnnouncement:
        'Пользователь {user}, за повторные объявления с неверным форматом доступ к чату ограничен.',
      topicKickMessage:
        'Пользователь {user}, за повторные сообщения с неверным форматом доступ к чату ограничен.',
      topicBan:
        'Пользователь {user}, применен тайм-аут на {ban_duration}. Причина: {reason}.',
      banNotice:
        'Пользователь {user}, применен тайм-аут на {ban_duration}. Возвращайтесь без нарушений.',
      messageLimitsWarn:
        'Пользователь {user}, вынесено предупреждение. Причина: {reason}.',
      messageLimitsKick:
        'Пользователь {user}, за повторное нарушение ограничений доступ к чату ограничен. Причина: {reason}.',
      messageLimitsBan:
        'Пользователь {user}, применен тайм-аут на {ban_duration}. Причина: {reason}.',
    },
  },
  FRIENDLY: {
    editable: {
      greetingBotMessageText: '{user}, привет. Добро пожаловать в чат.',
      linkBotMessageText:
        '{user}, сообщение {message_status}, потому что {reason}. Поправьте его и возвращайтесь в диалог.',
      linkWarnMessageText:
        '{user}, {warning}, потому что {reason}. Давайте дальше без повторов.',
      textFiltersBotMessageText:
        '{user}, сообщение {message_status}, потому что {reason}. Поправьте его, и можно спокойно продолжать.',
      textFiltersWarnMessageText:
        '{user}, {warning}. Давайте дальше спокойно и по правилам.',
      duplicateBotMessageText:
        '{user}, вижу повтор: сообщение {duplicate_context}. {sanction} Давайте дальше без дублей.',
      messageLimitsBotMessageText:
        '{user}, сообщение {message_status}, потому что {reason}. Поправьте его и можно продолжать.',
      nightModeBotMessageText:
        'Сейчас в чате действует ночной режим. Интервал: {night_window} ({night_timezone}). {night_status}',
    },
    system: {
      linkKick:
        '{user}, за повторные ссылки пришлось временно вывести вас из чата. Если вернетесь, давайте уже без них.',
      textFiltersKickCommercial:
        '{user}, за повторную рекламу пришлось временно вывести вас из чата.',
      textFiltersKickProfanity:
        '{user}, за повторную грубую лексику пришлось временно вывести вас из чата.',
      textFiltersKickGeneric:
        '{user}, за повторные нарушения текстовых правил пришлось временно вывести вас из чата.',
      topicExplainAnnouncement:
        '{user}, объявление {message_status}, потому что {reason}. Поправьте формат, и все будет нормально.',
      topicExplainMessage:
        '{user}, сообщение {message_status}, потому что {reason}. Поправьте формат, и можно продолжать.',
      topicWarn:
        '{user}, фиксирую предупреждение: {reason}. Давайте дальше без повторения.',
      topicKickAnnouncement:
        '{user}, за повторные объявления не по формату пришлось временно вывести вас из чата.',
      topicKickMessage:
        '{user}, за повторные сообщения не по формату пришлось временно вывести вас из чата.',
      topicBan: '{user}, пришлось выдать тайм-аут на {ban_duration}. Причина: {reason}.',
      banNotice:
        '{user}, выдан тайм-аут на {ban_duration}. Возвращайтесь уже без нарушений.',
      messageLimitsWarn:
        '{user}, фиксирую предупреждение: {reason}. Давайте дальше аккуратнее.',
      messageLimitsKick:
        '{user}, за повторные нарушения ограничений пришлось временно вывести вас из чата. Причина: {reason}.',
      messageLimitsBan:
        '{user}, пришлось выдать тайм-аут на {ban_duration}. Причина: {reason}.',
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
        '{user}, добро пожаловать. Да, здесь тоже есть правила, но вы справитесь.',
      linkBotMessageText:
        '{user}, сообщение {message_status}. Причина: {reason}. План был дерзкий, теперь давайте нормально.',
      linkWarnMessageText:
        '{user}, {warning}. Причина простая: {reason}. Эксперимент засчитан, повторять не надо.',
      textFiltersBotMessageText:
        '{user}, сообщение {message_status}. Причина: {reason}. Импровизация смелая, но давайте без нее.',
      textFiltersWarnMessageText:
        '{user}, {warning}. Давайте без этого стендапа на ровном месте.',
      duplicateBotMessageText:
        '{user}, повтор найден: сообщение {duplicate_context}. {sanction} Серийное производство сообщений сегодня закрыто.',
      messageLimitsBotMessageText:
        '{user}, сообщение {message_status}. Причина: {reason}. Формат решил пойти своим путем, но не в этот раз.',
      nightModeBotMessageText:
        'Ночной режим включен. Интервал: {night_window} ({night_timezone}). {night_status} Да, даже у чата есть часы работы.',
    },
    system: {
      linkKick:
        '{user}, ссылки упрямо возвращались, поэтому из чата пришлось вывести уже вас.',
      textFiltersKickCommercial:
        '{user}, реклама решила не сдаваться, поэтому с чатом пришлось попрощаться вам.',
      textFiltersKickProfanity:
        '{user}, запас грубой лексики впечатлил, но дальше уже без этого и без чата.',
      textFiltersKickGeneric:
        '{user}, нарушения решили собраться в серию, поэтому дальше чат идет без вас.',
      topicExplainAnnouncement:
        '{user}, объявление {message_status}. Причина: {reason}. Формат притворился необязательным, но нет.',
      topicExplainMessage:
        '{user}, сообщение {message_status}. Причина: {reason}. Формат, как выяснилось, все же существует.',
      topicWarn:
        '{user}, предупреждение зафиксировано. Причина: {reason}. Бумаги я не люблю, но повод был.',
      topicKickAnnouncement:
        '{user}, объявления снова пошли не по форме, поэтому дальше чат обойдется без вас.',
      topicKickMessage:
        '{user}, сообщения снова пошли не по форме, поэтому дальше чат обойдется без вас.',
      topicBan:
        '{user}, оформлен тайм-аут на {ban_duration}. Причина: {reason}. Будет пауза на пересборку формата.',
      banNotice:
        '{user}, оформлен тайм-аут на {ban_duration}. Возвращайтесь уже без творческих нарушений.',
      messageLimitsWarn:
        '{user}, предупреждение зафиксировано. Причина: {reason}. Лимиты, как назло, тоже умеют считать.',
      messageLimitsKick:
        '{user}, ограничения проигнорированы повторно, поэтому чат временно пойдет без вас. Причина: {reason}.',
      messageLimitsBan:
        '{user}, оформлен тайм-аут на {ban_duration}. Причина: {reason}. Иногда пауза работает лучше аргументов.',
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
