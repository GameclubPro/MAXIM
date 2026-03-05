import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { ChatContextCacheService } from './chat-context-cache.service';

@Module({
  imports: [PrismaModule],
  providers: [ChatContextCacheService],
  exports: [ChatContextCacheService],
})
export class ChatContextModule {}
