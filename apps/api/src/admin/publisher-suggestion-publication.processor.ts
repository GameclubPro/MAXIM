import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Optional } from '@nestjs/common';
import type { Job } from 'bullmq';
import { getAppRole, roleRunsPublisher } from '../runtime/app-role';
import { PublisherDispatchHealthService } from '../publisher/publisher-dispatch-health.service';
import { PublisherActionCredentialService } from '../publisher/publisher-action-credential.service';
import {
  assertPublisherDispatchAllowedOrDelay,
  assertPublisherRuntimeEnabledOrDelay,
} from '../publisher/publisher-dispatch-job-guard';
import { PublisherIdentityAttestationService } from '../publisher/publisher-identity-attestation.service';
import { assertPublisherIdentityOrDelay } from '../publisher/publisher-identity-attestation-job-guard';
import { PublisherRuntimeBoundaryService } from '../publisher/publisher-runtime-boundary.service';
import { ChannelDialogService } from './channel-dialog.service';
import { PublisherSuggestionService } from './publisher-suggestion.service';
import {
  PUBLISHER_SUGGESTION_PUBLICATION_QUEUE,
  type PublisherSuggestionPublicationJob,
} from './publisher-suggestion-publication.queue';

@Processor(PUBLISHER_SUGGESTION_PUBLICATION_QUEUE, { concurrency: 1 })
export class PublisherSuggestionPublicationProcessor extends WorkerHost {
  constructor(
    private readonly channelDialogService: ChannelDialogService,
    private readonly identityAttestation: PublisherIdentityAttestationService,
    private readonly dispatchHealth: PublisherDispatchHealthService,
    private readonly runtimeBoundary: PublisherRuntimeBoundaryService,
    private readonly publisherSuggestions: PublisherSuggestionService,
    @Optional()
    private readonly publisherCredentials?: PublisherActionCredentialService,
  ) {
    super();
  }

  async process(job: Job<PublisherSuggestionPublicationJob>, token?: string): Promise<void> {
    if (!roleRunsPublisher(getAppRole()) || process.env.APP_SERVICE_NAME !== 'api-publisher') {
      throw new Error('Publisher suggestion job received by a non-publisher API role');
    }
    await assertPublisherRuntimeEnabledOrDelay(this.runtimeBoundary, job, token);
    await assertPublisherIdentityOrDelay(this.identityAttestation, job, token);
    await assertPublisherDispatchAllowedOrDelay(this.dispatchHealth, job, token);
    const handled = await this.publisherSuggestions.processPublicationJob(
      job.data.suggestionId,
      job.data.claimToken,
    );
    if (handled) {
      const requiredBotId = this.publisherCredentials?.getBotId().trim() ?? '';
      if (requiredBotId) {
        await this.channelDialogService.syncPublisherSuggestionAdminReviewMessages(
          job.data.suggestionId,
          requiredBotId,
        );
      }
      return;
    }
    await this.channelDialogService.processPublisherSuggestionPublicationJob(
      job.data.suggestionId,
      job.data.claimToken,
    );
  }
}
