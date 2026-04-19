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
    label: 'Коп',
    subtitle: 'спокойный опер',
    description: 'Взрослый тон: сухой юмор, жаргон по делу и порядок без перегиба.',
    iconKey: 'police',
  },
  IRONIC: {
    label: 'Шут',
    subtitle: 'острый язык, но без злобы',
    description: 'Взрослая ирония: коротко, ясно, с подколом по делу и без дешёвого цирка.',
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
        'Здравия, {user} 👮‍♂️ На линии {bot_character_name}. Осваивайтесь спокойно, тут порядок без лишней драмы.',
      linkBotMessageText:
        'Товарищ {user}, ссылку снял с линии 🚨 Тут со ссылками без самодеятельности.',
      linkWarnMessageText:
        'Товарищ {user}, взял на карандаш 📝 По ссылкам тут режим строгий, не доводим до протокола.',
      requiredSubscriptionBotMessageText:
        'Товарищ {user}, вход в эфир через подписку на {channels} 📡 Подпишитесь и заходите снова. Сейчас сообщение: {message_status}.',
      requiredSubscriptionWarnMessageText:
        'Товарищ {user}, это предупреждение 📝 Для сообщений нужна подписка на {channels}.',
      textFiltersBotMessageText:
        'Товарищ {user}, это прикрыл 👮‍♂️ Причина: {reason}. Подправьте по форме и снова в эфир.',
      textFiltersWarnMessageText:
        'Товарищ {user}, взял на карандаш 📝 Причина: {reason}. Дальше без лишнего шума.',
      duplicateBotMessageText: 'Товарищ {user}, вижу повтор 👀 {sanction}',
      messageLimitsBotMessageText:
        'Товарищ {user}, это прикрыл 📏 Причина: {reason}. Подправьте и снова в эфир.',
      nightModeBotMessageText:
        '🌙 Ночной патруль на линии. Чат прикрыт на {night_window} ({night_timezone}). {night_status}',
      nightModeOpenMessageText:
        '☀️ Отбой ночному патрулю. {opening_status} Можно снова в эфир, но без подвигов.',
    },
    system: {
      linkMute: 'Товарищ {user}, по ссылкам пошёл рецидив 🚨 Включаю мут.',
      requiredSubscriptionMute:
        'Товарищ {user}, без подписки на {channels} снова пошли в эфир 📡 Включаю мут.',
      requiredSubscriptionBan:
        'Товарищ {user}, тут уже шлагбаум ⛔ До ручного разбана. Для сообщений нужна подписка на {channels}.',
      textFiltersMuteCommercial: 'Товарищ {user}, реклама пошла по второму кругу 🚨 Включаю мут.',
      textFiltersMuteProfanity: 'Товарищ {user}, по лексике снова занесло 🚨 Включаю мут.',
      textFiltersMuteGeneric: 'Товарищ {user}, нарушения пошли серией 🚨 Включаю мут.',
      topicExplainAnnouncement:
        'Товарищ {user}, объявление прикрыл 👮‍♂️ Причина: {reason}. Подправьте по форме и снова в эфир.',
      topicExplainMessage:
        'Товарищ {user}, сообщение прикрыл 👮‍♂️ Причина: {reason}. Подправьте по форме и снова в эфир.',
      topicWarn: 'Товарищ {user}, взял на карандаш 📝 Причина: {reason}.',
      topicMuteAnnouncement: 'Товарищ {user}, объявления опять мимо формы 🚨 Включаю мут.',
      topicMuteMessage: 'Товарищ {user}, сообщения опять мимо формы 🚨 Включаю мут.',
      topicBan: 'Товарищ {user}, тут уже шлагбаум ⛔ Причина: {reason}. До ручного разбана.',
      muteNotice:
        'Товарищ {user}, включаю тихий режим на {mute_duration} 🔒 До конца срока новые сообщения будут скрываться.',
      messageLimitsWarn: 'Товарищ {user}, взял на карандаш 📝 Причина: {reason}.',
      messageLimitsMute:
        'Товарищ {user}, лимиты снова поехали 🚨 Включаю мут. Причина: {reason}.',
      messageLimitsBan: 'Товарищ {user}, тут уже шлагбаум ⛔ Причина: {reason}. До ручного разбана.',
    },
  },
  IRONIC: {
    editable: {
      greetingBotMessageText:
        '{user}, привет 😏 На связи {bot_character_name}. Осваивайтесь спокойно, а драму оставим сериалам.',
      linkBotMessageText:
        '{user}, ссылку убрал 🔗 Внешний интернет тут сегодня без гастролей.',
      linkWarnMessageText:
        '{user}, это уже предупреждение ⚠️ Со ссылками шутка была понятна с первого раза.',
      requiredSubscriptionBotMessageText:
        '{user}, сначала подпишитесь на {channels} 📡 Потом уже пишите сюда. Порядок скучный, зато рабочий: {message_status}.',
      requiredSubscriptionWarnMessageText:
        '{user}, это уже предупреждение ⚠️ Без подписки на {channels} сообщение всё ещё не проходит. Причина: {reason}.',
      textFiltersBotMessageText:
        '{user}, это убрал 🧹 Причина: {reason}. Мысль можно оставить, подачу лучше освежить.',
      textFiltersWarnMessageText:
        '{user}, это уже предупреждение ⚠️ Причина: {reason}. Острота хороша, пока не спорит с правилами.',
      duplicateBotMessageText: '{user}, мысль уже выходила на сцену 🎭 {sanction}',
      messageLimitsBotMessageText:
        '{user}, это не прошло 📏 Причина: {reason}. Лимиты считают честно, даже без чувства юмора.',
      nightModeBotMessageText:
        '🌙 Ночной режим: {night_window} ({night_timezone}). {night_status} Чату тоже нужен антракт.',
      nightModeOpenMessageText:
        '☀️ Антракт окончен. {opening_status} Можно снова писать, только без лишних соло.',
    },
    system: {
      linkMute: '{user}, со ссылками пошли на бис 🔒 Поэтому теперь мут.',
      requiredSubscriptionMute:
        '{user}, без подписки на {channels} снова вышли в эфир 📡 Поэтому теперь мут.',
      requiredSubscriptionBan:
        '{user}, на этом занавес ⛔ Бан до ручного разбана. Без подписки на {channels} дальше всё равно не взлетит.',
      textFiltersMuteCommercial:
        '{user}, реклама пошла на второй круг 🔒 Поэтому теперь мут.',
      textFiltersMuteProfanity:
        '{user}, лексика снова ушла не туда 🔒 Поэтому теперь мут.',
      textFiltersMuteGeneric: '{user}, спор с правилами снова затянулся 🔒 Поэтому теперь мут.',
      topicExplainAnnouncement:
        '{user}, объявление убрал 🧹 Причина: {reason}. Формат тут не для декора, а для пользы.',
      topicExplainMessage:
        '{user}, сообщение убрал 🧹 Причина: {reason}. Формат тут не для декора, а для пользы.',
      topicWarn:
        '{user}, это уже предупреждение ⚠️ Причина: {reason}.',
      topicMuteAnnouncement: '{user}, объявления снова мимо формата 🔒 Поэтому теперь мут.',
      topicMuteMessage: '{user}, сообщения снова мимо формата 🔒 Поэтому теперь мут.',
      topicBan:
        '{user}, на этом занавес ⛔ Причина: {reason}. Бан до ручного разбана.',
      muteNotice:
        '{user}, мут на {mute_duration} 🔒 До конца срока новые сообщения будут скрываться. Небольшая пауза ещё никому не вредила.',
      messageLimitsWarn:
        '{user}, это уже предупреждение ⚠️ Причина: {reason}. Лимиты считают честно, даже когда это обидно.',
      messageLimitsMute:
        '{user}, с лимитами снова спорим 🔒 Поэтому теперь мут. Причина: {reason}.',
      messageLimitsBan:
        '{user}, на этом занавес ⛔ Причина: {reason}. Бан до ручного разбана.',
    },
  },
};

