import type { ChannelDialogType, ManagedEntityType } from '@maxim/contracts';
import { BadRequestException } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  buildCompactProfileMentionStartPayload,
  isValidMaxBotStartPayload,
  isValidMaxMiniappStartPayload,
} from '../max/max-deep-link.util';
import type { MaxMessageButton } from '../max/max-client.service';
import type { MaxBotLinkService } from '../max/max-bot-link.service';
import type { MaxBotRegistryService } from '../max/max-bot-registry.service';
import { readTrimmedString } from './admin-legacy-utils';

const CHANNEL_DIALOG_START_PARAM_PREFIX = 'cd-';
const CHANNEL_SUGGESTION_START_PARAM_PREFIX = 'cds-';
const CHANNEL_DIALOG_TOKEN_PREFIX = 'cdt-';
const PROFILE_MENTION_START_PREFIX = 'pmh-';

type ChannelDialogTokenPayload = {
  v: 1;
  d: string;
  s: string;
};

type ProfileMentionStartPayload = {
  v: 1;
  k: 'profile-mention';
  c: string;
  e: ManagedEntityType;
  u: string;
  n: string;
};

type AdminDialogLinkHelperOptions = {
  appBaseUrl: string | null;
  explicitBotContactId: string | null;
  ownBotUserId: string | null;
  maxBotToken: string;
  maxBotTokenValidationSecrets: readonly string[];
  maxBotLinkService?: MaxBotLinkService;
  maxBotRegistry?: MaxBotRegistryService;
};

export class AdminDialogLinkHelper {
  constructor(private readonly options: AdminDialogLinkHelperOptions) {}

  buildChannelDialogLaunchUrl(
    chatId: string,
    type: ChannelDialogType,
    threadId: string,
    botId?: string | null,
  ): string | null {
    return this.buildEntityDialogLaunchUrl('channel', chatId, type, threadId, botId);
  }

  buildChannelDialogDirectWebAppUrl(
    chatId: string,
    type: ChannelDialogType,
    threadId: string,
  ): string | null {
    return this.buildEntityDialogDirectWebAppUrl('channel', chatId, type, threadId);
  }

  buildChatDialogButton(
    chatId: string,
    type: ChannelDialogType,
    threadId: string,
    text: string,
    botId?: string | null,
  ): MaxMessageButton {
    const launchUrl = this.buildChatDialogLaunchUrl(chatId, type, threadId, botId);
    const webAppUrl = this.buildChatDialogDirectWebAppUrl(chatId, type, threadId);
    const botContactId = this.resolveBotContactId(botId);

    return launchUrl
      ? {
          type: 'link',
          text,
          url: launchUrl,
        }
      : webAppUrl && botContactId
        ? {
            type: 'open_app',
            text,
            webApp: webAppUrl,
            contactId: botContactId,
          }
        : {
            type: 'link',
            text,
            url: webAppUrl ?? `${this.options.appBaseUrl ?? 'https://major-maksimov.ru'}/app/`,
          };
  }

  buildChatDialogLaunchUrl(
    chatId: string,
    type: ChannelDialogType,
    threadId: string,
    botId?: string | null,
  ): string | null {
    return this.buildEntityDialogLaunchUrl('chat', chatId, type, threadId, botId);
  }

  buildChatDialogDirectWebAppUrl(
    chatId: string,
    type: ChannelDialogType,
    threadId: string,
  ): string | null {
    return this.buildEntityDialogDirectWebAppUrl('chat', chatId, type, threadId);
  }

  buildChannelSuggestionStartPayload(
    chatId: string,
    threadId: string,
    botId?: string | null,
  ): string {
    const normalizedChatId = chatId.trim();
    const normalizedThreadId = threadId.trim();
    const compactThreadId = this.compactSuggestionThreadId(normalizedThreadId);

    if (!normalizedChatId || !compactThreadId) {
      return this.buildChannelDialogStartParam(chatId, 'suggest', threadId);
    }

    const signature = this.buildChannelSuggestionStartSignature(
      normalizedChatId,
      normalizedThreadId,
      this.getCurrentBotToken(botId),
    );
    return `${CHANNEL_SUGGESTION_START_PARAM_PREFIX}${normalizedChatId}.${compactThreadId}.${signature}`;
  }

  buildBotStartUrl(startPayload: string, botId?: string | null): string | null {
    if (!isValidMaxBotStartPayload(startPayload)) {
      return null;
    }

    const fallbackBotId = botId?.trim() || this.options.ownBotUserId;
    return (
      this.options.maxBotLinkService?.buildBotStartUrlSync?.(startPayload, botId) ??
      (fallbackBotId
        ? `https://max.ru/${encodeURIComponent(fallbackBotId)}?start=${encodeURIComponent(startPayload)}`
        : null)
    );
  }

