import { ManagedBroadcastDeliveryStatus } from '../prisma/prisma-client';
import {
  LEGACY_PUBLICATION_DISAPPEARANCE_LAST_ERROR,
  LEGACY_PUBLICATION_EXACT_ABSENCE_ERROR,
  buildEffectivePublicationDeliveryStatusSql,
  buildEffectivePublicationDeliveryStatusWhere,
  buildRetryableFailedPublicationDeliveryWhere,
  isLegacyAutomatedAbsenceFailure,
  resolveEffectivePublicationDeliveryStatus,
} from './publication-legacy-automated-absence';

function legacyFailure(overrides: Record<string, unknown> = {}) {
  return {
    status: ManagedBroadcastDeliveryStatus.FAILED,
    remoteMessageId: 'remote-message',
    remoteMessageVerifiedAt: null,
    remoteMessageVerificationAttemptCount: 3,
    remoteMessageVerificationAbsentCount: 3,
    remoteMessageVerificationPresentCount: 0,
    remoteMessageVerificationAttemptedAt: new Date('2026-07-25T08:05:00.000Z'),
    remoteMessageVerificationNextAt: null,
    remoteMessageVerificationLastError: LEGACY_PUBLICATION_EXACT_ABSENCE_ERROR,
    remoteMessageVerificationSource: null,
    legacySentWithoutRemoteId: false,
    lastErrorCode: null,
    lastError: LEGACY_PUBLICATION_DISAPPEARANCE_LAST_ERROR,
    sentAt: new Date('2026-07-25T08:00:00.000Z'),
    lockedAt: null,
    lockToken: null,
    publicationOccurrenceId: 'occurrence-1',
    ...overrides,
  };
}

describe('legacy automated publication absence signature', () => {
  it('classifies only the old automated terminal state as effectively ambiguous', () => {
    const delivery = legacyFailure();

    expect(isLegacyAutomatedAbsenceFailure(delivery)).toBe(true);
    expect(resolveEffectivePublicationDeliveryStatus(delivery)).toBe(
      ManagedBroadcastDeliveryStatus.AMBIGUOUS,
    );
    expect(buildRetryableFailedPublicationDeliveryWhere()).toEqual(
      expect.objectContaining({
        status: ManagedBroadcastDeliveryStatus.FAILED,
        OR: expect.arrayContaining([
          { remoteMessageVerificationLastError: null },
          { lastError: null },
          { lastError: { not: LEGACY_PUBLICATION_DISAPPEARANCE_LAST_ERROR } },
        ]),
      }),
    );
  });

  it('keeps an explicit manual mark_failed retryable', () => {
    const delivery = legacyFailure({
      lastError: 'Администратор подтвердил, что сообщение не было опубликовано.',
    });

    expect(isLegacyAutomatedAbsenceFailure(delivery)).toBe(false);
    expect(resolveEffectivePublicationDeliveryStatus(delivery)).toBe(
      ManagedBroadcastDeliveryStatus.FAILED,
    );
  });

  it('uses the effective status for delivery-list filters', () => {
    expect(
      buildEffectivePublicationDeliveryStatusWhere(ManagedBroadcastDeliveryStatus.AMBIGUOUS),
    ).toEqual({
      OR: expect.arrayContaining([
        { status: ManagedBroadcastDeliveryStatus.AMBIGUOUS },
        expect.objectContaining({
          status: ManagedBroadcastDeliveryStatus.FAILED,
          remoteMessageVerificationAbsentCount: { gte: 3 },
          lastError: LEGACY_PUBLICATION_DISAPPEARANCE_LAST_ERROR,
        }),
      ]),
    });
    expect(
      buildEffectivePublicationDeliveryStatusWhere(ManagedBroadcastDeliveryStatus.FAILED),
    ).toEqual(
      expect.objectContaining({
        status: ManagedBroadcastDeliveryStatus.FAILED,
        OR: expect.arrayContaining([{ lastError: null }]),
      }),
    );
  });

  it('keeps the aggregate SQL classifier aligned with the strict signature', () => {
    const query = buildEffectivePublicationDeliveryStatusSql();
    const text = query.strings.join('?').replace(/\s+/gu, ' ');

    expect(text).toContain('delivery."remote_message_verification_absent_count" >= ?');
    expect(text).toContain('delivery."last_error" = ?');
    expect(text).toContain('CAST(\'AMBIGUOUS\' AS "ManagedBroadcastDeliveryStatus")');
    expect(query.values).toEqual(
      expect.arrayContaining([
        LEGACY_PUBLICATION_EXACT_ABSENCE_ERROR,
        LEGACY_PUBLICATION_DISAPPEARANCE_LAST_ERROR,
      ]),
    );
  });
});
