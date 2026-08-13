import { MaxApiMetricsService } from './max-api-metrics.service';

const redisStores: Array<Map<string, string>> = [];
const redisInstances: Array<{
  scan: jest.Mock<Promise<[string, string[]]>, [string, string, string, string, string]>;
  mget: jest.Mock<Promise<Array<string | null>>, string[]>;
  quit: jest.Mock<Promise<void>, []>;
}> = [];

jest.mock('ioredis', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => {
    const store = new Map<string, string>();
    const instance = {
      scan: jest
        .fn()
        .mockImplementation(
          async (
            _cursor: string,
            _matchLiteral: string,
            pattern: string,
            _countLiteral: string,
            _countValue: string,
          ) => {
            const normalizedPrefix = pattern.replace(/\*+$/u, '');
            return ['0', [...store.keys()].filter((key) => key.startsWith(normalizedPrefix))] as [
              string,
              string[],
            ];
          },
        ),
      mget: jest
        .fn()
        .mockImplementation(async (...keys: string[]) => keys.map((key) => store.get(key) ?? null)),
      quit: jest.fn().mockResolvedValue(undefined),
    };
    redisStores.push(store);
    redisInstances.push(instance);
    return instance;
  }),
}));

function createConfigMock(appServiceName?: string) {
  return {
    get: jest.fn((key: string) => {
      switch (key) {
        case 'APP_SERVICE_NAME':
          return appServiceName;
        case 'MAX_API_GLOBAL_RPS':
          return 30;
        case 'MAX_API_GLOBAL_RPS_CRITICAL':
          return 12;
        case 'MAX_API_GLOBAL_RPS_INTERACTIVE':
          return 10;
        case 'MAX_API_GLOBAL_RPS_BACKGROUND':
          return 4;
        default:
          return undefined;
      }
    }),
    getOrThrow: jest.fn((key: string) => {
      if (key === 'REDIS_URL') {
        return 'redis://localhost:6379/0';
      }
      throw new Error(`Missing key ${key}`);
    }),
  };
}

