import { Module } from '@nestjs/common';
import { RuntimeCoreModule } from '../runtime/runtime-core.module';
import { MessageRetentionModule } from './message-retention.module';

// FLAG: Retention keeps its complete admission, governor and delete-guard dependency graph.
// Do not import the full HTTP/moderation/publisher root merely to satisfy a global provider.
@Module({ imports: [RuntimeCoreModule, MessageRetentionModule] })
export class MessageRetentionAppModule {}
