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
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { ManagedGiveawayService } from './managed-giveaway.service';

function createSignedInitData(botToken: string, userId: string, authDateSec: number): string {
  const entries: Array<[string, string]> = [
    ['auth_date', String(authDateSec)],
    ['user', JSON.stringify({ id: userId })],
  ];
  const sortedPairs = [...entries]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  const secretKey = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const hash = createHmac('sha256', secretKey).update(sortedPairs).digest('hex');

  return [...entries, ['hash', hash]]
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join('&');
}

describe('AdminController chats refresh auth e2e', () => {
  let app: NestFastifyApplication;
  const botToken = 'test-bot-token';
  const listChatsWithRefreshState = jest.fn();

  beforeEach(async () => {
    listChatsWithRefreshState.mockReset().mockResolvedValue({
      items: [],
      snapshot: {
        version: 'snapshot-v1',
        builtAt: '2026-04-04T10:00:00.000Z',
        lastSyncedAt: '2026-04-04T09:59:30.000Z',
        source: 'published_snapshot',
        stale: true,
      },
      refresh: {
        complete: true,
        cursor: -1,
        backoffActive: false,
        nextPollAfterMs: 0,
        processedCandidates: null,
        totalCandidates: null,
        progressPercent: 100,
        lastSyncedAt: '2026-04-01T19:00:00.000Z',
        manualRefreshBlockedReason: 'recent_sync',
        manualRefreshRetryAfterMs: 18_000,
      },
    });

    const moduleRef = await Test.createTestingModule({
      controllers: [AdminController],
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
          provide: AdminService,
          useValue: {
            listChatsWithRefreshState,
          },
        },
        {
          provide: ManagedGiveawayService,
          useValue: {},
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

  it('rejects an unauthenticated chats refresh request', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/chats?refresh=1&includeRefreshState=1&bypassCache=1',
    });

    expect(response.statusCode).toBe(401);
  });

  it('returns refresh state for an authenticated chats refresh request', async () => {
    const initData = createSignedInitData(botToken, '100', Math.floor(Date.now() / 1_000));

    const response = await app.inject({
      method: 'GET',
      url: '/v1/chats?refresh=1&includeRefreshState=1&bypassCache=1',
      headers: {
        authorization: `InitData ${initData}`,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      items: [],
      snapshot: {
        version: 'snapshot-v1',
        builtAt: '2026-04-04T10:00:00.000Z',
        lastSyncedAt: '2026-04-04T09:59:30.000Z',
        source: 'published_snapshot',
        stale: true,
      },
      refresh: {
        complete: true,
        cursor: -1,
        backoffActive: false,
        nextPollAfterMs: 0,
        processedCandidates: null,
        totalCandidates: null,
        progressPercent: 100,
        lastSyncedAt: '2026-04-01T19:00:00.000Z',
        manualRefreshBlockedReason: 'recent_sync',
        manualRefreshRetryAfterMs: 18_000,
      },
    });

    expect(listChatsWithRefreshState).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: '100',
        username: null,
        displayName: null,
        avatarUrl: null,
        profileUrl: null,
      }),
      {
        refresh: true,
        fresh: false,
        bypassRemoteCache: true,
        resetRefreshCursor: false,
      },
    );
  });
});
