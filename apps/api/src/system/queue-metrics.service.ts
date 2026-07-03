import { InjectQueue, getQueueToken } from '@nestjs/bullmq';
import { Injectable, Optional } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { Prisma, WebhookStatus } from '../prisma/prisma-client';
import type { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { ADMIN_MANAGED_ENTITIES_REFRESH_QUEUE } from '../admin/admin-managed-entities-refresh.queue';
import { ADMIN_MANUAL_FANOUT_QUEUE } from '../admin/admin-manual-fanout.queue';
import { ADMIN_SUGGESTION_DELIVERY_QUEUE } from '../admin/admin-suggestion-delivery.queue';
import { ADMIN_SUPER_BAN_QUEUE } from '../admin/admin-super-ban.queue';
import { VK_PARSING_PUBLISH_QUEUE, VK_PARSING_SYNC_QUEUE } from '../admin/vk-parsing.queue';
import { MAX_CHAT_ADMIN_ROSTER_SYNC_QUEUE } from '../max/max-chat-admin-roster-sync.queue';
import { MaxBotRegistryService } from '../max/max-bot-registry.service';
import { GLOBAL_SPAMMER_DENORM_QUEUE } from '../moderation/global-spammer-denorm.queue';
import { NIGHT_MODE_TRANSITION_QUEUE } from '../moderation/night-mode-transition.queue';
import {
  DEFAULT_WEBHOOK_WORKER_GROUP_NAMES,
  getDefaultWebhookHomeOwnerByQueue,
  getDefaultWebhookWorkerGroupQueues,
  type DefaultWebhookWorkerGroupName,
} from '../runtime/moderation-runtime';
import type { DefaultWebhookLeaseSummary } from '../runtime/default-webhook-dynamic-leases';
import { ActionHealthService, type ActionHealthSnapshot } from './action-health.service';
import { WebhookDynamicLeaseStatusService } from './webhook-dynamic-lease-status.service';
import {
  DEFAULT_WEBHOOK_QUEUE_NAMES,
  type DefaultWebhookQueueName,
  JOIN_WEBHOOK_QUEUE_NAMES,
  type JoinWebhookQueueName,
  LEGACY_WEBHOOK_QUEUE,
  WEBHOOK_QUEUE_BACKGROUND,
  WEBHOOK_QUEUE_CRITICAL,
} from '../webhook/webhook-queues';

export type QueueCounters = {
  waiting: number;
  prioritized: number;
  active: number;
  delayed: number;
  failed: number;
  completed: number;
};

export const AUXILIARY_QUEUE_NAMES = [
  ADMIN_MANAGED_ENTITIES_REFRESH_QUEUE,
  VK_PARSING_SYNC_QUEUE,
  VK_PARSING_PUBLISH_QUEUE,
  NIGHT_MODE_TRANSITION_QUEUE,
  MAX_CHAT_ADMIN_ROSTER_SYNC_QUEUE,
  ADMIN_MANUAL_FANOUT_QUEUE,
  ADMIN_SUPER_BAN_QUEUE,
  ADMIN_SUGGESTION_DELIVERY_QUEUE,
] as const;
export type AuxiliaryQueueName = (typeof AUXILIARY_QUEUE_NAMES)[number];

export type WebhookStatusMetrics = {
  count: number;
  oldestEventId: string | null;
  oldestCreatedAt: string | null;
  oldestLagSec: number;
  activeCount?: number;
  staleCount?: number;
  activeWindowSec?: number;
};

export type WebhookDefaultWorkerGroupMetrics = {
  queues: DefaultWebhookQueueName[];
  counters: QueueCounters;
};

export type WebhookDynamicLeaseQueueMetrics = {
  homeOwner: DefaultWebhookWorkerGroupName;
  actualOwner: DefaultWebhookWorkerGroupName;
  desiredOwner: DefaultWebhookWorkerGroupName;
  eligibleForDynamicLeases: boolean;
  handoffPending: boolean;
  activeJobs: number;
  pressure: number;
  reason: string;
  claimFencingToken: number | null;
  claimLeaseUntil: string | null;
  lastHandoffAt: string | null;
};

export type WebhookDynamicLeaseMetricsSnapshot = {
  mode: DefaultWebhookLeaseSummary['mode'];
  generatedAt: string;
  liveWorkerGroups: DefaultWebhookWorkerGroupName[];
  queues: Record<DefaultWebhookQueueName, WebhookDynamicLeaseQueueMetrics>;
};

export type BotQueueMetricsSnapshot = {
  webhookEvents: {
    received: WebhookStatusMetrics;
    queued: WebhookStatusMetrics;
    failed: WebhookStatusMetrics;
  };
  userFacingWebhookEvents: {
    received: WebhookStatusMetrics;
    queued: WebhookStatusMetrics;
    failed: WebhookStatusMetrics;
  };
  queuedByQueue: Record<string, number>;
  actionHealth: ActionHealthSnapshot;
  oldestQueuedEventId: string | null;
  oldestQueuedCreatedAt: string | null;
  oldestQueuedLagSec: number;
  oldestReceivedEventId: string | null;
  oldestReceivedCreatedAt: string | null;
  oldestReceivedLagSec: number;
  effectiveLagSec: number;
  userFacingOldestQueuedEventId: string | null;
  userFacingOldestQueuedCreatedAt: string | null;
  userFacingOldestQueuedLagSec: number;
  userFacingOldestReceivedEventId: string | null;
  userFacingOldestReceivedCreatedAt: string | null;
  userFacingOldestReceivedLagSec: number;
  userFacingEffectiveLagSec: number;
};

export type QueueMetricsSnapshot = {
  moderation: QueueCounters;
  webhookCritical: QueueCounters;
  webhookJoin: QueueCounters;
  webhookJoinShards: Record<JoinWebhookQueueName, QueueCounters>;
  webhookDefault: QueueCounters;
  webhookDefaultShards: Record<DefaultWebhookQueueName, QueueCounters>;
  webhookDefaultWorkerGroups: Record<
    DefaultWebhookWorkerGroupName,
    WebhookDefaultWorkerGroupMetrics
  >;
  webhookBackground: QueueCounters;
  webhookLegacy: QueueCounters;
  actions: QueueCounters;
  globalSpammerDenorm: QueueCounters;
  auxiliaryQueues: Record<AuxiliaryQueueName, QueueCounters>;
  webhookEvents: {
    received: WebhookStatusMetrics;
    queued: WebhookStatusMetrics;
    failed: WebhookStatusMetrics;
  };
  userFacingWebhookEvents: {
    received: WebhookStatusMetrics;
    queued: WebhookStatusMetrics;
    failed: WebhookStatusMetrics;
  };
  actionHealth: ActionHealthSnapshot;
  webhookDynamicLeases: WebhookDynamicLeaseMetricsSnapshot | null;
  bots: Record<string, BotQueueMetricsSnapshot>;
  oldestQueuedEventId: string | null;
  oldestQueuedCreatedAt: string | null;
  oldestQueuedLagSec: number;
  oldestReceivedEventId: string | null;
  oldestReceivedCreatedAt: string | null;
  oldestReceivedLagSec: number;
  effectiveLagSec: number;
  userFacingOldestQueuedEventId: string | null;
  userFacingOldestQueuedCreatedAt: string | null;
  userFacingOldestQueuedLagSec: number;
  userFacingOldestReceivedEventId: string | null;
  userFacingOldestReceivedCreatedAt: string | null;
  userFacingOldestReceivedLagSec: number;
  userFacingEffectiveLagSec: number;
  generatedAt: string;
};

export type WebhookDefaultShardSnapshot = {
  webhookDefaultShards: Record<DefaultWebhookQueueName, QueueCounters>;
  webhookDefaultWorkerGroups: Record<
    DefaultWebhookWorkerGroupName,
    WebhookDefaultWorkerGroupMetrics
  >;
  generatedAt: string;
};

type QueueMetricsSnapshotOptions = {
  maxAgeMs?: number;
};

const EMPTY_COUNTERS: QueueCounters = {
  waiting: 0,
  prioritized: 0,
  active: 0,
  delayed: 0,
  failed: 0,
  completed: 0,
};

const EMPTY_WEBHOOK_STATUS_METRICS: WebhookStatusMetrics = {
  count: 0,
  oldestEventId: null,
  oldestCreatedAt: null,
  oldestLagSec: 0,
};
const ACTIVE_FAILED_WEBHOOK_WINDOW_SEC = 6 * 60 * 60;
const USER_FACING_WEBHOOK_TYPES = [
  'message_created',
  'message_callback',
  'bot_started',
  'bot_added',
] as const;

@Injectable()
export class QueueMetricsService {
  private snapshotCache: QueueMetricsSnapshot | null = null;
  private snapshotCacheAtMs = 0;
  private snapshotPromise: Promise<QueueMetricsSnapshot> | null = null;
  private defaultShardSnapshotCache: WebhookDefaultShardSnapshot | null = null;
  private defaultShardSnapshotCacheAtMs = 0;
  private defaultShardSnapshotPromise: Promise<WebhookDefaultShardSnapshot> | null = null;
  private readonly webhookJoinQueuesByName: Record<JoinWebhookQueueName, Queue | undefined>;
  private readonly webhookDefaultQueuesByName: Record<DefaultWebhookQueueName, Queue | undefined>;
  private readonly auxiliaryQueuesByName: Record<AuxiliaryQueueName, Queue | undefined>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly actionHealthService: ActionHealthService,
    private readonly moduleRef: ModuleRef,
    private readonly maxBotRegistry: MaxBotRegistryService,
    @Optional()
    private readonly webhookDynamicLeaseStatusService?: WebhookDynamicLeaseStatusService,
    @Optional() @InjectQueue(WEBHOOK_QUEUE_CRITICAL) private readonly webhookCriticalQueue?: Queue,
    @Optional()
    @InjectQueue(WEBHOOK_QUEUE_BACKGROUND)
    private readonly webhookBackgroundQueue?: Queue,
    @Optional() @InjectQueue(LEGACY_WEBHOOK_QUEUE) private readonly webhookLegacyQueue?: Queue,
    @Optional() @InjectQueue('moderation-actions') private readonly actionQueue?: Queue,
    @Optional()
    @InjectQueue(GLOBAL_SPAMMER_DENORM_QUEUE)
    private readonly globalSpammerDenormQueue?: Queue,
  ) {
    this.webhookJoinQueuesByName = Object.fromEntries(
      JOIN_WEBHOOK_QUEUE_NAMES.map((queueName) => [
        queueName,
        this.resolveOptionalQueue(queueName),
      ]),
    ) as Record<JoinWebhookQueueName, Queue | undefined>;
    this.webhookDefaultQueuesByName = Object.fromEntries(
      DEFAULT_WEBHOOK_QUEUE_NAMES.map((queueName) => [
        queueName,
        this.resolveOptionalQueue(queueName),
      ]),
    ) as Record<DefaultWebhookQueueName, Queue | undefined>;
    this.auxiliaryQueuesByName = Object.fromEntries(
      AUXILIARY_QUEUE_NAMES.map((queueName) => [queueName, this.resolveOptionalQueue(queueName)]),
    ) as Record<AuxiliaryQueueName, Queue | undefined>;
  }

  private resolveOptionalQueue(queueName: string): Queue | undefined {
    try {
      return this.moduleRef.get<Queue>(getQueueToken(queueName), { strict: false });
    } catch {
      return undefined;
    }
  }

  async getSnapshot(options: QueueMetricsSnapshotOptions = {}): Promise<QueueMetricsSnapshot> {
    const maxAgeMs = options.maxAgeMs ?? 0;
    const cachedSnapshot = this.getCachedSnapshot(maxAgeMs);
    if (cachedSnapshot) {
      return cachedSnapshot;
    }

    if (this.snapshotPromise) {
      return this.snapshotPromise;
    }

    this.snapshotPromise = this.buildSnapshot();

    try {
      const snapshot = await this.snapshotPromise;
      this.snapshotCache = snapshot;
      this.snapshotCacheAtMs = Date.now();
      return snapshot;
    } finally {
      this.snapshotPromise = null;
    }
  }

  peekCachedSnapshot(maxAgeMs = Number.POSITIVE_INFINITY): QueueMetricsSnapshot | null {
    return this.getCachedSnapshot(maxAgeMs);
  }

  async getWebhookDefaultShardSnapshot(
    options: QueueMetricsSnapshotOptions = {},
  ): Promise<WebhookDefaultShardSnapshot> {
    const maxAgeMs = options.maxAgeMs ?? 0;
    const cachedSnapshot = this.getCachedDefaultShardSnapshot(maxAgeMs);
    if (cachedSnapshot) {
      return cachedSnapshot;
    }

    if (this.defaultShardSnapshotPromise) {
      return this.defaultShardSnapshotPromise;
    }

    this.defaultShardSnapshotPromise = this.buildWebhookDefaultShardSnapshot();

    try {
      const snapshot = await this.defaultShardSnapshotPromise;
      this.setDefaultShardSnapshotCache(snapshot);
      return snapshot;
    } finally {
      this.defaultShardSnapshotPromise = null;
    }
  }

  private getCachedSnapshot(maxAgeMs: number): QueueMetricsSnapshot | null {
    if (!this.snapshotCache || maxAgeMs <= 0) {
      return null;
    }

    if (Date.now() - this.snapshotCacheAtMs > maxAgeMs) {
      return null;
    }

    return this.snapshotCache;
  }

  private getCachedDefaultShardSnapshot(maxAgeMs: number): WebhookDefaultShardSnapshot | null {
    if (!this.defaultShardSnapshotCache || maxAgeMs <= 0) {
      return null;
    }

    if (Date.now() - this.defaultShardSnapshotCacheAtMs > maxAgeMs) {
      return null;
    }

    return this.defaultShardSnapshotCache;
  }

  private setDefaultShardSnapshotCache(snapshot: WebhookDefaultShardSnapshot): void {
    this.defaultShardSnapshotCache = snapshot;
    this.defaultShardSnapshotCacheAtMs = Date.now();
  }

  private async buildSnapshot(): Promise<QueueMetricsSnapshot> {
    const botIds = (
      typeof this.maxBotRegistry.getOperationalBots === 'function'
        ? this.maxBotRegistry.getOperationalBots()
        : typeof this.maxBotRegistry.getAllBots === 'function'
          ? this.maxBotRegistry.getAllBots()
          : []
    ).map((bot) => bot.id);
    await this.actionHealthService.refreshSnapshots(60, botIds);
    const dynamicLeaseSummary = this.webhookDynamicLeaseStatusService
      ? await this.webhookDynamicLeaseStatusService.getSummary(2_000)
      : null;
    const defaultShardSnapshot = await this.buildWebhookDefaultShardSnapshot(dynamicLeaseSummary);
    this.setDefaultShardSnapshotCache(defaultShardSnapshot);

    const queueSnapshots = await Promise.all([
      this.readQueueCounters(this.webhookCriticalQueue),
      ...JOIN_WEBHOOK_QUEUE_NAMES.map((queueName) =>
        this.readQueueCounters(this.webhookJoinQueuesByName[queueName]),
      ),
      this.readQueueCounters(this.webhookBackgroundQueue),
      this.readQueueCounters(this.webhookLegacyQueue),
      this.readQueueCounters(this.actionQueue),
      this.readQueueCounters(this.globalSpammerDenormQueue),
      ...AUXILIARY_QUEUE_NAMES.map((queueName) =>
        this.readQueueCounters(this.auxiliaryQueuesByName[queueName]),
      ),
    ]);
    const [received, queued, failed, userFacingReceived, userFacingQueued, userFacingFailed] =
      await Promise.all([
        this.readWebhookStatusMetrics(WebhookStatus.RECEIVED),
        this.readWebhookStatusMetrics(WebhookStatus.QUEUED),
        this.readWebhookStatusMetrics(WebhookStatus.FAILED),
        this.readWebhookStatusMetricsByTypes(WebhookStatus.RECEIVED, USER_FACING_WEBHOOK_TYPES),
        this.readWebhookStatusMetricsByTypes(WebhookStatus.QUEUED, USER_FACING_WEBHOOK_TYPES),
        this.readWebhookStatusMetricsByTypes(WebhookStatus.FAILED, USER_FACING_WEBHOOK_TYPES),
      ]);
    const bots = await this.buildPerBotSnapshots(botIds);

    const [webhookCritical, ...restSnapshots] = queueSnapshots;
    const webhookJoinShardSnapshots = restSnapshots.slice(0, JOIN_WEBHOOK_QUEUE_NAMES.length);
    const webhookJoinShards = Object.fromEntries(
      JOIN_WEBHOOK_QUEUE_NAMES.map((queueName, index) => [
        queueName,
        webhookJoinShardSnapshots[index] ?? { ...EMPTY_COUNTERS },
      ]),
    ) as Record<JoinWebhookQueueName, QueueCounters>;
    const webhookJoin = this.sumQueueCounters(...Object.values(webhookJoinShards));
    const defaultSnapshotOffset = JOIN_WEBHOOK_QUEUE_NAMES.length;
    const webhookBackground = restSnapshots[defaultSnapshotOffset] ?? EMPTY_COUNTERS;
    const webhookLegacy = restSnapshots[defaultSnapshotOffset + 1] ?? EMPTY_COUNTERS;
    const actions = restSnapshots[defaultSnapshotOffset + 2] ?? EMPTY_COUNTERS;
    const globalSpammerDenorm = restSnapshots[defaultSnapshotOffset + 3] ?? EMPTY_COUNTERS;
    const auxiliaryQueueSnapshotOffset = defaultSnapshotOffset + 4;
    const auxiliaryQueues = Object.fromEntries(
      AUXILIARY_QUEUE_NAMES.map((queueName, index) => [
        queueName,
        restSnapshots[auxiliaryQueueSnapshotOffset + index] ?? { ...EMPTY_COUNTERS },
      ]),
    ) as Record<AuxiliaryQueueName, QueueCounters>;
    const webhookDefaultShards = defaultShardSnapshot.webhookDefaultShards;
    const webhookDefault = this.sumQueueCounters(...Object.values(webhookDefaultShards));
    const webhookDefaultWorkerGroups = defaultShardSnapshot.webhookDefaultWorkerGroups;

    const actionHealth = this.actionHealthService.getSnapshot(60);
    const oldestQueuedLagSec = queued.oldestLagSec;
    const oldestReceivedLagSec = received.oldestLagSec;
    const effectiveLagSec = Math.max(oldestQueuedLagSec, oldestReceivedLagSec);
    const userFacingOldestQueuedLagSec = userFacingQueued.oldestLagSec;
    const userFacingOldestReceivedLagSec = userFacingReceived.oldestLagSec;
    const userFacingEffectiveLagSec = Math.max(
      userFacingOldestQueuedLagSec,
      userFacingOldestReceivedLagSec,
    );
    const moderation = this.sumQueueCounters(
      webhookCritical,
      webhookJoin,
      webhookDefault,
      webhookBackground,
      webhookLegacy,
    );

    return {
      moderation,
      webhookCritical,
      webhookJoin,
      webhookJoinShards,
      webhookDefault,
      webhookDefaultShards,
      webhookDefaultWorkerGroups,
      webhookBackground,
      webhookLegacy,
      actions,
      globalSpammerDenorm,
      auxiliaryQueues,
      webhookEvents: {
        received,
        queued,
        failed,
      },
      userFacingWebhookEvents: {
        received: userFacingReceived,
        queued: userFacingQueued,
        failed: userFacingFailed,
      },
      actionHealth,
      webhookDynamicLeases: dynamicLeaseSummary
        ? {
            mode: dynamicLeaseSummary.mode,
            generatedAt: dynamicLeaseSummary.generatedAt,
            liveWorkerGroups: [...dynamicLeaseSummary.liveWorkerGroups],
            queues: dynamicLeaseSummary.queues,
          }
        : null,
      bots,
      oldestQueuedEventId: queued.oldestEventId,
      oldestQueuedCreatedAt: queued.oldestCreatedAt,
      oldestQueuedLagSec,
      oldestReceivedEventId: received.oldestEventId,
      oldestReceivedCreatedAt: received.oldestCreatedAt,
      oldestReceivedLagSec,
      effectiveLagSec,
      userFacingOldestQueuedEventId: userFacingQueued.oldestEventId,
      userFacingOldestQueuedCreatedAt: userFacingQueued.oldestCreatedAt,
      userFacingOldestQueuedLagSec,
      userFacingOldestReceivedEventId: userFacingReceived.oldestEventId,
      userFacingOldestReceivedCreatedAt: userFacingReceived.oldestCreatedAt,
      userFacingOldestReceivedLagSec,
      userFacingEffectiveLagSec,
      generatedAt: new Date().toISOString(),
    };
  }

  private async buildWebhookDefaultShardSnapshot(
    dynamicLeaseSummary?: DefaultWebhookLeaseSummary | null,
  ): Promise<WebhookDefaultShardSnapshot> {
    const resolvedDynamicLeaseSummary =
      dynamicLeaseSummary !== undefined
        ? dynamicLeaseSummary
        : this.webhookDynamicLeaseStatusService
          ? await this.webhookDynamicLeaseStatusService.getSummary(2_000)
          : null;
    const webhookDefaultShardSnapshots = await Promise.all(
      DEFAULT_WEBHOOK_QUEUE_NAMES.map((queueName) =>
        this.readQueueCounters(this.webhookDefaultQueuesByName[queueName]),
      ),
    );
    const webhookDefaultShards = Object.fromEntries(
      DEFAULT_WEBHOOK_QUEUE_NAMES.map((queueName, index) => [
        queueName,
        webhookDefaultShardSnapshots[index] ?? { ...EMPTY_COUNTERS },
      ]),
    ) as Record<DefaultWebhookQueueName, QueueCounters>;

    return {
      webhookDefaultShards,
      webhookDefaultWorkerGroups: this.buildWebhookDefaultWorkerGroups(
        webhookDefaultShards,
        resolvedDynamicLeaseSummary ?? null,
      ),
      generatedAt: new Date().toISOString(),
    };
  }

  private async readQueueCounters(queue?: Queue): Promise<QueueCounters> {
    if (!queue) {
      return EMPTY_COUNTERS;
    }

    const [waiting, prioritized, active, delayed, failed, completed] = await Promise.all([
      queue.getWaitingCount(),
      queue.getPrioritizedCount(),
      queue.getActiveCount(),
      queue.getDelayedCount(),
      queue.getFailedCount(),
      queue.getCompletedCount(),
    ]);

    return { waiting, prioritized, active, delayed, failed, completed };
  }

  private sumQueueCounters(...counters: QueueCounters[]): QueueCounters {
    return counters.reduce<QueueCounters>(
      (total, current) => ({
        waiting: total.waiting + current.waiting,
        prioritized: total.prioritized + current.prioritized,
        active: total.active + current.active,
        delayed: total.delayed + current.delayed,
        failed: total.failed + current.failed,
        completed: total.completed + current.completed,
      }),
      { ...EMPTY_COUNTERS },
    );
  }

  private buildWebhookDefaultWorkerGroups(
    webhookDefaultShards: Record<DefaultWebhookQueueName, QueueCounters>,
    dynamicLeaseSummary: DefaultWebhookLeaseSummary | null,
  ): Record<DefaultWebhookWorkerGroupName, WebhookDefaultWorkerGroupMetrics> {
    const workerGroupQueues = dynamicLeaseSummary
      ? this.buildWorkerGroupQueuesFromLeaseSummary(dynamicLeaseSummary)
      : getDefaultWebhookWorkerGroupQueues();

    return Object.fromEntries(
      DEFAULT_WEBHOOK_WORKER_GROUP_NAMES.map((groupName) => {
        const queues = [...workerGroupQueues[groupName]];
        return [
          groupName,
          {
            queues,
            counters: this.sumQueueCounters(
              ...queues.map(
                (queueName) => webhookDefaultShards[queueName] ?? { ...EMPTY_COUNTERS },
              ),
            ),
          },
        ];
      }),
    ) as Record<DefaultWebhookWorkerGroupName, WebhookDefaultWorkerGroupMetrics>;
  }

  private buildWorkerGroupQueuesFromLeaseSummary(
    dynamicLeaseSummary: DefaultWebhookLeaseSummary,
  ): Record<DefaultWebhookWorkerGroupName, DefaultWebhookQueueName[]> {
    const queuesByGroup = Object.fromEntries(
      DEFAULT_WEBHOOK_WORKER_GROUP_NAMES.map((groupName) => [
        groupName,
        [] as DefaultWebhookQueueName[],
      ]),
    ) as Record<DefaultWebhookWorkerGroupName, DefaultWebhookQueueName[]>;
    const homeOwnerByQueue = getDefaultWebhookHomeOwnerByQueue();

    for (const queueName of DEFAULT_WEBHOOK_QUEUE_NAMES) {
      const entry = dynamicLeaseSummary.queues[queueName];
      const owner = entry?.actualOwner ?? homeOwnerByQueue[queueName];
      queuesByGroup[owner].push(queueName);
    }

    return queuesByGroup;
  }

  private async readWebhookStatusMetrics(status: WebhookStatus): Promise<WebhookStatusMetrics> {
    return this.readWebhookStatusMetricsForBot(status, null);
  }

  private async readWebhookStatusMetricsByTypes(
    status: WebhookStatus,
    types: readonly string[],
    botId: string | null = null,
  ): Promise<WebhookStatusMetrics> {
    if (types.length === 0) {
      return { ...EMPTY_WEBHOOK_STATUS_METRICS };
    }

    if (typeof this.prisma.$queryRaw !== 'function') {
      return this.readWebhookStatusMetricsForBot(status, botId);
    }

    const normalizedBotId = typeof botId === 'string' ? botId.trim() : '';
    const activeFailedCutoff = new Date(Date.now() - ACTIVE_FAILED_WEBHOOK_WINDOW_SEC * 1_000);
    const statusCondition = Prisma.raw(`'${status}'::"WebhookStatus"`);
    const conditions: Prisma.Sql[] = [Prisma.sql`"status" = ${statusCondition}`];
    if (normalizedBotId) {
      if (normalizedBotId === this.maxBotRegistry.getDefaultBot().id) {
        conditions.push(Prisma.sql`("bot_id" = ${normalizedBotId} OR "bot_id" IS NULL)`);
      } else {
        conditions.push(Prisma.sql`"bot_id" = ${normalizedBotId}`);
      }
    }
    conditions.push(
      Prisma.sql`COALESCE("normalized_payload"->>'type', '') IN (${Prisma.join(types)})`,
    );

    const rows = await this.prisma.$queryRaw<
      Array<{
        count: bigint | number;
        activeCount?: bigint | number;
        oldestEventId: string | null;
        oldestCreatedAt: Date | null;
      }>
    >(Prisma.sql`
      WITH filtered AS (
        SELECT id, created_at
        FROM webhook_events
        WHERE ${Prisma.join(conditions, ' AND ')}
      )
      SELECT
        COUNT(*)::bigint AS count,
        ${
          status === WebhookStatus.FAILED
            ? Prisma.sql`COUNT(*) FILTER (WHERE created_at >= ${activeFailedCutoff})::bigint AS "activeCount",`
            : Prisma.sql``
        }
        (
          SELECT id
          FROM filtered
          ORDER BY created_at ASC
          LIMIT 1
        ) AS "oldestEventId",
        (
          SELECT created_at
          FROM filtered
          ORDER BY created_at ASC
          LIMIT 1
        ) AS "oldestCreatedAt"
      FROM filtered
    `);
    const row = rows[0];
    const count =
      typeof row?.count === 'bigint'
        ? Number(row.count)
        : typeof row?.count === 'number'
          ? row.count
          : 0;
    const activeCount =
      status === WebhookStatus.FAILED
        ? typeof row?.activeCount === 'bigint'
          ? Number(row.activeCount)
          : typeof row?.activeCount === 'number'
            ? row.activeCount
            : 0
        : undefined;

    if (!row?.oldestCreatedAt) {
      const metrics: WebhookStatusMetrics = {
        ...EMPTY_WEBHOOK_STATUS_METRICS,
        count,
      };
      return status === WebhookStatus.FAILED
        ? this.decorateFailedWebhookMetrics(metrics, activeCount ?? 0)
        : metrics;
    }

    const metrics: WebhookStatusMetrics = {
      count,
      oldestEventId: row.oldestEventId ?? null,
      oldestCreatedAt: row.oldestCreatedAt.toISOString(),
      oldestLagSec: Math.max(0, (Date.now() - row.oldestCreatedAt.getTime()) / 1_000),
    };
    return status === WebhookStatus.FAILED
      ? this.decorateFailedWebhookMetrics(metrics, activeCount ?? 0)
      : metrics;
  }

  private async buildPerBotSnapshots(
    botIds: readonly string[],
  ): Promise<Record<string, BotQueueMetricsSnapshot>> {
    const snapshots = await Promise.all(
      botIds.map(async (botId) => {
        const [
          received,
          queued,
          failed,
          userFacingReceived,
          userFacingQueued,
          userFacingFailed,
          queuedByQueue,
        ] = await Promise.all([
          this.readWebhookStatusMetricsForBot(WebhookStatus.RECEIVED, botId),
          this.readWebhookStatusMetricsForBot(WebhookStatus.QUEUED, botId),
          this.readWebhookStatusMetricsForBot(WebhookStatus.FAILED, botId),
          this.readWebhookStatusMetricsByTypes(
            WebhookStatus.RECEIVED,
            USER_FACING_WEBHOOK_TYPES,
            botId,
          ),
          this.readWebhookStatusMetricsByTypes(
            WebhookStatus.QUEUED,
            USER_FACING_WEBHOOK_TYPES,
            botId,
          ),
          this.readWebhookStatusMetricsByTypes(
            WebhookStatus.FAILED,
            USER_FACING_WEBHOOK_TYPES,
            botId,
          ),
          this.readQueuedByQueue(botId),
        ]);
        const oldestQueuedLagSec = queued.oldestLagSec;
        const oldestReceivedLagSec = received.oldestLagSec;
        const userFacingOldestQueuedLagSec = userFacingQueued.oldestLagSec;
        const userFacingOldestReceivedLagSec = userFacingReceived.oldestLagSec;
        const actionHealth =
          typeof this.actionHealthService.getCombinedSnapshot === 'function'
            ? this.actionHealthService.getCombinedSnapshot(60, ['critical', 'interactive'], botId)
            : this.actionHealthService.getSnapshot(60, botId);

        return [
          botId,
          {
            webhookEvents: {
              received,
              queued,
              failed,
            },
            userFacingWebhookEvents: {
              received: userFacingReceived,
              queued: userFacingQueued,
              failed: userFacingFailed,
            },
            queuedByQueue,
            actionHealth,
            oldestQueuedEventId: queued.oldestEventId,
            oldestQueuedCreatedAt: queued.oldestCreatedAt,
            oldestQueuedLagSec,
            oldestReceivedEventId: received.oldestEventId,
            oldestReceivedCreatedAt: received.oldestCreatedAt,
            oldestReceivedLagSec,
            effectiveLagSec: Math.max(oldestQueuedLagSec, oldestReceivedLagSec),
            userFacingOldestQueuedEventId: userFacingQueued.oldestEventId,
            userFacingOldestQueuedCreatedAt: userFacingQueued.oldestCreatedAt,
            userFacingOldestQueuedLagSec,
            userFacingOldestReceivedEventId: userFacingReceived.oldestEventId,
            userFacingOldestReceivedCreatedAt: userFacingReceived.oldestCreatedAt,
            userFacingOldestReceivedLagSec,
            userFacingEffectiveLagSec: Math.max(
              userFacingOldestQueuedLagSec,
              userFacingOldestReceivedLagSec,
            ),
          } satisfies BotQueueMetricsSnapshot,
        ] as const;
      }),
    );

    return Object.fromEntries(snapshots);
  }

  private async readWebhookStatusMetricsForBot(
    status: WebhookStatus,
    botId: string | null,
  ): Promise<WebhookStatusMetrics> {
    const where = this.buildWebhookStatusWhere(status, botId);
    const activeFailedCutoff = new Date(Date.now() - ACTIVE_FAILED_WEBHOOK_WINDOW_SEC * 1_000);
    const [count, oldestEvent, activeCount] = await Promise.all([
      this.prisma.webhookEvent.count({
        where,
      }),
      this.prisma.webhookEvent.findFirst({
        where,
        orderBy: { createdAt: 'asc' },
        select: { id: true, createdAt: true },
      }),
      status === WebhookStatus.FAILED
        ? this.prisma.webhookEvent.count({
            where: {
              ...where,
              createdAt: {
                gte: activeFailedCutoff,
              },
            },
          })
        : Promise.resolve(undefined),
    ]);

    if (!oldestEvent) {
      const metrics: WebhookStatusMetrics = {
        ...EMPTY_WEBHOOK_STATUS_METRICS,
        count,
      };
      return status === WebhookStatus.FAILED
        ? this.decorateFailedWebhookMetrics(metrics, activeCount ?? 0)
        : metrics;
    }

    const oldestLagSec = Math.max(0, (Date.now() - oldestEvent.createdAt.getTime()) / 1_000);
    const metrics: WebhookStatusMetrics = {
      count,
      oldestEventId: oldestEvent.id,
      oldestCreatedAt: oldestEvent.createdAt.toISOString(),
      oldestLagSec,
    };
    return status === WebhookStatus.FAILED
      ? this.decorateFailedWebhookMetrics(metrics, activeCount ?? 0)
      : metrics;
  }

  private decorateFailedWebhookMetrics(
    metrics: WebhookStatusMetrics,
    activeCount: number,
  ): WebhookStatusMetrics {
    return {
      ...metrics,
      activeCount,
      activeWindowSec: ACTIVE_FAILED_WEBHOOK_WINDOW_SEC,
      ...(metrics.count > activeCount
        ? {
            staleCount: Math.max(0, metrics.count - activeCount),
          }
        : {}),
    };
  }

  private async readQueuedByQueue(botId: string): Promise<Record<string, number>> {
    const rows = await this.prisma.webhookEvent.groupBy({
      by: ['queueName'],
      where: {
        ...this.buildWebhookStatusWhere(WebhookStatus.QUEUED, botId),
        queueName: {
          not: null,
        },
      },
      _count: {
        _all: true,
      },
    });

    return Object.fromEntries(
      rows
        .map((row) => [row.queueName, row._count._all] as const)
        .filter((entry): entry is [string, number] => typeof entry[0] === 'string'),
    );
  }

  private buildWebhookStatusWhere(status: WebhookStatus, botId: string | null) {
    if (!botId) {
      return { status };
    }

    if (botId === this.maxBotRegistry.getDefaultBot().id) {
      return {
        status,
        OR: [{ botId }, { botId: null }],
      };
    }

    return {
      status,
      botId,
    };
  }
}
