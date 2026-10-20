import { isPublisherManagedEntityActivationRequired } from './publisher-entity-connection.util';
import type { MaxChatMemberAccess, MaxClientService } from '../max/max-client.service';
import { ChatBotMembershipStatus, Prisma, type ChatEntityType } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { PUBLISHER_ROSTER_INTERVAL_MS } from './publisher-access-refresh-policy';
import {
  publisherAccessProbeLifecycleWhere,
  publisherAccessProbeLifecycleSuperseded,
} from './publisher-access-probe-fence';

const GRANTED_TTL_MS = 3 * 24 * 60 * 60_000;

export type PublisherAdminRosterProbe = Readonly<{
  chatId: string;
  publisherBotId: string;
  probeStartedAtMs: number;
  members: readonly MaxChatMemberAccess[];
}>;

export async function probePublisherAdminRoster(params: {
  maxClient: MaxClientService;
  chatId: string;
  publisherBotId: string;
  probeStartedAt: Date;
}): Promise<PublisherAdminRosterProbe> {
  const members = await params.maxClient.getChatAdminAccesses(params.chatId, {
    botId: params.publisherBotId,
    trafficClass: 'background',
    sourceTag: 'publisher_user_access',
    bypassCache: true,
    timeoutMs: 5_000,
  });
  return {
    chatId: params.chatId,
    publisherBotId: params.publisherBotId,
    probeStartedAtMs: params.probeStartedAt.getTime(),
    members,
  };
}

export async function syncPublisherAdminRoster(
  params: {
    prisma: PrismaService;
    maxClient: MaxClientService;
    chatId: string;
    publisherBotId: string;
    entityType: ChatEntityType;
    probeStartedAt: Date;
    botAccessCheckedAt: Date;
    botAccessState: 'CONFIRMED_ADMIN' | 'CONFIRMED_OWNER';
  },
  probedRoster?: PublisherAdminRosterProbe,
): Promise<boolean> {
  const { prisma, maxClient, chatId, publisherBotId, probeStartedAt } = params;
  // FLAG: A caller-provided roster must be the complete exact-bot probe from this same
  // refresh. Persistence below still rechecks lifecycle, access version, and member epochs.
  const proof =
    probedRoster ??
    (await probePublisherAdminRoster({ maxClient, chatId, publisherBotId, probeStartedAt }));
  if (
    proof.chatId !== chatId ||
    proof.publisherBotId !== publisherBotId ||
    proof.probeStartedAtMs !== probeStartedAt.getTime()
  )
    return false;
  const roster = proof.members;
  // FLAG: A roster discovers positive authority only. Omitted or absent members never
  // prove that a previously confirmed exact user lost rights; explicit negatives own revocation.
  if (roster.some((member) => !member.userId || !(member.isAdmin || member.isOwner)))
    throw new Error('Incomplete MAX administrator role evidence');
  const humanAdminIds = [
    ...new Set(
      roster.flatMap((member) =>
        member.userId &&
        member.isBot === false &&
        member.explicitPrivilegeEvidence === true &&
        (member.isAdmin || member.isOwner)
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
      isPublisherManagedEntityActivationRequired(binding) ||
      binding.publisherBotId !== publisherBotId ||
      binding.status !== ChatBotMembershipStatus.ACTIVE ||
      publisherAccessProbeLifecycleSuperseded(binding, probeStartedAt) ||
      binding.botAccessCheckedAt?.getTime() !== params.botAccessCheckedAt.getTime() ||
      binding.botAccessState !== params.botAccessState
    )
      return false;

    // FLAG: Lock the exact proof before granting edges. A zero-row CAS returns before any
    // grants; SQL failure rolls back both the durable schedule and every access mutation.
    const scheduled = await tx.publisherEntityBinding.updateMany({
      where: {
        chatId,
        publisherBotId,
        status: ChatBotMembershipStatus.ACTIVE,
        botAccessCheckedAt: params.botAccessCheckedAt,
        botAccessState: params.botAccessState,
        AND: [
          publisherAccessProbeLifecycleWhere(probeStartedAt),
          {
            OR: [{ rosterCheckedAt: null }, { rosterCheckedAt: { lte: probeStartedAt } }],
          },
        ],
      },
      data: {
        rosterCheckedAt: probeStartedAt,
        rosterRefreshAfter: new Date(probeStartedAt.getTime() + PUBLISHER_ROSTER_INTERVAL_MS),
      },
    });
    if (scheduled.count !== 1) return false;

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
    const ownerIds = new Set(
      roster.filter((member) => member.isOwner).map((member) => member.userId),
    );
    const grant = {
      entityType: params.entityType,
      state: 'GRANTED' as const,
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
      for (const role of ['OWNER', 'ADMIN'] as const) {
        const roleUserIds = grantUserIds.filter(
          (userId) => ownerIds.has(userId) === (role === 'OWNER'),
        );
        if (roleUserIds.length === 0) continue;
        await tx.managedEntityAccessEdge.updateMany({
          where: {
            chatId,
            botId: publisherBotId,
            userId: { in: roleUserIds },
            checkedAt: { lte: probeStartedAt },
          },
          data: { ...grant, userRole: role },
        });
      }
      for (let offset = 0; offset < grantUserIds.length; offset += 250) {
        await tx.managedEntityAccessEdge.createMany({
          data: grantUserIds.slice(offset, offset + 250).map((userId) => ({
            chatId,
            botId: publisherBotId,
            userId,
            ...grant,
            userRole: ownerIds.has(userId) ? 'OWNER' : 'ADMIN',
          })),
          skipDuplicates: true,
        });
      }
    }
    return true;
  });
}
