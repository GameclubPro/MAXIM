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
