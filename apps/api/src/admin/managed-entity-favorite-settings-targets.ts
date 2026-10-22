import type { ManagedEntityFavoriteType } from '@maxim/contracts';
import { ChatEntityType, type ManagedEntityFavorite, type Prisma } from '../prisma/prisma-client';
import { canonicalManagedEntityFavoriteType } from './managed-entity-favorites-writer';

export type CanonicalFavoriteSettingsDatabase = {
  managedEntityFavorite: {
    findMany: (
      args: Pick<Prisma.ManagedEntityFavoriteFindManyArgs, 'where' | 'orderBy'> & {
        select: { chatId: true; favoriteType: true };
      },
    ) => Promise<Array<Pick<ManagedEntityFavorite, 'chatId' | 'favoriteType'>>>;
  };
};

export async function listCanonicalFavoriteChatIdsForSettingsTarget(
  db: CanonicalFavoriteSettingsDatabase,
  userId: string,
  favoriteTypes: readonly ManagedEntityFavoriteType[],
): Promise<string[]> {
  if (favoriteTypes.length === 0) return [];

  const rows = await db.managedEntityFavorite.findMany({
    where: { userId, entityType: ChatEntityType.CHAT },
    orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
    select: { chatId: true, favoriteType: true },
  });
  const rowsByChatId = new Map<string, typeof rows>();
  for (const row of rows) {
    const group = rowsByChatId.get(row.chatId);
    if (group) group.push(row);
    else rowsByChatId.set(row.chatId, [row]);
  }

  const selected = new Set(favoriteTypes);
  const chatIds: string[] = [];
  for (const [chatId, group] of rowsByChatId) {
    const favoriteType = canonicalManagedEntityFavoriteType(group);
    if (favoriteType !== null && selected.has(favoriteType)) chatIds.push(chatId);
  }
  return chatIds;
}
