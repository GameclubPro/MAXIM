import { createHmac } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { InitDataGuard } from '../auth/init-data.guard';
import { InitDataService } from '../auth/init-data.service';
import { PublisherInitDataKeyService } from '../auth/publisher-init-data-key.service';
import { MaxBotRegistryService } from '../max/max-bot-registry.service';
import { QueueMetricsService } from './queue-metrics.service';
import { MaxApiMetricsService } from './max-api-metrics.service';
import { SystemBotsService } from './system-bots.service';
import { SystemController } from './system.controller';
import { SystemDashboardService } from './system-dashboard.service';
import { SystemModeService } from './system-mode.service';

function createSignedInitData(botToken: string, userId: string, authDateSec: number): string {
  const entries: Array<[string, string]> = [
    ['auth_date', String(authDateSec)],
    ['user', JSON.stringify({ id: userId })],
  ];
  const sortedPairs = [...entries]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  const secretKey = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const hash = createHmac('sha256', secretKey).update(sortedPairs).digest('hex');

  return [...entries, ['hash', hash]]
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join('&');
}

describe('SystemController auth e2e', () => {
  let app: NestFastifyApplication;
  let appCreated = false;
  const botToken = 'test-bot-token';
  const getSourceSnapshot = jest.fn();
  const getRoutePreview = jest.fn();
  const getRouteAudit = jest.fn();
  const getMembershipAudit = jest.fn();
  const getQueueSnapshot = jest.fn();
  const getOperationalQueueSnapshot = jest.fn();

  beforeEach(async () => {
    appCreated = false;
    getSourceSnapshot.mockReset().mockResolvedValue({
      generatedAt: '2026-04-01T18:10:00.000Z',
      windowSec: 120,
      overall: { totalRequests: 3 },
    });
    getRoutePreview.mockReset().mockResolvedValue({
      generatedAt: '2026-04-01T18:11:00.000Z',
      query: {
        chatId: 'chat-1',
        purpose: 'send_message',
        action: null,
        capability: null,
        fallbackToPrimary: false,
        botId: null,
      },
      routes: [{ purpose: 'send_message', botId: 'bot-2' }],
    });
    getRouteAudit.mockReset().mockResolvedValue({
      generatedAt: '2026-04-01T18:11:30.000Z',
      summary: {
        auditedEntities: 2,
        emptyCandidates: 0,
      },
    });
    getMembershipAudit.mockReset().mockResolvedValue({
      generatedAt: '2026-04-01T18:12:00.000Z',
      summary: { criticalCount: 0 },
    });
    getQueueSnapshot.mockReset();
    getOperationalQueueSnapshot.mockReset().mockResolvedValue({
      effectiveLagSec: 2,
      webhookDefaultShards: {
        'moderation-default-0': {
          waiting: 1,
          prioritized: 0,
          active: 0,
          delayed: 0,
          failed: 0,
          completed: 4,
        },
      },
      actions: {
        waiting: 0,
        prioritized: 0,
        active: 1,
        delayed: 0,
        failed: 0,
        completed: 3,
      },
      generatedAt: '2026-09-02T12:00:00.000Z',
    });

    const moduleRef = await Test.createTestingModule({
      controllers: [SystemController],
      providers: [
        InitDataGuard,
        InitDataService,
        {
          provide: PublisherInitDataKeyService,
          useValue: { getVerificationKeys: jest.fn(() => null) },
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string, fallback?: unknown) => {
              if (key === 'INIT_DATA_MAX_AGE_SEC') {
                return 300;
              }
              if (key === 'NODE_ENV') {
                return 'production';
              }
              if (key === 'SYSTEM_ADMIN_USER_IDS') {
                return '100';
              }
              return fallback;
            }),
          },
        },
        {
          provide: MaxBotRegistryService,
          useValue: {
            getAllBots: jest.fn(() => [{ id: 'test-bot' }]),
            getValidationTokensForBot: jest.fn(() => [botToken]),
          },
        },
        {
          provide: QueueMetricsService,
          useValue: {
            getSnapshot: getQueueSnapshot,
            getOperationalSnapshot: getOperationalQueueSnapshot,
          },
        },
        {
          provide: SystemModeService,
          useValue: { getEffectiveSnapshot: jest.fn() },
        },
        {
          provide: SystemDashboardService,
          useValue: { getSnapshot: jest.fn() },
        },
        {
          provide: MaxApiMetricsService,
          useValue: { getSourceSnapshot },
        },
        {
          provide: SystemBotsService,
          useValue: {
            getSnapshot: jest.fn(),
            getRoutePreview,
            getRouteAudit,
            getMembershipAudit,
          },
        },
      ],
    }).compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    appCreated = true;
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterEach(async () => {
    if (appCreated) {
      await app.close();
    }
  });

  it('rejects an unauthenticated request', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/system/metrics/max-api?windowSec=120',
    });

    expect(response.statusCode).toBe(401);
  });

  it('protects and serves the lightweight operational queue endpoint', async () => {
    const unauthenticated = await app.inject({
      method: 'GET',
      url: '/v1/system/metrics/queues/operational',
    });
    expect(unauthenticated.statusCode).toBe(401);

    const initData = createSignedInitData(botToken, '100', Math.floor(Date.now() / 1_000));
    const authenticated = await app.inject({
      method: 'GET',
      url: '/v1/system/metrics/queues/operational',
      headers: {
        authorization: `InitData ${initData}`,
      },
    });

    expect(authenticated.statusCode).toBe(200);
    expect(authenticated.json()).toMatchObject({
      effectiveLagSec: 2,
      webhookDefaultShards: {
        'moderation-default-0': { waiting: 1 },
      },
      actions: { active: 1 },
    });
    expect(getOperationalQueueSnapshot).toHaveBeenCalledWith({ maxAgeMs: 1_000 });
    expect(getQueueSnapshot).not.toHaveBeenCalled();
  });

  it('returns source-level MAX metrics for an authenticated system admin', async () => {
    const initData = createSignedInitData(botToken, '100', Math.floor(Date.now() / 1_000));

    const response = await app.inject({
      method: 'GET',
      url: '/v1/system/metrics/max-api?windowSec=120',
      headers: {
        authorization: `InitData ${initData}`,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      generatedAt: '2026-04-01T18:10:00.000Z',
      windowSec: 120,
      overall: { totalRequests: 3 },
    });

    expect(getSourceSnapshot).toHaveBeenCalledWith({ windowSec: 120 });
  });

  it('returns a bot route preview for an authenticated system admin', async () => {
    const initData = createSignedInitData(botToken, '100', Math.floor(Date.now() / 1_000));

    const response = await app.inject({
      method: 'GET',
      url: '/v1/system/bots/routes/preview?chatId=chat-1&purpose=send_message&fallbackToPrimary=false',
      headers: {
        authorization: `InitData ${initData}`,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      generatedAt: '2026-04-01T18:11:00.000Z',
      query: {
        chatId: 'chat-1',
        purpose: 'send_message',
        action: null,
        capability: null,
        fallbackToPrimary: false,
        botId: null,
      },
      routes: [{ purpose: 'send_message', botId: 'bot-2' }],
    });
    expect(getRoutePreview).toHaveBeenCalledWith({
      chatId: 'chat-1',
      purpose: 'send_message',
      action: null,
      capability: null,
      fallbackToPrimary: false,
      botId: null,
    });
  });

  it('returns a bot route audit for an authenticated system admin', async () => {
    const initData = createSignedInitData(botToken, '100', Math.floor(Date.now() / 1_000));

    const response = await app.inject({
      method: 'GET',
      url: '/v1/system/bots/routes/audit?sampleLimit=7&includeCovered=false',
      headers: {
        authorization: `InitData ${initData}`,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      generatedAt: '2026-04-01T18:11:30.000Z',
      summary: {
        auditedEntities: 2,
        emptyCandidates: 0,
      },
    });
    expect(getRouteAudit).toHaveBeenCalledWith({
      sampleLimit: 7,
      includeCovered: false,
    });
  });

  it('returns a bot membership audit for an authenticated system admin', async () => {
    const initData = createSignedInitData(botToken, '100', Math.floor(Date.now() / 1_000));

    const response = await app.inject({
      method: 'GET',
      url: '/v1/system/bots/audit?sampleLimit=5&snapshotFreshMs=60000',
      headers: {
        authorization: `InitData ${initData}`,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      generatedAt: '2026-04-01T18:12:00.000Z',
      summary: { criticalCount: 0 },
    });
    expect(getMembershipAudit).toHaveBeenCalledWith({
      sampleLimit: 5,
      snapshotFreshMs: 60_000,
    });
  });
});
