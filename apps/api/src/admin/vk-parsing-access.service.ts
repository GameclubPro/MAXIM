import type { VkParsingCapability } from '@maxim/contracts';
import { Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { type AuthUser } from '../common/decorators/current-user.decorator';
import { ChatEntityType } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { PublisherPolicyService } from './publisher-policy.service';

@Injectable()
export class VkParsingAccessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly publisherPolicyService: PublisherPolicyService,
    private readonly configService: ConfigService,
  ) {}

  async getCapability(chatId: string, user: AuthUser): Promise<VkParsingCapability> {
    const chat = await this.prisma.chat.findUnique({
      where: { id: chatId },
      select: { entityType: true },
    });
    if (!chat) {
      return {
        enabled: true,
        canUse: false,
        reasonCode: 'NOT_FOUND',
        reason: 'Чат или канал не найден.',
      };
    }

    try {
      await this.publisherPolicyService.getEntity(
        this.resolvePublisherEntityType(chat.entityType),
        chatId,
        user,
      );
    } catch {
      return {
        enabled: true,
        canUse: false,
        reasonCode: 'ACCESS_DENIED',
        reason: 'Недостаточно прав администратора.',
      };
    }

    if (!this.hasVkServiceToken()) {
      return {
        enabled: false,
        canUse: false,
        reasonCode: 'NOT_CONFIGURED',
        reason: 'VK_SERVICE_TOKEN не настроен на сервере.',
      };
    }

    return { enabled: true, canUse: true, reasonCode: null, reason: null };
  }

  async assertAccess(chatId: string, user: AuthUser): Promise<ChatEntityType> {
    const chat = await this.prisma.chat.findUnique({
      where: { id: chatId },
      select: { entityType: true },
    });
    if (!chat) {
      throw new NotFoundException('Чат или канал не найден.');
    }

    await this.publisherPolicyService.getEntity(
      this.resolvePublisherEntityType(chat.entityType),
      chatId,
      user,
    );
    this.assertConfigured();
    return chat.entityType;
  }

  async resolvePublicationEntityType(chatId: string): Promise<ChatEntityType | null> {
    const chat = await this.prisma.chat.findUnique({
      where: { id: chatId },
      select: { entityType: true },
    });
    return chat?.entityType ?? null;
  }

  private resolvePublisherEntityType(entityType: ChatEntityType): 'chat' | 'channel' {
    return entityType === ChatEntityType.CHANNEL ? 'channel' : 'chat';
  }

  private hasVkServiceToken(): boolean {
    return Boolean(this.configService.get<string>('VK_SERVICE_TOKEN')?.trim());
  }

  private assertConfigured(): void {
    if (this.hasVkServiceToken()) {
      return;
    }

    throw new ServiceUnavailableException('VK_SERVICE_TOKEN не настроен на сервере.');
  }
}
