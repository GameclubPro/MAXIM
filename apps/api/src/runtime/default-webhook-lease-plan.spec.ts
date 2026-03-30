import { buildDefaultWebhookLeasePlan } from './default-webhook-lease-plan';
import { DEFAULT_WEBHOOK_QUEUE_NAMES } from '../webhook/webhook-queues';

function buildCounters() {
  return Object.fromEntries(
    DEFAULT_WEBHOOK_QUEUE_NAMES.map((queueName) => [
      queueName,
      { waiting: 0, active: 0, delayed: 0 },
    ]),
  ) as Record<(typeof DEFAULT_WEBHOOK_QUEUE_NAMES)[number], { waiting: number; active: number; delayed: number }>;
}

describe('buildDefaultWebhookLeasePlan', () => {
  it('keeps static home owners when dynamic mode is off', () => {
    const counters = buildCounters();
    counters['moderation-default-0'] = { waiting: 2, active: 0, delayed: 0 };

    const plan = buildDefaultWebhookLeasePlan({
      mode: 'off',
      queueCounters: counters,
      rebalanceCooldownMs: 30_000,
    });

    expect(plan.queues['moderation-default-0']).toMatchObject({
      currentOwner: 'api-moderation',
      desiredOwner: 'api-moderation',
      eligibleForDynamicLeases: false,
      reason: 'static-home',
    });
  });

  it('recommends rebalancing a canary queue toward a colder worker group', () => {
    const counters = buildCounters();
    counters['moderation-default-0'] = { waiting: 10, active: 0, delayed: 0 };
    counters['moderation-default-4'] = { waiting: 6, active: 1, delayed: 0 };
    counters['moderation-default-8'] = { waiting: 4, active: 0, delayed: 0 };
    counters['moderation-default-12'] = { waiting: 3, active: 0, delayed: 0 };
    counters['moderation-default-2'] = { waiting: 1, active: 0, delayed: 0 };

    const plan = buildDefaultWebhookLeasePlan({
      mode: 'canary',
      canaryQueues: new Set(['moderation-default-0']),
      queueCounters: counters,
      rebalanceCooldownMs: 30_000,
    });

    expect(plan.queues['moderation-default-0']).toMatchObject({
      eligibleForDynamicLeases: true,
      currentOwner: 'api-moderation',
      desiredOwner: 'api-moderation-realtime-b',
      handoffPending: true,
      reason: 'rebalance-least-loaded',
    });
  });

  it('keeps the current owner while a queue is still active', () => {
    const counters = buildCounters();
    counters['moderation-default-0'] = { waiting: 0, active: 1, delayed: 0 };

    const plan = buildDefaultWebhookLeasePlan({
      mode: 'on',
      queueCounters: counters,
      rebalanceCooldownMs: 30_000,
    });

    expect(plan.queues['moderation-default-0']).toMatchObject({
      currentOwner: 'api-moderation',
      desiredOwner: 'api-moderation',
      handoffPending: false,
      reason: 'keep-active-owner',
    });
  });

  it('redistributes a queue when the current owner heartbeat disappears', () => {
    const counters = buildCounters();
    counters['moderation-default-0'] = { waiting: 4, active: 0, delayed: 0 };

    const plan = buildDefaultWebhookLeasePlan({
      mode: 'on',
      aliveWorkerGroups: new Set([
        'api-moderation-realtime-b',
        'api-moderation-realtime-c',
        'api-moderation-realtime-d',
      ]),
      claimedOwners: {
        'moderation-default-0': 'api-moderation',
      },
      queueCounters: counters,
      rebalanceCooldownMs: 30_000,
    });

    expect(plan.queues['moderation-default-0']).toMatchObject({
      currentOwner: 'api-moderation',
      desiredOwner: 'api-moderation-realtime-b',
      handoffPending: true,
      reason: 'owner-unavailable',
    });
  });
});
