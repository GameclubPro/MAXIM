import { Injectable } from '@nestjs/common';
import type { ChatSummary, ManagedEntityType } from '@maxim/contracts';
import {
  ChatEntityType,
  ManagedEntityAccessRole,
  ManagedEntityAccessState,
  Prisma,
} from '../prisma/prisma-client';
import {
  ChatContextCacheService,
  type ManagedEntitiesPublishedSnapshot,
} from '../chat-context/chat-context-cache.service';
import { PrismaService } from '../prisma/prisma.service';
import { MaxBotLinkService } from './max-bot-link.service';
import type { MaxChatMemberAccess } from './max-client.service';

export const MANAGED_ENTITY_HANDSHAKE_SOURCE = 'handshake_start';

const HANDSHAKE_BOOTSTRAP_TTL_SEC = 15 * 60;
const HANDSHAKE_PUBLISHED_SNAPSHOT_TTL_SEC = 7 * 24 * 60 * 60;
const HANDSHAKE_ACCESS_EDGE_GRANTED_TTL_MS = 3 * 24 * 60 * 60 * 1_000;

export type ManagedEntityAccessWriteContext = {
  chatId: string;
  botId: string;
  senderId: string | null;
  title: string;
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

    const catalog = (this.prisma as PrismaService & {
      managedBotChatCatalog?: {
        upsert?: (args: unknown) => Promise<unknown>;
      };
    }).managedBotChatCatalog;
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
          status: 'ACTIVE',
          source: MANAGED_ENTITY_HANDSHAKE_SOURCE,
          lastSeenAt: now,
        },
        update: {
          entityType: context.prismaEntityType,
          title: context.title,
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
      this.prisma.chatBotMembership.updateMany({
        where: {
          chatId: context.chatId,
          botId: context.botId,
        },
        data: {
          permissionsSnapshot: this.buildPermissionsSnapshot(botAccess),
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

    return existing?.state === ManagedEntityAccessState.GRANTED;
  }

  async patchUserVisibleState(
    context: ManagedEntityAccessWriteContext & { senderId: string },
  ): Promise<void> {
    const summary = this.buildChatSummary(context);
    const existing = await this.chatContextCache.getManagedEntitiesPublishedSnapshot(
      context.senderId,
      context.entityType,
    );
    const nowIso = new Date().toISOString();
    const items = [
      summary,
      ...((existing?.items ?? []).filter((item) => item.id.trim() !== context.chatId)),
    ];
    const snapshot: ManagedEntitiesPublishedSnapshot = {
      version: `handshake:${context.chatId}:${Date.now()}`,
      builtAt: nowIso,
      lastSyncedAt: nowIso,
      itemCount: items.length,
      itemsHash: this.buildItemsHash(items),
      items,
    };
    await this.chatContextCache.setManagedEntitiesPublishedSnapshot(
      context.senderId,
      context.entityType,
      snapshot,
      HANDSHAKE_PUBLISHED_SNAPSHOT_TTL_SEC,
    );
  }

  private buildChatSummary(context: ManagedEntityAccessWriteContext): ChatSummary {
    return {
      id: context.chatId,
      title: context.title,
      createdAt: context.createdAt ?? new Date().toISOString(),
      entityType: context.entityType,
      link: null,
      primaryBotId: context.botId,
      assignedBots: [],
      sharedMode: 'owned',
      channelOverview: null,
    };
  }

  private buildItemsHash(items: readonly ChatSummary[]): string {
    return Buffer.from(
      JSON.stringify(items.map((item) => [item.entityType, item.id, item.title])),
    )
      .toString('base64url')
      .slice(0, 64);
  }

  private buildPermissionsSnapshot(access: MaxChatMemberAccess): Prisma.InputJsonObject {
    return {
      isAdmin: access.isAdmin,
      isOwner: access.isOwner,
      permissions: access.permissions,
      checkedAt: new Date().toISOString(),
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
}
