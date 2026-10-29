import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { HttpException } from '@nestjs/common';
import type { PrismaService } from '../../prisma/prisma.service';
import type {
  KaravanMarketplaceAuthorityService,
  KaravanPrincipal,
} from './karavan-marketplace-authority.service';
import { KaravanMarketplaceProxyService } from './karavan-marketplace-proxy.service';
const principal: KaravanPrincipal = {
  source: 'session',
  principalKey: 'a'.repeat(64),
  launchBotId: 'synthetic',
};
describe('native Major shop commands', () => {
  afterEach(() => jest.restoreAllMocks());
  function setup() {
    const authority = {
      issue: jest.fn().mockResolvedValue({ proofId: 'synthetic' }),
    } satisfies Pick<KaravanMarketplaceAuthorityService, 'issue'>;
    const service = new KaravanMarketplaceProxyService(
      {} as PrismaService,
      authority as unknown as KaravanMarketplaceAuthorityService,
      new ConfigService({
        KARAVAN_MARKETPLACE_API_BASE_URL: 'https://synthetic.test/karavan',
        KARAVAN_MARKETPLACE_COMMAND_TOKEN: 'synthetic-command',
      }),
    );
    const fetchMock = jest.spyOn(globalThis, 'fetch');
    const payload = {
      commandId: randomUUID(),
      chatId: '-999',
      marketplaceId: randomUUID(),
      expectedBindingGeneration: 3,
      command: { operation: 'pins' },
    };
    return { service, authority, fetchMock, payload };
  }
  it('uses the server selected chat and authenticated actor and validates the operation response', async () => {
    const { service, authority, fetchMock, payload } = setup();
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ operation: 'pins', data: { revision: 2, offers: [] } }), {
        status: 200,
      }),
    );
    await expect(service.manage('-123', '777', payload, principal)).resolves.toMatchObject({
      operation: 'pins',
    });
    expect(authority.issue).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: '-123',
        actorMaxUserId: '777',
        action: 'manage_shop',
        expectedBindingGeneration: 3,
      }),
      principal,
    );
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(
      'https://synthetic.test/karavan/api/v1/integrations/maxim/marketplaces/manage',
    );
    expect(JSON.parse(init!.body as string).payload.chatId).toBe('-123');
    expect(init!.redirect).toBe('error');
  });
  it('preserves safe conflicts without exposing remote diagnostics', async () => {
    const { service, fetchMock, payload } = setup();
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          error: 'MARKETPLACE_REVISION_CONFLICT',
          message: 'private database details',
        }),
        { status: 409 },
      ),
    );
    try {
      await service.manage('-123', '777', payload, principal);
      throw new Error('Expected conflict');
    } catch (error) {
      expect(error).toBeInstanceOf(HttpException);
      expect((error as HttpException).getStatus()).toBe(409);
      expect(JSON.stringify((error as HttpException).getResponse())).not.toContain('database');
    }
  });
  it('rejects invented proxy paths or actor overrides before issuing authority', async () => {
    const { service, authority, payload } = setup();
    await expect(
      service.manage(
        '-123',
        '777',
        { ...payload, command: { operation: 'proxy', path: '/operator' } },
        principal,
      ),
    ).rejects.toThrow();
    await expect(
      service.manage('-123', '777', { ...payload, actorMaxUserId: '888' }, principal),
    ).rejects.toThrow();
    expect(authority.issue).not.toHaveBeenCalled();
  });
});
