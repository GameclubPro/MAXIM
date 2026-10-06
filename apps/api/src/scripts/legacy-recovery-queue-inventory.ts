import { MAX_ACTION_ALL_QUEUE_NAMES } from '../max/max-action.queue';
import type { MaxActionJob } from '../max/max-client.service';
import { readLegacyActionSourceScopes } from '../webhook/webhook-legacy-hold.service';
import {
  legacySnapshotDigest,
  type LegacyChildHoldInput,
  type LegacyRecoveryCandidate,
} from '../webhook/webhook-legacy-cold-install';

export const LEGACY_RECOVERY_MAX_QUEUE_JOBS = 5_000;
export class LegacyRecoveryRefusedError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
const catalogReplyBytes = 64 * 1024;
const catalogReplyKeys = 200;
// FLAG: COUNT is only a Redis hint. Reject oversized replies on the server before
// they reach the client; EVAL_RO cannot mutate queues or their metadata.
const boundedCatalogScan = `
local result = redis.call('SCAN', ARGV[1], 'MATCH', 'bull:*', 'COUNT', 200)
local keys = result[2]
if #keys > 200 then return {0} end
local bytes = 0
for _, key in ipairs(keys) do
  bytes = bytes + string.len(key)
  if bytes > 65536 then return {0} end
end
local reply = {1, result[1]}
for _, key in ipairs(keys) do table.insert(reply, key) end
return reply
`;
export async function scanLegacyRecoveryQueueCatalog(
  redis: { eval_ro(script: string, keyCount: number, cursor: string): Promise<unknown> },
  cursor: string,
): Promise<[string, string[]]> {
  if (!/^[0-9]{1,20}$/u.test(cursor))
    throw new LegacyRecoveryRefusedError('queue_inventory_unproved', 'Invalid catalog cursor');
  const reply = await redis.eval_ro(boundedCatalogScan, 0, cursor);
  if (
    !Array.isArray(reply) ||
    reply[0] !== 1 ||
    typeof reply[1] !== 'string' ||
    !/^[0-9]{1,20}$/u.test(reply[1]) ||
    reply.length - 2 > catalogReplyKeys ||
    reply.slice(2).some((key) => typeof key !== 'string') ||
    reply.slice(2).reduce((bytes, key: string) => bytes + Buffer.byteLength(key), 0) >
      catalogReplyBytes
  )
    throw new LegacyRecoveryRefusedError(
      'queue_catalog_budget_exceeded',
      'Legacy queue catalog reply exceeds finite review budget',
    );
  return [reply[1], reply.slice(2) as string[]];
}
export const LEGACY_RECOVERY_JOB_STATES = [
  'wait',
  'paused',
  'active',
  'delayed',
  'prioritized',
  'waiting-children',
  'failed',
] as const;
export type LegacyQueueSnapshot = {
  name: string;
  count: number;
  jobs: Array<{ id: string; data: unknown }>;
};
const actionQueues = new Set<string>(MAX_ACTION_ALL_QUEUE_NAMES);
const actions = new Set([
  'SEND_MESSAGE',
  'DELETE_MESSAGE',
  'BAN_MEMBER',
  'KICK_MEMBER',
  'UNBAN_MEMBER',
  'TRY_UNBAN_MEMBER',
  'NOTIFY_MODERATORS',
]);
export function isLegacyRecoveryWebhookQueue(name: string): boolean {
  return /^(?:moderation|moderation-critical|moderation-background|moderation-default|moderation-join-[0-3]|moderation-default-(?:[0-9]|1[0-5]))$/u.test(
    name,
  );
}
function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function id(value: unknown): string | null {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 512 &&
    value === value.trim()
    ? value
    : null;
}

