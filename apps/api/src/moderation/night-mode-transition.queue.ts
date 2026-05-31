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
  }
>;

export function buildNightModeTransitionJobId(
  chatId: string,
  transition: NightModeTransitionKind,
  scheduledFor: string,
  sessionKey: string,
): string {
  const occurrenceDigest = createHash('sha1')
    .update(`${chatId}:${transition}:${scheduledFor}:${sessionKey}`)
    .digest('hex');
  return `${buildNightModeTransitionJobIdPrefix(chatId)}${transition}:${occurrenceDigest}`;
}

export function buildNightModeTransitionJobIdPrefix(chatId: string): string {
  const chatDigest = createHash('sha1').update(chatId).digest('hex');
  return `night-mode-transition:${chatDigest}:`;
}
