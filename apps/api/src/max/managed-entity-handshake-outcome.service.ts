import { Injectable, Logger } from '@nestjs/common';
import { ChatEntityType, ManagedEntityHandshakeOutcomeStatus } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';

export type ManagedEntityHandshakeOutcomeWrite = {
  chatId: string;
  userId: string;
  botId: string;
  entityType: ChatEntityType;
  status: ManagedEntityHandshakeOutcomeStatus;
  reason?: string | null;
  title?: string | null;
  source?: string | null;
};

const HANDSHAKE_OUTCOME_TTL_MS = 24 * 60 * 60 * 1_000;

@Injectable()
export class ManagedEntityHandshakeOutcomeService {
  private readonly logger = new Logger(ManagedEntityHandshakeOutcomeService.name);

  constructor(private readonly prisma: PrismaService) {}

  async recordOutcome(params: ManagedEntityHandshakeOutcomeWrite): Promise<void> {
    const chatId = params.chatId.trim();
    const userId = params.userId.trim();
    const botId = params.botId.trim();
    if (!chatId || !userId || !botId) {
      return;
    }

    const now = new Date();
    const expiresAt = new Date(now.getTime() + HANDSHAKE_OUTCOME_TTL_MS);
    try {
      await this.prisma.managedEntityHandshakeOutcome.upsert({
        where: {
          chatId_userId_botId: {
            chatId,
            userId,
            botId,
          },
        },
        create: {
          chatId,
          userId,
          botId,
          entityType: params.entityType,
          status: params.status,
          reason: params.reason ?? null,
          title: params.title?.trim() || null,
          source: params.source?.trim() || 'handshake_start',
          happenedAt: now,
          expiresAt,
        },
        update: {
          entityType: params.entityType,
          status: params.status,
          reason: params.reason ?? null,
          title: params.title?.trim() || null,
          source: params.source?.trim() || 'handshake_start',
          happenedAt: now,
          expiresAt,
        },
      });
    } catch (error: unknown) {
      this.logger.debug(
        {
          chatId,
          userId,
          botId,
          status: params.status,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to record managed entity handshake outcome',
      );
    }
  }
}
