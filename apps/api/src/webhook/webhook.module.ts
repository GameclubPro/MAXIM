import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ModerationModule } from '../moderation/moderation.module';
import { WebhookController } from './webhook.controller';
import { WebhookParser } from './webhook.parser';
import { WebhookRateLimitService } from './webhook-rate-limit.service';
import { WebhookService } from './webhook.service';

@Module({
  imports: [BullModule.registerQueue({ name: 'moderation' }), ModerationModule],
  controllers: [WebhookController],
  providers: [WebhookParser, WebhookService, WebhookRateLimitService],
  exports: [WebhookService],
})
export class WebhookModule {}