  parseCompactChannelSuggestionStartPayload(
    startPayload: string | null,
  ): { chatId: string; token: string } | null {
    if (!startPayload || !startPayload.startsWith(CHANNEL_SUGGESTION_START_PARAM_PREFIX)) {
      return null;
    }

    const rawPayload = startPayload.slice(CHANNEL_SUGGESTION_START_PARAM_PREFIX.length);
    const [chatIdRaw, compactThreadIdRaw, signatureRaw, ...rest] = rawPayload.split('.');
    if (rest.length > 0) {
      return null;
    }

    const chatId = chatIdRaw?.trim() ?? '';
    const compactThreadId = compactThreadIdRaw?.trim().toLowerCase() ?? '';
    const signature = signatureRaw?.trim().toLowerCase() ?? '';
    const threadId = this.expandSuggestionThreadId(compactThreadId);
    if (!chatId || !threadId || !/^[a-f0-9]{24}$/u.test(signature)) {
      return null;
    }

    const matchedBotToken = this.resolveChannelSuggestionStartBotToken(signature, chatId, threadId);
    if (!matchedBotToken) {
      return null;
    }

    return {
      chatId,
      token: this.buildEntityDialogToken('channel', chatId, 'suggest', threadId, matchedBotToken),
    };
  }

  parseChannelSuggestionStartPayload(
    startPayload: string | null,
  ): { chatId: string; token: string } | null {
    const compactPayload = this.parseCompactChannelSuggestionStartPayload(startPayload);
    if (compactPayload) {
      return compactPayload;
    }

    if (!startPayload || !startPayload.startsWith(CHANNEL_DIALOG_START_PARAM_PREFIX)) {
      return null;
    }

    const encodedPayload = startPayload.slice(CHANNEL_DIALOG_START_PARAM_PREFIX.length);
    if (!encodedPayload) {
      return null;
    }

    try {
      const parsed = JSON.parse(
        Buffer.from(encodedPayload, 'base64url').toString('utf8'),
      ) as Partial<{
        v: number;
        k: string;
        c: string;
        m: string;
        t: string;
      }>;
      const chatId = typeof parsed.c === 'string' ? parsed.c.trim() : '';
      const token = typeof parsed.t === 'string' ? parsed.t.trim() : '';

      if (
        parsed.v !== 1 ||
        parsed.k !== 'channel-dialog' ||
        parsed.m !== 'suggest' ||
        !chatId ||
        !token
      ) {
        return null;
      }

      return {
        chatId,
        token,
      };
    } catch {
      return null;
    }
  }

  buildProfileMentionStartPayload(
    params: {
      chatId: string;
      entityType: ManagedEntityType;
      userId: string;
      displayName: string;
    },
    botId?: string | null,
  ): string {
    const compactPayload = buildCompactProfileMentionStartPayload(
      {
        chatId: params.chatId,
        entityType: params.entityType,
        userId: params.userId,
      },
      this.getCurrentBotToken(botId),
    );
    if (compactPayload) {
      return compactPayload;
    }

    const payload = Buffer.from(
      JSON.stringify({
        v: 1,
        k: 'profile-mention',
        c: params.chatId,
        e: params.entityType,
        u: params.userId,
        n: params.displayName.trim() || 'Пользователь',
      } satisfies ProfileMentionStartPayload),
      'utf8',
    ).toString('base64url');

    return `${PROFILE_MENTION_START_PREFIX}${payload}`;
  }

  buildChannelDialogToken(
    chatId: string,
    type: ChannelDialogType,
    threadId?: string | null,
  ): string {
    return this.buildEntityDialogToken('channel', chatId, type, threadId);
  }

  resolveChannelDialogThreadId(
    chatId: string,
    type: ChannelDialogType,
    token: string | null | undefined,
  ): string | null {
    return this.resolveEntityDialogThreadId('channel', chatId, type, token);
  }

  resolveChatDialogThreadId(
    chatId: string,
    type: ChannelDialogType,
    token: string | null | undefined,
  ): string | null {
    return this.resolveEntityDialogThreadId('chat', chatId, type, token);
  }

  resolveBotContactId(botId?: string | null): string | null {
    const contextAwareContactId = this.options.maxBotLinkService?.resolveContactIdSync?.(botId);
    if (contextAwareContactId) {
      return contextAwareContactId;
    }

    if (!botId && this.options.explicitBotContactId) {
      return this.options.explicitBotContactId;
    }

    const resolvedBotId = this.options.maxBotRegistry?.getBotById(botId)?.id ?? null;
    const fallbackBotUserId = resolvedBotId ?? this.options.ownBotUserId;
    if (!fallbackBotUserId) {
      return null;
    }

    const [candidate] = fallbackBotUserId.split('_');
    return /^\d+$/u.test(candidate) ? candidate : null;
  }

