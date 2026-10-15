import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validateEnv } from '../config/env.schema';
import { MaxBotRegistryService } from '../max/max-bot-registry.service';
import { FixedModeratorPreservationService } from '../max/fixed-moderator-preservation.service';
import { PrismaModule } from '../prisma/prisma.module';

// FLAG: This operator context has no HTTP server, MAX client, workers or schedulers.
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv, expandVariables: true }),
    PrismaModule,
  ],
  providers: [MaxBotRegistryService, FixedModeratorPreservationService],
})
export class FixedModeratorPreservationModule {}
