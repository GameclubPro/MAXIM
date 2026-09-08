import { MODULE_METADATA } from '@nestjs/common/constants';

import { AdminModule } from '../admin/admin.module';
import { MaxModule } from '../max/max.module';
import { SystemModule } from '../system/system.module';
import { ModerationDeleteIntentModule } from './moderation-delete-intent.module';
import { ModerationDeleteIntentService } from './moderation-delete-intent.service';
import { ModerationModule } from './moderation.module';
import { ParticipantModerationImmunityService } from './participant-moderation-immunity.service';
import { PhotoDuplicateRuntimePolicyService } from './photo-duplicate/photo-duplicate-runtime-policy.service';
import { CommercialOcrRuntimePolicyService } from './commercial-ocr/commercial-ocr-runtime-policy.service';
import { ProfanityDeleteGuardService } from './profanity/profanity-delete-guard.service';
import { RuleEngineModule } from './rule-engine.module';
import { RuleEngineService } from './rule-engine.service';

function readModuleMetadata(moduleType: unknown, key: string): unknown[] {
  return (Reflect.getMetadata(key, moduleType as object) as unknown[] | undefined) ?? [];
}

describe('ModerationDeleteIntentModule', () => {
  it('owns and exports the delete-intent provider without duplicate domain providers', () => {
    const intentImports = readModuleMetadata(ModerationDeleteIntentModule, MODULE_METADATA.IMPORTS);
    const intentProviders = readModuleMetadata(
      ModerationDeleteIntentModule,
      MODULE_METADATA.PROVIDERS,
    );
    const intentExports = readModuleMetadata(ModerationDeleteIntentModule, MODULE_METADATA.EXPORTS);
    const moderationProviders = readModuleMetadata(ModerationModule, MODULE_METADATA.PROVIDERS);
    const moderationImports = readModuleMetadata(ModerationModule, MODULE_METADATA.IMPORTS);
    const adminProviders = readModuleMetadata(AdminModule, MODULE_METADATA.PROVIDERS);
    const adminImports = readModuleMetadata(AdminModule, MODULE_METADATA.IMPORTS);

    expect(intentImports).toContain(MaxModule);
    expect(intentImports).toContain(RuleEngineModule);
    expect(moderationImports).toContain(RuleEngineModule);
    expect(intentProviders).toContain(ModerationDeleteIntentService);
    expect(intentProviders).toContain(ParticipantModerationImmunityService);
    expect(intentProviders).toContain(ProfanityDeleteGuardService);
    expect(intentProviders).toContain(CommercialOcrRuntimePolicyService);
    expect(intentProviders).toContain(PhotoDuplicateRuntimePolicyService);
    expect(intentExports).toContain(ModerationDeleteIntentService);
    expect(intentExports).toContain(ParticipantModerationImmunityService);
    expect(intentExports).toContain(ProfanityDeleteGuardService);
    expect(intentExports).toContain(CommercialOcrRuntimePolicyService);
    expect(intentExports).toContain(PhotoDuplicateRuntimePolicyService);
    expect(moderationImports).toContain(ModerationDeleteIntentModule);
    expect(adminImports).toContain(ModerationDeleteIntentModule);
    expect(moderationProviders).not.toContain(ModerationDeleteIntentService);
    expect(adminProviders).not.toContain(ModerationDeleteIntentService);
    expect(intentProviders).not.toContain(RuleEngineService);
    expect(moderationProviders).not.toContain(RuleEngineService);
    expect(readModuleMetadata(RuleEngineModule, MODULE_METADATA.PROVIDERS)).toContain(
      RuleEngineService,
    );
    expect(readModuleMetadata(RuleEngineModule, MODULE_METADATA.EXPORTS)).toContain(
      RuleEngineService,
    );
    expect(readModuleMetadata(RuleEngineModule, MODULE_METADATA.IMPORTS)).toContain(SystemModule);
  });
});
