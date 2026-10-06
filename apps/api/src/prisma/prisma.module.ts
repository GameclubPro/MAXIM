import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { WebhookLegacyHoldService } from '../webhook/webhook-legacy-hold.service';

@Global()
@Module({
  providers: [PrismaService, WebhookLegacyHoldService],
  exports: [PrismaService, WebhookLegacyHoldService],
})
export class PrismaModule {}
