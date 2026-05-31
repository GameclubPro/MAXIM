import { Injectable, Logger, Optional } from '@nestjs/common';
import type { ManagedEntityType } from '@maxim/contracts';
import { ChatEntityType, ManagedEntityAccessState, type Prisma } from '../prisma/prisma-client';
import { ChatContextCacheService } from '../chat-context/chat-context-cache.service';
import { PrismaService } from '../prisma/prisma.service';
import { NightModeTransitionSchedulerService } from '../moderation/night-mode-transition-scheduler.service';
import { MaxBotLinkService } from './max-bot-link.service';

export type ManagedEntityAccessLossReason =
  | 'chat_not_found'
  | 'chat_denied'
  | 'bot_not_chat_member'
  | 'chat_inaccessible';

export type MaxTerminalChatActionErrorClassification = {
  kind: 'managed_entity_access_lost' | 'message_not_found' | 'terminal_unknown';
  reason?: ManagedEntityAccessLossReason;
  statusCode: number | null;
  code: string | null;
  message: string;
};

export type RecordManagedEntityAccessLostParams = {
  chatId: string;
  botId?: string | null;
  entityType?: ChatEntityType | null;
  title?: string | null;
  reason: ManagedEntityAccessLossReason;
  source: string;
};

export type RecordManagedEntityAccessLostResult = {
  chatId: string;
  botId: string | null;
  nextOwnerBotId: string | null;
  updatedAccessEdges: number | null;
};

@Injectable()
export class ManagedEntityAccessLossService {
  private readonly logger = new Logger(ManagedEntityAccessLossService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly maxBotLinkService: MaxBotLinkService,
    private readonly chatContextCache: ChatContextCacheService,
    @Optional()
    private readonly nightModeTransitionScheduler?: NightModeTransitionSchedulerService,
  ) {}

  async recordManagedEntityAccessLost(
    params: RecordManagedEntityAccessLostParams,
  ): Promise<RecordManagedEntityAccessLostResult | null> {
    const chatId = params.chatId.trim();
    if (!chatId) {
      return null;
    }

    const chat = await this.prisma.chat.findUnique({
      where: { id: chatId },
      select: {
        title: true,
        entityType: true,
      },
    });
    const botId = await this.resolveBotId(chatId, params.botId);
    const title = params.title?.trim() || chat?.title || `Chat ${chatId}`;
    const entityType = params.entityType ?? chat?.entityType ?? null;
    const nextOwnerBotId = botId
      ? await this.maxBotLinkService.markChatBotRemoved({
          chatId,
          botId,
          title,
          entityType,
        })
      : null;
    const updatedAccessEdges = await this.markAccessEdgesBotDenied({
      chatId,
      botId,
      reason: params.reason,
      source: params.source,
    });

    await Promise.all([
      this.chatContextCache.invalidate(chatId),
      this.chatContextCache.clearManagedEntitiesRecentBootstrapForChat(
        chatId,
        mapManagedEntityType(entityType),
      ),
      this.nightModeTransitionScheduler?.clearChatJobs(chatId) ?? Promise.resolve(),
    ]);

    this.logger.warn(
      {
        chatId,
        botId,
        nextOwnerBotId,
        reason: params.reason,
        source: params.source,
        updatedAccessEdges,
      },
      'Recorded managed entity access lost',
    );

    return {
      chatId,
      botId,
      nextOwnerBotId,
      updatedAccessEdges,
    };
  }

  private async resolveBotId(
    chatId: string,
    botId: string | null | undefined,
  ): Promise<string | null> {
    const explicit = this.readTrimmedString(botId);
    if (explicit) {
      return explicit;
    }

    try {
      const resolved = await this.maxBotLinkService.resolveBotId({ chatId });
      return this.readTrimmedString(resolved);
    } catch {
      return null;
    }
  }

  private async markAccessEdgesBotDenied(params: {
    chatId: string;
    botId: string | null;
    reason: string;
    source: string;
  }): Promise<number | null> {
    if (typeof this.prisma.managedEntityAccessEdge?.updateMany !== 'function') {
      return null;
    }

    const result = await this.prisma.managedEntityAccessEdge.updateMany({
      where: {
        chatId: params.chatId,
        ...(params.botId ? { botId: params.botId } : {}),
      },
      data: {
        state: ManagedEntityAccessState.BOT_DENIED,
        botRole: 'MEMBER',
        checkedAt: new Date(),
        expiresAt: null,
        deniedReason: params.reason,
        source: params.source,
      } satisfies Prisma.ManagedEntityAccessEdgeUpdateManyMutationInput,
    });

    return typeof result.count === 'number' ? result.count : null;
  }

  private readTrimmedString(value: string | null | undefined): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
  }
}

export function classifyMaxTerminalChatActionError(
  error: unknown,
): MaxTerminalChatActionErrorClassification | null {
  const statusCode = extractMaxErrorStatus(error);
  const code = extractMaxErrorCode(error);
  const message = extractMaxErrorMessage(error);

  if (code === 'message.not.found' || message.includes('message not found')) {
    return {
      kind: 'message_not_found',
      statusCode,
      code,
      message,
    };
  }

  if (code === 'chat.not.found' || message.includes('chat not found')) {
    return {
      kind: 'managed_entity_access_lost',
      reason: 'chat_not_found',
      statusCode,
      code,
      message,
    };
  }

  if (code === 'chat.denied') {
    return {
      kind: 'managed_entity_access_lost',
      reason: 'chat_denied',
      statusCode,
      code,
      message,
    };
  }

  if (message.includes('bot is not a chat member')) {
    return {
      kind: 'managed_entity_access_lost',
      reason: 'bot_not_chat_member',
      statusCode,
      code,
      message,
    };
  }

  if (message.includes('not accessible')) {
    return {
      kind: 'managed_entity_access_lost',
      reason: 'chat_inaccessible',
      statusCode,
      code,
      message,
    };
  }

  if (statusCode === 403 || statusCode === 404) {
    return {
      kind: 'terminal_unknown',
      statusCode,
      code,
      message,
    };
  }

  return null;
}

export function extractMaxErrorStatus(error: unknown): number | null {
  const maybeStatus = (error as { response?: { status?: number } })?.response?.status;
  return typeof maybeStatus === 'number' ? maybeStatus : null;
}

export function extractMaxErrorCode(error: unknown): string | null {
  const maybeCode = (error as { response?: { data?: { code?: unknown } } })?.response?.data?.code;
  return typeof maybeCode === 'string' && maybeCode.trim().length > 0
    ? maybeCode.trim().toLowerCase()
    : null;
}

export function extractMaxErrorMessage(error: unknown): string {
  const responseMessage = (error as { response?: { data?: { message?: unknown } } })?.response?.data
    ?.message;
  if (typeof responseMessage === 'string' && responseMessage.trim().length > 0) {
    return responseMessage.trim().toLowerCase();
  }

  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message.trim().toLowerCase();
  }

  return String(error).trim().toLowerCase();
}

function mapManagedEntityType(entityType: ChatEntityType | null): ManagedEntityType | null {
  if (entityType === ChatEntityType.CHAT) {
    return 'chat';
  }
  if (entityType === ChatEntityType.CHANNEL) {
    return 'channel';
  }
  return null;
}
