import { Processor, WorkerHost } from '@nestjs/bullmq';
import { DelayedError, type Job } from 'bullmq';
import { getAppRole, roleRunsAction } from '../runtime/app-role';
import {
  ADMIN_MANAGED_ENTITIES_REFRESH_JOB_TTL_MS,
  ADMIN_MANAGED_ENTITIES_REFRESH_QUEUE,
  resolveAdminManagedEntitiesRefreshJitterMs,
  type AdminManagedEntitiesRefreshJob,
} from './admin-managed-entities-refresh.queue';
import { ManagedEntitiesDiscoveryService } from './managed-entities-discovery.service';
import { ManagedEntityPresentationService } from './managed-entity-presentation.service';

@Processor(ADMIN_MANAGED_ENTITIES_REFRESH_QUEUE, {
  concurrency: 1,
})
export class AdminManagedEntitiesRefreshProcessor extends WorkerHost {
  constructor(
    private readonly managedEntitiesDiscoveryService: ManagedEntitiesDiscoveryService,
    private readonly presentation: ManagedEntityPresentationService,
  ) {
    super();
  }

  async process(job: Job<AdminManagedEntitiesRefreshJob>) {
    if (!roleRunsAction(getAppRole())) {
      return;
    }

    const envelopeCreatedAtMs = Date.parse(job.data.createdAt ?? '');
    const queuedAtMs = Number.isFinite(envelopeCreatedAtMs) ? envelopeCreatedAtMs : job.timestamp;
    if (
      typeof queuedAtMs === 'number' &&
      Number.isFinite(queuedAtMs) &&
      Date.now() - queuedAtMs >= ADMIN_MANAGED_ENTITIES_REFRESH_JOB_TTL_MS
    ) {
      return;
    }

    if (job.data.presentationEntityId) {
      await this.presentation.process(job.data);
      return;
    }

    const outcome = await this.managedEntitiesDiscoveryService.processManagedEntitiesRefreshJob(
      job.data,
    );
    if (!outcome) {
      return;
    }

    const jobId =
      String(job.id ?? '').trim() ||
      `managed-entities-refresh__${job.data.entityType}__${job.data.userId}`;
    const jitterMs = resolveAdminManagedEntitiesRefreshJitterMs(jobId, 'defer');
    await job.moveToDelayed(
      Date.now() + Math.max(0, outcome.continueAfterMs) + jitterMs,
      job.token,
    );
    throw new DelayedError();
  }
}
