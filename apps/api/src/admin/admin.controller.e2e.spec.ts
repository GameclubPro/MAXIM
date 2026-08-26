import { createHmac } from 'node:crypto';
import { ConflictException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { InitDataGuard } from '../auth/init-data.guard';
import { InitDataService } from '../auth/init-data.service';
import { PublisherInitDataKeyService } from '../auth/publisher-init-data-key.service';
import { MaxBotRegistryService } from '../max/max-bot-registry.service';
import { AdminManagedEntitiesController } from './admin-managed-entities.controller';
import { ManagedEntitiesService } from './managed-entities.service';

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

describe('AdminController auth e2e', () => {
  let app: NestFastifyApplication;
  let appCreated = false;
  const botToken = 'test-bot-token';
  const listChatsWithRefreshState = jest.fn();
  const getManagedEntityFavoriteLabels = jest.fn();
  const updateManagedEntityFavoriteLabels = jest.fn();

  beforeEach(async () => {
    appCreated = false;
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
        userVisibleComplete: true,
        nextPollAfterMs: 0,
        processedCandidates: null,
        totalCandidates: null,
        progressPercent: 100,
        lastSyncedAt: '2026-04-01T19:00:00.000Z',
        manualRefreshBlockedReason: 'recent_sync',
        manualRefreshRetryAfterMs: 18_000,
      },
    });
    getManagedEntityFavoriteLabels.mockReset().mockImplementation((user: { userId: string }) => ({
      initialized: true,
      labels: { important: `VIP ${user.userId}` },
      revision: 1,
    }));
    updateManagedEntityFavoriteLabels
      .mockReset()
      .mockImplementation((_user: { userId: string }, body: { labels: unknown }) => ({
        initialized: true,
        labels: body.labels,
        revision: 2,
      }));

    const moduleRef = await Test.createTestingModule({
      controllers: [AdminManagedEntitiesController],
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
          provide: ManagedEntitiesService,
          useValue: {
            listChatsWithRefreshState,
            getManagedEntityFavoriteLabels,
            updateManagedEntityFavoriteLabels,
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
        userVisibleComplete: true,
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

  it('rejects unauthenticated favorite-label reads and writes', async () => {
    const [readResponse, writeResponse] = await Promise.all([
      app.inject({
        method: 'GET',
        url: '/v1/managed-entities/favorite-labels',
      }),
      app.inject({
        method: 'PUT',
        url: '/v1/managed-entities/favorite-labels',
        payload: { labels: { important: 'VIP' }, expectedRevision: 1 },
      }),
    ]);

    expect(readResponse.statusCode).toBe(401);
    expect(writeResponse.statusCode).toBe(401);
    expect(getManagedEntityFavoriteLabels).not.toHaveBeenCalled();
    expect(updateManagedEntityFavoriteLabels).not.toHaveBeenCalled();
  });

  it('isolates favorite-label profiles by the authenticated administrator', async () => {
    const authDateSec = Math.floor(Date.now() / 1_000);
    const authorization = (userId: string) =>
      `InitData ${createSignedInitData(botToken, userId, authDateSec)}`;

    const firstRead = await app.inject({
      method: 'GET',
      url: '/v1/managed-entities/favorite-labels',
      headers: { authorization: authorization('100') },
    });
    const secondRead = await app.inject({
      method: 'GET',
      url: '/v1/managed-entities/favorite-labels',
      headers: { authorization: authorization('200') },
    });
    const write = await app.inject({
      method: 'PUT',
      url: '/v1/managed-entities/favorite-labels',
      headers: { authorization: authorization('200') },
      payload: { labels: { important: 'Ключевые' }, expectedRevision: 1 },
    });

    expect(firstRead.statusCode).toBe(200);
    expect(firstRead.json()).toEqual({
      initialized: true,
      labels: { important: 'VIP 100' },
      revision: 1,
    });
    expect(secondRead.statusCode).toBe(200);
    expect(secondRead.json()).toEqual({
      initialized: true,
      labels: { important: 'VIP 200' },
      revision: 1,
    });
    expect(write.statusCode).toBe(200);
    expect(write.json()).toEqual({
      initialized: true,
      labels: { important: 'Ключевые' },
      revision: 2,
    });
    expect(getManagedEntityFavoriteLabels.mock.calls.map(([user]) => user.userId)).toEqual([
      '100',
      '200',
    ]);
    expect(updateManagedEntityFavoriteLabels).toHaveBeenCalledWith(
      expect.objectContaining({ userId: '200' }),
      { labels: { important: 'Ключевые' }, expectedRevision: 1 },
    );
  });

  it('returns 409 when another session already advanced the favorite-label revision', async () => {
    const message =
      'Названия категорий уже изменились. Обновите данные и повторите сохранение.';
    updateManagedEntityFavoriteLabels.mockRejectedValueOnce(
      new ConflictException({
        code: 'MANAGED_ENTITY_FAVORITE_LABELS_REVISION_CONFLICT',
        message,
      }),
    );
    const initData = createSignedInitData(botToken, '200', Math.floor(Date.now() / 1_000));

    const response = await app.inject({
      method: 'PUT',
      url: '/v1/managed-entities/favorite-labels',
      headers: { authorization: `InitData ${initData}` },
      payload: { labels: { important: 'Ключевые' }, expectedRevision: 1 },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      code: 'MANAGED_ENTITY_FAVORITE_LABELS_REVISION_CONFLICT',
      message,
    });
    expect(updateManagedEntityFavoriteLabels).toHaveBeenCalledWith(
      expect.objectContaining({ userId: '200' }),
      { labels: { important: 'Ключевые' }, expectedRevision: 1 },
    );
  });
});
