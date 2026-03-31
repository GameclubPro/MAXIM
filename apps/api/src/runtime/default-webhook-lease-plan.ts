import {
  DEFAULT_WEBHOOK_WORKER_GROUP_NAMES,
  getDefaultWebhookHomeOwnerByQueue,
  getWebhookDynamicLeaseCanaryQueues,
  type DefaultWebhookWorkerGroupName,
  type WebhookDynamicLeasesMode,
} from './moderation-runtime';
import {
  DEFAULT_WEBHOOK_QUEUE_NAMES,
  type DefaultWebhookQueueName,
} from '../webhook/webhook-queues';

export type DefaultWebhookLeaseCounters = {
  waiting: number;
  active: number;
  delayed: number;
  failed?: number;
  completed?: number;
};

export type DefaultWebhookLeasePlanInput = {
  mode: WebhookDynamicLeasesMode;
  canaryQueues?: ReadonlySet<DefaultWebhookQueueName>;
  aliveWorkerGroups?: ReadonlySet<DefaultWebhookWorkerGroupName>;
  claimedOwners?: Partial<Record<DefaultWebhookQueueName, DefaultWebhookWorkerGroupName | null>>;
  lastHandoffAtMs?: Partial<Record<DefaultWebhookQueueName, number | null>>;
  queueCounters: Record<DefaultWebhookQueueName, DefaultWebhookLeaseCounters>;
  rebalanceCooldownMs: number;
  suppressRebalance?: boolean;
};

export type DefaultWebhookLeasePlanEntry = {
  queueName: DefaultWebhookQueueName;
  homeOwner: DefaultWebhookWorkerGroupName;
  eligibleForDynamicLeases: boolean;
  currentOwner: DefaultWebhookWorkerGroupName;
  desiredOwner: DefaultWebhookWorkerGroupName;
  handoffPending: boolean;
  activeJobs: number;
  pressure: number;
  reason:
    | 'static-home'
    | 'bootstrap-home'
    | 'keep-active-owner'
    | 'keep-pressure-owner'
    | 'keep-cooldown-owner'
    | 'keep-current-owner'
    | 'rebalance-least-loaded'
    | 'owner-unavailable';
};

export type DefaultWebhookLeasePlan = {
  queues: Record<DefaultWebhookQueueName, DefaultWebhookLeasePlanEntry>;
  workerLoads: Record<DefaultWebhookWorkerGroupName, number>;
};

const ACTIVE_WEIGHT = 4;

function normalizeWorkerGroups(
  aliveWorkerGroups?: ReadonlySet<DefaultWebhookWorkerGroupName>,
): DefaultWebhookWorkerGroupName[] {
  if (!aliveWorkerGroups || aliveWorkerGroups.size === 0) {
    return [...DEFAULT_WEBHOOK_WORKER_GROUP_NAMES];
  }

  const normalized = DEFAULT_WEBHOOK_WORKER_GROUP_NAMES.filter((groupName) =>
    aliveWorkerGroups.has(groupName),
  );
  return normalized.length > 0 ? normalized : [...DEFAULT_WEBHOOK_WORKER_GROUP_NAMES];
}

function resolveDynamicEligibility(
  mode: WebhookDynamicLeasesMode,
  canaryQueues: ReadonlySet<DefaultWebhookQueueName>,
  queueName: DefaultWebhookQueueName,
): boolean {
  if (mode === 'on') {
    return true;
  }
  if (mode === 'canary') {
    return canaryQueues.has(queueName);
  }
  return false;
}

function measurePressure(counters: DefaultWebhookLeaseCounters): number {
  return counters.waiting + counters.active * ACTIVE_WEIGHT + counters.delayed;
}

