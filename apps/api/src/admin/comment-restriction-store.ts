import type { ManagedEntityType } from '@maxim/contracts';
import type { MiniappProfile } from '@maxim/contracts/publisher';
import type { CommentRestriction as CommentRestrictionResponse } from '@maxim/contracts/channel-dialog';
import { ForbiddenException } from '@nestjs/common';
import { Prisma, type PrismaClient, type CommentRestriction } from '../prisma/prisma-client';

export type CommentScope = {
  chatId: string;
  entityType: ManagedEntityType;
  profile: MiniappProfile;
};

export function commentRestrictionKey(scope: CommentScope, userId: string) {
  return {
    profile: scope.profile,
    entityType: scope.entityType === 'channel' ? ('CHANNEL' as const) : ('CHAT' as const),
    chatId: scope.chatId,
    userId,
  };
}

export function presentCommentRestriction(
  row: CommentRestriction | null,
  userId: string,
  now = new Date(),
): CommentRestrictionResponse {
  const active =
    row?.kind === 'BAN' || (row?.kind === 'MUTE' && row.expiresAt !== null && row.expiresAt > now);
  return {
    userId,
    displayName: row?.displayName ?? null,
    kind: active ? (row.kind as 'MUTE' | 'BAN') : null,
    expiresAt: active ? (row.expiresAt?.toISOString() ?? null) : null,
    reason: active ? row.reason : '',
    revision: row?.revision ?? 0,
  };
}

export async function lockCommentParticipant(
  tx: Prisma.TransactionClient,
  scope: CommentScope,
  userId: string,
) {
  const key = JSON.stringify([
    'comment-restriction-v1',
    scope.profile,
    scope.entityType,
    scope.chatId,
    userId,
  ]);
  await tx.$executeRaw(
    Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0::bigint))`,
  );
}

// FLAG: Sanctions and comment writes share this transaction lock, including the first sanction.
// Remote uploads and MAX lookups must stay outside the transaction.
export async function withCommentWrite<T>(
  prisma: PrismaClient,
  scope: CommentScope,
  userId: string,
  write: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await lockCommentParticipant(tx, scope, userId);
    const row = await tx.commentRestriction.findUnique({
      where: { profile_entityType_chatId_userId: commentRestrictionKey(scope, userId) },
    });
    const restriction = presentCommentRestriction(row, userId);
    if (restriction.kind) {
      throw new ForbiddenException({
        code: 'COMMENT_RESTRICTED',
        message:
          restriction.kind === 'BAN'
            ? 'Вы заблокированы в комментариях этого сообщества.'
            : 'Вам временно запрещено участвовать в комментариях этого сообщества.',
        restriction,
      });
    }
    return write(tx);
  });
}
