import { normalizeAppRole, type AppRole } from './app-role';
import {
  DEFAULT_WEBHOOK_QUEUE_NAMES,
  JOIN_WEBHOOK_QUEUE_NAMES,
  LEGACY_WEBHOOK_QUEUE,
  WEBHOOK_QUEUE_BACKGROUND,
  WEBHOOK_QUEUE_CRITICAL,
  type AnyWebhookQueueName,
  type DefaultWebhookQueueName,
} from '../webhook/webhook-queues';

export type RuntimeRoleCapabilities = {
  httpEnabled: boolean;
  ingressEnabled: boolean;
  adminEnabled: boolean;
  enqueueEnabled: boolean;
  moderationEnabled: boolean;
  actionEnabled: boolean;
};

export type DefaultWebhookWorkerGroupName =
  | 'api-moderation'
  | 'api-moderation-realtime-b'
  | 'api-moderation-realtime-c'
  | 'api-moderation-realtime-d';

export type WebhookDynamicLeasesMode = 'off' | 'shadow' | 'canary' | 'on';

export type RuntimeServiceName =
  | 'api-all'
  | 'api-ingress'
  | 'api-admin'
  | 'api-enqueue'
  | 'api-moderation'
  | 'api-moderation-critical'
  | 'api-moderation-join'
  | 'api-moderation-realtime-b'
  | 'api-moderation-realtime-c'
  | 'api-moderation-realtime-d'
  | 'api-moderation-background'
  | 'api-action';

export type RuntimeQueueProfile =
  | 'all-in-one'
  | 'none'
  | 'webhook-enqueue'
  | 'webhook-critical'
  | 'webhook-join'
  | 'webhook-default'
  | 'webhook-background'
  | 'max-action-dispatch';

export type RuntimeQueuePriority =
  | 'all'
  | 'http-ingress'
  | 'admin-heavy-read'
  | 'webhook-enqueue'
  | 'user-facing-critical'
  | 'user-facing-realtime'
  | 'background'
  | 'action-dispatch';

export type RuntimeTopologySource =
  | 'declared-service'
  | 'role-inference'
  | 'queue-inference'
  | 'fallback';

export type RuntimeServiceProfile = {
  serviceName: RuntimeServiceName;
  serviceTitle: string;
  appRole: AppRole;
  capabilities: RuntimeRoleCapabilities;
  queueProfile: RuntimeQueueProfile;
  queuePriority: RuntimeQueuePriority;
  moderationQueues: readonly AnyWebhookQueueName[];
  dynamicLeasesMode: WebhookDynamicLeasesMode;
  dynamicLeasesWorkerGroup: DefaultWebhookWorkerGroupName | null;
  canaryShardIds: readonly DefaultWebhookQueueName[];
  backgroundTasksEnabled: boolean;
};

export type RuntimeServiceProfileResolution = {
  service: RuntimeServiceProfile;
  source: RuntimeTopologySource;
};

export const RUNTIME_ROLE_CAPABILITIES = Object.freeze({
  all: {
    httpEnabled: true,
    ingressEnabled: true,
    adminEnabled: true,
    enqueueEnabled: true,
    moderationEnabled: true,
    actionEnabled: true,
  },
  ingress: {
    httpEnabled: true,
    ingressEnabled: true,
    adminEnabled: false,
    enqueueEnabled: false,
    moderationEnabled: false,
    actionEnabled: false,
  },
  admin: {
    httpEnabled: true,
    ingressEnabled: false,
    adminEnabled: true,
    enqueueEnabled: false,
    moderationEnabled: false,
    actionEnabled: false,
  },
  enqueue: {
    httpEnabled: false,
    ingressEnabled: false,
    adminEnabled: false,
    enqueueEnabled: true,
    moderationEnabled: false,
    actionEnabled: false,
  },
  moderation: {
    httpEnabled: false,
    ingressEnabled: false,
    adminEnabled: false,
    enqueueEnabled: false,
    moderationEnabled: true,
    actionEnabled: false,
  },
  action: {
    httpEnabled: false,
    ingressEnabled: false,
    adminEnabled: false,
    enqueueEnabled: false,
    moderationEnabled: false,
    actionEnabled: true,
  },
} as const satisfies Record<AppRole, RuntimeRoleCapabilities>);

export const DEFAULT_WEBHOOK_WORKER_GROUP_NAMES = Object.freeze([
  'api-moderation',
  'api-moderation-realtime-b',
  'api-moderation-realtime-c',
  'api-moderation-realtime-d',
] as const satisfies readonly DefaultWebhookWorkerGroupName[]);

