import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validateEnv } from '../config/env.schema';
import { MaxBotContextService } from '../max/max-bot-context.service';
import { MaxBotLinkService } from '../max/max-bot-link.service';
import { MaxBotRegistryService } from '../max/max-bot-registry.service';
import { MaxClientService } from '../max/max-client.service';
import { RedisCounterModule } from '../moderation/redis-counter.module';
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
    PrismaModule,
    RedisCounterModule,
  ],
  providers: [
    MaxBotRegistryService,
    MaxBotContextService,
    MaxBotLinkService,
    ActionHealthService,
    MaxClientService,
  ],
})
export class VkParsingAccessEvidenceRefreshModule {}
