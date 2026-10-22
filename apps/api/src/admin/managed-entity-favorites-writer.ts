import { ConflictException } from '@nestjs/common';
import type {
  ManagedEntityFavoriteType,
  ManagedEntityNetworkCompositionChange,
  ManagedEntityType,
} from '@maxim/contracts';
import { Prisma } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import {
  CONTRACT_FAVORITE_TYPE_BY_PRISMA,
  MANAGED_ENTITY_FAVORITE_TYPE_ORDER,
  PRISMA_FAVORITE_TYPE_BY_CONTRACT,
} from './admin.service.support';

export function canonicalManagedEntityFavoriteType(
  rows: readonly { favoriteType: keyof typeof CONTRACT_FAVORITE_TYPE_BY_PRISMA }[],
): ManagedEntityFavoriteType | null {
  const types = new Set(rows.map((row) => CONTRACT_FAVORITE_TYPE_BY_PRISMA[row.favoriteType]));
  return MANAGED_ENTITY_FAVORITE_TYPE_ORDER.find((type) => types.has(type)) ?? null;
}

type FavoriteWrite = ManagedEntityNetworkCompositionChange;

export async function lockManagedEntityFavorites(
  tx: Prisma.TransactionClient,
  userId: string,
  entityType: ManagedEntityType,
): Promise<void> {
  await tx.$executeRaw(
    Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify(['managed-favorites-v1', userId, entityType])}, 0::BIGINT))`,
  );
}

export async function writeManagedEntityFavorites(
  prisma: PrismaService,
  userId: string,
  entityType: ManagedEntityType,
  changes: readonly FavoriteWrite[],
  assertVisible?: (tx: Prisma.TransactionClient) => Promise<void>,
): Promise<ManagedEntityNetworkCompositionChange[]> {
  return prisma.$transaction(async (tx) => {
    // FLAG: Every single/bulk favorite writer uses this same transaction lock. Empty
    // assignments have no row to lock; per-user/type serialization closes that race.
    await lockManagedEntityFavorites(tx, userId, entityType);
    await assertVisible?.(tx);
    const prismaEntityType = entityType === 'chat' ? 'CHAT' : 'CHANNEL';
    const rows = await tx.managedEntityFavorite.findMany({
      where: {
        userId,
        entityType: prismaEntityType,
        chatId: { in: changes.map((c) => c.entityId) },
      },
      select: { chatId: true, favoriteType: true },
    });
    const current = new Map<string, ManagedEntityFavoriteType | null>();
    for (const change of changes) {
      current.set(
        change.entityId,
        canonicalManagedEntityFavoriteType(rows.filter((row) => row.chatId === change.entityId)),
      );
    }
    const conflicts = changes.filter(
      (change) =>
        change.expectedFavoriteType !== current.get(change.entityId) &&
        change.favoriteType !== current.get(change.entityId),
    );
    if (conflicts.length > 0) {
      throw new ConflictException({
        code: 'MANAGED_ENTITY_NETWORK_COMPOSITION_CONFLICT',
        message: 'Состав сетки изменился на другом устройстве. Обновите данные перед сохранением.',
        conflicts: conflicts.map((change) => ({
          entityId: change.entityId,
          favoriteType: current.get(change.entityId) ?? null,
        })),
      });
    }
    const result: ManagedEntityNetworkCompositionChange[] = [];
    const mutations: FavoriteWrite[] = [];
    for (const change of changes) {
      const previous = current.get(change.entityId) ?? null;
      const entityRows = rows.filter((row) => row.chatId === change.entityId);
      result.push({
        entityId: change.entityId,
        expectedFavoriteType: change.expectedFavoriteType,
        favoriteType: change.favoriteType,
      });
      if (previous === change.favoriteType && entityRows.length <= 1) continue;
      mutations.push(change);
    }
    if (mutations.length > 0) {
      await tx.managedEntityFavorite.deleteMany({
        where: {
          userId,
          entityType: prismaEntityType,
          chatId: { in: mutations.map((change) => change.entityId) },
        },
      });
      const assignments = mutations.filter((change) => change.favoriteType !== null);
      if (assignments.length > 0)
        await tx.managedEntityFavorite.createMany({
          data: assignments.map((change) => ({
            userId,
            entityType: prismaEntityType,
            chatId: change.entityId,
            favoriteType: PRISMA_FAVORITE_TYPE_BY_CONTRACT[change.favoriteType!],
            position: 0,
          })),
        });
      await tx.auditLog.createMany({
        data: mutations.map((change) => ({
          chatId: change.entityId,
          actorUserId: userId,
          action: 'UPDATE_MANAGED_ENTITY_FAVORITES',
          payload: {
            entityType,
            favoriteTypes: change.favoriteType === null ? [] : [change.favoriteType],
          },
        })),
      });
    }
    return result;
  });
}
