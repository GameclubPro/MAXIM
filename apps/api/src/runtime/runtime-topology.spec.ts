import {
  DEFAULT_WEBHOOK_WORKER_GROUP_QUEUES,
  RUNTIME_SERVICE_PROFILES,
  resolveRuntimeServiceProfile,
} from './runtime-topology';

describe('runtime-topology', () => {
  it('keeps default webhook shard groups in one typed topology map', () => {
    expect(RUNTIME_SERVICE_PROFILES['api-moderation'].moderationQueues).toEqual([
      'moderation-default-0',
      'moderation-default-4',
      'moderation-default-8',
      'moderation-default-12',
    ]);
    expect(RUNTIME_SERVICE_PROFILES['api-moderation-realtime-c'].moderationQueues).toEqual([
      'moderation-default-2',
      'moderation-default-6',
      'moderation-default-10',
      'moderation-default-14',
    ]);
    expect(DEFAULT_WEBHOOK_WORKER_GROUP_QUEUES['api-moderation-realtime-d']).toEqual([
      'moderation-default-3',
      'moderation-default-7',
      'moderation-default-11',
      'moderation-default-15',
    ]);
  });

  it('uses explicit APP_SERVICE_NAME as the runtime source of truth', () => {
    expect(
      resolveRuntimeServiceProfile({
        APP_ROLE: 'moderation',
        APP_SERVICE_NAME: 'api-moderation-background',
        MODERATION_ENABLED_QUEUES: 'critical',
      }),
    ).toMatchObject({
      source: 'declared-service',
      service: {
        serviceName: 'api-moderation-background',
        queueProfile: 'webhook-background',
        queuePriority: 'background',
        backgroundTasksEnabled: true,
      },
    });
  });

  it('infers legacy production services from role/env when the service name is absent', () => {
    expect(resolveRuntimeServiceProfile({ APP_ROLE: 'ingress' })).toMatchObject({
      source: 'role-inference',
      service: { serviceName: 'api-ingress' },
    });
    expect(
      resolveRuntimeServiceProfile({
        APP_ROLE: 'moderation',
        WEBHOOK_DYNAMIC_LEASES_WORKER_GROUP: 'api-moderation-realtime-b',
      }),
    ).toMatchObject({
      source: 'role-inference',
      service: { serviceName: 'api-moderation-realtime-b' },
    });
    expect(
      resolveRuntimeServiceProfile({
        APP_ROLE: 'moderation',
        MODERATION_ENABLED_QUEUES: 'legacy,critical',
      }),
    ).toMatchObject({
      source: 'queue-inference',
      service: { serviceName: 'api-moderation-critical' },
    });
  });
});
