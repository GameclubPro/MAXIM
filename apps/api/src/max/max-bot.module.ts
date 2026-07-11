import { Global, Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { MaxBotContextService } from './max-bot-context.service';
import { MaxBotOwnershipFoundationService } from './max-bot-ownership-foundation.service';
import { MaxBotLinkService } from './max-bot-link.service';
import { MaxBotRegistryService } from './max-bot-registry.service';
import { ChatRoutingReconcileService } from './chat-routing-reconcile.service';

@Global()
@Module({
  imports: [PrismaModule],
  providers: [
    MaxBotRegistryService,
    MaxBotContextService,
    MaxBotLinkService,
    MaxBotOwnershipFoundationService,
    ChatRoutingReconcileService,
  ],
  exports: [
    MaxBotRegistryService,
    MaxBotContextService,
    MaxBotLinkService,
    MaxBotOwnershipFoundationService,
    ChatRoutingReconcileService,
  ],
})
export class MaxBotModule {}
