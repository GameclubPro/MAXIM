import { Injectable, Logger } from '@nestjs/common';
import {
  ChatBotAccessState,
  ChatCatalogKind,
  ChatBotMembershipRole,
  ChatBotMembershipStatus,
  ChatEntityType,
  ChatRoutingState,
  Prisma,
} from '../prisma/prisma-client';
import type { ManagedEntityBotCapability } from '@maxim/contracts';
import { resolveChatCatalogKind } from '../common/chat-catalog-kind.util';
import { PrismaService } from '../prisma/prisma.service';
import { isValidMaxBotStartPayload, isValidMaxMiniappStartPayload } from './max-deep-link.util';
import { MaxBotContextService } from './max-bot-context.service';
import { MaxBotRegistryService, type MaxBotDefinition } from './max-bot-registry.service';
import {
  canAuthenticateInitDataForBotState,
  canDiscoverChatsForBotState,
  canExecuteActionsForBotState,
  isOperationalBotState,
} from './max-bot-state.util';
import {
  membershipExplicitlyLacksAccess,
  isFreshMembershipAccessSnapshot,
  normalizeMembershipAccessSnapshot,
  normalizePermissionName,
  resolvePreferredPrimaryBotId,
  type MembershipAccessSnapshot,
} from './max-bot-access-policy.util';
import {
  buildBotAccessSnapshotPersistence,
  type BotAccessSnapshotInput,
} from './bot-access-snapshot.util';
import {
  hasConfirmedDeleteMessageAccess,
  resolveDeleteMessageAccessFailure,
  type MaxDeleteMessageAccessFailureReason,
} from './max-delete-message-access.util';
import {
  MAX_SEND_ROUTE_DISAPPEARANCE_FAILURE_CODE,
  MAX_SEND_ROUTE_QUARANTINE_MS,
} from './max-send-route-health';

const CHAT_BOT_CACHE_TTL_MS = 10 * 60 * 1_000;
const OBSERVED_WEBHOOK_TOUCH_TTL_MS = 60 * 1_000;
const SEND_ROUTE_STICKY_DISAPPEARANCE_THRESHOLD = 2;
const SEND_ROUTE_OPEN_CIRCUIT_RECHECK_MS = 15 * 60_000;
const EDIT_MESSAGE_PERMISSION_ALIASES = new Set([
  'edit',
  'edit_message',
  'edit_messages',
  'can_edit_message',
  'can_edit_messages',
  'post_edit_delete_message',
  'post_edit_delete_messages',
  'can_post_edit_delete_message',
  'can_post_edit_delete_messages',
]);
const WRITE_MESSAGE_PERMISSION_ALIASES = new Set(['write', 'can_write']);
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

type ModerationActionPermission = 'delete_message' | 'edit_message' | 'moderate_member';

type ChatBotBindingCacheEntry = {
  botId: string;
  expiresAtMs: number;
};

export type ChatBotExecutionBinding = {
  chatId: string;
  activeBotId: string | null;
  primaryBotId: string | null;
  activeMembershipStatus: ChatBotMembershipStatus | null;
  assignedBotIds: string[];
  shouldHandleGroupUpdate: boolean;
};

export type ChatRoutingStateReconcileResult = {
  routingState: ChatRoutingState;
  changed: boolean;
};

export type MaxBotRoutePurpose =
  | 'default'
  | 'read'
  | 'send_message'
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
      routingVersion?: number | null;
    }
  | {
      purpose: 'send_message';
      chatId: string | null;
      primaryBotId: string | null;
      botId: string | null;
      candidateBotIds: string[];
      reason: MaxBotRouteReason | null;
      routingVersion?: number | null;
      quarantinedCandidateBotIds?: string[];
      halfOpenCandidateBotIds?: string[];
      retryAt?: Date | null;
    }
  | {
      purpose: 'moderation_action';
      chatId: string | null;
      primaryBotId: string | null;
      botId: string | null;
      candidateBotIds: string[];
      reason: MaxBotRouteReason | null;
      routingVersion?: number | null;
      action: ModerationActionPermission;
    }
  | {
      purpose: 'capability';
      chatId: string | null;
      primaryBotId: string | null;
      botId: string | null;
      candidateBotIds: string[];
      reason: MaxBotRouteReason | null;
      routingVersion?: number | null;
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
      purpose: 'send_message';
      chatId: string;
      fallbackToPrimary?: boolean;
      allowHalfOpenProbe?: boolean;
    }
  | {
      purpose: 'moderation_action';
      chatId: string;
      action: ModerationActionPermission;
      fallbackToPrimary?: boolean;
    }
  | {
      purpose: 'capability';
      chatId: string;
      capability: ManagedEntityBotCapability;
      fallbackToPrimary?: boolean;
    };

export type MaxDeleteMessageCapabilityState =
  | 'confirmed_capable'
  | 'stale_or_unknown'
  | 'explicitly_incapable';

export type MaxDeleteMessageCapabilityReason =
  | MaxDeleteMessageAccessFailureReason
  | 'confirmed'
  | 'chat_not_found'
  | 'no_active_membership'
  | 'snapshot_stale'
  | 'access_state_unconfirmed'
  | 'access_denied'
  | 'bot_not_actionable';

export type MaxDeleteMessageCandidateCapability = {
  botId: string;
  state: MaxDeleteMessageCapabilityState;
  reason: MaxDeleteMessageCapabilityReason;
  checkedAt: string | null;
  expiresAt: string | null;
  routeEligible: boolean;
};

export type MaxDeleteMessageBotRoute = {
  purpose: 'moderation_action';
  action: 'delete_message';
  chatId: string | null;
  entityType: ChatEntityType | null;
  routingState: ChatRoutingState | null;
  routingVersion: number | null;
  primaryBotId: string | null;
  botId: string | null;
  candidateBotIds: string[];
  reason: MaxBotRouteReason | null;
  capabilityState: MaxDeleteMessageCapabilityState;
  capabilityReason: MaxDeleteMessageCapabilityReason;
  checkedAt: string | null;
  expiresAt: string | null;
  candidateCapabilities: MaxDeleteMessageCandidateCapability[];
};

type ResolvedChatRouteMembership = {
  botId: string;
  role: ChatBotMembershipRole;
  status: ChatBotMembershipStatus;
  botAccessState: ChatBotAccessState;
  botAccessCheckedAt: Date | null;
  botAccessExpiresAt: Date | null;
  permissionsSnapshot: unknown;
  capabilities: unknown;
  sendRouteFailureCount: number;
  sendRouteQuarantinedUntil: Date | null;
  sendRouteLastFailureCode: string | null;
};

type ResolvedChatRouteState = {
  chatId: string;
  entityType: ChatEntityType | null;
  routingState: ChatRoutingState;
  hasStoredBotAssignment: boolean;
  storedPrimaryBotId: string | null;
  primaryBotId: string | null;
  routingVersion: number;
  memberships: ResolvedChatRouteMembership[];
  activeKnownMemberships: ResolvedChatRouteMembership[];
  activeOperationalMemberships: ResolvedChatRouteMembership[];
  activeActionableMemberships: ResolvedChatRouteMembership[];
};

