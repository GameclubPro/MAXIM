import type { BotSpeechPersona } from '@maxim/contracts/bot-speech';
import { buildUserAgreementStartNotice } from './user-agreement-notice';

export type BotStartSpeechProfile = {
  persona: BotSpeechPersona;
  characterName: string;
};

export const BOT_START_APP_LINE = 'Настройки модерации чатов и каналов доступны в приложении.';

export const BOT_PRIVATE_MENU_APP_LINE =
  'Настройки модерации чатов и каналов доступны в приложении.';

export function buildBotStartIntroLines(
  profile: BotStartSpeechProfile,
  renderTitle: (title: string) => string,
  options: { appBaseUrl?: string | null } = {},
): string[] {
  const userAgreementNotice = buildUserAgreementStartNotice(options.appBaseUrl);

  if (isRexSpeechProfile(profile)) {
    return [
      renderTitle(`${profile.characterName} на посту.`),
      '',
      'Помогает администраторам держать чаты и каналы в порядке: замечает спам, опасные ссылки, мат, дубли сообщений и другие нарушения.',
      '',
      BOT_START_APP_LINE,
      '',
      userAgreementNotice,
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
    userAgreementNotice,
    '',
    'Если понадобится помощь, техподдержка ниже.',
  ];
}

export function buildBotStartQuickActionText(_profile: BotStartSpeechProfile): string {
  return 'Посты и автопостинг теперь в боте Публик.';
}

function isRexSpeechProfile(profile: BotStartSpeechProfile): boolean {
  const normalizedName = profile.characterName.trim().toLocaleLowerCase('ru-RU');
  return normalizedName.includes('рэкс') || normalizedName.includes('рекс');
}
