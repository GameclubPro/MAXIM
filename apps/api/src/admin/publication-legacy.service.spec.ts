import { decodeLegacyPublicationListCursor } from '@maxim/contracts/publication';
import { BadRequestException } from '@nestjs/common';
import {
  ChatEntityType,
  ManagedAutopostMaterializationStatus,
  ManagedAutopostRuleStatus,
  ManagedBroadcastDeliveryStatus,
  ManagedBroadcastStatus,
} from '../prisma/prisma-client';
import { PublicationLegacyService } from './publication-legacy.service';

const user = {
  userId: 'user-1',
  username: null,
  displayName: null,
};

function payload(overrides: Record<string, unknown> = {}) {
  return {
    text: 'Новости проекта',
    textFormat: 'markdown',
    targetMode: 'current',
    targetChatIds: ['chat-1'],
    applyToAllChats: false,
    buttons: [],
    buttonEnabled: false,
    buttonUrl: '',
    buttonText: 'Открыть',
    imageEnabled: false,
    imageBase64: '',
    imageMimeType: '',
    imageFileName: '',
    images: [],
    mediaType: null,
    mediaPayload: null,
    mediaMimeType: '',
    mediaFileName: '',
    scheduleMode: 'calendar',
    scheduleTimezone: 'Europe/Moscow',
    scheduledSlots: ['2027-07-10T09:00:00.000Z'],
    replaceConflictingSlots: false,
    sendAt: null,
    cycleEnabled: false,
    cycleEveryHours: 1,
    cycleCount: 1,
    ...overrides,
  };
}

function autopostRow(id: string, updatedAt: string) {
  return {
    id,
    sourceChatId: 'chat-1',
    entityType: ChatEntityType.CHAT,
    status: ManagedAutopostRuleStatus.ACTIVE,
    revision: 3,
    title: 'Ежедневные новости',
    nextMaterializeAt: new Date('2027-07-10T08:55:00.000Z'),
    lastError: null,
    createdAt: new Date('2026-07-01T09:00:00.000Z'),
    updatedAt: new Date(updatedAt),
  };
}

function autopostProjection(id: string) {
  const content = payload();
  return {
    id,
    text: content.text,
    targetMode: content.targetMode,
    targetChatIds: content.targetChatIds,
    imageEnabled: content.imageEnabled,
    imageCount: content.images.length,
    mediaType: content.mediaType,
    scheduleTimezone: content.scheduleTimezone,
    scheduledSlots: content.scheduledSlots,
  };
}

function broadcastRow(id: string, updatedAt: string) {
  return {
    id,
    sourceChatId: 'chat-1',
    entityType: ChatEntityType.CHAT,
    status: ManagedBroadcastStatus.ACTIVE,
    text: `Новости ${id}`,
    applyToAllChats: false,
    targetChatIds: ['chat-1'],
    imageEnabled: false,
    mediaType: null,
    scheduleTimezone: 'Europe/Moscow',
    nextSendAt: new Date('2027-07-10T09:00:00.000Z'),
    lastError: null,
    createdAt: new Date('2026-07-01T09:00:00.000Z'),
    updatedAt: new Date(updatedAt),
  };
}

function createService() {
  const managedAutopostRule = {
    findMany: jest
      .fn()
      .mockResolvedValueOnce([autopostRow('autopost-a', '2026-07-12T12:00:00.000Z')])
      .mockResolvedValueOnce([]),
    count: jest.fn().mockResolvedValue(1),
  };
  const managedBroadcast = {
    findMany: jest
      .fn()
      .mockResolvedValueOnce([
        broadcastRow('broadcast-b', '2026-07-12T11:00:00.000Z'),
        broadcastRow('broadcast-c', '2026-07-12T10:00:00.000Z'),
      ])
      .mockResolvedValueOnce([broadcastRow('broadcast-c', '2026-07-12T10:00:00.000Z')]),
    count: jest.fn().mockResolvedValue(2),
  };
  const $queryRaw = jest.fn().mockResolvedValue([autopostProjection('autopost-a')]);
  const managedAutopostMaterialization = {
    findMany: jest.fn().mockResolvedValue([]),
  };
  const prisma = {
    managedAutopostRule,
    managedAutopostMaterialization,
    managedBroadcast,
    $queryRaw,
  };
  const managedEntitiesService = {
    listChats: jest.fn().mockResolvedValue([
      {
        id: 'chat-1',
        title: 'Основной чат',
        entityType: 'chat',
        avatarUrl: null,
        link: 'https://max.ru/chat-1',
      },
    ]),
    listChannels: jest.fn().mockResolvedValue([
      {
        id: 'channel-1',
        title: 'Канал',
        entityType: 'channel',
        avatarUrl: null,
        link: 'https://max.ru/channel-1',
      },
    ]),
  };
  const service = new PublicationLegacyService(prisma as never, managedEntitiesService as never);
  return {
    $queryRaw,
    managedAutopostRule,
    managedAutopostMaterialization,
    managedBroadcast,
    managedEntitiesService,
    service,
  };
}

