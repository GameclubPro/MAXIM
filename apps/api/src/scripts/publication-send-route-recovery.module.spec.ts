jest.mock('../config/env.schema', () => ({
  validateEnv: jest.fn((environment: Record<string, unknown>) => environment),
}));

import { MODULE_METADATA } from '@nestjs/common/constants';
import { AdminModule } from '../admin/admin.module';
import { MaxBotLinkService } from '../max/max-bot-link.service';
import { MaxBotRegistryService } from '../max/max-bot-registry.service';
import { MaxClientService } from '../max/max-client.service';
import { MaxModule } from '../max/max.module';
import { ModerationModule } from '../moderation/moderation.module';
import { SystemModule } from '../system/system.module';
import { PublicationSendRouteRecoveryModule } from './publication-send-route-recovery.module';

describe('PublicationSendRouteRecoveryModule', () => {
  it('keeps live MAX and background runtime providers out of the recovery CLI', () => {
    const imports = Reflect.getMetadata(
      MODULE_METADATA.IMPORTS,
      PublicationSendRouteRecoveryModule,
    ) as unknown[];
    const providers = Reflect.getMetadata(
      MODULE_METADATA.PROVIDERS,
      PublicationSendRouteRecoveryModule,
    ) as unknown[];

    for (const runtimeModule of [AdminModule, MaxModule, ModerationModule, SystemModule]) {
      expect(imports).not.toContain(runtimeModule);
    }
    expect(providers).toContain(MaxBotRegistryService);
    expect(providers).not.toContain(MaxBotLinkService);
    expect(providers).not.toContain(MaxClientService);
  });
});
