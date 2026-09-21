import type { MessageRetentionSummary } from '@maxim/contracts/settings';

export function retentionStatus(
  policy: {
    enabled: boolean;
    pausedAt: Date | null;
    pendingCount: number;
    lastStatus: string;
  } | null,
  mode: string,
  available: boolean,
  dueMs = Infinity,
): MessageRetentionSummary['status'] {
  if (!available) return 'unavailable';
  if (!policy?.enabled) return 'off';
  if (policy.pausedAt) return 'capacity_paused';
  if (mode === 'shadow') return 'shadow';
  if (policy.pendingCount > 0 && ['paused', 'no_access', 'error'].includes(policy.lastStatus))
    return policy.lastStatus as 'paused' | 'no_access' | 'error';
  return dueMs < Date.now() - 3_600_000 ||
    (policy.pendingCount > 0 && policy.lastStatus === 'delayed')
    ? 'delayed'
    : 'running';
}
