export const MAX_SEND_AUTO_DELETE_LEGACY_MARKER_VERSION = 1 as const;
export const MAX_SEND_AUTO_DELETE_MARKER_VERSION = 2 as const;

export const MAX_SEND_AUTO_DELETE_CONFIRMATION_KINDS = {
  EXACT_ABSENCE_PREFLIGHT: 'exact_absence_preflight',
  DOCUMENTED_DELETE_SUCCESS: 'documented_delete_success',
} as const;

export type MaxSendAutoDeleteConfirmationKind =
  (typeof MAX_SEND_AUTO_DELETE_CONFIRMATION_KINDS)[keyof typeof MAX_SEND_AUTO_DELETE_CONFIRMATION_KINDS];

type MaxSendAutoDeleteMarkerBase = {
  sourceSendJobId: string;
  sourceSendCompletedAt: string | null;
  requestedDelayMs: number;
  originBotId: string;
};

export type MaxSendAutoDeleteLegacyMarker = MaxSendAutoDeleteMarkerBase & {
  version: typeof MAX_SEND_AUTO_DELETE_LEGACY_MARKER_VERSION;
  exactAbsenceVerifiedAt?: string;
  exactAbsenceVerificationPhase?: 'preflight' | 'post_delete';
};

export type MaxSendAutoDeleteCurrentMarker = MaxSendAutoDeleteMarkerBase & {
  version: typeof MAX_SEND_AUTO_DELETE_MARKER_VERSION;
  confirmedAt?: string;
  confirmationKind?: MaxSendAutoDeleteConfirmationKind;
};

export type MaxSendAutoDeleteMarker =
  | MaxSendAutoDeleteLegacyMarker
  | MaxSendAutoDeleteCurrentMarker;

export type MaxSendAutoDeleteConfirmation = {
  confirmedAt: string;
  kind: MaxSendAutoDeleteConfirmationKind;
};

export function isMaxSendAutoDeleteMarker(value: unknown): value is MaxSendAutoDeleteMarker {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const marker = value as Record<string, unknown>;
  const sourceSendCompletedAt = marker.sourceSendCompletedAt;
  return (
    (marker.version === MAX_SEND_AUTO_DELETE_LEGACY_MARKER_VERSION ||
      marker.version === MAX_SEND_AUTO_DELETE_MARKER_VERSION) &&
    typeof marker.sourceSendJobId === 'string' &&
    marker.sourceSendJobId.trim().length > 0 &&
    (sourceSendCompletedAt === null ||
      (typeof sourceSendCompletedAt === 'string' &&
        Number.isFinite(Date.parse(sourceSendCompletedAt)))) &&
    typeof marker.requestedDelayMs === 'number' &&
    Number.isFinite(marker.requestedDelayMs) &&
    marker.requestedDelayMs > 0 &&
    typeof marker.originBotId === 'string' &&
    marker.originBotId.trim().length > 0
  );
}

export function readMaxSendAutoDeleteConfirmation(
  value: unknown,
): MaxSendAutoDeleteConfirmation | null {
  if (!isMaxSendAutoDeleteMarker(value)) {
    return null;
  }
  if (value.version === MAX_SEND_AUTO_DELETE_LEGACY_MARKER_VERSION) {
    // FLAG: v1 post_delete was written only after DELETE returned documented success=true.
    // v1 preflight may have trusted an access-masked 404 and is deliberately not accepted.
    return value.exactAbsenceVerificationPhase === 'post_delete' &&
      typeof value.exactAbsenceVerifiedAt === 'string' &&
      Number.isFinite(Date.parse(value.exactAbsenceVerifiedAt))
      ? {
          confirmedAt: value.exactAbsenceVerifiedAt,
          kind: MAX_SEND_AUTO_DELETE_CONFIRMATION_KINDS.DOCUMENTED_DELETE_SUCCESS,
        }
      : null;
  }

  return (value.confirmationKind ===
    MAX_SEND_AUTO_DELETE_CONFIRMATION_KINDS.EXACT_ABSENCE_PREFLIGHT ||
    value.confirmationKind === MAX_SEND_AUTO_DELETE_CONFIRMATION_KINDS.DOCUMENTED_DELETE_SUCCESS) &&
    typeof value.confirmedAt === 'string' &&
    Number.isFinite(Date.parse(value.confirmedAt))
    ? { confirmedAt: value.confirmedAt, kind: value.confirmationKind }
    : null;
}
