import { Injectable, Logger } from '@nestjs/common';
import { ChatEntityType, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  isValidMaxBotStartPayload,
  isValidMaxMiniappStartPayload,
} from './max-deep-link.util';
import { MaxBotContextService } from './max-bot-context.service';
import { MaxBotRegistryService, type MaxBotDefinition } from './max-bot-registry.service';

const CHAT_BOT_CACHE_TTL_MS = 10 * 60 * 1_000;

type ChatBotBindingCacheEntry = {
  botId: string;
  expiresAtMs: number;
};

@Injectable()
export class MaxBotLinkService {
  private readonly logger = new Logger(MaxBotLinkService.name);
  private readonly chatBotBindingCache = new Map<string, ChatBotBindingCacheEntry>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly botRegistry: MaxBotRegistryService,
    private readonly botContext: MaxBotContextService,
  ) {}

  getDefaultBotId(): string {
    return this.botRegistry.getDefaultBot().id;
  }

  getContextOrDefaultBotId(): string {
    return this.botContext.getActiveBotId() ?? this.getDefaultBotId();
  }

  getResolvedBotSync(botId?: string | null): MaxBotDefinition {
    return (
      this.botRegistry.getBotById(botId) ??
      this.botRegistry.getBotById(this.botContext.getActiveBotId()) ??
      this.botRegistry.getDefaultBot()
    );
  }

  getBotTokenSync(botId?: string | null): string {
    return this.getResolvedBotSync(botId).token;
  }

  resolveBotIdSync(botId?: string | null, chatId?: string | null): string {
    const explicitBot = this.botRegistry.getBotById(botId);
    if (explicitBot) {
      return explicitBot.id;
    }

    const contextBotId = this.botContext.getActiveBotId();
    if (contextBotId) {
      return contextBotId;
    }

    const cachedBotId = this.getCachedChatBotId(chatId);
    if (cachedBotId) {
      return cachedBotId;
    }

    return this.getDefaultBotId();
  }

  getValidationTokens(botId?: string | null): readonly string[] {
    return botId
      ? this.botRegistry.getValidationTokensForBot(botId)
      : this.botRegistry.getValidationTokens();
  }

  isKnownBotUserId(userId: string | null | undefined): boolean {
    return this.botRegistry.isKnownBotUserId(userId);
  }

  async resolveBotId(options: { chatId?: string | null; botId?: string | null } = {}): Promise<string> {
    const explicitBot = this.botRegistry.getBotById(options.botId);
    if (explicitBot) {
      return explicitBot.id;
    }

    const contextBotId = this.botContext.getActiveBotId();
    if (contextBotId) {
      return contextBotId;
    }

    const chatId = typeof options.chatId === 'string' ? options.chatId.trim() : '';
    if (chatId) {
      const cachedBotId = this.getCachedChatBotId(chatId);
      if (cachedBotId) {
        return cachedBotId;
      }

      const chat = await this.prisma.chat.findUnique({
        where: { id: chatId },
        select: { botId: true },
      });
      const chatBot = this.botRegistry.getBotById(chat?.botId ?? null);
      if (chatBot) {
        this.rememberChatBotBinding(chatId, chatBot.id);
        return chatBot.id;
      }
    }

    return this.getDefaultBotId();
  }

  resolveContactIdSync(botId?: string | null): string | null {
    const bot = this.getResolvedBotSync(botId);
    return bot.contactId;
  }

  buildMiniappStartUrlSync(startParam: string, botId?: string | null): string | null {
    if (!isValidMaxMiniappStartPayload(startParam)) {
      return null;
    }

    const resolvedBotId = this.resolveBotIdSync(botId);
    return `https://max.ru/${encodeURIComponent(resolvedBotId)}?startapp=${encodeURIComponent(startParam)}`;
  }

  buildBotStartUrlSync(startPayload: string, botId?: string | null): string | null {
    if (!isValidMaxBotStartPayload(startPayload)) {
      return null;
    }

    const resolvedBotId = this.resolveBotIdSync(botId);
    return `https://max.ru/${encodeURIComponent(resolvedBotId)}?start=${encodeURIComponent(startPayload)}`;
  }

  rememberChatBotBinding(chatId: string, botId: string | null | undefined): void {
    const normalizedChatId = chatId.trim();
    const normalizedBotId = this.botRegistry.getBotById(botId)?.id ?? null;
    if (!normalizedChatId || !normalizedBotId) {
      return;
    }

    this.chatBotBindingCache.set(normalizedChatId, {
      botId: normalizedBotId,
      expiresAtMs: Date.now() + CHAT_BOT_CACHE_TTL_MS,
    });
  }

  async resolveContactId(options: { chatId?: string | null; botId?: string | null } = {}): Promise<string | null> {
    return this.resolveContactIdSync(await this.resolveBotId(options));
  }

  async buildMiniappStartUrl(
    startParam: string,
    options: { chatId?: string | null; botId?: string | null } = {},
  ): Promise<string | null> {
    if (!isValidMaxMiniappStartPayload(startParam)) {
      return null;
    }

    const botId = await this.resolveBotId(options);
    return `https://max.ru/${encodeURIComponent(botId)}?startapp=${encodeURIComponent(startParam)}`;
  }

  async buildBotStartUrl(
    startPayload: string,
    options: { chatId?: string | null; botId?: string | null } = {},
  ): Promise<string | null> {
    if (!isValidMaxBotStartPayload(startPayload)) {
      return null;
    }

    const botId = await this.resolveBotId(options);
    return `https://max.ru/${encodeURIComponent(botId)}?start=${encodeURIComponent(startPayload)}`;
  }

  async bindChatToBot(params: {
    chatId: string;
    title?: string | null;
    entityType?: ChatEntityType | null;
    botId?: string | null;
    allowReassign?: boolean;
  }): Promise<void> {
    const chatId = params.chatId.trim();
    if (!chatId) {
      return;
    }

    const botId = await this.resolveBotId({ chatId, botId: params.botId });
    const title = params.title?.trim() || `Chat ${chatId}`;
    const entityType = params.entityType ?? undefined;

    try {
      await this.prisma.chat.create({
        data: {
          id: chatId,
          title,
          botId,
          ...(entityType ? { entityType } : {}),
        },
      });
      this.rememberChatBotBinding(chatId, botId);
      return;
    } catch (error: unknown) {
      if (!this.isPrismaKnownError(error, 'P2002')) {
        throw error;
      }
    }

    const updated = await this.prisma.chat.updateMany({
      where: {
        id: chatId,
        ...(params.allowReassign === true
          ? {}
          : {
              OR: [{ botId: null }, { botId }],
            }),
      },
      data: {
        title,
        botId,
        ...(entityType ? { entityType } : {}),
      },
    });

    if (updated.count > 0) {
      this.rememberChatBotBinding(chatId, botId);
      return;
    }

    const existing = await this.prisma.chat.findUnique({
      where: { id: chatId },
      select: { botId: true },
    });
    this.rememberChatBotBinding(chatId, existing?.botId ?? null);
    if ((existing?.botId ?? null) !== botId) {
      this.logger.warn(
        {
          chatId,
          existingBotId: existing?.botId ?? null,
          incomingBotId: botId,
        },
        'Skipped chat bot reassignment because the chat is already bound to another bot',
      );
    }
  }

  private isPrismaKnownError(error: unknown, code: string): boolean {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      return error.code === code;
    }

    return (error as { code?: string } | null)?.code === code;
  }

  private getCachedChatBotId(chatId: string | null | undefined): string | null {
    const normalizedChatId = typeof chatId === 'string' ? chatId.trim() : '';
    if (!normalizedChatId) {
      return null;
    }

    const cached = this.chatBotBindingCache.get(normalizedChatId);
    if (!cached) {
      return null;
    }

    if (cached.expiresAtMs < Date.now()) {
      this.chatBotBindingCache.delete(normalizedChatId);
      return null;
    }

    return cached.botId;
  }
}
