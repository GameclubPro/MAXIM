import { PublisherSetupRequiredException } from '../publisher/publisher-errors';
import { PublicationLifecycle, PublicationScheduleStatus } from '../prisma/prisma-client';
import { PublicationService } from './publication.service';

function createHarness() {
  const scheduledAt = new Date('2026-09-13T09:00:00Z');
  const schedule = {
    id: 'schedule',
    publicationId: 'publication',
    revision: 2,
    nextMaterializeAt: scheduledAt,
    rule: {
      mode: 'recurrence',
      timezone: 'UTC',
      frequency: 'daily',
      interval: 1,
      weekdays: [],
      times: ['12:00'],
      startsAt: '2026-09-13T09:00:00Z',
      endsAt: null,
      maxOccurrences: 2,
      replaceConflicts: false,
    },
    publication: {
      id: 'publication',
      canonicalContentRevisionId: 'content',
      dispatchProfile: 'PUBLIK_V1',
      requiredBotId: 'publik',
      actorUserId: 'author',
    },
  };
  const scheduleUpdate = jest.fn().mockResolvedValue({ count: 1 });
  const publicationUpdate = jest.fn().mockResolvedValue({ count: 1 });
  const occurrenceCreate = jest.fn().mockResolvedValue({ count: 2 });
  const claim = jest.fn().mockResolvedValue({ count: 1 });
  const latest = jest.fn().mockResolvedValue(null);
  const tx = {
    publicationSchedule: { updateMany: claim },
    publication: {
      findUnique: jest.fn().mockResolvedValue({ canonicalContentRevisionId: 'content' }),
    },
    publicationOccurrence: { createMany: occurrenceCreate },
  };
  const transaction = jest.fn(async (callback) => callback(tx));
  const service = Object.assign(Object.create(PublicationService.prototype), {
    prisma: {
      publicationSchedule: {
        findMany: jest.fn().mockResolvedValue([schedule]),
        updateMany: scheduleUpdate,
      },
      publicationOccurrence: { findFirst: latest, count: jest.fn().mockResolvedValue(0) },
      publication: { updateMany: publicationUpdate },
      $transaction: transaction,
    },
    logger: { warn: jest.fn() },
    resolveOccurrenceTargets: jest.fn().mockResolvedValue([{ chatId: 'chat', entityType: 'chat' }]),
    lockPublicationCalendar: jest.fn().mockResolvedValue(undefined),
    reservePublicationCalendar: jest.fn().mockResolvedValue(undefined),
  });
  return {
    service,
    scheduleUpdate,
    publicationUpdate,
    occurrenceCreate,
    latest,
    transaction,
    claim,
  };
}

describe('Publication recurrence preparation recovery', () => {
  beforeEach(() => jest.useFakeTimers().setSystemTime(new Date('2026-09-13T10:00:00Z')));
  afterEach(() => jest.useRealTimers());

  it.each(['P1001', 'P2024', 'P2028', 'P2034'])(
    'preserves the schedule after %s and materializes it on the next poll',
    async (code) => {
      const harness = createHarness();
      const error = Object.assign(new Error('Transient database failure'), { code });
      harness.transaction.mockRejectedValueOnce(error);
      await harness.service.materializeRecurringSchedules(1);
      expect(harness.scheduleUpdate).not.toHaveBeenCalled();
      expect(harness.publicationUpdate).not.toHaveBeenCalled();
      expect(harness.occurrenceCreate).not.toHaveBeenCalled();

      await harness.service.materializeRecurringSchedules(1);
      expect(harness.occurrenceCreate).toHaveBeenCalledTimes(1);
      expect(harness.claim).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ lastError: null }),
        }),
      );
    },
  );

  it('does not terminalize the schedule when a pre-transaction read times out', async () => {
    const harness = createHarness();
    harness.latest.mockRejectedValue(Object.assign(new Error('Pool timeout'), { code: 'P2024' }));
    await harness.service.materializeRecurringSchedules(1);
    expect(harness.scheduleUpdate).not.toHaveBeenCalled();
    expect(harness.publicationUpdate).not.toHaveBeenCalled();
    expect(harness.transaction).not.toHaveBeenCalled();
  });

  it('backs off unavailable Publisher access without canceling the recurrence', async () => {
    const harness = createHarness();
    harness.service.resolveOccurrenceTargets.mockRejectedValue(
      new PublisherSetupRequiredException(['chat'], 'PUBLISHER_ACTOR_ACCESS_REQUIRED'),
    );
    await harness.service.materializeRecurringSchedules(1);
    expect(harness.scheduleUpdate).toHaveBeenCalledWith({
      where: {
        id: 'schedule',
        revision: 2,
        status: PublicationScheduleStatus.ACTIVE,
        nextMaterializeAt: new Date('2026-09-13T09:00:00Z'),
        publication: { is: { lifecycle: PublicationLifecycle.ACTIVE } },
      },
      data: {
        nextMaterializeAt: new Date('2026-09-13T10:01:00Z'),
        lastError: 'PUBLISHER_ACTOR_ACCESS_REQUIRED',
      },
    });
    expect(harness.publicationUpdate).not.toHaveBeenCalled();
    expect(harness.occurrenceCreate).not.toHaveBeenCalled();
  });

  it('still records a permanent preparation failure under the observed schedule fence', async () => {
    const harness = createHarness();
    harness.service.reservePublicationCalendar.mockRejectedValue(new Error('Invalid calendar'));
    await harness.service.materializeRecurringSchedules(1);
    expect(harness.scheduleUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          nextMaterializeAt: new Date('2026-09-13T09:00:00Z'),
          revision: 2,
        }),
        data: {
          status: PublicationScheduleStatus.ERROR,
          nextMaterializeAt: null,
          lastError: 'Invalid calendar',
        },
      }),
    );
    expect(harness.publicationUpdate).toHaveBeenCalledTimes(1);
  });
});
