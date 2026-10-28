import { ConfigService } from '@nestjs/config';
import {
  MarketplaceNavigationService,
  signMarketplaceLaunch,
} from './marketplace-navigation.service';
import type { MarketplaceButtonPolicyService } from './marketplace-button-policy.service';
import type { MaxBotRegistryService } from '../../max/max-bot-registry.service';
import type { ManagedEntitiesService } from '../../admin/managed-entities.service';
import type { PrismaService } from '../../prisma/prisma.service';

const bot = 'id613070470872_9_bot';
const listing = '26000000-0000-4000-8000-000000000001';
const target = { target: 'manage', kind: 'CHAT', entityId: '-100', listingId: listing } as const;
const user = { userId: '911001', username: null, displayName: null, launchBotId: bot };
function fixture() {
  const buttons = {
    entry: jest
      .fn()
      .mockResolvedValue({
        isOwner: true,
        listing: { id: listing },
        manageUrl: `https://max.ru/id613000037577_3_bot?startapp=manage_chat_${listing}`,
      }),
    identity: jest
      .fn()
      .mockImplementation((actorUserId, kind, entityId, profile) => ({
        actorUserId,
        kind,
        entityId,
        profile,
      })),
  };
  const registry = {
    getBotById: jest.fn().mockReturnValue({ id: bot, state: 'active' }),
    getPublisherBotDescriptor: jest.fn().mockReturnValue({ id: 'publik_test_bot' }),
  };
  const service = new MarketplaceNavigationService(
    new ConfigService({ SVYAZKA_PROFILE_TOKEN: 'a'.repeat(64) }),
    registry as unknown as MaxBotRegistryService,
    buttons as unknown as MarketplaceButtonPolicyService,
    {} as ManagedEntitiesService,
    {} as PrismaService,
  );
  return { service, buttons, registry };
}
describe('Birzhik contextual navigation', () => {
  afterEach(() => jest.restoreAllMocks());
  it('matches the cross-project signed golden vector', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 9, 28));
    const { service } = fixture();
    expect((await service.launch(user, 'moderation', target)).url).toBe(
      'https://max.ru/id613000037577_3_bot?startapp=b1-mc-26000000000040008000000000000001-mc100-id613070470872_9_bot-29887200-p0uOTh07B9ohkXTW',
    );
  });
  it('rejects unknown/disabled sources and another owner, without signing arbitrary URLs', async () => {
    const { service, registry, buttons } = fixture();
    registry.getBotById.mockReturnValue({ id: bot, state: 'disabled' });
    await expect(service.launch(user, 'moderation', target)).rejects.toThrow(
      'Бот запуска недоступен',
    );
    registry.getBotById.mockReturnValue({ id: bot, state: 'active' });
    buttons.entry.mockResolvedValue({ isOwner: false, listing: { id: listing }, manageUrl: null });
    await expect(service.launch(user, 'moderation', target)).rejects.toThrow(
      'Управление профилем недоступно',
    );
    await expect(
      service.launch(user, 'moderation', { ...target, returnUrl: 'https://attacker.invalid' }),
    ).rejects.toThrow();
  });
  it('catalog launch needs no entity lookup and includes only the verified origin bot', async () => {
    const { service, buttons } = fixture();
    const result = await service.launch(user, 'moderation', { target: 'catalog' });
    expect(new URL(result.url).searchParams.get('startapp')).toMatch(
      /^b1-ch-0-mh0-id613070470872_9_bot-/u,
    );
    expect(buttons.entry).not.toHaveBeenCalled();
  });
  it('domain-separates and binds the complete navigation target', () => {
    expect(signMarketplaceLaunch('b1-ch-0-mh0-bot-1', 'a'.repeat(64))).not.toBe(
      signMarketplaceLaunch('b1-ch-0-mh0-bot-2', 'a'.repeat(64)),
    );
  });
});
