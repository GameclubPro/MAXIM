import { createHash } from 'node:crypto';
import type { QueueJobEnvelope, QueueRetryPolicyName } from '../common/queue-job-envelope';
import {
  buildNightModeTransitionSessionKey,
  type NightModeTransitionKind,
} from './night-mode-transition-time.util';

export const NIGHT_MODE_TRANSITION_QUEUE = 'night-mode-transitions';
export const NIGHT_MODE_TRANSITION_JOB_NAME = 'night-mode-transition';
export const NIGHT_MODE_TRANSITION_CLOSE_EVENT_RECOVERY = 'close_notice_event' as const;
export const NIGHT_MODE_TRANSITION_POST_EXECUTION_CLEANUP_FAILURE_PREFIX =
  'Night mode transition post-execution scheduling failed';
export const NIGHT_MODE_TRANSITION_LOCK_BUSY_FAILURE_PREFIX = 'Night mode transition lock is busy';

export type NightModeTransitionRecoveryOnly = {
  kind: typeof NIGHT_MODE_TRANSITION_CLOSE_EVENT_RECOVERY;
  version: 1;
  sessionKey: string;
  messageId: string;
  botId: string;
  timezone: string;
  startMinutes: number;
  endMinutes: number;
};

export type NightModeTransitionJob = QueueJobEnvelope<
  {
    chatId: string;
    transition: NightModeTransitionKind;
    scheduledFor: string;
    sessionKey: string;
  },
  {
    retryPolicyName?: Extract<QueueRetryPolicyName, 'night-mode-transition'>;
    createdAt?: string;
    transitionRuntimeVersion?: 2 | 3 | 4;
    scheduleFingerprint?: string;
    recoveryOnly?: NightModeTransitionRecoveryOnly;
  }
>;

export type NightModeTransitionProcessResult = {
  shouldEnqueueNext: boolean;
};

export const NIGHT_MODE_TRANSITION_PROCESS_CONTINUE: NightModeTransitionProcessResult = {
  shouldEnqueueNext: true,
};

export const NIGHT_MODE_TRANSITION_PROCESS_STOP: NightModeTransitionProcessResult = {
  shouldEnqueueNext: false,
};

export function buildNightModeTransitionJobId(
  chatId: string,
  transition: NightModeTransitionKind,
  scheduledFor: string,
  sessionKey: string,
): string {
  // FLAG: SHA-1 preserves IDs for persisted BullMQ jobs; it is not a security boundary.
  const occurrenceDigest = createHash('sha1')
    .update(`${chatId}:${transition}:${scheduledFor}:${sessionKey}`)
    .digest('hex');
  return `${buildNightModeTransitionJobIdPrefix(chatId)}${transition}__${occurrenceDigest}`;
}

export function buildNightModeTransitionJobIdPrefix(chatId: string): string {
  // FLAG: Keep this aligned with the legacy occurrence digest until queued jobs are migrated.
  const chatDigest = createHash('sha1').update(chatId).digest('hex');
  return `night-mode-transition__${chatDigest}__`;
}

export function buildNightModeTransitionRecoveryJobId(
  chatId: string,
  recovery: NightModeTransitionRecoveryOnly,
): string {
  const digest = createHash('sha256')
    .update(
      [
        chatId.trim(),
        recovery.kind,
        recovery.version,
        recovery.sessionKey,
        recovery.messageId,
        recovery.botId,
      ].join('\u001f'),
    )
    .digest('hex');
  return `${buildNightModeTransitionJobIdPrefix(chatId)}recovery__${digest}`;
}

export function parseNightModeTransitionRecoveryOnly(
  value: unknown,
): NightModeTransitionRecoveryOnly | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const sessionKey = boundedString(record.sessionKey, 512);
  const messageId = boundedString(record.messageId, 256);
  const botId = boundedString(record.botId, 256);
  const timezone = boundedString(record.timezone, 128);
  const startMinutes = record.startMinutes;
  const endMinutes = record.endMinutes;
  if (
    record.kind !== NIGHT_MODE_TRANSITION_CLOSE_EVENT_RECOVERY ||
    record.version !== 1 ||
    !sessionKey ||
    !messageId ||
    !botId ||
    !timezone ||
    !Number.isInteger(startMinutes) ||
    typeof startMinutes !== 'number' ||
    startMinutes < 0 ||
    startMinutes > 1_439 ||
    !Number.isInteger(endMinutes) ||
    typeof endMinutes !== 'number' ||
    endMinutes < 0 ||
    endMinutes > 1_439
  ) {
    return null;
  }
  const sessionDateKey = sessionKey.slice(-10);
  if (
    !/^\d{4}-\d{2}-\d{2}$/u.test(sessionDateKey) ||
    buildNightModeTransitionSessionKey({
      timezone,
      startMinutes,
      endMinutes,
      sessionDateKey,
    }) !== sessionKey
  ) {
    return null;
  }
  return {
    kind: NIGHT_MODE_TRANSITION_CLOSE_EVENT_RECOVERY,
    version: 1,
    sessionKey,
    messageId,
    botId,
    timezone,
    startMinutes,
    endMinutes,
  };
}

function boundedString(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value.trim();
  return normalized && normalized.length <= maxLength ? normalized : null;
}
