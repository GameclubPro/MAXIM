import { Global, Module } from '@nestjs/common';
import { NightModeTransitionModule } from '../moderation/night-mode-transition.module';
import { PrismaModule } from '../prisma/prisma.module';
import { MaxBotContextService } from './max-bot-context.service';
import { MaxBotOwnershipFoundationService } from './max-bot-ownership-foundation.service';
import { MaxBotLinkService } from './max-bot-link.service';
import { MaxBotRegistryService } from './max-bot-registry.service';
import { ChatRoutingReconcileService } from './chat-routing-reconcile.service';
import { ModerationDeleteIntentAccessWakeService } from './moderation-delete-intent-access-wake.service';
import { PublisherWebhookCredentialService } from '../publisher/publisher-webhook-credential.service';

@Global()
@Module({
  imports: [PrismaModule, NightModeTransitionModule],
  providers: [
    MaxBotRegistryService,
    MaxBotContextService,
    ModerationDeleteIntentAccessWakeService,
    MaxBotLinkService,
    MaxBotOwnershipFoundationService,
    ChatRoutingReconcileService,
    PublisherWebhookCredentialService,
  ],
  exports: [
    MaxBotRegistryService,
    MaxBotContextService,
    MaxBotLinkService,
    MaxBotOwnershipFoundationService,
    ChatRoutingReconcileService,
    PublisherWebhookCredentialService,
  ],
})
export class MaxBotModule {}
