import { BadRequestException, Injectable, Logger, Optional } from '@nestjs/common';
import {
  ChatBotAccessState,
  ChatBotMembershipRole,
  ChatBotMembershipStatus,
  ChatEntityType,
} from '../prisma/prisma-client';
import type {
  ManagedEntityAssignedBot,
  ManagedEntityBotCapability,
  ManagedEntityBotExecutionPlan,
  ManagedEntityType,
} from '@maxim/contracts';
import { PrismaService } from '../prisma/prisma.service';
import { ChatContextCacheService } from '../chat-context/chat-context-cache.service';
import {
  MAX_API_SOURCE_TAGS,
  MaxClientService,
  type MaxChatMemberAccess,
} from './max-client.service';
import { MaxBotLinkService } from './max-bot-link.service';
import { MaxBotRegistryService } from './max-bot-registry.service';
import { ManagedEntityAccessLossService } from './managed-entity-access-loss.service';
import { canDiscoverChatsForBotState, canExecuteActionsForBotState } from './max-bot-state.util';
import {
  membershipExplicitlyLacksAccess,
  resolvePreferredPrimaryBotId,
} from './max-bot-access-policy.util';

type PersistedMembership = {
  botId: string;
  role: ChatBotMembershipRole;
  status: ChatBotMembershipStatus;
  capabilities: unknown;
  permissionsSnapshot: unknown;
  lastSeenAt: Date | null;
  lastWebhookAt: Date | null;
};

type PermissionsSummary = NonNullable<ManagedEntityAssignedBot['permissionsSummary']>;
type BotAccessSnapshotRefreshResult = {
  snapshot: PermissionsSummary | null;
  accessStateOverride?: ChatBotAccessState;
  lastErrorCode?: string | null;
  persistedEpoch?: {
    checkedAt: Date;
    source: string;
    accessState: ChatBotAccessState;
  };
};

const ASSIST_CAPABILITIES_BY_ENTITY: Record<
  ManagedEntityType,
  readonly ManagedEntityBotCapability[]
> = {
  chat: ['suggestion_delivery', 'membership_prewarm', 'access_prewarm'],
  channel: [
    'background_scans',
    'channel_stats',
    'suggestion_delivery',
    'membership_prewarm',
    'access_prewarm',
  ],
};
const ACCESS_SNAPSHOT_REFRESH_DEBOUNCE_MS = 60_000;
const ACCESS_SNAPSHOT_RATE_LIMIT_BACKOFF_MS = 10_000;

