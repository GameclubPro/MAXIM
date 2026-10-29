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
  const authority = { introspect: jest.fn() } satisfies Pick<
    KaravanMarketplaceAuthorityService,
    'introspect'
  >;
  const handoffs = { exchange: jest.fn() } satisfies Pick<
    KaravanMarketplaceHandoffService,
    'exchange'
  >;
  const resolver = { listChoices: jest.fn(), saveChoice: jest.fn() } satisfies Pick<
    KaravanMarketplaceResolverService,
    'listChoices' | 'saveChoice'
  >;
  const bindings = { status: jest.fn() } satisfies Pick<
    KaravanMarketplaceBindingStatusService,
    'status'
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
        { provide: KaravanMarketplaceAuthorityService, useValue: authority },
        { provide: KaravanMarketplaceHandoffService, useValue: handoffs },
        { provide: KaravanMarketplaceResolverService, useValue: resolver },
        { provide: KaravanMarketplaceBindingStatusService, useValue: bindings },
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

  const routes = [
    ['publication-choices/list', resolver.listChoices, { actorMaxUserId: input.actorMaxUserId }],
    [
      'publication-choices/save',
      resolver.saveChoice,
      {
        actorMaxUserId: input.actorMaxUserId,
        choiceId: '11111111-1111-4111-8111-111111111111',
        storeId: '22222222-2222-4222-8222-222222222222',
      },
    ],
    [
      'bindings/status',
      bindings.status,
      {
        chatId: input.chatId,
        botId: input.botId,
        authorityEpoch: input.authorityEpoch,
        verifiedAt: input.verifiedAt,
      },
    ],
    [
      'authority/introspect',
      authority.introspect,
      {
        actorMaxUserId: input.actorMaxUserId,
        chatId: input.chatId,
        commandId: 'synthetic-command',
        action: 'read_chat_module',
        marketplaceId: null,
        expectedBindingGeneration: null,
        payloadHash: 'a'.repeat(64),
        proofId: 'b'.repeat(43),
      },
    ],
    ['authority/access-check', actorAccess.check, input],
    [
      'handoffs/exchange',
      handoffs.exchange,
      {
        actorMaxUserId: input.actorMaxUserId,
        code: 'c'.repeat(43),
        exchangeId: '33333333-3333-4333-8333-333333333333',
        audience: 'client',
      },
    ],
  ] as const;

  describe.each(routes)('%s request boundary', (path, handler, validInput) => {
    const route = `/v1/integrations/karavan/v1/${path}`;
    it.each([
      {},
      [],
      { ...validInput, actorMaxUserId: 123 },
      { ...validInput, unexpected: 'private-value' },
    ])('rejects malformed input before invoking services (%j)', async (payload) => {
      const response = await app.inject({
        method: 'POST',
        url: route,
        payload,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.statusCode).toBe(400);
      expect(response.body).not.toContain('private-value');
      expect(handler).not.toHaveBeenCalled();
    });
    it('authenticates before validating the request', async () => {
      const response = await app.inject({
        method: 'POST',
        url: route,
        payload: {},
        headers: { authorization: 'Bearer synthetic-command-credential' },
      });
      expect(response.statusCode).toBe(401);
      expect(handler).not.toHaveBeenCalled();
    });
    it('forwards valid input unchanged', async () => {
      handler.mockResolvedValueOnce({ ok: true });
      const response = await app.inject({
        method: 'POST',
        url: route,
        payload: validInput,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.statusCode).toBe(path === 'authority/access-check' ? 200 : 201);
      expect(handler).toHaveBeenCalledWith(validInput);
    });
  });

  it('keeps internal failures distinct from malformed input', async () => {
    actorAccess.check.mockRejectedValueOnce(new Error('private-internal-error'));
    const response = await app.inject({
      method: 'POST',
      url,
      payload: input,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain('private-internal-error');
  });
});
