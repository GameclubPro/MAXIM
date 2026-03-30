import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, WebhookStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  getDefaultWebhookWorkerGroupQueues,
  type DefaultWebhookWorkerGroupName,
} from '../runtime/moderation-runtime';
import { QueueMetricsService } from '../system/queue-metrics.service';
import {
  DEFAULT_WEBHOOK_QUEUE_NAMES,
  type ActiveWebhookQueueName,
  type DefaultWebhookQueueName,
  extractWebhookChatId,
  extractWebhookType,
  resolveDefaultWebhookQueueIndexForChatId,
  resolveDefaultWebhookQueueNameForChatId,
  WEBHOOK_QUEUE_BACKGROUND,
  WEBHOOK_QUEUE_CRITICAL,
} from './webhook-queues';

type ChatQueueAssignment = {
  queueName: DefaultWebhookQueueName;
  expiresAtMs: number;
};

type QueuePressure = {
  queueName: DefaultWebhookQueueName;
  queuePressure: number;
  workerPressure: number;
  leasedChats: number;
  tieOrder: number;
};

const DEFAULT_CHAT_ASSIGNMENT_TTL_SEC = 90;
const DEFAULT_QUEUE_SNAPSHOT_MAX_AGE_MS = 1_000;

@Injectable()
export class WebhookRoutingService {
  private readonly chatAssignmentTtlMs: number;
  private readonly queueSnapshotMaxAgeMs: number;
  private readonly chatAssignments = new Map<string, ChatQueueAssignment>();
  private readonly assignmentRefreshes = new Map<string, Promise<DefaultWebhookQueueName>>();
  private readonly workerGroupByQueue = this.buildWorkerGroupByQueue();

  constructor(
    private readonly prisma: PrismaService,
    private readonly queueMetricsService: QueueMetricsService,
    configService: ConfigService,
  ) {
    this.chatAssignmentTtlMs =
      this.readConfigInt(
        configService.get('WEBHOOK_ROUTING_CHAT_ASSIGNMENT_TTL_SEC'),
        DEFAULT_CHAT_ASSIGNMENT_TTL_SEC,
      ) * 1_000;
    this.queueSnapshotMaxAgeMs = this.readConfigInt(
      configService.get('WEBHOOK_ROUTING_QUEUE_SNAPSHOT_MAX_AGE_MS'),
      DEFAULT_QUEUE_SNAPSHOT_MAX_AGE_MS,
      50,
    );
  }

  async resolveQueueName(
    webhookEventId: string,
    payload: unknown,
  ): Promise<ActiveWebhookQueueName> {
    switch (extractWebhookType(payload)) {
      case 'message_callback':
      case 'user_added':
      case 'bot_added':
      case 'bot_started':
        return WEBHOOK_QUEUE_CRITICAL;
      case 'user_removed':
      case 'bot_removed':
        return WEBHOOK_QUEUE_BACKGROUND;
      case 'message_created':
      default:
        return this.resolveDefaultQueueName(webhookEventId, payload);
    }
  }

  private async resolveDefaultQueueName(
    webhookEventId: string,
    payload: unknown,
  ): Promise<DefaultWebhookQueueName> {
    const chatId = extractWebhookChatId(payload);
    if (!chatId) {
      return DEFAULT_WEBHOOK_QUEUE_NAMES[0];
    }

    const now = Date.now();
    const currentAssignment = this.readFreshAssignment(chatId, now);
    if (currentAssignment) {
      return currentAssignment.queueName;
    }

    const refresh = this.assignmentRefreshes.get(chatId);
    if (refresh) {
      return refresh;
    }

    const refreshPromise = this.refreshChatAssignment(chatId, webhookEventId, now).finally(() => {
      if (this.assignmentRefreshes.get(chatId) === refreshPromise) {
        this.assignmentRefreshes.delete(chatId);
      }
    });
    this.assignmentRefreshes.set(chatId, refreshPromise);
    return refreshPromise;
  }

  private async refreshChatAssignment(
    chatId: string,
    webhookEventId: string,
    now: number,
  ): Promise<DefaultWebhookQueueName> {
    const previousAssignment = this.chatAssignments.get(chatId);
    const fallbackQueue =
      previousAssignment?.queueName ?? resolveDefaultWebhookQueueNameForChatId(chatId);

    const hasOutstandingWork = await this.hasOutstandingMessageQueueWork(chatId, webhookEventId);
    if (hasOutstandingWork) {
      return this.storeAssignment(chatId, fallbackQueue, now);
    }

    const snapshot = await this.queueMetricsService.getSnapshot({
      maxAgeMs: this.queueSnapshotMaxAgeMs,
    });
    const nextQueue = this.selectLeastPressuredQueue(chatId, snapshot, fallbackQueue, now);
    return this.storeAssignment(chatId, nextQueue, now);
  }

  private selectLeastPressuredQueue(
    chatId: string,
    snapshot: Awaited<ReturnType<QueueMetricsService['getSnapshot']>>,
    currentQueueName: DefaultWebhookQueueName,
    now: number,
  ): DefaultWebhookQueueName {
    const rotatedQueueNames = this.rotateQueueNames(chatId);
    const candidates = rotatedQueueNames.map((queueName, tieOrder) =>
      this.buildQueuePressureCandidate(queueName, tieOrder, snapshot, now),
    );
    const bestCandidate = candidates.reduce((best, current) =>
      this.compareQueuePressure(current, best) < 0 ? current : best,
    );
    const currentCandidate = candidates.find((candidate) => candidate.queueName === currentQueueName);
    if (!currentCandidate) {
      return bestCandidate.queueName;
    }

    const queuePressureGap = currentCandidate.queuePressure - bestCandidate.queuePressure;
    const workerPressureGap = currentCandidate.workerPressure - bestCandidate.workerPressure;
    const leasedChatsGap = currentCandidate.leasedChats - bestCandidate.leasedChats;
    const keepCurrentQueue =
      this.compareQueuePressure(currentCandidate, bestCandidate) <= 0 ||
      (queuePressureGap <= 1 && workerPressureGap <= 2 && leasedChatsGap <= 1);

    return keepCurrentQueue ? currentQueueName : bestCandidate.queueName;
  }

