import { Global, Module } from '@nestjs/common';
import { InitDataGuard } from './init-data.guard';
import { InitDataService } from './init-data.service';
import { MiniappAccessObservabilityService } from './miniapp-access-observability.service';
import { MiniappRequestSecurityService } from './miniapp-request-security.service';
import { MiniappSessionController } from './miniapp-session.controller';
import { MiniappSessionService } from './miniapp-session.service';
import { MINIAPP_SESSION_AUTHORITY } from './miniapp-session-authority';
import { MiniappProfileGuard } from './miniapp-profile.guard';
import { PublisherInitDataKeyService } from './publisher-init-data-key.service';

@Global()
@Module({
  controllers: [MiniappSessionController],
  providers: [
    InitDataService,
    InitDataGuard,
    MiniappAccessObservabilityService,
    MiniappRequestSecurityService,
    MiniappSessionService,
    { provide: MINIAPP_SESSION_AUTHORITY, useExisting: MiniappSessionService },
    MiniappProfileGuard,
    PublisherInitDataKeyService,
  ],
  exports: [
    InitDataService,
    InitDataGuard,
    MiniappAccessObservabilityService,
    MiniappRequestSecurityService,
    MiniappSessionService,
    MINIAPP_SESSION_AUTHORITY,
    MiniappProfileGuard,
    PublisherInitDataKeyService,
  ],
})
export class AuthModule {}
