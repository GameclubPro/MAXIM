import { Logger } from '@nestjs/common';
import type { MaxClientService } from '../max/max-client.service';
import {
  ChatBotAccessState,
  ChatBotMembershipStatus,
  ChatEntityType,
  Prisma,
} from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { publisherAccessProbeLifecycleSuperseded } from './publisher-access-probe-fence';

export class PublisherCatalogRefreshExecutor {
  private readonly logger = new Logger(PublisherCatalogRefreshExecutor.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly maxClient: MaxClientService,
    private readonly publisherBotId: string,
  ) {}
  async execute(
    chatId: string,
    fallbackEntityType: ChatEntityType,
    probeStartedAt: Date,
    committedBotAccessCheckedAt: Date,
    committedBotAccessState: ChatBotAccessState,
    requireHydration: boolean,
  ): Promise<{ entityType: ChatEntityType; committed: boolean }> {
    try {
      const snapshot = await this.maxClient.getChatSnapshot(chatId, {
        botId: this.publisherBotId,
        trafficClass: 'background',
        sourceTag: 'publisher_readiness',
        bypassCache: true,
        timeoutMs: 5_000,
      });
      const entityType =
        snapshot.entityType === 'channel'
          ? ChatEntityType.CHANNEL
          : snapshot.entityType === 'chat'
            ? ChatEntityType.CHAT
            : fallbackEntityType;
      const title = snapshot.title?.trim();
      const committed = await this.prisma.$transaction(async (tx) => {
        const chats = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          SELECT chat."id"
          FROM "chats" AS chat
          WHERE chat."id" = ${chatId}
          FOR UPDATE OF chat
        `);
        if (chats.length === 0) return false;
        const binding = await tx.publisherEntityBinding.findUnique({
          where: { chatId },
          select: {
            publisherBotId: true,
            status: true,
            lifecycleEventAt: true,
            lifecycleEventType: true,
            botAccessCheckedAt: true,
            botAccessState: true,
          },
        });
        if (
          !binding ||
          binding.publisherBotId !== this.publisherBotId ||
          binding.status !== ChatBotMembershipStatus.ACTIVE ||
          publisherAccessProbeLifecycleSuperseded(binding, probeStartedAt) ||
          binding.botAccessCheckedAt?.getTime() !== committedBotAccessCheckedAt.getTime() ||
          binding.botAccessState !== committedBotAccessState
        ) {
          return false;
        }
        await tx.managedBotChatCatalog.upsert({
          where: { botId_chatId: { botId: this.publisherBotId, chatId } },
          create: {
            botId: this.publisherBotId,
            chatId,
            entityType,
            title: title ?? null,
            link: snapshot.link,
            avatarUrl: snapshot.avatarUrl,
            status: 'ACTIVE',
            source: 'publisher_targeted_snapshot',
            lastSeenAt: probeStartedAt,
          },
          update: {
            entityType,
            ...(title ? { title } : {}),
            link: snapshot.link,
            avatarUrl: snapshot.avatarUrl,
            status: 'ACTIVE',
            source: 'publisher_targeted_snapshot',
            lastSeenAt: probeStartedAt,
          },
        });
        return true;
      });
      return { entityType, committed };
    } catch (error: unknown) {
      if (requireHydration) {
        throw error;
      }
      this.logger.warn(
        { chatId, err: error instanceof Error ? error.message : String(error) },
        'Publisher access refreshed but entity metadata hydration failed',
      );
      return { entityType: fallbackEntityType, committed: true };
    }
  }
}
