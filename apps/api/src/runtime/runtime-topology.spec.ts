import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  DEFAULT_WEBHOOK_WORKER_GROUP_QUEUES,
  RUNTIME_SERVICE_NAMES,
  RUNTIME_SERVICE_PROFILES,
  resolveRuntimeServiceProfile,
} from './runtime-topology';
import { getEnabledModerationProcessorQueues } from './moderation-runtime';
import { APP_ROLES, normalizeAppRole } from './app-role';

type ComposeService = {
  environment?: Record<string, unknown>;
};

type ComposeFile = {
  services?: Record<string, ComposeService>;
};

function readComposeApiServices(fileName: string): Record<string, ComposeService> {
  const composePath = resolve(__dirname, '../../../../infra', fileName);
  const compose = parseYaml(readFileSync(composePath, 'utf8'), {
    customTags: [{ tag: '!override', collection: 'seq', resolve: (value) => value }],
  }) as ComposeFile;

  return compose.services ?? {};
}

describe('runtime-topology', () => {
  it('normalizes app roles from the shared role registry', () => {
    expect(APP_ROLES).toEqual(['all', 'ingress', 'admin', 'enqueue', 'moderation', 'action']);
    expect(normalizeAppRole(' MODERATION ')).toBe('moderation');
    expect(normalizeAppRole('unknown', 'ingress')).toBe('ingress');
  });

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

  it('marks the action role as a background task runner for managed automation', () => {
    expect(RUNTIME_SERVICE_PROFILES['api-action']).toMatchObject({
      appRole: 'action',
      queueProfile: 'max-action-dispatch',
      backgroundTasksEnabled: true,
    });
  });

  it('isolates commercial OCR from webhook moderation queues', () => {
    expect(RUNTIME_SERVICE_PROFILES['api-media-analysis']).toMatchObject({
      appRole: 'moderation',
      queueProfile: 'commercial-image-ocr',
      queuePriority: 'background',
      moderationQueues: [],
      backgroundTasksEnabled: false,
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

  it.each(['docker-compose.yml', 'docker-compose.scale.yml'])(
    'keeps %s API service names and moderation queues aligned with typed topology',
    (fileName) => {
      const services = readComposeApiServices(fileName);

      for (const serviceName of RUNTIME_SERVICE_NAMES.filter((name) => name !== 'api-all')) {
        const service = services[serviceName];
        expect(service).toBeDefined();

        const environment = service?.environment ?? {};
        expect(environment.APP_SERVICE_NAME).toBe(serviceName);

        const profile = RUNTIME_SERVICE_PROFILES[serviceName];
        expect(resolveRuntimeServiceProfile(environment).service.serviceName).toBe(serviceName);

        if (profile.capabilities.moderationEnabled) {
          const rawEnabledQueues =
            typeof environment.MODERATION_ENABLED_QUEUES === 'string'
              ? environment.MODERATION_ENABLED_QUEUES
              : undefined;
          expect(getEnabledModerationProcessorQueues(rawEnabledQueues)).toEqual(
            new Set(profile.moderationQueues),
          );
        } else {
          expect(environment.MODERATION_ENABLED_QUEUES).toBeUndefined();
        }
      }
    },
  );
});
