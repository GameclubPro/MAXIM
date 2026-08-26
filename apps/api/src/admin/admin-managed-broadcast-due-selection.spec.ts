import {
  ManagedBroadcastDeliveryStatus,
  ManagedBroadcastStatus,
  PublicationDispatchProfile,
  PublicationScheduleMode,
} from '../prisma/prisma-client';
import {
  selectPriorityHalfOpenPublicationVerificationBatch,
  selectPublicationManagedBroadcastDueBatch,
} from './admin-managed-broadcast-due-selection';
import {
  buildPublicationDeliveryVerificationScheduledData,
  hasPublicationDeliveryAutomatedVerificationState,
} from './publication-delivery-verification-state';

describe('publication managed broadcast due selection', () => {
  it('selects only bounded due half-open canaries without excluding pending siblings', async () => {
    const now = new Date('2026-08-07T15:00:00.000Z');
    jest.useFakeTimers().setSystemTime(now);
    try {
      const queryRaw = jest
        .fn()
        .mockResolvedValue([{ id: 'half-open-broadcast', deliveryId: 'half-open-delivery' }]);

      const result = await selectPriorityHalfOpenPublicationVerificationBatch(
        { $queryRaw: queryRaw } as never,
        99,
      );

      expect(result.dueRows).toEqual([
        { id: 'half-open-broadcast', deliveryId: 'half-open-delivery' },
      ]);
      expect(result.staleLockBefore).toEqual(new Date('2026-08-07T14:55:00.000Z'));
      const query = queryRaw.mock.calls[0]?.[0] as {
        strings?: readonly string[];
        values?: readonly unknown[];
      };
      const sql = (query.strings ?? []).join('?').replace(/\s+/gu, ' ').trim();
      expect(query.values).toEqual([
        new Date('2026-08-07T14:55:00.000Z'),
        new Date('2026-08-07T14:59:45.000Z'),
        now,
        'PUBLICATION_MESSAGE_DISAPPEARED',
        now,
        2,
      ]);
      expect(sql).toContain('membership."status" = \'ACTIVE\'::"ChatBotMembershipStatus"');
      expect(sql).toContain('membership."send_route_failure_count" = 1');
      expect(sql).toContain('membership."send_route_last_failure_at" IS NOT NULL');
      expect(sql).toContain('AS "deliveryId"');
      expect(sql).toContain('delivery."sent_at" >= membership."send_route_last_failure_at"');
      expect(sql).toContain('in_flight."status" = \'SENDING\'::"ManagedBroadcastDeliveryStatus"');
      expect(sql).not.toContain(
        'in_flight."status" = \'PENDING\'::"ManagedBroadcastDeliveryStatus"',
      );
      expect(sql).toContain('LIMIT ?');
    } finally {
      jest.useRealTimers();
    }
  });

  it('reserves recovery capacity without letting old verification rows starve new sends', async () => {
    const executionRows = Array.from({ length: 10 }, (_, index) => ({ id: `send-${index + 1}` }));
    const verificationRows = Array.from({ length: 5 }, (_, index) => ({
      id: `verify-${index + 1}`,
    }));
    const findMany = jest
      .fn()
      .mockResolvedValueOnce(executionRows)
      .mockResolvedValueOnce(verificationRows)
      .mockResolvedValueOnce([]);

    const result = await selectPublicationManagedBroadcastDueBatch(
      { managedBroadcast: { findMany } } as never,
      [PublicationScheduleMode.RECURRENCE],
      10,
    );

    expect(result.dueRows.map((row) => row.id)).toEqual([
      ...executionRows.slice(0, 8).map((row) => row.id),
      'verify-1',
      'verify-2',
    ]);
    expect(findMany).toHaveBeenCalledTimes(3);
    expect(findMany.mock.calls[0]?.[0]?.where.dispatchProfile).toBe(
      PublicationDispatchProfile.LEGACY_ROUTED,
    );
    expect(findMany.mock.calls[1]?.[0]?.where.status.in).toEqual([
      ManagedBroadcastStatus.ACTIVE,
      ManagedBroadcastStatus.PARTIAL,
      ManagedBroadcastStatus.FAILED,
    ]);
    expect(findMany.mock.calls[1]?.[0]?.where.deliveries.some.AND[0].OR).toEqual([
      { remoteMessageVerificationNextAt: { not: null } },
      { remoteMessageVerificationAttemptedAt: { not: null } },
      { remoteMessageVerificationSource: { not: null } },
      { remoteMessageVerificationAttemptCount: { gt: 0 } },
      { remoteMessageVerificationAbsentCount: { gt: 0 } },
      { remoteMessageVerificationPresentCount: { gt: 0 } },
    ]);
  });

  it('scopes every publisher due lane to PUBLIK_V1 envelopes', async () => {
    const findMany = jest.fn().mockResolvedValue([]);

    await selectPublicationManagedBroadcastDueBatch(
      { managedBroadcast: { findMany } } as never,
      [PublicationScheduleMode.NOW],
      10,
      PublicationDispatchProfile.PUBLIK_V1,
    );

    expect(findMany).toHaveBeenCalledTimes(3);
    for (const [request] of findMany.mock.calls) {
      const where = request.where;
      const profile = where.dispatchProfile ?? where.AND?.[0]?.dispatchProfile;
      expect(profile).toBe(PublicationDispatchProfile.PUBLIK_V1);
    }
  });

  it('serializes PUBLIK_V1 discovery queries to preserve a foreground pool slot', async () => {
    let resolveExecution!: (rows: Array<{ id: string }>) => void;
    const executionRows = new Promise<Array<{ id: string }>>((resolve) => {
      resolveExecution = resolve;
    });
    const findMany = jest
      .fn()
      .mockReturnValueOnce(executionRows)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const selection = selectPublicationManagedBroadcastDueBatch(
      { managedBroadcast: { findMany } } as never,
      [PublicationScheduleMode.NOW],
      10,
      PublicationDispatchProfile.PUBLIK_V1,
    );
    await Promise.resolve();

    expect(findMany).toHaveBeenCalledTimes(1);
    resolveExecution([]);
    await selection;

    expect(findMany).toHaveBeenCalledTimes(3);
  });

  it('uses the whole batch for verification when no send is due', async () => {
    const verificationRows = [{ id: 'verify-1' }, { id: 'verify-2' }, { id: 'verify-3' }];
    const findMany = jest
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(verificationRows)
      .mockResolvedValueOnce([]);

    const result = await selectPublicationManagedBroadcastDueBatch(
      { managedBroadcast: { findMany } } as never,
      [PublicationScheduleMode.SLOTS],
      3,
    );

    expect(result.dueRows).toEqual(verificationRows);
  });

  it('keeps the only slot for an outbound send when both lanes are due', async () => {
    const findMany = jest
      .fn()
      .mockResolvedValueOnce([{ id: 'send-1' }])
      .mockResolvedValueOnce([{ id: 'verify-1' }])
      .mockResolvedValueOnce([]);

    const result = await selectPublicationManagedBroadcastDueBatch(
      { managedBroadcast: { findMany } } as never,
      [PublicationScheduleMode.NOW],
      1,
    );

    expect(result.dueRows).toEqual([{ id: 'send-1' }]);
  });

  it('keeps a bounded DB-only fallback for ACTIVE envelopes with untouched SENT rows', async () => {
    const findMany = jest.fn().mockResolvedValue([]);

    await selectPublicationManagedBroadcastDueBatch(
      { managedBroadcast: { findMany } } as never,
      [PublicationScheduleMode.RECURRENCE],
      10,
    );

    const activeFallback = findMany.mock.calls[2]?.[0]?.where.AND[1].OR[0];
    expect(activeFallback).toEqual({
      status: ManagedBroadcastStatus.ACTIVE,
      deliveries: {
        some: {
          OR: [
            {
              status: {
                in: [
                  ManagedBroadcastDeliveryStatus.PENDING,
                  ManagedBroadcastDeliveryStatus.SENDING,
                  ManagedBroadcastDeliveryStatus.FAILED,
                  ManagedBroadcastDeliveryStatus.AMBIGUOUS,
                  ManagedBroadcastDeliveryStatus.CANCELED,
                ],
              },
            },
            {
              status: ManagedBroadcastDeliveryStatus.SENT,
              remoteMessageVerifiedAt: { not: null },
            },
            {
              status: ManagedBroadcastDeliveryStatus.SENT,
              remoteMessageId: null,
            },
            {
              status: ManagedBroadcastDeliveryStatus.SENT,
              remoteMessageId: { not: null },
              remoteMessageVerifiedAt: null,
              AND: [
                {
                  remoteMessageVerificationNextAt: null,
                  remoteMessageVerificationAttemptedAt: null,
                  remoteMessageVerificationSource: null,
                  remoteMessageVerificationAttemptCount: 0,
                  remoteMessageVerificationAbsentCount: 0,
                  remoteMessageVerificationPresentCount: 0,
                },
              ],
            },
            expect.objectContaining({
              status: ManagedBroadcastDeliveryStatus.SENT,
              remoteMessageVerifiedAt: null,
            }),
          ],
        },
      },
    });
  });

  it('arms new sends explicitly while leaving pristine legacy state unenrolled', () => {
    const sentAt = new Date('2026-07-27T20:30:00.000Z');
    const scheduled = buildPublicationDeliveryVerificationScheduledData(sentAt);

    expect(hasPublicationDeliveryAutomatedVerificationState(scheduled)).toBe(true);
    expect(scheduled.remoteMessageVerificationNextAt).toEqual(new Date('2026-07-27T20:30:15.000Z'));
    expect(
      hasPublicationDeliveryAutomatedVerificationState({
        remoteMessageVerificationAttemptCount: 0,
        remoteMessageVerificationAbsentCount: 0,
        remoteMessageVerificationPresentCount: 0,
        remoteMessageVerificationAttemptedAt: null,
        remoteMessageVerificationNextAt: null,
        remoteMessageVerificationSource: null,
      }),
    ).toBe(false);
    expect(
      hasPublicationDeliveryAutomatedVerificationState({
        remoteMessageVerificationAttemptCount: 1,
        remoteMessageVerificationNextAt: null,
      }),
    ).toBe(true);
  });
});
