import { hasExplicitHumanAdministrator } from '../max/managed-entity-activation.util';
import { isPublisherManagedEntityActivationRequired } from './publisher-entity-connection.util';
import type { MaxChatMemberAccess, MaxClientService } from '../max/max-client.service';
import {
  ChatBotAccessState,
  ChatBotMembershipStatus,
  ChatEntityType,
  ManagedEntityAccessRole,
  ManagedEntityAccessState,
  Prisma,
} from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { publisherAccessProbeLifecycleSuperseded } from './publisher-access-probe-fence';
import { extractPublisherMaxStatusCode } from './publisher-dispatch-health.service';
import { PublisherBotProofSupersededError } from './publisher-fresh-bot-proof';
import type { PublisherAccessProbeOutcome } from './publisher-access-refresh-policy';

const PUBLISHER_USER_ACCESS_GRANTED_TTL_MS = 3 * 24 * 60 * 60_000;
const PUBLISHER_USER_ACCESS_DENIED_TTL_MS = 15 * 60_000;

export class PublisherActorAccessExecutor {
  constructor(
    private readonly prisma: PrismaService,
    private readonly maxClient: MaxClientService,
    private readonly publisherBotId: string,
  ) {}
  async execute(params: {
    chatId: string;
    entityType: ChatEntityType;
    userId: string;
    candidateVersion: string | null;
    botAccess: MaxChatMemberAccess;
    probeStartedAt: Date;
    committedBotAccessCheckedAt: Date;
    committedBotAccessState: ChatBotAccessState;
    interactive: boolean;
  }): Promise<{
    committed: boolean;
    state: ManagedEntityAccessState;
    outcome: PublisherAccessProbeOutcome;
  }> {
    let userAccess: MaxChatMemberAccess | null;
    try {
      userAccess = await this.maxClient.getChatMemberAccess(params.chatId, params.userId, {
        botId: this.publisherBotId,
        trafficClass: params.interactive ? 'interactive' : 'background',
        sourceTag: 'publisher_user_access',
        bypassCache: true,
        timeoutMs: 5_000,
        ignoreFailureMetricStatuses: [403, 404],
      });
    } catch (error: unknown) {
      const statusCode = extractPublisherMaxStatusCode(error);
      if (statusCode !== 403 && statusCode !== 404) {
        throw error;
      }
      // FLAG: A member-endpoint 403/404 is not proof of lost admin rights. The exact
      // roster may recover a positive grant, but absence cannot establish a user denial.
      const roster =
        params.botAccess.isAdmin || params.botAccess.isOwner
          ? await this.maxClient.getChatAdminAccesses(params.chatId, {
              botId: this.publisherBotId,
              trafficClass: params.interactive ? 'interactive' : 'background',
              sourceTag: 'publisher_user_access',
              bypassCache: true,
              timeoutMs: 5_000,
            })
          : [];
      if (
        roster.some(
          (member) =>
            !member.userId ||
            typeof member.isBot !== 'boolean' ||
            !(member.isAdmin || member.isOwner) ||
            member.explicitPrivilegeEvidence !== true,
        )
      )
        throw new Error('Incomplete MAX administrator roster');
      const identity = (id: string | null) =>
        (id ?? '')
          .trim()
          .toLowerCase()
          .replace(/^id(?=\d)/u, '');
      userAccess =
        roster.find((member) => identity(member.userId) === identity(params.userId)) ?? null;
    }
    // FLAG: Absent role fields/empty member responses are not a revocation. Only exact
    // non-admin evidence or a bot identity may deny; roster absence remains unknown.
    if (
      !userAccess ||
      (!userAccess.isAdmin &&
        !userAccess.isOwner &&
        userAccess.isBot !== true &&
        userAccess.explicitNonPrivilegeEvidence !== true)
    )
      throw new Error('MAX actor role evidence is incomplete');
    const checkedAt = params.probeStartedAt;
    const userIsBot = userAccess?.isBot === true;
    const userHasUnverifiedBotType =
      typeof userAccess?.isBot !== 'boolean' &&
      (userAccess?.isAdmin === true || userAccess?.isOwner === true);
    if (userHasUnverifiedBotType) throw new Error('MAX actor type is unknown');
    if (
      userAccess?.isBot === false &&
      (userAccess.isAdmin || userAccess.isOwner) &&
      userAccess.explicitPrivilegeEvidence !== true
    )
      throw new Error('MAX actor privilege evidence is incomplete');
    const userHasAdminAccess = hasExplicitHumanAdministrator(
      userAccess ?? undefined,
      params.userId,
    );
    const botHasAdminAccess = params.botAccess.isAdmin || params.botAccess.isOwner;
    const granted = userHasAdminAccess && botHasAdminAccess;
    const state = granted
      ? ManagedEntityAccessState.GRANTED
      : botHasAdminAccess
        ? ManagedEntityAccessState.USER_DENIED
        : ManagedEntityAccessState.BOT_DENIED;
    const deniedReason = granted
      ? null
      : botHasAdminAccess
        ? userIsBot
          ? 'publisher_actor_is_bot'
          : 'publisher_user_not_admin'
        : 'publisher_bot_not_admin';
    const userRole = this.toAccessRole(userAccess);
    const botRole = this.toAccessRole(params.botAccess);
    const committed = await this.prisma.$transaction(async (tx) => {
      const chats = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT chat."id"
        FROM "chats" AS chat
        WHERE chat."id" = ${params.chatId}
        FOR UPDATE OF chat
      `);
      if (chats.length === 0) return false;
      const binding = await tx.publisherEntityBinding.findUnique({
        where: { chatId: params.chatId },
        select: {
          publisherBotId: true,
          status: true,
          lifecycleEventAt: true,
          lifecycleEventType: true,
          botAccessCheckedAt: true,
          botAccessExpiresAt: true,
          botAccessState: true,
          permissionsSnapshot: true,
          botAccessSource: true,
        },
      });
      if (
        !binding ||
        isPublisherManagedEntityActivationRequired(binding) ||
        binding.publisherBotId !== this.publisherBotId ||
        binding.status !== ChatBotMembershipStatus.ACTIVE ||
        publisherAccessProbeLifecycleSuperseded(binding, params.probeStartedAt)
      ) {
        return false;
      }
      if (
        binding.botAccessState !== params.committedBotAccessState &&
        binding.botAccessState !== ChatBotAccessState.CONFIRMED_ADMIN &&
        binding.botAccessState !== ChatBotAccessState.CONFIRMED_OWNER
      )
        return false;
      // FLAG: A concurrent bot renewal is not completion of the actor check. Retry
      // without granting against a changed proof; lifecycle revocation above stays terminal.
      if (
        binding.botAccessCheckedAt?.getTime() !== params.committedBotAccessCheckedAt.getTime() ||
        binding.botAccessState !== params.committedBotAccessState
      ) {
        throw new PublisherBotProofSupersededError();
      }
      const candidateEdge = await tx.managedEntityAccessEdge.findUnique({
        where: {
          chatId_userId_botId: {
            chatId: params.chatId,
            userId: params.userId,
            botId: this.publisherBotId,
          },
        },
        select: { sourceVersion: true, checkedAt: true },
      });
      // FLAG: A delayed MAX verdict cannot overwrite a newer user grant or membership reset.
      if (
        (candidateEdge?.checkedAt && candidateEdge.checkedAt > params.probeStartedAt) ||
        (params.candidateVersion && candidateEdge?.sourceVersion !== params.candidateVersion)
      ) {
        return false;
      }
      await tx.managedEntityAccessEdge.upsert({
        where: {
          chatId_userId_botId: {
            chatId: params.chatId,
            userId: params.userId,
            botId: this.publisherBotId,
          },
        },
        create: {
          chatId: params.chatId,
          userId: params.userId,
          botId: this.publisherBotId,
          entityType: params.entityType,
          state,
          userRole,
          botRole,
          checkedAt,
          expiresAt: new Date(
            checkedAt.getTime() +
              (granted
                ? PUBLISHER_USER_ACCESS_GRANTED_TTL_MS
                : PUBLISHER_USER_ACCESS_DENIED_TTL_MS),
          ),
          deniedReason,
          lastMaxErrorCode: null,
          lastMaxErrorMessage: null,
          lastMaxStatusCode: null,
          source: 'publisher_targeted_user_access',
          sourceVersion: params.candidateVersion,
        },
        update: {
          entityType: params.entityType,
          state,
          userRole,
          botRole,
          checkedAt,
          expiresAt: new Date(
            checkedAt.getTime() +
              (granted
                ? PUBLISHER_USER_ACCESS_GRANTED_TTL_MS
                : PUBLISHER_USER_ACCESS_DENIED_TTL_MS),
          ),
          deniedReason,
          lastMaxErrorCode: null,
          lastMaxErrorMessage: null,
          lastMaxStatusCode: null,
          source: 'publisher_targeted_user_access',
          sourceVersion: params.candidateVersion,
        },
      });
      return true;
    });
    return {
      committed,
      state,
      outcome: !committed ? 'superseded' : granted ? 'confirmed' : 'denied',
    };
  }

  private toAccessRole(access: MaxChatMemberAccess | null): ManagedEntityAccessRole {
    if (access?.isOwner) return ManagedEntityAccessRole.OWNER;
    if (access?.isAdmin) return ManagedEntityAccessRole.ADMIN;
    return access ? ManagedEntityAccessRole.MEMBER : ManagedEntityAccessRole.UNKNOWN;
  }
}
