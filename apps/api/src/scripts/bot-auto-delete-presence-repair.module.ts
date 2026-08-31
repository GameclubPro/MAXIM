import { HttpModule } from '@nestjs/axios';
import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';

import { validateEnv } from '../config/env.schema';
import { MaxBotContextService } from '../max/max-bot-context.service';
import { MaxBotLinkService } from '../max/max-bot-link.service';
import { MaxBotRegistryService } from '../max/max-bot-registry.service';
import { MaxClientService } from '../max/max-client.service';
import { ModerationDeleteIntentAccessWakeService } from '../max/moderation-delete-intent-access-wake.service';
import { CommercialOcrDeleteGuardService } from '../moderation/commercial-ocr/commercial-ocr-delete-guard.service';
import { CommercialOcrRuntimePolicyService } from '../moderation/commercial-ocr/commercial-ocr-runtime-policy.service';
import { LinkHistoryDeleteGuardService } from '../moderation/link-history-delete-guard.service';
import { MODERATION_DELETE_INTENT_QUEUE } from '../moderation/moderation-delete-intent.queue';
import { ModerationDeleteIntentService } from '../moderation/moderation-delete-intent.service';
import { ParticipantModerationImmunityService } from '../moderation/participant-moderation-immunity.service';
import { PhotoDuplicateRuntimePolicyService } from '../moderation/photo-duplicate/photo-duplicate-runtime-policy.service';
import { PrismaModule } from '../prisma/prisma.module';
import { ActionHealthService } from '../system/action-health.service';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnv,
      expandVariables: true,
    }),
    HttpModule.register({ timeout: 5_000, maxRedirects: 0 }),
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: {
          url: config.getOrThrow<string>('REDIS_URL'),
        },
      }),
    }),
    BullModule.registerQueue({ name: MODERATION_DELETE_INTENT_QUEUE }),
    PrismaModule,
  ],
  providers: [
    MaxBotRegistryService,
    MaxBotContextService,
    ModerationDeleteIntentAccessWakeService,
    MaxBotLinkService,
    ActionHealthService,
    MaxClientService,
    LinkHistoryDeleteGuardService,
    ParticipantModerationImmunityService,
    CommercialOcrRuntimePolicyService,
    CommercialOcrDeleteGuardService,
    PhotoDuplicateRuntimePolicyService,
    ModerationDeleteIntentService,
  ],
})
export class BotAutoDeletePresenceRepairModule {}
