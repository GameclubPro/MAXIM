import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import {
  ChatBotMembershipRole,
  ChatBotMembershipStatus,
  ChatEntityType,
  Prisma,
} from '@prisma/client';
import type {
  ManagedEntityAssignedBot,
  ManagedEntityBotCapability,
  ManagedEntityBotExecutionPlan,
  ManagedEntityType,
} from '@maxim/contracts';
import { PrismaService } from '../prisma/prisma.service';
import { MaxClientService, type MaxChatMemberAccess } from './max-client.service';
import { MaxBotLinkService } from './max-bot-link.service';
import {
  MaxBotRegistryService,
  type MaxBotDefinition,
} from './max-bot-registry.service';

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

const ASSIST_CAPABILITIES_BY_ENTITY: Record<ManagedEntityType, readonly ManagedEntityBotCapability[]> = {
  chat: ['suggestion_delivery', 'membership_prewarm', 'access_prewarm'],
  channel: [
    'background_scans',
    'channel_stats',
    'suggestion_delivery',
    'membership_prewarm',
    'access_prewarm',
  ],
};

const ACTIONABLE_LIFECYCLE_STATES = new Set(['active', 'draining']);

@Injectable()
export class MaxBotExecutionPlannerService {
  private readonly logger = new Logger(MaxBotExecutionPlannerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly maxClient: MaxClientService,
    private readonly maxBotLinkService: MaxBotLinkService,
    private readonly maxBotRegistry: MaxBotRegistryService,
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
    if (!ACTIONABLE_LIFECYCLE_STATES.has(targetBot.state)) {
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

    await this.prisma.chat.update({
      where: { id: chatId },
      data: {
        botId: targetBot.id,
        primaryBotId: targetBot.id,
        entityType: this.toPrismaEntityType(params.entityType),
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
        botId: targetBot.id,
        status: ChatBotMembershipStatus.ACTIVE,
      },
      data: {
        role: ChatBotMembershipRole.PRIMARY,
      },
    });

    this.maxBotLinkService.rememberChatBotBinding(chatId, targetBot.id);
    return this.buildExecutionPlan(chatId, params.entityType);
  }

  async promoteStandby(params: {
    chatId: string;
    entityType: ManagedEntityType;
    botId?: string | null;
  }): Promise<ManagedEntityBotExecutionPlan> {
    const state = await this.loadChatState(params.chatId);
    const requestedBotId = this.maxBotRegistry.getBotById(params.botId)?.id ?? null;
    const candidateMembership =
      state.memberships.find(
        (membership) =>
          membership.botId === requestedBotId &&
          membership.status === ChatBotMembershipStatus.ACTIVE &&
          membership.role === ChatBotMembershipRole.STANDBY,
      ) ??
      state.memberships.find(
        (membership) =>
          membership.status === ChatBotMembershipStatus.ACTIVE &&
          membership.role === ChatBotMembershipRole.STANDBY &&
          ACTIONABLE_LIFECYCLE_STATES.has(
            this.maxBotRegistry.getBotById(membership.botId)?.state ?? 'disabled',
          ),
      );

    if (!candidateMembership) {
      throw new BadRequestException('В этом чате нет активного standby-бота для promotion.');
    }

    return this.setPrimaryBot({
      chatId: params.chatId,
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
    if (membership.role === ChatBotMembershipRole.PRIMARY) {
      throw new BadRequestException('Owner-бот и так обслуживает user-facing path без assist-режима.');
    }

    let nextCapabilities: ManagedEntityBotCapability[] = [];
    let nextPermissionsSnapshot: PermissionsSummary | null = this.normalizePermissionsSummary(
      membership.permissionsSnapshot,
    );
    if (params.enabled) {
      nextPermissionsSnapshot = await this.refreshBotAccessSnapshot(chatId, botId);
      if (!nextPermissionsSnapshot.isAdmin && !nextPermissionsSnapshot.isOwner) {
        throw new BadRequestException(
          'Assist-режим можно включить только для бота с admin/owner доступом в этом чате.',
        );
      }
      nextCapabilities = [...ASSIST_CAPABILITIES_BY_ENTITY[params.entityType]];
    }

    await this.prisma.chatBotMembership.update({
      where: {
        chatId_botId: {
          chatId,
          botId,
        },
      },
      data: {
        capabilities: nextCapabilities,
        permissionsSnapshot: nextPermissionsSnapshot ?? Prisma.JsonNull,
      },
    });

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
      if (!bot || !ACTIONABLE_LIFECYCLE_STATES.has(bot.state)) {
        continue;
      }
      const snapshot = await this.refreshBotAccessSnapshot(chatId, bot.id);
      await this.prisma.chatBotMembership.update({
        where: {
          chatId_botId: {
            chatId,
            botId: bot.id,
          },
        },
        data: {
          permissionsSnapshot: snapshot ?? Prisma.JsonNull,
        },
      });
    }

    return this.buildExecutionPlan(chatId, params.entityType);
  }

  private async buildExecutionPlan(
    chatId: string,
    entityType: ManagedEntityType,
  ): Promise<ManagedEntityBotExecutionPlan> {
    const state = await this.loadChatState(chatId);
    const assignedBots = this.buildAssignedBots(state.memberships, state.primaryBotId);
    const sharedMode = this.resolveSharedMode(assignedBots);
    const activePartner =
      assignedBots.find(
        (bot) =>
          bot.role === 'standby' &&
          bot.membershipStatus === 'active' &&
          bot.lifecycleState !== 'disabled',
      ) ?? null;
    const assistPartner =
      assignedBots.find(
        (bot) =>
          bot.role === 'standby' &&
          bot.membershipStatus === 'active' &&
          bot.capabilities.length > 0 &&
          bot.lifecycleState !== 'disabled',
      ) ?? null;
    const partnerBotId = assistPartner?.botId ?? activePartner?.botId ?? null;
    const primaryBotId =
      this.maxBotRegistry.getBotById(state.primaryBotId)?.id ??
      assignedBots.find((bot) => bot.role === 'primary' && bot.membershipStatus === 'active')?.botId ??
      null;
    const reasons = [
      'User-facing updates, moderation notices and deep links всегда идут через owner-бота.',
    ];
    if (assistPartner) {
      reasons.push(
        `Assist-бот ${assistPartner.label} обслуживает только фоновые lane’ы: ${assistPartner.capabilities.join(', ')}.`,
      );
    } else if (activePartner) {
      reasons.push(
        `Standby-бот ${activePartner.label} готов к promotion, но assist-режим для него ещё не включён.`,
      );
    } else {
      reasons.push('В этом чате сейчас нет второго активного бота, поэтому режим остаётся owned.');
    }

    const warnings: string[] = [];
    if (!primaryBotId) {
      warnings.push('У чата нет валидного owner-бота. До dual-bot rollout надо назначить primary.');
    }
    if (activePartner && !assistPartner) {
      const snapshot = activePartner.permissionsSummary;
      if (!snapshot) {
        warnings.push(
          `Для ${activePartner.label} ещё нет актуального permissions snapshot. Нажмите «Обновить права» перед включением assist.`,
        );
      } else if (!snapshot.isAdmin && !snapshot.isOwner) {
        warnings.push(
          `${activePartner.label} больше не выглядит админом этого чата. Assist для него безопасно выключен.`,
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
      sharedMode,
      userFacingPolicy: 'owner-only',
      reasons,
      warnings,
      assignedBots,
    };
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
        membershipStatus: membership.status === ChatBotMembershipStatus.REMOVED ? 'removed' : 'active',
        lifecycleState: bot.state,
        speechPersona: bot.speechPersona,
        characterName: bot.characterName,
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
    if (activeBots.length <= 1) {
      return 'owned';
    }

    const primaryBot = activeBots.find((bot) => bot.role === 'primary') ?? activeBots[0] ?? null;
    const assistPartner = activeBots.find(
      (bot) => bot.role === 'standby' && bot.capabilities.length > 0,
    );
    if (assistPartner) {
      return 'shared-assist';
    }

    if (primaryBot?.lifecycleState === 'draining') {
      return 'shared-failover';
    }

    return 'shared-standby';
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
          .filter((item): item is ManagedEntityBotCapability => supported.has(item as ManagedEntityBotCapability)),
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

  private async refreshBotAccessSnapshot(chatId: string, botId: string): Promise<PermissionsSummary> {
    try {
      const access = await this.maxClient.getCurrentChatMemberAccess(chatId, {
        botId,
        trafficClass: 'background',
        timeoutMs: 1_500,
      });
      return this.toPermissionsSummary(access);
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId,
          botId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to refresh bot access snapshot for execution planner',
      );

      const state = await this.loadChatState(chatId);
      const existing = state.memberships.find((membership) => membership.botId === botId) ?? null;
      const snapshot = this.normalizePermissionsSummary(existing?.permissionsSnapshot ?? null);
      if (snapshot) {
        return snapshot;
      }

      return {
        checkedAt: new Date().toISOString(),
        isAdmin: false,
        isOwner: false,
        permissions: [],
      };
    }
  }

  private toPermissionsSummary(access: MaxChatMemberAccess): PermissionsSummary {
    return {
      checkedAt: new Date().toISOString(),
      isAdmin: access.isAdmin,
      isOwner: access.isOwner,
      permissions: Array.from(new Set(access.permissions.map((item) => item.trim()).filter(Boolean))),
    };
  }

  private toPrismaEntityType(entityType: ManagedEntityType): ChatEntityType {
    return entityType === 'channel' ? ChatEntityType.CHANNEL : ChatEntityType.CHAT;
  }
}
