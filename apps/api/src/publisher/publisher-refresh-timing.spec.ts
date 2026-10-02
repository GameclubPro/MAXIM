import type { PublisherBindingRefreshJob } from './publisher-binding-refresh.queue';
import { publisherRefreshTiming } from './publisher-refresh-timing';

const now = Date.parse('2026-10-03T00:00:00Z');
const at = (offset: number) => new Date(now + offset).toISOString();
const job: PublisherBindingRefreshJob = {
  version: 1,
  publisherBotId: 'publisher',
  chatId: 'chat',
  reason: 'bootstrap',
  requestedAt: at(-4_000),
};

describe('Publisher refresh latency coverage', () => {
  it.each([
    'bot_added',
    'webhook_observed',
    'forwarded_private',
    'historical_actor_recovery',
    'send_access_lost',
    'manual_recheck',
    'policy_enablement_recheck',
    'publication_due',
    'publication_actor_due',
  ] as const)('includes initial %s work in urgent observations', (reason) => {
    expect(publisherRefreshTiming({ ...job, reason }, now)).toEqual({
      workClass: 'urgent',
      queueAgeMs: 4_000,
    });
  });

  it.each(['scheduled_bot_access', 'stale_access'] as const)(
    'starts the urgent clock for %s at the expiry horizon, including late discovery',
    (reason) => {
      expect(publisherRefreshTiming({ ...job, reason, requiredBefore: at(40_000) }, now)).toEqual({
        workClass: 'urgent',
        queueAgeMs: 20_000,
      });
      expect(publisherRefreshTiming({ ...job, reason, requiredBefore: at(60_000) }, now)).toEqual({
        workClass: 'urgent',
        queueAgeMs: 0,
      });
      expect(publisherRefreshTiming({ ...job, reason, requiredBefore: at(60_001) }, now)).toEqual({
        workClass: 'background',
        queueAgeMs: 4_000,
      });
    },
  );

  it('keeps the earlier bot expiry urgent even before a future publication boundary', () => {
    expect(
      publisherRefreshTiming(
        {
          ...job,
          reason: 'scheduled_bot_access',
          publicationRequested: true,
          publicationUrgentAt: at(120_000),
          requiredBefore: at(30_000),
        },
        now,
      ),
    ).toEqual({ workClass: 'urgent', queueAgeMs: 30_000 });
  });

  it('does not apply a bot deadline to future actor preparation', () => {
    expect(
      publisherRefreshTiming(
        {
          ...job,
          reason: 'stale_user_access',
          candidateUserId: 'actor',
          publicationRequested: true,
          publicationUrgentAt: at(60_000),
          requiredBefore: at(-30_000),
        },
        now,
      ),
    ).toEqual({ workClass: 'preparation', queueAgeMs: 4_000 });
  });

  it('retains pre-enqueue publication delay without mutating the execution identity', () => {
    const envelope = Object.freeze({
      ...job,
      publicationRequested: true,
      publicationUrgentAt: at(-94_000),
      publicationRequestedAt: at(-200),
      requestedAt: at(-200),
    });
    expect(publisherRefreshTiming(envelope, now)).toEqual({
      workClass: 'urgent',
      queueAgeMs: 94_000,
    });
    expect(envelope.requestedAt).toBe(at(-200));
  });

  it.each(['bootstrap', 'binding_maintenance', 'stale_user_access'] as const)(
    'does not inflate urgent samples with aged %s work',
    (reason) => {
      expect(publisherRefreshTiming({ ...job, reason, requestedAt: at(-3_600_000) }, now)).toEqual({
        workClass: 'background',
        queueAgeMs: 3_600_000,
      });
    },
  );

  it('keeps missing age unknown and bounds future clock skew at zero', () => {
    expect(
      publisherRefreshTiming({ ...job, reason: 'bot_added', requestedAt: 'invalid' }, now),
    ).toEqual({ workClass: 'urgent', queueAgeMs: null });
    expect(
      publisherRefreshTiming({ ...job, reason: 'bot_added', requestedAt: at(100) }, now),
    ).toEqual({ workClass: 'urgent', queueAgeMs: 0 });
  });
});
