import { Injectable } from '@nestjs/common';
import type { ChatSummary, ManagedEntityType } from '@maxim/contracts';
import {
  ChatBotMembershipRole,
  ChatBotMembershipStatus,
  ChatEntityType,
  ManagedEntityAccessRole,
  ManagedEntityAccessState,
} from '../prisma/prisma-client';
import {
  ChatContextCacheService,
  type ManagedEntityPublishedSnapshotUpsert,
} from '../chat-context/chat-context-cache.service';
import { PrismaService } from '../prisma/prisma.service';
import { MaxBotLinkService } from './max-bot-link.service';
import type { MaxChatMemberAccess } from './max-client.service';
import { buildBotAccessSnapshotPersistence } from './bot-access-snapshot.util';

export const MANAGED_ENTITY_HANDSHAKE_SOURCE = 'handshake_start';

const HANDSHAKE_BOOTSTRAP_TTL_SEC = 15 * 60;
const HANDSHAKE_PUBLISHED_SNAPSHOT_TTL_SEC = 7 * 24 * 60 * 60;
const HANDSHAKE_ACCESS_EDGE_GRANTED_TTL_MS = 3 * 24 * 60 * 60 * 1_000;

export type ManagedEntityAccessWriteContext = {
  chatId: string;
  botId: string;
  senderId: string | null;
  title: string;
  link?: string | null;
  avatarUrl?: string | null;
  entityType: ManagedEntityType;
  prismaEntityType: ChatEntityType;
  createdAt: string | null;
};

@Injectable()
export class ManagedEntityAccessWriter {
  constructor(
    private readonly prisma: PrismaService,
    private readonly maxBotLinkService: MaxBotLinkService,
    private readonly chatContextCache: ChatContextCacheService,
  ) {}

  async bootstrapChat(context: ManagedEntityAccessWriteContext): Promise<void> {
    await this.maxBotLinkService.bindDiscoveredChatBots({
      chatId: context.chatId,
      primaryBotId: context.botId,
      botIds: [context.botId],
      title: context.title,
      entityType: context.prismaEntityType,
    });

    const catalog = (
      this.prisma as PrismaService & {
        managedBotChatCatalog?: {
          upsert?: (args: unknown) => Promise<unknown>;
        };
      }
    ).managedBotChatCatalog;
    if (typeof catalog?.upsert === 'function') {
      const now = new Date();
      await catalog.upsert({
        where: {
          botId_chatId: {
            botId: context.botId,
            chatId: context.chatId,
          },
        },
        create: {
          botId: context.botId,
          chatId: context.chatId,
          entityType: context.prismaEntityType,
          title: context.title,
          link: context.link ?? null,
          avatarUrl: context.avatarUrl ?? null,
          status: 'ACTIVE',
          source: MANAGED_ENTITY_HANDSHAKE_SOURCE,
          lastSeenAt: now,
        },
        update: {
          entityType: context.prismaEntityType,
          title: context.title,
          ...(context.link !== undefined ? { link: context.link } : {}),
          ...(context.avatarUrl !== undefined ? { avatarUrl: context.avatarUrl } : {}),
          status: 'ACTIVE',
          source: MANAGED_ENTITY_HANDSHAKE_SOURCE,
          lastSeenAt: now,
        },
      });
    }

    await this.chatContextCache.upsertManagedEntitiesRecentBootstrap(
      this.buildChatSummary(context),
      HANDSHAKE_BOOTSTRAP_TTL_SEC,
      context.senderId,
    );
  }

