jest.mock('../config/env.schema', () => ({
  validateEnv: jest.fn((environment: Record<string, unknown>) => environment),
}));

import { MODULE_METADATA } from '@nestjs/common/constants';
import { AdminModule } from '../admin/admin.module';
import { AppModule } from '../app.module';
import { MaxBotModule } from '../max/max-bot.module';
import { MaxClientService } from '../max/max-client.service';
import { MaxModule } from '../max/max.module';
import { ModerationModule } from '../moderation/moderation.module';
import { SystemModule } from '../system/system.module';
import { PublicationDeliveryVerificationAuditModule } from './publication-delivery-verification-audit.module';

describe('PublicationDeliveryVerificationAuditModule', () => {
  it('keeps runtime modules and background lifecycle providers out of the audit CLI', () => {
    const imports = Reflect.getMetadata(
      MODULE_METADATA.IMPORTS,
      PublicationDeliveryVerificationAuditModule,
    ) as unknown[];
    const providers = Reflect.getMetadata(
      MODULE_METADATA.PROVIDERS,
      PublicationDeliveryVerificationAuditModule,
    ) as unknown[];

    for (const runtimeModule of [
      AppModule,
      AdminModule,
      MaxBotModule,
      MaxModule,
      ModerationModule,
      SystemModule,
    ]) {
      expect(imports).not.toContain(runtimeModule);
    }
    expect(providers).toContain(MaxClientService);
  });
});