type ChatBotMembershipUpsertResult = {
  active: boolean;
  lifecycleAdvanced: boolean;
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
    return this.resolveExecutableBotId(this.botContext.getActiveBotId()) ?? this.getEntryBotId();
  }

  buildBotUrlSync(botId?: string | null): string {
    return `https://max.ru/${encodeURIComponent(this.resolveBotIdSync(botId))}`;
  }

  buildInitDataBotUrlSync(botId: string | null | undefined): string | null {
    const bot = this.botRegistry.getBotById(botId);
    return bot && canAuthenticateInitDataForBotState(bot.state)
      ? `https://max.ru/${encodeURIComponent(bot.id)}`
      : null;
  }

  getResolvedBotSync(botId?: string | null): MaxBotDefinition {
    return (
      this.getOperationalBotById(botId) ??
      this.getOperationalBotById(this.botContext.getActiveBotId()) ??
      this.botRegistry.getEntryBot()
    );
  }

  getBotTokenSync(botId?: string | null): string {
    return this.getResolvedBotSync(botId).token;
  }

  getExecutableBotById(botId: string | null | undefined): MaxBotDefinition | null {
    const bot = this.botRegistry.getBotById(botId);
    return bot && canExecuteActionsForBotState(bot.state) ? bot : null;
  }

  resolveBotIdFromUserId(userId: string | number | null | undefined): string | null {
    return this.botRegistry.resolveBotIdFromUserId(userId);
  }

  resolveExecutableBotId(botId: string | null | undefined): string | null {
    return this.getExecutableBotById(botId)?.id ?? null;
  }

  resolveBotIdSync(botId?: string | null, chatId?: string | null): string {
    const explicitBot = this.getOperationalBotById(botId);
    if (explicitBot) {
      return explicitBot.id;
    }

    const cachedBotId = this.getCachedChatBotId(chatId);
    if (cachedBotId) {
      return cachedBotId;
    }

    const contextBotId = this.resolveOperationalBotId(this.botContext.getActiveBotId());
    if (contextBotId) {
      return contextBotId;
    }

    return this.getEntryBotId();
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
      case 'send_message':
        return this.resolveSendMessageBotRoute(
          request.chatId,
          request.fallbackToPrimary,
          request.allowHalfOpenProbe,
        );
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

  async claimSendRouteHalfOpen(params: {
    chatId: string;
    botId: string;
    claimedAt?: Date;
  }): Promise<Date | null> {
    const chatId = params.chatId.trim();
    const botId = params.botId.trim();
    if (!chatId || !botId) {
      return null;
    }
    const claimedAt = params.claimedAt ?? new Date();
    const quarantinedUntil = new Date(claimedAt.getTime() + MAX_SEND_ROUTE_QUARANTINE_MS);
    const claimed = await this.prisma.chatBotMembership.updateMany({
      where: {
        chatId,
        botId,
        status: ChatBotMembershipStatus.ACTIVE,
        sendRouteFailureCount: 1,
        sendRouteLastFailureCode: MAX_SEND_ROUTE_DISAPPEARANCE_FAILURE_CODE,
        OR: [
          { sendRouteQuarantinedUntil: null },
          { sendRouteQuarantinedUntil: { lte: claimedAt } },
        ],
      },
      data: {
        sendRouteQuarantinedUntil: quarantinedUntil,
      },
    });
    return claimed.count === 1 ? quarantinedUntil : null;
  }

  async releaseSendRouteHalfOpen(params: {
    chatId: string;
    botId: string;
    claimedUntil: Date;
  }): Promise<boolean> {
    const chatId = params.chatId.trim();
    const botId = params.botId.trim();
    if (!chatId || !botId) {
      return false;
    }
    const released = await this.prisma.chatBotMembership.updateMany({
      where: {
        chatId,
        botId,
        status: ChatBotMembershipStatus.ACTIVE,
        sendRouteFailureCount: 1,
        sendRouteLastFailureCode: MAX_SEND_ROUTE_DISAPPEARANCE_FAILURE_CODE,
        sendRouteQuarantinedUntil: params.claimedUntil,
      },
      data: { sendRouteQuarantinedUntil: null },
    });
    return released.count === 1;
  }

  async resolveBotId(
    options: { chatId?: string | null; botId?: string | null } = {},
  ): Promise<string> {
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

  async resolveBotIdForSend(params: {
    chatId: string;
    fallbackToPrimary?: boolean;
  }): Promise<string | null> {
    const route = await this.resolveBotRoute({
      purpose: 'send_message',
      chatId: params.chatId,
      fallbackToPrimary: params.fallbackToPrimary,
    });
    return route.botId;
  }

  async resolveBotIdForChannelPoll(params: { chatId: string }): Promise<string | null> {
    return this.resolveBotIdForManagedPoll(params);
  }

  async resolveBotRouteForChannelPoll(params: { chatId: string }): Promise<MaxBotRoute> {
    return this.resolveBotRouteForManagedPoll(params);
  }

  async resolveBotIdForManagedPoll(params: { chatId: string }): Promise<string | null> {
    return (await this.resolveBotRouteForManagedPoll(params)).botId;
  }

  async resolveBotRouteForManagedPoll(params: { chatId: string }): Promise<MaxBotRoute> {
    const normalizedChatId = params.chatId.trim();
    if (!normalizedChatId) {
      return this.buildRoute({
        purpose: 'send_message',
        chatId: null,
      });
    }

    const state = await this.loadChatRouteState(normalizedChatId);
    if (!state || state.routingState === ChatRoutingState.NO_ELIGIBLE_BOT) {
      return this.buildRoute({
        purpose: 'send_message',
        chatId: normalizedChatId,
        routingVersion: state?.routingVersion ?? null,
      });
    }
    const eligible = state.activeActionableMemberships.filter((membership) => {
      const snapshot = normalizeMembershipAccessSnapshot(membership.permissionsSnapshot);
      return (
        this.hasConfirmedSendMessageAccess(snapshot, state.entityType) &&
        (state.entityType !== ChatEntityType.CHANNEL ||
          this.hasModerationActionPermission(snapshot, 'edit_message', ChatEntityType.CHANNEL))
      );
    });
    const primaryBotId =
      eligible.find((membership) => membership.botId === state.primaryBotId)?.botId ?? null;
    const candidates = this.orderSendMessageCandidatesByRouteHealth(
      state,
      Array.from(
        new Set([
          ...(primaryBotId ? [primaryBotId] : []),
          ...eligible.map((membership) => membership.botId),
        ]),
      ),
    );
    const selectedBotId = candidates.candidateBotIds[0] ?? null;
    return this.buildRoute({
      purpose: 'send_message',
      chatId: normalizedChatId,
      primaryBotId: state.primaryBotId,
      botId: selectedBotId,
      candidateBotIds: candidates.candidateBotIds,
      reason:
        selectedBotId === null
          ? null
          : selectedBotId === state.primaryBotId
            ? 'primary_confirmed'
            : 'alternate_confirmed',
      routingVersion: state.routingVersion,
      quarantinedCandidateBotIds: candidates.quarantinedCandidateBotIds,
      halfOpenCandidateBotIds: candidates.halfOpenCandidateBotIds,
      retryAt: candidates.retryAt,
    });
  }

  async getStoredChatPrimaryBotId(
    chatId: string | null | undefined,
    options: { bypassCache?: boolean } = {},
  ): Promise<string | null> {
    const normalizedChatId = typeof chatId === 'string' ? chatId.trim() : '';
    if (!normalizedChatId) {
      return null;
    }

    const chat = await this.prisma.chat.findUnique({
      where: { id: normalizedChatId },
      select: { primaryBotId: true, botId: true, routingState: true },
    });
    if (chat?.routingState === ChatRoutingState.NO_ELIGIBLE_BOT) {
      this.forgetChatBotBinding(normalizedChatId);
      return null;
    }

    const resolvedBotId =
      this.resolveOperationalBotId(chat?.primaryBotId ?? chat?.botId ?? null) ?? null;
    if (options.bypassCache !== true) {
      const cachedBotId = this.getCachedChatBotId(normalizedChatId);
      if (cachedBotId === resolvedBotId) {
        return cachedBotId;
      }
    }
    if (resolvedBotId) {
      this.rememberChatBotBinding(normalizedChatId, resolvedBotId);
    } else {
      this.forgetChatBotBinding(normalizedChatId);
    }

    return resolvedBotId;
  }

  async isBotAccessSnapshotStale(params: {
    chatId: string;
    botId: string;
    maxAgeMs: number;
    now?: Date;
  }): Promise<boolean> {
    const chatId = params.chatId.trim();
    const botId = this.resolveOperationalBotId(params.botId);
    if (!chatId || !botId) {
      return true;
    }

    const membership = await this.prisma.chatBotMembership.findUnique({
      where: {
        chatId_botId: {
          chatId,
          botId,
        },
      },
      select: {
        status: true,
        botAccessCheckedAt: true,
      },
    });
    if (!membership || membership.status !== ChatBotMembershipStatus.ACTIVE) {
      return true;
    }

    const checkedAtMs = membership.botAccessCheckedAt?.getTime() ?? Number.NaN;
    if (!Number.isFinite(checkedAtMs)) {
      return true;
    }

    const maxAgeMs = Math.max(0, Math.trunc(params.maxAgeMs));
    return (params.now ?? new Date()).getTime() - checkedAtMs >= maxAgeMs;
  }

  async recordBotAccessProbe(params: {
    chatId: string;
    botId: string;
    access: BotAccessSnapshotInput;
    source: string;
    checkedAt?: Date;
    allowMembershipRecovery?: boolean;
  }): Promise<boolean> {
    const chatId = params.chatId.trim();
    const botId = this.resolveOperationalBotId(params.botId);
    if (!chatId || !botId) {
      return false;
    }

    const checkedAt = params.checkedAt ?? new Date();
    let result = await this.prisma.chatBotMembership.updateMany({
      where: {
        chatId,
        botId,
        status: ChatBotMembershipStatus.ACTIVE,
      },
      data: {
        ...buildBotAccessSnapshotPersistence(params.access, {
          source: params.source,
          now: checkedAt,
        }),
        lastSeenAt: checkedAt,
      },
    });
    if (result.count === 0 && params.allowMembershipRecovery === true && params.access) {
      const membership = await this.upsertChatBotMembership(chatId, botId, {
        role: ChatBotMembershipRole.STANDBY,
        status: ChatBotMembershipStatus.ACTIVE,
        lastSeenAt: checkedAt,
        lifecycleEventAt: checkedAt,
        lifecycleEventType: 'live_probe',
        lifecycleSource: 'live_probe',
        allowReactivation: true,
      });
      if (membership.active) {
        result = await this.prisma.chatBotMembership.updateMany({
          where: {
            chatId,
            botId,
            status: ChatBotMembershipStatus.ACTIVE,
          },
          data: {
            ...buildBotAccessSnapshotPersistence(params.access, {
              source: params.source,
              now: checkedAt,
            }),
            lastSeenAt: checkedAt,
          },
        });
      }
    }
    if (result.count > 0) {
      await this.reconcileChatPrimaryByAccess({ chatId });
    }
    return result.count > 0;
  }

  async reconcileChatRoutingState(params: {
    chatId: string;
    forceVersionBump?: boolean;
  }): Promise<ChatRoutingStateReconcileResult | null> {
    return this.reconcileChatRoutingStateAttempt(
      params.chatId,
      2,
      params.forceVersionBump === true,
    );
  }

  private async reconcileChatRoutingStateAttempt(
    rawChatId: string,
    attemptsRemaining: number,
    forceVersionBump: boolean,
  ): Promise<ChatRoutingStateReconcileResult | null> {
    const chatId = rawChatId.trim();
    if (!chatId) {
      return null;
    }

    const state = await this.loadChatRouteState(chatId);
    if (!state) {
      return null;
    }
    const nextRoutingState = this.resolvePersistedRoutingState(state);
    const shouldClearStoredAssignment =
      nextRoutingState === ChatRoutingState.NO_ELIGIBLE_BOT && state.hasStoredBotAssignment;
    if (
      state.routingState === nextRoutingState &&
      !shouldClearStoredAssignment &&
      !forceVersionBump
    ) {
      if (nextRoutingState === ChatRoutingState.NO_ELIGIBLE_BOT) {
        this.forgetChatBotBinding(chatId);
      }
      return { routingState: nextRoutingState, changed: false };
    }

    const updated = await this.prisma.chat.updateMany({
      where: {
        id: chatId,
        routingState: state.routingState,
        routingVersion: state.routingVersion,
      },
      data: {
        routingState: nextRoutingState,
        routingVersion: { increment: 1 },
        ...(nextRoutingState === ChatRoutingState.NO_ELIGIBLE_BOT
          ? { botId: null, primaryBotId: null }
          : {}),
      },
    });
    if (updated.count === 0 && attemptsRemaining > 1) {
      return this.reconcileChatRoutingStateAttempt(chatId, attemptsRemaining - 1, forceVersionBump);
    }
    if (updated.count === 0) {
      if (forceVersionBump) {
        throw new Error(`Chat ${chatId} routing state changed during forced reconciliation`);
      }
      return null;
    }

    if (nextRoutingState === ChatRoutingState.NO_ELIGIBLE_BOT) {
      this.forgetChatBotBinding(chatId);
    }
    return { routingState: nextRoutingState, changed: true };
  }

  async observeStoredChatBotWebhook(params: {
    chatId: string;
    primaryBotId?: string | null;
    botId?: string | null;
    observedAt?: Date | null;
  }): Promise<void> {
    const chatId = params.chatId.trim();
    const primaryBotId = this.resolveOperationalBotId(params.primaryBotId);
    const observedBotId = this.resolveOperationalBotId(params.botId);
    if (!chatId || !observedBotId) {
      return;
    }

    const cacheKey = `${chatId}:${observedBotId}`;
    const nowMs = Date.now();
    if ((this.observedWebhookTouchCache.get(cacheKey) ?? 0) > nowMs) {
      return;
    }

    const now = params.observedAt ?? new Date(nowMs);
    const touched = await this.prisma.chatBotMembership.updateMany({
      where: {
        chatId,
        botId: observedBotId,
        status: ChatBotMembershipStatus.ACTIVE,
      },
      data: {
        ...(primaryBotId
          ? {
              role:
                observedBotId === primaryBotId
                  ? ChatBotMembershipRole.PRIMARY
                  : ChatBotMembershipRole.STANDBY,
            }
          : {}),
        lastSeenAt: now,
        lastWebhookAt: now,
      },
    });
    if (touched.count === 0) {
      return;
    }
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
    const normalizedBotId = this.resolveOperationalBotId(botId);
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

  async resolveContactId(
    options: { chatId?: string | null; botId?: string | null } = {},
  ): Promise<string | null> {
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
    lifecycleEventAt?: Date | null;
    lifecycleEventType?: string | null;
    lifecycleSource?: string | null;
    preserveRemovedMembership?: boolean;
  }): Promise<string | null> {
    const chatId = params.chatId.trim();
    if (!chatId) {
      return null;
    }

    const explicitBotId = this.resolveOperationalBotId(params.botId);
    const defaultRoute = await this.resolveBotRoute({
      purpose: 'default',
      chatId,
      botId: params.botId,
    });
    const botId = explicitBotId ?? defaultRoute.botId ?? this.getDefaultBotId();
    const title = params.title?.trim() || `Chat ${chatId}`;
    const entityType = params.entityType ?? undefined;
    const catalogKind = resolveChatCatalogKind({
      chatId,
      entityType: entityType ?? null,
      managedHint: true,
    });
    const now = new Date();

    const created = await this.prisma.chat.createMany({
      data: {
        id: chatId,
        title,
        botId,
        primaryBotId: botId,
        routingState: ChatRoutingState.NO_ELIGIBLE_BOT,
        ...(entityType ? { entityType } : {}),
        catalogKind,
      },
      skipDuplicates: true,
    });

    if (created.count > 0) {
      const membershipResult = await this.upsertChatBotMembership(chatId, botId, {
        role: ChatBotMembershipRole.PRIMARY,
        status: ChatBotMembershipStatus.ACTIVE,
        lastSeenAt: now,
        lastWebhookAt: explicitBotId ? now : null,
        lifecycleEventAt: params.lifecycleEventAt,
        lifecycleEventType: params.lifecycleEventType,
        lifecycleSource: params.lifecycleSource,
        allowReactivation:
          params.lifecycleEventType === 'bot_added' || params.lifecycleSource === 'live_probe',
        preserveRemovedMembership:
          params.preserveRemovedMembership ??
          (params.lifecycleEventType !== 'bot_added' && params.lifecycleSource !== 'live_probe'),
      });
      if (membershipResult.lifecycleAdvanced && params.lifecycleEventAt) {
        await this.markChatRoutingReadyFromLifecycleProof({
          chatId,
          botId,
          lifecycleEventAt: params.lifecycleEventAt,
          lifecycleEventType: params.lifecycleEventType ?? '',
          lifecycleSource: params.lifecycleSource ?? '',
        });
      }
      this.rememberChatBotBinding(chatId, botId);
      return membershipResult.active ? botId : null;
    }

    const existing = await this.prisma.chat.findUnique({
      where: { id: chatId },
      select: { primaryBotId: true, botId: true },
    });
    const existingPrimaryBotId = this.resolveOperationalBotId(
      existing?.primaryBotId ?? existing?.botId ?? null,
    );
    const nextPrimaryBotId =
      params.allowReassign === true ? botId : (existingPrimaryBotId ?? botId);

    await this.prisma.chat.update({
      where: { id: chatId },
      data: {
        title,
        botId: nextPrimaryBotId,
        primaryBotId: nextPrimaryBotId,
        ...(entityType ? { entityType } : {}),
        catalogKind,
      },
    });

    const incomingMembershipResult = await this.upsertChatBotMembership(chatId, botId, {
      role:
        nextPrimaryBotId === botId ? ChatBotMembershipRole.PRIMARY : ChatBotMembershipRole.STANDBY,
      status: ChatBotMembershipStatus.ACTIVE,
      lastSeenAt: now,
      lastWebhookAt: explicitBotId ? now : null,
      lifecycleEventAt: params.lifecycleEventAt,
      lifecycleEventType: params.lifecycleEventType,
      lifecycleSource: params.lifecycleSource,
      allowReactivation:
        params.lifecycleEventType === 'bot_added' || params.lifecycleSource === 'live_probe',
      preserveRemovedMembership:
        params.preserveRemovedMembership ??
        (params.lifecycleEventType !== 'bot_added' && params.lifecycleSource !== 'live_probe'),
    });
    if (incomingMembershipResult.lifecycleAdvanced && params.lifecycleEventAt) {
      await this.markChatRoutingReadyFromLifecycleProof({
        chatId,
        botId,
        lifecycleEventAt: params.lifecycleEventAt,
        lifecycleEventType: params.lifecycleEventType ?? '',
        lifecycleSource: params.lifecycleSource ?? '',
      });
    }

    if (nextPrimaryBotId && nextPrimaryBotId !== botId) {
      await this.upsertChatBotMembership(chatId, nextPrimaryBotId, {
        role: ChatBotMembershipRole.PRIMARY,
        status: ChatBotMembershipStatus.ACTIVE,
        lastSeenAt: now,
        preserveRemovedMembership: true,
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

    const reconciledPrimaryBotId =
      nextPrimaryBotId === botId && !incomingMembershipResult.active
        ? await this.promoteActiveChatBotMembership(chatId, title, entityType)
        : await this.reconcileChatPrimaryByAccess({
            chatId,
            title,
            entityType,
          });
    const resolvedPrimaryBotId =
      reconciledPrimaryBotId ??
      (nextPrimaryBotId !== botId || incomingMembershipResult.active ? nextPrimaryBotId : null);
    if (resolvedPrimaryBotId) {
      this.rememberChatBotBinding(chatId, resolvedPrimaryBotId);
    } else {
      this.forgetChatBotBinding(chatId);
    }
    return resolvedPrimaryBotId;
  }

  async getChatExecutionBinding(params: {
    chatId: string;
    activeBotId?: string | null;
  }): Promise<ChatBotExecutionBinding> {
    const chatId = params.chatId.trim();
    const activeBotId = this.resolveOperationalBotId(params.activeBotId);
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
        routingState: true,
        primaryBotId: true,
        botId: true,
        botMemberships: {
          select: {
            botId: true,
            role: true,
            status: true,
            botAccessState: true,
            botAccessCheckedAt: true,
            permissionsSnapshot: true,
          },
        },
      },
    });
    const routeClosed = chat?.routingState === ChatRoutingState.NO_ELIGIBLE_BOT;
    const activeKnownMemberships = (chat?.botMemberships ?? []).filter(
      (membership) =>
        membership.status === ChatBotMembershipStatus.ACTIVE &&
        Boolean(this.resolveOperationalBotId(membership.botId)),
    );
    const activeExecutableMemberships = activeKnownMemberships.filter(
      (membership) =>
        Boolean(this.resolveExecutableBotId(membership.botId)) &&
        this.isMembershipRouteAccessEligible(membership),
    );
    const accessEligibleActiveExecutableMemberships = activeExecutableMemberships;
    const accessEligibleActiveKnownMemberships = activeKnownMemberships.filter((membership) =>
      this.isMembershipRouteAccessEligible(membership),
    );
    const rawStoredExecutableBotId =
      this.resolveExecutableBotId(chat?.primaryBotId ?? null) ??
      this.resolveExecutableBotId(chat?.botId ?? null);
    const storedExecutableMembership = rawStoredExecutableBotId
      ? (activeExecutableMemberships.find(
          (membership) => membership.botId === rawStoredExecutableBotId,
        ) ?? null)
      : null;
    const storedExecutableBotId =
      rawStoredExecutableBotId &&
      storedExecutableMembership &&
      this.isMembershipRouteAccessEligible(storedExecutableMembership)
        ? rawStoredExecutableBotId
        : null;
    const storedOperationalBotId = this.resolveOperationalBotId(
      chat?.primaryBotId ?? chat?.botId ?? null,
    );
    const storedOperationalMembership = storedOperationalBotId
      ? (activeKnownMemberships.find((membership) => membership.botId === storedOperationalBotId) ??
        null)
      : null;
    const storedAccessEligibleBotId =
      storedOperationalBotId &&
      storedOperationalMembership &&
      this.isMembershipRouteAccessEligible(storedOperationalMembership)
        ? storedOperationalBotId
        : null;
    const executablePrimaryBotId =
      resolvePreferredPrimaryBotId(storedExecutableBotId, activeExecutableMemberships, {
        requireFreshSnapshotForPromotion: true,
      }) ??
      storedExecutableBotId ??
      accessEligibleActiveExecutableMemberships.find(
        (membership) => membership.role === ChatBotMembershipRole.PRIMARY,
      )?.botId ??
      accessEligibleActiveExecutableMemberships[0]?.botId ??
      null;
    const primaryBotId =
      executablePrimaryBotId ??
      resolvePreferredPrimaryBotId(storedAccessEligibleBotId, activeKnownMemberships, {
        requireFreshSnapshotForPromotion: true,
      }) ??
      storedAccessEligibleBotId ??
      accessEligibleActiveKnownMemberships.find(
        (membership) => membership.role === ChatBotMembershipRole.PRIMARY,
      )?.botId ??
      accessEligibleActiveKnownMemberships[0]?.botId ??
      null;
    const activeMembership =
      activeBotId && chat?.botMemberships
        ? (chat.botMemberships.find((membership) => membership.botId === activeBotId) ?? null)
        : null;
    const activeMembershipStatus = activeMembership?.status ?? null;
    const assignedBotIds = Array.from(
      new Set(activeKnownMemberships.map((membership) => membership.botId)),
    );
    const shouldHandleGroupUpdate = Boolean(
      !routeClosed &&
      activeBotId &&
      primaryBotId &&
      activeBotId === primaryBotId &&
      activeMembershipStatus === ChatBotMembershipStatus.ACTIVE &&
      Boolean(activeMembership && this.isMembershipRouteAccessEligible(activeMembership)),
    );

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

  async resolveDeleteMessageBotRoute(params: {
    chatId: string;
    expectedEntityType?: ChatEntityType | null;
    requireFreshSnapshot?: boolean;
  }): Promise<MaxDeleteMessageBotRoute> {
    const chatId = params.chatId.trim();
    if (!chatId) {
      return this.buildEmptyDeleteMessageBotRoute(null, 'chat_not_found');
    }

    const state = await this.loadChatRouteState(chatId);
    if (!state) {
      return this.buildEmptyDeleteMessageBotRoute(chatId, 'chat_not_found');
    }
    const entityType = params.expectedEntityType ?? state.entityType;
    if (params.expectedEntityType && params.expectedEntityType !== state.entityType) {
      this.logger.warn(
        {
          chatId,
          expectedEntityType: params.expectedEntityType,
          persistedEntityType: state.entityType,
        },
        'Using delete-intent entity type over stale managed chat metadata',
      );
    }

    const requireFreshSnapshot = params.requireFreshSnapshot !== false;
    const actionableBotIds = new Set(
      state.activeActionableMemberships.map((membership) => membership.botId),
    );
    const candidateCapabilities = state.activeKnownMemberships
      .map((membership) =>
        this.assessDeleteMessageCandidateCapability(
          membership,
          entityType,
          actionableBotIds.has(membership.botId),
        ),
      )
      .map((candidate) => ({
        ...candidate,
        routeEligible:
          candidate.routeEligible &&
          (candidate.state === 'confirmed_capable' ||
            (!requireFreshSnapshot && state.routingState === ChatRoutingState.READY)),
      }))
      .sort((left, right) => {
        if (left.botId === state.primaryBotId) {
          return -1;
        }
        if (right.botId === state.primaryBotId) {
          return 1;
        }
        return 0;
      });
    const routeCandidates = candidateCapabilities
      .filter((candidate) => candidate.routeEligible)
      .sort((left, right) => {
        const leftConfirmed = left.state === 'confirmed_capable';
        const rightConfirmed = right.state === 'confirmed_capable';
        if (leftConfirmed !== rightConfirmed) {
          return leftConfirmed ? -1 : 1;
        }
        if (left.botId === state.primaryBotId) {
          return -1;
        }
        if (right.botId === state.primaryBotId) {
          return 1;
        }
        return 0;
      });
    const selected = routeCandidates[0] ?? null;
    const aggregate =
      candidateCapabilities.find((candidate) => candidate.state === 'confirmed_capable') ??
      candidateCapabilities.find((candidate) => candidate.state === 'stale_or_unknown') ??
      candidateCapabilities[0] ??
      null;

    return {
      purpose: 'moderation_action',
      action: 'delete_message',
      chatId,
      entityType,
      routingState: state.routingState,
      routingVersion: state.routingVersion,
      primaryBotId: state.primaryBotId,
      botId: selected?.botId ?? null,
      candidateBotIds: routeCandidates.map((candidate) => candidate.botId),
      reason: selected
        ? selected.botId === state.primaryBotId
          ? selected.state === 'confirmed_capable'
            ? 'primary_confirmed'
            : 'primary_soft'
          : selected.state === 'confirmed_capable'
            ? 'alternate_confirmed'
            : 'alternate_soft'
        : null,
      capabilityState: aggregate?.state ?? 'stale_or_unknown',
      capabilityReason: aggregate?.reason ?? 'no_active_membership',
      checkedAt: aggregate?.checkedAt ?? null,
      expiresAt: aggregate?.expiresAt ?? null,
      candidateCapabilities,
    };
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

  async resolveBotIdsForCapability(params: {
    chatId: string;
    capability: ManagedEntityBotCapability;
    fallbackToPrimary?: boolean;
  }): Promise<string[]> {
    const route = await this.resolveBotRoute({
      purpose: 'capability',
      chatId: params.chatId,
      capability: params.capability,
      fallbackToPrimary: params.fallbackToPrimary,
    });
    return route.candidateBotIds;
  }

  async markChatBotRemoved(params: {
    chatId: string;
    botId?: string | null;
    title?: string | null;
    entityType?: ChatEntityType | null;
    accessLostReason?: string | null;
    accessLostSource?: string | null;
    lastMaxErrorCode?: string | null;
    lastMaxErrorMessage?: string | null;
    lastMaxStatusCode?: number | null;
    lifecycleEventAt?: Date | null;
    lifecycleEventType?: string | null;
    lifecycleSource?: string | null;
  }): Promise<string | null> {
    const chatId = params.chatId.trim();
    const botId = this.resolveOperationalBotId(params.botId);
    if (!chatId || !botId) {
      return null;
    }

    const title = params.title?.trim() || `Chat ${chatId}`;
    const entityType = params.entityType ?? undefined;
    const now = new Date();
    const lifecycleEventAt = params.lifecycleEventAt ?? now;
    const lifecycleEventType = params.lifecycleEventType?.trim() || 'bot_removed';
    const lifecycleSource = params.lifecycleSource?.trim() || 'webhook';
    const existingChat = await this.prisma.chat.findUnique({
      where: { id: chatId },
      select: {
        catalogKind: true,
      },
    });
    const catalogKind = resolveChatCatalogKind({
      chatId,
      entityType: entityType ?? null,
      contextOnlyHint: true,
    });
    const preserveManagedCatalogKind =
      existingChat?.catalogKind === ChatCatalogKind.MANAGED &&
      catalogKind === ChatCatalogKind.CONTEXT_ONLY;
    const accessLossSnapshot =
      params.accessLostReason ||
      params.accessLostSource ||
      params.lastMaxErrorCode ||
      params.lastMaxErrorMessage ||
      typeof params.lastMaxStatusCode === 'number'
        ? {
            accessLostReason: params.accessLostReason ?? null,
            accessLostSource: params.accessLostSource ?? null,
            lastMaxErrorCode: params.lastMaxErrorCode ?? null,
            lastMaxErrorMessage: params.lastMaxErrorMessage ?? null,
            lastMaxStatusCode: params.lastMaxStatusCode ?? null,
            accessLostAt: now.toISOString(),
          }
        : null;

    await this.prisma.chat.upsert({
      where: { id: chatId },
      create: {
        id: chatId,
        title,
        routingState: ChatRoutingState.NO_ELIGIBLE_BOT,
        ...(entityType ? { entityType } : {}),
        catalogKind,
      },
      update: {
        title,
        ...(entityType ? { entityType } : {}),
        ...(preserveManagedCatalogKind ? {} : { catalogKind }),
      },
    });

    const removed = await this.prisma.chatBotMembership.updateMany({
      where: {
        chatId,
        botId,
        OR: [
          { lifecycleEventAt: null },
          { lifecycleEventAt: { lt: lifecycleEventAt } },
          {
            lifecycleEventAt,
            status: ChatBotMembershipStatus.ACTIVE,
          },
        ],
      },
      data: {
        role: ChatBotMembershipRole.STANDBY,
        status: ChatBotMembershipStatus.REMOVED,
        ...(accessLossSnapshot ? { permissionsSnapshot: accessLossSnapshot } : {}),
        lastSeenAt: lifecycleEventAt,
        lastWebhookAt: lifecycleEventAt,
        lifecycleEventAt,
        lifecycleEventType,
        lifecycleSource,
      },
    });

    if (removed.count === 0) {
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
          ...(accessLossSnapshot ? { permissionsSnapshot: accessLossSnapshot } : {}),
          lastSeenAt: lifecycleEventAt,
          lastWebhookAt: lifecycleEventAt,
          lifecycleEventAt,
          lifecycleEventType,
          lifecycleSource,
        },
        update: {},
      });
    }

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
          .map((botId) => this.resolveOperationalBotId(botId))
          .filter((botId): botId is string => Boolean(botId)),
      ),
    );
    const normalizedPrimaryBotId =
      this.resolveOperationalBotId(params.primaryBotId) ?? observedBotIds[0] ?? null;
    const title = params.title?.trim() || `Chat ${chatId}`;
    const entityType = params.entityType ?? undefined;
    const now = new Date();
    const existing = await this.prisma.chat.findUnique({
      where: { id: chatId },
      select: { primaryBotId: true, botId: true },
    });
    const existingPrimaryBotId = this.resolveOperationalBotId(
      existing?.primaryBotId ?? existing?.botId ?? null,
    );
    const nextPrimaryBotId = existingPrimaryBotId ?? normalizedPrimaryBotId;
    const catalogKind = resolveChatCatalogKind({
      chatId,
      entityType: entityType ?? null,
      contextOnlyHint: true,
    });

    await this.prisma.chat.upsert({
      where: { id: chatId },
      create: {
        id: chatId,
        title,
        botId: nextPrimaryBotId,
        primaryBotId: nextPrimaryBotId,
        routingState: ChatRoutingState.NO_ELIGIBLE_BOT,
        ...(entityType ? { entityType } : {}),
        catalogKind,
      },
      update: {
        title,
        ...(nextPrimaryBotId ? { botId: nextPrimaryBotId, primaryBotId: nextPrimaryBotId } : {}),
        ...(entityType ? { entityType } : {}),
        catalogKind,
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
        lifecycleEventAt: now,
        lifecycleEventType: 'live_probe',
        lifecycleSource: 'managed_discovery',
        allowReactivation: true,
      });
    }

    if (nextPrimaryBotId && !observedBotIds.includes(nextPrimaryBotId)) {
      await this.upsertChatBotMembership(chatId, nextPrimaryBotId, {
        role: ChatBotMembershipRole.PRIMARY,
        status: ChatBotMembershipStatus.ACTIVE,
        lastSeenAt: now,
        preserveRemovedMembership: true,
      });
    }

    return this.reconcileChatPrimaryByAccess({
      chatId,
      title,
      entityType,
    });
  }

  async reconcileChatPrimaryByAccess(params: {
    chatId: string;
    title?: string | null;
    entityType?: ChatEntityType | null;
  }): Promise<string | null> {
    const chatId = params.chatId.trim();
    if (!chatId) {
      return null;
    }

    const state = await this.loadChatRouteState(chatId);
    if (!state) {
      this.forgetChatBotBinding(chatId);
      return null;
    }

    const nextRoutingState = this.resolvePersistedRoutingState(state);
    if (nextRoutingState === ChatRoutingState.NO_ELIGIBLE_BOT || !state.primaryBotId) {
      await this.reconcileChatRoutingState({ chatId });
      this.forgetChatBotBinding(chatId);
      return null;
    }

    const nextPrimaryBotId =
      resolvePreferredPrimaryBotId(state.primaryBotId, state.activeActionableMemberships, {
        requireFreshSnapshotForPromotion: true,
      }) ?? state.primaryBotId;
    const activeMemberships = state.activeKnownMemberships;
    const roleAlreadyConsistent =
      activeMemberships.some(
        (membership) =>
          membership.botId === nextPrimaryBotId &&
          membership.role === ChatBotMembershipRole.PRIMARY,
      ) &&
      activeMemberships.every(
        (membership) =>
          membership.botId === nextPrimaryBotId ||
          membership.role !== ChatBotMembershipRole.PRIMARY,
      );
    const title = params.title?.trim() || null;
    const entityType = params.entityType ?? null;

    if (
      state.storedPrimaryBotId === nextPrimaryBotId &&
      state.routingState === nextRoutingState &&
      roleAlreadyConsistent &&
      !title &&
      !entityType
    ) {
      this.rememberChatBotBinding(chatId, nextPrimaryBotId);
      return nextPrimaryBotId;
    }

    await this.prisma.chat.update({
      where: { id: chatId },
      data: {
        ...(title ? { title } : {}),
        botId: nextPrimaryBotId,
        primaryBotId: nextPrimaryBotId,
        routingState: nextRoutingState,
        ...(entityType ? { entityType } : {}),
      },
    });

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

  private async resolveDefaultBotRoute(params: {
    chatId?: string | null;
    botId?: string | null;
  }): Promise<MaxBotRoute> {
    const chatId = typeof params.chatId === 'string' ? params.chatId.trim() : '';
    const state = chatId ? await this.loadChatRouteState(chatId) : null;
    if (state?.routingState === ChatRoutingState.NO_ELIGIBLE_BOT) {
      this.forgetChatBotBinding(chatId);
      return this.buildRoute({
        purpose: 'default',
        chatId,
        routingVersion: state.routingVersion,
      });
    }

    const explicitBot = this.getOperationalBotById(params.botId);
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
      if (state?.primaryBotId) {
        this.rememberChatBotBinding(chatId, state.primaryBotId);
        return this.buildRoute({
          purpose: 'default',
          chatId,
          primaryBotId: state.primaryBotId,
          botId: state.primaryBotId,
          candidateBotIds: [state.primaryBotId],
          reason: 'chat_primary',
        });
      }

      const cachedBotId = this.getCachedChatBotId(chatId);
      if (cachedBotId) {
        const cachedMembership =
          state?.activeOperationalMemberships.find(
            (membership) => membership.botId === cachedBotId,
          ) ?? null;
        if (
          cachedMembership &&
          membershipExplicitlyLacksAccess(cachedMembership.permissionsSnapshot)
        ) {
          return this.buildRoute({
            purpose: 'default',
            chatId,
          });
        }
        return this.buildRoute({
          purpose: 'default',
          chatId,
          primaryBotId: cachedBotId,
          botId: cachedBotId,
          candidateBotIds: [cachedBotId],
          reason: 'chat_cache',
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

    const defaultBotId = this.getEntryBotId();
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
        routingVersion: memberAccessRoute.routingVersion ?? null,
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
      routingVersion: defaultRoute.routingVersion ?? null,
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
    if (state.routingState === ChatRoutingState.NO_ELIGIBLE_BOT) {
      return this.buildRoute({
        purpose: 'member_access',
        chatId: normalizedChatId,
        routingVersion: state.routingVersion,
      });
    }

    const primaryAdminCapableMembership =
      state.primaryBotId !== null
        ? (state.activeOperationalMemberships.find((membership) => {
            if (membership.botId !== state.primaryBotId) {
              return false;
            }

            const snapshot = normalizeMembershipAccessSnapshot(membership.permissionsSnapshot);
            return Boolean(snapshot && (snapshot.isAdmin || snapshot.isOwner));
          }) ?? null)
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
      state.activeOperationalMemberships.find((membership) => {
        if (membership.botId === state.primaryBotId) {
          return false;
        }

        const snapshot = normalizeMembershipAccessSnapshot(membership.permissionsSnapshot);
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
        ? (state.activeOperationalMemberships.find(
            (membership) => membership.botId === state.primaryBotId,
          ) ?? null)
        : null;
    if (
      primaryActiveMembership &&
      !membershipExplicitlyLacksAccess(primaryActiveMembership.permissionsSnapshot)
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
      state.activeOperationalMemberships.find(
        (membership) =>
          membership.botId !== state.primaryBotId &&
          !membershipExplicitlyLacksAccess(membership.permissionsSnapshot),
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

    const fallbackBotId =
      state.activeOperationalMemberships.find(
        (membership) =>
          membership.botId === state.primaryBotId &&
          !membershipExplicitlyLacksAccess(membership.permissionsSnapshot),
      )?.botId ??
      state.activeOperationalMemberships.find(
        (membership) => !membershipExplicitlyLacksAccess(membership.permissionsSnapshot),
      )?.botId ??
      null;
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

  private async resolveSendMessageBotRoute(
    chatId: string,
    fallbackToPrimary?: boolean,
    allowHalfOpenProbe?: boolean,
  ): Promise<MaxBotRoute> {
    const normalizedChatId = chatId.trim();
    if (!normalizedChatId) {
      return this.buildRoute({
        purpose: 'send_message',
        chatId: null,
      });
    }

    const state = await this.loadChatRouteState(normalizedChatId);
    if (!state || state.routingState === ChatRoutingState.NO_ELIGIBLE_BOT) {
      return this.buildRoute({
        purpose: 'send_message',
        chatId: normalizedChatId,
        routingVersion: state?.routingVersion ?? null,
      });
    }

    const candidates = this.buildSendMessageCandidateBotIdsFromState(
      state,
      fallbackToPrimary !== false,
      allowHalfOpenProbe === true,
    );
    const selectedBotId = candidates.candidateBotIds[0] ?? null;
    return this.buildRoute({
      purpose: 'send_message',
      chatId: normalizedChatId,
      primaryBotId: state.primaryBotId,
      botId: selectedBotId,
      candidateBotIds: candidates.candidateBotIds,
      reason: selectedBotId ? this.resolveSendMessageRouteReason(state, selectedBotId) : null,
      routingVersion: state.routingVersion,
      quarantinedCandidateBotIds: candidates.quarantinedCandidateBotIds,
      halfOpenCandidateBotIds: candidates.halfOpenCandidateBotIds,
      retryAt: candidates.retryAt,
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
    const candidateBotIds =
      state?.routingState === ChatRoutingState.READY
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
      routingVersion: state?.routingVersion ?? null,
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
    if (!state || state.routingState === ChatRoutingState.NO_ELIGIBLE_BOT) {
      return this.buildRoute({
        purpose: 'capability',
        chatId: normalizedChatId,
        routingVersion: state?.routingVersion ?? null,
        capability,
      });
    }

    const candidateBotIds = this.buildCapabilityCandidateBotIdsFromState(
      state,
      capability,
      fallbackToPrimary !== false,
    );
    const selectedBotId = candidateBotIds[0] ?? null;
    if (!selectedBotId) {
      return this.buildRoute({
        purpose: 'capability',
        chatId: normalizedChatId,
        primaryBotId: state.primaryBotId,
        routingVersion: state.routingVersion,
        capability,
      });
    }

    return this.buildRoute({
      purpose: 'capability',
      chatId: normalizedChatId,
      primaryBotId: state.primaryBotId,
      routingVersion: state.routingVersion,
      botId: selectedBotId,
      candidateBotIds,
      reason: selectedBotId === state.primaryBotId ? 'primary_fallback' : 'alternate_confirmed',
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
        routingState: true,
        routingVersion: true,
        primaryBotId: true,
        botId: true,
        botMemberships: {
          select: {
            botId: true,
            role: true,
            status: true,
            botAccessState: true,
            botAccessCheckedAt: true,
            botAccessExpiresAt: true,
            permissionsSnapshot: true,
            capabilities: true,
            sendRouteFailureCount: true,
            sendRouteQuarantinedUntil: true,
            sendRouteLastFailureCode: true,
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
      (membership) =>
        membership.status === ChatBotMembershipStatus.ACTIVE &&
        Boolean(this.resolveOperationalBotId(membership.botId)),
    );
    const activeOperationalMemberships = activeKnownMemberships.filter((membership) => {
      const bot = this.botRegistry.getBotById(membership.botId);
      return Boolean(bot && canDiscoverChatsForBotState(bot.state));
    });
    const activeActionableMemberships = activeKnownMemberships.filter((membership) => {
      const bot = this.botRegistry.getBotById(membership.botId);
      return Boolean(
        bot &&
        canExecuteActionsForBotState(bot.state) &&
        this.isMembershipRouteAccessEligible(membership),
      );
    });
    const accessEligibleActiveActionableMemberships = activeActionableMemberships;
    const storedPrimaryBotId = this.resolveOperationalBotId(chat.primaryBotId ?? null);
    const rawStoredExecutableBotId =
      this.resolveExecutableBotId(chat.primaryBotId ?? null) ??
      this.resolveExecutableBotId(chat.botId ?? null);
    const storedExecutableMembership = rawStoredExecutableBotId
      ? (activeActionableMemberships.find(
          (membership) => membership.botId === rawStoredExecutableBotId,
        ) ?? null)
      : null;
    const storedExecutableBotId =
      rawStoredExecutableBotId &&
      storedExecutableMembership &&
      this.isMembershipRouteAccessEligible(storedExecutableMembership)
        ? rawStoredExecutableBotId
        : null;
    const preferredPrimaryBotId =
      resolvePreferredPrimaryBotId(storedExecutableBotId, activeActionableMemberships, {
        requireFreshSnapshotForPromotion: true,
      }) ??
      storedExecutableBotId ??
      accessEligibleActiveActionableMemberships.find(
        (membership) => membership.role === ChatBotMembershipRole.PRIMARY,
      )?.botId ??
      accessEligibleActiveActionableMemberships[0]?.botId ??
      null;
    const primaryBotId = preferredPrimaryBotId;
    if (chat.routingState === ChatRoutingState.NO_ELIGIBLE_BOT) {
      this.forgetChatBotBinding(normalizedChatId);
    }

    return {
      chatId: normalizedChatId,
      entityType: chat.entityType ?? null,
      routingState: chat.routingState,
      hasStoredBotAssignment: Boolean(chat.primaryBotId || chat.botId),
      storedPrimaryBotId,
      primaryBotId,
      routingVersion: chat.routingVersion,
      memberships,
      activeKnownMemberships,
      activeOperationalMemberships,
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
      const normalizedBotId = this.resolveExecutableBotId(botId);
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

        const snapshot = normalizeMembershipAccessSnapshot(membership.permissionsSnapshot);
        return this.hasModerationActionPermission(snapshot, action, state.entityType);
      })?.botId ?? null,
    );
    for (const membership of state.activeActionableMemberships) {
      const snapshot = normalizeMembershipAccessSnapshot(membership.permissionsSnapshot);
      if (this.hasModerationActionPermission(snapshot, action, state.entityType)) {
        pushCandidate(membership.botId);
      }
    }

    const primaryActiveMembership =
      state.primaryBotId !== null
        ? (state.activeActionableMemberships.find(
            (membership) => membership.botId === state.primaryBotId,
          ) ?? null)
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
      const pushFallbackCandidate = (botId: string | null | undefined) => {
        const normalizedBotId = this.resolveExecutableBotId(botId);
        if (!normalizedBotId) {
          return;
        }

        const membership =
          state.activeActionableMemberships.find((item) => item.botId === normalizedBotId) ?? null;
        if (
          membership &&
          (this.membershipExplicitlyLacksModerationAction(
            membership.permissionsSnapshot,
            action,
            state.entityType,
          ) ||
            this.membershipSnapshotMarksActionLimited(
              membership.permissionsSnapshot,
              action,
              state.entityType,
            ))
        ) {
          return;
        }

        pushCandidate(normalizedBotId);
      };

      pushFallbackCandidate(state.primaryBotId);
      pushFallbackCandidate(state.activeActionableMemberships[0]?.botId ?? null);
    }

    return candidateBotIds;
  }

  private orderSendMessageCandidatesByRouteHealth(
    state: ResolvedChatRouteState,
    candidateBotIds: string[],
    allowHalfOpenProbe = false,
  ): {
    candidateBotIds: string[];
    quarantinedCandidateBotIds: string[];
    halfOpenCandidateBotIds: string[];
    retryAt: Date | null;
  } {
    const nowMs = Date.now();
    const membershipsByBotId = new Map(
      state.activeActionableMemberships.map((membership) => [membership.botId, membership]),
    );
    // FLAG: A disappearance quarantine is an execution fence, not a preference. Falling back to
    // the only quarantined bot would repeat a send that MAX accepted but did not retain. The
    // repeated-disappearance circuit stays open after its minimum TTL until a newer stable
    // observation (or controlled operator recovery) clears the failure code. A first failure gets
    // one half-open attempt after the TTL; the publication scheduler spaces those attempts.
    const executableCandidateBotIds: string[] = [];
    const halfOpenCandidateBotIds: string[] = [];
    const quarantinedCandidateBotIds: string[] = [];
    let retryAtMs = Number.POSITIVE_INFINITY;
    for (const botId of candidateBotIds) {
      const membership = membershipsByBotId.get(botId);
      const quarantinedUntilMs = membership?.sendRouteQuarantinedUntil?.getTime() ?? 0;
      const stickyDisappearance =
        membership?.sendRouteLastFailureCode === MAX_SEND_ROUTE_DISAPPEARANCE_FAILURE_CODE &&
        membership.sendRouteFailureCount >= SEND_ROUTE_STICKY_DISAPPEARANCE_THRESHOLD;
      const halfOpenDisappearance =
        membership?.sendRouteLastFailureCode === MAX_SEND_ROUTE_DISAPPEARANCE_FAILURE_CODE &&
        membership.sendRouteFailureCount === 1 &&
        quarantinedUntilMs <= nowMs;
      const activeTimedQuarantine = quarantinedUntilMs > nowMs;
      if (halfOpenDisappearance) {
        if (allowHalfOpenProbe) {
          halfOpenCandidateBotIds.push(botId);
        } else {
          quarantinedCandidateBotIds.push(botId);
          retryAtMs = Math.min(retryAtMs, nowMs + SEND_ROUTE_OPEN_CIRCUIT_RECHECK_MS);
        }
        continue;
      }
      if (!stickyDisappearance && !activeTimedQuarantine) {
        executableCandidateBotIds.push(botId);
        continue;
      }
      quarantinedCandidateBotIds.push(botId);
      retryAtMs = Math.min(
        retryAtMs,
        stickyDisappearance
          ? Math.max(quarantinedUntilMs, nowMs + MAX_SEND_ROUTE_QUARANTINE_MS)
          : quarantinedUntilMs,
      );
    }
    if (executableCandidateBotIds.length > 0) {
      return {
        candidateBotIds: executableCandidateBotIds,
        quarantinedCandidateBotIds: [...quarantinedCandidateBotIds, ...halfOpenCandidateBotIds],
        halfOpenCandidateBotIds: [],
        retryAt: Number.isFinite(retryAtMs) ? new Date(retryAtMs) : null,
      };
    }
    const halfOpenCandidateBotId = halfOpenCandidateBotIds[0] ?? null;
    return {
      candidateBotIds: halfOpenCandidateBotId ? [halfOpenCandidateBotId] : [],
      quarantinedCandidateBotIds: [
        ...quarantinedCandidateBotIds,
        ...halfOpenCandidateBotIds.slice(1),
      ],
      halfOpenCandidateBotIds: halfOpenCandidateBotId ? [halfOpenCandidateBotId] : [],
      retryAt: Number.isFinite(retryAtMs) ? new Date(retryAtMs) : null,
    };
  }

  private resolvePersistedRoutingState(state: ResolvedChatRouteState): ChatRoutingState {
    if (
      state.activeActionableMemberships.some((membership) =>
        this.isMembershipConfirmedRoutingEligible(membership),
      )
    ) {
      return ChatRoutingState.READY;
    }
    if (state.activeActionableMemberships.length === 0) {
      return ChatRoutingState.NO_ELIGIBLE_BOT;
    }
    return state.routingState;
  }

  private isMembershipConfirmedRoutingEligible(membership: ResolvedChatRouteMembership): boolean {
    if (!this.isMembershipRouteAccessEligible(membership)) {
      return false;
    }
    if (
      membership.botAccessState !== ChatBotAccessState.CONFIRMED_ADMIN &&
      membership.botAccessState !== ChatBotAccessState.CONFIRMED_OWNER
    ) {
      return false;
    }

    const expiresAtMs = membership.botAccessExpiresAt?.getTime() ?? Number.NaN;
    if (Number.isFinite(expiresAtMs)) {
      return expiresAtMs > Date.now();
    }
    return isFreshMembershipAccessSnapshot(
      normalizeMembershipAccessSnapshot(membership.permissionsSnapshot),
    );
  }

  private buildSendMessageCandidateBotIdsFromState(
    state: ResolvedChatRouteState,
    fallbackToPrimary = true,
    allowHalfOpenProbe = false,
  ): {
    candidateBotIds: string[];
    quarantinedCandidateBotIds: string[];
    halfOpenCandidateBotIds: string[];
    retryAt: Date | null;
  } {
    const candidateBotIds: string[] = [];
    const pushCandidate = (botId: string | null | undefined) => {
      const normalizedBotId = this.resolveExecutableBotId(botId);
      if (!normalizedBotId || candidateBotIds.includes(normalizedBotId)) {
        return;
      }
      candidateBotIds.push(normalizedBotId);
    };

    const primaryMembership =
      state.primaryBotId !== null
        ? (state.activeActionableMemberships.find(
            (membership) => membership.botId === state.primaryBotId,
          ) ?? null)
        : null;
    const primarySnapshot = normalizeMembershipAccessSnapshot(
      primaryMembership?.permissionsSnapshot,
    );
    if (this.hasConfirmedSendMessageAccess(primarySnapshot, state.entityType)) {
      pushCandidate(primaryMembership?.botId);
    }

    const confirmedAlternates = state.activeActionableMemberships
      .map((membership, index) => ({
        membership,
        index,
        snapshot: normalizeMembershipAccessSnapshot(membership.permissionsSnapshot),
      }))
      .filter(
        (candidate) =>
          candidate.membership.botId !== state.primaryBotId &&
          this.hasConfirmedSendMessageAccess(candidate.snapshot, state.entityType),
      )
      .sort((left, right) => {
        const leftScore = left.snapshot?.isOwner ? 2 : 1;
        const rightScore = right.snapshot?.isOwner ? 2 : 1;
        if (leftScore !== rightScore) {
          return rightScore - leftScore;
        }
        return left.index - right.index;
      });
    for (const candidate of confirmedAlternates) {
      pushCandidate(candidate.membership.botId);
    }

    if (
      primaryMembership &&
      !this.membershipExplicitlyLacksSendMessageAccess(
        primaryMembership.permissionsSnapshot,
        state.entityType,
      )
    ) {
      pushCandidate(primaryMembership.botId);
    }

    for (const membership of state.activeActionableMemberships) {
      if (
        membership.botId === state.primaryBotId ||
        this.membershipExplicitlyLacksSendMessageAccess(
          membership.permissionsSnapshot,
          state.entityType,
        )
      ) {
        continue;
      }
      pushCandidate(membership.botId);
    }

    if (fallbackToPrimary !== false) {
      const pushFallbackCandidate = (botId: string | null | undefined) => {
        const normalizedBotId = this.resolveExecutableBotId(botId);
        if (!normalizedBotId) {
          return;
        }

        const membership =
          state.activeActionableMemberships.find((item) => item.botId === normalizedBotId) ?? null;
        if (
          membership &&
          this.membershipExplicitlyLacksSendMessageAccess(
            membership.permissionsSnapshot,
            state.entityType,
          )
        ) {
          return;
        }

        pushCandidate(normalizedBotId);
      };

      pushFallbackCandidate(state.primaryBotId);
      pushFallbackCandidate(state.activeActionableMemberships[0]?.botId ?? null);
    }

    return this.orderSendMessageCandidatesByRouteHealth(state, candidateBotIds, allowHalfOpenProbe);
  }

  private buildCapabilityCandidateBotIdsFromState(
    state: ResolvedChatRouteState,
    capability: ManagedEntityBotCapability,
    fallbackToPrimary = true,
  ): string[] {
    const candidateBotIds: string[] = [];
    const pushCandidate = (botId: string | null | undefined) => {
      const normalizedBotId = this.resolveExecutableBotId(botId);
      if (!normalizedBotId || candidateBotIds.includes(normalizedBotId)) {
        return;
      }
      candidateBotIds.push(normalizedBotId);
    };

    for (const membership of state.activeActionableMemberships) {
      if (membership.role === ChatBotMembershipRole.PRIMARY) {
        continue;
      }
      if (membershipExplicitlyLacksAccess(membership.permissionsSnapshot)) {
        continue;
      }
      if (!this.normalizeBotCapabilities(membership.capabilities).includes(capability)) {
        continue;
      }
      pushCandidate(membership.botId);
    }

    if (fallbackToPrimary !== false) {
      const primaryMembership =
        state.primaryBotId !== null
          ? (state.activeActionableMemberships.find(
              (membership) => membership.botId === state.primaryBotId,
            ) ?? null)
          : null;
      if (
        !primaryMembership ||
        !membershipExplicitlyLacksAccess(primaryMembership.permissionsSnapshot)
      ) {
        pushCandidate(state.primaryBotId);
      }
    }

    return candidateBotIds;
  }

  private resolveSendMessageRouteReason(
    state: ResolvedChatRouteState,
    botId: string,
  ): MaxBotRouteReason {
    const membership =
      state.activeActionableMemberships.find((item) => item.botId === botId) ?? null;
    const hasConfirmedAccess = this.hasConfirmedSendMessageAccess(
      normalizeMembershipAccessSnapshot(membership?.permissionsSnapshot),
      state.entityType,
    );

    if (botId === state.primaryBotId) {
      return hasConfirmedAccess ? 'primary_confirmed' : 'primary_soft';
    }

    return hasConfirmedAccess ? 'alternate_confirmed' : 'alternate_soft';
  }

  private resolveModerationActionRouteReason(
    state: ResolvedChatRouteState,
    botId: string,
    action: ModerationActionPermission,
  ): MaxBotRouteReason {
    if (botId === state.primaryBotId) {
      const primaryMembership =
        state.activeActionableMemberships.find((membership) => membership.botId === botId) ?? null;
      const primarySnapshot = normalizeMembershipAccessSnapshot(
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
    const selectedSnapshot = normalizeMembershipAccessSnapshot(
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
    routingVersion?: number | null;
    action?: ModerationActionPermission;
    capability?: ManagedEntityBotCapability;
    quarantinedCandidateBotIds?: Array<string | null | undefined>;
    halfOpenCandidateBotIds?: Array<string | null | undefined>;
    retryAt?: Date | null;
  }): MaxBotRoute {
    const normalizedChatId =
      typeof params.chatId === 'string' && params.chatId.trim().length > 0
        ? params.chatId.trim()
        : null;
    const normalizedPrimaryBotId = this.resolveOperationalBotId(params.primaryBotId);
    const normalizeRouteBotId = (botId: string | null | undefined) =>
      this.isExecutableRoutePurpose(params.purpose)
        ? this.resolveExecutableBotId(botId)
        : this.resolveOperationalBotId(botId);
    const normalizedBotId = normalizeRouteBotId(params.botId);
    const normalizedCandidateBotIds = Array.from(
      new Set(
        (params.candidateBotIds ?? [])
          .map((botId) => normalizeRouteBotId(botId))
          .filter((botId): botId is string => Boolean(botId)),
      ),
    );
    const candidateBotIds =
      normalizedBotId && !normalizedCandidateBotIds.includes(normalizedBotId)
        ? [normalizedBotId, ...normalizedCandidateBotIds]
        : normalizedCandidateBotIds;
    const botId = normalizedBotId ?? candidateBotIds[0] ?? null;
    const routeReason = botId ? (params.reason ?? null) : null;
    const baseRoute = {
      purpose: params.purpose,
      chatId: normalizedChatId,
      primaryBotId: normalizedPrimaryBotId,
      botId,
      candidateBotIds,
      reason: routeReason,
      ...(params.routingVersion !== undefined ? { routingVersion: params.routingVersion } : {}),
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

    if (params.purpose === 'send_message') {
      return {
        ...baseRoute,
        purpose: 'send_message',
        quarantinedCandidateBotIds: Array.from(
          new Set(
            (params.quarantinedCandidateBotIds ?? [])
              .map((botId) => this.resolveExecutableBotId(botId))
              .filter((botId): botId is string => Boolean(botId)),
          ),
        ),
        halfOpenCandidateBotIds: Array.from(
          new Set(
            (params.halfOpenCandidateBotIds ?? [])
              .map((botId) => this.resolveExecutableBotId(botId))
              .filter((botId): botId is string => Boolean(botId)),
          ),
        ),
        retryAt: params.retryAt ?? null,
      };
    }

    return {
      ...baseRoute,
      purpose: params.purpose,
    };
  }

  private isExecutableRoutePurpose(purpose: MaxBotRoutePurpose): boolean {
    return (
      purpose === 'send_message' || purpose === 'moderation_action' || purpose === 'capability'
    );
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

  private hasModerationActionPermission(
    snapshot: MembershipAccessSnapshot | null,
    action: ModerationActionPermission,
    entityType: ChatEntityType | null,
  ): boolean {
    if (!snapshot) {
      return false;
    }

    if (action === 'delete_message') {
      return hasConfirmedDeleteMessageAccess(snapshot, entityType);
    }

    if (snapshot.isOwner) {
      return true;
    }

    if (snapshot.permissions.length === 0) {
      return snapshot.isAdmin;
    }

    return snapshot.permissions.some((permission) =>
      this.isModerationActionPermission(permission, action, entityType),
    );
  }

  private assessDeleteMessageCandidateCapability(
    membership: ResolvedChatRouteMembership,
    entityType: ChatEntityType | null,
    actionable: boolean,
  ): MaxDeleteMessageCandidateCapability {
    const snapshot = normalizeMembershipAccessSnapshot(membership.permissionsSnapshot);
    const snapshotCheckedAtMs = snapshot?.checkedAt ? Date.parse(snapshot.checkedAt) : Number.NaN;
    const membershipCheckedAtMs = membership.botAccessCheckedAt?.getTime() ?? Number.NaN;
    const checkedAtMs = Number.isFinite(membershipCheckedAtMs)
      ? membershipCheckedAtMs
      : snapshotCheckedAtMs;
    const expiresAtMs = membership.botAccessExpiresAt?.getTime() ?? Number.NaN;
    const checkedAt = Number.isFinite(checkedAtMs) ? new Date(checkedAtMs).toISOString() : null;
    const expiresAt = Number.isFinite(expiresAtMs) ? new Date(expiresAtMs).toISOString() : null;
    const result = (
      state: MaxDeleteMessageCapabilityState,
      reason: MaxDeleteMessageCapabilityReason,
      routeEligible = false,
    ): MaxDeleteMessageCandidateCapability => ({
      botId: membership.botId,
      state,
      reason,
      checkedAt,
      expiresAt,
      routeEligible,
    });

    if (
      membership.botAccessState === ChatBotAccessState.DENIED ||
      membership.botAccessState === ChatBotAccessState.LOST
    ) {
      return result('explicitly_incapable', 'access_denied');
    }
    if (!snapshot) {
      return result('stale_or_unknown', 'snapshot_missing', actionable);
    }

    const nowMs = Date.now();
    const fresh =
      Number.isFinite(checkedAtMs) &&
      checkedAtMs <= nowMs &&
      (Number.isFinite(expiresAtMs)
        ? expiresAtMs > nowMs
        : isFreshMembershipAccessSnapshot(snapshot, { nowMs }));
    if (!fresh) {
      return result('stale_or_unknown', 'snapshot_stale', actionable);
    }

    const permissionFailure = resolveDeleteMessageAccessFailure(snapshot, entityType);
    if (permissionFailure) {
      return result('explicitly_incapable', permissionFailure);
    }
    if (
      membership.botAccessState !== ChatBotAccessState.CONFIRMED_ADMIN &&
      membership.botAccessState !== ChatBotAccessState.CONFIRMED_OWNER
    ) {
      return result('stale_or_unknown', 'access_state_unconfirmed', actionable);
    }
    if (!actionable) {
      return result('stale_or_unknown', 'bot_not_actionable');
    }

    return result('confirmed_capable', 'confirmed', true);
  }

  private buildEmptyDeleteMessageBotRoute(
    chatId: string | null,
    reason: 'chat_not_found' | 'no_active_membership',
  ): MaxDeleteMessageBotRoute {
    return {
      purpose: 'moderation_action',
      action: 'delete_message',
      chatId,
      entityType: null,
      routingState: null,
      routingVersion: null,
      primaryBotId: null,
      botId: null,
      candidateBotIds: [],
      reason: null,
      capabilityState: 'stale_or_unknown',
      capabilityReason: reason,
      checkedAt: null,
      expiresAt: null,
      candidateCapabilities: [],
    };
  }

  private hasConfirmedSendMessageAccess(
    snapshot: MembershipAccessSnapshot | null,
    entityType: ChatEntityType | null,
  ): boolean {
    if (!snapshot) {
      return false;
    }
    if (snapshot.isOwner) {
      return true;
    }
    if (entityType !== ChatEntityType.CHANNEL) {
      return snapshot.isAdmin;
    }
    return snapshot.permissions.some((permission) =>
      WRITE_MESSAGE_PERMISSION_ALIASES.has(normalizePermissionName(permission)),
    );
  }

  private membershipExplicitlyLacksSendMessageAccess(
    value: unknown,
    entityType: ChatEntityType | null,
  ): boolean {
    const snapshot = normalizeMembershipAccessSnapshot(value);
    if (!snapshot) {
      return false;
    }
    if (
      entityType === ChatEntityType.CHANNEL &&
      snapshot.isAdmin &&
      snapshot.permissions.length === 0
    ) {
      return false;
    }
    return !this.hasConfirmedSendMessageAccess(snapshot, entityType);
  }

  private membershipExplicitlyLacksModerationAction(
    value: unknown,
    action: ModerationActionPermission,
    entityType: ChatEntityType | null,
  ): boolean {
    const snapshot = normalizeMembershipAccessSnapshot(value);
    if (!snapshot) {
      return false;
    }

    if (action === 'delete_message') {
      return !hasConfirmedDeleteMessageAccess(snapshot, entityType);
    }

    if (snapshot.isOwner) {
      return false;
    }

    if (snapshot.permissions.length === 0) {
      return !snapshot.isAdmin;
    }

    return !snapshot.permissions.some((permission) =>
      this.isModerationActionPermission(permission, action, entityType),
    );
  }

  private membershipSnapshotMarksActionLimited(
    value: unknown,
    action: ModerationActionPermission,
    _entityType: ChatEntityType | null,
  ): boolean {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return false;
    }

    const row = value as Record<string, unknown>;
    if (row.health !== 'action_limited') {
      return false;
    }

    const missingActions = Array.isArray(row.missingActions) ? row.missingActions : [];
    return missingActions.some((item) => item === action);
  }

  private isModerationActionPermission(
    permission: string,
    action: ModerationActionPermission,
    _entityType?: ChatEntityType | null,
  ): boolean {
    const normalized = normalizePermissionName(permission);
    if (!normalized) {
      return false;
    }

    if (action === 'delete_message') {
      return false;
    }

    if (action === 'edit_message') {
      return EDIT_MESSAGE_PERMISSION_ALIASES.has(normalized);
    }

    return MODERATE_MEMBER_PERMISSION_ALIASES.has(normalized);
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
        botAccessState: true,
        botAccessCheckedAt: true,
        permissionsSnapshot: true,
      },
    });

    const activeMemberships = memberships.filter(
      (membership) =>
        membership.status === ChatBotMembershipStatus.ACTIVE &&
        this.resolveExecutableBotId(membership.botId) &&
        this.isMembershipRouteAccessEligible(membership),
    );
    const accessEligibleActiveMemberships = activeMemberships.filter(
      (membership) => !membershipExplicitlyLacksAccess(membership.permissionsSnapshot),
    );
    const nextPrimaryBotId =
      resolvePreferredPrimaryBotId(null, activeMemberships, {
        requireFreshSnapshotForPromotion: true,
      }) ??
      accessEligibleActiveMemberships.find(
        (membership) => membership.role === ChatBotMembershipRole.PRIMARY,
      )?.botId ??
      accessEligibleActiveMemberships[0]?.botId ??
      null;

    await this.prisma.chat.update({
      where: { id: chatId },
      data: {
        title,
        botId: nextPrimaryBotId,
        primaryBotId: nextPrimaryBotId,
        routingState: nextPrimaryBotId ? ChatRoutingState.READY : ChatRoutingState.NO_ELIGIBLE_BOT,
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
      lifecycleEventAt?: Date | null;
      lifecycleEventType?: string | null;
      lifecycleSource?: string | null;
      allowReactivation?: boolean;
      preserveRemovedMembership?: boolean;
    },
  ): Promise<ChatBotMembershipUpsertResult> {
    const isActiveOperational =
      params.status === ChatBotMembershipStatus.ACTIVE &&
      Boolean(this.resolveOperationalBotId(botId));
    const nextStatus = isActiveOperational
      ? ChatBotMembershipStatus.ACTIVE
      : params.status === ChatBotMembershipStatus.ACTIVE
        ? ChatBotMembershipStatus.REMOVED
        : params.status;
    const nextRole = isActiveOperational ? params.role : ChatBotMembershipRole.STANDBY;

    const lifecycleEventAt = params.lifecycleEventAt ?? null;
    const lifecycleEventType = params.lifecycleEventType?.trim() || null;
    const lifecycleSource = params.lifecycleSource?.trim() || null;

    if (
      nextStatus === ChatBotMembershipStatus.ACTIVE &&
      lifecycleEventAt &&
      lifecycleEventType &&
      params.allowReactivation === true
    ) {
      const existing = await this.prisma.chatBotMembership.findUnique({
        where: { chatId_botId: { chatId, botId } },
        select: { id: true },
      });
      const updated = await this.prisma.chatBotMembership.updateMany({
        where: {
          chatId,
          botId,
          OR: [{ lifecycleEventAt: null }, { lifecycleEventAt: { lt: lifecycleEventAt } }],
        },
        data: {
          role: nextRole,
          status: ChatBotMembershipStatus.ACTIVE,
          ...(lifecycleSource === 'live_probe'
            ? {}
            : {
                permissionsSnapshot: Prisma.JsonNull,
                botAccessState: ChatBotAccessState.UNKNOWN,
                botAccessCheckedAt: null,
                botAccessExpiresAt: null,
                botAccessSource: lifecycleSource,
                botAccessLastErrorCode: null,
              }),
          lastSeenAt: params.lastSeenAt ?? lifecycleEventAt,
          lastWebhookAt: params.lastWebhookAt ?? lifecycleEventAt,
          lifecycleEventAt,
          lifecycleEventType,
          lifecycleSource,
        },
      });
      if (updated.count > 0) {
        return { active: true, lifecycleAdvanced: true };
      }

      const membership = await this.prisma.chatBotMembership.upsert({
        where: {
          chatId_botId: {
            chatId,
            botId,
          },
        },
        create: {
          chatId,
          botId,
          role: nextRole,
          status: ChatBotMembershipStatus.ACTIVE,
          lastSeenAt: params.lastSeenAt ?? lifecycleEventAt,
          lastWebhookAt: params.lastWebhookAt ?? lifecycleEventAt,
          lifecycleEventAt,
          lifecycleEventType,
          lifecycleSource,
        },
        update: {},
      });
      const active = membership.status === ChatBotMembershipStatus.ACTIVE;
      return { active, lifecycleAdvanced: active && !existing };
    }

    if (
      nextStatus === ChatBotMembershipStatus.ACTIVE &&
      params.preserveRemovedMembership === true
    ) {
      const touched = await this.prisma.chatBotMembership.updateMany({
        where: {
          chatId,
          botId,
          status: ChatBotMembershipStatus.ACTIVE,
        },
        data: {
          role: nextRole,
          ...(params.lastSeenAt ? { lastSeenAt: params.lastSeenAt } : {}),
          ...(params.lastWebhookAt ? { lastWebhookAt: params.lastWebhookAt } : {}),
        },
      });
      if (touched.count > 0) {
        return { active: true, lifecycleAdvanced: false };
      }

      const membership = await this.prisma.chatBotMembership.upsert({
        where: {
          chatId_botId: {
            chatId,
            botId,
          },
        },
        create: {
          chatId,
          botId,
          role: nextRole,
          status: ChatBotMembershipStatus.ACTIVE,
          ...(params.lastSeenAt ? { lastSeenAt: params.lastSeenAt } : {}),
          ...(params.lastWebhookAt ? { lastWebhookAt: params.lastWebhookAt } : {}),
        },
        update: {},
      });
      return {
        active: membership.status === ChatBotMembershipStatus.ACTIVE,
        lifecycleAdvanced: false,
      };
    }

    const membership = await this.prisma.chatBotMembership.upsert({
      where: {
        chatId_botId: {
          chatId,
          botId,
        },
      },
      create: {
        chatId,
        botId,
        role: nextRole,
        status: nextStatus,
        ...(params.lastSeenAt ? { lastSeenAt: params.lastSeenAt } : {}),
        ...(params.lastWebhookAt ? { lastWebhookAt: params.lastWebhookAt } : {}),
        ...(lifecycleEventAt ? { lifecycleEventAt } : {}),
        ...(lifecycleEventType ? { lifecycleEventType } : {}),
        ...(lifecycleSource ? { lifecycleSource } : {}),
      },
      update: {
        role: nextRole,
        status: nextStatus,
        ...(params.lastSeenAt ? { lastSeenAt: params.lastSeenAt } : {}),
        ...(params.lastWebhookAt ? { lastWebhookAt: params.lastWebhookAt } : {}),
        ...(lifecycleEventAt ? { lifecycleEventAt } : {}),
        ...(lifecycleEventType ? { lifecycleEventType } : {}),
        ...(lifecycleSource ? { lifecycleSource } : {}),
      },
    });
    return {
      active: membership.status === ChatBotMembershipStatus.ACTIVE,
      lifecycleAdvanced: false,
    };
  }

  private async markChatRoutingReadyFromLifecycleProof(params: {
    chatId: string;
    botId: string;
    lifecycleEventAt: Date;
    lifecycleEventType: string;
    lifecycleSource: string;
  }): Promise<void> {
    const liveProbe =
      params.lifecycleEventType === 'live_probe' && params.lifecycleSource === 'live_probe';
    if (!liveProbe && params.lifecycleEventType !== 'bot_added') {
      return;
    }
    await this.prisma.chat.updateMany({
      where: {
        id: params.chatId,
        routingState: { not: ChatRoutingState.READY },
        botMemberships: {
          some: {
            botId: params.botId,
            status: ChatBotMembershipStatus.ACTIVE,
            lifecycleEventAt: params.lifecycleEventAt,
            lifecycleEventType: params.lifecycleEventType,
            botAccessState: liveProbe
              ? { in: [ChatBotAccessState.CONFIRMED_ADMIN, ChatBotAccessState.CONFIRMED_OWNER] }
              : { notIn: [ChatBotAccessState.DENIED, ChatBotAccessState.LOST] },
            ...(liveProbe
              ? {
                  botAccessCheckedAt: { gte: params.lifecycleEventAt },
                  botAccessExpiresAt: { gt: params.lifecycleEventAt },
                }
              : {}),
          },
        },
      },
      data: {
        routingState: ChatRoutingState.READY,
        routingVersion: { increment: 1 },
      },
    });
  }

  private getOperationalBotById(botId: string | null | undefined): MaxBotDefinition | null {
    const bot = this.botRegistry.getBotById(botId);
    return bot && isOperationalBotState(bot.state) ? bot : null;
  }

  private resolveOperationalBotId(botId: string | null | undefined): string | null {
    return this.getOperationalBotById(botId)?.id ?? null;
  }

  private isMembershipRouteAccessEligible(
    membership: Pick<ResolvedChatRouteMembership, 'botAccessState' | 'permissionsSnapshot'>,
  ): boolean {
    return (
      membership.botAccessState !== ChatBotAccessState.DENIED &&
      membership.botAccessState !== ChatBotAccessState.LOST &&
      !membershipExplicitlyLacksAccess(membership.permissionsSnapshot)
    );
  }
}
