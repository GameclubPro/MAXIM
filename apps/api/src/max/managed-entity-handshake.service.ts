import { Injectable, Logger } from '@nestjs/common';
import type { ManagedEntityType, MaxUpdate } from '@maxim/contracts';
import { ChatEntityType, ManagedEntityHandshakeOutcomeStatus } from '../prisma/prisma-client';
import { isPrivateDirectChatId } from '../common/chat-id.util';
import {
  extractManagedEntityForwardedRecoveryCandidate,
  type ManagedEntityForwardedRecoveryCandidate,
} from '../common/managed-entity-forwarded-recovery.util';
import { isManagedEntityHandshakeStartCommand } from '../common/managed-entity-handshake-command.util';
import {
  MAX_API_SOURCE_TAGS,
  MaxClientService,
  type MaxChatMemberAccess,
} from './max-client.service';
import { normalizePermissionName } from './max-bot-access-policy.util';
import { hasConfirmedDeleteMessageAccess } from './max-delete-message-access.util';
import { MaxBotLinkService } from './max-bot-link.service';
import { MaxBotRegistryService } from './max-bot-registry.service';
import { MaxChatAdminRosterSyncService } from './max-chat-admin-roster-sync.service';
import type { MaxChatAdminRosterSyncJob } from './max-chat-admin-roster-sync.queue';
import {
  ManagedEntityAccessWriter,
  MANAGED_ENTITY_HANDSHAKE_SOURCE,
  type ManagedEntityAccessWriteContext,
} from './managed-entity-access-writer.service';
import { ManagedEntityHandshakeOutcomeService } from './managed-entity-handshake-outcome.service';

export const MANAGED_ENTITY_HANDSHAKE_START_CALLBACK_PAYLOAD =
  'managed_entity_handshake:start_hint';
export const MANAGED_ENTITY_HANDSHAKE_START_BUTTON_TEXT = 'Проверить подключение';
const HANDSHAKE_RATE_LIMIT_MS = 3 * 60 * 1_000;
const HANDSHAKE_RATE_LIMIT_MAX_KEYS = 2_048;
const HANDSHAKE_FORWARDED_ACTOR_BURST_LIMIT_MS = 5_000;
const HANDSHAKE_ACCESS_TIMEOUT_MS = 1_500;
const HANDSHAKE_SEND_TIMEOUT_MS = 1_500;
const HANDSHAKE_DELETE_TIMEOUT_MS = 1_500;
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
  replyChatId: string;
  botId: string;
  senderId: string | null;
  title: string;
  link?: string | null;
  avatarUrl?: string | null;
  entityType: ManagedEntityType;
  prismaEntityType: ChatEntityType;
  createdAt: string | null;
  commandMessageId: string | null;
  interactionMessageId: string | null;
  interaction: 'in_chat' | 'forwarded_private';
  bypassAccessCache: boolean;
};

@Injectable()
export class ManagedEntityHandshakeService {
  private readonly logger = new Logger(ManagedEntityHandshakeService.name);
  private readonly rateLimitUntilMs = new Map<string, number>();
  private readonly forwardedActorBurstUntilMs = new Map<string, number>();

  constructor(
    private readonly accessWriter: ManagedEntityAccessWriter,
    private readonly maxClient: MaxClientService,
    private readonly maxBotLinkService: MaxBotLinkService,
    private readonly maxBotRegistry: MaxBotRegistryService,
    private readonly maxChatAdminRosterSyncService: MaxChatAdminRosterSyncService,
    private readonly handshakeOutcomes: ManagedEntityHandshakeOutcomeService,
  ) {}

  async handleWebhookUpdate(update: MaxUpdate): Promise<ManagedEntityHandshakeResult> {
    const forwardedCandidate = extractManagedEntityForwardedRecoveryCandidate(update);
    if (forwardedCandidate) {
      return this.handleForwardedRecovery(update, forwardedCandidate);
    }

    const context = this.buildContext(update);
    if (!context) {
      return 'ignored';
    }

    return this.processContext(context);
  }

