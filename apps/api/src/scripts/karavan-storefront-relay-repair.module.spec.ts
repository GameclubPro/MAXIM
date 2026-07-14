jest.mock('../config/env.schema', () => ({
  validateEnv: jest.fn((environment: Record<string, unknown>) => environment),
}));

import { MODULE_METADATA } from '@nestjs/common/constants';
import { AdminModule } from '../admin/admin.module';
import { KaravanStorefrontRelayModule } from '../integrations/karavan-storefront/karavan-storefront-relay.module';
import { MaxBotModule } from '../max/max-bot.module';
import { MaxBotOwnershipFoundationService } from '../max/max-bot-ownership-foundation.service';
import { MaxModule } from '../max/max.module';
import { ModerationModule } from '../moderation/moderation.module';
import { SystemModule } from '../system/system.module';
import { KaravanStorefrontRelayRepairModule } from './karavan-storefront-relay-repair.module';

describe('KaravanStorefrontRelayRepairModule', () => {
  it('keeps full runtime modules and their background lifecycle providers out of the repair CLI', () => {
    const imports = Reflect.getMetadata(
      MODULE_METADATA.IMPORTS,
      KaravanStorefrontRelayRepairModule,
    ) as unknown[];
    const providers = Reflect.getMetadata(
      MODULE_METADATA.PROVIDERS,
      KaravanStorefrontRelayRepairModule,
    ) as unknown[];

    for (const runtimeModule of [
      AdminModule,
      KaravanStorefrontRelayModule,
      MaxBotModule,
      MaxModule,
      ModerationModule,
      SystemModule,
    ]) {
      expect(imports).not.toContain(runtimeModule);
    }
    expect(providers).not.toContain(MaxBotOwnershipFoundationService);
  });
});
