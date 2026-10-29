import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { ServiceUnavailableException } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { KaravanMarketplaceIntegrationController } from './karavan-marketplace-integration.controller';
import { KaravanMarketplaceAuthorityService } from './karavan-marketplace-authority.service';
import { KaravanMarketplaceHandoffService } from './karavan-marketplace-handoff.service';
import { KaravanMarketplaceResolverService } from './karavan-marketplace-resolver.service';
import { KaravanMarketplaceBindingStatusService } from './karavan-marketplace-binding-status.service';
import { KaravanMarketplaceActorAccessService } from './karavan-marketplace-actor-access.service';

describe('Karavan actor access integration route', () => {
  let app: NestFastifyApplication;
  const actorAccess = { check: jest.fn() } satisfies Pick<
    KaravanMarketplaceActorAccessService,
    'check'
  >;
  const token = 'synthetic-dedicated-authority-credential';
  const input = {
    actorMaxUserId: '9007199254740993',
    chatId: '-9007199254740993',
    botId: 'synthetic_major_bot',
    authorityEpoch: 'a'.repeat(64),
    verifiedAt: '2026-01-01T00:00:00.000Z',
    bindingGeneration: 3,
  };
  const url = '/v1/integrations/karavan/v1/authority/access-check';

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [KaravanMarketplaceIntegrationController],
      providers: [
        {
          provide: ConfigService,
          useValue: new ConfigService({ KARAVAN_MARKETPLACE_AUTHORITY_TOKEN: token }),
        },
        { provide: KaravanMarketplaceAuthorityService, useValue: {} },
        { provide: KaravanMarketplaceHandoffService, useValue: {} },
        { provide: KaravanMarketplaceResolverService, useValue: {} },
        { provide: KaravanMarketplaceBindingStatusService, useValue: {} },
        { provide: KaravanMarketplaceActorAccessService, useValue: actorAccess },
      ],
    }).compile();
    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });
  beforeEach(() => jest.clearAllMocks());
  afterAll(async () => app.close());

  it.each([undefined, 'Bearer synthetic-command-credential', 'Bearer ', `bearer ${token}`])(
    'rejects missing or non-authority credentials without checking MAX (%s)',
    async (authorization) => {
      const response = await app.inject({
        method: 'POST',
        url,
        payload: input,
        headers: authorization ? { authorization } : {},
      });
      expect(response.statusCode).toBe(401);
      expect(actorAccess.check).not.toHaveBeenCalled();
    },
  );

  it('routes the exact actor and binding tuple only through the dedicated authority credential', async () => {
    const decision = {
      ...input,
      allowed: true,
      reason: 'admin',
      checkedAt: '2026-01-01T01:00:00.000Z',
      expiresAt: '2026-01-01T01:00:15.000Z',
    };
    actorAccess.check.mockResolvedValueOnce(decision);
    const response = await app.inject({
      method: 'POST',
      url,
      payload: input,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(decision);
    expect(actorAccess.check).toHaveBeenCalledWith(input);
  });

  it('preserves an uncertain MAX result as unavailable', async () => {
    actorAccess.check.mockRejectedValueOnce(
      new ServiceUnavailableException('MAX пока не подтвердил права.'),
    );
    const response = await app.inject({
      method: 'POST',
      url,
      payload: input,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).not.toHaveProperty('allowed');
  });
});