export const DEFAULT_WEBHOOK_WORKER_GROUP_QUEUES = Object.freeze(
  Object.fromEntries(
    DEFAULT_WEBHOOK_WORKER_GROUP_NAMES.map((groupName, groupIndex) => [
      groupName,
      DEFAULT_WEBHOOK_QUEUE_NAMES.filter(
        (_, shardIndex) => shardIndex % DEFAULT_WEBHOOK_WORKER_GROUP_NAMES.length === groupIndex,
      ),
    ]),
  ) as unknown as Record<DefaultWebhookWorkerGroupName, readonly DefaultWebhookQueueName[]>,
);

export const ALL_MODERATION_QUEUE_NAMES: readonly AnyWebhookQueueName[] = Object.freeze([
  LEGACY_WEBHOOK_QUEUE,
  WEBHOOK_QUEUE_CRITICAL,
  ...JOIN_WEBHOOK_QUEUE_NAMES,
  ...DEFAULT_WEBHOOK_QUEUE_NAMES,
  WEBHOOK_QUEUE_BACKGROUND,
]);

export const WEBHOOK_DYNAMIC_LEASES_MODES = Object.freeze([
  'off',
  'shadow',
  'canary',
  'on',
] as const satisfies readonly WebhookDynamicLeasesMode[]);

export const RUNTIME_SERVICE_NAMES = Object.freeze([
  'api-all',
  'api-ingress',
  'api-admin',
  'api-enqueue',
  'api-moderation',
  'api-moderation-critical',
  'api-moderation-join',
  'api-moderation-realtime-b',
  'api-moderation-realtime-c',
  'api-moderation-realtime-d',
  'api-moderation-background',
  'api-action',
] as const satisfies readonly RuntimeServiceName[]);

const DEFAULT_CANARY_SHARDS = Object.freeze([
  'moderation-default-2',
  'moderation-default-11',
] as const satisfies readonly DefaultWebhookQueueName[]);