  async persistGrantedAccess(
    context: ManagedEntityAccessWriteContext & { senderId: string },
    botAccess: MaxChatMemberAccess,
    userAccess: MaxChatMemberAccess,
  ): Promise<boolean> {
    await this.bootstrapChat(context);

    const now = new Date();
    const expiresAt = new Date(now.getTime() + HANDSHAKE_ACCESS_EDGE_GRANTED_TTL_MS);
    const botAccessSnapshot = buildBotAccessSnapshotPersistence(botAccess, {
      source: MANAGED_ENTITY_HANDSHAKE_SOURCE,
      now,
    });
    const existing = await this.prisma.managedEntityAccessEdge.findUnique({
      where: {
        chatId_userId_botId: {
          chatId: context.chatId,
          userId: context.senderId,
          botId: context.botId,
        },
      },
      select: { state: true },
    });

    await this.prisma.$transaction([
      this.prisma.chatBotMembership.upsert({
        where: {
          chatId_botId: {
            chatId: context.chatId,
            botId: context.botId,
          },
        },
        create: {
          chatId: context.chatId,
          botId: context.botId,
          role: ChatBotMembershipRole.PRIMARY,
          status: ChatBotMembershipStatus.ACTIVE,
          ...botAccessSnapshot,
          lastSeenAt: now,
          lastWebhookAt: now,
        },
        update: {
          status: ChatBotMembershipStatus.ACTIVE,
          ...botAccessSnapshot,
          lastSeenAt: now,
          lastWebhookAt: now,
        },
      }),
      this.prisma.chatAdminAllowlist.upsert({
        where: {
          chatId_userId: {
            chatId: context.chatId,
            userId: context.senderId,
          },
        },
        create: {
          chatId: context.chatId,
          userId: context.senderId,
        },
        update: {},
      }),
      this.prisma.managedEntityAdminMember.upsert({
        where: {
          chatId_userId_observedByBotId: {
            chatId: context.chatId,
            userId: context.senderId,
            observedByBotId: context.botId,
          },
        },
        create: {
          chatId: context.chatId,
          userId: context.senderId,
          observedByBotId: context.botId,
          entityType: context.prismaEntityType,
          role: this.toAccessRole(userAccess),
          permissions: this.normalizePermissions(userAccess.permissions),
          checkedAt: now,
          expiresAt,
          source: MANAGED_ENTITY_HANDSHAKE_SOURCE,
        },
        update: {
          entityType: context.prismaEntityType,
          role: this.toAccessRole(userAccess),
          permissions: this.normalizePermissions(userAccess.permissions),
          checkedAt: now,
          expiresAt,
          source: MANAGED_ENTITY_HANDSHAKE_SOURCE,
        },
      }),
      this.prisma.managedEntityAccessEdge.upsert({
        where: {
          chatId_userId_botId: {
            chatId: context.chatId,
            userId: context.senderId,
            botId: context.botId,
          },
        },
        create: {
          chatId: context.chatId,
          userId: context.senderId,
          botId: context.botId,
          entityType: context.prismaEntityType,
          state: ManagedEntityAccessState.GRANTED,
          userRole: this.toAccessRole(userAccess),
          botRole: this.toAccessRole(botAccess),
          checkedAt: now,
          expiresAt,
          source: MANAGED_ENTITY_HANDSHAKE_SOURCE,
        },
        update: {
          entityType: context.prismaEntityType,
          state: ManagedEntityAccessState.GRANTED,
          userRole: this.toAccessRole(userAccess),
          botRole: this.toAccessRole(botAccess),
          checkedAt: now,
          expiresAt,
          deniedReason: null,
          lastMaxErrorCode: null,
          lastMaxErrorMessage: null,
          lastMaxStatusCode: null,
          source: MANAGED_ENTITY_HANDSHAKE_SOURCE,
        },
      }),
      this.prisma.managedEntityLocalActivity.upsert({
        where: {
          userId_chatId: {
            userId: context.senderId,
            chatId: context.chatId,
          },
        },
        create: {
          userId: context.senderId,
          chatId: context.chatId,
          entityType: context.prismaEntityType,
          chatTitle: context.title,
          sourceEventType: MANAGED_ENTITY_HANDSHAKE_SOURCE,
          botId: context.botId,
          lastEventAt: now,
        },
        update: {
          entityType: context.prismaEntityType,
          chatTitle: context.title,
          sourceEventType: MANAGED_ENTITY_HANDSHAKE_SOURCE,
          botId: context.botId,
          lastEventAt: now,
        },
      }),
    ]);
    await this.maxBotLinkService.reconcileChatPrimaryByAccess?.({
      chatId: context.chatId,
      title: context.title,
      entityType: context.prismaEntityType,
    });

    await Promise.all([
      this.chatContextCache.setAdminAccess(context.chatId, context.senderId, 'granted'),
      this.chatContextCache.rememberChatAdminUser(context.chatId, context.senderId),
    ]);

    return existing?.state === ManagedEntityAccessState.GRANTED;
  }

  async patchUserVisibleState(
    context: ManagedEntityAccessWriteContext & { senderId: string },
  ): Promise<void> {
    await this.chatContextCache.upsertManagedEntityPublishedSnapshot(
      context.senderId,
      this.buildPublishedSnapshotUpsert(context),
      HANDSHAKE_PUBLISHED_SNAPSHOT_TTL_SEC,
    );
  }

  private buildPublishedSnapshotUpsert(
    context: ManagedEntityAccessWriteContext,
  ): ManagedEntityPublishedSnapshotUpsert {
    return {
      ...this.buildChatSummaryBase(context),
      ...(context.link !== undefined ? { link: context.link } : {}),
      ...(context.avatarUrl !== undefined ? { avatarUrl: context.avatarUrl } : {}),
    };
  }

  private buildChatSummary(context: ManagedEntityAccessWriteContext): ChatSummary {
    return {
      ...this.buildChatSummaryBase(context),
      link: context.link ?? null,
      avatarUrl: context.avatarUrl ?? null,
    };
  }

  private buildChatSummaryBase(
    context: ManagedEntityAccessWriteContext,
  ): Omit<ChatSummary, 'link' | 'avatarUrl'> {
    return {
      id: context.chatId,
      title: context.title,
      createdAt: context.createdAt ?? new Date().toISOString(),
      entityType: context.entityType,
      primaryBotId: context.botId,
      assignedBots: [],
      sharedMode: 'owned',
      channelOverview: null,
    };
  }

  private toAccessRole(access: MaxChatMemberAccess): ManagedEntityAccessRole {
    if (access.isOwner) {
      return ManagedEntityAccessRole.OWNER;
    }
    if (access.isAdmin) {
      return ManagedEntityAccessRole.ADMIN;
    }
    return ManagedEntityAccessRole.MEMBER;
  }

  private normalizePermissions(permissions: readonly string[]): string[] {
    return Array.from(
      new Set(
        permissions
          .map((permission) => permission.trim())
          .filter((permission) => permission.length > 0),
      ),
    );
  }
}
