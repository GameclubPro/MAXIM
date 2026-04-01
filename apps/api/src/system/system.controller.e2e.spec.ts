import { createHmac } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { InitDataGuard } from '../auth/init-data.guard';
import { InitDataService } from '../auth/init-data.service';
import { MaxBotRegistryService } from '../max/max-bot-registry.service';
import { QueueMetricsService } from './queue-metrics.service';
import { MaxApiMetricsService } from './max-api-metrics.service';
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
  const botToken = 'test-bot-token';
  const getSourceSnapshot = jest.fn();

  beforeEach(async () => {
    getSourceSnapshot.mockReset().mockResolvedValue({
      generatedAt: '2026-04-01T18:10:00.000Z',
      windowSec: 120,
      overall: { totalRequests: 3 },
    });

    const moduleRef = await Test.createTestingModule({
      controllers: [SystemController],
      providers: [
        InitDataGuard,
        InitDataService,
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
            getValidationTokens: jest.fn(() => [botToken]),
          },
        },
        {
          provide: QueueMetricsService,
          useValue: { getSnapshot: jest.fn() },
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
      ],
    }).compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('rejects an unauthenticated request', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/system/metrics/max-api?windowSec=120',
    });

    expect(response.statusCode).toBe(401);
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
});