  isOwnBotUserId(userId: string): boolean {
    if (this.options.maxBotLinkService?.isKnownBotUserId?.(userId)) {
      return true;
    }

    const normalized = userId.trim();
    if (!normalized) {
      return false;
    }

    if (this.options.explicitBotContactId && normalized === this.options.explicitBotContactId) {
      return true;
    }

    if (!this.options.ownBotUserId) {
      return false;
    }

    return (
      normalized === this.options.ownBotUserId ||
      normalized === this.options.ownBotUserId.split('_')[0]
    );
  }

  private buildEntityDialogLaunchUrl(
    entityType: ManagedEntityType,
    chatId: string,
    type: ChannelDialogType,
    threadId: string,
    _botId?: string | null,
  ): string | null {
    return this.buildEntryMiniappStartUrl(
      this.buildEntityDialogStartParam(entityType, chatId, type, threadId),
    );
  }

  private buildEntityDialogDirectWebAppUrl(
    entityType: ManagedEntityType,
    chatId: string,
    type: ChannelDialogType,
    threadId: string,
  ): string | null {
    if (!this.options.appBaseUrl) {
      return null;
    }

    const token = this.buildEntityDialogToken(entityType, chatId, type, threadId);
    const encodedChatId = encodeURIComponent(chatId);
    const entitySegment = entityType === 'channel' ? 'channel' : 'chat';
    return `${this.options.appBaseUrl}/app/${entitySegment}/${encodedChatId}/dialog/${type}?token=${token}`;
  }

  buildChannelDialogStartParam(chatId: string, type: ChannelDialogType, threadId: string): string {
    return this.buildEntityDialogStartParam('channel', chatId, type, threadId);
  }

  private buildEntityDialogStartParam(
    entityType: ManagedEntityType,
    chatId: string,
    type: ChannelDialogType,
    threadId: string,
  ): string {
    const token = this.buildEntityDialogToken(entityType, chatId, type, threadId);
    const payload = JSON.stringify({
      v: 1,
      k: entityType === 'channel' ? 'channel-dialog' : 'chat-dialog',
      c: chatId,
      m: type,
      t: token,
    });
    const encoded = Buffer.from(payload, 'utf8').toString('base64url');
    return `${CHANNEL_DIALOG_START_PARAM_PREFIX}${encoded}`;
  }

  private buildEntryMiniappStartUrl(startParam: string): string | null {
    if (!isValidMaxMiniappStartPayload(startParam)) {
      return null;
    }

    return (
      this.options.maxBotLinkService?.buildEntryMiniappStartUrlSync?.(startParam) ??
      this.options.maxBotLinkService?.buildMiniappStartUrlSync?.(startParam) ??
      (this.options.ownBotUserId
        ? `https://max.ru/${encodeURIComponent(this.options.ownBotUserId)}?startapp=${encodeURIComponent(startParam)}`
        : null)
    );
  }

  private buildChannelSuggestionStartSignature(
    chatId: string,
    threadId: string,
    botToken = this.getCurrentBotToken(),
  ): string {
    return createHmac('sha256', botToken)
      .update(`suggest-start:${chatId}:${threadId}`)
      .digest('hex')
      .slice(0, 24);
  }

  private compactSuggestionThreadId(threadId: string): string | null {
    const normalized = threadId.trim().toLowerCase();
    if (
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(normalized)
    ) {
      return null;
    }

    return normalized.replace(/-/gu, '');
  }

  private expandSuggestionThreadId(compactThreadId: string): string | null {
    const normalized = compactThreadId.trim().toLowerCase();
    if (!/^[a-f0-9]{32}$/u.test(normalized)) {
      return null;
    }

    return [
      normalized.slice(0, 8),
      normalized.slice(8, 12),
      normalized.slice(12, 16),
      normalized.slice(16, 20),
      normalized.slice(20),
    ].join('-');
  }

  buildEntityDialogToken(
    entityType: ManagedEntityType,
    chatId: string,
    type: ChannelDialogType,
    threadId?: string | null,
    botToken = this.getCurrentBotToken(),
  ): string {
    const normalizedThreadId = threadId?.trim() ?? '';
    if (!normalizedThreadId) {
      return this.buildEntityDialogTokenSignature(entityType, chatId, type, null, botToken);
    }

    const payload = JSON.stringify({
      v: 1,
      d: normalizedThreadId,
      s: this.buildEntityDialogTokenSignature(
        entityType,
        chatId,
        type,
        normalizedThreadId,
        botToken,
      ),
    } satisfies ChannelDialogTokenPayload);
    const encoded = Buffer.from(payload, 'utf8').toString('base64url');
    return `${CHANNEL_DIALOG_TOKEN_PREFIX}${encoded}`;
  }

