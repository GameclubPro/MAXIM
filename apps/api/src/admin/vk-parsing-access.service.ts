import type { VkParsingCapability } from '@maxim/contracts';
import { Injectable, NotFoundException } from '@nestjs/common';
import { type AuthUser } from '../common/decorators/current-user.decorator';
import { ChatEntityType } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { AdminService } from './admin.service';

@Injectable()
export class VkParsingAccessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly adminService: AdminService,
  ) {}

  async getCapability(chatId: string, user: AuthUser): Promise<VkParsingCapability> {
    const chat = await this.prisma.chat.findUnique({
      where: { id: chatId },
      select: { entityType: true },
    });
    if (!chat) {
      return { enabled: true, canUse: false };
    }

    try {
      await this.adminService.assertChatAdmin(
        chatId,
        user.userId,
        this.resolveAdminEntityType(chat.entityType),
      );
    } catch {
      return { enabled: true, canUse: false };
    }

    return { enabled: true, canUse: true };
  }

  async assertAccess(chatId: string, user: AuthUser): Promise<ChatEntityType> {
    const chat = await this.prisma.chat.findUnique({
      where: { id: chatId },
      select: { entityType: true },
    });
    if (!chat) {
      throw new NotFoundException('Чат или канал не найден.');
    }

    await this.adminService.assertChatAdmin(
      chatId,
      user.userId,
      this.resolveAdminEntityType(chat.entityType),
    );
    return chat.entityType;
  }

  async resolvePublicationEntityType(chatId: string): Promise<ChatEntityType | null> {
    const chat = await this.prisma.chat.findUnique({
      where: { id: chatId },
      select: { entityType: true },
    });
    return chat?.entityType ?? null;
  }

  private resolveAdminEntityType(entityType: ChatEntityType): 'chat' | 'channel' {
    return entityType === ChatEntityType.CHANNEL ? 'channel' : 'chat';
  }
}
