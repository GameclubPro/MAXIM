import type { BotSpeechPersona } from '@maxim/contracts/bot-speech';
import { USER_AGREEMENT_START_NOTICE } from './user-agreement-notice';

export type BotStartSpeechProfile = {
  persona: BotSpeechPersona;
  characterName: string;
};

export const BOT_START_APP_LINE =
  'Все настройки, модерация, публикации и работа с каналами доступны в приложении.';

export const BOT_PRIVATE_MENU_APP_LINE =
  'Открывайте приложение для настроек, модерации, публикаций и работы с каналами.';

export function buildBotStartIntroLines(
  profile: BotStartSpeechProfile,
  renderTitle: (title: string) => string,
): string[] {
  if (isRexSpeechProfile(profile)) {
    return [
      renderTitle(`${profile.characterName} на посту.`),
      '',
      'Помогает администраторам держать чаты и каналы в порядке: замечает спам, опасные ссылки, мат, дубли сообщений и другие нарушения.',
      '',
      BOT_START_APP_LINE,
      '',
      USER_AGREEMENT_START_NOTICE,
      '',
      'Если понадобится помощь, техподдержка ниже.',
    ];
  }

  return [
    renderTitle(`${profile.characterName} на связи.`),
    '',
    'Я помогаю администраторам держать чаты и каналы в порядке: фильтрую спам, опасные ссылки, мат, дубли сообщений и другие нарушения.',
    '',
    BOT_START_APP_LINE,
    '',
    USER_AGREEMENT_START_NOTICE,
    '',
    'Если понадобится помощь, техподдержка ниже.',
  ];
}

export function buildBotStartQuickActionText(profile: BotStartSpeechProfile): string {
  if (isRexSpeechProfile(profile)) {
    return 'Быстро замечает новые задачи и помогает держать порядок.';
  }

  if (profile.persona === 'female') {
    return 'Я готова быстро принять текст, фото или видео для публикации.';
  }

  if (profile.persona === 'neutral') {
    return 'Быстро приму текст, фото или видео для публикации.';
  }

  return 'Я готов быстро принять текст, фото или видео для публикации.';
}

function isRexSpeechProfile(profile: BotStartSpeechProfile): boolean {
  const normalizedName = profile.characterName.trim().toLocaleLowerCase('ru-RU');
  return normalizedName.includes('рэкс') || normalizedName.includes('рекс');
}
