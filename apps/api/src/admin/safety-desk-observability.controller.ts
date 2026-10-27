import { Controller, Get, Inject, Param, UseGuards } from '@nestjs/common';
import { SafetyDeskCommercialAiService } from './safety-desk-commercial-ai.service';
import { SafetyDeskAdminGuard } from './safety-desk-admin.guard';
import { SafetyDeskDeleteEvidenceService } from './safety-desk-delete-evidence.service';
import { SafetyDeskWebhookCohortService } from './safety-desk-webhook-cohort.service';
import { SafetyDeskPublicationCohortService } from './safety-desk-publication-cohort.service';
import { SafetyDeskDeleteCohortService } from './safety-desk-delete-cohort.service';
import { SafetyDeskPublicationDeliveryCohortService } from './safety-desk-publication-delivery-cohort.service';
import { SafetyDeskPublicationDeliveryEvidenceService } from './safety-desk-publication-delivery-evidence.service';

@Controller('v1/safety-desk/runtime')
@UseGuards(SafetyDeskAdminGuard)
export class SafetyDeskObservabilityController {
  constructor(
    @Inject(SafetyDeskWebhookCohortService)
    private readonly webhookCohort: Pick<SafetyDeskWebhookCohortService, 'getSnapshot'>,
    @Inject(SafetyDeskDeleteEvidenceService)
    private readonly deleteEvidence: Pick<SafetyDeskDeleteEvidenceService, 'getEvidence'>,
    @Inject(SafetyDeskPublicationCohortService)
    private readonly publicationCohort: Pick<SafetyDeskPublicationCohortService, 'getSnapshot'>,
    @Inject(SafetyDeskDeleteCohortService)
    private readonly deleteCohort: Pick<SafetyDeskDeleteCohortService, 'getSnapshot'>,
    @Inject(SafetyDeskPublicationDeliveryCohortService)
    private readonly publicationDeliveryCohort: Pick<
      SafetyDeskPublicationDeliveryCohortService,
      'getSnapshot'
    >,
    @Inject(SafetyDeskPublicationDeliveryEvidenceService)
    private readonly publicationDeliveryEvidence: Pick<
      SafetyDeskPublicationDeliveryEvidenceService,
      'getEvidence'
    >,
    @Inject(SafetyDeskCommercialAiService)
    private readonly commercialAi: Pick<SafetyDeskCommercialAiService, 'getSnapshot'>,
  ) {}

  @Get('commercial-ai')
  getCommercialAi() {
    return this.commercialAi.getSnapshot();
  }

  @Get('webhook-cohort')
  getWebhookCohort() {
    return this.webhookCohort.getSnapshot();
  }

  @Get('publication-cohort')
  getPublicationCohort() {
    return this.publicationCohort.getSnapshot();
  }

  @Get('deletes/:intentId/evidence')
  getDeleteEvidence(@Param('intentId') intentId: string) {
    return this.deleteEvidence.getEvidence(intentId);
  }

  @Get('delete-cohort')
  getDeleteCohort() {
    return this.deleteCohort.getSnapshot();
  }

  @Get('publication-delivery-cohort')
  getPublicationDeliveryCohort() {
    return this.publicationDeliveryCohort.getSnapshot();
  }

  @Get('publication-deliveries/:deliveryId/evidence')
  getPublicationDeliveryEvidence(@Param('deliveryId') deliveryId: string) {
    return this.publicationDeliveryEvidence.getEvidence(deliveryId);
  }
}
