import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { ExecutionContext } from '@nestjs/common';
import { InitDataGuard } from '../../auth/init-data.guard';
import {
  MarketplaceEditorialController,
  MarketplaceEditorialIntegrationController,
} from './marketplace-editorial.controller';
import { MarketplaceEditorialAccessService } from './marketplace-editorial-access.service';
import { MarketplaceEditorialService } from './marketplace-editorial.service';

describe('editorial actual Nest Fastify routes and signed identity boundary', () => {
  let app: NestFastifyApplication;
  const token = 'synthetic-editorial-callback';
  const editorial = { get: jest.fn(), mutate: jest.fn() } satisfies Pick<
    MarketplaceEditorialService,
    'get' | 'mutate'
  >;
  const access = { prove: jest.fn() } satisfies Pick<MarketplaceEditorialAccessService, 'prove'>;
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [MarketplaceEditorialController, MarketplaceEditorialIntegrationController],
      providers: [
        { provide: ConfigService, useValue: new ConfigService({ SVYAZKA_ANALYTICS_TOKEN: token }) },
        { provide: MarketplaceEditorialService, useValue: editorial },
        { provide: MarketplaceEditorialAccessService, useValue: access },
      ],
    })
      .overrideGuard(InitDataGuard)
      .useValue({
        canActivate(context: ExecutionContext) {
          const request = context.switchToHttp().getRequest();
          if (request.headers['x-fixture-session'] !== 'valid') return false;
          request.user = { userId: '933001', username: null, displayName: null };
          request.miniappProfile = 'publisher';
          return true;
        },
      })
      .compile();
    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.setGlobalPrefix('api');
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });
  beforeEach(() => jest.clearAllMocks());
  afterAll(async () => app?.close());
  const url = '/api/v1/marketplace/entities/CHANNEL/-100/editorial?profile=publisher';
  it('dispatches GET/PATCH using the signed actor and profile', async () => {
    editorial.get.mockResolvedValue({ fixture: 'get' });
    editorial.mutate.mockResolvedValue({ fixture: 'patch' });
    const headers = { 'x-fixture-session': 'valid' };
    expect((await app.inject({ method: 'GET', url, headers })).statusCode).toBe(200);
    expect(editorial.get).toHaveBeenCalledWith('933001', 'CHANNEL', '-100', 'publisher');
    expect(
      (await app.inject({ method: 'PATCH', url, headers, payload: { description: 'fixture' } }))
        .statusCode,
    ).toBe(200);
    expect(editorial.mutate).toHaveBeenCalledWith('933001', 'CHANNEL', '-100', 'publisher', {
      description: 'fixture',
    });
  });
  it('does not pass a missing session or a substituted launch profile to the relay', async () => {
    expect((await app.inject({ method: 'GET', url })).statusCode).toBe(403);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: url.replace('profile=publisher', 'profile=moderation'),
          headers: { 'x-fixture-session': 'valid' },
        })
      ).statusCode,
    ).toBe(409);
    expect(editorial.get).not.toHaveBeenCalled();
  });
  it('requires the actual integration token at the separate proof route', async () => {
    const url = '/api/v1/integrations/svyazka/v1/editorial-access';
    expect((await app.inject({ method: 'POST', url, payload: {} })).statusCode).toBe(401);
    expect(access.prove).not.toHaveBeenCalled();
    access.prove.mockResolvedValue({ fixture: 'proof' });
    expect(
      (
        await app.inject({
          method: 'POST',
          url,
          payload: {},
          headers: { authorization: `Bearer ${token}` },
        })
      ).statusCode,
    ).toBe(201);
    expect(access.prove).toHaveBeenCalledWith({});
  });
});
