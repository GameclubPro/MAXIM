import { Injectable } from '@nestjs/common';
import {
  systemBotMembershipAuditSchema,
  systemBotRoutePreviewResponseSchema,
  systemBotsSnapshotSchema,
  type BotQueueMetricsSnapshot,
  type BotWebhookOperationalDiagnostics,
  type BotWebhookSubscriptionSnapshot,
  type SystemBotMembershipAudit,
  type SystemBotMembershipAuditBotSummary,
  type SystemBotMembershipAuditKind,
  type SystemBotMembershipAuditSample,
  type SystemBotMembershipAuditSeverity,
  type SystemBotAccessState,
  type SystemBotEntityCount,
  type SystemBotEntityType,
  type SystemBotManagedEntityStats,
  type SystemBotMaxApiLoad,
  type SystemBotMembershipRole,
  type SystemBotMembershipStatus,
  type SystemBotProblemKind,
  type SystemBotProblemSample,
  type SystemBotRouteMembership,
  type SystemBotRouteModerationAction,
  type SystemBotRoutePreviewResponse,
  type SystemBotRoutePreviewRoute,
  type SystemBotRoutePurpose,
  type SystemBotsSnapshot,
} from '@maxim/contracts/system';
import type { ManagedEntityBotCapability } from '@maxim/contracts/managed-entities';
import { isPrivateDirectChatId } from '../common/chat-id.util';
import {
  MaxBotLinkService,
  type MaxBotRoute,
  type MaxBotRouteRequest,
} from '../max/max-bot-link.service';
import { MaxBotRegistryService } from '../max/max-bot-registry.service';
import {
  canDiscoverChatsForBotState,
  canExecuteActionsForBotState,
  isOperationalBotState,
} from '../max/max-bot-state.util';
import {
  DEFAULT_PRIMARY_ACCESS_SNAPSHOT_FRESH_MS,
  isFreshMembershipAccessSnapshot,
  membershipExplicitlyLacksAccess,
  normalizeMembershipAccessSnapshot,
  resolvePreferredPrimaryBotId,
  type MembershipAccessSnapshot,
} from '../max/max-bot-access-policy.util';
import {
  ChatBotAccessState,
  ChatBotMembershipRole,
  ChatBotMembershipStatus,
  ChatCatalogKind,
  ChatEntityType,
  Prisma,
} from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { MaxApiMetricsService, type MaxApiBotRateLimitSnapshot } from './max-api-metrics.service';
import { QueueMetricsService } from './queue-metrics.service';
import { WebhookSubscriptionStatusService } from './webhook-subscription-status.service';

type PrimaryCountRow = {
  primaryBotId: string | null;
  entityType: ChatEntityType;
  _count: {
    _all: number;
  };
};

type MembershipAggregateRow = {
  botId: string;
  role: string;
  status: string;
  botAccessState: string;
  entityType: string;
  isAssist: boolean;
  count: bigint | number;
};

type ProblemSampleRow = {
  botId: string;
  chatId: string;
  title: string | null;
  entityType: string;
  kind: string;
  botRole: string;
  membershipStatus: string;
  botAccessState: string;
  primaryBotId: string | null;
  checkedAt: Date | string | null;
  lastSeenAt: Date | string | null;
  lastWebhookAt: Date | string | null;
  updatedAt: Date | string;
};

const BOT_PROBLEM_SAMPLE_LIMIT = 5;
const BOT_AUDIT_DEFAULT_SAMPLE_LIMIT = 25;
const BOT_ROUTE_PREVIEW_CAPABILITIES: readonly ManagedEntityBotCapability[] = [
  'background_scans',
  'channel_stats',
  'suggestion_delivery',
  'membership_prewarm',
  'access_prewarm',
];
const BOT_ROUTE_PREVIEW_MODERATION_ACTIONS: readonly SystemBotRouteModerationAction[] = [
  'delete_message',
  'moderate_member',
];

export type SystemBotRoutePreviewParams = {
  chatId: string;
  purpose: 'all' | SystemBotRoutePurpose;
  action?: SystemBotRouteModerationAction | null;
  capability?: ManagedEntityBotCapability | null;
  fallbackToPrimary?: boolean;
  botId?: string | null;
};

export type SystemBotMembershipAuditOptions = {
  sampleLimit?: number;
  snapshotFreshMs?: number;
};

type RoutePreviewChatRow = {
  id: string;
  title: string;
  entityType: ChatEntityType;
  catalogKind: ChatCatalogKind;
  primaryBotId: string | null;
  botId: string | null;
  botMemberships: RoutePreviewMembershipRow[];
};

type RoutePreviewMembershipRow = {
  botId: string;
  role: ChatBotMembershipRole;
  status: ChatBotMembershipStatus;
  capabilities: unknown;
  permissionsSnapshot: unknown;
  botAccessState: ChatBotAccessState;
  botAccessCheckedAt: Date | string | null;
  botAccessExpiresAt: Date | string | null;
  botAccessSource: string | null;
  botAccessLastErrorCode: string | null;
  lastSeenAt: Date | string | null;
  lastWebhookAt: Date | string | null;
  updatedAt?: Date | string;
  createdAt?: Date | string;
};

type AuditChatRow = RoutePreviewChatRow;

type AuditIssueInput = {
  kind: SystemBotMembershipAuditKind;
  severity: SystemBotMembershipAuditSeverity;
  chat: AuditChatRow;
  membership?: RoutePreviewMembershipRow | null;
  suggestedPrimaryBotId?: string | null;
  alternateBotIds?: string[];
  reason: string;
  evidenceFresh?: boolean;
};

