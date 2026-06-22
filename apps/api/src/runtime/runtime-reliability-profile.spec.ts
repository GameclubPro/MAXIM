import { buildSystemQueueGroupHealth } from './runtime-reliability-profile';
import type { QueueCounters, QueueMetricsSnapshot } from '../system/queue-metrics.service';

function counters(overrides: Partial<QueueCounters> = {}): QueueCounters {
  return {
    waiting: 0,
    prioritized: 0,
    active: 0,
    delayed: 0,
    failed: 0,
    completed: 0,
    ...overrides,
  };
}

function queueSnapshot(overrides: Partial<QueueMetricsSnapshot> = {}): QueueMetricsSnapshot {
  return {
    webhookCritical: counters(),
    webhookJoin: counters(),
    webhookJoinShards: {},
    webhookDefaultWorkerGroups: {},
    webhookBackground: counters(),
    webhookLegacy: counters(),
    actions: counters(),
    globalSpammerDenorm: counters(),
    ...overrides,
  } as QueueMetricsSnapshot;
}

describe('runtime reliability queue group health', () => {
  it('keeps failed-only BullMQ history visible without marking the group critical', () => {
    const health = buildSystemQueueGroupHealth(
      queueSnapshot({
        actions: counters({ failed: 8093 }),
      }),
    );

    expect(health.status).toBe('warning');
    expect(health.groups).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'actions',
          failed: 8093,
          pressure: 0,
          status: 'warning',
        }),
      ]),
    );
  });

  it('still marks a queue group critical when waiting backlog reaches the threshold', () => {
    const health = buildSystemQueueGroupHealth(
      queueSnapshot({
        actions: counters({ waiting: 50, failed: 1 }),
      }),
    );

    expect(health.status).toBe('critical');
    expect(health.groups).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'actions',
          waiting: 50,
          pressure: 50,
          status: 'critical',
        }),
      ]),
    );
  });
});
