import { createHash, randomUUID } from 'node:crypto';
import type { JobsOptions, Queue } from 'bullmq';
import type { MaxChatAdminRosterSyncJob } from './max-chat-admin-roster-sync.queue';

// FLAG: An active older probe cannot consume a new explicit connection refresh.
// Deduplicate independently for each receiving bot and retain one fresh follow-up
// in Redis; replacing/removing a chat-wide job can lose another bot's demand.
export async function handOffHandshakeRoster(
  queue: Pick<Queue<MaxChatAdminRosterSyncJob>, 'add'>,
  job: MaxChatAdminRosterSyncJob,
  options: Pick<JobsOptions, 'attempts' | 'priority' | 'backoff'>,
): Promise<boolean> {
  if (job.source !== 'handshake_start' || job.botIds?.length !== 1 || !job.botIds[0]) return false;
  const key = `handshake-roster-${createHash('sha256')
    .update(JSON.stringify([job.chatId, job.botIds[0]]))
    .digest('hex')}`;
  await queue.add('sync-chat-admin-roster', job, {
    ...options,
    jobId: `${key}__${randomUUID()}`,
    deduplication: { id: key, keepLastIfActive: true },
    removeOnComplete: true,
    removeOnFail: false,
  });
  return true;
}
