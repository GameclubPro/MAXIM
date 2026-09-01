import { MAX_SEND_ROUTE_DISAPPEARANCE_FAILURE_CODE } from '../max/max-send-route-health';
import {
  ChatBotMembershipStatus,
  ManagedBroadcastDeliveryStatus,
  Prisma,
  PublicationOccurrenceStatus,
} from '../prisma/prisma-client';
import {
  LEGACY_PUBLICATION_DISAPPEARANCE_LAST_ERROR,
  LEGACY_PUBLICATION_EXACT_ABSENCE_ERROR,
} from '../admin/publication-legacy-automated-absence';
import {
  readLegacyPublicationAbsenceNormalizationOptions,
  runLegacyPublicationAbsenceNormalization,
  type LegacyPublicationAbsenceNormalizationOptions,
} from './normalize-legacy-publication-absence';

const NOW = new Date('2026-09-01T10:00:00.000Z');
const SENT_AT = new Date('2026-08-31T10:00:00.000Z');

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    id: 'delivery-1',
    broadcastId: 'broadcast-1',
    occurrenceIndex: 1,
    targetChatId: 'chat-1',
    botId: 'bot-1',
    status: ManagedBroadcastDeliveryStatus.FAILED,
    remoteMessageId: 'remote-message',
    remoteMessageVerifiedAt: null,
    remoteMessageVerificationAttemptCount: 3,
    remoteMessageVerificationAbsentCount: 3,
    remoteMessageVerificationPresentCount: 0,
    remoteMessageVerificationAttemptedAt: new Date('2026-08-31T10:05:00.000Z'),
    remoteMessageVerificationNextAt: null,
    remoteMessageVerificationLastError: LEGACY_PUBLICATION_EXACT_ABSENCE_ERROR,
    remoteMessageVerificationSource: null,
    legacySentWithoutRemoteId: false,
    lastErrorCode: null,
    lastError: LEGACY_PUBLICATION_DISAPPEARANCE_LAST_ERROR,
    sentAt: SENT_AT,
    lockedAt: null,
    lockToken: null,
    publicationOccurrenceId: 'occurrence-1',
    updatedAt: new Date('2026-08-31T10:05:01.000Z'),
    publicationOccurrence: {
      id: 'occurrence-1',
      status: PublicationOccurrenceStatus.FAILED,
      updatedAt: new Date('2026-08-31T10:05:02.000Z'),
    },
    ...overrides,
  };
}

function membership(overrides: Record<string, unknown> = {}) {
  return {
    id: 'membership-1',
    chatId: 'chat-1',
    botId: 'bot-1',
    status: ChatBotMembershipStatus.ACTIVE,
    sendRouteFailureCount: 2,
    sendRouteQuarantinedUntil: new Date('2026-09-01T16:00:00.000Z'),
    sendRouteLastFailureAt: SENT_AT,
    sendRouteLastFailureCode: MAX_SEND_ROUTE_DISAPPEARANCE_FAILURE_CODE,
    sendRouteLastSuccessAt: new Date('2026-08-30T10:00:00.000Z'),
    updatedAt: new Date('2026-08-31T10:05:03.000Z'),
    ...overrides,
  };
}

function options(
  overrides: Partial<LegacyPublicationAbsenceNormalizationOptions> = {},
): LegacyPublicationAbsenceNormalizationOptions {
  return {
    apply: false,
    json: false,
    actorUserId: null,
    deliveryIds: ['delivery-1'],
    ...overrides,
  };
}

