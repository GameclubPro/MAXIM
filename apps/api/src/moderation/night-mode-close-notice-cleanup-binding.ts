export const NIGHT_MODE_CLOSE_NOTICE_CLEANUP_RULE_CODE = 'NIGHT_MODE_CLOSE_NOTICE_CLEANUP';

export type NightModeCloseNoticeCleanupBinding = {
  version: 1;
  sessionKey: string;
  scheduleFingerprint: string;
  sideEffectFingerprint: string;
  event: {
    id: string;
    ruleCode: 'NIGHT_MODE_CLOSE_NOTICE';
    messageId: string;
  };
};

export function parseNightModeCloseNoticeCleanupBinding(
  value: unknown,
): NightModeCloseNoticeCleanupBinding | null {
  const record = asRecord(value);
  const event = asRecord(record?.event);
  const sessionKey = boundedString(record?.sessionKey, 512);
  const scheduleFingerprint = fingerprint(record?.scheduleFingerprint);
  const sideEffectFingerprint = fingerprint(record?.sideEffectFingerprint);
  const eventId = boundedString(event?.id, 256);
  const messageId = boundedString(event?.messageId, 256);
  if (
    record?.version !== 1 ||
    !sessionKey ||
    !scheduleFingerprint ||
    !sideEffectFingerprint ||
    !eventId ||
    event?.ruleCode !== 'NIGHT_MODE_CLOSE_NOTICE' ||
    !messageId
  ) {
    return null;
  }
  return {
    version: 1,
    sessionKey,
    scheduleFingerprint,
    sideEffectFingerprint,
    event: {
      id: eventId,
      ruleCode: 'NIGHT_MODE_CLOSE_NOTICE',
      messageId,
    },
  };
}

function fingerprint(value: unknown): string | null {
  const normalized = boundedString(value, 80);
  return normalized && /^sha256:[a-f0-9]{64}$/u.test(normalized) ? normalized : null;
}

function boundedString(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= maxLength ? normalized : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
