import { DelayedError, type Job } from 'bullmq';
import {
  PublisherIdentityAttestationError,
  PublisherIdentityAttestationService,
} from './publisher-identity-attestation.service';

export const PUBLISHER_IDENTITY_ATTESTATION_DEFER_MS = 60_000;

type PublisherDeferrableJob = Pick<Job, 'moveToDelayed' | 'token'>;

export async function assertPublisherIdentityOrDelay(
  identityAttestation: PublisherIdentityAttestationService,
  job: PublisherDeferrableJob,
  workerToken?: string,
): Promise<void> {
  try {
    await identityAttestation.assertAttested();
  } catch (error: unknown) {
    if (!(error instanceof PublisherIdentityAttestationError)) {
      throw error;
    }

    const lockToken = workerToken?.trim() || job.token?.trim();
    if (!lockToken) {
      throw error;
    }
    try {
      await job.moveToDelayed(Date.now() + PUBLISHER_IDENTITY_ATTESTATION_DEFER_MS, lockToken);
    } catch {
      throw error;
    }
    throw new DelayedError();
  }
}
