import { Injectable, Logger } from '@nestjs/common';
import {
  ChatBotMembershipRole,
  ChatBotMembershipStatus,
  ChatEntityType,
  Prisma,
} from '@prisma/client';
import type { ManagedEntityBotCapability } from '@maxim/contracts';
import { PrismaService } from '../prisma/prisma.service';
import {
  isValidMaxBotStartPayload,
  isValidMaxMiniappStartPayload,
} from './max-deep-link.util';
import { MaxBotContextService } from './max-bot-context.service';
import { MaxBotRegistryService, type MaxBotDefinition } from './max-bot-registry.service';

const CHAT_BOT_CACHE_TTL_MS = 10 * 60 * 1_000;
const OBSERVED_WEBHOOK_TOUCH_TTL_MS = 60 * 1_000;
const ACTIONABLE_BOT_LIFECYCLE_STATES = new Set(['active', 'draining']);
const DELETE_MESSAGE_PERMISSION_ALIASES = new Set([
  'delete',
  'delete_message',
  'delete_messages',
  'can_delete_message',
  'can_delete_messages',
  'post_edit_delete_message',
  'post_edit_delete_messages',
  'can_post_edit_delete_message',
  'can_post_edit_delete_messages',
]);
const MODERATE_MEMBER_PERMISSION_ALIASES = new Set([
  'add_remove_members',
  'can_add_remove_members',
  'remove_members',
  'can_remove_members',
  'manage_members',
  'can_manage_members',
  'kick_members',
  'can_kick_members',
  'ban_members',
  'can_ban_members',
  'ban_users',
  'can_ban_users',
  'delete_members',
  'can_delete_members',
]);

type ModerationActionPermission = 'delete_message' | 'moderate_member';

type ChatBotBindingCacheEntry = {
  botId: string;
  expiresAtMs: number;
};

type MembershipAccessSnapshot = {
  isAdmin: boolean;
  isOwner: boolean;
  permissions: string[];
};

export type ChatBotExecutionBinding = {
  chatId: string;
  activeBotId: string | null;
  primaryBotId: string | null;
  activeMembershipStatus: ChatBotMembershipStatus | null;
  assignedBotIds: string[];
  shouldHandleGroupUpdate: boolean;
};

export type MaxBotRoutePurpose =
  | 'default'
  | 'read'
  | 'member_access'
  | 'moderation_action'
  | 'capability';

export type MaxBotRouteReason =
  | 'explicit'
  | 'chat_cache'
  | 'chat_primary'
  | 'context'
  | 'default'
  | 'primary_confirmed'
  | 'alternate_confirmed'
  | 'primary_soft'
  | 'alternate_soft'
  | 'primary_fallback'
  | 'alternate_fallback';

export type MaxBotRoute =
  | {
      purpose: 'default' | 'read' | 'member_access';
      chatId: string | null;
      primaryBotId: string | null;
      botId: string | null;
      candidateBotIds: string[];
      reason: MaxBotRouteReason | null;
    }
  | {
      purpose: 'moderation_action';
      chatId: string | null;
      primaryBotId: string | null;
      botId: string | null;
      candidateBotIds: string[];
      reason: MaxBotRouteReason | null;
      action: 'delete_message' | 'moderate_member';
    }
  | {
      purpose: 'capability';
      chatId: string | null;
      primaryBotId: string | null;
      botId: string | null;
      candidateBotIds: string[];
      reason: MaxBotRouteReason | null;
      capability: ManagedEntityBotCapability;
    };

export type MaxBotRouteRequest =
  | {
      purpose: 'default';
      chatId?: string | null;
      botId?: string | null;
    }
  | {
      purpose: 'read' | 'member_access';
      chatId: string;
    }
  | {
      purpose: 'moderation_action';
      chatId: string;
      action: 'delete_message' | 'moderate_member';
      fallbackToPrimary?: boolean;
    }
  | {
      purpose: 'capability';
      chatId: string;
      capability: ManagedEntityBotCapability;
      fallbackToPrimary?: boolean;
    };

type ResolvedChatRouteMembership = {
  botId: string;
  role: ChatBotMembershipRole;
  status: ChatBotMembershipStatus;
  permissionsSnapshot: unknown;
  capabilities: unknown;
};

type ResolvedChatRouteState = {
  chatId: string;
  entityType: ChatEntityType | null;
  primaryBotId: string | null;
  memberships: ResolvedChatRouteMembership[];
  activeKnownMemberships: ResolvedChatRouteMembership[];
  activeActionableMemberships: ResolvedChatRouteMembership[];
};

