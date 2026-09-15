import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { updateCommentRestrictionRequestSchema } from '@maxim/contracts/channel-dialog';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { MaxClientService } from '../max/max-client.service';
import { MaxBotRegistryService } from '../max/max-bot-registry.service';
import { PublisherBindingRefreshQueueService } from '../publisher/publisher-binding-refresh.queue';
import type { Prisma } from '../prisma/prisma-client';
import { ManagedEntitiesService } from './managed-entities.service';
import { PublisherPolicyService } from './publisher-policy.service';
import { resolveDialogAuditAction } from './admin-dialog-profile-helpers';
import {
  commentRestrictionKey,
  lockCommentParticipant,
  presentCommentRestriction,
  type CommentScope,
} from './comment-restriction-store';

@Injectable()
export class CommentModerationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly entities: ManagedEntitiesService,
    private readonly publisherPolicy: PublisherPolicyService,
    private readonly maxClient: MaxClientService,
    private readonly registry: MaxBotRegistryService,
    private readonly publisherRefresh: PublisherBindingRefreshQueueService,
  ) {}

  private async assertAdmin(scope: CommentScope, user: AuthUser) {
    if (scope.profile === 'publisher') {
      await this.publisherPolicy.getEntity(scope.entityType, scope.chatId, user);
    } else if (scope.entityType === 'channel') {
      await this.entities.assertChannelAdminAccess(scope.chatId, user);
    } else {
      await this.entities.assertChatAdminAccess(scope.chatId, user);
    }
  }

  async state(scope: CommentScope, user: AuthUser) {
    let canManage = false;
    try {
      if (scope.profile === 'publisher') {
        await this.publisherPolicy.getEntity(scope.entityType, scope.chatId, user);
        canManage = true;
      } else {
        // Capability polling stays local; mutations perform a fresh authorization check.
        const edge = await this.prisma.managedEntityAccessEdge.findFirst({
          where: {
            chatId: scope.chatId,
            userId: user.userId,
            entityType: commentRestrictionKey(scope, user.userId).entityType,
            botId: { in: this.registry.getAdminVisibleBots().map((bot) => bot.id) },
            state: 'GRANTED',
            userRole: { in: ['OWNER', 'ADMIN'] },
            expiresAt: { gt: new Date() },
          },
          select: { userId: true },
        });
        canManage = Boolean(edge);
      }
    } catch (error) {
      if (
        !(error instanceof ForbiddenException) &&
        !(error instanceof NotFoundException) &&
        !(error instanceof BadRequestException)
      )
        throw error;
    }
    return { canManage, restriction: await this.read(scope, user.userId) };
  }

  private async read(scope: CommentScope, userId: string) {
    const row = await this.prisma.commentRestriction.findUnique({
      where: { profile_entityType_chatId_userId: commentRestrictionKey(scope, userId) },
    });
    return presentCommentRestriction(row, userId);
  }

  async target(scope: CommentScope, user: AuthUser, userId: string) {
    await this.assertAdmin(scope, user);
    return this.read(scope, userId);
  }

  async list(scope: CommentScope, user: AuthUser, cursor?: string) {
    await this.assertAdmin(scope, user);
    const key = commentRestrictionKey(scope, '');
    const rows = await this.prisma.commentRestriction.findMany({
      where: {
        profile: key.profile,
        entityType: key.entityType,
        chatId: key.chatId,
        ...(cursor ? { userId: { gt: cursor } } : {}),
        OR: [{ kind: 'BAN' }, { kind: 'MUTE', expiresAt: { gt: new Date() } }],
      },
      orderBy: { userId: 'asc' },
      take: 51,
    });
    const page = rows.slice(0, 50);
    return {
      items: page.map((row) => presentCommentRestriction(row, row.userId)),
      nextCursor: rows.length > 50 ? page.at(-1)!.userId : null,
    };
  }

  async update(
    scope: CommentScope,
    user: AuthUser,
    userId: string,
    threadId: string | null,
    body: unknown,
  ) {
    const parsed = updateCommentRestrictionRequestSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.format());
    const request = parsed.data;
    await this.assertAdmin(scope, user);
    if (userId === user.userId) throw new ForbiddenException('Нельзя ограничить самого себя.');

    if (request.action !== 'RELEASE' && this.registry.isKnownBotUserId(userId)) {
      throw new ForbiddenException('Владельцев, администраторов и ботов нельзя ограничивать.');
    }

    // FLAG: Never accept a client-supplied name or arbitrary first-time target. The signed
    // thread and authenticated profile bind the source comment; existing rows allow release
    // after a moderator deletes the original comment.
    const source = request.sourceMessageId
      ? await this.prisma.auditLog.findFirst({
          where: {
            id: request.sourceMessageId,
            chatId: scope.chatId,
            actorUserId: userId,
            action: resolveDialogAuditAction('comments', scope.profile),
            ...(threadId ? { payload: { path: ['threadId'], equals: threadId } } : {}),
          },
          select: { payload: true },
        })
      : null;
    if (request.sourceMessageId && !source)
      throw new NotFoundException('Комментарий автора не найден. Обновите обсуждение.');
    const sourceName =
      source?.payload && typeof source.payload === 'object' && !Array.isArray(source.payload)
        ? source.payload.authorDisplayName
        : null;
    if (
      !source &&
      !(await this.prisma.commentRestriction.findUnique({
        where: { profile_entityType_chatId_userId: commentRestrictionKey(scope, userId) },
      }))
    ) {
      throw new NotFoundException('Автор комментария не найден.');
    }

    if (scope.profile === 'publisher') {
      await this.refreshPublisherRoles(scope, user.userId, userId, request.action === 'RELEASE');
    } else {
      const botId = await this.entities.resolveManagedEntityReadBotId(scope.chatId);
      if (!botId) throw new ServiceUnavailableException('Не удалось проверить права в MAX.');
      const access = await this.maxClient.getChatMembersAccess(
        scope.chatId,
        [user.userId, userId],
        { botId, bypassCache: true, trafficClass: 'interactive', timeoutMs: 5000 },
      );
      const actor = access.get(user.userId);
      if (!actor?.isAdmin && !actor?.isOwner)
        throw new ForbiddenException('Права администратора изменились. Обновите комментарии.');
      const target = access.get(userId);
      if (request.action !== 'RELEASE' && (target?.isAdmin || target?.isOwner || target?.isBot))
        throw new ForbiddenException('Владельцев, администраторов и ботов нельзя ограничивать.');
    }

    return this.prisma.$transaction(async (tx) => {
      await lockCommentParticipant(tx, scope, userId);
      if (
        scope.profile === 'publisher' &&
        !(await this.publisherRolesReady(
          tx,
          scope,
          user.userId,
          userId,
          request.action === 'RELEASE',
        ))
      ) {
        throw new ConflictException('Права участников изменились. Повторите проверку.');
      }
      const key = commentRestrictionKey(scope, userId);
      const where = { profile_entityType_chatId_userId: key };
      const current = await tx.commentRestriction.findUnique({ where });
      if (!current && !source) throw new NotFoundException('Автор комментария не найден.');
      if ((current?.revision ?? 0) !== request.expectedRevision)
        throw new ConflictException(
          'Ограничение уже изменилось. Обновите данные и повторите действие.',
        );
      const data = {
        kind: request.action === 'RELEASE' ? null : request.action,
        expiresAt:
          request.action === 'MUTE' ? new Date(Date.now() + request.durationSeconds! * 1000) : null,
        reason: request.action === 'RELEASE' ? '' : request.reason,
        displayName:
          typeof sourceName === 'string'
            ? sourceName.slice(0, 256)
            : (current?.displayName ?? null),
        revision: request.expectedRevision + 1,
      };
      const saved = await tx.commentRestriction.upsert({
        where,
        create: { ...key, ...data },
        update: data,
      });
      await tx.auditLog.create({
        data: {
          chatId: scope.chatId,
          actorUserId: user.userId,
          action: 'COMMENT_RESTRICTION_CHANGED',
          payload: {
            profile: scope.profile,
            entityType: scope.entityType,
            targetUserId: userId,
            action: request.action,
            previousKind: current?.kind ?? null,
            kind: saved.kind,
            expiresAt: saved.expiresAt?.toISOString() ?? null,
            reason: data.reason,
            revision: saved.revision,
          },
        },
      });
      return presentCommentRestriction(saved, userId);
    });
  }

  private async publisherRolesReady(
    db: Pick<Prisma.TransactionClient, 'managedEntityAccessEdge'>,
    scope: CommentScope,
    actorId: string,
    targetId: string,
    release: boolean,
  ): Promise<boolean> {
    const botId = this.registry.getPublisherBotDescriptor().id;
    const rows = await db.managedEntityAccessEdge.findMany({
      where: {
        chatId: scope.chatId,
        botId,
        userId: { in: [actorId, targetId] },
        entityType: commentRestrictionKey(scope, actorId).entityType,
        source: 'publisher_targeted_user_access',
        checkedAt: { gt: new Date(Date.now() - 30_000) },
        expiresAt: { gt: new Date() },
      },
      select: {
        userId: true,
        state: true,
        userRole: true,
        botRole: true,
        deniedReason: true,
        lastMaxStatusCode: true,
      },
    });
    const actor = rows.find((row) => row.userId === actorId);
    const target = rows.find((row) => row.userId === targetId);
    if (!actor || (!release && !target)) return false;
    if (actor.state !== 'GRANTED' || !['OWNER', 'ADMIN'].includes(actor.userRole))
      throw new ForbiddenException('Права администратора изменились. Обновите комментарии.');
    if (release) return true;
    if (
      target &&
      (['OWNER', 'ADMIN'].includes(target.userRole) ||
        target.deniedReason === 'publisher_actor_is_bot' ||
        target.deniedReason === 'publisher_actor_type_unverified')
    )
      throw new ForbiddenException('Владельцев, администраторов и ботов нельзя ограничивать.');
    return Boolean(
      target &&
      target.state === 'USER_DENIED' &&
      target.deniedReason === 'publisher_user_not_admin' &&
      target.lastMaxStatusCode === null &&
      ['OWNER', 'ADMIN'].includes(target.botRole),
    );
  }

  private async refreshPublisherRoles(
    scope: CommentScope,
    actorId: string,
    targetId: string,
    release: boolean,
  ) {
    // FLAG: api-admin has no Publisher token. Only the existing Publisher worker may probe MAX;
    // require its recent, exact-bot successful role evidence before committing a restriction.
    if (await this.publisherRolesReady(this.prisma, scope, actorId, targetId, release)) return;
    for (const candidateUserId of release ? [actorId] : [actorId, targetId]) {
      await this.publisherRefresh.enqueue({
        chatId: scope.chatId,
        publisherBotId: this.registry.getPublisherBotDescriptor().id,
        candidateUserId,
        reason: 'manual_recheck',
      });
    }
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      if (await this.publisherRolesReady(this.prisma, scope, actorId, targetId, release)) return;
    }
    throw new ConflictException({
      code: 'COMMENT_MODERATION_ACCESS_PENDING',
      message: 'Проверяем права участников в MAX. Повторите действие через несколько секунд.',
    });
  }
}
