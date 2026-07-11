import {
  buildSystemQueueGroupHealth,
  buildSystemRuntimeProfile,
} from './runtime-reliability-profile';
import {
  AUXILIARY_QUEUE_NAMES,
  type QueueCounters,
  type QueueMetricsSnapshot,
} from '../system/queue-metrics.service';

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
    auxiliaryQueues: Object.fromEntries(
      AUXILIARY_QUEUE_NAMES.map((queueName) => [queueName, counters()]),
    ) as QueueMetricsSnapshot['auxiliaryQueues'],
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
          queues: [
            'moderation-actions',
            'max-actions-critical',
            'max-actions-interactive',
            'max-actions-background',
          ],
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

  it('tracks auxiliary queues without treating scheduled delayed jobs as pressure', () => {
    const health = buildSystemQueueGroupHealth(
      queueSnapshot({
        auxiliaryQueues: {
          ...Object.fromEntries(AUXILIARY_QUEUE_NAMES.map((queueName) => [queueName, counters()])),
          'night-mode-transitions': counters({ delayed: 3073 }),
          'max-chat-admin-roster-sync': counters({ waiting: 2, failed: 7581 }),
        } as QueueMetricsSnapshot['auxiliaryQueues'],
      }),
    );

    expect(health.status).toBe('warning');
    expect(health.groups).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'aux:night-mode-transitions',
          delayed: 3073,
          pressure: 0,
          status: 'healthy',
        }),
        expect.objectContaining({
          name: 'aux:max-chat-admin-roster-sync',
          waiting: 2,
          failed: 7581,
          pressure: 2,
          status: 'warning',
        }),
      ]),
    );
  });

  it('labels the legacy webhook group with the actual BullMQ queue name', () => {
    const health = buildSystemQueueGroupHealth(queueSnapshot());

    expect(health.groups).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'webhook-legacy',
          queues: ['moderation'],
        }),
      ]),
    );
  });

  it('marks auxiliary queues critical when waiting backlog reaches the threshold', () => {
    const health = buildSystemQueueGroupHealth(
      queueSnapshot({
        auxiliaryQueues: {
          ...Object.fromEntries(AUXILIARY_QUEUE_NAMES.map((queueName) => [queueName, counters()])),
          'vk-parsing-publish': counters({ waiting: 50, delayed: 5000 }),
        } as QueueMetricsSnapshot['auxiliaryQueues'],
      }),
    );

    expect(health.status).toBe('critical');
    expect(health.groups).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'aux:vk-parsing-publish',
          waiting: 50,
          delayed: 5000,
          pressure: 50,
          status: 'critical',
        }),
      ]),
    );
  });
});

describe('runtime reliability action queue profile', () => {
  const previousAppRole = process.env.APP_ROLE;
  const previousServiceName = process.env.APP_SERVICE_NAME;

  afterEach(() => {
    if (previousAppRole === undefined) {
      delete process.env.APP_ROLE;
    } else {
      process.env.APP_ROLE = previousAppRole;
    }
    if (previousServiceName === undefined) {
      delete process.env.APP_SERVICE_NAME;
    } else {
      process.env.APP_SERVICE_NAME = previousServiceName;
    }
  });

  it('reports all split action queues for the action runtime', () => {
    process.env.APP_ROLE = 'action';
    process.env.APP_SERVICE_NAME = 'api-action';

    expect(buildSystemRuntimeProfile().enabledQueues).toEqual(
      expect.arrayContaining([
        'moderation-actions',
        'max-actions-critical',
        'max-actions-interactive',
        'max-actions-background',
      ]),
    );
  });
});
