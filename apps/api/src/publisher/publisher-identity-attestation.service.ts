import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { getAppRole, roleRunsPublisher } from '../runtime/app-role';
import { MaxClientService } from '../max/max-client.service';
import { PublisherActionCredentialService } from './publisher-action-credential.service';
import {
  extractPublisherMaxStatusCode,
  PublisherDispatchHealthService,
} from './publisher-dispatch-health.service';
import { matchesPublisherRemoteIdentity } from './publisher-identity-attestation.util';

export type PublisherIdentityAttestationFailure =
  | 'identity_mismatch'
  | 'authorization_failed'
  | 'transient_failure';

export class PublisherIdentityAttestationError extends Error {
  readonly code = 'PUBLISHER_IDENTITY_ATTESTATION_FAILED';

  constructor(readonly failure: PublisherIdentityAttestationFailure) {
    super('Publik action-token identity attestation failed');
    this.name = 'PublisherIdentityAttestationError';
  }
}

@Injectable()
export class PublisherIdentityAttestationService implements OnModuleInit {
  private readonly logger = new Logger(PublisherIdentityAttestationService.name);
  private readonly publisherBotId: string;
  private attested = false;
  private inFlight: Promise<void> | null = null;

  constructor(
    private readonly maxClient: MaxClientService,
    credentials: PublisherActionCredentialService,
    private readonly dispatchHealth: PublisherDispatchHealthService,
  ) {
    if (!roleRunsPublisher(getAppRole()) || process.env.APP_SERVICE_NAME !== 'api-publisher') {
      throw new Error('Publisher identity attestation loaded outside api-publisher');
    }
    this.publisherBotId = credentials.getBotId();
    credentials.getRequiredActionToken(this.publisherBotId);
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.assertAttested();
    } catch (error: unknown) {
      this.logger.warn(
        { failure: readAttestationFailure(error) },
        'Publik action-token identity is not attested; publisher dispatch remains closed',
      );
    }
  }

  async assertAttested(): Promise<void> {
    if (this.attested) {
      return;
    }
    if (this.inFlight) {
      return this.inFlight;
    }

    const attempt = this.attest();
    this.inFlight = attempt;
    try {
      await attempt;
    } finally {
      if (this.inFlight === attempt) {
        this.inFlight = null;
      }
    }
  }

  private async attest(): Promise<void> {
    const attemptedAt = new Date();
    let identity;
    try {
      identity = await this.maxClient.getOwnProfileIdentity({
        botId: this.publisherBotId,
        trafficClass: 'background',
        sourceTag: 'publisher_identity_attestation',
        timeoutMs: 5_000,
      });
    } catch (error: unknown) {
      const statusCode = extractPublisherMaxStatusCode(error);
      if (statusCode === 401 || statusCode === 403) {
        await this.persistIdentityPause('identity_authorization_failed', statusCode, new Date());
        throw new PublisherIdentityAttestationError('authorization_failed');
      }
      throw new PublisherIdentityAttestationError('transient_failure');
    }

    if (!matchesPublisherRemoteIdentity(this.publisherBotId, identity)) {
      await this.persistIdentityPause('identity_mismatch', null, new Date());
      throw new PublisherIdentityAttestationError('identity_mismatch');
    }

    try {
      await this.dispatchHealth.recordAuthenticatedSuccess(attemptedAt);
    } catch {
      throw new PublisherIdentityAttestationError('transient_failure');
    }
    this.attested = true;
  }

  private async persistIdentityPause(
    reason: 'identity_authorization_failed' | 'identity_mismatch',
    statusCode: number | null,
    observedAt: Date,
  ): Promise<void> {
    try {
      await this.dispatchHealth.recordGlobalIdentityAttestationFailure(
        reason,
        statusCode,
        observedAt,
      );
    } catch {
      this.logger.error(
        { reason },
        'Failed to persist the Publik identity-attestation pause; in-process dispatch remains closed',
      );
    }
  }
}

function readAttestationFailure(error: unknown): PublisherIdentityAttestationFailure {
  return error instanceof PublisherIdentityAttestationError ? error.failure : 'transient_failure';
}
