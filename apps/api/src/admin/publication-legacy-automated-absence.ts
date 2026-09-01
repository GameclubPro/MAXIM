import { ManagedBroadcastDeliveryStatus, Prisma } from '../prisma/prisma-client';

export const LEGACY_PUBLICATION_EXACT_ABSENCE_ERROR =
  'MAX exact message lookup confirmed that the message is absent';
export const LEGACY_PUBLICATION_DISAPPEARANCE_LAST_ERROR =
  'MAX несколько раз подтвердил, что сообщение исчезло после отправки. Проверьте публикацию вручную.';
export const LEGACY_PUBLICATION_EXACT_ABSENCE_MIN_COUNT = 3;

type LegacyAutomatedAbsenceDelivery = {
  status: ManagedBroadcastDeliveryStatus;
  remoteMessageId: string | null;
  remoteMessageVerifiedAt: Date | null;
  remoteMessageVerificationAttemptCount: number;
  remoteMessageVerificationAbsentCount: number;
  remoteMessageVerificationPresentCount: number;
  remoteMessageVerificationAttemptedAt: Date | null;
  remoteMessageVerificationNextAt: Date | null;
  remoteMessageVerificationLastError: string | null;
  remoteMessageVerificationSource: string | null;
  legacySentWithoutRemoteId: boolean;
  lastErrorCode: string | null;
  lastError: string | null;
  sentAt: Date | null;
  lockedAt: Date | null;
  lockToken: string | null;
  publicationOccurrenceId: string | null;
};

export function buildLegacyAutomatedAbsenceSignatureWhere(): Prisma.ManagedBroadcastDeliveryWhereInput {
  return {
    publicationOccurrenceId: { not: null },
    remoteMessageId: { not: null },
    remoteMessageVerifiedAt: null,
    remoteMessageVerificationAttemptCount: {
      gte: LEGACY_PUBLICATION_EXACT_ABSENCE_MIN_COUNT,
    },
    remoteMessageVerificationAbsentCount: {
      gte: LEGACY_PUBLICATION_EXACT_ABSENCE_MIN_COUNT,
    },
    remoteMessageVerificationPresentCount: 0,
    remoteMessageVerificationAttemptedAt: { not: null },
    remoteMessageVerificationNextAt: null,
    remoteMessageVerificationLastError: LEGACY_PUBLICATION_EXACT_ABSENCE_ERROR,
    remoteMessageVerificationSource: null,
    legacySentWithoutRemoteId: false,
    lastErrorCode: null,
    lastError: LEGACY_PUBLICATION_DISAPPEARANCE_LAST_ERROR,
    sentAt: { not: null },
    lockedAt: null,
    lockToken: null,
  };
}

export function buildLegacyAutomatedAbsenceFailedWhere(): Prisma.ManagedBroadcastDeliveryWhereInput {
  return {
    status: ManagedBroadcastDeliveryStatus.FAILED,
    ...buildLegacyAutomatedAbsenceSignatureWhere(),
  };
}

export function buildNonLegacyAutomatedAbsenceSignatureWhere(): Prisma.ManagedBroadcastDeliveryWhereInput {
  return {
    OR: [
      { publicationOccurrenceId: null },
      { remoteMessageId: null },
      { remoteMessageVerifiedAt: { not: null } },
      {
        remoteMessageVerificationAttemptCount: {
          lt: LEGACY_PUBLICATION_EXACT_ABSENCE_MIN_COUNT,
        },
      },
      {
        remoteMessageVerificationAbsentCount: {
          lt: LEGACY_PUBLICATION_EXACT_ABSENCE_MIN_COUNT,
        },
      },
      { remoteMessageVerificationPresentCount: { not: 0 } },
      { remoteMessageVerificationAttemptedAt: null },
      { remoteMessageVerificationNextAt: { not: null } },
      { remoteMessageVerificationLastError: null },
      {
        remoteMessageVerificationLastError: {
          not: LEGACY_PUBLICATION_EXACT_ABSENCE_ERROR,
        },
      },
      { remoteMessageVerificationSource: { not: null } },
      { legacySentWithoutRemoteId: true },
      { lastErrorCode: { not: null } },
      { lastError: null },
      { lastError: { not: LEGACY_PUBLICATION_DISAPPEARANCE_LAST_ERROR } },
      { sentAt: null },
      { lockedAt: { not: null } },
      { lockToken: { not: null } },
    ],
  };
}

export function buildRetryableFailedPublicationDeliveryWhere(): Prisma.ManagedBroadcastDeliveryWhereInput {
  return {
    status: ManagedBroadcastDeliveryStatus.FAILED,
    ...buildNonLegacyAutomatedAbsenceSignatureWhere(),
  };
}

export function buildEffectivePublicationDeliveryStatusWhere(
  status: ManagedBroadcastDeliveryStatus,
): Prisma.ManagedBroadcastDeliveryWhereInput {
  if (status === ManagedBroadcastDeliveryStatus.AMBIGUOUS) {
    return {
      OR: [
        { status: ManagedBroadcastDeliveryStatus.AMBIGUOUS },
        buildLegacyAutomatedAbsenceFailedWhere(),
      ],
    };
  }
  if (status === ManagedBroadcastDeliveryStatus.FAILED) {
    return buildRetryableFailedPublicationDeliveryWhere();
  }
  return { status };
}

