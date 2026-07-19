import {
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

describe('PublicationPresenterService', () => {
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
      ]),
    );
  });
});
