import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppModule } from '../app.module';
import { MaxChatAdminRosterSyncService } from '../max/max-chat-admin-roster-sync.service';

const REMOTE_LIST_BOT_CHATS_UNSUPPORTED_IN_PRODUCTION =
  'Remote MAX GET /chats backfill is not supported in production; use the webhook/subscription managed chat catalog instead. See https://dev.max.ru/docs-api/methods/GET/chats';

async function main() {
  const bypassCache = process.argv.includes('--bypass-cache');
  const allowRemoteListBotChats = process.argv.includes('--remote-list-bot-chats');

  if (
    allowRemoteListBotChats &&
    String(process.env.NODE_ENV ?? '')
      .trim()
      .toLowerCase() === 'production'
  ) {
    throw new Error(REMOTE_LIST_BOT_CHATS_UNSUPPORTED_IN_PRODUCTION);
  }

  const app = await NestFactory.createApplicationContext(AppModule, {
    bufferLogs: true,
  });
  app.useLogger(app.get(Logger));

  try {
    const logger = app.get(Logger);
    const service = app.get(MaxChatAdminRosterSyncService);
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
