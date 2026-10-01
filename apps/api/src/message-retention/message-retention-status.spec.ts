import { retentionStatus } from './message-retention-status';
import { retentionBlockerStatus, retentionGuardOutcome } from './message-retention.policy';

describe('retention persisted blockers', () => {
  const policy = { enabled: true, pausedAt: null, pendingCount: 0, lastStatus: 'running' };
  it('keeps review visible after active credit has been released', () => {
    expect(retentionStatus(policy, 'on', true, Infinity, 'error')).toBe('error');
  });
  it('clears a resolved error only with an explicit blocker-free snapshot', () => {
    expect(retentionStatus({ ...policy, lastStatus: 'error' }, 'on', true, Infinity, null)).toBe(
      'running',
    );
  });
  it('preserves a governor pause when a blocker-free snapshot still has pending work', () => {
    expect(
      retentionStatus(
        { ...policy, lastStatus: 'paused', pendingCount: 1 },
        'on',
        true,
        Infinity,
        null,
      ),
    ).toBe('paused');
  });
  it('orders independent blockers by severity', () => {
    expect(retentionBlockerStatus(['deferred', 'waiting_access', 'terminal_review'])).toBe('error');
    expect(retentionBlockerStatus(['deferred', 'waiting_access'])).toBe('no_access');
    expect(retentionBlockerStatus(['reconciliation'])).toBe('delayed');
  });
  it('distinguishes ended authority from protection', () => {
    expect(retentionGuardOutcome('activation_ended')).toBe('cancelled');
    expect(retentionGuardOutcome('pinned')).toBe('protected');
  });
});
