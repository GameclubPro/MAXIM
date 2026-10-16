import { ChatEntityType } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import type { ManagedChannelContext } from './moderation.service.support';

export async function loadManagedChannelAutoPostContext(
  prisma: PrismaService,
  chatId: string,
  chatTitle?: string,
): Promise<ManagedChannelContext | null> {
  if (typeof prisma.chat.findUnique !== 'function') {
    return null;
  }

  let channel = await prisma.chat.findUnique({
    where: { id: chatId },
    include: {
      channelSettings: true,
      admins: {
        select: {
          userId: true,
        },
      },
    },
  });

  if (!channel || channel.entityType !== ChatEntityType.CHANNEL) {
    return null;
  }

  if (!channel.channelSettings || (chatTitle?.trim() && channel.title !== chatTitle.trim())) {
    if (typeof prisma.chat.update !== 'function') {
      return channel.channelSettings
        ? {
            channelSettings: channel.channelSettings,
            adminUserIds: channel.admins.map((item) => item.userId),
          }
        : null;
    }

    channel = await prisma.chat.update({
      where: { id: chatId },
      data: {
        ...(chatTitle?.trim()
          ? {
              title: chatTitle.trim(),
            }
          : {}),
        channelSettings: {
          upsert: {
            update: {},
            create: {
              commentsEnabled: false,
            },
          },
        },
      },
      include: {
        channelSettings: true,
        admins: {
          select: {
            userId: true,
          },
        },
      },
    });
  }

  if (!channel.channelSettings) {
    return null;
  }

  return {
    channelSettings: channel.channelSettings,
    adminUserIds: channel.admins.map((item) => item.userId),
  };
}

export async function loadChannelAutoPostScanContexts(
  prisma: PrismaService,
  chatIds: readonly string[],
): Promise<ManagedChannelContext[]> {
  const normalizedChatIds = Array.from(
    new Set(chatIds.map((chatId) => chatId.trim()).filter((chatId) => chatId.length > 0)),
  );
  if (normalizedChatIds.length === 0) {
    return [];
  }

  const channelSettings = await prisma.channelSettings.findMany({
    where: {
      chatId: {
        in: normalizedChatIds,
      },
      chat: {
        entityType: ChatEntityType.CHANNEL,
      },
    },
    include: {
      chat: {
        select: {
          admins: {
            select: {
              userId: true,
            },
          },
        },
      },
    },
  });
  const contextsByChatId = new Map(
    channelSettings.map((settings) => [
      settings.chatId,
      {
        channelSettings: settings,
        adminUserIds: settings.chat.admins.map((item) => item.userId),
      } satisfies ManagedChannelContext,
    ]),
  );

  return normalizedChatIds.flatMap((chatId) => {
    const context = contextsByChatId.get(chatId);
    return context ? [context] : [];
  });
}
