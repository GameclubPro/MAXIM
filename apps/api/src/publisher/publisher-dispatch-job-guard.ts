import {
  PublisherDispatchHealthUnavailableError,
  PublisherDispatchHealthService,
  PublisherDispatchPausedError,
} from './publisher-dispatch-health.service';
import { delayPublisherJobOrRethrow, type PublisherDeferrableJob } from './publisher-job-delay';

export const PUBLISHER_DISPATCH_PAUSE_DEFER_MS = 60_000;

export async function assertPublisherDispatchAllowedOrDelay(
  dispatchHealth: PublisherDispatchHealthService,
  job: PublisherDeferrableJob,
  workerToken?: string,
): Promise<void> {
  try {
    await dispatchHealth.assertDispatchAllowed();
  } catch (error: unknown) {
    if (
      !(error instanceof PublisherDispatchPausedError) &&
      !(error instanceof PublisherDispatchHealthUnavailableError)
    ) {
      throw error;
    }
    await delayPublisherJobOrRethrow(job, workerToken, PUBLISHER_DISPATCH_PAUSE_DEFER_MS, error);
  }
}
