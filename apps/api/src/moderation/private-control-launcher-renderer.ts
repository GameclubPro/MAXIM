import {
  BOT_START_APP_LINE,
  buildBotStartIntroLines,
  buildBotStartQuickActionText,
} from '../common/bot-start-greeting';
import { buildUserAgreementShortNotice } from '../common/user-agreement-notice';
import type { MaxMessageButton } from '../max/max-client.service';
import type { ActiveBotSpeechProfile, PrivateView } from './private-control.types';

export type PrivateMiniappMovedViewInput = {
  title: string;
  description: string;
  entityLabel: string;
  entityTitle?: string | null;
  launchButton: MaxMessageButton;
  backButton?: MaxMessageButton | null;
  footerButtons: MaxMessageButton[][];
};

export type PrivateLauncherHomeViewInput = {
  profile: ActiveBotSpeechProfile;
  appBaseUrl?: string | null;
  notice?: string | null;
  footerButtons: MaxMessageButton[][];
};

export type PrivateLauncherIntroViewInput = {
  profile: ActiveBotSpeechProfile;
  appBaseUrl?: string | null;
  footerButtons: MaxMessageButton[][];
};

export function renderPrivateMiniappMovedView(
  input: PrivateMiniappMovedViewInput,
): PrivateView {
  const lines = [
    privateMarkdownTitle(input.title),
    '',
    ...(input.entityTitle
      ? [`${input.entityLabel}: ${escapePrivateMarkdown(input.entityTitle)}`]
      : []),
    input.description,
    'В боте оставлены только базовые действия: принять текст, фото или видео и подтвердить публикацию.',
  ];

  return {
    text: lines.join('\n'),
    options: {
      buttons: [
        [input.launchButton],
        ...(input.backButton ? [[input.backButton]] : []),
        ...input.footerButtons,
      ],
      textFormat: 'markdown',
    },
  };
}

export function renderPrivateLauncherHomeView(
  input: PrivateLauncherHomeViewInput,
): PrivateView {
  const lines = [
    privateMarkdownTitle(input.profile.characterName),
    '',
    BOT_START_APP_LINE,
    buildUserAgreementShortNotice(input.appBaseUrl),
    buildBotStartQuickActionText(input.profile),
    ...(input.notice ? ['', `Статус: ${escapePrivateMarkdown(input.notice)}`] : []),
  ];

  return {
    text: lines.join('\n'),
    options: {
      buttons: input.footerButtons,
      textFormat: 'markdown',
    },
  };
}

export function renderPrivateLauncherIntroView(
  input: PrivateLauncherIntroViewInput,
): PrivateView {
  const lines = buildBotStartIntroLines(input.profile, privateMarkdownTitle, {
    appBaseUrl: input.appBaseUrl,
  });

  return {
    text: lines.join('\n'),
    options: {
      buttons: input.footerButtons,
      textFormat: 'markdown',
    },
  };
}

export function compactPrivateText(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`;
}

export function privateMarkdownTitle(title: string): string {
  return `**${escapePrivateMarkdown(title)}**`;
}

export function escapePrivateMarkdown(value: string): string {
  return value.replace(/([\\_*[\]()`])/g, '\\$1');
}

export function escapePrivateHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function escapePrivateHtmlAttribute(value: string): string {
  return escapePrivateHtml(value);
}