export function buildEffectivePublicationDeliveryExcludeStatusWhere(
  excludedStatus: ManagedBroadcastDeliveryStatus,
): Prisma.ManagedBroadcastDeliveryWhereInput {
  const statuses = Object.values(ManagedBroadcastDeliveryStatus).filter(
    (status) => status !== excludedStatus,
  );
  return {
    OR: statuses.map(buildEffectivePublicationDeliveryStatusWhere),
  };
}

export function buildEffectiveDeliveryListWhere(query: {
  status?: ManagedBroadcastDeliveryStatus;
  excludeStatus?: ManagedBroadcastDeliveryStatus;
}): Prisma.ManagedBroadcastDeliveryWhereInput {
  return query.status
    ? buildEffectivePublicationDeliveryStatusWhere(query.status)
    : query.excludeStatus
      ? buildEffectivePublicationDeliveryExcludeStatusWhere(query.excludeStatus)
      : {};
}

export function isLegacyAutomatedAbsenceFailure(delivery: LegacyAutomatedAbsenceDelivery): boolean {
  return (
    delivery.status === ManagedBroadcastDeliveryStatus.FAILED &&
    delivery.publicationOccurrenceId !== null &&
    delivery.remoteMessageId !== null &&
    delivery.remoteMessageVerifiedAt === null &&
    delivery.remoteMessageVerificationAttemptCount >= LEGACY_PUBLICATION_EXACT_ABSENCE_MIN_COUNT &&
    delivery.remoteMessageVerificationAbsentCount >= LEGACY_PUBLICATION_EXACT_ABSENCE_MIN_COUNT &&
    delivery.remoteMessageVerificationPresentCount === 0 &&
    delivery.remoteMessageVerificationAttemptedAt !== null &&
    delivery.remoteMessageVerificationNextAt === null &&
    delivery.remoteMessageVerificationLastError === LEGACY_PUBLICATION_EXACT_ABSENCE_ERROR &&
    delivery.remoteMessageVerificationSource === null &&
    delivery.legacySentWithoutRemoteId === false &&
    delivery.lastErrorCode === null &&
    delivery.lastError === LEGACY_PUBLICATION_DISAPPEARANCE_LAST_ERROR &&
    delivery.sentAt !== null &&
    delivery.lockedAt === null &&
    delivery.lockToken === null
  );
}

export function resolveEffectivePublicationDeliveryStatus(
  delivery: LegacyAutomatedAbsenceDelivery,
): ManagedBroadcastDeliveryStatus {
  return isLegacyAutomatedAbsenceFailure(delivery)
    ? ManagedBroadcastDeliveryStatus.AMBIGUOUS
    : delivery.status;
}

export function buildManualReviewDeliveryWhere(
  delivery: LegacyAutomatedAbsenceDelivery & { id: string },
): Prisma.ManagedBroadcastDeliveryWhereInput | null {
  if (delivery.status === ManagedBroadcastDeliveryStatus.AMBIGUOUS) {
    return { id: delivery.id, status: ManagedBroadcastDeliveryStatus.AMBIGUOUS };
  }
  return isLegacyAutomatedAbsenceFailure(delivery)
    ? { id: delivery.id, ...buildLegacyAutomatedAbsenceFailedWhere() }
    : null;
}

export function buildEffectivePublicationDeliveryStatusSql(): Prisma.Sql {
  return Prisma.sql`
    CASE
      WHEN delivery."status" = CAST('FAILED' AS "ManagedBroadcastDeliveryStatus")
        AND delivery."publication_occurrence_id" IS NOT NULL
        AND delivery."remote_message_id" IS NOT NULL
        AND delivery."remote_message_verified_at" IS NULL
        AND delivery."remote_message_verification_attempt_count" >= ${LEGACY_PUBLICATION_EXACT_ABSENCE_MIN_COUNT}
        AND delivery."remote_message_verification_absent_count" >= ${LEGACY_PUBLICATION_EXACT_ABSENCE_MIN_COUNT}
        AND delivery."remote_message_verification_present_count" = 0
        AND delivery."remote_message_verification_attempted_at" IS NOT NULL
        AND delivery."remote_message_verification_next_at" IS NULL
        AND delivery."remote_message_verification_last_error" = ${LEGACY_PUBLICATION_EXACT_ABSENCE_ERROR}
        AND delivery."remote_message_verification_source" IS NULL
        AND delivery."legacy_sent_without_remote_id" = FALSE
        AND delivery."last_error_code" IS NULL
        AND delivery."last_error" = ${LEGACY_PUBLICATION_DISAPPEARANCE_LAST_ERROR}
        AND delivery."sent_at" IS NOT NULL
        AND delivery."locked_at" IS NULL
        AND delivery."lock_token" IS NULL
      THEN CAST('AMBIGUOUS' AS "ManagedBroadcastDeliveryStatus")
      ELSE delivery."status"
    END
  `;
}
