import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import type { MarketplaceProfileRelayResponse } from '@maxim/contracts/marketplace-integration';
import { MarketplaceProfileService } from './marketplace-profile.service';
import type { MarketplaceBindingRow, MarketplaceStateService } from './marketplace-state.service';
import type { MarketplaceAccessService } from './marketplace-access.service';
import type { PrismaService } from '../../prisma/prisma.service';

const bot = 'https://max.ru/id613000037577_3_bot';
describe('marketplace compatible profile presentation relay', () => {
  const binding = {
    id: randomUUID(),
    actor_user_id: '323459159',
    entity_id: '-100',
    kind: 'CHANNEL',
    profile: 'publisher',
    revision: 1,
  } as MarketplaceBindingRow;
  const db = { $executeRaw: jest.fn().mockResolvedValue(1) };
  const service = new MarketplaceProfileService(
    db as unknown as PrismaService,
    new ConfigService({ SVYAZKA_PROFILE_TOKEN: 'fixture-only' }),
    {} as MarketplaceStateService,
    {} as MarketplaceAccessService,
  );
  const response = (): MarketplaceProfileRelayResponse => ({
    bindingId: binding.id,
    entityId: '-100',
    kind: 'CHANNEL',
    revision: 1,
    listing: null,
    choices: { topics: [], regions: [] },
    capabilities: {
      canEdit: true,
      canPublish: false,
      canPause: false,
      publicState: 'DRAFT',
      placementState: 'BOT_REQUIRED',
      manageUrl: null,
      connectUrl: `${bot}?startapp=connect_channel_-100`,
    },
  });
  beforeEach(() => db.$executeRaw.mockClear());
  afterEach(() => jest.restoreAllMocks());
  it.each(['GET', 'POST'] as const)(
    'negotiates additive view fields for %s without changing old payloads',
    async (method) => {
      const result = response();
      const fetch = jest
        .spyOn(global, 'fetch')
        .mockResolvedValue(new Response(JSON.stringify(result), { status: 200 }));
      expect(
        await service.relay(
          binding,
          method === 'GET'
            ? undefined
            : { action: 'pause', requestId: randomUUID(), expectedRevision: 1 },
        ),
      ).toEqual(result);
      expect(fetch).toHaveBeenCalledWith(
        expect.any(URL),
        expect.objectContaining({
          method,
          headers: expect.objectContaining({ 'x-marketplace-profile-view': '2' }),
        }),
      );
    },
  );
  it('persists a snapshot that the previous strict relay schema can read', async () => {
    const result = response();
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify(result), { status: 200 }));
    await service.relay(binding);
    const values = (db.$executeRaw.mock.calls[0] ?? []) as unknown[];
    const json = values.find((value) => typeof value === 'string' && value.startsWith('{'));
    expect(typeof json).toBe('string');
    const stored = JSON.parse(json as string);
    expect(stored).not.toHaveProperty('capabilities');
    const legacy = { ...result };
    delete legacy.capabilities;
    expect(stored).toEqual(legacy);
  });
  it('accepts the previous response without presentation fields during rolling deployment', async () => {
    const result = response();
    delete result.capabilities;
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify(result), { status: 200 }));
    expect(await service.relay(binding)).toEqual(result);
  });
  it.each([
    'https://example.test/?startapp=connect_channel_-100',
    `${bot}?startapp=connect_chat_-100`,
    `${bot}?startapp=connect_channel_-101`,
  ])('rejects an unrelated connection handoff %s', async (connectUrl) => {
    const result = response();
    result.capabilities!.connectUrl = connectUrl;
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify(result), { status: 200 }));
    await expect(service.relay(binding)).rejects.toThrow('Не удалось проверить профиль');
  });
});

describe('marketplace mini-app response compatibility', () => {
  it.each(['get', 'mutate'] as const)('keeps presentation fields opt-in for %s', async (method) => {
    const { MarketplaceProfileController } = await import('./marketplace.controller');
    const response = {
      bindingId: 'test',
      capabilities: { canEdit: true },
      statistics: { state: 'PENDING' },
    };
    const service = {
      get: jest.fn().mockResolvedValue(response),
      mutate: jest.fn().mockResolvedValue(response),
    };
    const controller = new MarketplaceProfileController(
      service as unknown as MarketplaceProfileService,
    );
    const user = { userId: '323459159', username: null, displayName: null };
    const read = (view?: string) =>
      method === 'get'
        ? controller.get(
            user,
            'CHANNEL',
            '-100',
            'publisher',
            { miniappProfile: 'publisher' },
            view,
          )
        : controller.mutate(
            user,
            'CHANNEL',
            '-100',
            'publisher',
            {},
            { miniappProfile: 'publisher' },
            view,
          );
    expect(await read()).toEqual({ bindingId: 'test' });
    expect(await read('2')).toEqual(response);
  });
});
