import { createHash } from 'node:crypto';
import type { QueueJobEnvelope, QueueRetryPolicyName } from '../common/queue-job-envelope';
import type { NightModeTransitionKind } from './night-mode-transition-time.util';

export const NIGHT_MODE_TRANSITION_QUEUE = 'night-mode-transitions';
export const NIGHT_MODE_TRANSITION_JOB_NAME = 'night-mode-transition';

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
    transitionRuntimeVersion?: 2;
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
