import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { getAppRole, roleRunsPublisher } from '../runtime/app-role';
import {
  assertPublisherDispatchAllowedOrDelay,
  assertPublisherRuntimeEnabledOrDelay,
} from '../publisher/publisher-dispatch-job-guard';
import { PublisherDispatchHealthService } from '../publisher/publisher-dispatch-health.service';
import { assertPublisherIdentityOrDelay } from '../publisher/publisher-identity-attestation-job-guard';
import { PublisherIdentityAttestationService } from '../publisher/publisher-identity-attestation.service';
import { PublisherRuntimeBoundaryService } from '../publisher/publisher-runtime-boundary.service';
import { PublicationService } from './publication.service';
import { PublisherPublicationDispatchRunnerService } from './publisher-publication-dispatch-runner.service';
import {
  PUBLISHER_PUBLICATION_WAKEUP_JOB,
  PUBLISHER_PUBLICATION_WAKEUP_JOB_TTL_MS,
  PUBLISHER_PUBLICATION_WAKEUP_QUEUE,
  type PublisherPublicationWakeupJob,
  type PublisherPublicationWakeupReason,
} from './publisher-publication-wakeup.queue';

const WAKEUP_REASONS = new Set<PublisherPublicationWakeupReason>([
  'create',
  'update',
  'resume',
  'retry',
  'resolution',
]);

@Processor(PUBLISHER_PUBLICATION_WAKEUP_QUEUE, { concurrency: 1 })
export class PublisherPublicationWakeupProcessor extends WorkerHost {
  constructor(
    private readonly publicationService: PublicationService,
    private readonly publicationRunner: PublisherPublicationDispatchRunnerService,
    private readonly runtimeBoundary: PublisherRuntimeBoundaryService,
    private readonly identityAttestation: PublisherIdentityAttestationService,
    private readonly dispatchHealth: PublisherDispatchHealthService,
  ) {
    super();
  }

  async process(job: Job<PublisherPublicationWakeupJob>, token?: string): Promise<void> {
    if (!roleRunsPublisher(getAppRole()) || process.env.APP_SERVICE_NAME !== 'api-publisher') {
      throw new Error('Publisher publication wakeup queue may only be consumed by api-publisher');
    }
    const data = this.readJobData(job.data);
    if (job.name !== PUBLISHER_PUBLICATION_WAKEUP_JOB || job.id !== data.idempotencyKey) {
      throw new Error('Publisher publication wakeup job identity is invalid');
    }
    const createdAtMs = Date.parse(data.createdAt);
    const queuedAtMs = Number.isFinite(createdAtMs) ? createdAtMs : job.timestamp;
    if (Date.now() - queuedAtMs >= PUBLISHER_PUBLICATION_WAKEUP_JOB_TTL_MS) {
      return;
    }

    // FLAG: A disabled Publisher must not materialize publication work. Delay this durable signal
    // before any database scan; the ordinary 15-second scanner remains the recovery fallback.
    await assertPublisherRuntimeEnabledOrDelay(this.runtimeBoundary, job, token);
    await assertPublisherIdentityOrDelay(this.identityAttestation, job, token);
    await assertPublisherDispatchAllowedOrDelay(this.dispatchHealth, job, token);

    await this.publicationService.processPublisherPublicationWake(data.publicationId, {
      allowPastScheduled: data.reason === 'retry' || data.reason === 'resolution',
      occurrenceId: data.occurrenceId ?? undefined,
    });
    await this.publicationRunner.wakeAfterPublicationMaterialization(
      data.publicationId,
      data.occurrenceId ?? undefined,
    );
  }

  private readJobData(data: unknown): PublisherPublicationWakeupJob {
    const value =
      typeof data === 'object' && data !== null
        ? (data as Partial<PublisherPublicationWakeupJob>)
        : null;
    if (
      value?.version !== 1 ||
      value.kind !== 'materialize_publication' ||
      typeof value.publicationId !== 'string' ||
      !value.publicationId.trim() ||
      !('occurrenceId' in value) ||
      (value.occurrenceId !== null &&
        (typeof value.occurrenceId !== 'string' || !value.occurrenceId.trim())) ||
      !value.reason ||
      !WAKEUP_REASONS.has(value.reason) ||
      typeof value.idempotencyKey !== 'string' ||
      !value.idempotencyKey.trim() ||
      value.retryPolicyName !== 'publisher-publication-wakeup' ||
      typeof value.createdAt !== 'string' ||
      !Number.isFinite(Date.parse(value.createdAt))
    ) {
      throw new Error('Publisher publication wakeup job is invalid');
    }
    const requiresOccurrence = value.reason === 'retry' || value.reason === 'resolution';
    if (requiresOccurrence !== Boolean(value.occurrenceId)) {
      throw new Error('Publisher publication wakeup occurrence scope is invalid');
    }
    return value as PublisherPublicationWakeupJob;
  }
}
