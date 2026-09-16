import { ConfigService } from '@nestjs/config';
import { MaxBotLinkService } from './max-bot-link.service';
import { MaxBotRegistryService } from './max-bot-registry.service';

function fixture(
  role: 'admin' | 'ingress' | 'action' | 'publisher',
  publisherId = 'se14088825_bot',
) {
  const registry = new MaxBotRegistryService(
    new ConfigService({
      APP_ROLE: role,
      APP_BASE_URL: 'https://major-maksimov.ru',
      MAX_BOT_ID: role === 'publisher' ? publisherId : 'major_bot',
      MAX_ENTRY_BOT_ID: role === 'publisher' ? publisherId : 'major_bot',
      MAX_BOT_TOKEN: 'test-runtime-token',
      MAX_WEBHOOK_SECRET_PATH: 'test-path',
      MAX_WEBHOOK_HEADER_SECRET: 'test-header',
      MAX_PUBLISHER_BOT_ID: publisherId,
    }),
  );
  return {
    registry,
    links: new MaxBotLinkService(
      {} as never,
      registry,
      { getActiveBotId: () => 'major_bot' } as never,
      {} as never,
    ),
  };
}

describe('Exact Publisher links without action credentials', () => {
  it.each(['admin', 'ingress', 'action', 'publisher'] as const)(
    'keeps Publisher links exact in %s',
    (role) => {
      const { links, registry } = fixture(role);
      expect(links.buildPublisherBotUrlSync()).toBe('https://max.ru/se14088825_bot');
      expect(links.buildPublisherBotStartUrlSync('vk_review')).toBe(
        'https://max.ru/se14088825_bot?start=vk_review',
      );
      expect(links.buildPublisherMiniappStartUrlSync('mr-route')).toBe(
        'https://max.ru/se14088825_bot?startapp=mr-route',
      );
      if (role !== 'publisher') {
        expect(registry.getBotById('se14088825_bot')).toBeNull();
        expect(registry.getValidationTokensForBot('se14088825_bot')).toEqual([]);
        expect(links.buildBotStartUrlSync('start')).toBe('https://max.ru/major_bot?start=start');
      }
    },
  );

  it('uses the configured Publisher descriptor rather than a hardcoded public alias', () => {
    const { links } = fixture('admin', 'custom_publisher_bot');
    expect(links.buildPublisherBotStartUrlSync('vk_review')).toBe(
      'https://max.ru/custom_publisher_bot?start=vk_review',
    );
  });

  it('preserves MAX payload validation without falling back to a different bot', () => {
    const { links } = fixture('admin');
    for (const payload of ['', 'a'.repeat(129), 'vk_review&startapp=other']) {
      expect(links.buildPublisherBotStartUrlSync(payload)).toBeNull();
    }
    for (const payload of ['', 'a'.repeat(513), '/publisher/channel/1']) {
      expect(links.buildPublisherMiniappStartUrlSync(payload)).toBeNull();
    }
  });
});
