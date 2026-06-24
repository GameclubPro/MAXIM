import type { MaxMessageButton } from '../max/max-client.service';
import {
  compactPrivateText,
  escapePrivateHtml,
  escapePrivateMarkdown,
  privateMarkdownTitle,
  renderPrivateLauncherHomeView,
  renderPrivateLauncherIntroView,
  renderPrivateMiniappMovedView,
} from './private-control-launcher-renderer';

const appButton: MaxMessageButton = {
  type: 'open_app',
  text: '📱 Приложение',
  webApp: '/app',
};

const supportButton: MaxMessageButton = {
  type: 'link',
  text: '🆘 Поддержка',
  url: 'https://example.test/support',
};

const backButton: MaxMessageButton = {
  type: 'callback',
  text: '↩️ Назад',
  payload: 'pc:back',
};

describe('private control launcher renderer', () => {
  it('renders launcher home copy from the active bot profile', () => {
    const view = renderPrivateLauncherHomeView({
      profile: {
        persona: 'female',
        characterName: 'Майор Максимова',
      },
      appBaseUrl: 'https://major-maksimov.ru',
      footerButtons: [[appButton], [supportButton]],
    });

    expect(view.text).toContain('**Майор Максимова**');
    expect(view.text).toContain(
      'Все настройки, модерация, публикации и работа с каналами доступны в приложении.',
    );
    expect(view.text).toContain(
      'Документы: [пользовательское соглашение](https://major-maksimov.ru/app/legal/agreement)',
    );
    expect(view.text).toContain('Я готова быстро принять текст, фото или видео для публикации.');
    expect(view.options).toEqual({
      buttons: [[appButton], [supportButton]],
      textFormat: 'markdown',
    });
  });

  it('escapes markdown in launcher dynamic fields without changing existing semantics', () => {
    const view = renderPrivateLauncherHomeView({
      profile: {
        persona: 'male',
        characterName: 'Майор *[test](x)*',
      },
      notice: 'chat_(42) `ok`',
      footerButtons: [],
    });

    expect(view.text).toContain('**Майор \\*\\[test\\]\\(x\\)\\***');
    expect(view.text).toContain('Статус: chat\\_\\(42\\) \\`ok\\`');
  });

  it('renders one-time launcher intro with supplied footer buttons', () => {
    const view = renderPrivateLauncherIntroView({
      profile: {
        persona: 'neutral',
        characterName: 'Рэкс',
      },
      appBaseUrl: 'https://major-maksimov.ru',
      footerButtons: [[appButton], [supportButton]],
    });

    expect(view.text).toContain('**Рэкс на посту.**');
    expect(view.text).toContain('Помогает администраторам держать чаты и каналы в порядке');
    expect(view.text).toContain(
      '[пользовательское соглашение](https://major-maksimov.ru/app/legal/agreement)',
    );
    expect(view.options).toEqual({
      buttons: [[appButton], [supportButton]],
      textFormat: 'markdown',
    });
  });

  it('renders mini app moved screens from prebuilt buttons and resolved titles', () => {
    const view = renderPrivateMiniappMovedView({
      title: 'Настройки *перенесены*',
      description: 'Основные настройки доступны в приложении.',
      entityLabel: 'Чат',
      entityTitle: 'Chat [42]',
      launchButton: appButton,
      backButton,
      footerButtons: [[supportButton]],
    });

    expect(view.text).toBe(
      [
        '**Настройки \\*перенесены\\***',
        '',
        'Чат: Chat \\[42\\]',
        'Основные настройки доступны в приложении.',
        'В боте оставлены только базовые действия: принять текст, фото или видео и подтвердить публикацию.',
      ].join('\n'),
    );
    expect(view.options).toEqual(
      expect.objectContaining({
        buttons: [[appButton], [backButton], [supportButton]],
        textFormat: 'markdown',
      }),
    );
  });

  it('omits empty entity and back rows for mini app moved screens', () => {
    const view = renderPrivateMiniappMovedView({
      title: 'Активность открывается в mini app',
      description: 'События доступны в mini app.',
      entityLabel: 'Канал',
      entityTitle: null,
      launchButton: appButton,
      backButton: null,
      footerButtons: [],
    });

    expect(view.text).not.toContain('Канал:');
    expect(view.options).toEqual(
      expect.objectContaining({
        buttons: [[appButton]],
      }),
    );
  });

  it('keeps private render primitive behavior stable', () => {
    expect(compactPrivateText('  Очень    длинный текст  ', 11)).toBe('Очень длин…');
    expect(privateMarkdownTitle('A_B')).toBe('**A\\_B**');
    expect(escapePrivateMarkdown('\\_*[]()`')).toBe('\\\\\\_\\*\\[\\]\\(\\)\\`');
    expect(escapePrivateHtml(`<a title="x&y">'z'</a>`)).toBe(
      '&lt;a title=&quot;x&amp;y&quot;&gt;&#39;z&#39;&lt;/a&gt;',
    );
  });
});
