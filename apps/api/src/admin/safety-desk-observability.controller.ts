import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { SafetyDeskAdminGuard } from './safety-desk-admin.guard';
import { SafetyDeskDeleteEvidenceService } from './safety-desk-delete-evidence.service';
import { SafetyDeskWebhookCohortService } from './safety-desk-webhook-cohort.service';
import { SafetyDeskPublicationCohortService } from './safety-desk-publication-cohort.service';

@Controller('v1/safety-desk/runtime')
@UseGuards(SafetyDeskAdminGuard)
export class SafetyDeskObservabilityController {
  constructor(
    private readonly webhookCohort: SafetyDeskWebhookCohortService,
    private readonly deleteEvidence: SafetyDeskDeleteEvidenceService,
    private readonly publicationCohort: SafetyDeskPublicationCohortService,
  ) {}

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
}
