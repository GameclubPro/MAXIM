import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ChatContextModule } from '../chat-context/chat-context.module';
import { MaxModule } from '../max/max.module';
import { SystemModule } from '../system/system.module';
import { WebhookController } from './webhook.controller';
import { WebhookIngestionService } from './webhook-ingestion.service';
import { WebhookOutboxService } from './webhook-outbox.service';
import { WebhookParser } from './webhook.parser';
import { ALL_WEBHOOK_QUEUE_NAMES } from './webhook-queues';
import { WebhookRoutingService } from './webhook-routing.service';
import { WebhookRateLimitService } from './webhook-rate-limit.service';
import { WebhookService } from './webhook.service';

@Module({
  imports: [
    BullModule.registerQueue(...ALL_WEBHOOK_QUEUE_NAMES.map((name) => ({ name }))),
    ChatContextModule,
    MaxModule,
    SystemModule,
  ],
  controllers: [WebhookController],
  providers: [
    WebhookParser,
    WebhookIngestionService,
    WebhookService,
    WebhookRateLimitService,
    WebhookRoutingService,
    WebhookOutboxService,
  ],
  exports: [WebhookIngestionService, WebhookService],
})
export class WebhookModule {}