@Injectable()
export class MaxBotLinkService {
  private readonly logger = new Logger(MaxBotLinkService.name);
  private readonly chatBotBindingCache = new Map<string, ChatBotBindingCacheEntry>();
  private readonly observedWebhookTouchCache = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly botRegistry: MaxBotRegistryService,
    private readonly botContext: MaxBotContextService,
  ) {}

  getDefaultBotId(): string {
    return this.botRegistry.getDefaultBot().id;
  }

  getEntryBotId(): string {
    return this.botRegistry.getEntryBot().id;
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

    const cachedBotId = this.getCachedChatBotId(chatId);
    if (cachedBotId) {
      return cachedBotId;
    }

    const contextBotId = this.botContext.getActiveBotId();
    if (contextBotId) {
      return contextBotId;
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

  async resolveBotRoute(request: MaxBotRouteRequest): Promise<MaxBotRoute> {
    switch (request.purpose) {
      case 'default':
        return this.resolveDefaultBotRoute(request);
      case 'read':
        return this.resolveReadBotRoute(request.chatId);
      case 'member_access':
        return this.resolveMemberAccessBotRoute(request.chatId);
      case 'moderation_action':
        return this.resolveModerationActionBotRoute(
          request.chatId,
          request.action,
          request.fallbackToPrimary,
        );
      case 'capability':
        return this.resolveCapabilityBotRoute(
          request.chatId,
          request.capability,
          request.fallbackToPrimary,
        );
    }
  }

  async resolveBotRoutes(request: MaxBotRouteRequest): Promise<MaxBotRoute> {
    if (request.purpose === 'moderation_action') {
      return this.resolveModerationActionBotRoute(
        request.chatId,
        request.action,
        request.fallbackToPrimary,
      );
    }

    return this.resolveBotRoute(request);
  }

  async resolveBotId(options: { chatId?: string | null; botId?: string | null } = {}): Promise<string> {
    const route = await this.resolveBotRoute({
      purpose: 'default',
      chatId: options.chatId,
      botId: options.botId,
    });
    return route.botId ?? this.getDefaultBotId();
  }

  async resolveBotIdForRead(params: { chatId: string }): Promise<string | null> {
    const route = await this.resolveBotRoute({
      purpose: 'read',
      chatId: params.chatId,
    });
    return route.botId;
  }

  async getStoredChatPrimaryBotId(chatId: string | null | undefined): Promise<string | null> {
    const normalizedChatId = typeof chatId === 'string' ? chatId.trim() : '';
    if (!normalizedChatId) {
      return null;
    }

    const cachedBotId = this.getCachedChatBotId(normalizedChatId);
    if (cachedBotId) {
      return cachedBotId;
    }

    const chat = await this.prisma.chat.findUnique({
      where: { id: normalizedChatId },
      select: { primaryBotId: true, botId: true },
    });
    const resolvedBotId =
      this.botRegistry.getBotById(chat?.primaryBotId ?? chat?.botId ?? null)?.id ?? null;
    if (resolvedBotId) {
      this.rememberChatBotBinding(normalizedChatId, resolvedBotId);
    }

    return resolvedBotId;
  }

  async observeStoredChatBotWebhook(params: {
    chatId: string;
    primaryBotId?: string | null;
    botId?: string | null;
  }): Promise<void> {
    const chatId = params.chatId.trim();
    const primaryBotId = this.botRegistry.getBotById(params.primaryBotId)?.id ?? null;
    const observedBotId = this.botRegistry.getBotById(params.botId)?.id ?? null;
    if (!chatId || !observedBotId) {
      return;
    }

    const cacheKey = `${chatId}:${observedBotId}`;
    const nowMs = Date.now();
    if ((this.observedWebhookTouchCache.get(cacheKey) ?? 0) > nowMs) {
      return;
    }

    const now = new Date(nowMs);
    await this.upsertChatBotMembership(chatId, observedBotId, {
      role:
        primaryBotId !== null && observedBotId !== primaryBotId
          ? ChatBotMembershipRole.STANDBY
          : ChatBotMembershipRole.PRIMARY,
      status: ChatBotMembershipStatus.ACTIVE,
      lastSeenAt: now,
      lastWebhookAt: now,
    });
    this.observedWebhookTouchCache.set(cacheKey, nowMs + OBSERVED_WEBHOOK_TOUCH_TTL_MS);

    if (primaryBotId) {
      this.rememberChatBotBinding(chatId, primaryBotId);
    }
  }

  resolveContactIdSync(botId?: string | null): string | null {
    const bot = this.getResolvedBotSync(botId);
    return bot.contactId;
  }

  buildEntryMiniappStartUrlSync(startParam: string): string | null {
    if (!isValidMaxMiniappStartPayload(startParam)) {
      return null;
    }

    return `https://max.ru/${encodeURIComponent(this.getEntryBotId())}?startapp=${encodeURIComponent(startParam)}`;
  }

  buildEntryBotStartUrlSync(startPayload: string): string | null {
    if (!isValidMaxBotStartPayload(startPayload)) {
      return null;
    }

    return `https://max.ru/${encodeURIComponent(this.getEntryBotId())}?start=${encodeURIComponent(startPayload)}`;
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

  forgetChatBotBinding(chatId: string): void {
    const normalizedChatId = chatId.trim();
    if (!normalizedChatId) {
      return;
    }
    this.chatBotBindingCache.delete(normalizedChatId);
  }

  async resolveContactId(options: { chatId?: string | null; botId?: string | null } = {}): Promise<string | null> {
    const route = await this.resolveBotRoute({
      purpose: 'default',
      chatId: options.chatId,
      botId: options.botId,
    });
    return this.resolveContactIdSync(route.botId);
  }

  async buildEntryMiniappStartUrl(startParam: string): Promise<string | null> {
    if (!isValidMaxMiniappStartPayload(startParam)) {
      return null;
    }

    return `https://max.ru/${encodeURIComponent(this.getEntryBotId())}?startapp=${encodeURIComponent(startParam)}`;
  }

  async buildEntryBotStartUrl(startPayload: string): Promise<string | null> {
    if (!isValidMaxBotStartPayload(startPayload)) {
      return null;
    }

    return `https://max.ru/${encodeURIComponent(this.getEntryBotId())}?start=${encodeURIComponent(startPayload)}`;
  }

  async buildMiniappStartUrl(
    startParam: string,
    options: { chatId?: string | null; botId?: string | null } = {},
  ): Promise<string | null> {
    if (!isValidMaxMiniappStartPayload(startParam)) {
      return null;
    }

    const route = await this.resolveBotRoute({
      purpose: 'default',
      chatId: options.chatId,
      botId: options.botId,
    });
    const botId = route.botId ?? this.getDefaultBotId();
    return `https://max.ru/${encodeURIComponent(botId)}?startapp=${encodeURIComponent(startParam)}`;
  }

  async buildBotStartUrl(
    startPayload: string,
    options: { chatId?: string | null; botId?: string | null } = {},
  ): Promise<string | null> {
    if (!isValidMaxBotStartPayload(startPayload)) {
      return null;
    }

    const route = await this.resolveBotRoute({
      purpose: 'default',
      chatId: options.chatId,
      botId: options.botId,
    });
    const botId = route.botId ?? this.getDefaultBotId();
    return `https://max.ru/${encodeURIComponent(botId)}?start=${encodeURIComponent(startPayload)}`;
  }

  async bindChatToBot(params: {
    chatId: string;
    title?: string | null;
    entityType?: ChatEntityType | null;
    botId?: string | null;
    allowReassign?: boolean;
  }): Promise<string | null> {
    const chatId = params.chatId.trim();
    if (!chatId) {
      return null;
    }

    const explicitBotId = this.botRegistry.getBotById(params.botId)?.id ?? null;
    const defaultRoute = await this.resolveBotRoute({
      purpose: 'default',
      chatId,
      botId: params.botId,
    });
    const botId = explicitBotId ?? defaultRoute.botId ?? this.getDefaultBotId();
    const title = params.title?.trim() || `Chat ${chatId}`;
    const entityType = params.entityType ?? undefined;
    const now = new Date();

    try {
      await this.prisma.chat.create({
        data: {
          id: chatId,
          title,
          botId,
          primaryBotId: botId,
          ...(entityType ? { entityType } : {}),
        },
      });
      await this.upsertChatBotMembership(chatId, botId, {
        role: ChatBotMembershipRole.PRIMARY,
        status: ChatBotMembershipStatus.ACTIVE,
        lastSeenAt: now,
        lastWebhookAt: explicitBotId ? now : null,
      });
      this.rememberChatBotBinding(chatId, botId);
      return botId;
    } catch (error: unknown) {
      if (!this.isPrismaKnownError(error, 'P2002')) {
        throw error;
      }
    }

    const existing = await this.prisma.chat.findUnique({
      where: { id: chatId },
      select: { primaryBotId: true, botId: true },
    });
    const existingPrimaryBotId =
      this.botRegistry.getBotById(existing?.primaryBotId ?? existing?.botId ?? null)?.id ?? null;
    const nextPrimaryBotId =
      params.allowReassign === true ? botId : (existingPrimaryBotId ?? botId);

    await this.prisma.chat.update({
      where: { id: chatId },
      data: {
        title,
        botId: nextPrimaryBotId,
        primaryBotId: nextPrimaryBotId,
        ...(entityType ? { entityType } : {}),
      },
    });

    await this.upsertChatBotMembership(chatId, botId, {
      role:
        nextPrimaryBotId === botId
          ? ChatBotMembershipRole.PRIMARY
          : ChatBotMembershipRole.STANDBY,
      status: ChatBotMembershipStatus.ACTIVE,
      lastSeenAt: now,
      lastWebhookAt: explicitBotId ? now : null,
    });

    if (nextPrimaryBotId && nextPrimaryBotId !== botId) {
      await this.upsertChatBotMembership(chatId, nextPrimaryBotId, {
        role: ChatBotMembershipRole.PRIMARY,
        status: ChatBotMembershipStatus.ACTIVE,
        lastSeenAt: now,
      });

      this.logger.debug(
        {
          chatId,
          existingBotId: nextPrimaryBotId,
          incomingBotId: botId,
        },
        'Registered shared chat bot presence without changing the primary bot assignment',
      );
    }

    this.rememberChatBotBinding(chatId, nextPrimaryBotId);
    return nextPrimaryBotId;
  }

  async getChatExecutionBinding(params: {
    chatId: string;
    activeBotId?: string | null;
  }): Promise<ChatBotExecutionBinding> {
    const chatId = params.chatId.trim();
    const activeBotId = this.botRegistry.getBotById(params.activeBotId)?.id ?? null;
    if (!chatId) {
      return {
        chatId,
        activeBotId,
        primaryBotId: null,
        activeMembershipStatus: null,
        assignedBotIds: [],
        shouldHandleGroupUpdate: true,
      };
    }

    const chat = await this.prisma.chat.findUnique({
      where: { id: chatId },
      select: {
        primaryBotId: true,
        botId: true,
        botMemberships: {
          select: {
            botId: true,
            role: true,
            status: true,
          },
        },
      },
    });
    const activeKnownMemberships = (chat?.botMemberships ?? []).filter(
      (membership) =>
        membership.status === ChatBotMembershipStatus.ACTIVE &&
        Boolean(this.botRegistry.getBotById(membership.botId)),
    );
    const primaryBotId =
      this.botRegistry.getBotById(chat?.primaryBotId ?? chat?.botId ?? null)?.id ??
      activeKnownMemberships.find((membership) => membership.role === ChatBotMembershipRole.PRIMARY)
        ?.botId ??
      activeKnownMemberships[0]?.botId ??
      null;
    const activeMembership =
      activeBotId && chat?.botMemberships
        ? chat.botMemberships.find((membership) => membership.botId === activeBotId) ?? null
        : null;
    const activeMembershipStatus = activeMembership?.status ?? null;
    const assignedBotIds = Array.from(
      new Set(
        activeKnownMemberships.map((membership) => membership.botId),
      ),
    );
    const shouldHandleGroupUpdate =
      !activeBotId ||
      !primaryBotId ||
      (activeBotId === primaryBotId && activeMembershipStatus !== ChatBotMembershipStatus.REMOVED);

    return {
      chatId,
      activeBotId,
      primaryBotId,
      activeMembershipStatus,
      assignedBotIds,
      shouldHandleGroupUpdate,
    };
  }

  async resolveBotIdForMemberAccess(params: { chatId: string }): Promise<string | null> {
    const route = await this.resolveBotRoute({
      purpose: 'member_access',
      chatId: params.chatId,
    });
    return route.botId;
  }

  async resolveBotIdForModerationAction(params: {
    chatId: string;
    action: ModerationActionPermission;
    fallbackToPrimary?: boolean;
  }): Promise<string | null> {
    const route = await this.resolveBotRoutes({
      purpose: 'moderation_action',
      chatId: params.chatId,
      action: params.action,
      fallbackToPrimary: params.fallbackToPrimary,
    });
    return route.botId;
  }

  async resolveBotIdsForModerationAction(params: {
    chatId: string;
    action: ModerationActionPermission;
    fallbackToPrimary?: boolean;
  }): Promise<string[]> {
    const route = await this.resolveBotRoutes({
      purpose: 'moderation_action',
      chatId: params.chatId,
      action: params.action,
      fallbackToPrimary: params.fallbackToPrimary,
    });
    return route.candidateBotIds;
  }

  async resolveBotIdForCapability(params: {
    chatId: string;
    capability: ManagedEntityBotCapability;
    fallbackToPrimary?: boolean;
  }): Promise<string | null> {
    const route = await this.resolveBotRoute({
      purpose: 'capability',
      chatId: params.chatId,
      capability: params.capability,
      fallbackToPrimary: params.fallbackToPrimary,
    });
    return route.botId;
  }

  async markChatBotRemoved(params: {
    chatId: string;
    botId?: string | null;
    title?: string | null;
    entityType?: ChatEntityType | null;
  }): Promise<string | null> {
    const chatId = params.chatId.trim();
    const botId = this.botRegistry.getBotById(params.botId)?.id ?? null;
    if (!chatId || !botId) {
      return null;
    }

    const title = params.title?.trim() || `Chat ${chatId}`;
    const entityType = params.entityType ?? undefined;
    const now = new Date();

    await this.prisma.chat.upsert({
      where: { id: chatId },
      create: {
        id: chatId,
        title,
        ...(entityType ? { entityType } : {}),
      },
      update: {
        title,
        ...(entityType ? { entityType } : {}),
      },
    });

    await this.prisma.chatBotMembership.upsert({
      where: {
        chatId_botId: {
          chatId,
          botId,
        },
      },
      create: {
        chatId,
        botId,
        role: ChatBotMembershipRole.STANDBY,
        status: ChatBotMembershipStatus.REMOVED,
        lastSeenAt: now,
        lastWebhookAt: now,
      },
      update: {
        role: ChatBotMembershipRole.STANDBY,
        status: ChatBotMembershipStatus.REMOVED,
        lastSeenAt: now,
        lastWebhookAt: now,
      },
    });

    return this.promoteActiveChatBotMembership(chatId, title, entityType);
  }

  async bindDiscoveredChatBots(params: {
    chatId: string;
    primaryBotId?: string | null;
    botIds?: readonly string[] | null;
    title?: string | null;
    entityType?: ChatEntityType | null;
  }): Promise<string | null> {
    const chatId = params.chatId.trim();
    if (!chatId) {
      return null;
    }

    const observedBotIds = Array.from(
      new Set(
        (params.botIds ?? [])
          .map((botId) => this.botRegistry.getBotById(botId)?.id ?? null)
          .filter((botId): botId is string => Boolean(botId)),
      ),
    );
    const normalizedPrimaryBotId =
      this.botRegistry.getBotById(params.primaryBotId)?.id ?? observedBotIds[0] ?? null;
    const title = params.title?.trim() || `Chat ${chatId}`;
    const entityType = params.entityType ?? undefined;
    const now = new Date();
    const existing = await this.prisma.chat.findUnique({
      where: { id: chatId },
      select: { primaryBotId: true, botId: true },
    });
    const existingPrimaryBotId =
      this.botRegistry.getBotById(existing?.primaryBotId ?? existing?.botId ?? null)?.id ?? null;
    const nextPrimaryBotId = existingPrimaryBotId ?? normalizedPrimaryBotId;

    await this.prisma.chat.upsert({
      where: { id: chatId },
      create: {
        id: chatId,
        title,
        botId: nextPrimaryBotId,
        primaryBotId: nextPrimaryBotId,
        ...(entityType ? { entityType } : {}),
      },
      update: {
        title,
        ...(nextPrimaryBotId
          ? { botId: nextPrimaryBotId, primaryBotId: nextPrimaryBotId }
          : {}),
        ...(entityType ? { entityType } : {}),
      },
    });

    for (const observedBotId of observedBotIds) {
      await this.upsertChatBotMembership(chatId, observedBotId, {
        role:
          nextPrimaryBotId === observedBotId
            ? ChatBotMembershipRole.PRIMARY
            : ChatBotMembershipRole.STANDBY,
        status: ChatBotMembershipStatus.ACTIVE,
        lastSeenAt: now,
      });
    }

    if (nextPrimaryBotId && !observedBotIds.includes(nextPrimaryBotId)) {
      await this.upsertChatBotMembership(chatId, nextPrimaryBotId, {
        role: ChatBotMembershipRole.PRIMARY,
        status: ChatBotMembershipStatus.ACTIVE,
        lastSeenAt: now,
      });
    }

    this.rememberChatBotBinding(chatId, nextPrimaryBotId);
    return nextPrimaryBotId;
  }

  private async resolveDefaultBotRoute(params: {
    chatId?: string | null;
    botId?: string | null;
  }): Promise<MaxBotRoute> {
    const chatId = typeof params.chatId === 'string' ? params.chatId.trim() : '';
    const explicitBot = this.botRegistry.getBotById(params.botId);
    if (explicitBot) {
      return this.buildRoute({
        purpose: 'default',
        chatId,
        botId: explicitBot.id,
        candidateBotIds: [explicitBot.id],
        reason: 'explicit',
      });
    }

    if (chatId) {
      const cachedBotId = this.getCachedChatBotId(chatId);
      if (cachedBotId) {
        return this.buildRoute({
          purpose: 'default',
          chatId,
          primaryBotId: cachedBotId,
          botId: cachedBotId,
          candidateBotIds: [cachedBotId],
          reason: 'chat_cache',
        });
      }

      const chat = await this.prisma.chat.findUnique({
        where: { id: chatId },
        select: { primaryBotId: true, botId: true },
      });
      const chatBot = this.botRegistry.getBotById(chat?.primaryBotId ?? chat?.botId ?? null);
      if (chatBot) {
        this.rememberChatBotBinding(chatId, chatBot.id);
        return this.buildRoute({
          purpose: 'default',
          chatId,
          primaryBotId: chatBot.id,
          botId: chatBot.id,
          candidateBotIds: [chatBot.id],
          reason: 'chat_primary',
        });
      }
    }

    const contextBotId = this.botContext.getActiveBotId();
    if (contextBotId) {
      return this.buildRoute({
        purpose: 'default',
        chatId,
        botId: contextBotId,
        candidateBotIds: [contextBotId],
        reason: 'context',
      });
    }

    const defaultBotId = this.getDefaultBotId();
    return this.buildRoute({
      purpose: 'default',
      chatId,
      botId: defaultBotId,
      candidateBotIds: [defaultBotId],
      reason: 'default',
    });
  }

  private async resolveReadBotRoute(chatId: string): Promise<MaxBotRoute> {
    const normalizedChatId = chatId.trim();
    if (!normalizedChatId) {
      return this.buildRoute({
        purpose: 'read',
        chatId: null,
      });
    }

    const memberAccessRoute = await this.resolveMemberAccessBotRoute(normalizedChatId);
    if (memberAccessRoute.botId) {
      return this.buildRoute({
        purpose: 'read',
        chatId: normalizedChatId,
        primaryBotId: memberAccessRoute.primaryBotId,
        botId: memberAccessRoute.botId,
        candidateBotIds: memberAccessRoute.candidateBotIds,
        reason: memberAccessRoute.reason,
      });
    }

    const defaultRoute = await this.resolveDefaultBotRoute({ chatId: normalizedChatId });
    return this.buildRoute({
      purpose: 'read',
      chatId: normalizedChatId,
      primaryBotId: defaultRoute.primaryBotId,
      botId: defaultRoute.botId,
      candidateBotIds: defaultRoute.candidateBotIds,
      reason: defaultRoute.reason,
    });
  }

  private async resolveMemberAccessBotRoute(chatId: string): Promise<MaxBotRoute> {
    const normalizedChatId = chatId.trim();
    if (!normalizedChatId) {
      return this.buildRoute({
        purpose: 'member_access',
        chatId: null,
      });
    }

    const state = await this.loadChatRouteState(normalizedChatId);
    if (!state) {
      return this.buildRoute({
        purpose: 'member_access',
        chatId: normalizedChatId,
      });
    }

    const primaryAdminCapableMembership =
      state.primaryBotId !== null
        ? state.activeKnownMemberships.find((membership) => {
            if (membership.botId !== state.primaryBotId) {
              return false;
            }

            const snapshot = this.normalizeMembershipAccessSnapshot(membership.permissionsSnapshot);
            return Boolean(snapshot && (snapshot.isAdmin || snapshot.isOwner));
          }) ?? null
        : null;
    if (primaryAdminCapableMembership) {
      return this.buildRoute({
        purpose: 'member_access',
        chatId: normalizedChatId,
        primaryBotId: state.primaryBotId,
        botId: primaryAdminCapableMembership.botId,
        candidateBotIds: [primaryAdminCapableMembership.botId],
        reason: 'primary_confirmed',
      });
    }

    const alternateAdminCapableMembership =
      state.activeKnownMemberships.find((membership) => {
        if (membership.botId === state.primaryBotId) {
          return false;
        }

        const snapshot = this.normalizeMembershipAccessSnapshot(membership.permissionsSnapshot);
        return Boolean(snapshot && (snapshot.isAdmin || snapshot.isOwner));
      }) ?? null;
    if (alternateAdminCapableMembership) {
      return this.buildRoute({
        purpose: 'member_access',
        chatId: normalizedChatId,
        primaryBotId: state.primaryBotId,
        botId: alternateAdminCapableMembership.botId,
        candidateBotIds: [alternateAdminCapableMembership.botId],
        reason: 'alternate_confirmed',
      });
    }

    const primaryActiveMembership =
      state.primaryBotId !== null
        ? state.activeKnownMemberships.find((membership) => membership.botId === state.primaryBotId) ??
          null
        : null;
    if (
      primaryActiveMembership &&
      !this.membershipExplicitlyLacksAccess(primaryActiveMembership.permissionsSnapshot)
    ) {
      return this.buildRoute({
        purpose: 'member_access',
        chatId: normalizedChatId,
        primaryBotId: state.primaryBotId,
        botId: primaryActiveMembership.botId,
        candidateBotIds: [primaryActiveMembership.botId],
        reason: 'primary_soft',
      });
    }

    const alternateMembership =
      state.activeKnownMemberships.find(
        (membership) =>
          membership.botId !== state.primaryBotId &&
          !this.membershipExplicitlyLacksAccess(membership.permissionsSnapshot),
      ) ?? null;
    if (alternateMembership) {
      return this.buildRoute({
        purpose: 'member_access',
        chatId: normalizedChatId,
        primaryBotId: state.primaryBotId,
        botId: alternateMembership.botId,
        candidateBotIds: [alternateMembership.botId],
        reason: 'alternate_soft',
      });
    }

    const fallbackBotId = state.primaryBotId ?? state.activeKnownMemberships[0]?.botId ?? null;
    return this.buildRoute({
      purpose: 'member_access',
      chatId: normalizedChatId,
      primaryBotId: state.primaryBotId,
      botId: fallbackBotId,
      candidateBotIds: fallbackBotId ? [fallbackBotId] : [],
      reason:
        fallbackBotId === null
          ? null
          : fallbackBotId === state.primaryBotId
            ? 'primary_fallback'
            : 'alternate_fallback',
    });
  }

  private async resolveModerationActionBotRoute(
    chatId: string,
    action: ModerationActionPermission,
    fallbackToPrimary?: boolean,
  ): Promise<MaxBotRoute> {
    const normalizedChatId = chatId.trim();
    if (!normalizedChatId) {
      return this.buildRoute({
        purpose: 'moderation_action',
        chatId: null,
        action,
      });
    }

    const state = await this.loadChatRouteState(normalizedChatId);
    const candidateBotIds = state
      ? this.buildModerationActionCandidateBotIdsFromState(
          state,
          action,
          fallbackToPrimary !== false,
        )
      : [];
    const selectedBotId = candidateBotIds[0] ?? null;

    return this.buildRoute({
      purpose: 'moderation_action',
      chatId: normalizedChatId,
      primaryBotId: state?.primaryBotId ?? null,
      botId: selectedBotId,
      candidateBotIds,
      reason:
        state && selectedBotId
          ? this.resolveModerationActionRouteReason(state, selectedBotId, action)
          : null,
      action,
    });
  }

  private async resolveCapabilityBotRoute(
    chatId: string,
    capability: ManagedEntityBotCapability,
    fallbackToPrimary?: boolean,
  ): Promise<MaxBotRoute> {
    const normalizedChatId = chatId.trim();
    if (!normalizedChatId) {
      return this.buildRoute({
        purpose: 'capability',
        chatId: null,
        capability,
      });
    }

    const state = await this.loadChatRouteState(normalizedChatId);
    if (!state) {
      return this.buildRoute({
        purpose: 'capability',
        chatId: normalizedChatId,
        capability,
      });
    }

    const partnerBotId =
      state.activeActionableMemberships.find((membership) => {
        if (membership.role === ChatBotMembershipRole.PRIMARY) {
          return false;
        }

        return this.normalizeBotCapabilities(membership.capabilities).includes(capability);
      })?.botId ?? null;
    if (partnerBotId) {
      return this.buildRoute({
        purpose: 'capability',
        chatId: normalizedChatId,
        primaryBotId: state.primaryBotId,
        botId: partnerBotId,
        candidateBotIds: [partnerBotId],
        reason: 'alternate_confirmed',
        capability,
      });
    }

    if (fallbackToPrimary === false || !state.primaryBotId) {
      return this.buildRoute({
        purpose: 'capability',
        chatId: normalizedChatId,
        primaryBotId: state.primaryBotId,
        capability,
      });
    }

    return this.buildRoute({
      purpose: 'capability',
      chatId: normalizedChatId,
      primaryBotId: state.primaryBotId,
      botId: state.primaryBotId,
      candidateBotIds: [state.primaryBotId],
      reason: 'primary_fallback',
      capability,
    });
  }

  private async loadChatRouteState(chatId: string): Promise<ResolvedChatRouteState | null> {
    const normalizedChatId = chatId.trim();
    if (!normalizedChatId) {
      return null;
    }

    const chat = await this.prisma.chat.findUnique({
      where: { id: normalizedChatId },
      select: {
        entityType: true,
        primaryBotId: true,
        botId: true,
        botMemberships: {
          select: {
            botId: true,
            role: true,
            status: true,
            permissionsSnapshot: true,
            capabilities: true,
          },
          orderBy: [{ updatedAt: 'desc' }, { createdAt: 'asc' }],
        },
      },
    });
    if (!chat) {
      return null;
    }

    const memberships = (chat.botMemberships ?? []).filter((membership) =>
      Boolean(this.botRegistry.getBotById(membership.botId)),
    );
    const activeKnownMemberships = memberships.filter(
      (membership) => membership.status === ChatBotMembershipStatus.ACTIVE,
    );
    const activeActionableMemberships = activeKnownMemberships.filter((membership) => {
      const bot = this.botRegistry.getBotById(membership.botId);
      return Boolean(bot && ACTIONABLE_BOT_LIFECYCLE_STATES.has(bot.state));
    });
    const primaryBotId =
      this.botRegistry.getBotById(chat.primaryBotId ?? chat.botId ?? null)?.id ??
      activeKnownMemberships.find((membership) => membership.role === ChatBotMembershipRole.PRIMARY)
        ?.botId ??
      activeKnownMemberships[0]?.botId ??
      null;

    return {
      chatId: normalizedChatId,
      entityType: chat.entityType ?? null,
      primaryBotId,
      memberships,
      activeKnownMemberships,
      activeActionableMemberships,
    };
  }

  private buildModerationActionCandidateBotIdsFromState(
    state: ResolvedChatRouteState,
    action: ModerationActionPermission,
    fallbackToPrimary = true,
  ): string[] {
    const candidateBotIds: string[] = [];
    const pushCandidate = (botId: string | null | undefined) => {
      const normalizedBotId = this.botRegistry.getBotById(botId)?.id ?? null;
      if (!normalizedBotId || candidateBotIds.includes(normalizedBotId)) {
        return;
      }
      candidateBotIds.push(normalizedBotId);
    };

    pushCandidate(
      state.activeActionableMemberships.find((membership) => {
        if (membership.botId !== state.primaryBotId) {
          return false;
        }

        const snapshot = this.normalizeMembershipAccessSnapshot(membership.permissionsSnapshot);
        return this.hasModerationActionPermission(snapshot, action, state.entityType);
      })?.botId ?? null,
    );
    for (const membership of state.activeActionableMemberships) {
      const snapshot = this.normalizeMembershipAccessSnapshot(membership.permissionsSnapshot);
      if (this.hasModerationActionPermission(snapshot, action, state.entityType)) {
        pushCandidate(membership.botId);
      }
    }

    const primaryActiveMembership =
      state.primaryBotId !== null
        ? state.activeActionableMemberships.find(
            (membership) => membership.botId === state.primaryBotId,
          ) ?? null
        : null;
    if (
      primaryActiveMembership &&
      !this.membershipExplicitlyLacksModerationAction(
        primaryActiveMembership.permissionsSnapshot,
        action,
        state.entityType,
      )
    ) {
      pushCandidate(primaryActiveMembership.botId);
    }

    for (const membership of state.activeActionableMemberships) {
      if (
        membership.botId === state.primaryBotId ||
        this.membershipExplicitlyLacksModerationAction(
          membership.permissionsSnapshot,
          action,
          state.entityType,
        )
      ) {
        continue;
      }
      pushCandidate(membership.botId);
    }

    if (fallbackToPrimary !== false) {
      pushCandidate(state.primaryBotId);
      pushCandidate(state.activeActionableMemberships[0]?.botId ?? null);
    }

    return candidateBotIds;
  }

  private resolveModerationActionRouteReason(
    state: ResolvedChatRouteState,
    botId: string,
    action: ModerationActionPermission,
  ): MaxBotRouteReason {
    if (botId === state.primaryBotId) {
      const primaryMembership =
        state.activeActionableMemberships.find((membership) => membership.botId === botId) ?? null;
      const primarySnapshot = this.normalizeMembershipAccessSnapshot(
        primaryMembership?.permissionsSnapshot,
      );
      if (this.hasModerationActionPermission(primarySnapshot, action, state.entityType)) {
        return 'primary_confirmed';
      }
      if (
        primaryMembership &&
        !this.membershipExplicitlyLacksModerationAction(
          primaryMembership.permissionsSnapshot,
          action,
          state.entityType,
        )
      ) {
        return 'primary_soft';
      }
      return 'primary_fallback';
    }

    const selectedMembership =
      state.activeActionableMemberships.find((membership) => membership.botId === botId) ?? null;
    const selectedSnapshot = this.normalizeMembershipAccessSnapshot(
      selectedMembership?.permissionsSnapshot,
    );
    if (this.hasModerationActionPermission(selectedSnapshot, action, state.entityType)) {
      return 'alternate_confirmed';
    }
    if (
      selectedMembership &&
      !this.membershipExplicitlyLacksModerationAction(
        selectedMembership.permissionsSnapshot,
        action,
        state.entityType,
      )
    ) {
      return 'alternate_soft';
    }
    return 'alternate_fallback';
  }

  private buildRoute(params: {
    purpose: MaxBotRoutePurpose;
    chatId?: string | null;
    primaryBotId?: string | null;
    botId?: string | null;
    candidateBotIds?: Array<string | null | undefined>;
    reason?: MaxBotRouteReason | null;
    action?: ModerationActionPermission;
    capability?: ManagedEntityBotCapability;
  }): MaxBotRoute {
    const normalizedChatId =
      typeof params.chatId === 'string' && params.chatId.trim().length > 0
        ? params.chatId.trim()
        : null;
    const normalizedPrimaryBotId = this.botRegistry.getBotById(params.primaryBotId)?.id ?? null;
    const normalizedBotId = this.botRegistry.getBotById(params.botId)?.id ?? null;
    const normalizedCandidateBotIds = Array.from(
      new Set(
        (params.candidateBotIds ?? [])
          .map((botId) => this.botRegistry.getBotById(botId)?.id ?? null)
          .filter((botId): botId is string => Boolean(botId)),
      ),
    );
    const candidateBotIds =
      normalizedBotId && !normalizedCandidateBotIds.includes(normalizedBotId)
        ? [normalizedBotId, ...normalizedCandidateBotIds]
        : normalizedCandidateBotIds;
    const botId = normalizedBotId ?? candidateBotIds[0] ?? null;
    const baseRoute = {
      purpose: params.purpose,
      chatId: normalizedChatId,
      primaryBotId: normalizedPrimaryBotId,
      botId,
      candidateBotIds,
      reason: params.reason ?? null,
    };

    if (params.purpose === 'moderation_action') {
      return {
        ...baseRoute,
        purpose: 'moderation_action',
        action: params.action ?? 'delete_message',
      };
    }

    if (params.purpose === 'capability') {
      return {
        ...baseRoute,
        purpose: 'capability',
        capability: params.capability ?? 'access_prewarm',
      };
    }

    return {
      ...baseRoute,
      purpose: params.purpose,
    };
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

  private normalizeBotCapabilities(value: unknown): ManagedEntityBotCapability[] {
    if (!Array.isArray(value)) {
      return [];
    }

    const supported = new Set<ManagedEntityBotCapability>([
      'background_scans',
      'channel_stats',
      'suggestion_delivery',
      'membership_prewarm',
      'access_prewarm',
    ]);

    return Array.from(
      new Set(
        value
          .map((item) => (typeof item === 'string' ? item.trim() : ''))
          .filter((item): item is ManagedEntityBotCapability =>
            supported.has(item as ManagedEntityBotCapability),
        ),
      ),
    );
  }

  private normalizeMembershipAccessSnapshot(value: unknown): MembershipAccessSnapshot | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }

    const row = value as Record<string, unknown>;
    const permissions = Array.isArray(row.permissions)
      ? Array.from(
          new Set(
            row.permissions
              .map((permission) => this.normalizePermissionName(permission))
              .filter((permission): permission is string => permission.length > 0),
          ),
        )
      : [];
    return {
      isAdmin: row.isAdmin === true,
      isOwner: row.isOwner === true,
      permissions,
    };
  }

  private membershipExplicitlyLacksAccess(value: unknown): boolean {
    const snapshot = this.normalizeMembershipAccessSnapshot(value);
    return Boolean(snapshot && !snapshot.isAdmin && !snapshot.isOwner);
  }

  private hasModerationActionPermission(
    snapshot: MembershipAccessSnapshot | null,
    action: ModerationActionPermission,
    entityType: ChatEntityType | null,
  ): boolean {
    if (!snapshot) {
      return false;
    }

    if (snapshot.isOwner) {
      return true;
    }

    // MAX group-chat membership snapshots often omit explicit delete aliases
    // even when the admin bot can delete offending user messages.
    if (action === 'delete_message' && this.adminImpliesDeleteMessage(entityType)) {
      return snapshot.isAdmin;
    }

    if (snapshot.permissions.length === 0) {
      return snapshot.isAdmin;
    }

    return snapshot.permissions.some((permission) =>
      this.isModerationActionPermission(permission, action),
    );
  }

  private membershipExplicitlyLacksModerationAction(
    value: unknown,
    action: ModerationActionPermission,
    entityType: ChatEntityType | null,
  ): boolean {
    const snapshot = this.normalizeMembershipAccessSnapshot(value);
    if (!snapshot) {
      return false;
    }

    if (snapshot.isOwner) {
      return false;
    }

    if (action === 'delete_message' && this.adminImpliesDeleteMessage(entityType)) {
      return !snapshot.isAdmin;
    }

    if (snapshot.permissions.length === 0) {
      return !snapshot.isAdmin;
    }

    return !snapshot.permissions.some((permission) =>
      this.isModerationActionPermission(permission, action),
    );
  }

  private isModerationActionPermission(
    permission: string,
    action: ModerationActionPermission,
  ): boolean {
    const normalized = this.normalizePermissionName(permission);
    if (!normalized) {
      return false;
    }

    return action === 'delete_message'
      ? DELETE_MESSAGE_PERMISSION_ALIASES.has(normalized)
      : MODERATE_MEMBER_PERMISSION_ALIASES.has(normalized);
  }

  private adminImpliesDeleteMessage(entityType: ChatEntityType | null): boolean {
    return entityType !== ChatEntityType.CHANNEL;
  }

  private normalizePermissionName(permission: unknown): string {
    if (typeof permission !== 'string') {
      return '';
    }

    return permission
      .trim()
      .toLowerCase()
      .replace(/[-\s]+/gu, '_');
  }

  private async promoteActiveChatBotMembership(
    chatId: string,
    title: string,
    entityType?: ChatEntityType,
  ): Promise<string | null> {
    const memberships = await this.prisma.chatBotMembership.findMany({
      where: { chatId },
      orderBy: [{ updatedAt: 'desc' }, { createdAt: 'asc' }],
      select: {
        botId: true,
        role: true,
        status: true,
      },
    });

    const activeMemberships = memberships.filter(
      (membership) =>
        membership.status === ChatBotMembershipStatus.ACTIVE &&
        this.botRegistry.getBotById(membership.botId),
    );
    const nextPrimaryBotId =
      activeMemberships.find((membership) => membership.role === ChatBotMembershipRole.PRIMARY)?.botId ??
      activeMemberships[0]?.botId ??
      null;

    await this.prisma.chat.update({
      where: { id: chatId },
      data: {
        title,
        botId: nextPrimaryBotId,
        primaryBotId: nextPrimaryBotId,
        ...(entityType ? { entityType } : {}),
      },
    });

    if (!nextPrimaryBotId) {
      this.forgetChatBotBinding(chatId);
      return null;
    }

    await this.prisma.chatBotMembership.updateMany({
      where: {
        chatId,
        status: ChatBotMembershipStatus.ACTIVE,
      },
      data: {
        role: ChatBotMembershipRole.STANDBY,
      },
    });
    await this.prisma.chatBotMembership.updateMany({
      where: {
        chatId,
        botId: nextPrimaryBotId,
        status: ChatBotMembershipStatus.ACTIVE,
      },
      data: {
        role: ChatBotMembershipRole.PRIMARY,
      },
    });

    this.rememberChatBotBinding(chatId, nextPrimaryBotId);
    return nextPrimaryBotId;
  }

  private async upsertChatBotMembership(
    chatId: string,
    botId: string,
    params: {
      role: ChatBotMembershipRole;
      status: ChatBotMembershipStatus;
      lastSeenAt?: Date | null;
      lastWebhookAt?: Date | null;
    },
  ): Promise<void> {
    await this.prisma.chatBotMembership.upsert({
      where: {
        chatId_botId: {
          chatId,
          botId,
        },
      },
      create: {
        chatId,
        botId,
        role: params.role,
        status: params.status,
        ...(params.lastSeenAt ? { lastSeenAt: params.lastSeenAt } : {}),
        ...(params.lastWebhookAt ? { lastWebhookAt: params.lastWebhookAt } : {}),
      },
      update: {
        role: params.role,
        status: params.status,
        ...(params.lastSeenAt ? { lastSeenAt: params.lastSeenAt } : {}),
        ...(params.lastWebhookAt ? { lastWebhookAt: params.lastWebhookAt } : {}),
      },
    });
  }
}
