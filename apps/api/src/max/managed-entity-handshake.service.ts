import { Injectable, Logger } from '@nestjs/common';
import type { ManagedEntityType, MaxUpdate } from '@maxim/contracts';
import { ChatEntityType } from '../prisma/prisma-client';
import { isPrivateDirectChatId } from '../common/chat-id.util';
import {
  MAX_API_SOURCE_TAGS,
  MaxClientService,
  type MaxChatMemberAccess,
} from './max-client.service';
import { MaxBotLinkService } from './max-bot-link.service';
import { MaxBotRegistryService } from './max-bot-registry.service';
import { MaxChatAdminRosterSyncService } from './max-chat-admin-roster-sync.service';
import {
  ManagedEntityAccessWriter,
  MANAGED_ENTITY_HANDSHAKE_SOURCE,
  type ManagedEntityAccessWriteContext,
} from './managed-entity-access-writer.service';

const HANDSHAKE_COMMAND = 'старт';
export const MANAGED_ENTITY_HANDSHAKE_START_CALLBACK_PAYLOAD =
  'managed_entity_handshake:start_hint';
const HANDSHAKE_RATE_LIMIT_MS = 3 * 60 * 1_000;
const HANDSHAKE_ACCESS_TIMEOUT_MS = 1_500;
const HANDSHAKE_SEND_TIMEOUT_MS = 1_500;
const HANDSHAKE_SOURCE = MANAGED_ENTITY_HANDSHAKE_SOURCE;

export type ManagedEntityHandshakeResult =
  | 'ignored'
  | 'rate_limited'
  | 'bootstrapped_without_user'
  | 'denied'
  | 'connected'
  | 'already_connected'
  | 'failed';

type ManagedEntityHandshakeContext = {
  update: MaxUpdate;
  chatId: string;
  botId: string;
  senderId: string | null;
  title: string;
  entityType: ManagedEntityType;
  prismaEntityType: ChatEntityType;
  createdAt: string | null;
};

@Injectable()
export class ManagedEntityHandshakeService {
  private readonly logger = new Logger(ManagedEntityHandshakeService.name);
  private readonly rateLimitUntilMs = new Map<string, number>();

  constructor(
    private readonly accessWriter: ManagedEntityAccessWriter,
    private readonly maxClient: MaxClientService,
    private readonly maxBotLinkService: MaxBotLinkService,
    private readonly maxBotRegistry: MaxBotRegistryService,
    private readonly maxChatAdminRosterSyncService: MaxChatAdminRosterSyncService,
  ) {}

  async handleWebhookUpdate(update: MaxUpdate): Promise<ManagedEntityHandshakeResult> {
    const context = this.buildContext(update);
    if (!context) {
      return 'ignored';
    }

    if (!this.reserveRateLimitSlot(context)) {
      return 'rate_limited';
    }

    try {
      const botAccess = await this.maxClient.getCurrentChatMemberAccess(context.chatId, {
        botId: context.botId,
        trafficClass: 'interactive',
        actionHealthLane: 'background',
        sourceTag: MAX_API_SOURCE_TAGS.MANAGED_HANDSHAKE,
        timeoutMs: HANDSHAKE_ACCESS_TIMEOUT_MS,
      });
      if (!this.isAdminOrOwner(botAccess)) {
        await this.replySafely(context, 'Не получилось подключить чат: у бота нет прав администратора.');
        return 'denied';
      }

      if (!context.senderId) {
        await this.accessWriter.bootstrapChat(this.toWriteContext(context));
        await this.replySafely(
          context,
          'Бот видит этот канал. Откройте мини-приложение от имени администратора, чтобы привязать доступ.',
        );
        return 'bootstrapped_without_user';
      }

      const accessByUser = await this.maxClient.getChatMembersAccess(
        context.chatId,
        [context.senderId],
        {
          botId: context.botId,
          trafficClass: 'interactive',
          actionHealthLane: 'background',
          sourceTag: MAX_API_SOURCE_TAGS.MANAGED_HANDSHAKE,
          timeoutMs: HANDSHAKE_ACCESS_TIMEOUT_MS,
        },
      );
      const userAccess = accessByUser.get(context.senderId) ?? null;
      if (!userAccess || !this.isAdminOrOwner(userAccess)) {
        await this.replySafely(
          context,
          'Команду Старт может выполнить только администратор или владелец чата.',
        );
        return 'denied';
      }

      const writeContext = this.toWriteContextWithSender(context);
      const wasConnected = await this.accessWriter.persistGrantedAccess(
        writeContext,
        botAccess,
        userAccess,
      );
      await this.accessWriter.patchUserVisibleState(writeContext);
      await this.enqueueRosterSync(context);
      await this.replySafely(
        context,
        wasConnected ? 'Уже подключен. Я обновил доступ и настройки.' : 'Готово, чат подключен.',
        this.buildSettingsButton(context),
      );
      return wasConnected ? 'already_connected' : 'connected';
    } catch (error: unknown) {
      this.logger.warn(
        {
          updateId: update.updateId,
          chatId: context.chatId,
          botId: context.botId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to process managed entity handshake command',
      );
      return 'failed';
    }
  }

  private buildContext(update: MaxUpdate): ManagedEntityHandshakeContext | null {
    const updateType = update.type.trim().toLowerCase();
    if (updateType !== 'message_created' && updateType !== 'message_callback') {
      return null;
    }

    if (updateType === 'message_created') {
      const text = update.message?.text?.trim().toLowerCase() ?? '';
      if (text !== HANDSHAKE_COMMAND) {
        return null;
      }
    } else if (this.readCallbackPayload(update) !== MANAGED_ENTITY_HANDSHAKE_START_CALLBACK_PAYLOAD) {
      return null;
    }

    const chatId = update.message?.chatId?.trim() ?? '';
    if (!chatId || isPrivateDirectChatId(chatId)) {
      return null;
    }

    const resolvedBot = this.maxBotRegistry.getBotById(update.botId ?? null);
    if (!resolvedBot) {
      return null;
    }

    const rawSenderId =
      update.message?.senderId?.trim() ||
      (updateType === 'message_callback' ? this.readCallbackUserId(update) : null) ||
      '';
    const senderId =
      rawSenderId && !this.maxBotRegistry.isKnownBotUserId(rawSenderId) ? rawSenderId : null;
    const entityType = update.message?.entityType === 'channel' ? 'channel' : 'chat';
    const prismaEntityType = entityType === 'channel' ? ChatEntityType.CHANNEL : ChatEntityType.CHAT;
    const title =
      update.message?.chatTitle?.trim() ||
      (entityType === 'channel' ? `Channel ${chatId}` : `Chat ${chatId}`);

    return {
      update,
      chatId,
      botId: resolvedBot.id,
      senderId,
      title,
      entityType,
      prismaEntityType,
      createdAt: update.message?.createdAt?.trim() || null,
    };
  }

  private readCallbackPayload(update: MaxUpdate): string | null {
    const callback = this.asRecord(update.raw?.callback);
    const payload = callback?.payload ?? callback?.data;
    return typeof payload === 'string' ? payload.trim() || null : null;
  }

  private readCallbackUserId(update: MaxUpdate): string | null {
    const callback = this.asRecord(update.raw?.callback);
    const user = this.asRecord(callback?.user);
    const value =
      user?.user_id ??
      user?.userId ??
      user?.id ??
      callback?.user_id ??
      callback?.userId ??
      callback?.sender_id ??
      callback?.senderId;
    if (typeof value !== 'string' && typeof value !== 'number') {
      return null;
    }
    const normalized = String(value).trim();
    return normalized.length > 0 ? normalized : null;
  }

  private asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  }

