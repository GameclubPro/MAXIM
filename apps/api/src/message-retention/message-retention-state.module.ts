import { Module } from '@nestjs/common';
import { MessageRetentionStore } from './message-retention-store.service';

@Module({ providers: [MessageRetentionStore], exports: [MessageRetentionStore] })
export class MessageRetentionStateModule {}
