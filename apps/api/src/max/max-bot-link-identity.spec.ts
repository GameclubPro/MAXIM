import { ConfigService } from '@nestjs/config';
import { MaxBotRegistryService } from './max-bot-registry.service';
import { MaxBotLinkService } from './max-bot-link.service';

describe('exact historical moderation bot identity', () => {
  const major = 'id613002203036_bot';
  const publisher = 'id613002203036_2_bot';
  function service(role = 'moderation') {
    const registry = new MaxBotRegistryService(
      new ConfigService({
        APP_ROLE: role,
        MAX_BOT_ID: role === 'publisher' ? publisher : major,
        MAX_BOT_STATE: role === 'publisher' ? 'active' : 'disabled',
        MAX_BOTS_JSON:
          role === 'publisher'
            ? undefined
            : JSON.stringify([
                {
                  id: 'active-entry-bot',
                  token: 'fixture-entry-token',
                  webhookSecretPath: 'fixture-entry-path',
                  webhookHeaderSecret: 'fixture-entry-header',
                  state: 'active',
                },
              ]),
        MAX_BOT_TOKEN: 'fixture-token',
        MAX_WEBHOOK_SECRET_PATH: 'fixture-path',
        MAX_WEBHOOK_HEADER_SECRET: 'fixture-header',
        MAX_PUBLISHER_BOT_ID: publisher,
      }),
    );
    const links = Object.create(MaxBotLinkService.prototype) as MaxBotLinkService;
    Object.defineProperty(links, 'botRegistry', { value: registry });
    return { links, registry };
  }

  it('retains exact Major ownership independently of current execution state', () => {
    const { links } = service();
    expect(links.getExecutableBotById(major)).toBeNull();
    expect(links.isRegisteredModerationBotId(major)).toBe(true);
    expect(links.isRegisteredModerationBotId('613002203036')).toBe(false);
    expect(links.isRegisteredModerationBotId(` ${major}`)).toBe(false);
    expect(links.isRegisteredModerationBotId('unknown')).toBe(false);
  });

  it.each(['moderation', 'publisher'])('excludes Publisher receipts in the %s runtime', (role) => {
    const { links, registry } = service(role);
    expect(registry.resolveBotIdFromUserId(publisher)).toBe(publisher);
    expect(links.isRegisteredModerationBotId(publisher)).toBe(false);
  });
});
