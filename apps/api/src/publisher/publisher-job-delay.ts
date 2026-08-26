import { DelayedError, type Job } from 'bullmq';

export type PublisherDeferrableJob = Pick<Job, 'moveToDelayed' | 'token'>;

export async function delayPublisherJobOrRethrow(
  job: PublisherDeferrableJob,
  workerToken: string | undefined,
  delayMs: number,
  error: unknown,
): Promise<never> {
  const lockToken = workerToken?.trim() || job.token?.trim();
  if (!lockToken) {
    throw error;
  }
  try {
    await job.moveToDelayed(Date.now() + delayMs, lockToken);
  } catch {
    throw error;
  }
  throw new DelayedError();
}
