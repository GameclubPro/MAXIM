import { Injectable, OnModuleInit, OnModuleDestroy, Optional } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PublisherActionCredentialService } from './publisher-action-credential.service';
import { PublisherBackgroundWorkCoordinatorService } from './publisher-background-work-coordinator.service';
import { PublisherIdentityAttestationService } from './publisher-identity-attestation.service';
import { PublisherRuntimeBoundaryService } from './publisher-runtime-boundary.service';
import { PublisherEntityBindingLifecycleService } from './publisher-entity-binding-lifecycle.service';
import { PublisherBindingRefreshQueueService } from './publisher-binding-refresh.queue';
import { PublisherDispatchHealthService } from './publisher-dispatch-health.service';
import { PublisherAccessRefreshPolicy } from './publisher-access-refresh-policy';
import { PublisherAccessRefreshEvidenceService } from './publisher-access-refresh-evidence.service';

@Injectable()
export class PublisherBindingRefreshSchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly publisherBotId: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly refreshQueue: PublisherBindingRefreshQueueService,
    credentials: PublisherActionCredentialService,
    private readonly dispatchHealth: PublisherDispatchHealthService,
    private readonly identityAttestation: PublisherIdentityAttestationService,
    private readonly runtimeBoundary: PublisherRuntimeBoundaryService,
    private readonly backgroundWork: PublisherBackgroundWorkCoordinatorService,
    private readonly bindingLifecycle: PublisherEntityBindingLifecycleService,
    @Optional()
    private readonly policy: PublisherAccessRefreshPolicy = new PublisherAccessRefreshPolicy(),
    @Optional() private readonly evidence?: PublisherAccessRefreshEvidenceService,
  ) {
    this.publisherBotId = credentials.getBotId();
    // FLAG: Preserve the role credential boundary while retiring fleet permission scans.
    credentials.getRequiredActionToken(this.publisherBotId);
  }

  // FLAG: Permission renewals are demand-driven. Retain this injectable compatibility
  // boundary for existing role composition, but never enumerate the fleet at startup
  // or on a timer. Publication author preflight is owned by its separate scheduler.
  async onModuleInit(): Promise<void> {}
  onModuleDestroy(): void {}
  async scan(_reason: 'startup' | 'scheduled'): Promise<void> {}
}