  private buildEntityDialogTokenSignature(
    entityType: ManagedEntityType,
    chatId: string,
    type: ChannelDialogType,
    threadId?: string | null,
    botToken = this.getCurrentBotToken(),
  ): string {
    const normalizedThreadId = threadId?.trim() ?? '';
    const baseScope =
      entityType === 'channel' ? `dialog:${chatId}:${type}` : `dialog:chat:${chatId}:${type}`;
    const scope = normalizedThreadId ? `${baseScope}:${normalizedThreadId}` : baseScope;
    return createHmac('sha256', botToken).update(scope).digest('hex');
  }

  private resolveEntityDialogThreadId(
    entityType: ManagedEntityType,
    chatId: string,
    type: ChannelDialogType,
    token: string | null | undefined,
  ): string | null {
    const normalizedToken = typeof token === 'string' ? token.trim() : '';
    const openAgainMessage =
      entityType === 'channel'
        ? 'Неверный токен кнопки. Откройте диалог заново из сообщения канала.'
        : 'Неверный токен кнопки. Откройте диалог заново из сообщения чата.';
    const staleMessage =
      entityType === 'channel'
        ? 'Кнопка устарела. Откройте сообщение в канале и нажмите кнопку снова.'
        : 'Кнопка устарела. Откройте сообщение в чате и нажмите кнопку снова.';
    if (!normalizedToken) {
      throw new BadRequestException(openAgainMessage);
    }

    if (/^[a-f0-9]{64}$/iu.test(normalizedToken)) {
      const signature = normalizedToken.toLowerCase();
      if (!this.isValidEntityDialogTokenSignature(signature, entityType, chatId, type)) {
        throw new BadRequestException(staleMessage);
      }

      return null;
    }

    if (!normalizedToken.startsWith(CHANNEL_DIALOG_TOKEN_PREFIX)) {
      throw new BadRequestException(openAgainMessage);
    }

    const encodedPayload = normalizedToken.slice(CHANNEL_DIALOG_TOKEN_PREFIX.length);
    if (!encodedPayload) {
      throw new BadRequestException(openAgainMessage);
    }

    let payload: Partial<ChannelDialogTokenPayload>;
    try {
      payload = JSON.parse(
        Buffer.from(encodedPayload, 'base64url').toString('utf8'),
      ) as Partial<ChannelDialogTokenPayload>;
    } catch {
      throw new BadRequestException(openAgainMessage);
    }

    const threadId = readTrimmedString(payload.d);
    const signature = readTrimmedString(payload.s)?.toLowerCase() ?? '';
    if (
      payload.v !== 1 ||
      !threadId ||
      threadId.length > 120 ||
      !/^[a-f0-9]{64}$/u.test(signature)
    ) {
      throw new BadRequestException(openAgainMessage);
    }

    if (!this.isValidEntityDialogTokenSignature(signature, entityType, chatId, type, threadId)) {
      throw new BadRequestException(staleMessage);
    }

    return threadId;
  }

  private resolveChannelSuggestionStartBotToken(
    providedHex: string,
    chatId: string,
    threadId: string,
  ): string | null {
    for (const botToken of this.options.maxBotTokenValidationSecrets) {
      if (
        this.isValidChannelDialogSignature(
          providedHex,
          this.buildChannelSuggestionStartSignature(chatId, threadId, botToken),
        )
      ) {
        return botToken;
      }
    }

    return null;
  }

  private isValidEntityDialogTokenSignature(
    providedHex: string,
    entityType: ManagedEntityType,
    chatId: string,
    type: ChannelDialogType,
    threadId?: string | null,
  ): boolean {
    return this.options.maxBotTokenValidationSecrets.some((botToken) =>
      this.isValidChannelDialogSignature(
        providedHex,
        this.buildEntityDialogTokenSignature(entityType, chatId, type, threadId, botToken),
      ),
    );
  }

  private isValidChannelDialogSignature(providedHex: string, expectedHex: string): boolean {
    return (
      providedHex.length === expectedHex.length &&
      timingSafeEqual(Buffer.from(providedHex, 'hex'), Buffer.from(expectedHex, 'hex'))
    );
  }

  private getCurrentBotToken(botId?: string | null): string {
    return this.options.maxBotLinkService?.getBotTokenSync?.(botId) ?? this.options.maxBotToken;
  }
}