export const RUNTIME_SERVICE_PROFILES = Object.freeze({
  'api-all': {
    serviceName: 'api-all',
    serviceTitle: 'All-in-one API runtime',
    appRole: 'all',
    capabilities: RUNTIME_ROLE_CAPABILITIES.all,
    queueProfile: 'all-in-one',
    queuePriority: 'all',
    moderationQueues: ALL_MODERATION_QUEUE_NAMES,
    dynamicLeasesMode: 'off',
    dynamicLeasesWorkerGroup: null,
    canaryShardIds: [],
    backgroundTasksEnabled: true,
  },
  'api-ingress': {
    serviceName: 'api-ingress',
    serviceTitle: 'Public webhook/API ingress',
    appRole: 'ingress',
    capabilities: RUNTIME_ROLE_CAPABILITIES.ingress,
    queueProfile: 'none',
    queuePriority: 'http-ingress',
    moderationQueues: [],
    dynamicLeasesMode: 'off',
    dynamicLeasesWorkerGroup: null,
    canaryShardIds: [],
    backgroundTasksEnabled: false,
  },
  'api-admin': {
    serviceName: 'api-admin',
    serviceTitle: 'Admin and heavy-read API',
    appRole: 'admin',
    capabilities: RUNTIME_ROLE_CAPABILITIES.admin,
    queueProfile: 'none',
    queuePriority: 'admin-heavy-read',
    moderationQueues: [],
    dynamicLeasesMode: 'off',
    dynamicLeasesWorkerGroup: null,
    canaryShardIds: [],
    backgroundTasksEnabled: false,
  },
  'api-enqueue': {
    serviceName: 'api-enqueue',
    serviceTitle: 'Webhook enqueue worker',
    appRole: 'enqueue',
    capabilities: RUNTIME_ROLE_CAPABILITIES.enqueue,
    queueProfile: 'webhook-enqueue',
    queuePriority: 'webhook-enqueue',
    moderationQueues: [],
    dynamicLeasesMode: 'off',
    dynamicLeasesWorkerGroup: null,
    canaryShardIds: [],
    backgroundTasksEnabled: false,
  },
  'api-moderation': {
    serviceName: 'api-moderation',
    serviceTitle: 'Default moderation shard group A',
    appRole: 'moderation',
    capabilities: RUNTIME_ROLE_CAPABILITIES.moderation,
    queueProfile: 'webhook-default',
    queuePriority: 'user-facing-realtime',
    moderationQueues: DEFAULT_WEBHOOK_WORKER_GROUP_QUEUES['api-moderation'],
    dynamicLeasesMode: 'canary',
    dynamicLeasesWorkerGroup: 'api-moderation',
    canaryShardIds: DEFAULT_CANARY_SHARDS,
    backgroundTasksEnabled: false,
  },
  'api-moderation-critical': {
    serviceName: 'api-moderation-critical',
    serviceTitle: 'Critical webhook worker',
    appRole: 'moderation',
    capabilities: RUNTIME_ROLE_CAPABILITIES.moderation,
    queueProfile: 'webhook-critical',
    queuePriority: 'user-facing-critical',
    moderationQueues: [LEGACY_WEBHOOK_QUEUE, WEBHOOK_QUEUE_CRITICAL],
    dynamicLeasesMode: 'off',
    dynamicLeasesWorkerGroup: null,
    canaryShardIds: [],
    backgroundTasksEnabled: false,
  },
  'api-moderation-join': {
    serviceName: 'api-moderation-join',
    serviceTitle: 'Membership/join webhook worker',
    appRole: 'moderation',
    capabilities: RUNTIME_ROLE_CAPABILITIES.moderation,
    queueProfile: 'webhook-join',
    queuePriority: 'user-facing-critical',
    moderationQueues: JOIN_WEBHOOK_QUEUE_NAMES,
    dynamicLeasesMode: 'off',
    dynamicLeasesWorkerGroup: null,
    canaryShardIds: [],
    backgroundTasksEnabled: false,
  },
  'api-moderation-realtime-b': {
    serviceName: 'api-moderation-realtime-b',
    serviceTitle: 'Default moderation shard group B',
    appRole: 'moderation',
    capabilities: RUNTIME_ROLE_CAPABILITIES.moderation,
    queueProfile: 'webhook-default',
    queuePriority: 'user-facing-realtime',
    moderationQueues: DEFAULT_WEBHOOK_WORKER_GROUP_QUEUES['api-moderation-realtime-b'],
    dynamicLeasesMode: 'canary',
    dynamicLeasesWorkerGroup: 'api-moderation-realtime-b',
    canaryShardIds: DEFAULT_CANARY_SHARDS,
    backgroundTasksEnabled: false,
  },
  'api-moderation-realtime-c': {
    serviceName: 'api-moderation-realtime-c',
    serviceTitle: 'Default moderation shard group C',
    appRole: 'moderation',
    capabilities: RUNTIME_ROLE_CAPABILITIES.moderation,
    queueProfile: 'webhook-default',
    queuePriority: 'user-facing-realtime',
    moderationQueues: DEFAULT_WEBHOOK_WORKER_GROUP_QUEUES['api-moderation-realtime-c'],
    dynamicLeasesMode: 'canary',
    dynamicLeasesWorkerGroup: 'api-moderation-realtime-c',
    canaryShardIds: DEFAULT_CANARY_SHARDS,
    backgroundTasksEnabled: false,
  },
  'api-moderation-realtime-d': {
    serviceName: 'api-moderation-realtime-d',
    serviceTitle: 'Default moderation shard group D',
    appRole: 'moderation',
    capabilities: RUNTIME_ROLE_CAPABILITIES.moderation,
    queueProfile: 'webhook-default',
    queuePriority: 'user-facing-realtime',
    moderationQueues: DEFAULT_WEBHOOK_WORKER_GROUP_QUEUES['api-moderation-realtime-d'],
    dynamicLeasesMode: 'canary',
    dynamicLeasesWorkerGroup: 'api-moderation-realtime-d',
    canaryShardIds: DEFAULT_CANARY_SHARDS,
    backgroundTasksEnabled: false,
  },
  'api-moderation-background': {
    serviceName: 'api-moderation-background',
    serviceTitle: 'Background moderation worker',
    appRole: 'moderation',
    capabilities: RUNTIME_ROLE_CAPABILITIES.moderation,
    queueProfile: 'webhook-background',
    queuePriority: 'background',
    moderationQueues: [WEBHOOK_QUEUE_BACKGROUND],
    dynamicLeasesMode: 'off',
    dynamicLeasesWorkerGroup: null,
    canaryShardIds: [],
    backgroundTasksEnabled: true,
  },
  'api-action': {
    serviceName: 'api-action',
    serviceTitle: 'MAX action dispatch worker',
    appRole: 'action',
    capabilities: RUNTIME_ROLE_CAPABILITIES.action,
    queueProfile: 'max-action-dispatch',
    queuePriority: 'action-dispatch',
    moderationQueues: [],
    dynamicLeasesMode: 'off',
    dynamicLeasesWorkerGroup: null,
    canaryShardIds: [],
    backgroundTasksEnabled: true,
  },
} as const satisfies Record<RuntimeServiceName, RuntimeServiceProfile>);

