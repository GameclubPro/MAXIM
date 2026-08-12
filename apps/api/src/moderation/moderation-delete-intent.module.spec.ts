import { MODULE_METADATA } from '@nestjs/common/constants';

import { AdminModule } from '../admin/admin.module';
import { MaxModule } from '../max/max.module';
import { ModerationDeleteIntentModule } from './moderation-delete-intent.module';
import { ModerationDeleteIntentService } from './moderation-delete-intent.service';
import { ModerationModule } from './moderation.module';
import { ParticipantModerationImmunityService } from './participant-moderation-immunity.service';
import { PhotoDuplicateRuntimePolicyService } from './photo-duplicate/photo-duplicate-runtime-policy.service';

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
    expect(intentProviders).toContain(ModerationDeleteIntentService);
    expect(intentProviders).toContain(ParticipantModerationImmunityService);
    expect(intentProviders).toContain(PhotoDuplicateRuntimePolicyService);
    expect(intentExports).toContain(ModerationDeleteIntentService);
    expect(intentExports).toContain(ParticipantModerationImmunityService);
    expect(intentExports).toContain(PhotoDuplicateRuntimePolicyService);
    expect(moderationImports).toContain(ModerationDeleteIntentModule);
    expect(adminImports).toContain(ModerationDeleteIntentModule);
    expect(moderationProviders).not.toContain(ModerationDeleteIntentService);
    expect(adminProviders).not.toContain(ModerationDeleteIntentService);
  });
});
