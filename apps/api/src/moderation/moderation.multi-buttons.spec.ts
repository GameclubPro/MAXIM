import { ModerationService } from './moderation.service';

type ModerationServicePrivateAccess = {
  buildBotMessageOptions: (
    chatId: string,
    rawButtons: unknown,
    buttonEnabled: boolean,
    buttonUrl: string,
    buttonText: string,
    rulesButtonEnabled?: boolean,
    rulesPublishedUrl?: string | null,
    rulesPublishedMessageId?: string | null,
  ) => unknown;
};

function createService(): ModerationService {
  return new ModerationService(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    undefined,
    undefined,
    {
      get: jest.fn().mockReturnValue(undefined),
    } as never,
  );
}

describe('ModerationService button normalization', () => {
  it('chunks configured buttons into rows of three for bot messages', () => {
    const service = createService();
    const privateAccess = service as unknown as ModerationServicePrivateAccess;

    const result = privateAccess.buildBotMessageOptions(
      'chat-1',
      [
        { text: 'Один', url: 'https://max.ru/one' },
        { text: 'Два', url: 'https://max.ru/two' },
        { text: 'Три', url: 'https://max.ru/three' },
        { text: 'Четыре', url: 'https://max.ru/four' },
      ],
      true,
      '',
      '',
    );

    expect(result).toEqual({
      buttons: [
        [
          { text: 'Один', url: 'https://max.ru/one' },
          { text: 'Два', url: 'https://max.ru/two' },
          { text: 'Три', url: 'https://max.ru/three' },
        ],
        [{ text: 'Четыре', url: 'https://max.ru/four' }],
      ],
    });
  });

  it('falls back to the legacy button fields when stored arrays are empty', () => {
    const service = createService();
    const privateAccess = service as unknown as ModerationServicePrivateAccess;

    const result = privateAccess.buildBotMessageOptions(
      'chat-1',
      [],
      true,
      'https://max.ru/channel/rules',
      'Правила',
    );

    expect(result).toEqual({
      button: {
        text: 'Правила',
        url: 'https://max.ru/channel/rules',
      },
    });
  });
});
