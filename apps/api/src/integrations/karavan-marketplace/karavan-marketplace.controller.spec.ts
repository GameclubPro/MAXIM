import type { KaravanMarketplaceResolverService } from './karavan-marketplace-resolver.service';
import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import type { FastifyRequest } from 'fastify';
import type { KaravanMarketplaceModule } from '@maxim/contracts/karavan-marketplace';
import { KaravanMarketplaceController } from './karavan-marketplace.controller';
import type { KaravanMarketplaceAuthorityService } from './karavan-marketplace-authority.service';
import type { KaravanMarketplaceProxyService } from './karavan-marketplace-proxy.service';
import type { KaravanMarketplaceHandoffService } from './karavan-marketplace-handoff.service';

describe('Karavan module destination permissions', () => {
  function fixture() {
    const marketplaceId = randomUUID();
    const state: KaravanMarketplaceModule = {
      marketplace: {
        id: marketplaceId,
        networkId: randomUUID(),
        publicSlug: 'synthetic',
        name: 'Synthetic',
        description: null,
        kind: 'chat',
        status: 'draft',
        admissionPolicy: 'applications',
        logoImageUrl: null,
        coverImageUrl: null,
        editRevision: 1,
        policyRevision: 1,
        orderRevision: 1,
        visibilityRevision: 1,
      },
      binding: {
        id: randomUUID(),
        chatId: '-123',
        chatTitle: 'Synthetic',
        state: 'verified',
        generation: 1,
        revision: 1,
        verifiedAt: new Date().toISOString(),
      },
      permissions: ['review_listing'],
      counts: { listings: 0, pendingApplications: 3, chats: 1 },
      canManage: false,
    };
    const proxy = { module: jest.fn().mockResolvedValue(state) } satisfies Pick<
      KaravanMarketplaceProxyService,
      'module'
    >;
    const authority = {
      principal: jest.fn().mockReturnValue({
        source: 'session',
        principalKey: 'a'.repeat(64),
        launchBotId: 'synthetic',
      }),
    } satisfies Pick<KaravanMarketplaceAuthorityService, 'principal'>;
    const handoffs = {
      issue: jest.fn().mockResolvedValue({
        url: 'https://max.ru/synthetic?startapp=example',
        expiresAt: new Date().toISOString(),
      }),
    } satisfies Pick<KaravanMarketplaceHandoffService, 'issue'>;
    const controller = new KaravanMarketplaceController(
      new ConfigService(),
      authority as unknown as KaravanMarketplaceAuthorityService,
      proxy as unknown as KaravanMarketplaceProxyService,
      {
        listChoices: jest.fn().mockResolvedValue({ choices: [] }),
      } as unknown as KaravanMarketplaceResolverService,
      handoffs as unknown as KaravanMarketplaceHandoffService,
    );
    const invoke = (destination: string) =>
      controller.handoff(
        '-123',
        { commandId: randomUUID(), marketplaceId, destination },
        { userId: '777', username: null, displayName: null },
        {} as FastifyRequest,
      );
    return { state, invoke, handoffs };
  }
  it('lets a delegated reviewer open applications without granting marketplace settings', async () => {
    const { invoke, handoffs } = fixture();
    await expect(invoke('applications')).resolves.toHaveProperty('url');
    await expect(invoke('categories')).rejects.toThrow('недоступно');
    await expect(invoke('open_marketplace')).rejects.toThrow('недоступно');
    await expect(invoke('invite_sellers')).rejects.toThrow('недоступно');
    expect(handoffs.issue).toHaveBeenCalledTimes(1);
  });
  it('does not mint handoff for disconnected binding even with management permission', async () => {
    const { state, invoke, handoffs } = fixture();
    state.permissions = ['manage_marketplace'];
    state.canManage = true;
    state.binding!.state = 'disconnected';
    await expect(invoke('manage')).rejects.toThrow('недоступно');
    expect(handoffs.issue).not.toHaveBeenCalled();
  });

  it('opens private preview for a reviewer and live buyer view only for an active shop', async () => {
    const { state, invoke, handoffs } = fixture();
    await expect(invoke('preview')).resolves.toHaveProperty('url');
    await expect(invoke('view')).rejects.toThrow('недоступен');
    state.marketplace!.status = 'active';
    await expect(invoke('view')).resolves.toHaveProperty('url');
    await expect(invoke('preview')).rejects.toThrow('недоступен');
    state.permissions = [];
    await expect(invoke('view')).rejects.toThrow('недоступно');
    expect(handoffs.issue).toHaveBeenCalledTimes(2);
  });
  it('does not expose a destination after marketplace membership was revoked', async () => {
    const { state, invoke, handoffs } = fixture();
    state.permissions = [];
    await expect(invoke('manage')).rejects.toThrow('недоступно');
    expect(handoffs.issue).not.toHaveBeenCalled();
  });
});
