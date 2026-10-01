import { Module } from '@nestjs/common';
import { AdminModule } from './admin/admin.module';
import { HealthModule } from './health/health.module';
import { MaxModule } from './max/max.module';
import { ModerationModule } from './moderation/moderation.module';
import { PublisherModule } from './publisher/publisher.module';
import { SystemModule } from './system/system.module';
import { WebhookModule } from './webhook/webhook.module';
import { MessageRetentionModule } from './message-retention/message-retention.module';
import { RuntimeCoreModule } from './runtime/runtime-core.module';

@Module({
  imports: [
    RuntimeCoreModule,
    MaxModule,
    ModerationModule,
    WebhookModule,
    MessageRetentionModule,
    AdminModule,
    SystemModule,
    HealthModule,
    PublisherModule,
  ],
})
export class AppModule {}