const SERVICE_BY_DEFAULT_WORKER_GROUP = Object.freeze(
  Object.fromEntries(
    DEFAULT_WEBHOOK_WORKER_GROUP_NAMES.map((groupName) => [groupName, groupName]),
  ) as Record<DefaultWebhookWorkerGroupName, RuntimeServiceName>,
);

export function isRuntimeServiceName(value: unknown): value is RuntimeServiceName {
  return typeof value === 'string' && RUNTIME_SERVICE_NAMES.includes(value as RuntimeServiceName);
}

export function isDefaultWebhookWorkerGroupName(
  value: unknown,
): value is DefaultWebhookWorkerGroupName {
  return (
    typeof value === 'string' &&
    DEFAULT_WEBHOOK_WORKER_GROUP_NAMES.includes(value as DefaultWebhookWorkerGroupName)
  );
}

export function resolveRuntimeServiceProfile(
  env: Record<string, unknown> = process.env,
): RuntimeServiceProfileResolution {
  const declaredService = normalizeRuntimeServiceName(env.APP_SERVICE_NAME);
  if (declaredService) {
    return {
      service: RUNTIME_SERVICE_PROFILES[declaredService],
      source: 'declared-service',
    };
  }

  const role = normalizeAppRole(env.APP_ROLE);
  if (role !== 'moderation') {
    const serviceName = serviceNameByRole(role);
    return {
      service: RUNTIME_SERVICE_PROFILES[serviceName],
      source: role === 'all' ? 'fallback' : 'role-inference',
    };
  }

  const workerGroup = normalizeDefaultWorkerGroupName(env.WEBHOOK_DYNAMIC_LEASES_WORKER_GROUP);
  if (workerGroup) {
    return {
      service: RUNTIME_SERVICE_PROFILES[SERVICE_BY_DEFAULT_WORKER_GROUP[workerGroup]],
      source: 'role-inference',
    };
  }

  const queueProfileService = inferModerationServiceFromQueues(env.MODERATION_ENABLED_QUEUES);
  if (queueProfileService) {
    return {
      service: RUNTIME_SERVICE_PROFILES[queueProfileService],
      source: 'queue-inference',
    };
  }

  return {
    service: RUNTIME_SERVICE_PROFILES['api-moderation'],
    source: 'fallback',
  };
}

export function normalizeRuntimeServiceName(value: unknown): RuntimeServiceName | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  return isRuntimeServiceName(normalized) ? normalized : null;
}

export function normalizeDefaultWorkerGroupName(
  value: unknown,
): DefaultWebhookWorkerGroupName | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim();
  return isDefaultWebhookWorkerGroupName(normalized) ? normalized : null;
}

function serviceNameByRole(role: AppRole): RuntimeServiceName {
  switch (role) {
    case 'ingress':
      return 'api-ingress';
    case 'admin':
      return 'api-admin';
    case 'enqueue':
      return 'api-enqueue';
    case 'action':
      return 'api-action';
    case 'moderation':
      return 'api-moderation';
    case 'all':
    default:
      return 'api-all';
  }
}

function inferModerationServiceFromQueues(rawValue: unknown): RuntimeServiceName | null {
  if (typeof rawValue !== 'string' || rawValue.trim().length === 0) {
    return null;
  }

  const tokens = new Set(
    rawValue
      .split(',')
      .map((token) => token.trim().toLowerCase())
      .filter(Boolean),
  );

  if (tokens.has('background') || tokens.has(WEBHOOK_QUEUE_BACKGROUND)) {
    return 'api-moderation-background';
  }
  if (tokens.has('join') || JOIN_WEBHOOK_QUEUE_NAMES.some((queueName) => tokens.has(queueName))) {
    return 'api-moderation-join';
  }
  if (
    tokens.has('critical') ||
    tokens.has('legacy') ||
    tokens.has(WEBHOOK_QUEUE_CRITICAL) ||
    tokens.has(LEGACY_WEBHOOK_QUEUE)
  ) {
    return 'api-moderation-critical';
  }

  for (const groupName of DEFAULT_WEBHOOK_WORKER_GROUP_NAMES) {
    const groupQueues = DEFAULT_WEBHOOK_WORKER_GROUP_QUEUES[groupName];
    if (groupQueues.some((queueName) => tokens.has(queueName))) {
      return SERVICE_BY_DEFAULT_WORKER_GROUP[groupName];
    }
  }

  return null;
}