  private buildQueuePressureCandidate(
    queueName: DefaultWebhookQueueName,
    tieOrder: number,
    snapshot: Awaited<ReturnType<QueueMetricsService['getSnapshot']>>,
    now: number,
  ): QueuePressure {
    const queueCounters = snapshot.webhookDefaultShards[queueName];
    const queuePressure =
      (queueCounters?.waiting ?? 0) + (queueCounters?.active ?? 0) + (queueCounters?.delayed ?? 0);
    const workerGroupName = this.workerGroupByQueue[queueName];
    const workerCounters = workerGroupName
      ? snapshot.webhookDefaultWorkerGroups[workerGroupName]?.counters
      : null;
    const workerPressure = workerCounters
      ? workerCounters.waiting + workerCounters.active
      : queuePressure;

    let leasedChats = 0;
    for (const assignment of this.chatAssignments.values()) {
      if (assignment.queueName !== queueName || assignment.expiresAtMs <= now) {
        continue;
      }
      leasedChats += 1;
    }

    return {
      queueName,
      queuePressure,
      workerPressure,
      leasedChats,
      tieOrder,
    };
  }

  private compareQueuePressure(left: QueuePressure, right: QueuePressure): number {
    if (left.queuePressure !== right.queuePressure) {
      return left.queuePressure - right.queuePressure;
    }
    if (left.workerPressure !== right.workerPressure) {
      return left.workerPressure - right.workerPressure;
    }
    if (left.leasedChats !== right.leasedChats) {
      return left.leasedChats - right.leasedChats;
    }
    return left.tieOrder - right.tieOrder;
  }

  private rotateQueueNames(chatId: string): DefaultWebhookQueueName[] {
    const startIndex = resolveDefaultWebhookQueueIndexForChatId(chatId);
    return DEFAULT_WEBHOOK_QUEUE_NAMES.map(
      (_, offset) =>
        DEFAULT_WEBHOOK_QUEUE_NAMES[(startIndex + offset) % DEFAULT_WEBHOOK_QUEUE_NAMES.length]!,
    );
  }

  private readFreshAssignment(chatId: string, now: number): ChatQueueAssignment | null {
    const assignment = this.chatAssignments.get(chatId);
    if (!assignment) {
      return null;
    }

    if (assignment.expiresAtMs <= now) {
      return null;
    }

    return assignment;
  }

  private storeAssignment(
    chatId: string,
    queueName: DefaultWebhookQueueName,
    now: number,
  ): DefaultWebhookQueueName {
    this.chatAssignments.set(chatId, {
      queueName,
      expiresAtMs: now + this.chatAssignmentTtlMs,
    });
    return queueName;
  }

  private async hasOutstandingMessageQueueWork(
    chatId: string,
    webhookEventId: string,
  ): Promise<boolean> {
    const rows = await this.prisma.$queryRaw<Array<{ pending_count?: bigint | number }>>(
      Prisma.sql`
        SELECT COUNT(*)::bigint AS pending_count
        FROM webhook_events
        WHERE id <> ${webhookEventId}
          AND status IN (${Prisma.join([WebhookStatus.RECEIVED, WebhookStatus.QUEUED])})
          AND LOWER(
            COALESCE(
              NULLIF(BTRIM(normalized_payload->>'type'), ''),
              NULLIF(BTRIM(normalized_payload->>'update_type'), '')
            )
          ) = 'message_created'
          AND COALESCE(
            NULLIF(BTRIM(normalized_payload->'message'->>'chatId'), ''),
            NULLIF(BTRIM(normalized_payload->>'chatId'), '')
          ) = ${chatId}
      `,
    );
    const pendingCount = rows[0]?.pending_count;

    if (typeof pendingCount === 'bigint') {
      return pendingCount > 0n;
    }

    return typeof pendingCount === 'number' ? pendingCount > 0 : false;
  }

  private buildWorkerGroupByQueue(): Record<
    DefaultWebhookQueueName,
    DefaultWebhookWorkerGroupName | undefined
  > {
    const workerGroups = getDefaultWebhookWorkerGroupQueues();
    const workerGroupByQueue = Object.fromEntries(
      DEFAULT_WEBHOOK_QUEUE_NAMES.map((queueName) => [queueName, undefined]),
    ) as Record<DefaultWebhookQueueName, DefaultWebhookWorkerGroupName | undefined>;

    for (const [groupName, queues] of Object.entries(workerGroups) as Array<
      [DefaultWebhookWorkerGroupName, readonly DefaultWebhookQueueName[]]
    >) {
      for (const queueName of queues) {
        workerGroupByQueue[queueName] = groupName;
      }
    }

    return workerGroupByQueue;
  }

  private readConfigInt(value: unknown, fallback: number, min = 1): number {
    const numericValue =
      typeof value === 'number'
        ? value
        : typeof value === 'string' && value.trim().length > 0
          ? Number(value)
          : Number.NaN;
    if (Number.isFinite(numericValue) && numericValue >= min) {
      return Math.trunc(numericValue);
    }

    return fallback;
  }
}
