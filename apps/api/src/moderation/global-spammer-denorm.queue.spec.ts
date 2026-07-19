import {
  buildGlobalSpammerDenormDeduplicationId,
  hashQueueToken,
} from './global-spammer-denorm.queue';

describe('global spammer denorm queue', () => {
  it('builds deterministic BullMQ-safe per-user deduplication ids', () => {
    const left = buildGlobalSpammerDenormDeduplicationId('User-1');
    const right = buildGlobalSpammerDenormDeduplicationId('User-1');
    const other = buildGlobalSpammerDenormDeduplicationId('user-2');

    expect(left).toBe(right);
    expect(left).not.toBe(other);
    expect(left).toBe(`global-spammer-denorm__${hashQueueToken('User-1')}`);
    expect(hashQueueToken('User-1')).toMatch(/^[a-f0-9]{64}$/u);
    expect(left).not.toContain(':');
  });
});