describe('MaxApiMetricsService', () => {
  beforeEach(() => {
    redisStores.length = 0;
    redisInstances.length = 0;
    jest.useFakeTimers().setSystemTime(new Date('2026-04-01T18:10:00.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('aggregates source-level MAX API metrics by bot and traffic class', async () => {
    const service = new MaxApiMetricsService(createConfigMock() as never);
    const store = redisStores[0]!;
    const nowSec = Math.floor(Date.now() / 1_000);
    const expectedWindowSec = 60;
    const avg = (totalRequests: number) => Number((totalRequests / expectedWindowSec).toFixed(3));

    store.set(`maxapi:rps:source:v1:bot-a:background:channel_auto_post:${nowSec}`, '6');
    store.set(`maxapi:rps:source:v1:bot-a:background:channel_auto_post:${nowSec - 1}`, '3');
    store.set(`maxapi:rps:source:v1:bot-a:background:managed_refresh:${nowSec}`, '2');
    store.set(`maxapi:rps:source:v1:bot-b:background:giveaway_draw_background:${nowSec - 2}`, '4');
    store.set(`maxapi:rps:source:v1:bot-b:interactive:managed_refresh:${nowSec - 2}`, '1');
    store.set(`maxapi:rps:source:v1:bot-b:background:channel_auto_post:${nowSec - 1000}`, '99');

    await expect(service.getSourceSnapshot({ windowSec: 10 })).resolves.toEqual({
      generatedAt: expect.any(String),
      windowSec: expectedWindowSec,
      windowStartAt: new Date((nowSec - expectedWindowSec + 1) * 1_000).toISOString(),
      windowEndAt: new Date(nowSec * 1_000).toISOString(),
      rateLimitOutcomes: {
        generatedAt: expect.any(String),
        windowSec: expectedWindowSec,
        stack: {
          internalLimiterRejects: 0,
          external429: 0,
        },
        bots: {},
      },
      overall: {
        totalRequests: 16,
        avgRps: avg(16),
        peakRps: 8,
        activeSeconds: 3,
        trafficClasses: {
          critical: {
            totalRequests: 0,
            avgRps: 0,
            peakRps: 0,
            activeSeconds: 0,
          },
          interactive: {
            totalRequests: 1,
            avgRps: avg(1),
            peakRps: 1,
            activeSeconds: 1,
          },
          background: {
            totalRequests: 15,
            avgRps: avg(15),
            peakRps: 8,
            activeSeconds: 3,
          },
        },
      },
      sources: {
        channel_auto_post: {
          totalRequests: 9,
          avgRps: avg(9),
          peakRps: 6,
          activeSeconds: 2,
          trafficClasses: {
            critical: {
              totalRequests: 0,
              avgRps: 0,
              peakRps: 0,
              activeSeconds: 0,
            },
            interactive: {
              totalRequests: 0,
              avgRps: 0,
              peakRps: 0,
              activeSeconds: 0,
            },
            background: {
              totalRequests: 9,
              avgRps: avg(9),
              peakRps: 6,
              activeSeconds: 2,
            },
          },
        },
        giveaway_draw_background: {
          totalRequests: 4,
          avgRps: avg(4),
          peakRps: 4,
          activeSeconds: 1,
          trafficClasses: {
            critical: {
              totalRequests: 0,
              avgRps: 0,
              peakRps: 0,
              activeSeconds: 0,
            },
            interactive: {
              totalRequests: 0,
              avgRps: 0,
              peakRps: 0,
              activeSeconds: 0,
            },
            background: {
              totalRequests: 4,
              avgRps: avg(4),
              peakRps: 4,
              activeSeconds: 1,
            },
          },
        },
        managed_refresh: {
          totalRequests: 3,
          avgRps: avg(3),
          peakRps: 2,
          activeSeconds: 2,
          trafficClasses: {
            critical: {
              totalRequests: 0,
              avgRps: 0,
              peakRps: 0,
              activeSeconds: 0,
            },
            interactive: {
              totalRequests: 1,
              avgRps: avg(1),
              peakRps: 1,
              activeSeconds: 1,
            },
            background: {
              totalRequests: 2,
              avgRps: avg(2),
              peakRps: 2,
              activeSeconds: 1,
            },
          },
        },
      },
      bots: {
        'bot-a': {
          overall: {
            totalRequests: 11,
            avgRps: avg(11),
            peakRps: 8,
            activeSeconds: 2,
            trafficClasses: {
              critical: {
                totalRequests: 0,
                avgRps: 0,
                peakRps: 0,
                activeSeconds: 0,
              },
              interactive: {
                totalRequests: 0,
                avgRps: 0,
                peakRps: 0,
                activeSeconds: 0,
              },
              background: {
                totalRequests: 11,
                avgRps: avg(11),
                peakRps: 8,
                activeSeconds: 2,
              },
            },
          },
          sources: {
            channel_auto_post: {
              totalRequests: 9,
              avgRps: avg(9),
              peakRps: 6,
              activeSeconds: 2,
              trafficClasses: {
                critical: {
                  totalRequests: 0,
                  avgRps: 0,
                  peakRps: 0,
                  activeSeconds: 0,
                },
                interactive: {
                  totalRequests: 0,
                  avgRps: 0,
                  peakRps: 0,
                  activeSeconds: 0,
                },
                background: {
                  totalRequests: 9,
                  avgRps: avg(9),
                  peakRps: 6,
                  activeSeconds: 2,
                },
              },
            },
            managed_refresh: {
              totalRequests: 2,
              avgRps: avg(2),
              peakRps: 2,
              activeSeconds: 1,
              trafficClasses: {
                critical: {
                  totalRequests: 0,
                  avgRps: 0,
                  peakRps: 0,
                  activeSeconds: 0,
                },
                interactive: {
                  totalRequests: 0,
                  avgRps: 0,
                  peakRps: 0,
                  activeSeconds: 0,
                },
                background: {
                  totalRequests: 2,
                  avgRps: avg(2),
                  peakRps: 2,
                  activeSeconds: 1,
                },
              },
            },
          },
        },
        'bot-b': {
          overall: {
            totalRequests: 5,
            avgRps: avg(5),
            peakRps: 5,
            activeSeconds: 1,
            trafficClasses: {
              critical: {
                totalRequests: 0,
                avgRps: 0,
                peakRps: 0,
                activeSeconds: 0,
              },
              interactive: {
                totalRequests: 1,
                avgRps: avg(1),
                peakRps: 1,
                activeSeconds: 1,
              },
              background: {
                totalRequests: 4,
                avgRps: avg(4),
                peakRps: 4,
                activeSeconds: 1,
              },
            },
          },
          sources: {
            giveaway_draw_background: {
              totalRequests: 4,
              avgRps: avg(4),
              peakRps: 4,
              activeSeconds: 1,
              trafficClasses: {
                critical: {
                  totalRequests: 0,
                  avgRps: 0,
                  peakRps: 0,
                  activeSeconds: 0,
                },
                interactive: {
                  totalRequests: 0,
                  avgRps: 0,
                  peakRps: 0,
                  activeSeconds: 0,
                },
                background: {
                  totalRequests: 4,
                  avgRps: avg(4),
                  peakRps: 4,
                  activeSeconds: 1,
                },
              },
            },
            managed_refresh: {
              totalRequests: 1,
              avgRps: avg(1),
              peakRps: 1,
              activeSeconds: 1,
              trafficClasses: {
                critical: {
                  totalRequests: 0,
                  avgRps: 0,
                  peakRps: 0,
                  activeSeconds: 0,
                },
                interactive: {
                  totalRequests: 1,
                  avgRps: avg(1),
                  peakRps: 1,
                  activeSeconds: 1,
                },
                background: {
                  totalRequests: 0,
                  avgRps: 0,
                  peakRps: 0,
                  activeSeconds: 0,
                },
              },
            },
          },
        },
      },
    });

    await service.onModuleDestroy();
  });

  it('aggregates internal limiter rejects and external 429s for stack and bots', async () => {
    const service = new MaxApiMetricsService(createConfigMock() as never);
    const store = redisStores[0]!;
    const nowSec = Math.floor(Date.now() / 1_000);

    store.set(`maxapi:rate-limit:v1:internal_limiter:bot-a:critical:${nowSec}`, '3');
    store.set(`maxapi:rate-limit:v1:external_429:bot-a:interactive:${nowSec - 1}`, '2');
    store.set(`maxapi:rate-limit:v1:external_429:bot-b:background:${nowSec}`, '4');
    store.set(`maxapi:rate-limit:v1:internal_limiter:stack:critical:${nowSec}`, '3');
    store.set(`maxapi:rate-limit:v1:external_429:stack:interactive:${nowSec - 1}`, '2');
    store.set(`maxapi:rate-limit:v1:external_429:stack:background:${nowSec}`, '4');
    store.set(`maxapi:rate-limit:v1:external_429:stack:critical:${nowSec - 1_000}`, '99');

    await expect(service.getRateLimitOutcomeSnapshot({ windowSec: 10 })).resolves.toEqual({
      generatedAt: expect.any(String),
      windowSec: 60,
      stack: {
        internalLimiterRejects: 3,
        external429: 6,
      },
      bots: {
        'bot-a': {
          internalLimiterRejects: 3,
          external429: 2,
        },
        'bot-b': {
          internalLimiterRejects: 0,
          external429: 4,
        },
      },
    });

    await service.onModuleDestroy();
  });

  it('aggregates limiter-backed bot RPS pressure by traffic class', async () => {
    const service = new MaxApiMetricsService(createConfigMock() as never);
    const store = redisStores[0]!;
    const nowSec = Math.floor(Date.now() / 1_000);
    const expectedWindowSec = 60;
    const avg = (totalRequests: number) => Number((totalRequests / expectedWindowSec).toFixed(3));

    store.set(`maxapi:rps:global:bot-a:critical:${nowSec}`, '6');
    store.set(`maxapi:rps:global:bot-a:interactive:${nowSec}`, '4');
    store.set(`maxapi:rps:global:bot-a:background:${nowSec - 1}`, '3');
    store.set(`maxapi:rps:global:bot-b:background:${nowSec}`, '2');
    store.set(`maxapi:rps:global:bot-b:interactive:${nowSec - 1}`, '1');

    await expect(
      service.getBotRateLimitSnapshot(['bot-a', 'bot-b'], { windowSec: 10 }),
    ).resolves.toEqual({
      'bot-a': {
        windowSec: expectedWindowSec,
        totalRequests: 13,
        avgRps: avg(13),
        peakRps: 10,
        activeSeconds: 2,
        trafficClasses: {
          critical: {
            totalRequests: 6,
            avgRps: avg(6),
            peakRps: 6,
            activeSeconds: 1,
          },
          interactive: {
            totalRequests: 4,
            avgRps: avg(4),
            peakRps: 4,
            activeSeconds: 1,
          },
          background: {
            totalRequests: 3,
            avgRps: avg(3),
            peakRps: 3,
            activeSeconds: 1,
          },
        },
        limits: {
          globalRps: 30,
          criticalRps: 16,
          interactiveRps: 14,
          backgroundRps: 4,
        },
        peakLoad: 0.75,
        avgLoad: 0.0125,
        smoothedLoad: 0.15,
      },
      'bot-b': {
        windowSec: expectedWindowSec,
        totalRequests: 3,
        avgRps: avg(3),
        peakRps: 2,
        activeSeconds: 2,
        trafficClasses: {
          critical: {
            totalRequests: 0,
            avgRps: 0,
            peakRps: 0,
            activeSeconds: 0,
          },
          interactive: {
            totalRequests: 1,
            avgRps: avg(1),
            peakRps: 1,
            activeSeconds: 1,
          },
          background: {
            totalRequests: 2,
            avgRps: avg(2),
            peakRps: 2,
            activeSeconds: 1,
          },
        },
        limits: {
          globalRps: 30,
          criticalRps: 16,
          interactiveRps: 14,
          backgroundRps: 4,
        },
        peakLoad: 0.5,
        avgLoad: 0.0083,
        smoothedLoad: 0.1,
      },
    });

    await service.onModuleDestroy();
  });

  it('combines shared overall pressure with isolated service class pressure', async () => {
    const service = new MaxApiMetricsService(createConfigMock('API Action / A') as never);
    const store = redisStores[0]!;
    const nowSec = Math.floor(Date.now() / 1_000);
    const servicePrefix = 'maxapi:rps:service:v1:api_action_a';

    store.set(`${servicePrefix}:bot:bot-a:critical:${nowSec}`, '2');
    store.set(`${servicePrefix}:bot:bot-a:interactive:${nowSec}`, '3');
    store.set(`${servicePrefix}:bot:bot-a:background:${nowSec}`, '4');
    store.set(`${servicePrefix}:bot:bot-a:background:${nowSec - 1}`, '1');
    store.set(`${servicePrefix}:stack:critical:${nowSec}`, '2');
    store.set(`${servicePrefix}:stack:interactive:${nowSec}`, '3');
    store.set(`${servicePrefix}:stack:background:${nowSec}`, '4');
    store.set(`${servicePrefix}:stack:background:${nowSec - 1}`, '1');

    store.set(`maxapi:rps:service:v1:api_action_b:bot:bot-a:background:${nowSec}`, '100');
    store.set(`maxapi:rps:service:v1:api_action_b:stack:background:${nowSec}`, '100');
    store.set(`maxapi:rps:global:bot-a:${nowSec}`, '109');
    store.set(`maxapi:rps:global:bot-a:${nowSec - 1}`, '1');
    store.set(`maxapi:rps:global:bot-a:background:${nowSec}`, '200');
    store.set(`maxapi:rps:stack:${nowSec}`, '109');
    store.set(`maxapi:rps:stack:${nowSec - 1}`, '1');
    store.set(`maxapi:rps:stack:background:${nowSec}`, '200');

    const [bots, stack] = await Promise.all([
      service.getBotRateLimitSnapshot(['bot-a'], {
        windowSec: 60,
        capacityScope: 'service',
      }),
      service.getStackRateLimitSnapshot({ windowSec: 60, capacityScope: 'service' }),
    ]);

    expect(bots['bot-a']).toMatchObject({
      totalRequests: 110,
      peakRps: 109,
      activeSeconds: 2,
      trafficClasses: {
        critical: { totalRequests: 2 },
        interactive: { totalRequests: 3 },
        background: { totalRequests: 5 },
      },
    });
    expect(stack).toMatchObject({
      totalRequests: 110,
      peakRps: 109,
      activeSeconds: 2,
      trafficClasses: {
        critical: { totalRequests: 2 },
        interactive: { totalRequests: 3 },
        background: { totalRequests: 5 },
      },
    });

    await service.onModuleDestroy();
  });

  it('keeps shared overall load during service-metric cold start', async () => {
    const service = new MaxApiMetricsService(createConfigMock('API Action / A') as never);
    const store = redisStores[0]!;
    const nowSec = Math.floor(Date.now() / 1_000);

    store.set(`maxapi:rps:global:bot-a:${nowSec}`, '12');
    store.set(`maxapi:rps:stack:${nowSec}`, '12');
    store.set(`maxapi:rps:global:bot-a:background:${nowSec}`, '12');
    store.set(`maxapi:rps:stack:background:${nowSec}`, '12');

    const [bots, stack] = await Promise.all([
      service.getBotRateLimitSnapshot(['bot-a'], {
        windowSec: 60,
        capacityScope: 'service',
      }),
      service.getStackRateLimitSnapshot({ windowSec: 60, capacityScope: 'service' }),
    ]);

    expect(bots['bot-a']).toMatchObject({
      totalRequests: 12,
      smoothedLoad: 0.08,
      trafficClasses: {
        critical: { totalRequests: 0 },
        interactive: { totalRequests: 0 },
        background: { totalRequests: 0 },
      },
    });
    expect(stack).toMatchObject({
      totalRequests: 12,
      smoothedLoad: 0.08,
      trafficClasses: {
        critical: { totalRequests: 0 },
        interactive: { totalRequests: 0 },
        background: { totalRequests: 0 },
      },
    });

    await service.onModuleDestroy();
  });

  it('aggregates stack-wide limiter pressure across all runtime bots', async () => {
    const service = new MaxApiMetricsService(createConfigMock() as never);
    const store = redisStores[0]!;
    const nowSec = Math.floor(Date.now() / 1_000);
    const expectedWindowSec = 60;
    const avg = (totalRequests: number) => Number((totalRequests / expectedWindowSec).toFixed(3));

    store.set(`maxapi:rps:stack:${nowSec}`, '20');
    store.set(`maxapi:rps:stack:critical:${nowSec}`, '8');
    store.set(`maxapi:rps:stack:interactive:${nowSec}`, '9');
    store.set(`maxapi:rps:stack:background:${nowSec}`, '3');
    store.set(`maxapi:rps:stack:${nowSec - 1}`, '16');
    store.set(`maxapi:rps:stack:critical:${nowSec - 1}`, '2');
    store.set(`maxapi:rps:stack:interactive:${nowSec - 1}`, '10');
    store.set(`maxapi:rps:stack:background:${nowSec - 1}`, '4');

    await expect(service.getStackRateLimitSnapshot({ windowSec: 10 })).resolves.toEqual({
      windowSec: expectedWindowSec,
      totalRequests: 36,
      avgRps: avg(36),
      peakRps: 20,
      activeSeconds: 2,
      trafficClasses: {
        critical: {
          totalRequests: 10,
          avgRps: avg(10),
          peakRps: 8,
          activeSeconds: 2,
        },
        interactive: {
          totalRequests: 19,
          avgRps: avg(19),
          peakRps: 10,
          activeSeconds: 2,
        },
        background: {
          totalRequests: 7,
          avgRps: avg(7),
          peakRps: 4,
          activeSeconds: 2,
        },
      },
      limits: {
        globalRps: 30,
        criticalRps: 16,
        interactiveRps: 14,
        backgroundRps: 4,
      },
      peakLoad: 1,
      avgLoad: 0.0293,
      smoothedLoad: 0.35,
    });

    await service.onModuleDestroy();
  });
});