export function buildDefaultWebhookLeasePlan(
  input: DefaultWebhookLeasePlanInput,
): DefaultWebhookLeasePlan {
  const nowMs = Date.now();
  const canaryQueues =
    input.canaryQueues ?? getWebhookDynamicLeaseCanaryQueues(undefined);
  const aliveWorkerGroups = normalizeWorkerGroups(input.aliveWorkerGroups);
  const homeOwnerByQueue = getDefaultWebhookHomeOwnerByQueue();
  const lastHandoffAtMs = input.lastHandoffAtMs ?? {};
  const claimedOwners = input.claimedOwners ?? {};

  const currentOwnerByQueue = Object.fromEntries(
    DEFAULT_WEBHOOK_QUEUE_NAMES.map((queueName) => {
      const homeOwner = homeOwnerByQueue[queueName];
      const claimedOwner = claimedOwners[queueName];
      if (
        claimedOwner &&
        DEFAULT_WEBHOOK_WORKER_GROUP_NAMES.includes(claimedOwner as DefaultWebhookWorkerGroupName)
      ) {
        return [queueName, claimedOwner];
      }
      return [queueName, homeOwner];
    }),
  ) as Record<DefaultWebhookQueueName, DefaultWebhookWorkerGroupName>;

  const workerLoads = Object.fromEntries(
    DEFAULT_WEBHOOK_WORKER_GROUP_NAMES.map((groupName) => [groupName, 0]),
  ) as Record<DefaultWebhookWorkerGroupName, number>;
  for (const queueName of DEFAULT_WEBHOOK_QUEUE_NAMES) {
    workerLoads[currentOwnerByQueue[queueName]] += measurePressure(input.queueCounters[queueName]);
  }

  const queues = {} as Record<DefaultWebhookQueueName, DefaultWebhookLeasePlanEntry>;
  const dynamicQueues = DEFAULT_WEBHOOK_QUEUE_NAMES.filter((queueName) =>
    resolveDynamicEligibility(input.mode, canaryQueues, queueName),
  ).sort(
    (left, right) =>
      measurePressure(input.queueCounters[right]) - measurePressure(input.queueCounters[left]) ||
      left.localeCompare(right),
  );

  for (const queueName of DEFAULT_WEBHOOK_QUEUE_NAMES) {
    const homeOwner = homeOwnerByQueue[queueName];
    const currentOwner = currentOwnerByQueue[queueName];
    const eligibleForDynamicLeases = resolveDynamicEligibility(input.mode, canaryQueues, queueName);
    const counters = input.queueCounters[queueName];
    const pressure = measurePressure(counters);
    queues[queueName] = {
      queueName,
      homeOwner,
      eligibleForDynamicLeases,
      currentOwner,
      desiredOwner: currentOwner,
      handoffPending: false,
      activeJobs: counters.active,
      pressure,
      reason: eligibleForDynamicLeases ? 'bootstrap-home' : 'static-home',
    };
  }

  for (const queueName of dynamicQueues) {
    const queue = queues[queueName];
    const homeOwner = queue.homeOwner;
    const currentOwner = queue.currentOwner;
    const lastHandoffAt = lastHandoffAtMs[queueName] ?? null;
    const cooldownActive =
      typeof lastHandoffAt === 'number' &&
      Number.isFinite(lastHandoffAt) &&
      nowMs - lastHandoffAt < input.rebalanceCooldownMs;

    if (!aliveWorkerGroups.includes(currentOwner)) {
      const desiredOwner = chooseLeastLoadedOwner({
        candidateOwners: aliveWorkerGroups,
        currentOwner,
        homeOwner,
        workerLoads,
      });
      queue.desiredOwner = desiredOwner;
      queue.handoffPending = desiredOwner !== currentOwner;
      queue.reason = 'owner-unavailable';
      continue;
    }

    if (queue.activeJobs > 0) {
      queue.desiredOwner = currentOwner;
      queue.reason = 'keep-active-owner';
      continue;
    }

    if (cooldownActive) {
      queue.desiredOwner = currentOwner;
      queue.reason = 'keep-cooldown-owner';
      continue;
    }

    if (input.suppressRebalance) {
      queue.desiredOwner = currentOwner;
      queue.reason = 'keep-pressure-owner';
      continue;
    }

    const desiredOwner = chooseLeastLoadedOwner({
      candidateOwners: aliveWorkerGroups,
      currentOwner,
      homeOwner,
      workerLoads,
    });

    if (desiredOwner === currentOwner) {
      queue.desiredOwner = currentOwner;
      queue.reason = 'keep-current-owner';
      continue;
    }

    workerLoads[currentOwner] = Math.max(0, workerLoads[currentOwner] - queue.pressure);
    workerLoads[desiredOwner] += queue.pressure;
    queue.desiredOwner = desiredOwner;
    queue.handoffPending = true;
    queue.reason = 'rebalance-least-loaded';
  }

  return {
    queues,
    workerLoads,
  };
}

function chooseLeastLoadedOwner(params: {
  candidateOwners: readonly DefaultWebhookWorkerGroupName[];
  currentOwner: DefaultWebhookWorkerGroupName;
  homeOwner: DefaultWebhookWorkerGroupName;
  workerLoads: Record<DefaultWebhookWorkerGroupName, number>;
}): DefaultWebhookWorkerGroupName {
  const { candidateOwners, currentOwner, homeOwner, workerLoads } = params;
  return [...candidateOwners].sort((left, right) => {
    const loadDiff = workerLoads[left] - workerLoads[right];
    if (loadDiff !== 0) {
      return loadDiff;
    }
    if (left === currentOwner && right !== currentOwner) {
      return -1;
    }
    if (right === currentOwner && left !== currentOwner) {
      return 1;
    }
    if (left === homeOwner && right !== homeOwner) {
      return -1;
    }
    if (right === homeOwner && left !== homeOwner) {
      return 1;
    }
    return left.localeCompare(right);
  })[0]!;
}
