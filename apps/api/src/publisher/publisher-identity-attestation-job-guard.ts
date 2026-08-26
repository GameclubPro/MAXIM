import {
  PublisherIdentityAttestationError,
  PublisherIdentityAttestationService,
} from './publisher-identity-attestation.service';
import { delayPublisherJobOrRethrow, type PublisherDeferrableJob } from './publisher-job-delay';

export const PUBLISHER_IDENTITY_ATTESTATION_DEFER_MS = 60_000;

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
    await delayPublisherJobOrRethrow(
      job,
      workerToken,
      PUBLISHER_IDENTITY_ATTESTATION_DEFER_MS,
      error,
    );
  }
}
