import { MAX_CHAT_RULES_TEXT_LENGTH } from '@maxim/contracts';
import { AdminChatRulesTextRuntime } from './admin-chat-rules-text-runtime';
import {
  createAdminChatRulesTextRuntimeContext,
  type AdminChatRulesTextRuntimeContext,
} from './admin-chat-rules-text-runtime-context';

function createRuntime(
  overrides: Partial<AdminChatRulesTextRuntimeContext> = {},
): AdminChatRulesTextRuntime {
  return new AdminChatRulesTextRuntime(
    createAdminChatRulesTextRuntimeContext({
      prisma: {} as never,
      chatContextCache: { invalidate: jest.fn() } as never,
      maxClient: { getChatMemberProfiles: jest.fn() } as never,
      logger: { warn: jest.fn() } as never,
      maxBotTokenValidationSecrets: [],
      getSettings: jest.fn(),
      getDomainAllowlistDetails: jest.fn(),
      resolveRequiredSubscriptionChannelHeaders: jest.fn(),
      resolveUserDisplayNames: jest.fn(),
      resolveChatSettingsReadBotAssignmentData: jest.fn(),
      ...overrides,
    }),
  );
}

describe('AdminChatRulesTextRuntime publication formatting', () => {
  it('does not read allowlist or subscription channels when the authorized settings read fails', async () => {
    const denied = new Error('access revoked');
    const getSettings = jest.fn().mockRejectedValue(denied);
    const getDomainAllowlistDetails = jest.fn();
    const resolveRequiredSubscriptionChannelHeaders = jest.fn();
    const runtime = createRuntime({
      getSettings,
      getDomainAllowlistDetails,
      resolveRequiredSubscriptionChannelHeaders,
    });
    const user = { userId: 'admin-1', username: null, displayName: null, chatTitle: null };
    await expect(runtime.buildAutofilledRulesTextFromCurrentSettings('chat-1', user)).rejects.toBe(
      denied,
    );
    expect(getSettings).toHaveBeenCalledWith('chat-1', user);
    expect(getDomainAllowlistDetails).not.toHaveBeenCalled();
    expect(resolveRequiredSubscriptionChannelHeaders).not.toHaveBeenCalled();
  });

  it('rejects an oversized formatted import instead of truncating its markup', () => {
    const runtime = createRuntime();
    const exact = 'A'.repeat(MAX_CHAT_RULES_TEXT_LENGTH);

    expect(runtime.normalizeImportedRulesText(exact)).toBe(exact);
    expect(runtime.normalizeImportedRulesText(`**${exact}**`)).toBeNull();
  });

  it('renders nested rules formatting as MAX HTML with whitespace intact', async () => {
    const runtime = createRuntime();

    await expect(
      runtime.buildFormattedRulesPublicationText(
        'chat-1',
        '🔥[**_++MAX Docs++_**](https://dev.max.ru/docs-api)\n\n~~Зачеркнутый~~\n\n  Второй абзац с  пробелами',
        {
          textFormat: 'markdown',
          adminContactButtonEnabled: false,
          adminContactButtonUrl: '',
        },
      ),
    ).resolves.toEqual({
      text: '🔥<a href="https://dev.max.ru/docs-api"><strong><em><u>MAX Docs</u></em></strong></a>\n\n<s>Зачеркнутый</s>\n\n&nbsp;&nbsp;Второй абзац с&nbsp;&nbsp;пробелами',
      textFormat: 'html',
    });
  });

  it('renders the appended admin contact mention in the same HTML payload', async () => {
    const runtime = createRuntime();
    const mentionPayload = `pmh-${Buffer.from(
      JSON.stringify({ v: 1, k: 'profile-mention', u: 'admin-1', n: 'Админ' }),
      'utf8',
    ).toString('base64url')}`;

    await expect(
      runtime.buildFormattedRulesPublicationText('chat-1', '**Правила**', {
        textFormat: 'markdown',
        adminContactButtonEnabled: true,
        adminContactButtonUrl: `https://max.ru/id1_bot?start=${mentionPayload}`,
      }),
    ).resolves.toEqual({
      text: '<strong>Правила</strong>\n\nСвязь с админом: <a href="max://user/admin-1">Админ</a>',
      textFormat: 'html',
    });
  });

  it('falls back to bounded MAX markdown and rejects contact overflow', async () => {
    const runtime = createRuntime();
    const exact = '&'.repeat(MAX_CHAT_RULES_TEXT_LENGTH);

    await expect(
      runtime.buildFormattedRulesPublicationText('chat-1', exact, {
        textFormat: 'markdown',
        adminContactButtonEnabled: false,
        adminContactButtonUrl: '',
      }),
    ).resolves.toEqual({ text: exact, textFormat: 'markdown' });
    await expect(
      runtime.buildFormattedRulesPublicationText('chat-1', 'A'.repeat(MAX_CHAT_RULES_TEXT_LENGTH), {
        textFormat: 'markdown',
        adminContactButtonEnabled: true,
        adminContactButtonUrl: 'https://max.ru/admin',
      }),
    ).rejects.toThrow('Текст правил после форматирования слишком длинный');
  });

  it('keeps plain markdown-like punctuation literal like Publik', async () => {
    const runtime = createRuntime();

    await expect(
      runtime.buildFormattedRulesPublicationText('chat-1', '**не жирный**\n# не заголовок', {
        textFormat: 'plain',
        adminContactButtonEnabled: false,
        adminContactButtonUrl: '',
      }),
    ).resolves.toEqual({
      text: '**не жирный**\n# не заголовок',
      textFormat: undefined,
    });
  });

  it('escapes plain rules before adding a formatted admin contact', async () => {
    const runtime = createRuntime();

    await expect(
      runtime.buildFormattedRulesPublicationText('chat-1', '<правила> & **буквально**', {
        textFormat: 'plain',
        adminContactButtonEnabled: true,
        adminContactButtonUrl: 'https://max.ru/admin',
      }),
    ).resolves.toEqual({
      text: '&lt;правила&gt; &amp; **буквально**\n\n<a href="https://max.ru/admin">Связь с админом</a>',
      textFormat: 'html',
    });
  });
});