describe('legacy publication absence normalization CLI', () => {
  it('defaults to a bounded explicit-ID dry-run and requires an actor for apply', () => {
    expect(
      readLegacyPublicationAbsenceNormalizationOptions(['--delivery-id', 'delivery-1', '--json']),
    ).toEqual({
      apply: false,
      json: true,
      actorUserId: null,
      deliveryIds: ['delivery-1'],
    });
    expect(() => readLegacyPublicationAbsenceNormalizationOptions([])).toThrow(
      'explicit --delivery-id',
    );
    expect(() =>
      readLegacyPublicationAbsenceNormalizationOptions(['--apply', '--delivery-id', 'delivery-1']),
    ).toThrow('--apply requires --actor-user-id');
    expect(() =>
      readLegacyPublicationAbsenceNormalizationOptions([
        '--delivery-id',
        'delivery-1',
        '--delivery-id',
        'delivery-1',
      ]),
    ).toThrow('must be unique');
  });

  it('previews the strict legacy candidate and exact sticky route without mutating', async () => {
    const transaction = jest.fn();
    const prisma = {
      managedBroadcastDelivery: { findUnique: jest.fn().mockResolvedValue(candidate()) },
      chatBotMembership: { findFirst: jest.fn().mockResolvedValue(membership()) },
      $transaction: transaction,
    };

    await expect(
      runLegacyPublicationAbsenceNormalization(prisma as never, options(), () => NOW),
    ).resolves.toEqual(
      expect.objectContaining({
        apply: false,
        requested: 1,
        wouldApply: 1,
        applied: 0,
        outcomes: [expect.objectContaining({ result: 'would_apply', routeResult: 'would_clear' })],
      }),
    );
    expect(transaction).not.toHaveBeenCalled();
  });

  it('rejects an explicit manual mark_failed row from normalization', async () => {
    const transaction = jest.fn();
    const prisma = {
      managedBroadcastDelivery: {
        findUnique: jest.fn().mockResolvedValue(
          candidate({
            lastError: 'Администратор подтвердил, что сообщение не было опубликовано.',
          }),
        ),
      },
      chatBotMembership: { findFirst: jest.fn() },
      $transaction: transaction,
    };

    const summary = await runLegacyPublicationAbsenceNormalization(
      prisma as never,
      options(),
      () => NOW,
    );

    expect(summary).toEqual(
      expect.objectContaining({
        ineligible: 1,
        outcomes: [
          expect.objectContaining({ result: 'ineligible', reason: 'legacy_signature_mismatch' }),
        ],
      }),
    );
    expect(prisma.chatBotMembership.findFirst).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it('normalizes delivery and occurrence, clears only its exact sticky route, and audits safely', async () => {
    const deliveryUpdateMany = jest
      .fn()
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 3 });
    const occurrenceUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
    const membershipUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
    const broadcastUpdateMany = jest.fn().mockResolvedValue({ count: 2 });
    const auditCreate = jest.fn().mockResolvedValue({ id: 'audit-1' });
    const tx = {
      managedBroadcastDelivery: {
        findUnique: jest.fn().mockResolvedValue(candidate()),
        updateMany: deliveryUpdateMany,
      },
      publicationOccurrence: { updateMany: occurrenceUpdateMany },
      chatBotMembership: {
        findFirst: jest.fn().mockResolvedValue(membership()),
        updateMany: membershipUpdateMany,
      },
      managedBroadcast: { updateMany: broadcastUpdateMany },
      auditLog: { create: auditCreate },
    };
    const transaction = jest.fn(async (callback) => callback(tx));
    const prisma = { $transaction: transaction };

    const summary = await runLegacyPublicationAbsenceNormalization(
      prisma as never,
      options({ apply: true, actorUserId: 'admin-1' }),
      () => NOW,
    );

    expect(summary).toEqual(
      expect.objectContaining({
        applied: 1,
        routesCleared: 1,
        routeCasConflicts: 0,
        wokenBroadcastCount: 2,
        releasedDeliveryCount: 3,
      }),
    );
    expect(transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    });
    expect(deliveryUpdateMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'delivery-1',
          status: ManagedBroadcastDeliveryStatus.FAILED,
          remoteMessageId: 'remote-message',
          remoteMessageVerificationAbsentCount: 3,
          updatedAt: expect.any(Date),
        }),
        data: { status: ManagedBroadcastDeliveryStatus.AMBIGUOUS },
      }),
    );
    expect(deliveryUpdateMany.mock.calls[0]?.[0]?.data).not.toHaveProperty('remoteMessageId');
    expect(deliveryUpdateMany.mock.calls[0]?.[0]?.data).not.toHaveProperty('sentAt');
    expect(occurrenceUpdateMany).toHaveBeenCalledWith({
      where: {
        id: 'occurrence-1',
        status: PublicationOccurrenceStatus.FAILED,
        updatedAt: expect.any(Date),
      },
      data: { status: PublicationOccurrenceStatus.AMBIGUOUS },
    });
    expect(membershipUpdateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: 'membership-1',
        sendRouteFailureCount: 2,
        sendRouteLastFailureAt: SENT_AT,
        sendRouteLastFailureCode: MAX_SEND_ROUTE_DISAPPEARANCE_FAILURE_CODE,
        updatedAt: expect.any(Date),
      }),
      data: {
        sendRouteFailureCount: 0,
        sendRouteQuarantinedUntil: null,
        sendRouteLastFailureAt: null,
        sendRouteLastFailureCode: null,
      },
    });
    expect(broadcastUpdateMany).toHaveBeenCalledTimes(1);
    expect(auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        chatId: 'chat-1',
        actorUserId: 'admin-1',
        action: 'PUBLICATION_LEGACY_ABSENCE_NORMALIZED',
        payload: expect.objectContaining({
          reason: 'legacy_post_send_exact_absence_fail_closed',
          routeResult: 'cleared',
          wokenBroadcastCount: 2,
          releasedDeliveryCount: 3,
        }),
      }),
    });
    expect(JSON.stringify(auditCreate.mock.calls[0]?.[0]?.data?.payload)).not.toContain(
      'remote-message',
    );
  });

  it('preserves a newer route failure while still normalizing the legacy delivery', async () => {
    const deliveryUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
    const membershipUpdateMany = jest.fn();
    const broadcastUpdateMany = jest.fn();
    const auditCreate = jest.fn().mockResolvedValue({ id: 'audit-1' });
    const tx = {
      managedBroadcastDelivery: {
        findUnique: jest.fn().mockResolvedValue(candidate()),
        updateMany: deliveryUpdateMany,
      },
      publicationOccurrence: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      chatBotMembership: {
        findFirst: jest
          .fn()
          .mockResolvedValue(
            membership({ sendRouteLastFailureAt: new Date('2026-09-01T09:00:00.000Z') }),
          ),
        updateMany: membershipUpdateMany,
      },
      managedBroadcast: { updateMany: broadcastUpdateMany },
      auditLog: { create: auditCreate },
    };

    const summary = await runLegacyPublicationAbsenceNormalization(
      { $transaction: jest.fn(async (callback) => callback(tx)) } as never,
      options({ apply: true, actorUserId: 'admin-1' }),
      () => NOW,
    );

    expect(summary).toEqual(
      expect.objectContaining({
        applied: 1,
        routesCleared: 0,
        outcomes: [expect.objectContaining({ routeResult: 'not_matching' })],
      }),
    );
    expect(membershipUpdateMany).not.toHaveBeenCalled();
    expect(broadcastUpdateMany).not.toHaveBeenCalled();
    expect(auditCreate).toHaveBeenCalledTimes(1);
  });

  it('stops before occurrence, route, and audit writes when the delivery CAS loses', async () => {
    const occurrenceUpdateMany = jest.fn();
    const membershipFindFirst = jest.fn();
    const auditCreate = jest.fn();
    const tx = {
      managedBroadcastDelivery: {
        findUnique: jest.fn().mockResolvedValue(candidate()),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      publicationOccurrence: { updateMany: occurrenceUpdateMany },
      chatBotMembership: { findFirst: membershipFindFirst, updateMany: jest.fn() },
      managedBroadcast: { updateMany: jest.fn() },
      auditLog: { create: auditCreate },
    };

    const summary = await runLegacyPublicationAbsenceNormalization(
      { $transaction: jest.fn(async (callback) => callback(tx)) } as never,
      options({ apply: true, actorUserId: 'admin-1' }),
      () => NOW,
    );

    expect(summary).toEqual(expect.objectContaining({ applied: 0, casConflicts: 1 }));
    expect(occurrenceUpdateMany).not.toHaveBeenCalled();
    expect(membershipFindFirst).not.toHaveBeenCalled();
    expect(auditCreate).not.toHaveBeenCalled();
  });
});
