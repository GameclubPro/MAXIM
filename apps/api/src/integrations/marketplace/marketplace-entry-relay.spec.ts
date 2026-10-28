import { ConfigService } from '@nestjs/config';
import { MarketplaceButtonPolicyService } from './marketplace-button-policy.service';
import type { MarketplaceAccessService } from './marketplace-access.service';
import type { MarketplaceStateService } from './marketplace-state.service';
import type { PrismaService } from '../../prisma/prisma.service';
const input = {
  actorUserId: '911001',
  entityId: '-100',
  kind: 'CHAT',
  profile: 'moderation',
} as const;
const listing = '26000000-0000-4000-8000-000000000001';
const body = () => ({
  entityId: '-100',
  kind: 'CHAT',
  profile: 'moderation',
  publicState: 'PUBLIC',
  isOwner: false,
  canCreate: false,
  manageUrl: null,
  listing: {
    id: listing,
    ownershipKey: 'a'.repeat(64),
    title: 'Synthetic',
    publicUrl: `https://max.ru/id613000037577_3_bot?startapp=listing_chat_${listing}`,
    profileOnly: false,
  },
  connectUrl: 'https://max.ru/id613000037577_3_bot?startapp=connect_chat_-100',
  checkedAt: new Date().toISOString(),
  validUntil: new Date(Date.now() + 299_000).toISOString(),
});
describe('Birzhik read-only entry relay boundary', () => {
  afterEach(() => jest.restoreAllMocks());
  const service = () =>
    new MarketplaceButtonPolicyService(
      {} as PrismaService,
      new ConfigService({ SVYAZKA_PROFILE_TOKEN: 'a'.repeat(64) }),
      {} as MarketplaceStateService,
      {} as MarketplaceAccessService,
    );
  it('accepts a public non-owner profile without granting owner management', async () => {
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify(body()), { status: 200 }));
    const entry = await service().readEntry(input);
    expect(entry.isOwner).toBe(false);
    expect(entry.manageUrl).toBeNull();
  });
  it.each(['wrong-entity', 'owner-link', 'arbitrary-link', 'long-proof'] as const)(
    'rejects %s',
    async (kind) => {
      const result = body();
      if (kind === 'wrong-entity') result.entityId = '-200';
      if (kind === 'owner-link')
        Object.assign(result, {
          manageUrl: `https://max.ru/id613000037577_3_bot?startapp=manage_chat_${listing}`,
        });
      if (kind === 'arbitrary-link') result.listing.publicUrl = 'https://attacker.invalid';
      if (kind === 'long-proof') result.validUntil = new Date(Date.now() + 86400_000).toISOString();
      jest
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(new Response(JSON.stringify(result), { status: 200 }));
      await expect(service().readEntry(input)).rejects.toThrow('Не удалось проверить профиль');
    },
  );
});
