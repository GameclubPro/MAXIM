import type { MaxClientService } from '../max/max-client.service';
import { ChatBotMembershipStatus, Prisma, type ChatEntityType } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { publisherAccessProbeLifecycleSuperseded } from './publisher-access-probe-fence';

const GRANTED_TTL_MS = 3 * 24 * 60 * 60_000;
const DENIED_TTL_MS = 15 * 60_000;

export async function syncPublisherAdminRoster(params: {
  prisma: PrismaService;
  maxClient: MaxClientService;
  chatId: string;
  publisherBotId: string;
  entityType: ChatEntityType;
  probeStartedAt: Date;
  botAccessCheckedAt: Date;
  botAccessState: 'CONFIRMED_ADMIN' | 'CONFIRMED_OWNER';
}): Promise<boolean> {
  const { prisma, maxClient, chatId, publisherBotId, probeStartedAt } = params;
  const roster = await maxClient.getChatAdminAccesses(chatId, {
    botId: publisherBotId,
    trafficClass: 'background',
    sourceTag: 'publisher_user_access',
    bypassCache: true,
    timeoutMs: 5_000,
  });
  const presentUserIds = [
    ...new Set(
      roster.flatMap((member) =>
        member.userId && (member.isAdmin || member.isOwner) ? [member.userId] : [],
      ),
    ),
  ];
  const humanAdminIds = [
    ...new Set(
      roster.flatMap((member) =>
        member.userId && member.isBot === false && (member.isAdmin || member.isOwner)
          ? [member.userId]
          : [],
      ),
    ),
  ];
  return prisma.$transaction(async (tx) => {
    // FLAG: An exact Publisher roster never grants Major access or survives a newer lifecycle.
    const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT chat."id" FROM "chats" AS chat WHERE chat."id" = ${chatId} FOR UPDATE OF chat
    `);
    if (locked.length !== 1) return false;
    const binding = await tx.publisherEntityBinding.findUnique({ where: { chatId } });
    if (
      !binding ||
      binding.publisherBotId !== publisherBotId ||
      binding.status !== ChatBotMembershipStatus.ACTIVE ||
      publisherAccessProbeLifecycleSuperseded(binding, probeStartedAt) ||
      binding.botAccessCheckedAt?.getTime() !== params.botAccessCheckedAt.getTime() ||
      binding.botAccessState !== params.botAccessState
    )
      return false;

    const membershipChanges =
      humanAdminIds.length > 0
        ? await tx.$queryRaw<Array<{ userId: string }>>(Prisma.sql`
          SELECT DISTINCT activity."user_id" AS "userId"
          FROM "chat_membership_activity_events" AS activity
          WHERE activity."chat_id" = ${chatId}
            AND activity."user_id" IN (${Prisma.join(humanAdminIds)})
            AND activity."event_type" IN ('user_added', 'user_removed')
            AND activity."event_at" >= ${probeStartedAt}
        `)
        : [];
    const changedUserIds = new Set(membershipChanges.map((row) => row.userId));
    const grantUserIds = humanAdminIds.filter((userId) => !changedUserIds.has(userId));
    const grant = {
      entityType: params.entityType,
      state: 'GRANTED' as const,
      userRole: 'ADMIN' as const,
      botRole:
        params.botAccessState === 'CONFIRMED_OWNER' ? ('OWNER' as const) : ('ADMIN' as const),
      checkedAt: probeStartedAt,
      expiresAt: new Date(probeStartedAt.getTime() + GRANTED_TTL_MS),
      deniedReason: null,
      lastMaxErrorCode: null,
      lastMaxErrorMessage: null,
      lastMaxStatusCode: null,
      source: 'publisher_admin_roster',
    };
    if (grantUserIds.length > 0) {
      // FLAG: Preserve newer verdicts and candidate versions; the parent lock orders writers.
      await tx.managedEntityAccessEdge.updateMany({
        where: {
          chatId,
          botId: publisherBotId,
          userId: { in: grantUserIds },
          checkedAt: { lte: probeStartedAt },
        },
        data: grant,
      });
      for (let offset = 0; offset < grantUserIds.length; offset += 250) {
        await tx.managedEntityAccessEdge.createMany({
          data: grantUserIds.slice(offset, offset + 250).map((userId) => ({
            chatId,
            botId: publisherBotId,
            userId,
            ...grant,
          })),
          skipDuplicates: true,
        });
      }
    }
    // FLAG: Only absence from a complete roster revokes; unknown bot markers grant nothing.
    await tx.managedEntityAccessEdge.updateMany({
      where: {
        chatId,
        botId: publisherBotId,
        state: 'GRANTED',
        userId: { notIn: presentUserIds },
        checkedAt: { lte: probeStartedAt },
      },
      data: {
        state: 'USER_DENIED',
        userRole: 'UNKNOWN',
        checkedAt: probeStartedAt,
        expiresAt: new Date(probeStartedAt.getTime() + DENIED_TTL_MS),
        deniedReason: 'publisher_user_removed_from_admin_roster',
        source: 'publisher_admin_roster',
      },
    });
    return true;
  });
}