  private async handleForwardedRecovery(
    update: MaxUpdate,
    candidate: ManagedEntityForwardedRecoveryCandidate,
  ): Promise<ManagedEntityHandshakeResult> {
    const resolvedBot = this.maxBotRegistry.getBotById(update.botId ?? null);
    if (!resolvedBot || this.maxBotRegistry.isKnownBotUserId(candidate.forwarderUserId)) {
      return 'ignored';
    }

    const rateLimitKey = this.buildForwardedRateLimitKey(
      candidate.sourceChatId,
      candidate.forwarderUserId,
    );
    if (
      this.isRateLimitKeyBlocked(this.rateLimitUntilMs, rateLimitKey) ||
      !this.reserveForwardedActorBurstSlot(resolvedBot.id, candidate.forwarderUserId) ||
      !this.reserveRateLimitKey(rateLimitKey)
    ) {
      this.logger.log(
        {
          chatId: candidate.sourceChatId,
          botId: resolvedBot.id,
          entityType: null,
          hasSender: true,
          interaction: 'forwarded_private',
          outcome: 'rate_limited',
        },
        'Managed entity handshake outcome',
      );
      return 'rate_limited';
    }

    try {
      const snapshot = await this.maxClient.getChatSnapshot(candidate.sourceChatId, {
        botId: resolvedBot.id,
        trafficClass: 'interactive',
        actionHealthLane: 'background',
        sourceTag: MAX_API_SOURCE_TAGS.MANAGED_HANDSHAKE,
        timeoutMs: HANDSHAKE_ACCESS_TIMEOUT_MS,
        bypassCache: true,
        ignoreFailureMetricStatuses: [403, 404],
      });
      const entityType = snapshot.entityType;
      const context: ManagedEntityHandshakeContext = {
        update,
        chatId: candidate.sourceChatId,
        replyChatId: candidate.privateChatId,
        botId: resolvedBot.id,
        senderId: candidate.forwarderUserId,
        title:
          snapshot.title?.trim() ||
          (entityType === 'channel'
            ? `Channel ${candidate.sourceChatId}`
            : `Chat ${candidate.sourceChatId}`),
        link: snapshot.link,
        avatarUrl: snapshot.avatarUrl,
        entityType,
        prismaEntityType: entityType === 'channel' ? ChatEntityType.CHANNEL : ChatEntityType.CHAT,
        createdAt: update.message?.createdAt?.trim() || null,
        commandMessageId: null,
        interactionMessageId: candidate.incomingMessageId,
        interaction: 'forwarded_private',
        bypassAccessCache: true,
      };

      return this.processContext(context, true);
    } catch (error: unknown) {
      if (this.isBotAccessDeniedError(error)) {
        this.releaseRateLimitKey(rateLimitKey);
        await this.sendReplySafely({
          update,
          botId: resolvedBot.id,
          replyChatId: candidate.privateChatId,
          sourceChatId: candidate.sourceChatId,
          text: 'Не удалось открыть чат или канал. Добавьте бота администратором с доступом к сообщениям и перешлите публикацию еще раз.',
        });
        return 'denied';
      }

      this.releaseRateLimitKey(rateLimitKey);
      await this.sendReplySafely({
        update,
        botId: resolvedBot.id,
        replyChatId: candidate.privateChatId,
        sourceChatId: candidate.sourceChatId,
        text: 'Не удалось подключить чат или канал. Перешлите сообщение еще раз позже.',
      });
      this.logger.warn(
        {
          updateId: update.updateId,
          chatId: candidate.sourceChatId,
          botId: resolvedBot.id,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to resolve forwarded managed entity handshake source',
      );
      return 'failed';
    }
  }

  private async processContext(
    context: ManagedEntityHandshakeContext,
    rateLimitReserved = false,
  ): Promise<ManagedEntityHandshakeResult> {
    if (!rateLimitReserved && !this.reserveRateLimitSlot(context)) {
      await this.recordOutcome(
        context,
        ManagedEntityHandshakeOutcomeStatus.RATE_LIMITED,
        'duplicate_recently',
      );
      this.logOutcome(context, 'rate_limited');
      return 'rate_limited';
    }

    try {
      const botAccess = await this.maxClient.getCurrentChatMemberAccess(context.chatId, {
        botId: context.botId,
        trafficClass: 'interactive',
        actionHealthLane: 'background',
        sourceTag: MAX_API_SOURCE_TAGS.MANAGED_HANDSHAKE,
        timeoutMs: HANDSHAKE_ACCESS_TIMEOUT_MS,
        ...(context.bypassAccessCache ? { bypassCache: true } : {}),
        ignoreFailureMetricStatuses: [403, 404],
      });
      if (!this.isAdminOrOwner(botAccess)) {
        await this.recordOutcome(
          context,
          ManagedEntityHandshakeOutcomeStatus.BOT_DENIED,
          'bot_not_admin',
        );
        this.logOutcome(context, 'bot_denied');
        this.releaseForwardedRateLimitSlot(context);
        await this.replyToForwardedDenial(context, 'bot');
        return 'denied';
      }

      if (!this.hasRequiredBotReadAccess(context, botAccess)) {
        await this.recordOutcome(
          context,
          ManagedEntityHandshakeOutcomeStatus.BOT_DENIED,
          'bot_missing_read_all_messages',
        );
        this.logOutcome(context, 'bot_missing_read_all_messages');
        this.releaseForwardedRateLimitSlot(context);
        await this.replyToForwardedDenial(context, 'bot_read');
        return 'denied';
      }

      if (!context.senderId) {
        await this.accessWriter.bootstrapChat(this.toWriteContext(context));
        await this.replySafely(
          context,
          'Бот видит этот канал. Откройте мини-приложение от имени администратора, чтобы привязать доступ.',
        );
        await this.recordOutcome(
          context,
          ManagedEntityHandshakeOutcomeStatus.BOOTSTRAPPED_WITHOUT_USER,
          'sender_missing',
        );
        this.logOutcome(context, 'bootstrapped_without_user');
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
          ...(context.bypassAccessCache ? { bypassCache: true } : {}),
          ignoreFailureMetricStatuses: [403, 404],
        },
      );
      const userAccess = accessByUser.get(context.senderId) ?? null;
      if (!userAccess || !this.isAdminOrOwner(userAccess)) {
        await this.recordOutcome(
          context,
          ManagedEntityHandshakeOutcomeStatus.USER_DENIED,
          'user_not_admin',
        );
        this.logOutcome(context, 'user_denied');
        this.releaseForwardedRateLimitSlot(context);
        await this.replyToForwardedDenial(context, 'user');
        return 'denied';
      }

      const writeContext = this.toWriteContextWithSender(context);
      const wasConnected = await this.accessWriter.persistGrantedAccess(
        writeContext,
        botAccess,
        userAccess,
      );
      await this.accessWriter.patchUserVisibleState(writeContext);
      await this.refreshRosterSync(context);
      await this.deleteCommandMessageSafely(context, botAccess);
      await this.replySafely(
        context,
        this.buildSuccessReply(context, wasConnected),
        this.buildSettingsButton(context),
      );
      await this.recordSuccessfulOutcomeSafely(
        context,
        wasConnected
          ? ManagedEntityHandshakeOutcomeStatus.ALREADY_CONNECTED
          : ManagedEntityHandshakeOutcomeStatus.CONNECTED,
      );
      this.logOutcome(context, wasConnected ? 'already_connected' : 'connected');
      return wasConnected ? 'already_connected' : 'connected';
    } catch (error: unknown) {
      if (this.isBotAccessDeniedError(error)) {
        await this.recordOutcome(
          context,
          ManagedEntityHandshakeOutcomeStatus.BOT_DENIED,
          'bot_access_denied',
        );
        this.logOutcome(context, 'bot_denied');
        this.releaseForwardedRateLimitSlot(context);
        await this.replyToForwardedDenial(context, 'bot');
        return 'denied';
      }

      this.releaseRateLimitSlot(context);
      await this.recordOutcome(context, ManagedEntityHandshakeOutcomeStatus.FAILED, 'exception');
      if (context.interaction === 'forwarded_private') {
        await this.replySafely(context, 'Не удалось проверить доступ. Попробуйте еще раз.');
      }
      this.logger.warn(
        {
          updateId: context.update.updateId,
          chatId: context.chatId,
          botId: context.botId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to process managed entity handshake',
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
      if (!isManagedEntityHandshakeStartCommand(update)) {
        return null;
      }
    } else if (
      this.readCallbackPayload(update) !== MANAGED_ENTITY_HANDSHAKE_START_CALLBACK_PAYLOAD
    ) {
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
      updateType === 'message_callback'
        ? (this.readCallbackUserId(update) ?? update.message?.senderId?.trim() ?? '')
        : (update.message?.senderId?.trim() ?? '');
    const senderId =
      rawSenderId && !this.maxBotRegistry.isKnownBotUserId(rawSenderId) ? rawSenderId : null;
    const entityType = update.message?.entityType === 'channel' ? 'channel' : 'chat';
    const prismaEntityType =
      entityType === 'channel' ? ChatEntityType.CHANNEL : ChatEntityType.CHAT;
    const title =
      update.message?.chatTitle?.trim() ||
      (entityType === 'channel' ? `Channel ${chatId}` : `Chat ${chatId}`);

    return {
      update,
      chatId,
      replyChatId: chatId,
      botId: resolvedBot.id,
      senderId,
      title,
      entityType,
      prismaEntityType,
      createdAt: update.message?.createdAt?.trim() || null,
      commandMessageId:
        updateType === 'message_created' ? update.message?.messageId?.trim() || null : null,
      interactionMessageId:
        updateType === 'message_created' ? update.message?.messageId?.trim() || null : null,
      interaction: 'in_chat',
      bypassAccessCache: false,
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
    return this.reserveRateLimitKey(this.buildRateLimitKey(context));
  }

  private reserveRateLimitKey(key: string): boolean {
    return this.reserveBoundedRateLimitKey(this.rateLimitUntilMs, key, HANDSHAKE_RATE_LIMIT_MS);
  }

  private reserveForwardedActorBurstSlot(botId: string, forwarderId: string): boolean {
    return this.reserveBoundedRateLimitKey(
      this.forwardedActorBurstUntilMs,
      `forwarded-actor:${botId}:${forwarderId}`,
      HANDSHAKE_FORWARDED_ACTOR_BURST_LIMIT_MS,
    );
  }

  private reserveBoundedRateLimitKey(
    slots: Map<string, number>,
    key: string,
    ttlMs: number,
  ): boolean {
    const now = Date.now();
    this.pruneExpiredRateLimitKeys(slots, now);
    const blockedUntil = slots.get(key) ?? 0;
    if (blockedUntil > now) {
      return false;
    }

    slots.delete(key);
    while (slots.size >= HANDSHAKE_RATE_LIMIT_MAX_KEYS) {
      const oldestKey = slots.keys().next().value;
      if (typeof oldestKey !== 'string') {
        break;
      }
      slots.delete(oldestKey);
    }
    slots.set(key, now + ttlMs);
    return true;
  }

  private isRateLimitKeyBlocked(slots: Map<string, number>, key: string): boolean {
    const now = Date.now();
    this.pruneExpiredRateLimitKeys(slots, now);
    return (slots.get(key) ?? 0) > now;
  }

  private pruneExpiredRateLimitKeys(slots: Map<string, number>, now: number): void {
    for (const [key, blockedUntil] of slots) {
      if (blockedUntil <= now) {
        slots.delete(key);
      }
    }
  }

  private releaseRateLimitSlot(context: ManagedEntityHandshakeContext): void {
    this.releaseRateLimitKey(this.buildRateLimitKey(context));
  }

  private releaseForwardedRateLimitSlot(context: ManagedEntityHandshakeContext): void {
    if (context.interaction === 'forwarded_private') {
      this.releaseRateLimitSlot(context);
    }
  }

  private releaseRateLimitKey(key: string): void {
    this.rateLimitUntilMs.delete(key);
  }

  private buildRateLimitKey(context: ManagedEntityHandshakeContext): string {
    const actorId = context.senderId ?? context.botId;
    if (context.interaction === 'forwarded_private') {
      return this.buildForwardedRateLimitKey(context.chatId, actorId);
    }
    return this.buildRateLimitKeyFromValues(context.chatId, actorId, context.interactionMessageId);
  }

  private buildForwardedRateLimitKey(sourceChatId: string, forwarderId: string): string {
    return `forwarded:${sourceChatId}:${forwarderId}`;
  }

  private buildRateLimitKeyFromValues(
    chatId: string,
    actorId: string,
    interactionMessageId: string | null,
  ): string {
    return interactionMessageId
      ? `${chatId}:${actorId}:${interactionMessageId}`
      : `${chatId}:${actorId}`;
  }

  private async recordOutcome(
    context: ManagedEntityHandshakeContext,
    status: ManagedEntityHandshakeOutcomeStatus,
    reason: string | null = null,
  ): Promise<void> {
    await this.handshakeOutcomes.recordOutcome({
      chatId: context.chatId,
      userId: context.senderId ?? context.botId,
      botId: context.botId,
      entityType: context.prismaEntityType,
      status,
      reason,
      title: context.title,
      source: HANDSHAKE_SOURCE,
    });
  }

  private async recordSuccessfulOutcomeSafely(
    context: ManagedEntityHandshakeContext,
    status: ManagedEntityHandshakeOutcomeStatus,
  ): Promise<void> {
    try {
      await this.recordOutcome(context, status);
    } catch (error: unknown) {
      this.logger.warn(
        {
          updateId: context.update.updateId,
          chatId: context.chatId,
          botId: context.botId,
          status,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to record successful managed entity handshake outcome',
      );
    }
  }

  private logOutcome(context: ManagedEntityHandshakeContext, outcome: string): void {
    this.logger.log(
      {
        chatId: context.chatId,
        botId: context.botId,
        hasSender: Boolean(context.senderId),
        entityType: context.entityType,
        interaction: context.interaction,
        outcome,
      },
      'Managed entity handshake outcome',
    );
  }

  private isAdminOrOwner(access: MaxChatMemberAccess | null): boolean {
    return access?.isOwner === true || access?.isAdmin === true;
  }

  private hasRequiredBotReadAccess(
    context: ManagedEntityHandshakeContext,
    access: MaxChatMemberAccess,
  ): boolean {
    if (context.interaction !== 'forwarded_private' || access.isOwner) {
      return true;
    }

    return access.permissions.some((permission) => {
      const normalized = normalizePermissionName(permission);
      return normalized === 'read_all_messages' || normalized === 'can_read_all_messages';
    });
  }

  private isBotAccessDeniedError(error: unknown): boolean {
    const status = this.extractStatusCode(error);
    if (status !== 403 && status !== 404) {
      return false;
    }

    const code = this.extractErrorCode(error);
    if (!code) {
      return true;
    }

    return code === 'chat.denied' || code === 'chat.not.found' || code === 'bot.denied';
  }

  private extractStatusCode(error: unknown): number | null {
    const status = (error as { response?: { status?: unknown } } | null)?.response?.status;
    return typeof status === 'number' && Number.isInteger(status) ? status : null;
  }

  private extractErrorCode(error: unknown): string | null {
    const data = (error as { response?: { data?: unknown } } | null)?.response?.data;
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return null;
    }

    const code = (data as Record<string, unknown>).code;
    return typeof code === 'string' && code.trim().length > 0 ? code.trim() : null;
  }

  private buildRosterSyncJob(context: ManagedEntityHandshakeContext): MaxChatAdminRosterSyncJob {
    return {
      chatId: context.chatId,
      botIds: [context.botId],
      title: context.title,
      entityType: context.entityType,
      source: HANDSHAKE_SOURCE,
    };
  }

  private async refreshRosterSync(context: ManagedEntityHandshakeContext): Promise<void> {
    const job = this.buildRosterSyncJob(context);
    if (context.interaction === 'forwarded_private') {
      try {
        await this.maxChatAdminRosterSyncService.scheduleChatAdminRosterSync(job);
      } catch (error: unknown) {
        this.logger.warn(
          {
            updateId: context.update.updateId,
            chatId: context.chatId,
            botId: context.botId,
            err: error instanceof Error ? error.message : String(error),
          },
          'Failed to schedule managed entity roster refresh after forwarded recovery',
        );
      }
      return;
    }

    try {
      const refreshed = await this.maxChatAdminRosterSyncService.processJob(job);
      if (refreshed) {
        return;
      }
    } catch (error: unknown) {
      this.logger.warn(
        {
          updateId: context.update.updateId,
          chatId: context.chatId,
          botId: context.botId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to refresh managed entity roster directly after handshake',
      );
    }

    await this.maxChatAdminRosterSyncService.scheduleChatAdminRosterSync(job);
  }

  private async deleteCommandMessageSafely(
    context: ManagedEntityHandshakeContext,
    botAccess: MaxChatMemberAccess,
  ): Promise<void> {
    if (!context.commandMessageId) {
      return;
    }

    if (!this.canDeleteMessages(botAccess, context.prismaEntityType)) {
      this.logger.debug(
        {
          updateId: context.update.updateId,
          chatId: context.chatId,
          botId: context.botId,
          permissions: botAccess.permissions,
        },
        'Skipped managed entity handshake command deletion because bot lacks delete permission',
      );
      return;
    }

    try {
      await this.maxClient.deleteMessage(context.chatId, context.commandMessageId, {
        immediate: true,
        botId: context.botId,
        trafficClass: 'interactive',
        actionHealthLane: 'background',
        sourceTag: MAX_API_SOURCE_TAGS.MANAGED_HANDSHAKE,
        timeoutMs: HANDSHAKE_DELETE_TIMEOUT_MS,
        ignoreFailureMetricStatuses: [403, 404],
      });
    } catch (error: unknown) {
      this.logger.warn(
        {
          updateId: context.update.updateId,
          chatId: context.chatId,
          botId: context.botId,
          messageId: context.commandMessageId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to delete managed entity handshake command message',
      );
    }
  }

  private canDeleteMessages(access: MaxChatMemberAccess, entityType: ChatEntityType): boolean {
    return hasConfirmedDeleteMessageAccess(
      {
        checkedAt: null,
        isAdmin: access.isAdmin,
        isOwner: access.isOwner,
        permissions: access.permissions,
      },
      entityType,
    );
  }

  private async replySafely(
    context: ManagedEntityHandshakeContext,
    text: string,
    buttons?: NonNullable<Parameters<MaxClientService['sendMessageImmediateWithId']>[2]>['buttons'],
  ): Promise<void> {
    await this.sendReplySafely({
      update: context.update,
      botId: context.botId,
      replyChatId: context.replyChatId,
      sourceChatId: context.chatId,
      text,
      buttons,
    });
  }

  private async sendReplySafely({
    update,
    botId,
    replyChatId,
    sourceChatId,
    text,
    buttons,
  }: {
    update: MaxUpdate;
    botId: string;
    replyChatId: string;
    sourceChatId: string;
    text: string;
    buttons?: NonNullable<Parameters<MaxClientService['sendMessageImmediateWithId']>[2]>['buttons'];
  }): Promise<void> {
    try {
      await this.maxClient.sendMessageImmediateWithId(
        replyChatId,
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
          botId,
          trafficClass: 'interactive',
          actionHealthLane: 'background',
          sourceTag: MAX_API_SOURCE_TAGS.MANAGED_HANDSHAKE,
          timeoutMs: HANDSHAKE_SEND_TIMEOUT_MS,
        },
      );
    } catch (error: unknown) {
      this.logger.warn(
        {
          updateId: update.updateId,
          chatId: sourceChatId,
          replyChatId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to send managed entity handshake reply',
      );
    }
  }

  private async replyToForwardedDenial(
    context: ManagedEntityHandshakeContext,
    actor: 'bot' | 'bot_read' | 'user',
  ): Promise<void> {
    if (context.interaction !== 'forwarded_private') {
      return;
    }

    const entityLabel = context.entityType === 'channel' ? 'канала' : 'чата';
    const entityAccusative = context.entityType === 'channel' ? 'канал' : 'чат';
    const text =
      actor === 'bot'
        ? `Бот не администратор ${entityLabel}. Назначьте бота администратором и перешлите сообщение еще раз.`
        : actor === 'bot_read'
          ? `У бота нет доступа ко всем сообщениям ${entityLabel}. Включите это право и перешлите сообщение еще раз.`
          : `Подключить ${entityAccusative} может только владелец или администратор.`;
    await this.replySafely(context, text);
  }

  private buildSuccessReply(context: ManagedEntityHandshakeContext, wasConnected: boolean): string {
    if (context.interaction === 'in_chat') {
      return wasConnected
        ? 'Уже подключен. Я обновил доступ и настройки.'
        : 'Готово, чат подключен.';
    }

    const entityLabel = context.entityType === 'channel' ? 'Канал' : 'Чат';
    return wasConnected
      ? `${entityLabel} уже подключен. Доступ обновлен.`
      : `Готово, ${entityLabel.toLowerCase()} подключен.`;
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
      link: context.link,
      avatarUrl: context.avatarUrl,
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
