export const MESSAGE_RETENTION_RULE = 'MESSAGE_RETENTION_DELETE';
export const MESSAGE_RETENTION_QUEUE = 'message-retention';
export const MESSAGE_RETENTION_DAY_MS = 86_400_000;
export const MESSAGE_RETENTION_QUEUE_LIMIT = 100;
export const MESSAGE_RETENTION_TIMER_MS = 1_000;
export const MESSAGE_RETENTION_IDLE_MS = 30_000;
export const MESSAGE_RETENTION_VISIT_MS = 20_000;
export const MESSAGE_RETENTION_RECOVERY_RETRY_MS = 5 * 60_000;
export const MESSAGE_RETENTION_SHARD_LIMIT = 62_500;
export const MESSAGE_RETENTION_SLOT_IDS = Array.from(
  { length: MESSAGE_RETENTION_QUEUE_LIMIT },
  (_, slot) => `retention-slot-${slot}`,
);

export type RetentionOutcomeCode =
  | 'deleted'
  | 'shadow'
  | 'protected'
  | 'cancelled'
  | 'deferred'
  | 'waiting_access'
  | 'terminal_review'
  | 'worker_error'
  | 'reconciliation';

export type RetentionBlockerStatus = 'error' | 'no_access' | 'delayed' | null;

export function retentionBlockerStatus(outcomes: readonly string[]): RetentionBlockerStatus {
  if (outcomes.some((code) => code === 'terminal_review' || code === 'worker_error'))
    return 'error';
  if (outcomes.includes('waiting_access')) return 'no_access';
  return outcomes.some((code) => code === 'reconciliation' || code === 'deferred')
    ? 'delayed'
    : null;
}

export function retentionGuardOutcome(reason?: string): 'protected' | 'cancelled' {
  return ['activation_ended', 'candidate_inactive', 'entity_ineligible'].includes(reason ?? '')
    ? 'cancelled'
    : 'protected';
}
