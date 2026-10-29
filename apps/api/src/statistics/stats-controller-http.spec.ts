import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { STATS_HTTP_PREFIX, STATS_ROUTES } from '@maxim/contracts/statistics-central';
import type {
  StatsAuthorityRequest,
  StatsAuthorityResolveRequest,
  StatsHistoryRequest,
  StatsSummaryRequest,
} from '@maxim/contracts/statistics-central';
import { PrismaService } from '../prisma/prisma.service';
import { StatsAccessService } from './stats-access.service';
import { StatsChangesService } from './stats-changes.service';
import { StatsIngestService } from './stats-ingest.service';
import { StatsReadService } from './stats-read.service';
import { StatsController } from './stats.controller';
import { registerStatsHttpLimits } from './stats-http-limits';

describe('central statistics real Nest Fastify routes', () => {
  let app: NestFastifyApplication;
  const token = 'synthetic-statistics-route-token';
  const id = '00000000-0000-4000-8000-000000000001';
  const entity = { kind: 'CHANNEL' as const, maxId: '-123456789' };
  const scope = {
    contractVersion: 1,
    producerEpoch: id,
    entity,
    role: 'CONSUMER',
    actorMaxUserId: '123456789',
    botRef: 'synthetic-statistics-bot',
    consumer: 'EXCHANGE',
    purpose: 'OWNER_ANALYTICS',
  } satisfies StatsAuthorityResolveRequest;
  const authority = {
    contractVersion: 1,
    requestId: id,
    operations: [
      {
        id,
        revision: '1',
        operation: 'ATTEST',
        entity,
        role: scope.role,
        actorMaxUserId: scope.actorMaxUserId,
        botRef: scope.botRef,
        consumer: scope.consumer,
        purpose: scope.purpose,
        scopes: [
          { metric: 'AUDIENCE', horizon: 0, method: { id: 'AUDIENCE_SNAPSHOT', version: 1 } },
        ],
        checkedAt: '2026-10-30T00:00:00Z',
        producerEpoch: id,
        localAccessFence: 'synthetic-fence',
      },
    ],
  } satisfies StatsAuthorityRequest;
  const summary = {
    contractVersion: 1,
    contexts: [
      {
        contextId: id,
        entity,
        actorMaxUserId: scope.actorMaxUserId,
        purpose: scope.purpose,
        consumerAuthority: { id, epoch: '1' },
      },
    ],
    metrics: ['AUDIENCE'],
    horizons: [0],
    cursor: null,
    periods: [7],
  } satisfies StatsSummaryRequest;
  const history = {
    contractVersion: 1,
    contexts: summary.contexts,
    metrics: summary.metrics,
    horizons: summary.horizons,
    cursor: null,
    periodDays: 7,
    methods: ['AUDIENCE_SNAPSHOT'],
    rowLimit: 256,
  } satisfies StatsHistoryRequest;
  const access = { attest: jest.fn(), resolve: jest.fn() } satisfies Pick<
    StatsAccessService,
    'attest' | 'resolve'
  >;
  const ingest = { ingest: jest.fn() } satisfies Pick<StatsIngestService, 'ingest'>;
  const read = { summaries: jest.fn(), history: jest.fn() } satisfies Pick<
    StatsReadService,
    'summaries' | 'history'
  >;
  const feed = { changes: jest.fn() } satisfies Pick<StatsChangesService, 'changes'>;
  const handlers = [
    access.attest,
    access.resolve,
    ingest.ingest,
    read.summaries,
    read.history,
    feed.changes,
  ];
  const actionCases = [
    [STATS_ROUTES.authorities, authority, access.attest],
    [STATS_ROUTES.authorityResolve, scope, access.resolve],
    [STATS_ROUTES.summaries, summary, read.summaries],
    [STATS_ROUTES.history, history, read.history],
  ] as const;
  const posts = [...actionCases.map(([route]) => route), STATS_ROUTES.ingest];

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [StatsController],
      providers: [
        {
          provide: ConfigService,
          useValue: new ConfigService({
            SVYAZKA_ANALYTICS_TOKEN: token,
            STATISTICS_CENTRAL_ENABLED: 'true',
            STATISTICS_CENTRAL_MODE: 'CENTRAL',
          }),
        },
        { provide: PrismaService, useValue: { $queryRaw: jest.fn() } },
        { provide: StatsAccessService, useValue: access },
        { provide: StatsIngestService, useValue: ingest },
        { provide: StatsReadService, useValue: read },
        { provide: StatsChangesService, useValue: feed },
      ],
    }).compile();
    app = module.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter({ bodyLimit: 1_000_000 }),
    );
    app.setGlobalPrefix('api');
    registerStatsHttpLimits(app.getHttpAdapter().getInstance());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });
  beforeEach(() => jest.clearAllMocks());
  afterAll(async () => app?.close());

  it.each(actionCases)(
    'dispatches the exact literal action %s to its own handler',
    async (route, payload, handler) => {
      handler.mockResolvedValueOnce({ route });
      const response = await app.inject({
        method: 'POST',
        url: STATS_HTTP_PREFIX + route,
        headers: { authorization: `Bearer ${token}` },
        payload,
      });
      expect(response.statusCode).toBe(201);
      expect(response.json()).toEqual({ route });
      expect(handler).toHaveBeenCalledWith(payload);
      for (const other of handlers) if (other !== handler) expect(other).not.toHaveBeenCalled();
    },
  );

  it.each(Object.values(STATS_ROUTES))('requires the dedicated credential at %s', async (route) => {
    const response = await app.inject({
      method: posts.includes(route as (typeof posts)[number]) ? 'POST' : 'GET',
      url: STATS_HTTP_PREFIX + route,
      headers: { authorization: 'Bearer synthetic-wrong-token' },
    });
    expect(response.statusCode).toBe(401);
    for (const handler of handlers) expect(handler).not.toHaveBeenCalled();
  });

  it.each(posts)('validates the request schema at %s', async (route) => {
    const response = await app.inject({
      method: 'POST',
      url: STATS_HTTP_PREFIX + route,
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    });
    expect(response.statusCode).toBe(400);
    for (const handler of handlers) expect(handler).not.toHaveBeenCalled();
  });

  it.each([
    '/authorities:unknown',
    '/authoritiesbatch',
    '/authorities::batch',
    '/summaries:unknown',
    '/history:unknown',
  ])('rejects an unregistered action %s', async (route) => {
    const response = await app.inject({
      method: 'POST',
      url: STATS_HTTP_PREFIX + route,
      headers: { authorization: `Bearer ${token}` },
      payload: authority,
    });
    expect(response.statusCode).toBe(404);
    for (const handler of handlers) expect(handler).not.toHaveBeenCalled();
  });

  it.each(actionCases)(
    'preserves the streaming body limit for %s',
    async (route, payload, handler) => {
      const limit = route === STATS_ROUTES.authorities ? 131_072 : 65_536;
      const json = JSON.stringify(payload);
      const padded = json + ' '.repeat(limit - Buffer.byteLength(json));
      handler.mockResolvedValueOnce({ route });
      const inject = (body: string) =>
        app.inject({
          method: 'POST',
          url: STATS_HTTP_PREFIX + route,
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          payload: body,
        });
      expect((await inject(padded)).statusCode).toBe(201);
      expect(handler).toHaveBeenCalledTimes(1);
      expect((await inject(padded + ' ')).statusCode).toBe(413);
      expect(handler).toHaveBeenCalledTimes(1);
    },
  );
});