const BOT_SPEECH_POLICE_FEMALE_PRESET: BotSpeechPreset = {
  editable: {
    greetingBotMessageText:
      'Здравия, {user} 👮‍♀️ На линии {bot_character_name}. Осваивайтесь спокойно, тут порядок без лишней драмы.',
    linkBotMessageText:
      'Товарищ {user}, ссылку сняла с линии 🚨 Тут со ссылками без самодеятельности.',
    linkWarnMessageText:
      'Товарищ {user}, взяла на карандаш 📝 По ссылкам тут режим строгий, не доводим до протокола.',
    requiredSubscriptionBotMessageText:
      'Товарищ {user}, вход в эфир через подписку на {channels} 📡 Подпишитесь и заходите снова. Сейчас сообщение: {message_status}.',
    requiredSubscriptionWarnMessageText:
      'Товарищ {user}, это предупреждение 📝 Для сообщений нужна подписка на {channels}.',
    textFiltersBotMessageText:
      'Товарищ {user}, это прикрыла 👮‍♀️ Причина: {reason}. Подправьте по форме и снова в эфир.',
    textFiltersWarnMessageText:
      'Товарищ {user}, взяла на карандаш 📝 Причина: {reason}. Дальше без лишнего шума.',
    duplicateBotMessageText: 'Товарищ {user}, вижу повтор 👀 {sanction}',
    messageLimitsBotMessageText:
      'Товарищ {user}, это прикрыла 📏 Причина: {reason}. Подправьте и снова в эфир.',
    nightModeBotMessageText:
      '🌙 Ночной патруль на линии. Чат прикрыт на {night_window} ({night_timezone}). {night_status}',
    nightModeOpenMessageText:
      '☀️ Отбой ночному патрулю. {opening_status} Можно снова в эфир, но без подвигов.',
  },
  system: {
    linkMute: 'Товарищ {user}, по ссылкам пошёл рецидив 🚨 Включаю мут.',
    requiredSubscriptionMute:
      'Товарищ {user}, без подписки на {channels} снова пошли в эфир 📡 Включаю мут.',
    requiredSubscriptionBan:
      'Товарищ {user}, тут уже шлагбаум ⛔ До ручного разбана. Для сообщений нужна подписка на {channels}.',
    textFiltersMuteCommercial: 'Товарищ {user}, реклама пошла по второму кругу 🚨 Включаю мут.',
    textFiltersMuteProfanity: 'Товарищ {user}, по лексике снова занесло 🚨 Включаю мут.',
    textFiltersMuteGeneric: 'Товарищ {user}, нарушения пошли серией 🚨 Включаю мут.',
    topicExplainAnnouncement:
      'Товарищ {user}, объявление прикрыла 👮‍♀️ Причина: {reason}. Подправьте по форме и снова в эфир.',
    topicExplainMessage:
      'Товарищ {user}, сообщение прикрыла 👮‍♀️ Причина: {reason}. Подправьте по форме и снова в эфир.',
    topicWarn: 'Товарищ {user}, взяла на карандаш 📝 Причина: {reason}.',
    topicMuteAnnouncement: 'Товарищ {user}, объявления опять мимо формы 🚨 Включаю мут.',
    topicMuteMessage: 'Товарищ {user}, сообщения опять мимо формы 🚨 Включаю мут.',
    topicBan: 'Товарищ {user}, тут уже шлагбаум ⛔ Причина: {reason}. До ручного разбана.',
    muteNotice:
      'Товарищ {user}, включаю тихий режим на {mute_duration} 🔒 До конца срока новые сообщения будут скрываться.',
    messageLimitsWarn: 'Товарищ {user}, взяла на карандаш 📝 Причина: {reason}.',
    messageLimitsMute:
      'Товарищ {user}, лимиты снова поехали 🚨 Включаю мут. Причина: {reason}.',
    messageLimitsBan: 'Товарищ {user}, тут уже шлагбаум ⛔ Причина: {reason}. До ручного разбана.',
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
