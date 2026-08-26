import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { getAppRole, roleRunsPublisher } from '../runtime/app-role';
import { PublisherDispatchHealthService } from '../publisher/publisher-dispatch-health.service';
import { assertPublisherDispatchAllowedOrDelay } from '../publisher/publisher-dispatch-job-guard';
import { PublisherIdentityAttestationService } from '../publisher/publisher-identity-attestation.service';
import { assertPublisherIdentityOrDelay } from '../publisher/publisher-identity-attestation-job-guard';
import { ChannelDialogService } from './channel-dialog.service';
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
  ) {
    super();
  }

  async process(job: Job<PublisherSuggestionPublicationJob>, token?: string): Promise<void> {
    if (!roleRunsPublisher(getAppRole()) || process.env.APP_SERVICE_NAME !== 'api-publisher') {
      throw new Error('Publisher suggestion job received by a non-publisher API role');
    }
    await assertPublisherIdentityOrDelay(this.identityAttestation, job, token);
    await assertPublisherDispatchAllowedOrDelay(this.dispatchHealth, job, token);
    await this.channelDialogService.processPublisherSuggestionPublicationJob(
      job.data.suggestionId,
      job.data.claimToken,
    );
  }
}