@Injectable()
export class MaxBotExecutionPlannerService {
  private readonly logger = new Logger(MaxBotExecutionPlannerService.name);
  private managedRefreshBackoffUntilMs = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly maxClient: MaxClientService,
    private readonly maxBotLinkService: MaxBotLinkService,
    private readonly maxBotRegistry: MaxBotRegistryService,
    @Optional() private readonly chatContextCache?: ChatContextCacheService,
    @Optional()
    private readonly managedEntityAccessLossService?: ManagedEntityAccessLossService,
  ) {}

  async getManagedEntityExecutionPlan(params: {
    chatId: string;
    entityType: ManagedEntityType;
    refreshCapabilities?: boolean;
  }): Promise<ManagedEntityBotExecutionPlan> {
    const chatId = params.chatId.trim();
    if (!chatId) {
      throw new BadRequestException('chatId is required');
    }

    if (params.refreshCapabilities) {
      await this.refreshChatBotCapabilitySnapshots({
        chatId,
        entityType: params.entityType,
      });
    }

    return this.buildExecutionPlan(chatId, params.entityType);
  }

  async setPrimaryBot(params: {
    chatId: string;
    entityType: ManagedEntityType;
    botId: string;
  }): Promise<ManagedEntityBotExecutionPlan> {
    const chatId = params.chatId.trim();
    const targetBot = this.maxBotRegistry.getBotById(params.botId);
    if (!chatId || !targetBot) {
      throw new BadRequestException('Выбранный бот не найден.');
    }
    if (!canExecuteActionsForBotState(targetBot.state)) {
      throw new BadRequestException('Выбранный бот ещё не готов к выполнению действий.');
    }

    const state = await this.loadChatState(chatId);
    const targetMembership = state.memberships.find(
      (membership) =>
        membership.botId === targetBot.id && membership.status === ChatBotMembershipStatus.ACTIVE,
    );
    if (!targetMembership) {
      throw new BadRequestException('Бот ещё не состоит в этом чате как активный участник.');
    }
    const targetAccess = await this.refreshBotAccessSnapshot(chatId, targetBot.id, {
      source: 'execution_planner_primary',
    });
    const targetSnapshot = targetAccess.snapshot;
    if (!targetSnapshot?.isAdmin && !targetSnapshot?.isOwner) {
      throw new BadRequestException(
        'Owner-ботом можно назначить только бота с подтверждёнными admin/owner правами.',
      );
    }
    if (!targetAccess.persistedEpoch) {
      throw new BadRequestException('Доступ бота изменился во время проверки. Обновите права.');
    }

    const selected = await this.maxBotLinkService.selectChatPrimaryBot({
      chatId,
      botId: targetBot.id,
      entityType: this.toPrismaEntityType(params.entityType),
      expectedAccessEpoch: targetAccess.persistedEpoch,
    });
    if (!selected) {
      throw new BadRequestException('Доступ бота изменился во время назначения. Обновите права.');
    }

    return this.buildExecutionPlan(chatId, params.entityType);
  }

  async promoteStandby(params: {
    chatId: string;
    entityType: ManagedEntityType;
    botId?: string | null;
  }): Promise<ManagedEntityBotExecutionPlan> {
    const chatId = params.chatId.trim();
    const initialState = await this.loadChatState(chatId);
    const requestedBotId = this.resolveRequestedBotId(params.botId);
    if (!requestedBotId) {
      await this.refreshEligibleStandbyPromotionSnapshots(chatId, initialState.memberships);
    }
    const state = requestedBotId ? initialState : await this.loadChatState(chatId);
    const candidateMembership = requestedBotId
      ? state.memberships.find(
          (membership) =>
            membership.botId === requestedBotId &&
            membership.status === ChatBotMembershipStatus.ACTIVE &&
            membership.role === ChatBotMembershipRole.STANDBY,
        )
      : this.resolvePreferredStandbyPromotionCandidate(state.memberships);

    if (!candidateMembership) {
      throw new BadRequestException(
        requestedBotId
          ? 'Выбранный бот не является активным standby-ботом этого чата.'
          : 'В этом чате нет активного standby-бота для promotion.',
      );
    }

    return this.setPrimaryBot({
      chatId,
      entityType: params.entityType,
      botId: candidateMembership.botId,
    });
  }

  async setPartnerAssist(params: {
    chatId: string;
    entityType: ManagedEntityType;
    botId: string;
    enabled: boolean;
  }): Promise<ManagedEntityBotExecutionPlan> {
    const chatId = params.chatId.trim();
    const botId = this.maxBotRegistry.getBotById(params.botId)?.id ?? null;
    if (!chatId || !botId) {
      throw new BadRequestException('Выбранный бот не найден.');
    }

    const state = await this.loadChatState(chatId);
    const membership = state.memberships.find((item) => item.botId === botId) ?? null;
    if (!membership || membership.status !== ChatBotMembershipStatus.ACTIVE) {
      throw new BadRequestException('Бот не является активным участником этого чата.');
    }
    if (params.enabled) {
      const bot = this.maxBotRegistry.getBotById(botId);
      if (!bot || !canExecuteActionsForBotState(bot.state)) {
        throw new BadRequestException('Assist-режим можно включить только для active-бота.');
      }
    }
    if (membership.role === ChatBotMembershipRole.PRIMARY) {
      throw new BadRequestException(
        'Owner-бот и так обслуживает user-facing path без assist-режима.',
      );
    }

    let nextCapabilities: ManagedEntityBotCapability[] = [];
    let nextPermissionsSnapshot: PermissionsSummary | null = this.normalizePermissionsSummary(
      membership.permissionsSnapshot,
    );
    let nextAccess: BotAccessSnapshotRefreshResult | null = null;
    if (params.enabled) {
      nextAccess = await this.refreshBotAccessSnapshot(chatId, botId, {
        source: 'execution_planner_assist',
      });
      nextPermissionsSnapshot = nextAccess.snapshot;
      if (!nextPermissionsSnapshot?.isAdmin && !nextPermissionsSnapshot?.isOwner) {
        await this.updateMembershipCapabilities(chatId, botId, [], nextAccess);
        throw new BadRequestException(
          'Assist-режим можно включить только для бота с admin/owner доступом в этом чате.',
        );
      }
      if (!nextAccess.persistedEpoch) {
        throw new BadRequestException('Доступ бота изменился во время проверки. Обновите права.');
      }
      nextCapabilities = [...ASSIST_CAPABILITIES_BY_ENTITY[params.entityType]];
    }

    const capabilitiesUpdated = await this.updateMembershipCapabilities(
      chatId,
      botId,
      nextCapabilities,
      nextAccess,
    );
    if (params.enabled && !capabilitiesUpdated) {
      throw new BadRequestException('Доступ бота изменился во время обновления assist-режима.');
    }

    return this.buildExecutionPlan(chatId, params.entityType);
  }

  async refreshChatBotCapabilitySnapshots(params: {
    chatId: string;
    entityType: ManagedEntityType;
    botId?: string | null;
  }): Promise<ManagedEntityBotExecutionPlan> {
    const chatId = params.chatId.trim();
    const requestedBotId = this.maxBotRegistry.getBotById(params.botId)?.id ?? null;
    const state = await this.loadChatState(chatId);

    for (const membership of state.memberships) {
      if (membership.status !== ChatBotMembershipStatus.ACTIVE) {
        continue;
      }
      if (requestedBotId && membership.botId !== requestedBotId) {
        continue;
      }
      const bot = this.maxBotRegistry.getBotById(membership.botId);
      if (!bot || !canDiscoverChatsForBotState(bot.state)) {
        continue;
      }
      const cachedSnapshot = this.readFreshPermissionsSummary(membership.permissionsSnapshot);
      if (cachedSnapshot) {
        if (this.permissionsSummaryExplicitlyLacksAdminAccess(cachedSnapshot)) {
          await this.clearMembershipAssistCapabilities(chatId, bot.id);
        }
        continue;
      }

      const access = await this.refreshBotAccessSnapshot(chatId, bot.id, {
        honorSharedBackoff: true,
        source: 'execution_planner_refresh',
      });
      const snapshot = access.snapshot;
      if (this.permissionsSummaryExplicitlyLacksAdminAccess(snapshot)) {
        await this.updateMembershipCapabilities(chatId, bot.id, [], access);
      }
    }

    return this.buildExecutionPlan(chatId, params.entityType);
  }

  private async buildExecutionPlan(
    chatId: string,
    entityType: ManagedEntityType,
  ): Promise<ManagedEntityBotExecutionPlan> {
    await this.maxBotLinkService.reconcileChatPrimaryByAccess({
      chatId,
      entityType: this.toPrismaEntityType(entityType),
    });

    const state = await this.loadChatState(chatId);
    const assignedBots = this.buildAssignedBots(state.memberships, state.primaryBotId);
    const sharedMode = this.resolveSharedMode(assignedBots);
    const activePartners = assignedBots.filter((bot) => this.isActiveExecutableStandbyBot(bot));
    const assistPartners = activePartners.filter((bot) => bot.capabilities.length > 0);
    const partnerBotIds =
      assistPartners.length > 0
        ? assistPartners.map((bot) => bot.botId)
        : activePartners.map((bot) => bot.botId);
    const partnerBotId = partnerBotIds[0] ?? null;
    const primaryBotId =
      this.maxBotRegistry.getBotById(state.primaryBotId)?.id ??
      assignedBots.find((bot) => bot.role === 'primary' && bot.membershipStatus === 'active')
        ?.botId ??
      null;
    const reasons = [
      'Пользовательские deep link-сценарии стараются оставаться на том боте, из которого пользователь открыл поток.',
    ];
    if (assistPartners.length > 0) {
      const assistLabels = assistPartners.map((bot) => bot.label).join(', ');
      const capabilityNames = Array.from(
        new Set(assistPartners.flatMap((bot) => bot.capabilities)),
      ).join(', ');
      reasons.push(
        `Assist-боты ${assistLabels} обслуживают только фоновые lane’ы: ${capabilityNames}.`,
      );
    } else if (activePartners.length > 0) {
      const standbyLabels = activePartners.map((bot) => bot.label).join(', ');
      reasons.push(
        `Standby-боты ${standbyLabels} готовы к promotion, но assist-режим для них ещё не включён.`,
      );
    } else {
      reasons.push('В этом чате сейчас нет активного standby-бота, поэтому режим остаётся owned.');
    }

    const warnings: string[] = [];
    if (!primaryBotId) {
      warnings.push(
        'У чата нет валидного owner-бота. До multi-bot rollout надо назначить primary.',
      );
    }
    for (const partner of activePartners) {
      if (partner.capabilities.length > 0) {
        continue;
      }
      const snapshot = partner.permissionsSummary;
      if (!snapshot) {
        warnings.push(
          `Для ${partner.label} ещё нет актуального permissions snapshot. Нажмите «Обновить права» перед включением assist.`,
        );
      } else if (!snapshot.isAdmin && !snapshot.isOwner) {
        warnings.push(
          `${partner.label} больше не выглядит админом этого чата. Assist для него безопасно выключен.`,
        );
      }
    }

    return {
      chatId,
      entityType,
      primaryBotId,
      speakerBotId: primaryBotId,
      workerBotId: primaryBotId,
      linkBotId: primaryBotId,
      partnerBotId,
      partnerBotIds,
      sharedMode,
      userFacingPolicy: 'owner-only',
      reasons,
      warnings,
      assignedBots,
    };
  }

  private resolvePreferredStandbyPromotionCandidate(
    memberships: readonly PersistedMembership[],
  ): PersistedMembership | null {
    const activeExecutableStandbyMemberships = memberships.filter(
      (membership) =>
        membership.status === ChatBotMembershipStatus.ACTIVE &&
        membership.role === ChatBotMembershipRole.STANDBY &&
        !membershipExplicitlyLacksAccess(membership.permissionsSnapshot) &&
        canExecuteActionsForBotState(
          this.maxBotRegistry.getBotById(membership.botId)?.state ?? 'disabled',
        ),
    );
    if (activeExecutableStandbyMemberships.length === 0) {
      return null;
    }

    const preferredBotId = resolvePreferredPrimaryBotId(null, activeExecutableStandbyMemberships, {
      requireFreshSnapshotForPromotion: true,
    });
    return (
      activeExecutableStandbyMemberships.find(
        (membership) => membership.botId === preferredBotId,
      ) ??
      activeExecutableStandbyMemberships[0] ??
      null
    );
  }

  private async refreshEligibleStandbyPromotionSnapshots(
    chatId: string,
    memberships: readonly PersistedMembership[],
  ): Promise<void> {
    for (const membership of memberships) {
      if (
        membership.status !== ChatBotMembershipStatus.ACTIVE ||
        membership.role !== ChatBotMembershipRole.STANDBY ||
        !canExecuteActionsForBotState(
          this.maxBotRegistry.getBotById(membership.botId)?.state ?? 'disabled',
        )
      ) {
        continue;
      }

      const access = await this.refreshBotAccessSnapshot(chatId, membership.botId, {
        source: 'execution_planner_promote',
      });
      const snapshot = access.snapshot;
      if (this.permissionsSummaryExplicitlyLacksAdminAccess(snapshot)) {
        await this.updateMembershipCapabilities(chatId, membership.botId, [], access);
      }
    }
  }

  private permissionsSummaryExplicitlyLacksAdminAccess(
    snapshot: PermissionsSummary | null,
  ): boolean {
    return Boolean(snapshot && !snapshot.isAdmin && !snapshot.isOwner);
  }

  private async clearMembershipAssistCapabilities(chatId: string, botId: string): Promise<void> {
    await this.prisma.chatBotMembership.update({
      where: {
        chatId_botId: {
          chatId,
          botId,
        },
      },
      data: {
        capabilities: [],
      },
    });
  }

  private async loadChatState(chatId: string): Promise<{
    primaryBotId: string | null;
    memberships: PersistedMembership[];
  }> {
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
            capabilities: true,
            permissionsSnapshot: true,
            lastSeenAt: true,
            lastWebhookAt: true,
          },
          orderBy: [{ updatedAt: 'desc' }, { createdAt: 'asc' }],
        },
      },
    });

    if (!chat) {
      throw new BadRequestException('Чат не найден в локальной модели.');
    }

    return {
      primaryBotId:
        this.maxBotRegistry.getBotById(chat.primaryBotId ?? chat.botId ?? null)?.id ?? null,
      memberships: chat.botMemberships.map((membership) => ({
        botId: membership.botId,
        role: membership.role,
        status: membership.status,
        capabilities: membership.capabilities,
        permissionsSnapshot: membership.permissionsSnapshot,
        lastSeenAt: membership.lastSeenAt,
        lastWebhookAt: membership.lastWebhookAt,
      })),
    };
  }

  private buildAssignedBots(
    memberships: readonly PersistedMembership[],
    primaryBotId: string | null,
  ): ManagedEntityAssignedBot[] {
    const seen = new Set<string>();
    const assignedBots: ManagedEntityAssignedBot[] = [];

    for (const membership of memberships) {
      const bot = this.maxBotRegistry.getBotById(membership.botId);
      if (!bot || seen.has(bot.id)) {
        continue;
      }
      seen.add(bot.id);
      assignedBots.push({
        botId: bot.id,
        label: bot.label,
        role:
          membership.role === ChatBotMembershipRole.PRIMARY ||
          (primaryBotId !== null && primaryBotId === bot.id)
            ? 'primary'
            : 'standby',
        membershipStatus:
          membership.status === ChatBotMembershipStatus.REMOVED ? 'removed' : 'active',
        lifecycleState: bot.state,
        speechPersona: bot.speechPersona,
        characterName: bot.characterName,
        avatarUrl: null,
        capabilities: this.normalizeCapabilities(membership.capabilities),
        permissionsSummary: this.normalizePermissionsSummary(membership.permissionsSnapshot),
      });
    }

    if (primaryBotId && !seen.has(primaryBotId)) {
      const bot = this.maxBotRegistry.getBotById(primaryBotId);
      if (bot) {
        assignedBots.unshift({
          botId: bot.id,
          label: bot.label,
          role: 'primary',
          membershipStatus: 'active',
          lifecycleState: bot.state,
          speechPersona: bot.speechPersona,
          characterName: bot.characterName,
          avatarUrl: null,
          capabilities: [],
          permissionsSummary: null,
        });
      }
    }

    assignedBots.sort((left, right) => {
      if (left.role !== right.role) {
        return left.role === 'primary' ? -1 : 1;
      }
      if (left.membershipStatus !== right.membershipStatus) {
        return left.membershipStatus === 'active' ? -1 : 1;
      }
      return left.label.localeCompare(right.label, 'ru');
    });

    return assignedBots;
  }

  private resolveSharedMode(
    assignedBots: readonly ManagedEntityAssignedBot[],
  ): ManagedEntityBotExecutionPlan['sharedMode'] {
    const activeBots = assignedBots.filter((bot) => bot.membershipStatus === 'active');
    const activeExecutableStandbyBots = activeBots.filter((bot) =>
      this.isActiveExecutableStandbyBot(bot),
    );
    if (activeBots.length <= 1 || activeExecutableStandbyBots.length === 0) {
      return 'owned';
    }

    const primaryBot = activeBots.find((bot) => bot.role === 'primary') ?? activeBots[0] ?? null;
    const assistPartner = activeExecutableStandbyBots.find((bot) => bot.capabilities.length > 0);
    if (assistPartner) {
      return 'shared-assist';
    }

    if (primaryBot?.lifecycleState === 'draining') {
      return 'shared-failover';
    }

    return 'shared-standby';
  }

  private isExecutableLifecycleState(state: ManagedEntityAssignedBot['lifecycleState']): boolean {
    return canExecuteActionsForBotState(state);
  }

  private isActiveExecutableStandbyBot(bot: ManagedEntityAssignedBot): boolean {
    return (
      bot.role === 'standby' &&
      bot.membershipStatus === 'active' &&
      this.isExecutableLifecycleState(bot.lifecycleState)
    );
  }

  private resolveRequestedBotId(botId: string | null | undefined): string | null {
    const normalized = typeof botId === 'string' ? botId.trim() : '';
    if (!normalized) {
      return null;
    }

    const bot = this.maxBotRegistry.getBotById(normalized);
    if (!bot) {
      throw new BadRequestException('Выбранный бот не найден.');
    }

    return bot.id;
  }

  private async updateMembershipCapabilities(
    chatId: string,
    botId: string,
    capabilities: readonly ManagedEntityBotCapability[],
    accessRefresh: BotAccessSnapshotRefreshResult | null,
  ): Promise<boolean> {
    if (accessRefresh && !accessRefresh.persistedEpoch) {
      return false;
    }
    const updated = await this.prisma.chatBotMembership.updateMany({
      where: {
        chatId,
        botId,
        status: ChatBotMembershipStatus.ACTIVE,
        ...(accessRefresh?.persistedEpoch
          ? {
              botAccessCheckedAt: accessRefresh.persistedEpoch.checkedAt,
              botAccessSource: accessRefresh.persistedEpoch.source,
              botAccessState: accessRefresh.persistedEpoch.accessState,
            }
          : {}),
      },
      data: {
        capabilities: [...capabilities],
      },
    });
    return updated.count === 1;
  }

  private normalizeCapabilities(value: unknown): ManagedEntityBotCapability[] {
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

  private normalizePermissionsSummary(value: unknown): PermissionsSummary | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }

    const row = value as Record<string, unknown>;
    const checkedAt =
      typeof row.checkedAt === 'string' && row.checkedAt.trim().length > 0 ? row.checkedAt : null;
    const permissions = Array.isArray(row.permissions)
      ? Array.from(
          new Set(
            row.permissions
              .map((item) => (typeof item === 'string' ? item.trim() : ''))
              .filter((item): item is string => item.length > 0),
          ),
        )
      : [];

    return {
      checkedAt,
      isAdmin: row.isAdmin === true,
      isOwner: row.isOwner === true,
      permissions,
    };
  }

  private async refreshBotAccessSnapshot(
    chatId: string,
    botId: string,
    options: { source: string; honorSharedBackoff?: boolean },
  ): Promise<BotAccessSnapshotRefreshResult> {
    if (await this.isManagedRefreshBackoffActive(options)) {
      return {
        snapshot: await this.resolveStoredPermissionsSnapshot(chatId, botId),
      };
    }

    const probeStartedAt = new Date();
    try {
      const access = await this.maxClient.getCurrentChatMemberAccess(chatId, {
        botId,
        bypassCache: true,
        trafficClass: 'background',
        timeoutMs: 1_500,
        sourceTag: MAX_API_SOURCE_TAGS.MANAGED_REFRESH,
      });
      const persisted = await this.maxBotLinkService.recordBotAccessProbe({
        chatId,
        botId,
        access,
        source: options.source,
        checkedAt: probeStartedAt,
        allowMembershipRecovery: false,
      });
      const snapshot = this.toPermissionsSummary(access, probeStartedAt);
      return {
        snapshot,
        ...(persisted
          ? {
              persistedEpoch: {
                checkedAt: probeStartedAt,
                source: options.source,
                accessState: this.resolveBotAccessState(snapshot),
              },
            }
          : {}),
      };
    } catch (error: unknown) {
      if (this.isRateLimitPressureError(error)) {
        await this.markManagedRefreshBackoff();
        this.logger.debug(
          {
            chatId,
            botId,
            err: error instanceof Error ? error.message : String(error),
          },
          'Deferred execution planner access refresh under managed_refresh rate pressure',
        );
        return {
          snapshot: await this.resolveStoredPermissionsSnapshot(chatId, botId),
        };
      }

      if (this.isTerminalBotAccessError(error)) {
        const lastErrorCode = this.resolveBotAccessErrorCode(error);
        const persisted = await this.maxBotLinkService.recordBotAccessProbe({
          chatId,
          botId,
          access: null,
          source: options.source,
          checkedAt: probeStartedAt,
          lastErrorCode,
          allowMembershipRecovery: false,
        });
        await this.managedEntityAccessLossService?.recordIfManagedEntityAccessLost({
          chatId,
          botId,
          operation: 'lookup',
          source: options.source,
          error,
          lifecycleEventAt: probeStartedAt,
          lifecycleEventType: 'live_probe',
          lifecycleSource: 'live_probe',
        });
        const snapshot = this.toDeniedPermissionsSummary(probeStartedAt);
        this.logger.debug(
          {
            chatId,
            botId,
            err: error instanceof Error ? error.message : String(error),
          },
          'Execution planner access refresh confirmed denied bot access',
        );
        return {
          snapshot,
          accessStateOverride: ChatBotAccessState.DENIED,
          lastErrorCode,
          ...(persisted
            ? {
                persistedEpoch: {
                  checkedAt: probeStartedAt,
                  source: options.source,
                  accessState: ChatBotAccessState.DENIED,
                },
              }
            : {}),
        };
      }

      this.logger.warn(
        {
          chatId,
          botId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to refresh bot access snapshot for execution planner',
      );

      return {
        snapshot: await this.resolveStoredPermissionsSnapshot(chatId, botId),
      };
    }
  }

  private async resolveStoredPermissionsSnapshot(
    chatId: string,
    botId: string,
  ): Promise<PermissionsSummary | null> {
    const state = await this.loadChatState(chatId);
    const existing = state.memberships.find((membership) => membership.botId === botId) ?? null;
    return this.normalizePermissionsSummary(existing?.permissionsSnapshot ?? null);
  }

  private toPermissionsSummary(access: MaxChatMemberAccess, checkedAt: Date): PermissionsSummary {
    return {
      checkedAt: checkedAt.toISOString(),
      isAdmin: access.isAdmin,
      isOwner: access.isOwner,
      permissions: Array.from(
        new Set(access.permissions.map((item) => item.trim()).filter(Boolean)),
      ),
    };
  }

  private toDeniedPermissionsSummary(checkedAt: Date): PermissionsSummary {
    return {
      checkedAt: checkedAt.toISOString(),
      isAdmin: false,
      isOwner: false,
      permissions: [],
    };
  }

  private resolveBotAccessState(snapshot: PermissionsSummary | null): ChatBotAccessState {
    if (!snapshot) {
      return ChatBotAccessState.UNKNOWN;
    }
    if (snapshot.isOwner) {
      return ChatBotAccessState.CONFIRMED_OWNER;
    }
    if (snapshot.isAdmin) {
      return ChatBotAccessState.CONFIRMED_ADMIN;
    }
    return ChatBotAccessState.CONFIRMED_MEMBER;
  }

  private readFreshPermissionsSummary(value: unknown, now = Date.now()): PermissionsSummary | null {
    const snapshot = this.normalizePermissionsSummary(value);
    if (!snapshot?.checkedAt) {
      return null;
    }

    const checkedAtMs = Date.parse(snapshot.checkedAt);
    if (!Number.isFinite(checkedAtMs) || checkedAtMs + ACCESS_SNAPSHOT_REFRESH_DEBOUNCE_MS <= now) {
      return null;
    }

    return snapshot;
  }

  private isRateLimitPressureError(error: unknown): boolean {
    const status = (error as { response?: { status?: number } } | null)?.response?.status;
    if (status === 429) {
      return true;
    }

    const message = error instanceof Error ? error.message : String(error);
    const normalizedMessage = message.trim().toLowerCase();
    return (
      normalizedMessage.includes('rate limit exceeded') ||
      normalizedMessage.includes('source limit exceeded')
    );
  }

  private isTerminalBotAccessError(error: unknown): boolean {
    const status = (error as { response?: { status?: number } } | null)?.response?.status;
    if (status === 403 || status === 404) {
      return true;
    }

    const code = this.resolveBotAccessErrorCode(error);
    return code === 'access.denied' || code === 'chat.denied' || code === 'chat.not.found';
  }

  private resolveBotAccessErrorCode(error: unknown): string | null {
    const code = (error as { response?: { data?: { code?: unknown } } } | null)?.response?.data
      ?.code;
    if (typeof code === 'string' && code.trim().length > 0) {
      return code.trim();
    }

    const status = (error as { response?: { status?: number } } | null)?.response?.status;
    if (status === 403) {
      return 'access.denied';
    }
    if (status === 404) {
      return 'chat.not.found';
    }

    return null;
  }

  private isLocalManagedRefreshBackoffActive(now = Date.now()): boolean {
    if (this.managedRefreshBackoffUntilMs <= now) {
      this.managedRefreshBackoffUntilMs = 0;
      return false;
    }

    return true;
  }

  private async isManagedRefreshBackoffActive(
    options: { honorSharedBackoff?: boolean } = {},
    now = Date.now(),
  ): Promise<boolean> {
    if (this.isLocalManagedRefreshBackoffActive(now)) {
      return true;
    }

    if (options.honorSharedBackoff !== true || !this.chatContextCache) {
      return false;
    }

    try {
      return await this.chatContextCache.isManagedRefreshSourceBackoffActive();
    } catch (error: unknown) {
      this.logger.debug(
        {
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to read shared managed_refresh backoff marker',
      );
      return false;
    }
  }

  private async markManagedRefreshBackoff(now = Date.now()): Promise<void> {
    this.managedRefreshBackoffUntilMs = Math.max(
      this.managedRefreshBackoffUntilMs,
      now + ACCESS_SNAPSHOT_RATE_LIMIT_BACKOFF_MS,
    );

    if (!this.chatContextCache) {
      return;
    }

    try {
      await this.chatContextCache.activateManagedRefreshSourceBackoff(
        Math.ceil(ACCESS_SNAPSHOT_RATE_LIMIT_BACKOFF_MS / 1_000),
      );
    } catch (error: unknown) {
      this.logger.debug(
        {
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to store shared managed_refresh backoff marker',
      );
    }
  }

  private toPrismaEntityType(entityType: ManagedEntityType): ChatEntityType {
    return entityType === 'channel' ? ChatEntityType.CHANNEL : ChatEntityType.CHAT;
  }
}
