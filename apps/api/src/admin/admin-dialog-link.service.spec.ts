import { createHmac } from 'node:crypto';
import { AdminDialogLinkService } from './admin-dialog-link.service';

const THREAD_ID = '12345678-1234-1234-9234-1234567890ab';

function createConfigMock(options: { token?: string; previousToken?: string | null } = {}) {
  return {
    getOrThrow: jest.fn((key: string) => {
      if (key === 'MAX_BOT_TOKEN') {
        return options.token ?? 'test-max-bot-token';
      }
      throw new Error(`Missing key: ${key}`);
    }),
    get: jest.fn((key: string) => {
      if (key === 'MAX_BOT_TOKEN_PREVIOUS') {
        return options.previousToken ?? null;
      }
      if (key === 'APP_BASE_URL') {
        return 'https://major-maksimov.ru';
      }
      if (key === 'MAX_BOT_ID') {
        return '777000_bot';
      }
      if (key === 'MAX_BOT_CONTACT_ID') {
        return '777000';
      }
      return null;
    }),
  };
}

function decodeDialogToken(token: string): { d?: string; s?: string } {
  return JSON.parse(Buffer.from(token.slice('cdt-'.length), 'base64url').toString('utf8')) as {
    d?: string;
    s?: string;
  };
}

describe('AdminDialogLinkService', () => {
  it('builds and parses compact channel suggestion start payloads', () => {
    const service = new AdminDialogLinkService(createConfigMock() as never);

    const startPayload = service.buildChannelSuggestionStartPayload('channel-1', THREAD_ID);

    expect(startPayload).toMatch(/^cds-channel-1\.[a-f0-9]{32}\.[a-f0-9]{24}$/u);
    expect(service.parseChannelSuggestionStartPayload(startPayload)).toMatchObject({
      chatId: 'channel-1',
      token: expect.stringMatching(/^cdt-/u),
    });
  });

  it('accepts compact payloads signed with the previous bot token', () => {
    const oldService = new AdminDialogLinkService(
      createConfigMock({ token: 'old-token' }) as never,
    );
    const newService = new AdminDialogLinkService(
      createConfigMock({ token: 'new-token', previousToken: 'old-token' }) as never,
    );

    const startPayload = oldService.buildChannelSuggestionStartPayload('channel-1', THREAD_ID);

    expect(newService.parseChannelSuggestionStartPayload(startPayload)).toMatchObject({
      chatId: 'channel-1',
      token: expect.stringMatching(/^cdt-/u),
    });
  });

  it('uses the same routed bot token for compact suggestion payloads and dialog tokens', () => {
    const maxBotLinkService = {
      getBotTokenSync: jest.fn((botId?: string | null) =>
        botId?.trim() === 'bot-2' ? 'token-bot-2' : 'token-default',
      ),
      getValidationTokens: jest.fn().mockReturnValue(['token-default', 'token-bot-2']),
    };
    const service = new AdminDialogLinkService(
      createConfigMock({ token: 'token-default' }) as never,
      maxBotLinkService as never,
    );

    const startPayload = service.buildChannelSuggestionStartPayload(
      'channel-1',
      THREAD_ID,
      'bot-2',
    );
    const parsed = service.parseChannelSuggestionStartPayload(startPayload);

    const [, , startSignature] = startPayload.slice('cds-'.length).split('.');
    expect(startSignature).toBe(
      createHmac('sha256', 'token-bot-2')
        .update(`suggest-start:channel-1:${THREAD_ID}`)
        .digest('hex')
        .slice(0, 24),
    );
    expect(maxBotLinkService.getBotTokenSync).toHaveBeenCalledWith('bot-2');
    expect(parsed).toMatchObject({
      chatId: 'channel-1',
      token: expect.stringMatching(/^cdt-/u),
    });

    const parsedToken = decodeDialogToken(parsed!.token);
    expect(parsedToken.s).toBe(
      createHmac('sha256', 'token-bot-2')
        .update(`dialog:channel-1:suggest:${THREAD_ID}`)
        .digest('hex'),
    );
    expect(parsedToken.s).not.toBe(
      createHmac('sha256', 'token-default')
        .update(`dialog:channel-1:suggest:${THREAD_ID}`)
        .digest('hex'),
    );
  });

  it('uses the explicit bot id for bot start URL fallback without the link service', () => {
    const service = new AdminDialogLinkService(createConfigMock() as never);

    expect(service.buildBotStartUrl('profile_payload', 'bot-2')).toBe(
      'https://max.ru/bot-2?start=profile_payload',
    );
  });

  it('parses legacy channel-dialog start payloads for suggestion links', () => {
    const service = new AdminDialogLinkService(createConfigMock() as never);
    const token = 'cdt-legacy-token';
    const encoded = Buffer.from(
      JSON.stringify({
        v: 1,
        k: 'channel-dialog',
        c: 'channel-1',
        m: 'suggest',
        t: token,
      }),
      'utf8',
    ).toString('base64url');

    expect(service.parseChannelSuggestionStartPayload(`cd-${encoded}`)).toEqual({
      chatId: 'channel-1',
      token,
    });
  });
});
