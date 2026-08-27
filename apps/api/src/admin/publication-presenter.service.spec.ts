import {
  ChatEntityType,
  PublicationDispatchProfile,
  PublicationLifecycle,
  PublicationOccurrenceStatus,
  PublicationScheduleMode,
  PublicationScheduleStatus,
} from '../prisma/prisma-client';
import { PublicationPresenterService } from './publication-presenter.service';

const EMPTY_DELIVERY = {
  total: 0,
  pending: 0,
  sent: 0,
  failed: 0,
  ambiguous: 0,
  canceled: 0,
};

function extractSqlText(query: unknown): string {
  const strings = (query as { strings?: readonly string[] } | null)?.strings;
  return (Array.isArray(strings) ? strings.join('?') : String(query)).replace(/\s+/gu, ' ').trim();
}

function extractSqlValues(query: unknown): readonly unknown[] {
  return (query as { values?: readonly unknown[] } | null)?.values ?? [];
}

describe('PublicationPresenterService', () => {
  it('uses only the exact active Publisher catalog for PUBLIK_V1 target presentation', async () => {
    const catalogFindMany = jest.fn().mockResolvedValue([
      {
        chatId: 'chat-publisher',
        entityType: ChatEntityType.CHAT,
        title: 'Название Публика',
        avatarUrl: 'https://cdn.max/publisher.png',
        link: 'https://max.ru/publisher-chat',
      },
      {
        chatId: 'channel-fallback',
        entityType: ChatEntityType.CHANNEL,
        title: '   ',
        avatarUrl: null,
        link: 'https://example.com/not-max',
      },
    ]);
    const presenter = new PublicationPresenterService({
      managedBotChatCatalog: { findMany: catalogFindMany },
    } as never);
    const targets = [
      {
        targetChatId: 'chat-publisher',
        entityType: ChatEntityType.CHAT,
        chat: { title: 'Устаревшее название Майора' },
      },
      {
        targetChatId: 'channel-fallback',
        entityType: ChatEntityType.CHANNEL,
        chat: { title: 'Название канала из Майора' },
      },
    ];
    const presentations = await presenter.loadPublisherTargetPresentations(
      targets,
      'publisher-bot',
    );
    const details = await presenter.mapPublicationDetails(
      {
        id: 'publication-publisher',
        title: 'Публикация',
        lifecycle: PublicationLifecycle.ACTIVE,
        dispatchProfile: PublicationDispatchProfile.PUBLIK_V1,
        version: 1,
        canonicalContentRevisionId: 'content-1',
        canonicalContentRevision: {
          id: 'content-1',
          revision: 1,
          text: 'Текст',
          textFormat: 'PLAIN',
          buttons: [],
          assets: [],
        },
        targets,
        audienceSelection: 'SELECTED',
        audienceMode: 'SNAPSHOT',
        schedule: null,
        occurrences: [],
        deliveryStats: EMPTY_DELIVERY,
        actionableDeliveryStats: EMPTY_DELIVERY,
        createdAt: new Date('2026-08-27T10:00:00.000Z'),
        updatedAt: new Date('2026-08-27T10:00:00.000Z'),
      },
      presentations,
    );

    expect(details.targets).toEqual([
      expect.objectContaining({
        chatId: 'chat-publisher',
        title: 'Название Публика',
        avatarUrl: 'https://cdn.max/publisher.png',
        link: 'https://max.ru/publisher-chat',
      }),
      expect.objectContaining({
        chatId: 'channel-fallback',
        title: 'channel-fallback',
        link: null,
      }),
    ]);
    expect(details.targetPreviews.map((target) => target.title)).toEqual([
      'Название Публика',
      'channel-fallback',
    ]);
    expect(JSON.stringify(details)).not.toContain('Майора');
    expect(catalogFindMany).toHaveBeenCalledWith({
      where: {
        botId: 'publisher-bot',
        chatId: { in: ['chat-publisher', 'channel-fallback'] },
        status: 'ACTIVE',
      },
      select: {
        chatId: true,
        entityType: true,
        title: true,
        avatarUrl: true,
        link: true,
      },
    });
  });

  it('searches the active exact Publisher catalog by its displayed title or ID fallback', async () => {
    const queryRaw = jest
      .fn()
      .mockResolvedValue([{ chatId: 'fallback-channel', entityType: ChatEntityType.CHANNEL }]);
    const presenter = new PublicationPresenterService({
      $queryRaw: queryRaw,
    } as never);

    await expect(
      presenter.findPublisherTargetSearchMatches('publisher-bot', 'fallback'),
    ).resolves.toEqual([{ chatId: 'fallback-channel', entityType: ChatEntityType.CHANNEL }]);
    const searchSql = extractSqlText(queryRaw.mock.calls[0]?.[0]);
    const searchValues = extractSqlValues(queryRaw.mock.calls[0]?.[0]);
    expect(searchSql).toContain('FROM "managed_bot_chat_catalog" AS catalog');
    expect(searchSql).toContain('catalog."status" = \'ACTIVE\'');
    expect(searchSql).toContain(
      'COALESCE(NULLIF(BTRIM(catalog."title"), \'\'), catalog."chat_id") ILIKE ?',
    );
    expect(searchValues).toEqual(['publisher-bot', '%fallback%', 501]);
  });

  it('batches Publisher catalog presentation reads and rejects overbroad searches', async () => {
    const catalogFindMany = jest.fn().mockResolvedValue([]);
    const queryRaw = jest.fn().mockResolvedValue(
      Array.from({ length: 501 }, (_, index) => ({
        chatId: `chat-${index}`,
        entityType: ChatEntityType.CHAT,
      })),
    );
    const presenter = new PublicationPresenterService({
      managedBotChatCatalog: { findMany: catalogFindMany },
      $queryRaw: queryRaw,
    } as never);
    const targets = Array.from({ length: 201 }, (_, index) => ({
      targetChatId: `chat-${index}`,
      entityType: ChatEntityType.CHAT,
    }));

    await presenter.loadPublisherTargetPresentations(targets, 'publisher-bot');
    expect(catalogFindMany).toHaveBeenCalledTimes(2);
    expect(catalogFindMany.mock.calls[0]?.[0].where.chatId.in).toHaveLength(200);
    expect(catalogFindMany.mock.calls[1]?.[0].where.chatId.in).toEqual(['chat-200']);
    await expect(presenter.findPublisherTargetSearchMatches('publisher-bot', 'а')).rejects.toThrow(
      'Уточните поиск по чатам и каналам.',
    );
  });

  it('maps current and historical delivery content revisions without guessing legacy rows', () => {
    const presenter = new PublicationPresenterService({} as never);
    const publicationOccurrence = {
      publication: { canonicalContentRevisionId: 'content-current' },
    };

    expect(
      presenter.mapDeliveryContentRevision({
        contentRevision: { id: 'content-current', revision: 4 },
        publicationOccurrence,
      }),
    ).toEqual({ contentRevision: 4, usesLatestContent: true });
    expect(
      presenter.mapDeliveryContentRevision({
        contentRevision: { id: 'content-old', revision: 2 },
        publicationOccurrence,
      }),
    ).toEqual({ contentRevision: 2, usesLatestContent: false });
    expect(
      presenter.mapDeliveryContentRevision({
        contentRevision: null,
        publicationOccurrence,
      }),
    ).toEqual({});
  });

  it('makes only failed occurrences from the current schedule revision retryable', async () => {
    const presenter = new PublicationPresenterService({} as never);
    const details = await presenter.mapPublicationDetails({
      id: 'publication-1',
      title: 'Публикация',
      lifecycle: PublicationLifecycle.ACTIVE,
      version: 3,
      canonicalContentRevisionId: 'content-2',
      canonicalContentRevision: {
        id: 'content-2',
        revision: 2,
        text: 'Новая версия',
        textFormat: 'PLAIN',
        buttons: [
          {
            text: 'Broken',
            url: 'https://max.ru/chat/example/https://nested.example.test',
          },
          { text: 'Open', url: 'https://example.test/post' },
        ],
        assets: [],
      },
      audienceSelection: 'SELECTED',
      audienceMode: 'SNAPSHOT',
      targets: [],
      schedule: {
        id: 'schedule-1',
        mode: PublicationScheduleMode.NOW,
        status: PublicationScheduleStatus.ACTIVE,
        revision: 2,
        rule: { mode: 'now', timezone: 'Europe/Moscow' },
        lastError: null,
      },
      occurrences: [
        {
          id: 'occurrence-current',
          scheduleId: 'schedule-1',
          scheduleRevision: 2,
          contentRevisionId: 'content-2',
          contentRevision: { revision: 2 },
          scheduledAt: new Date('2026-07-18T10:00:00.000Z'),
          status: PublicationOccurrenceStatus.FAILED,
          deliveryStats: { ...EMPTY_DELIVERY, total: 1, failed: 1 },
        },
        {
          id: 'occurrence-old',
          scheduleId: 'schedule-1',
          scheduleRevision: 1,
          contentRevisionId: 'content-1',
          contentRevision: { revision: 1 },
          scheduledAt: new Date('2026-07-17T10:00:00.000Z'),
          status: PublicationOccurrenceStatus.FAILED,
          deliveryStats: { ...EMPTY_DELIVERY, total: 1, failed: 1 },
        },
        {
          id: 'occurrence-missing-envelope',
          scheduleId: 'schedule-1',
          scheduleRevision: 2,
          contentRevisionId: 'content-2',
          contentRevision: { revision: 2 },
          scheduledAt: new Date('2026-07-16T10:00:00.000Z'),
          status: PublicationOccurrenceStatus.FAILED,
          legacyBroadcastId: null,
          deliveryStats: EMPTY_DELIVERY,
          _count: { legacyBroadcasts: 0 },
        },
      ],
      deliveryStats: { ...EMPTY_DELIVERY, total: 2, failed: 2 },
      actionableDeliveryStats: { ...EMPTY_DELIVERY, total: 1, failed: 1 },
      createdAt: new Date('2026-07-17T09:00:00.000Z'),
      updatedAt: new Date('2026-07-18T09:00:00.000Z'),
    });

    expect(details.actionableDelivery).toEqual({ ...EMPTY_DELIVERY, total: 1, failed: 1 });
    expect(details.content.buttons).toEqual([
      { text: 'Open', url: 'https://example.test/post', row: 0 },
    ]);
    expect(details.occurrences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'occurrence-current',
          canRetry: true,
          contentRevision: 2,
          usesLatestContent: true,
        }),
        expect.objectContaining({
          id: 'occurrence-old',
          canRetry: false,
          contentRevision: 1,
          usesLatestContent: false,
        }),
        expect.objectContaining({
          id: 'occurrence-missing-envelope',
          canRetry: true,
          contentRevision: 2,
          usesLatestContent: true,
        }),
      ]),
    );
  });
});
