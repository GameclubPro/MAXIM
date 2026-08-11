export type DuplicateStateEventType = 'message_created' | 'message_edited';

export function resolveTrustedDuplicateStateRevision(
  updateType: string | null,
  createdAt: string,
  eventTimestampSource: unknown,
): {
  duplicateStateEventType?: DuplicateStateEventType;
  duplicateStateEventTimestampMs?: number;
} {
  const duplicateStateEventType =
    updateType === 'message_created' || updateType === 'message_edited' ? updateType : undefined;
  if (!duplicateStateEventType) {
    return {};
  }

  const timestampMs = eventTimestampSource === 'ingress' ? Number.NaN : Date.parse(createdAt);
  return {
    duplicateStateEventType,
    ...(Number.isSafeInteger(timestampMs) && timestampMs > 0
      ? { duplicateStateEventTimestampMs: timestampMs }
      : {}),
  };
}
