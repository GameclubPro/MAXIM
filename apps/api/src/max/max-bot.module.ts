import { Global, Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { MaxBotContextService } from './max-bot-context.service';
import { MaxBotOwnershipFoundationService } from './max-bot-ownership-foundation.service';
import { MaxBotLinkService } from './max-bot-link.service';
import { MaxBotRegistryService } from './max-bot-registry.service';

@Global()
@Module({
  imports: [PrismaModule],
  providers: [
    MaxBotRegistryService,
    MaxBotContextService,
    MaxBotLinkService,
    MaxBotOwnershipFoundationService,
  ],
  exports: [
    MaxBotRegistryService,
    MaxBotContextService,
    MaxBotLinkService,
    MaxBotOwnershipFoundationService,
  ],
})
export class MaxBotModule {}
