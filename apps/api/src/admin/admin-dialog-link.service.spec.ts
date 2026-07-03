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