// FLAG: Initial cold recovery deliberately refuses nonempty non-MAX child queues.
// Queue truncation and unattributed SEND are no-apply results, never proof of no effects.
export function classifyLegacyRecoveryQueues(
  candidates: readonly LegacyRecoveryCandidate[],
  queues: readonly LegacyQueueSnapshot[],
): LegacyChildHoldInput[] {
  if (new Set(queues.map((queue) => queue.name)).size !== queues.length)
    throw new LegacyRecoveryRefusedError(
      'child_inventory_incomplete',
      'Duplicate legacy queue inventory',
    );
  const chats = new Set(candidates.map((candidate) => candidate.source.chatId));
  const users = new Set(candidates.map((candidate) => candidate.source.userId));
  const children = new Map<string, LegacyChildHoldInput>();
  let total = 0;
  for (const queue of queues) {
    if (
      !Number.isSafeInteger(queue.count) ||
      queue.count < 0 ||
      queue.count !== queue.jobs.length ||
      new Set(queue.jobs.map((job) => job.id)).size !== queue.jobs.length
    )
      throw new LegacyRecoveryRefusedError(
        'child_inventory_incomplete',
        'Incomplete legacy queue inventory',
      );
    total += queue.count;
    if (total > LEGACY_RECOVERY_MAX_QUEUE_JOBS)
      throw new LegacyRecoveryRefusedError(
        'queue_catalog_budget_exceeded',
        'Legacy queue inventory exceeds finite review budget',
      );
    if (!actionQueues.has(queue.name)) {
      if (queue.count !== 0)
        throw new LegacyRecoveryRefusedError(
          'non_max_work_pending',
          'Unclassified non-MAX child queue blocks legacy recovery',
        );
      continue;
    }
    for (const job of queue.jobs) {
      const data = record(job.data);
      const chatId = id(data?.chatId);
      const jobKey = id(data?.idempotencyKey);
      const userId = id(data?.userId);
      const messageId = id(data?.messageId);
      if (
        !id(job.id) ||
        !chatId ||
        !jobKey ||
        typeof data?.actionType !== 'string' ||
        !actions.has(data.actionType)
      )
        throw new LegacyRecoveryRefusedError(
          'max_child_unattributed',
          'Unattributed MAX child blocks legacy recovery',
        );
      let scopes: ReturnType<typeof readLegacyActionSourceScopes>;
      try {
        scopes = readLegacyActionSourceScopes(data as unknown as MaxActionJob);
      } catch {
        throw new LegacyRecoveryRefusedError(
          'child_scope_conflict',
          'Conflicting legacy child source scope',
        );
      }
      if (scopes.some((scope) => scope.chatId !== chatId))
        throw new LegacyRecoveryRefusedError(
          'child_scope_conflict',
          'Conflicting legacy child source scope',
        );
      const sourceUsers = [
        ...new Set(scopes.flatMap((scope) => (scope.userId ? [scope.userId] : []))),
      ];
      const sourceMessages = [
        ...new Set(scopes.flatMap((scope) => (scope.messageId ? [scope.messageId] : []))),
      ];
      if (sourceUsers.length > 1 || sourceMessages.length > 1)
        throw new LegacyRecoveryRefusedError(
          'child_scope_conflict',
          'Conflicting legacy child source scope',
        );
      const sourceUser = userId ?? sourceUsers[0];
      const sourceMessage = messageId ?? sourceMessages[0];
      // An old generic SEND may target another scope. Its origin cannot be deduced
      // from rendered text, a job ID, creation time or the absence of a SQL ledger.
      if (data.actionType === 'SEND_MESSAGE' && !sourceUser && !sourceMessage)
        throw new LegacyRecoveryRefusedError(
          'send_source_unattributed',
          'Unattributed SEND blocks legacy recovery',
        );
      if (!chats.has(chatId)) {
        // Cross-chat member effects are denied by the permanent global-user hold.
        // No broader chat hold is invented for an unrelated destination.
        if (sourceUser && users.has(sourceUser) && data.actionType === 'SEND_MESSAGE')
          throw new LegacyRecoveryRefusedError(
            'cross_chat_send_pending',
            'Cross-chat legacy SEND requires separate reviewed scope',
          );
        continue;
      }
      const child: LegacyChildHoldInput = {
        jobKey,
        queueName: queue.name,
        jobPayloadDigest: legacySnapshotDigest(job.data),
        chatId,
        ...(sourceMessage ? { messageId: sourceMessage } : {}),
        ...(sourceUser ? { userId: sourceUser } : {}),
      };
      const prior = children.get(jobKey);
      if (prior && legacySnapshotDigest(prior) !== legacySnapshotDigest(child))
        throw new LegacyRecoveryRefusedError(
          'child_identity_conflict',
          'Conflicting legacy child identity',
        );
      children.set(jobKey, child);
    }
  }
  return [...children.values()].sort((a, b) => a.jobKey.localeCompare(b.jobKey));
}
