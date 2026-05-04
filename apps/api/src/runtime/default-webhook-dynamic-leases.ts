import {
  DEFAULT_WEBHOOK_WORKER_GROUP_NAMES,
  type DefaultWebhookWorkerGroupName,
  type WebhookDynamicLeasesMode,
} from './moderation-runtime';
import {
  DEFAULT_WEBHOOK_QUEUE_NAMES,
  type DefaultWebhookQueueName,
} from '../webhook/webhook-queues';

export type DefaultWebhookShardClaim = {
  queueName: DefaultWebhookQueueName;
  ownerId: DefaultWebhookWorkerGroupName;
  fencingToken: number;
  claimedAtMs: number;
  updatedAtMs: number;
  leaseUntilMs: number;
};

export type DefaultWebhookShardHandoff = {
  queueName: DefaultWebhookQueueName;
  fromOwnerId: DefaultWebhookWorkerGroupName;
  toOwnerId: DefaultWebhookWorkerGroupName;
  issuedAtMs: number;
  expiresAtMs: number;
};

export type DefaultWebhookLeaseSummaryEntry = {
  queueName: DefaultWebhookQueueName;
  homeOwner: DefaultWebhookWorkerGroupName;
  actualOwner: DefaultWebhookWorkerGroupName;
  desiredOwner: DefaultWebhookWorkerGroupName;
  eligibleForDynamicLeases: boolean;
  handoffPending: boolean;
  activeJobs: number;
  pressure: number;
  reason: string;
  claimFencingToken: number | null;
  claimLeaseUntil: string | null;
  lastHandoffAt: string | null;
};

export type DefaultWebhookLeaseSummary = {
  mode: WebhookDynamicLeasesMode;
  generatedAt: string;
  queues: Record<DefaultWebhookQueueName, DefaultWebhookLeaseSummaryEntry>;
  workerLoads: Record<DefaultWebhookWorkerGroupName, number>;
  liveWorkerGroups: DefaultWebhookWorkerGroupName[];
};

const LEASE_KEY_PREFIX = 'system:webhook-default-lease:v1:claim:';
const HANDOFF_KEY_PREFIX = 'system:webhook-default-lease:v1:handoff:';
const HEARTBEAT_KEY_PREFIX = 'system:webhook-default-lease:v1:heartbeat:';
export const DEFAULT_WEBHOOK_LEASE_SUMMARY_KEY = 'system:webhook-default-lease:v1:summary';

export function buildDefaultWebhookLeaseKey(queueName: DefaultWebhookQueueName): string {
  return `${LEASE_KEY_PREFIX}${queueName}`;
}

export function buildDefaultWebhookHandoffKey(queueName: DefaultWebhookQueueName): string {
  return `${HANDOFF_KEY_PREFIX}${queueName}`;
}

export function buildDefaultWebhookWorkerHeartbeatKey(
  workerGroupName: DefaultWebhookWorkerGroupName,
): string {
  return `${HEARTBEAT_KEY_PREFIX}${workerGroupName}`;
}

export function isDefaultWebhookWorkerGroupName(
  value: unknown,
): value is DefaultWebhookWorkerGroupName {
  return (
    typeof value === 'string' &&
    DEFAULT_WEBHOOK_WORKER_GROUP_NAMES.includes(value as DefaultWebhookWorkerGroupName)
  );
}

export function isDefaultWebhookQueueName(value: unknown): value is DefaultWebhookQueueName {
  return (
    typeof value === 'string' && (DEFAULT_WEBHOOK_QUEUE_NAMES as readonly string[]).includes(value)
  );
}
