import { Injectable } from '@nestjs/common';
import {
  systemBotsSnapshotSchema,
  type BotQueueMetricsSnapshot,
  type BotWebhookOperationalDiagnostics,
  type BotWebhookSubscriptionSnapshot,
  type SystemBotAccessState,
  type SystemBotEntityCount,
  type SystemBotEntityType,
  type SystemBotManagedEntityStats,
  type SystemBotMaxApiLoad,
  type SystemBotMembershipRole,
  type SystemBotMembershipStatus,
  type SystemBotProblemKind,
  type SystemBotProblemSample,
  type SystemBotsSnapshot,
} from '@maxim/contracts/system';
import { MaxBotRegistryService } from '../max/max-bot-registry.service';
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

@Injectable()
export class SystemBotsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly botRegistry: MaxBotRegistryService,
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
