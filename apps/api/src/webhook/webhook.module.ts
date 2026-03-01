import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { WebhookController } from './webhook.controller';
import { WebhookOutboxService } from './webhook-outbox.service';
import { WebhookParser } from './webhook.parser';
import { WebhookRateLimitService } from './webhook-rate-limit.service';
import { WebhookService } from './webhook.service';

@Module({
  imports: [BullModule.registerQueue({ name: 'moderation' })],
  controllers: [WebhookController],
  providers: [WebhookParser, WebhookService, WebhookRateLimitService, WebhookOutboxService],
  exports: [WebhookService],
})
export class WebhookModule {}
