import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { getAppRole, roleRunsPublisher } from '../runtime/app-role';
import {
  PUBLISHER_BINDING_REFRESH_QUEUE,
  type PublisherBindingRefreshJob,
} from './publisher-binding-refresh.queue';
import {
  assertPublisherDispatchAllowedOrDelay,
  assertPublisherRuntimeEnabledOrDelay,
} from './publisher-dispatch-job-guard';
import { PublisherDispatchHealthService } from './publisher-dispatch-health.service';
import {
  PublisherBindingRefreshService,
  PublisherCandidateRefreshSupersededError,
} from './publisher-binding-refresh.service';
import { PublisherRuntimeBoundaryService } from './publisher-runtime-boundary.service';

@Processor(PUBLISHER_BINDING_REFRESH_QUEUE, { concurrency: 2 })
export class PublisherBindingRefreshProcessor extends WorkerHost {
  constructor(
    private readonly refreshService: PublisherBindingRefreshService,
    private readonly runtimeBoundary: PublisherRuntimeBoundaryService,
    private readonly dispatchHealth: PublisherDispatchHealthService,
  ) {
    super();
  }

  async process(job: Job<PublisherBindingRefreshJob>, token?: string): Promise<void> {
    if (!roleRunsPublisher(getAppRole()) || process.env.APP_SERVICE_NAME !== 'api-publisher') {
      throw new Error('Publisher binding refresh claimed outside api-publisher');
    }
    // Candidate identity exists only in this job, so preserve it across a disabled rollout.
    if (job.data.candidateUserId?.trim()) {
      await assertPublisherRuntimeEnabledOrDelay(this.runtimeBoundary, job, token);
      await assertPublisherDispatchAllowedOrDelay(this.dispatchHealth, job, token);
    }
    try {
      await this.refreshService.refresh(job.data);
    } catch (error: unknown) {
      if (error instanceof PublisherCandidateRefreshSupersededError) {
        return;
      }
      throw error;
    }
  }
}
