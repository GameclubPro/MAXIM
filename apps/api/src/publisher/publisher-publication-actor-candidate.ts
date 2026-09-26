import { randomUUID } from 'node:crypto';
import {
  ChatEntityType,
  ManagedEntityAccessRole,
  ManagedEntityAccessState,
  Prisma,
} from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import {
  PUBLISHER_ACCESS_CANDIDATE_PENDING_REASON,
  PUBLISHER_ACCESS_CANDIDATE_SOURCE,
  PUBLISHER_ACCESS_CANDIDATE_TTL_MS,
} from './publisher-entity-binding-lifecycle.service';
import { publisherRefreshEvidenceWhere } from './publisher-entity-connection.util';

export async function stageMissingPublicationActor(
  prisma: PrismaService,
  scope: { chatId: string; userId: string; botId: string; entityType?: ChatEntityType },
): Promise<{ requestedAt: Date; candidateVersion: string } | null> {
  return prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id" FROM "chats" WHERE "id" = ${scope.chatId} FOR UPDATE
    `);
    if (locked.length !== 1) return null;
    const chat = await tx.chat.findFirst({
      where: {
        id: scope.chatId,
        ...(scope.entityType ? { entityType: scope.entityType } : {}),
        publisherBinding: { is: publisherRefreshEvidenceWhere(scope.botId) },
      },
      select: { entityType: true },
    });
    if (!chat) return null;
    const key = { chatId: scope.chatId, userId: scope.userId, botId: scope.botId };
    const existing = await tx.managedEntityAccessEdge.findUnique({
      where: { chatId_userId_botId: key },
      select: { sourceVersion: true },
    });
    if (existing) return null;

    // FLAG: Persist only a non-grant candidate, never overwrite a concurrent grant/denial.
    // The Publisher worker must verify MAX and this exact version before granting access.
    const requestedAt = new Date();
    const candidateVersion = `publication:${randomUUID()}`;
    const created = await tx.managedEntityAccessEdge.createMany({
      data: [
        {
          ...key,
          entityType: chat.entityType,
          state: ManagedEntityAccessState.BOT_DENIED,
          userRole: ManagedEntityAccessRole.UNKNOWN,
          botRole: ManagedEntityAccessRole.UNKNOWN,
          checkedAt: requestedAt,
          expiresAt: new Date(requestedAt.getTime() + PUBLISHER_ACCESS_CANDIDATE_TTL_MS),
          deniedReason: PUBLISHER_ACCESS_CANDIDATE_PENDING_REASON,
          source: `${PUBLISHER_ACCESS_CANDIDATE_SOURCE}_publication`,
          sourceVersion: candidateVersion,
        },
      ],
      skipDuplicates: true,
    });
    return created.count === 1 ? { requestedAt, candidateVersion } : null;
  });
}