describe('PublicationLegacyService', () => {
  it('paginates a stable merged legacy list without duplicates', async () => {
    const { $queryRaw, managedAutopostRule, managedBroadcast, service } = createService();
    const query = { view: 'active', kind: 'all', entityType: 'chat', query: 'Новости', limit: 2 };

    const firstPage = await service.list(user as never, query);
    expect(firstPage.items.map((item) => item.id)).toEqual(['autopost-a', 'broadcast-b']);
    expect(firstPage.totalCount).toBe(3);
    expect(firstPage.nextCursor).not.toBeNull();
    expect(decodeLegacyPublicationListCursor(firstPage.nextCursor ?? '')).toEqual({
      v: 1,
      updatedAt: '2026-07-12T11:00:00.000Z',
      id: 'broadcast-b',
      itemKind: 'broadcast',
      view: 'active',
      kind: 'all',
      entityType: 'chat',
      query: 'Новости',
    });

    const secondPage = await service.list(user as never, {
      ...query,
      cursor: firstPage.nextCursor ?? undefined,
    });
    expect(secondPage.items.map((item) => item.id)).toEqual(['broadcast-c']);
    expect(secondPage.totalCount).toBe(3);
    expect(secondPage.nextCursor).toBeNull();
    expect(
      firstPage.items.some((first) => secondPage.items.some((second) => second.id === first.id)),
    ).toBe(false);

    expect(managedAutopostRule.findMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [{ entityType: ChatEntityType.CHAT, sourceChatId: { in: ['chat-1'] } }],
          status: {
            in: [
              ManagedAutopostRuleStatus.ACTIVE,
              ManagedAutopostRuleStatus.PAUSED,
              ManagedAutopostRuleStatus.ERROR,
            ],
          },
          AND: [
            {
              OR: [
                { title: { contains: 'Новости', mode: 'insensitive' } },
                {
                  chat: { is: { title: { contains: 'Новости', mode: 'insensitive' } } },
                },
                {
                  payload: {
                    path: ['text'],
                    string_contains: 'Новости',
                    mode: 'insensitive',
                  },
                },
              ],
            },
          ],
        }),
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        take: 3,
        select: expect.not.objectContaining({ payload: true }),
      }),
    );
    expect($queryRaw).toHaveBeenCalledTimes(1);
    expect(managedBroadcast.findMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: expect.objectContaining({
          publicationOccurrenceId: null,
          autopostMaterializations: { none: {} },
        }),
        select: expect.not.objectContaining({
          imageBase64: true,
          mediaPayload: true,
        }),
      }),
    );
    expect(managedBroadcast.findMany.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({
        where: expect.objectContaining({
          AND: expect.arrayContaining([
            {
              OR: [
                { updatedAt: { lt: new Date('2026-07-12T11:00:00.000Z') } },
                {
                  updatedAt: new Date('2026-07-12T11:00:00.000Z'),
                  id: { lt: 'broadcast-b' },
                },
              ],
            },
          ]),
        }),
      }),
    );
  });

  it('rejects a cursor when any bound filter changes', async () => {
    const { service } = createService();
    const firstPage = await service.list(user as never, { view: 'active', limit: 2 });

    await expect(
      service.list(user as never, {
        view: 'history',
        limit: 2,
        cursor: firstPage.nextCursor,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('uses the item kind as the final cursor tie-breaker across legacy tables', async () => {
    const { $queryRaw, managedAutopostRule, managedBroadcast, service } = createService();
    const updatedAt = '2026-07-12T12:00:00.000Z';
    managedAutopostRule.findMany.mockReset();
    managedAutopostRule.findMany
      .mockResolvedValueOnce([autopostRow('shared-id', updatedAt)])
      .mockResolvedValueOnce([autopostRow('shared-id', updatedAt)]);
    managedBroadcast.findMany.mockReset();
    managedBroadcast.findMany
      .mockResolvedValueOnce([broadcastRow('shared-id', updatedAt)])
      .mockResolvedValueOnce([]);
    $queryRaw.mockResolvedValue([autopostProjection('shared-id')]);

    const firstPage = await service.list(user as never, { view: 'active', limit: 1 });
    expect(firstPage.items.map((item) => item.kind)).toEqual(['broadcast']);

    const secondPage = await service.list(user as never, {
      view: 'active',
      limit: 1,
      cursor: firstPage.nextCursor ?? undefined,
    });
    expect(secondPage.items.map((item) => item.kind)).toEqual(['autopost']);
    expect(secondPage.nextCursor).toBeNull();
  });

  it('surfaces failed and ambiguous deliveries from the current autopost revision', async () => {
    const { managedAutopostMaterialization, service } = createService();
    managedAutopostMaterialization.findMany.mockResolvedValue([
      {
        ruleId: 'autopost-a',
        broadcast: {
          status: ManagedBroadcastStatus.ACTIVE,
          lastError: null,
          deliveries: [{ id: 'delivery-1' }],
        },
      },
    ]);

    const response = await service.list(user as never, {
      view: 'active',
      kind: 'autopost',
      limit: 2,
    });

    expect(response.items[0]).toEqual(
      expect.objectContaining({
        kind: 'autopost',
        status: ManagedAutopostRuleStatus.ERROR,
        lastError: 'Есть неоднозначная доставка после таймаута MAX. Проверьте публикацию вручную.',
      }),
    );
    expect(managedAutopostMaterialization.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: ManagedAutopostMaterializationStatus.CREATED,
          OR: [{ ruleId: 'autopost-a', revision: 3 }],
          broadcast: {
            is: {
              OR: [
                {
                  status: {
                    in: [ManagedBroadcastStatus.FAILED, ManagedBroadcastStatus.PARTIAL],
                  },
                },
                {
                  deliveries: {
                    some: { status: ManagedBroadcastDeliveryStatus.AMBIGUOUS },
                  },
                },
              ],
            },
          },
        }),
      }),
    );
  });

  it('does not query legacy tables when the requested entity type is inaccessible', async () => {
    const { managedAutopostRule, managedBroadcast, managedEntitiesService, service } =
      createService();
    managedEntitiesService.listChannels.mockResolvedValue([]);

    await expect(service.list(user as never, { entityType: 'channel' })).resolves.toEqual({
      items: [],
      nextCursor: null,
      totalCount: 0,
    });
    expect(managedAutopostRule.findMany).not.toHaveBeenCalled();
    expect(managedBroadcast.findMany).not.toHaveBeenCalled();
  });
});