@Injectable()
export class SystemBotsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly botRegistry: MaxBotRegistryService,
    private readonly botLinkService: MaxBotLinkService,
    private readonly queueMetricsService: QueueMetricsService,
    private readonly webhookSubscriptionStatusService: WebhookSubscriptionStatusService,
    private readonly maxApiMetricsService: MaxApiMetricsService,
  ) {}

  async getSnapshot(): Promise<SystemBotsSnapshot> {
    const bots = [...this.botRegistry.getAllBots()];
    const botIds = bots.map((bot) => bot.id);
    const generatedAt = new Date().toISOString();

    const [
      queueSnapshot,
      webhookSubscription,
      maxApiLoads,
      primaryRows,
      membershipRows,
      problemRows,
    ] = await Promise.all([
      this.queueMetricsService.getSnapshot({ maxAgeMs: 2_000 }),
      this.webhookSubscriptionStatusService.getSnapshot(),
      this.maxApiMetricsService.getBotRateLimitSnapshot(botIds, { windowSec: 60 }),
      this.readPrimaryCounts(botIds),
      this.readMembershipAggregates(botIds),
      this.readProblemSamples(botIds),
    ]);

    const botStats = new Map(
      botIds.map((botId) => [
        botId,
        {
          entities: this.createEmptyEntityStats(),
          access: {
            lost: 0,
            stale: 0,
            denied: 0,
            unknown: 0,
            removedAfterLoss: 0,
          },
          problemSamples: [] as SystemBotProblemSample[],
        },
      ]),
    );

    for (const row of primaryRows) {
      if (!row.primaryBotId) {
        continue;
      }
      const stats = botStats.get(row.primaryBotId);
      if (!stats) {
        continue;
      }
      this.incrementEntityCount(stats.entities.primary, row.entityType, row._count._all);
    }

    for (const row of membershipRows) {
      const stats = botStats.get(row.botId);
      if (!stats) {
        continue;
      }

      const count = this.toNumber(row.count);
      const status = this.mapMembershipStatus(row.status);
      const role = this.mapMembershipRole(row.role);
      const accessState = this.mapAccessState(row.botAccessState);
      const entityType = this.mapEntityType(row.entityType);

      if (status === 'active' && role === 'standby') {
        this.incrementEntityCount(stats.entities.standby, entityType, count);
        if (row.isAssist) {
          this.incrementEntityCount(stats.entities.assist, entityType, count);
        }
      }

      if (status === 'active') {
        if (accessState === 'lost') {
          stats.access.lost += count;
        } else if (accessState === 'stale') {
          stats.access.stale += count;
        } else if (accessState === 'denied') {
          stats.access.denied += count;
        } else if (accessState === 'unknown') {
          stats.access.unknown += count;
        }
      }

      if (status === 'removed' && accessState === 'lost') {
        stats.access.removedAfterLoss += count;
      }
    }

    for (const row of problemRows) {
      const stats = botStats.get(row.botId);
      if (!stats || stats.problemSamples.length >= BOT_PROBLEM_SAMPLE_LIMIT) {
        continue;
      }
      stats.problemSamples.push(this.mapProblemSample(row));
    }

    const summaries = bots.map((bot) => {
      const stats = botStats.get(bot.id) ?? {
        entities: this.createEmptyEntityStats(),
        access: {
          lost: 0,
          stale: 0,
          denied: 0,
          unknown: 0,
          removedAfterLoss: 0,
        },
        problemSamples: [] as SystemBotProblemSample[],
      };
      const webhook = webhookSubscription.bots[bot.id] ?? null;

      return {
        botId: bot.id,
        label: bot.label,
        characterName: bot.characterName,
        lifecycleState: bot.state,
        adminVisible: bot.visibleInAdmin,
        isDefault: bot.isDefault,
        contactId: bot.contactId,
        webhook,
        operationalDiagnostics: webhook?.operationalDiagnostics ?? null,
        queue: (queueSnapshot.bots[bot.id] ?? null) as BotQueueMetricsSnapshot | null,
        maxApiLoad: this.mapMaxApiLoad(maxApiLoads[bot.id]),
        entities: stats.entities,
        access: stats.access,
        problemSamples: stats.problemSamples,
      };
    });

    const parsed = systemBotsSnapshotSchema.parse({
      generatedAt,
      summary: this.buildSummary(summaries),
      bots: summaries,
    });

    return parsed;
  }

  async getRoutePreview(
    params: SystemBotRoutePreviewParams,
  ): Promise<SystemBotRoutePreviewResponse> {
    const chatId = params.chatId.trim();
    const fallbackToPrimary = params.fallbackToPrimary !== false;
    const generatedAt = new Date().toISOString();
    const chat = await this.readRoutePreviewChat(chatId);
    const routeRequests = this.buildRoutePreviewRequests({
      chatId,
      purpose: params.purpose,
      action: params.action ?? null,
      capability: params.capability ?? null,
      fallbackToPrimary,
      botId: params.botId ?? null,
    });
    const routes = await Promise.all(
      routeRequests.map((request) => this.botLinkService.resolveBotRoute(request)),
    );
    const warnings = this.buildRoutePreviewWarnings(chatId, chat, routes);
    const parsed = systemBotRoutePreviewResponseSchema.parse({
      generatedAt,
      query: {
        chatId,
        purpose: params.purpose,
        action: params.action ?? null,
        capability: params.capability ?? null,
        fallbackToPrimary,
        botId: params.botId ?? null,
      },
      chat: {
        exists: Boolean(chat),
        chatId,
        title: chat?.title ?? null,
        entityType: chat ? this.mapEntityType(chat.entityType) : null,
        catalogKind: chat?.catalogKind ?? null,
        storedPrimaryBotId: chat?.primaryBotId ?? null,
        legacyBotId: chat?.botId ?? null,
      },
      routes: routes.map((route) => this.mapRoutePreviewRoute(route)),
      memberships: (chat?.botMemberships ?? []).map((membership) =>
        this.mapRoutePreviewMembership(membership),
      ),
      warnings,
    });

    return parsed;
  }

  async getMembershipAudit(
    options: SystemBotMembershipAuditOptions = {},
  ): Promise<SystemBotMembershipAudit> {
    const generatedAt = new Date().toISOString();
    const nowMs = Date.parse(generatedAt);
    const snapshotFreshMs =
      typeof options.snapshotFreshMs === 'number' && Number.isFinite(options.snapshotFreshMs)
        ? Math.max(0, Math.trunc(options.snapshotFreshMs))
        : DEFAULT_PRIMARY_ACCESS_SNAPSHOT_FRESH_MS;
    const sampleLimit =
      typeof options.sampleLimit === 'number' && Number.isFinite(options.sampleLimit)
        ? Math.max(1, Math.trunc(options.sampleLimit))
        : BOT_AUDIT_DEFAULT_SAMPLE_LIMIT;
    const chats = await this.readAuditChats();
    const summary = {
      auditedEntities: chats.length,
      activeMemberships: 0,
      deniedActivePrimary: 0,
      storedPrimaryDeniedAlternateEligible: 0,
      stalePermissionsSnapshot: 0,
      capabilitiesOnDeniedBot: 0,
      suspiciousRows: 0,
      warningCount: 0,
      criticalCount: 0,
    };
    const samples: SystemBotMembershipAuditSample[] = [];
    const byBot = new Map<string, SystemBotMembershipAuditBotSummary>();
    const ensureBotSummary = (botId: string): SystemBotMembershipAuditBotSummary => {
      const existing = byBot.get(botId);
      if (existing) {
        return existing;
      }
      const bot = this.botRegistry.getBotById(botId);
      const created: SystemBotMembershipAuditBotSummary = {
        botId,
        label: bot?.label ?? null,
        deniedPrimary: 0,
        staleSnapshots: 0,
        deniedCapabilities: 0,
        alternateEligibleFor: 0,
      };
      byBot.set(botId, created);
      return created;
    };
    for (const bot of this.botRegistry.getAllBots()) {
      ensureBotSummary(bot.id);
    }

    const addIssue = (issue: AuditIssueInput) => {
      if (issue.severity === 'warning') {
        summary.warningCount += 1;
      } else if (issue.severity === 'critical') {
        summary.criticalCount += 1;
      }

      switch (issue.kind) {
        case 'denied-active-primary':
          summary.deniedActivePrimary += 1;
          if (issue.membership?.botId) {
            ensureBotSummary(issue.membership.botId).deniedPrimary += 1;
          }
          break;
        case 'stored-primary-denied-alternate-eligible':
          summary.storedPrimaryDeniedAlternateEligible += 1;
          if (issue.suggestedPrimaryBotId) {
            ensureBotSummary(issue.suggestedPrimaryBotId).alternateEligibleFor += 1;
          }
          break;
        case 'stale-permissions-snapshot':
          summary.stalePermissionsSnapshot += 1;
          if (issue.membership?.botId) {
            ensureBotSummary(issue.membership.botId).staleSnapshots += 1;
          }
          break;
        case 'capabilities-on-denied-bot':
          summary.capabilitiesOnDeniedBot += 1;
          if (issue.membership?.botId) {
            ensureBotSummary(issue.membership.botId).deniedCapabilities += 1;
          }
          break;
        case 'suspicious-row':
          summary.suspiciousRows += 1;
          break;
      }

      if (samples.length >= sampleLimit) {
        return;
      }
      samples.push(
        this.mapAuditSample(issue, {
          nowMs,
          snapshotFreshMs,
        }),
      );
    };

    for (const chat of chats) {
      const activeMemberships = chat.botMemberships.filter(
        (membership) => membership.status === ChatBotMembershipStatus.ACTIVE,
      );
      summary.activeMemberships += activeMemberships.length;

      const primaryRoleMemberships = activeMemberships.filter(
        (membership) => membership.role === ChatBotMembershipRole.PRIMARY,
      );
      if (primaryRoleMemberships.length > 1) {
        addIssue({
          kind: 'suspicious-row',
          severity: 'warning',
          chat,
          membership: primaryRoleMemberships[0] ?? null,
          alternateBotIds: primaryRoleMemberships.map((membership) => membership.botId),
          reason: 'Several active memberships are marked PRIMARY for the same chat.',
        });
      }

      if (chat.entityType === ChatEntityType.CHAT && isPrivateDirectChatId(chat.id)) {
        addIssue({
          kind: 'suspicious-row',
          severity: 'warning',
          chat,
          membership: activeMemberships[0] ?? null,
          reason: 'Managed chat has a positive private-direct MAX chat id.',
        });
      }

      for (const membership of activeMemberships) {
        const bot = this.botRegistry.getBotById(membership.botId);
        const capabilities = this.normalizeBotCapabilities(membership.capabilities);
        const denied = this.membershipHasDeniedAccess(membership);
        const snapshot = normalizeMembershipAccessSnapshot(membership.permissionsSnapshot);
        const isPrimaryOrAssist =
          membership.role === ChatBotMembershipRole.PRIMARY || capabilities.length > 0;

        if (!bot) {
          addIssue({
            kind: 'suspicious-row',
            severity: 'warning',
            chat,
            membership,
            reason: 'Active membership points to a bot that is not configured at runtime.',
          });
        }

        if (membership.role === ChatBotMembershipRole.PRIMARY && capabilities.length > 0) {
          addIssue({
            kind: 'suspicious-row',
            severity: 'warning',
            chat,
            membership,
            reason:
              'Primary membership has assist capabilities; capabilities should live on standby bots.',
          });
        }

        if (capabilities.length > 0 && denied) {
          addIssue({
            kind: 'capabilities-on-denied-bot',
            severity: this.hasFreshAccessEvidence(membership, nowMs, snapshotFreshMs)
              ? 'critical'
              : 'warning',
            chat,
            membership,
            reason:
              'Bot keeps assist capabilities while access snapshot says it is denied or no longer admin/owner.',
          });
        }

        if (
          isPrimaryOrAssist &&
          !isFreshMembershipAccessSnapshot(snapshot, { nowMs, freshMs: snapshotFreshMs })
        ) {
          addIssue({
            kind: 'stale-permissions-snapshot',
            severity: membership.role === ChatBotMembershipRole.PRIMARY ? 'warning' : 'info',
            chat,
            membership,
            reason: snapshot
              ? 'Permissions snapshot is older than the audit freshness window.'
              : 'Permissions snapshot is missing for an active primary or assist bot.',
            evidenceFresh: false,
          });
        }
      }

      const storedPrimaryBotId = chat.primaryBotId?.trim() || null;
      const storedPrimaryMembership = storedPrimaryBotId
        ? (activeMemberships.find((membership) => membership.botId === storedPrimaryBotId) ?? null)
        : null;
      if (!storedPrimaryBotId || !storedPrimaryMembership) {
        addIssue({
          kind: 'suspicious-row',
          severity: 'warning',
          chat,
          membership: storedPrimaryMembership,
          reason: storedPrimaryBotId
            ? 'Stored primary bot is not an active membership for this chat.'
            : 'Managed chat has no stored primary bot.',
        });
        continue;
      }

      if (!this.membershipHasDeniedAccess(storedPrimaryMembership)) {
        continue;
      }

      const evidenceFresh = this.hasFreshAccessEvidence(
        storedPrimaryMembership,
        nowMs,
        snapshotFreshMs,
      );
      addIssue({
        kind: 'denied-active-primary',
        severity: evidenceFresh ? 'critical' : 'warning',
        chat,
        membership: storedPrimaryMembership,
        reason:
          'Stored primary bot is active but its local access state is denied/lost or non-admin.',
        evidenceFresh,
      });

      const alternateMemberships = activeMemberships.filter((membership) => {
        if (membership.botId === storedPrimaryBotId) {
          return false;
        }
        const bot = this.botRegistry.getBotById(membership.botId);
        const snapshot = normalizeMembershipAccessSnapshot(membership.permissionsSnapshot);
        return Boolean(
          bot &&
          canExecuteActionsForBotState(bot.state) &&
          snapshot &&
          (snapshot.isAdmin || snapshot.isOwner) &&
          isFreshMembershipAccessSnapshot(snapshot, { nowMs, freshMs: snapshotFreshMs }),
        );
      });

      if (alternateMemberships.length === 0) {
        continue;
      }

      const suggestedPrimaryBotId =
        resolvePreferredPrimaryBotId(null, alternateMemberships, {
          requireFreshSnapshotForPromotion: true,
          nowMs,
          freshMs: snapshotFreshMs,
        }) ??
        alternateMemberships[0]?.botId ??
        null;
      addIssue({
        kind: 'stored-primary-denied-alternate-eligible',
        severity: 'critical',
        chat,
        membership: storedPrimaryMembership,
        suggestedPrimaryBotId,
        alternateBotIds: alternateMemberships.map((membership) => membership.botId),
        reason:
          'Stored primary has denied access and another active executable bot has fresh admin/owner evidence.',
        evidenceFresh,
      });
    }

    const parsed = systemBotMembershipAuditSchema.parse({
      generatedAt,
      config: {
        snapshotFreshMs,
        sampleLimit,
      },
      summary,
      byBot: Array.from(byBot.values()).filter(
        (bot) =>
          bot.deniedPrimary > 0 ||
          bot.staleSnapshots > 0 ||
          bot.deniedCapabilities > 0 ||
          bot.alternateEligibleFor > 0,
      ),
      samples,
    });

    return parsed;
  }

  private async readRoutePreviewChat(chatId: string): Promise<RoutePreviewChatRow | null> {
    if (!chatId) {
      return null;
    }

    return this.prisma.chat.findUnique({
      where: { id: chatId },
      select: {
        id: true,
        title: true,
        entityType: true,
        catalogKind: true,
        primaryBotId: true,
        botId: true,
        botMemberships: {
          select: {
            botId: true,
            role: true,
            status: true,
            capabilities: true,
            permissionsSnapshot: true,
            botAccessState: true,
            botAccessCheckedAt: true,
            botAccessExpiresAt: true,
            botAccessSource: true,
            botAccessLastErrorCode: true,
            lastSeenAt: true,
            lastWebhookAt: true,
            createdAt: true,
            updatedAt: true,
          },
          orderBy: [{ updatedAt: 'desc' }, { createdAt: 'asc' }],
        },
      },
    });
  }

  private async readAuditChats(): Promise<AuditChatRow[]> {
    return this.prisma.chat.findMany({
      where: {
        OR: [
          { catalogKind: ChatCatalogKind.MANAGED },
          {
            catalogKind: ChatCatalogKind.UNKNOWN,
            entityType: ChatEntityType.CHANNEL,
          },
        ],
      },
      select: {
        id: true,
        title: true,
        entityType: true,
        catalogKind: true,
        primaryBotId: true,
        botId: true,
        botMemberships: {
          select: {
            botId: true,
            role: true,
            status: true,
            capabilities: true,
            permissionsSnapshot: true,
            botAccessState: true,
            botAccessCheckedAt: true,
            botAccessExpiresAt: true,
            botAccessSource: true,
            botAccessLastErrorCode: true,
            lastSeenAt: true,
            lastWebhookAt: true,
            createdAt: true,
            updatedAt: true,
          },
          orderBy: [{ updatedAt: 'desc' }, { createdAt: 'asc' }],
        },
      },
    });
  }

  private buildRoutePreviewRequests(params: {
    chatId: string;
    purpose: 'all' | SystemBotRoutePurpose;
    action: SystemBotRouteModerationAction | null;
    capability: ManagedEntityBotCapability | null;
    fallbackToPrimary: boolean;
    botId: string | null;
  }): MaxBotRouteRequest[] {
    const requests: MaxBotRouteRequest[] = [];
    const include = (purpose: SystemBotRoutePurpose) =>
      params.purpose === 'all' || params.purpose === purpose;

    if (include('default')) {
      requests.push({
        purpose: 'default',
        chatId: params.chatId,
        botId: params.botId,
      });
    }
    if (include('read')) {
      requests.push({ purpose: 'read', chatId: params.chatId });
    }
    if (include('member_access')) {
      requests.push({ purpose: 'member_access', chatId: params.chatId });
    }
    if (include('send_message')) {
      requests.push({
        purpose: 'send_message',
        chatId: params.chatId,
        fallbackToPrimary: params.fallbackToPrimary,
      });
    }
    if (include('moderation_action')) {
      const actions = params.action ? [params.action] : BOT_ROUTE_PREVIEW_MODERATION_ACTIONS;
      for (const action of actions) {
        requests.push({
          purpose: 'moderation_action',
          chatId: params.chatId,
          action,
          fallbackToPrimary: params.fallbackToPrimary,
        });
      }
    }
    if (include('capability')) {
      const capabilities = params.capability ? [params.capability] : BOT_ROUTE_PREVIEW_CAPABILITIES;
      for (const capability of capabilities) {
        requests.push({
          purpose: 'capability',
          chatId: params.chatId,
          capability,
          fallbackToPrimary: params.fallbackToPrimary,
        });
      }
    }

    return requests;
  }

  private buildRoutePreviewWarnings(
    chatId: string,
    chat: RoutePreviewChatRow | null,
    routes: readonly MaxBotRoute[],
  ): string[] {
    const warnings: string[] = [];
    if (!chat) {
      warnings.push(`Chat ${chatId} is not present in the local managed entity catalog.`);
      return warnings;
    }
    if (!chat.primaryBotId) {
      warnings.push('Chat has no stored primary bot.');
    }
    if (
      chat.primaryBotId &&
      !chat.botMemberships.some((item) => item.botId === chat.primaryBotId)
    ) {
      warnings.push('Stored primary bot has no local membership row.');
    }
    for (const route of routes) {
      if (!route.botId) {
        warnings.push(
          `Route ${this.formatRoutePreviewKey(route)} has no selected bot in local state.`,
        );
      }
    }
    return Array.from(new Set(warnings));
  }

  private formatRoutePreviewKey(route: MaxBotRoute): string {
    if (route.purpose === 'moderation_action') {
      return `${route.purpose}/${route.action}`;
    }
    if (route.purpose === 'capability') {
      return `${route.purpose}/${route.capability}`;
    }
    return route.purpose;
  }

  private mapRoutePreviewRoute(route: MaxBotRoute): SystemBotRoutePreviewRoute {
    return {
      purpose: route.purpose,
      action: route.purpose === 'moderation_action' ? route.action : null,
      capability: route.purpose === 'capability' ? route.capability : null,
      chatId: route.chatId,
      primaryBotId: route.primaryBotId,
      botId: route.botId,
      candidateBotIds: route.candidateBotIds,
      reason: route.reason,
      selectedBot: this.mapRouteBot(route.botId),
      candidateBots: route.candidateBotIds
        .map((botId) => this.mapRouteBot(botId))
        .filter((bot): bot is NonNullable<SystemBotRoutePreviewRoute['selectedBot']> =>
          Boolean(bot),
        ),
    };
  }

  private mapRouteBot(botId: string | null): SystemBotRoutePreviewRoute['selectedBot'] {
    if (!botId) {
      return null;
    }
    const bot = this.botRegistry.getBotById(botId);
    if (!bot) {
      return null;
    }
    return {
      botId: bot.id,
      label: bot.label,
      lifecycleState: bot.state,
      adminVisible: bot.visibleInAdmin,
      isDefault: this.botRegistry.getDefaultBot().id === bot.id,
    };
  }

  private mapRoutePreviewMembership(
    membership: RoutePreviewMembershipRow,
  ): SystemBotRouteMembership {
    const bot = this.botRegistry.getBotById(membership.botId);
    const snapshot = normalizeMembershipAccessSnapshot(membership.permissionsSnapshot);
    const capabilities = this.normalizeBotCapabilities(membership.capabilities);
    const issues: string[] = [];

    if (!bot) {
      issues.push('unknown-runtime-bot');
    } else {
      if (!isOperationalBotState(bot.state)) {
        issues.push('not-operational');
      }
      if (!canDiscoverChatsForBotState(bot.state)) {
        issues.push('not-discoverable');
      }
      if (!canExecuteActionsForBotState(bot.state)) {
        issues.push('not-executable');
      }
    }
    if (membership.status !== ChatBotMembershipStatus.ACTIVE) {
      issues.push('inactive-membership');
    }
    if (membership.botAccessState === ChatBotAccessState.DENIED) {
      issues.push('denied-access');
    } else if (membership.botAccessState === ChatBotAccessState.LOST) {
      issues.push('lost-access');
    } else if (membership.botAccessState === ChatBotAccessState.STALE) {
      issues.push('stale-access-state');
    }
    if (membershipExplicitlyLacksAccess(membership.permissionsSnapshot)) {
      issues.push('permissions-snapshot-denied');
    }
    if (capabilities.length > 0 && membership.role === ChatBotMembershipRole.PRIMARY) {
      issues.push('primary-has-assist-capabilities');
    }
    if (capabilities.length > 0 && this.membershipHasDeniedAccess(membership)) {
      issues.push('denied-bot-has-capabilities');
    }

    return {
      botId: membership.botId,
      label: bot?.label ?? null,
      configured: Boolean(bot),
      lifecycleState: bot?.state ?? null,
      operational: bot ? isOperationalBotState(bot.state) : false,
      discoverable: bot ? canDiscoverChatsForBotState(bot.state) : false,
      executable: bot ? canExecuteActionsForBotState(bot.state) : false,
      role: this.mapMembershipRole(membership.role),
      status: this.mapMembershipStatus(membership.status),
      botAccessState: this.mapAccessState(membership.botAccessState),
      capabilities,
      permissionsSummary: snapshot,
      botAccessCheckedAt: this.toIsoStringOrNull(membership.botAccessCheckedAt),
      botAccessExpiresAt: this.toIsoStringOrNull(membership.botAccessExpiresAt),
      botAccessSource: membership.botAccessSource,
      botAccessLastErrorCode: membership.botAccessLastErrorCode,
      lastSeenAt: this.toIsoStringOrNull(membership.lastSeenAt),
      lastWebhookAt: this.toIsoStringOrNull(membership.lastWebhookAt),
      issues,
    };
  }

  private mapAuditSample(
    issue: AuditIssueInput,
    freshness: { nowMs: number; snapshotFreshMs: number },
  ): SystemBotMembershipAuditSample {
    const membership = issue.membership ?? null;
    const snapshot = normalizeMembershipAccessSnapshot(membership?.permissionsSnapshot);
    const bot = this.botRegistry.getBotById(membership?.botId);
    return {
      kind: issue.kind,
      severity: issue.severity,
      chatId: issue.chat.id,
      title: issue.chat.title,
      entityType: this.mapEntityType(issue.chat.entityType),
      catalogKind: issue.chat.catalogKind,
      botId: membership?.botId ?? null,
      botLabel: bot?.label ?? null,
      primaryBotId: issue.chat.primaryBotId,
      suggestedPrimaryBotId: issue.suggestedPrimaryBotId ?? null,
      alternateBotIds: issue.alternateBotIds ?? [],
      membershipRole: membership ? this.mapMembershipRole(membership.role) : null,
      membershipStatus: membership ? this.mapMembershipStatus(membership.status) : null,
      botAccessState: membership ? this.mapAccessState(membership.botAccessState) : null,
      permissionsState: this.resolvePermissionsState(snapshot, freshness),
      permissionsCheckedAt: snapshot?.checkedAt ?? null,
      botAccessCheckedAt: this.toIsoStringOrNull(membership?.botAccessCheckedAt ?? null),
      botAccessExpiresAt: this.toIsoStringOrNull(membership?.botAccessExpiresAt ?? null),
      botAccessSource: membership?.botAccessSource ?? null,
      botAccessLastErrorCode: membership?.botAccessLastErrorCode ?? null,
      capabilities: this.normalizeBotCapabilities(membership?.capabilities),
      evidenceFresh:
        issue.evidenceFresh ??
        (membership
          ? this.hasFreshAccessEvidence(membership, freshness.nowMs, freshness.snapshotFreshMs)
          : false),
      reason: issue.reason,
    };
  }

  private resolvePermissionsState(
    snapshot: MembershipAccessSnapshot | null,
    freshness: { nowMs: number; snapshotFreshMs: number },
  ): SystemBotMembershipAuditSample['permissionsState'] {
    if (!snapshot) {
      return 'missing';
    }
    if (!snapshot.isAdmin && !snapshot.isOwner) {
      return 'denied';
    }
    return isFreshMembershipAccessSnapshot(snapshot, {
      nowMs: freshness.nowMs,
      freshMs: freshness.snapshotFreshMs,
    })
      ? 'fresh'
      : 'stale';
  }

  private hasFreshAccessEvidence(
    membership: RoutePreviewMembershipRow,
    nowMs: number,
    snapshotFreshMs: number,
  ): boolean {
    const snapshot = normalizeMembershipAccessSnapshot(membership.permissionsSnapshot);
    if (isFreshMembershipAccessSnapshot(snapshot, { nowMs, freshMs: snapshotFreshMs })) {
      return true;
    }
    const checkedAt = this.toIsoStringOrNull(membership.botAccessCheckedAt);
    if (!checkedAt) {
      return false;
    }
    const checkedAtMs = Date.parse(checkedAt);
    return (
      Number.isFinite(checkedAtMs) && checkedAtMs <= nowMs && checkedAtMs + snapshotFreshMs > nowMs
    );
  }

  private membershipHasDeniedAccess(membership: RoutePreviewMembershipRow): boolean {
    return (
      membership.botAccessState === ChatBotAccessState.DENIED ||
      membership.botAccessState === ChatBotAccessState.LOST ||
      membershipExplicitlyLacksAccess(membership.permissionsSnapshot)
    );
  }

  private normalizeBotCapabilities(value: unknown): ManagedEntityBotCapability[] {
    if (!Array.isArray(value)) {
      return [];
    }
    return Array.from(
      new Set(
        value
          .map((item) => (typeof item === 'string' ? item.trim() : ''))
          .filter((item): item is ManagedEntityBotCapability =>
            BOT_ROUTE_PREVIEW_CAPABILITIES.includes(item as ManagedEntityBotCapability),
          ),
      ),
    );
  }

  private async readPrimaryCounts(botIds: readonly string[]): Promise<PrimaryCountRow[]> {
    if (botIds.length === 0) {
      return [];
    }

    const rows = await this.prisma.chat.groupBy({
      by: ['primaryBotId', 'entityType'],
      where: {
        primaryBotId: { in: [...botIds] },
        OR: [
          { catalogKind: ChatCatalogKind.MANAGED },
          {
            catalogKind: ChatCatalogKind.UNKNOWN,
            entityType: ChatEntityType.CHANNEL,
          },
        ],
      },
      _count: {
        _all: true,
      },
    });

    return rows.map((row) => ({
      primaryBotId: row.primaryBotId,
      entityType: row.entityType,
      _count: {
        _all: row._count._all,
      },
    }));
  }

  private async readMembershipAggregates(
    botIds: readonly string[],
  ): Promise<MembershipAggregateRow[]> {
    if (botIds.length === 0) {
      return [];
    }

    return this.prisma.$queryRaw<MembershipAggregateRow[]>(Prisma.sql`
      SELECT
        m.bot_id AS "botId",
        m.role::text AS "role",
        m.status::text AS "status",
        m.bot_access_state::text AS "botAccessState",
        c.entity_type::text AS "entityType",
        (
          m.role = 'STANDBY'::"ChatBotMembershipRole"
          AND m.status = 'ACTIVE'::"ChatBotMembershipStatus"
          AND jsonb_typeof(m.capabilities::jsonb) = 'array'
          AND jsonb_array_length(m.capabilities::jsonb) > 0
        ) AS "isAssist",
        COUNT(*) AS "count"
      FROM chat_bot_memberships m
      INNER JOIN chats c ON c.id = m.chat_id
      WHERE
        m.bot_id IN (${Prisma.join(botIds)})
        AND (
          c.catalog_kind = 'MANAGED'::"ChatCatalogKind"
          OR (
            c.catalog_kind = 'UNKNOWN'::"ChatCatalogKind"
            AND c.entity_type = 'CHANNEL'::"ChatEntityType"
          )
        )
      GROUP BY
        m.bot_id,
        m.role,
        m.status,
        m.bot_access_state,
        c.entity_type,
        "isAssist"
    `);
  }

  private async readProblemSamples(botIds: readonly string[]): Promise<ProblemSampleRow[]> {
    if (botIds.length === 0) {
      return [];
    }

    return this.prisma.$queryRaw<ProblemSampleRow[]>(Prisma.sql`
      WITH ranked AS (
        SELECT
          m.bot_id AS "botId",
          c.id AS "chatId",
          c.title AS "title",
          c.entity_type::text AS "entityType",
          CASE
            WHEN (
              m.status = 'REMOVED'::"ChatBotMembershipStatus"
              AND COALESCE(m.permissions_snapshot::jsonb ? 'accessLostAt', false)
            ) THEN 'removed-after-loss'
            WHEN m.bot_access_state = 'LOST'::"ChatBotAccessState" THEN 'lost-access'
            WHEN m.bot_access_state = 'STALE'::"ChatBotAccessState" THEN 'stale-access'
            WHEN m.bot_access_state = 'DENIED'::"ChatBotAccessState" THEN 'denied-access'
            ELSE 'stale-access'
          END AS "kind",
          m.role::text AS "botRole",
          m.status::text AS "membershipStatus",
          m.bot_access_state::text AS "botAccessState",
          c.primary_bot_id AS "primaryBotId",
          m.bot_access_checked_at AS "checkedAt",
          m.last_seen_at AS "lastSeenAt",
          m.last_webhook_at AS "lastWebhookAt",
          c.updated_at AS "updatedAt",
          ROW_NUMBER() OVER (
            PARTITION BY m.bot_id
            ORDER BY
              CASE
                WHEN m.bot_access_state = 'LOST'::"ChatBotAccessState" THEN 4
                WHEN (
                  m.status = 'REMOVED'::"ChatBotMembershipStatus"
                  AND COALESCE(m.permissions_snapshot::jsonb ? 'accessLostAt', false)
                ) THEN 3
                WHEN m.bot_access_state = 'DENIED'::"ChatBotAccessState" THEN 2
                WHEN m.bot_access_state = 'STALE'::"ChatBotAccessState" THEN 1
                ELSE 0
              END DESC,
              COALESCE(m.bot_access_checked_at, m.updated_at, c.updated_at) DESC,
              c.id ASC
          ) AS rn
        FROM chat_bot_memberships m
        INNER JOIN chats c ON c.id = m.chat_id
        WHERE
          m.bot_id IN (${Prisma.join(botIds)})
          AND (
            c.catalog_kind = 'MANAGED'::"ChatCatalogKind"
            OR (
              c.catalog_kind = 'UNKNOWN'::"ChatCatalogKind"
              AND c.entity_type = 'CHANNEL'::"ChatEntityType"
            )
          )
          AND (
            m.bot_access_state IN (
              'DENIED'::"ChatBotAccessState",
              'LOST'::"ChatBotAccessState",
              'STALE'::"ChatBotAccessState"
            )
            OR (
              m.status = 'REMOVED'::"ChatBotMembershipStatus"
              AND COALESCE(m.permissions_snapshot::jsonb ? 'accessLostAt', false)
            )
          )
      )
      SELECT
        "botId",
        "chatId",
        "title",
        "entityType",
        "kind",
        "botRole",
        "membershipStatus",
        "botAccessState",
        "primaryBotId",
        "checkedAt",
        "lastSeenAt",
        "lastWebhookAt",
        "updatedAt"
      FROM ranked
      WHERE rn <= ${BOT_PROBLEM_SAMPLE_LIMIT}
      ORDER BY "botId" ASC, rn ASC
    `);
  }

  private createEmptyEntityCount(): SystemBotEntityCount {
    return {
      total: 0,
      chats: 0,
      channels: 0,
    };
  }

  private createEmptyEntityStats(): SystemBotManagedEntityStats {
    return {
      primary: this.createEmptyEntityCount(),
      standby: this.createEmptyEntityCount(),
      assist: this.createEmptyEntityCount(),
    };
  }

  private incrementEntityCount(
    target: SystemBotEntityCount,
    entityType: ChatEntityType | SystemBotEntityType,
    count: number,
  ): void {
    target.total += count;
    if (entityType === ChatEntityType.CHANNEL || entityType === 'channel') {
      target.channels += count;
      return;
    }
    target.chats += count;
  }

  private mapMaxApiLoad(snapshot: MaxApiBotRateLimitSnapshot | undefined): SystemBotMaxApiLoad {
    const background = snapshot?.trafficClasses.background;
    return {
      windowSec: snapshot?.windowSec ?? 60,
      totalRequests: snapshot?.totalRequests ?? 0,
      avgRps: snapshot?.avgRps ?? 0,
      peakRps: snapshot?.peakRps ?? 0,
      avgLoad: snapshot?.avgLoad ?? 0,
      peakLoad: snapshot?.peakLoad ?? 0,
      smoothedLoad: snapshot?.smoothedLoad ?? 0,
      background: {
        totalRequests: background?.totalRequests ?? 0,
        avgRps: background?.avgRps ?? 0,
        peakRps: background?.peakRps ?? 0,
      },
    };
  }

  private mapProblemSample(row: ProblemSampleRow): SystemBotProblemSample {
    return {
      chatId: row.chatId,
      title: row.title ?? row.chatId,
      entityType: this.mapEntityType(row.entityType),
      kind: this.mapProblemKind(row.kind),
      botRole: this.mapMembershipRole(row.botRole),
      membershipStatus: this.mapMembershipStatus(row.membershipStatus),
      botAccessState: this.mapAccessState(row.botAccessState),
      primaryBotId: row.primaryBotId,
      checkedAt: this.toIsoStringOrNull(row.checkedAt),
      lastSeenAt: this.toIsoStringOrNull(row.lastSeenAt),
      lastWebhookAt: this.toIsoStringOrNull(row.lastWebhookAt),
      updatedAt: this.toIsoString(row.updatedAt),
    };
  }

  private buildSummary(
    bots: Array<{
      lifecycleState: string;
      adminVisible: boolean;
      webhook: BotWebhookSubscriptionSnapshot | null;
      operationalDiagnostics: BotWebhookOperationalDiagnostics | null;
      entities: SystemBotManagedEntityStats;
      access: {
        lost: number;
        stale: number;
        denied: number;
      };
      problemSamples: readonly SystemBotProblemSample[];
    }>,
  ) {
    const summary = {
      total: bots.length,
      adminVisible: 0,
      active: 0,
      draining: 0,
      dormant: 0,
      disabled: 0,
      webhookWarningBotCount: 0,
      problemBotCount: 0,
      primaryEntities: this.createEmptyEntityCount(),
      standbyEntities: this.createEmptyEntityCount(),
      assistEntities: this.createEmptyEntityCount(),
      lostAccess: 0,
      staleAccess: 0,
      deniedAccess: 0,
    };

    for (const bot of bots) {
      if (bot.adminVisible) {
        summary.adminVisible += 1;
      }
      if (
        bot.lifecycleState === 'active' ||
        bot.lifecycleState === 'draining' ||
        bot.lifecycleState === 'dormant' ||
        bot.lifecycleState === 'disabled'
      ) {
        summary[bot.lifecycleState] += 1;
      }
      if (
        bot.webhook?.status === 'warning' ||
        bot.webhook?.status === 'critical' ||
        (bot.operationalDiagnostics?.issueCodes.length ?? 0) > 0
      ) {
        summary.webhookWarningBotCount += 1;
      }
      if (bot.problemSamples.length > 0) {
        summary.problemBotCount += 1;
      }
      this.addEntityCounts(summary.primaryEntities, bot.entities.primary);
      this.addEntityCounts(summary.standbyEntities, bot.entities.standby);
      this.addEntityCounts(summary.assistEntities, bot.entities.assist);
      summary.lostAccess += bot.access.lost;
      summary.staleAccess += bot.access.stale;
      summary.deniedAccess += bot.access.denied;
    }

    return summary;
  }

  private addEntityCounts(target: SystemBotEntityCount, source: SystemBotEntityCount): void {
    target.total += source.total;
    target.chats += source.chats;
    target.channels += source.channels;
  }

  private mapEntityType(value: string): SystemBotEntityType {
    return value === ChatEntityType.CHANNEL || value.toUpperCase() === ChatEntityType.CHANNEL
      ? 'channel'
      : 'chat';
  }

  private mapMembershipRole(value: string): SystemBotMembershipRole {
    return value === ChatBotMembershipRole.PRIMARY || value.toUpperCase() === 'PRIMARY'
      ? 'primary'
      : 'standby';
  }

  private mapMembershipStatus(value: string): SystemBotMembershipStatus {
    return value === ChatBotMembershipStatus.REMOVED || value.toUpperCase() === 'REMOVED'
      ? 'removed'
      : 'active';
  }

  private mapAccessState(value: string): SystemBotAccessState {
    switch (value) {
      case ChatBotAccessState.CONFIRMED_OWNER:
      case 'CONFIRMED_OWNER':
        return 'confirmed_owner';
      case ChatBotAccessState.CONFIRMED_ADMIN:
      case 'CONFIRMED_ADMIN':
        return 'confirmed_admin';
      case ChatBotAccessState.CONFIRMED_MEMBER:
      case 'CONFIRMED_MEMBER':
        return 'confirmed_member';
      case ChatBotAccessState.DENIED:
      case 'DENIED':
        return 'denied';
      case ChatBotAccessState.LOST:
      case 'LOST':
        return 'lost';
      case ChatBotAccessState.STALE:
      case 'STALE':
        return 'stale';
      case ChatBotAccessState.UNKNOWN:
      case 'UNKNOWN':
      default:
        return 'unknown';
    }
  }

  private mapProblemKind(value: string): SystemBotProblemKind {
    if (value === 'lost-access') {
      return 'lost-access';
    }
    if (value === 'denied-access') {
      return 'denied-access';
    }
    if (value === 'removed-after-loss') {
      return 'removed-after-loss';
    }
    return 'stale-access';
  }

  private toIsoStringOrNull(value: Date | string | null): string | null {
    return value ? this.toIsoString(value) : null;
  }

  private toIsoString(value: Date | string): string {
    return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
  }

  private toNumber(value: bigint | number): number {
    return typeof value === 'bigint' ? Number(value) : value;
  }
}
