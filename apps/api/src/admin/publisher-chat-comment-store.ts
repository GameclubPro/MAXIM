import type { MiniappProfile } from '@maxim/contracts/publisher';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Prisma, type PrismaClient } from '../prisma/prisma-client';
import { CHANNEL_DIALOG_MESSAGES_LIMIT } from './admin.service.support';

export type PublisherChatCommentRow = {
  id: string;
  actorUserId: string;
  payload: Prisma.JsonValue;
  createdAt: Date;
};

type PublisherChatCommentIdentity = {
  chatId: string;
  messageId: string;
  threadId: string | null;
};

type PublisherChatCommentMutation = (
  row: PublisherChatCommentRow,
) => Prisma.InputJsonValue | Promise<Prisma.InputJsonValue>;

type ParsedDialogCommentTarget = {
  row: PublisherChatCommentRow;
  payload: Record<string, unknown>;
};

type DialogCommentMutationBase = {
  prisma: PrismaClient;
  chatId: string;
  messageId: string;
  dialogProfile?: MiniappProfile;
  resolvePublisherThreadId: () => string | null;
  resolveLegacyTarget: () => Promise<ParsedDialogCommentTarget>;
};

type UpdateDialogCommentParams = DialogCommentMutationBase & {
  userId: string;
  text: string;
  hasAttachments: (value: unknown) => boolean;
};

type ToggleDialogCommentReactionParams = DialogCommentMutationBase & {
  userId: string;
  emoji: string;
  toggleReactions: (currentValue: unknown, emoji: string, userId: string) => unknown;
};

const dialogCommentRowSelect = {
  id: true,
  actorUserId: true,
  payload: true,
  createdAt: true,
} as const;

// FLAG: Keep the action and JSON expression literal aligned with
// audit_logs_publisher_chat_comment_thread_created_idx. A parameterized action can make
// PostgreSQL's generic plan ineligible for the partial index.
export function buildPublisherChatCommentsQuery(
  chatId: string,
  threadId: string | null,
): Prisma.Sql {
  const threadPredicate = threadId
    ? Prisma.sql`AND audit.payload->>'threadId' = ${threadId}`
    : Prisma.empty;

  return Prisma.sql`
    SELECT
      audit.id,
      audit.actor_user_id AS "actorUserId",
      audit.payload,
      audit.created_at AS "createdAt"
    FROM audit_logs audit
    WHERE audit.chat_id = ${chatId}
      AND audit.action = 'PUBLISHER_CHAT_DIALOG_COMMENT'
      ${threadPredicate}
    ORDER BY audit.created_at DESC
    LIMIT ${CHANNEL_DIALOG_MESSAGES_LIMIT}
  `;
}

export function buildPublisherChatCommentCountQuery(chatId: string, threadId: string): Prisma.Sql {
  return Prisma.sql`
    SELECT COUNT(*)::bigint AS count
    FROM audit_logs audit
    WHERE audit.chat_id = ${chatId}
      AND audit.action = 'PUBLISHER_CHAT_DIALOG_COMMENT'
      AND audit.payload->>'threadId' = ${threadId}
  `;
}

export async function countPublisherChatComments(
  prisma: PrismaClient,
  chatId: string,
  threadId: string,
): Promise<number> {
  const rows = await prisma.$queryRaw<Array<{ count: bigint | number | string }>>(
    buildPublisherChatCommentCountQuery(chatId, threadId),
  );
  const count = Number(rows[0]?.count ?? 0);
  return Number.isSafeInteger(count) && count > 0 ? count : 0;
}

function buildPublisherChatCommentLockQuery(identity: PublisherChatCommentIdentity): Prisma.Sql {
  const threadPredicate = identity.threadId
    ? Prisma.sql`AND audit.payload->>'threadId' = ${identity.threadId}`
    : Prisma.empty;

  return Prisma.sql`
    SELECT
      audit.id,
      audit.actor_user_id AS "actorUserId",
      audit.payload,
      audit.created_at AS "createdAt"
    FROM audit_logs audit
    WHERE audit.id = ${identity.messageId}
      AND audit.chat_id = ${identity.chatId}
      AND audit.action = 'PUBLISHER_CHAT_DIALOG_COMMENT'
      ${threadPredicate}
    FOR UPDATE OF audit
  `;
}

export async function mutatePublisherChatCommentWithLock(
  prisma: PrismaClient,
  identity: PublisherChatCommentIdentity,
  mutation: PublisherChatCommentMutation,
): Promise<PublisherChatCommentRow | null> {
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<PublisherChatCommentRow[]>(
      buildPublisherChatCommentLockQuery(identity),
    );
    const row = rows[0];
    if (!row) {
      return null;
    }

    const payload = await mutation(row);
    return tx.auditLog.update({
      where: { id: row.id },
      data: { payload },
      select: dialogCommentRowSelect,
    });
  });
}

export async function updateDialogCommentForProfile(
  params: UpdateDialogCommentParams,
): Promise<PublisherChatCommentRow | null> {
  const text = params.text.trim();
  const buildPayload = (target: ParsedDialogCommentTarget): Prisma.InputJsonValue => {
    if (target.row.actorUserId !== params.userId) {
      throw new ForbiddenException('Редактировать можно только свои комментарии.');
    }
    if (!text && !params.hasAttachments(target.payload.attachments)) {
      throw new BadRequestException('Введите текст комментария или добавьте вложение.');
    }
    return {
      ...target.payload,
      text,
      editedAt: new Date().toISOString(),
    } as Prisma.InputJsonValue;
  };

  if (params.dialogProfile === 'publisher') {
    return mutatePublisherChatCommentWithLock(
      params.prisma,
      {
        chatId: params.chatId,
        messageId: params.messageId,
        threadId: params.resolvePublisherThreadId(),
      },
      (row) => buildPayload({ row, payload: readObjectPayload(row.payload) }),
    );
  }

  const target = await params.resolveLegacyTarget();
  return params.prisma.auditLog.update({
    where: { id: target.row.id },
    data: { payload: buildPayload(target) },
    select: dialogCommentRowSelect,
  });
}

export async function toggleDialogCommentReactionForProfile(
  params: ToggleDialogCommentReactionParams,
): Promise<PublisherChatCommentRow | null> {
  const buildPayload = (payload: Record<string, unknown>): Prisma.InputJsonValue =>
    ({
      ...payload,
      reactions: params.toggleReactions(payload.reactions, params.emoji, params.userId),
    }) as Prisma.InputJsonValue;

  if (params.dialogProfile === 'publisher') {
    return mutatePublisherChatCommentWithLock(
      params.prisma,
      {
        chatId: params.chatId,
        messageId: params.messageId,
        threadId: params.resolvePublisherThreadId(),
      },
      (row) => buildPayload(readObjectPayload(row.payload)),
    );
  }

  const target = await params.resolveLegacyTarget();
  return params.prisma.auditLog.update({
    where: { id: target.row.id },
    data: { payload: buildPayload(target.payload) },
    select: dialogCommentRowSelect,
  });
}

function readObjectPayload(value: Prisma.JsonValue): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}
