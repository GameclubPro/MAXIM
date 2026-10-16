import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { SafetyDeskAdminGuard } from './safety-desk-admin.guard';
import { SafetyDeskObservabilityController } from './safety-desk-observability.controller';
import type { SafetyDeskWebhookCohortService } from './safety-desk-webhook-cohort.service';
import type { SafetyDeskDeleteEvidenceService } from './safety-desk-delete-evidence.service';

describe('closed observation routes', () => {
  it('keeps bounded evidence reads behind the owner guard and exposes only GET', () => {
    const getSnapshot = jest.fn<
      ReturnType<SafetyDeskWebhookCohortService['getSnapshot']>,
      Parameters<SafetyDeskWebhookCohortService['getSnapshot']>
    >();
    const getEvidence = jest.fn<
      ReturnType<SafetyDeskDeleteEvidenceService['getEvidence']>,
      Parameters<SafetyDeskDeleteEvidenceService['getEvidence']>
    >();
    const cohort = { getSnapshot } satisfies Pick<SafetyDeskWebhookCohortService, 'getSnapshot'>;
    const evidence = { getEvidence } satisfies Pick<SafetyDeskDeleteEvidenceService, 'getEvidence'>;
    const controller = new SafetyDeskObservabilityController(
      cohort as unknown as SafetyDeskWebhookCohortService,
      evidence as unknown as SafetyDeskDeleteEvidenceService,
    );
    expect(Reflect.getMetadata(GUARDS_METADATA, SafetyDeskObservabilityController)).toContain(
      SafetyDeskAdminGuard,
    );
    expect(Reflect.getMetadata(PATH_METADATA, SafetyDeskObservabilityController)).toBe(
      'v1/safety-desk/runtime',
    );
    expect(Reflect.getMetadata(METHOD_METADATA, controller.getWebhookCohort)).toBe(
      RequestMethod.GET,
    );
    expect(Reflect.getMetadata(METHOD_METADATA, controller.getDeleteEvidence)).toBe(
      RequestMethod.GET,
    );
    expect(Reflect.getMetadata(PATH_METADATA, controller.getDeleteEvidence)).toBe(
      'deletes/:intentId/evidence',
    );
    controller.getWebhookCohort();
    controller.getDeleteEvidence('exact-intent');
    expect(getSnapshot).toHaveBeenCalledTimes(1);
    expect(getEvidence).toHaveBeenCalledTimes(1);
    expect(getEvidence).toHaveBeenCalledWith('exact-intent');
  });
});
