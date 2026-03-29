import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { MaxModule } from '../max/max.module';
import { WebhookController } from './webhook.controller';
import { WebhookOutboxService } from './webhook-outbox.service';
import { WebhookParser } from './webhook.parser';
import { ALL_WEBHOOK_QUEUE_NAMES } from './webhook-queues';
import { WebhookRateLimitService } from './webhook-rate-limit.service';
import { WebhookService } from './webhook.service';

@Module({
  imports: [
    BullModule.registerQueue(...ALL_WEBHOOK_QUEUE_NAMES.map((name) => ({ name }))),
    MaxModule,
  ],
  controllers: [WebhookController],
  providers: [WebhookParser, WebhookService, WebhookRateLimitService, WebhookOutboxService],
  exports: [WebhookService],
})
export class WebhookModule {}
