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

  it('resolves multiple additional bots without collapsing the registry to a pair', () => {
    const bots = buildResolvedMaxBotConfigs({
      defaultBot: {
        id: 'id613002203036_bot',
        token: 'token-primary-123456',
        webhookSecretPath: 'primary-webhook-path-123456',
        webhookHeaderSecret: 'primary-webhook-header-123456',
      },
      additionalBotsJson: JSON.stringify([
        {
          id: 'id613002203036_4_bot',
          label: 'Майор Максимова',
          characterName: 'Майор Максимова',
          speechPersona: 'female',
          token: 'token-secondary-123456',
          webhookSecretPath: 'secondary-webhook-path-123456',
          webhookHeaderSecret: 'secondary-webhook-header-123456',
          state: 'active',
        },
        {
          id: 'id613002203036_5_bot',
          label: 'Рэкс',
          characterName: 'Рэкс',
          speechPersona: 'male',
          token: 'token-rex-123456',
          webhookSecretPath: 'rex-webhook-path-123456',
          webhookHeaderSecret: 'rex-webhook-header-123456',
          state: 'active',
        },
      ]),
    });

    expect(bots.map((bot) => bot.id)).toEqual([
      'id613002203036_bot',
      'id613002203036_4_bot',
      'id613002203036_5_bot',
    ]);
    expect(bots.at(2)).toMatchObject({
      label: 'Рэкс',
      characterName: 'Рэкс',
      speechPersona: 'male',
      state: 'active',
      visibleInAdmin: true,
      isDefault: false,
    });
  });
});
