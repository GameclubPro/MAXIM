import {
  PublisherDispatchHealthUnavailableError,
  PublisherDispatchHealthService,
  PublisherDispatchPausedError,
} from './publisher-dispatch-health.service';
import { delayPublisherJobOrRethrow, type PublisherDeferrableJob } from './publisher-job-delay';
import {
  PublisherDispatchDisabledError,
  PublisherRuntimeBoundaryService,
} from './publisher-runtime-boundary.service';

export const PUBLISHER_DISPATCH_PAUSE_DEFER_MS = 60_000;

export async function assertPublisherRuntimeEnabledOrDelay(
  runtimeBoundary: PublisherRuntimeBoundaryService,
  job: PublisherDeferrableJob,
  workerToken?: string,
): Promise<void> {
  try {
    runtimeBoundary.assertDispatchEnabled();
  } catch (error: unknown) {
    if (!(error instanceof PublisherDispatchDisabledError)) {
      throw error;
    }
    await delayPublisherJobOrRethrow(job, workerToken, PUBLISHER_DISPATCH_PAUSE_DEFER_MS, error);
  }
}

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
