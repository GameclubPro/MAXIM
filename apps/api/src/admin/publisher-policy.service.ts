import {
  publisherEntitiesResponseSchema,
  publisherEntitySchema,
  updateManagedEntityPublicationPolicyRequestSchema,
  type ManagedEntityPublicationPolicy,
  type ManagedEntityType,
  type PublisherEntitiesResponse,
  type PublisherEntity,
} from '@maxim/contracts/publisher';
import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import {
  ChatBotMembershipStatus,
  ChatEntityType,
  ManagedEntityAccessRole,
  ManagedEntityAccessState,
  Prisma,
} from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { MaxBotRegistryService } from '../max/max-bot-registry.service';
import { PublisherReadinessService } from '../publisher/publisher-readiness.service';
import { ManagedEntitiesService } from './managed-entities.service';

@Injectable()
export class PublisherPolicyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly botRegistry: MaxBotRegistryService,
    private readonly readinessService: PublisherReadinessService,
    private readonly managedEntitiesService: ManagedEntitiesService,
  ) {}

  async listEntities(user: AuthUser): Promise<PublisherEntitiesResponse> {
    const publisherBotId = this.botRegistry.getPublisherBotDescriptor().id;
    const actionableBotIds = new Set(this.botRegistry.getActionableBots().map((bot) => bot.id));
    const now = new Date();
    const legacyGraceStart = new Date(now.getTime() - 7 * 24 * 60 * 60_000);
    const runtimeAvailable = await this.readinessService.isRuntimeAvailable();
    const edges = await this.prisma.managedEntityAccessEdge.findMany({
      where: {
        userId: user.userId,
        state: ManagedEntityAccessState.GRANTED,
        userRole: { in: [ManagedEntityAccessRole.OWNER, ManagedEntityAccessRole.ADMIN] },
        OR: [{ expiresAt: { gt: now } }, { expiresAt: null, checkedAt: { gt: legacyGraceStart } }],
        botId: { not: publisherBotId },
      },
      orderBy: [{ checkedAt: 'desc' }, { chatId: 'asc' }],
      include: {
        chat: {
          select: {
            id: true,
            title: true,
            entityType: true,
            channelSettings: {
              select: {
                commentsEnabled: true,
                postSuggestionsEnabled: true,
                commentsModerationEnabled: true,
              },
            },
            publicationPolicy: true,
            publisherBinding: true,
            botMemberships: {
              where: { status: ChatBotMembershipStatus.ACTIVE },
              select: { botId: true },
            },
          },
        },
      },
    });

    const entitiesById = new Map<string, PublisherEntity>();
    for (const edge of edges) {
      if (
        entitiesById.has(edge.chatId) ||
        !actionableBotIds.has(edge.botId) ||
        !edge.chat.botMemberships.some((membership) => membership.botId === edge.botId)
      ) {
        continue;
      }
      entitiesById.set(edge.chatId, this.presentEntity(edge.chat, runtimeAvailable));
    }

    return publisherEntitiesResponseSchema.parse({
      items: [...entitiesById.values()].sort(
        (left, right) =>
          left.entityType.localeCompare(right.entityType) || left.title.localeCompare(right.title),
      ),
    });
  }

  async getEntity(
    entityType: ManagedEntityType,
    entityId: string,
    user: AuthUser,
  ): Promise<PublisherEntity> {
    const response = await this.listEntities(user);
    const entity = response.items.find(
      (item) => item.id === entityId && item.entityType === entityType,
    );
    if (!entity) {
      throw new BadRequestException('Managed entity is unavailable');
    }
    return entity;
  }

  async updatePolicy(
    entityType: ManagedEntityType,
    entityId: string,
    user: AuthUser,
    body: unknown,
  ): Promise<ManagedEntityPublicationPolicy> {
    const parsed = updateManagedEntityPublicationPolicyRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }
    const request = parsed.data;
    if (entityType === 'chat' && request.suggestionsViaPublik === true) {
      throw new BadRequestException('Suggestions via Publik are available only for channels');
    }
    await this.managedEntitiesService.assertManagedEntityAdminAccess(entityId, user, entityType);
    const expectedEntityType =
      entityType === 'channel' ? ChatEntityType.CHANNEL : ChatEntityType.CHAT;
    const existingChat = await this.prisma.chat.findUnique({
      where: { id: entityId },
      select: { entityType: true, publicationPolicy: true },
    });
    if (!existingChat || existingChat.entityType !== expectedEntityType) {
      throw new BadRequestException('Managed entity type does not match');
    }

    try {
      const policy = await this.prisma.$transaction(async (tx) => {
        let updated;
        if (!existingChat.publicationPolicy) {
          if (request.expectedRevision !== 0) {
            throw this.policyConflict();
          }
          updated = await tx.managedEntityPublicationPolicy.create({
            data: {
              chatId: entityId,
              publikEnabled: request.publikEnabled ?? true,
              suggestionsViaPublik:
                entityType === 'channel' ? (request.suggestionsViaPublik ?? false) : false,
              updatedByUserId: user.userId,
            },
          });
        } else {
          const changed = await tx.managedEntityPublicationPolicy.updateMany({
            where: { chatId: entityId, revision: request.expectedRevision },
            data: {
              ...(request.publikEnabled !== undefined
                ? { publikEnabled: request.publikEnabled }
                : {}),
              ...(entityType === 'channel' && request.suggestionsViaPublik !== undefined
                ? { suggestionsViaPublik: request.suggestionsViaPublik }
                : {}),
              revision: { increment: 1 },
              updatedByUserId: user.userId,
            },
          });
          if (changed.count !== 1) {
            throw this.policyConflict();
          }
          updated = await tx.managedEntityPublicationPolicy.findUniqueOrThrow({
            where: { chatId: entityId },
          });
        }
        await tx.auditLog.create({
          data: {
            chatId: entityId,
            actorUserId: user.userId,
            action: 'UPDATE_PUBLICATION_POLICY',
            payload: {
              changed: {
                ...(request.publikEnabled !== undefined
                  ? { publikEnabled: request.publikEnabled }
                  : {}),
                ...(entityType === 'channel' && request.suggestionsViaPublik !== undefined
                  ? { suggestionsViaPublik: request.suggestionsViaPublik }
                  : {}),
              },
              revision: updated.revision,
            } satisfies Prisma.InputJsonValue,
          },
        });
        return updated;
      });
      return this.readinessService.resolvePolicy(policy);
    } catch (error: unknown) {
      if ((error as { code?: unknown })?.code === 'P2002') {
        throw this.policyConflict();
      }
      throw error;
    }
  }

  private presentEntity(
    source: {
      id: string;
      title: string;
      entityType: ChatEntityType;
      channelSettings: {
        commentsEnabled: boolean;
        postSuggestionsEnabled: boolean;
        commentsModerationEnabled: boolean;
      } | null;
      publicationPolicy: Parameters<PublisherReadinessService['resolvePolicy']>[0];
      publisherBinding: Parameters<
        PublisherReadinessService['resolveReadiness']
      >[0]['publisherBinding'];
    },
    runtimeAvailable: boolean,
  ): PublisherEntity {
    return publisherEntitySchema.parse({
      id: source.id,
      title: source.title,
      entityType: source.entityType === ChatEntityType.CHANNEL ? 'channel' : 'chat',
      avatarUrl: null,
      channelOverview:
        source.entityType === ChatEntityType.CHANNEL && source.channelSettings
          ? source.channelSettings
          : null,
      policy: this.readinessService.resolvePolicy(source.publicationPolicy),
      readiness: this.readinessService.resolveReadiness(source, { runtimeAvailable }),
    });
  }

  private policyConflict(): ConflictException {
    return new ConflictException({
      message: 'Publication policy changed. Refresh and retry.',
      code: 'PUBLISHER_POLICY_REVISION_CONFLICT',
    });
  }
}
