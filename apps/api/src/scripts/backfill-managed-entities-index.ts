import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppModule } from '../app.module';
import { MaxChatAdminRosterSyncService } from '../max/max-chat-admin-roster-sync.service';

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, {
    bufferLogs: true,
  });
  app.useLogger(app.get(Logger));

  try {
    const logger = app.get(Logger);
    const service = app.get(MaxChatAdminRosterSyncService);
    const bypassCache = process.argv.includes('--bypass-cache');
    const allowRemoteListBotChats = process.argv.includes('--remote-list-bot-chats');
    const result = await service.backfillManagedEntitiesIndex({
      ...(bypassCache ? { bypassCache: true } : {}),
      ...(allowRemoteListBotChats ? { allowRemoteListBotChats: true } : {}),
    });

    logger.log(
      {
        bypassCache,
        allowRemoteListBotChats,
        discoveredChats: result.discoveredChats,
        syncedChats: result.syncedChats,
      },
      'Managed entities backfill completed',
    );
  } finally {
    await app.close();
  }
}

void main();