  private reserveRateLimitSlot(context: ManagedEntityHandshakeContext): boolean {
    const key = `${context.chatId}:${context.senderId ?? context.botId}`;
    const now = Date.now();
    const blockedUntil = this.rateLimitUntilMs.get(key) ?? 0;
    if (blockedUntil > now) {
      return false;
    }
    this.rateLimitUntilMs.set(key, now + HANDSHAKE_RATE_LIMIT_MS);
    return true;
  }

  private isAdminOrOwner(access: MaxChatMemberAccess | null): boolean {
    return access?.isOwner === true || access?.isAdmin === true;
  }

  private async enqueueRosterSync(context: ManagedEntityHandshakeContext): Promise<void> {
    await this.maxChatAdminRosterSyncService.scheduleChatAdminRosterSync({
      chatId: context.chatId,
      botIds: [context.botId],
      title: context.title,
      entityType: context.entityType,
      source: HANDSHAKE_SOURCE,
    });
  }

  private async replySafely(
    context: ManagedEntityHandshakeContext,
    text: string,
    buttons?: NonNullable<Parameters<MaxClientService['sendMessageImmediateWithId']>[2]>['buttons'],
  ): Promise<void> {
    try {
      await this.maxClient.sendMessageImmediateWithId(
        context.chatId,
        text,
        buttons && buttons.length > 0
          ? {
              buttons,
              debugContext: {
                screen: 'managed_entity_handshake',
                action: 'reply',
              },
            }
          : undefined,
        {
          botId: context.botId,
          trafficClass: 'interactive',
          actionHealthLane: 'background',
          sourceTag: MAX_API_SOURCE_TAGS.MANAGED_HANDSHAKE,
          timeoutMs: HANDSHAKE_SEND_TIMEOUT_MS,
        },
      );
    } catch (error: unknown) {
      this.logger.warn(
        {
          updateId: context.update.updateId,
          chatId: context.chatId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to send managed entity handshake reply',
      );
    }
  }

  private buildSettingsButton(
    context: ManagedEntityHandshakeContext,
  ): NonNullable<Parameters<MaxClientService['sendMessageImmediateWithId']>[2]>['buttons'] {
    const route = `/${context.entityType}/${encodeURIComponent(context.chatId)}/settings`;
    const startParam = `mr-${Buffer.from(
      JSON.stringify({
        v: 1,
        k: 'route',
        r: route,
      }),
      'utf8',
    ).toString('base64url')}`;
    const url =
      this.maxBotLinkService.buildEntryMiniappStartUrlSync(startParam) ??
      this.maxBotLinkService.buildMiniappStartUrlSync(startParam, context.botId);
    return url
      ? [
          [
            {
              type: 'link',
              text: 'Открыть настройки',
              url,
            },
          ],
        ]
      : [];
  }

  private toWriteContext(context: ManagedEntityHandshakeContext): ManagedEntityAccessWriteContext {
    return {
      chatId: context.chatId,
      title: context.title,
      botId: context.botId,
      senderId: context.senderId,
      entityType: context.entityType,
      prismaEntityType: context.prismaEntityType,
      createdAt: context.createdAt,
    };
  }

  private toWriteContextWithSender(
    context: ManagedEntityHandshakeContext,
  ): ManagedEntityAccessWriteContext & { senderId: string } {
    return {
      ...this.toWriteContext(context),
      senderId: context.senderId!,
    };
  }
}
