import type { MaxBotChat } from '../max/max-client.service';
import { readTrimmedString, fromPrismaEntityType } from './admin-legacy-utils';
import type {
  ManagedBotChatCatalogSnapshotRow,
  ManagedEntitiesDiscoverySnapshot,
} from './admin.service.support';

export function mergeManagedBotChatCatalogRows(
  rows: readonly ManagedBotChatCatalogSnapshotRow[],
  normalizeBotId: (botId: string | null | undefined) => string | null,
): ManagedEntitiesDiscoverySnapshot {
  const byChatId = new Map<string, MaxBotChat>();
  for (const row of rows) {
    const chatId = readTrimmedString(row.chatId);
    const botId = normalizeBotId(row.botId);
    if (!chatId || !botId) {
      continue;
    }

    const lastEventTimeNumber =
      row.lastEventTime !== null ? Number.parseInt(row.lastEventTime, 10) : Number.NaN;
    const existing = byChatId.get(chatId);
    if (existing) {
      existing.botIds = Array.from(new Set([...(existing.botIds ?? []), botId]));
      if (!existing.botId) {
        existing.botId = botId;
      }
      continue;
    }

    byChatId.set(chatId, {
      chatId,
      title: readTrimmedString(row.title),
      link: readTrimmedString(row.link),
      avatarUrl: readTrimmedString(row.avatarUrl),
      entityType: fromPrismaEntityType(row.entityType),
      lastEventTime: Number.isFinite(lastEventTimeNumber) ? lastEventTimeNumber : null,
      botId,
      botIds: [botId],
    });
  }

  return [...byChatId.values()];
}
