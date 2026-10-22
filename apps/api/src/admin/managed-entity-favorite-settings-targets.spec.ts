import type { ManagedEntityFavorite } from '../prisma/prisma-client';
import {
  listCanonicalFavoriteChatIdsForSettingsTarget,
  type CanonicalFavoriteSettingsDatabase,
} from './managed-entity-favorite-settings-targets';

type FavoriteDelegate = CanonicalFavoriteSettingsDatabase['managedEntityFavorite'];

function createDb(rows: ManagedEntityFavorite[]) {
  const findMany = jest.fn<
    ReturnType<FavoriteDelegate['findMany']>,
    Parameters<FavoriteDelegate['findMany']>
  >();
  findMany.mockResolvedValue(rows);
  const db: CanonicalFavoriteSettingsDatabase = {
    managedEntityFavorite: { findMany },
  };
  return { db, findMany };
}

function favorite(
  chatId: string,
  favoriteType: ManagedEntityFavorite['favoriteType'],
): ManagedEntityFavorite {
  return {
    id: `${chatId}:${favoriteType}`,
    userId: 'actor',
    chatId,
    entityType: 'CHAT',
    favoriteType,
    position: 0,
    createdAt: new Date('2026-10-22T00:00:00Z'),
    updatedAt: new Date('2026-10-22T00:00:00Z'),
  };
}

describe('canonical favorite settings recipients', () => {
  it('uses the canonical network before filtering legacy duplicate categories', async () => {
    const { db, findMany } = createDb([
      favorite('legacy', 'WATCH'),
      favorite('watch-only', 'WATCH'),
      favorite('legacy', 'IMPORTANT'),
      favorite('important-only', 'IMPORTANT'),
    ]);

    await expect(
      listCanonicalFavoriteChatIdsForSettingsTarget(db, 'actor', ['watch']),
    ).resolves.toEqual(['watch-only']);
    await expect(
      listCanonicalFavoriteChatIdsForSettingsTarget(db, 'actor', ['important']),
    ).resolves.toEqual(['legacy', 'important-only']);
    await expect(
      listCanonicalFavoriteChatIdsForSettingsTarget(db, 'actor', ['watch', 'important']),
    ).resolves.toEqual(['legacy', 'watch-only', 'important-only']);
    expect(findMany).toHaveBeenCalledWith({
      where: { userId: 'actor', entityType: 'CHAT' },
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
      select: { chatId: true, favoriteType: true },
    });
  });

  it('does not query storage when no favorite categories are selected', async () => {
    const { db, findMany } = createDb([]);

    await expect(listCanonicalFavoriteChatIdsForSettingsTarget(db, 'actor', [])).resolves.toEqual(
      [],
    );
    expect(findMany).not.toHaveBeenCalled();
  });
});
