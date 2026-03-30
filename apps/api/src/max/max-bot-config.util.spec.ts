import { buildResolvedMaxBotConfigs, parseAdditionalMaxBotsJson } from './max-bot-config.util';

describe('max bot config util', () => {
  it('defaults the primary bot to male speech persona and legacy character name', () => {
    const [bot] = buildResolvedMaxBotConfigs({
      defaultBot: {
        id: 'id613002203036_bot',
        token: 'token-primary-123456',
        webhookSecretPath: 'secret-path-123456',
        webhookHeaderSecret: 'header-secret-123456',
      },
    });

    expect(bot?.speechPersona).toBe('male');
    expect(bot?.characterName).toBe('Майор Максимов');
  });

  it('parses dormant additional bots with explicit female persona metadata', () => {
    const [bot] = parseAdditionalMaxBotsJson(
      JSON.stringify([
        {
          id: 'id700000000001_bot',
          label: 'Женский бот',
          characterName: 'Капитан Максимова',
          speechPersona: 'female',
          token: 'token-secondary-123456',
          webhookSecretPath: 'webhook-path-123456',
          webhookHeaderSecret: 'webhook-header-123456',
          state: 'dormant',
        },
      ]),
    );

    expect(bot).toMatchObject({
      id: 'id700000000001_bot',
      label: 'Женский бот',
      characterName: 'Капитан Максимова',
      speechPersona: 'female',
      state: 'dormant',
    });
  });
});
