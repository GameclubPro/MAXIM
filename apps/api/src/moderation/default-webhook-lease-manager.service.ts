import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Job, Worker } from 'bullmq';
import { Worker as BullWorker } from 'bullmq';
import Redis from 'ioredis';
import { getAppRole, roleRunsModeration } from '../runtime/app-role';
import { buildDefaultWebhookLeasePlan } from '../runtime/default-webhook-lease-plan';
import {
  buildDefaultWebhookHandoffKey,
  buildDefaultWebhookLeaseKey,
  buildDefaultWebhookWorkerHeartbeatKey,
  DEFAULT_WEBHOOK_LEASE_SUMMARY_KEY,
  type DefaultWebhookLeaseSummary,
  type DefaultWebhookShardClaim,
  type DefaultWebhookShardHandoff,
} from '../runtime/default-webhook-dynamic-leases';
import {
  DEFAULT_WEBHOOK_WORKER_GROUP_NAMES,
  getDefaultWebhookHomeOwnerByQueue,
  getDefaultWebhookShardConcurrencies,
  getDefaultWebhookWorkerGroupQueues,
  getWebhookDynamicLeaseCanaryQueues,
  getWebhookDynamicLeasesMode,
  getWebhookDynamicLeasesWorkerGroup,
  type DefaultWebhookWorkerGroupName,
  type WebhookDynamicLeasesMode,
} from '../runtime/moderation-runtime';
import { QueueMetricsService } from '../system/queue-metrics.service';
import {
  DEFAULT_WEBHOOK_QUEUE_NAMES,
  type DefaultWebhookQueueName,
  type ProcessWebhookJob,
} from '../webhook/webhook-queues';
import { ModerationService } from './moderation.service';

type WorkerHeartbeat = {
  workerGroupName: DefaultWebhookWorkerGroupName;
  updatedAtMs: number;
  mode: WebhookDynamicLeasesMode;
};

@Injectable()
export class DefaultWebhookLeaseManagerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DefaultWebhookLeaseManagerService.name);
  private readonly redis: Redis;
  private readonly redisUrl: string;
  private readonly workerGroupName: DefaultWebhookWorkerGroupName | null;
  private readonly mode: WebhookDynamicLeasesMode;
  private readonly canaryQueues: Set<DefaultWebhookQueueName>;
  private readonly homeQueues: readonly DefaultWebhookQueueName[];
  private readonly homeOwnerByQueue = getDefaultWebhookHomeOwnerByQueue();
  private readonly shardConcurrencies = getDefaultWebhookShardConcurrencies();
  private readonly heartbeatMs: number;
  private readonly leaseTtlMs: number;
  private readonly handoffTtlMs: number;
  private readonly rebalanceCooldownMs: number;
  private readonly summaryTtlMs: number;
  private readonly closeTimeoutMs: number;
  private readonly workers = new Map<DefaultWebhookQueueName, Worker<ProcessWebhookJob>>();
  private readonly closingWorkers = new Set<DefaultWebhookQueueName>();
  private readonly lastHandoffAtMs = new Map<DefaultWebhookQueueName, number>();
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private syncTimer: NodeJS.Timeout | null = null;
  private syncing = false;

  constructor(
    configService: ConfigService,
    private readonly moderationService: ModerationService,
    private readonly queueMetricsService: QueueMetricsService,
  ) {
    this.redisUrl = configService.getOrThrow<string>('REDIS_URL');
    this.redis = new Redis(this.redisUrl);
    this.workerGroupName = getWebhookDynamicLeasesWorkerGroup(
      configService.get('WEBHOOK_DYNAMIC_LEASES_WORKER_GROUP'),
    );
    this.mode = getWebhookDynamicLeasesMode(configService.get('WEBHOOK_DYNAMIC_LEASES_MODE'));
    this.canaryQueues = getWebhookDynamicLeaseCanaryQueues(
      configService.get('WEBHOOK_DYNAMIC_LEASES_CANARY_SHARDS'),
    );
    this.homeQueues = this.workerGroupName
      ? getDefaultWebhookWorkerGroupQueues()[this.workerGroupName]
      : [];
    this.heartbeatMs = configService.get<number>('WEBHOOK_DYNAMIC_LEASES_HEARTBEAT_MS', 3_000);
    this.leaseTtlMs = configService.get<number>('WEBHOOK_DYNAMIC_LEASES_LEASE_TTL_MS', 12_000);
    this.handoffTtlMs = configService.get<number>(
      'WEBHOOK_DYNAMIC_LEASES_HANDOFF_TTL_MS',
      this.leaseTtlMs,
    );
    this.rebalanceCooldownMs = configService.get<number>(
      'WEBHOOK_DYNAMIC_LEASES_REBALANCE_COOLDOWN_MS',
      30_000,
    );
    this.summaryTtlMs = configService.get<number>('WEBHOOK_DYNAMIC_LEASES_SUMMARY_TTL_MS', 20_000);
    this.closeTimeoutMs = configService.get<number>('WEBHOOK_DYNAMIC_LEASES_CLOSE_TIMEOUT_MS', 5_000);
  }

  onModuleInit() {
    if (!roleRunsModeration(getAppRole()) || !this.workerGroupName) {
      return;
    }

    this.heartbeatTimer = setInterval(() => {
      void this.publishKeepalive();
    }, this.heartbeatMs);
    this.heartbeatTimer.unref();
    this.syncTimer = setInterval(() => {
      void this.sync();
    }, this.heartbeatMs);
    this.syncTimer.unref();
    void this.publishKeepalive();
    void this.sync();
  }

  async onModuleDestroy() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }

    await Promise.all([...this.workers.values()].map((worker) => worker.close().catch(() => undefined)));
    this.workers.clear();
    await this.redis.quit();
  }

  private async sync(): Promise<void> {
    if (!this.workerGroupName || this.syncing) {
      return;
    }

    this.syncing = true;
    try {
      if (this.mode === 'off' || this.mode === 'shadow') {
        await this.releaseLocalDynamicClaims();
        await this.ensureStaticHomeWorkers();
        await this.closeWorkersExcept(new Set(this.homeQueues));
        await this.persistSummary(await this.buildSummary());
        return;
      }

      await this.bootstrapHomeClaims();
      await this.applyDynamicPlan();
      await this.persistSummary(await this.buildSummary());
    } catch (error: unknown) {
      this.logger.warn(
        { err: error instanceof Error ? error.message : String(error) },
        'Failed to sync default webhook lease manager',
      );
    } finally {
      this.syncing = false;
    }
  }

  private async publishKeepalive(): Promise<void> {
    if (!this.workerGroupName) {
      return;
    }

    try {
      await this.writeHeartbeat();
      if (this.mode === 'on' || this.mode === 'canary') {
        await this.renewLocalClaims();
      }
    } catch (error: unknown) {
      this.logger.warn(
        { err: error instanceof Error ? error.message : String(error) },
        'Failed to publish default webhook lease keepalive',
      );
    }
  }

  private async applyDynamicPlan(): Promise<void> {
    if (!this.workerGroupName) {
      return;
    }

    const claims = await this.loadClaims();
    const handoffs = await this.loadHandoffs();
    const aliveWorkerGroups = await this.loadAliveWorkerGroups();
    const snapshot = await this.queueMetricsService.getSnapshot({ maxAgeMs: 1_500 });
    const plan = buildDefaultWebhookLeasePlan({
      mode: this.mode,
      canaryQueues: this.canaryQueues,
      aliveWorkerGroups,
      claimedOwners: Object.fromEntries(
        DEFAULT_WEBHOOK_QUEUE_NAMES.map((queueName) => [queueName, claims[queueName]?.ownerId ?? null]),
      ) as Partial<Record<DefaultWebhookQueueName, DefaultWebhookWorkerGroupName | null>>,
      lastHandoffAtMs: Object.fromEntries(this.lastHandoffAtMs),
      queueCounters: snapshot.webhookDefaultShards,
      rebalanceCooldownMs: this.rebalanceCooldownMs,
    });

    const allowedWorkers = new Set<DefaultWebhookQueueName>();
    for (const queueName of DEFAULT_WEBHOOK_QUEUE_NAMES) {
      const entry = plan.queues[queueName];
      if (!entry.eligibleForDynamicLeases) {
        if (entry.homeOwner === this.workerGroupName) {
          await this.ensureWorkerRunning(queueName);
          allowedWorkers.add(queueName);
        }
        continue;
      }

      const currentClaim = claims[queueName] ?? null;
      const currentOwner = currentClaim?.ownerId ?? entry.homeOwner;
      if (currentOwner === this.workerGroupName && entry.desiredOwner !== this.workerGroupName) {
        if (entry.activeJobs > 0) {
          allowedWorkers.add(queueName);
          continue;
        }
        await this.issueHandoff(queueName, this.workerGroupName, entry.desiredOwner);
        await this.closeWorker(queueName);
        if (currentClaim?.ownerId === this.workerGroupName) {
          await this.releaseClaim(queueName);
        }
        this.lastHandoffAtMs.set(queueName, Date.now());
        continue;
      }

      if (entry.desiredOwner !== this.workerGroupName) {
        continue;
      }

      const currentHandoff = handoffs[queueName] ?? null;
      const homeOwnerAlive = aliveWorkerGroups.has(entry.homeOwner);
      const claimExpired = currentClaim ? currentClaim.leaseUntilMs <= Date.now() : false;
      const canClaim =
        currentClaim?.ownerId === this.workerGroupName ||
        claimExpired ||
        currentHandoff?.toOwnerId === this.workerGroupName ||
        (!currentClaim && entry.homeOwner === this.workerGroupName) ||
        (!currentClaim && !homeOwnerAlive);

      if (!canClaim) {
        continue;
      }

      const claimed = await this.claimQueue(queueName);
      if (!claimed) {
        continue;
      }
      await this.ensureWorkerRunning(queueName);
      allowedWorkers.add(queueName);
    }

    await this.closeWorkersExcept(allowedWorkers);
  }

  private async buildSummary(): Promise<DefaultWebhookLeaseSummary> {
    const claims = await this.loadClaims();
    const aliveWorkerGroups = await this.loadAliveWorkerGroups();
    const snapshot = await this.queueMetricsService.getSnapshot({ maxAgeMs: 1_500 });
    const plan = buildDefaultWebhookLeasePlan({
      mode: this.mode,
      canaryQueues: this.canaryQueues,
      aliveWorkerGroups,
      claimedOwners: Object.fromEntries(
        DEFAULT_WEBHOOK_QUEUE_NAMES.map((queueName) => [queueName, claims[queueName]?.ownerId ?? null]),
      ) as Partial<Record<DefaultWebhookQueueName, DefaultWebhookWorkerGroupName | null>>,
      lastHandoffAtMs: Object.fromEntries(this.lastHandoffAtMs),
      queueCounters: snapshot.webhookDefaultShards,
      rebalanceCooldownMs: this.rebalanceCooldownMs,
    });

    return {
      mode: this.mode,
      generatedAt: new Date().toISOString(),
      queues: Object.fromEntries(
        DEFAULT_WEBHOOK_QUEUE_NAMES.map((queueName) => {
          const entry = plan.queues[queueName];
          const claim = claims[queueName] ?? null;
          const actualOwner = claim?.ownerId ?? entry.homeOwner;
          return [
            queueName,
            {
              queueName,
              homeOwner: entry.homeOwner,
              actualOwner,
              desiredOwner: entry.desiredOwner,
              eligibleForDynamicLeases: entry.eligibleForDynamicLeases,
              handoffPending: entry.handoffPending,
              activeJobs: entry.activeJobs,
              pressure: entry.pressure,
              reason: entry.reason,
              claimFencingToken: claim?.fencingToken ?? null,
              claimLeaseUntil: claim ? new Date(claim.leaseUntilMs).toISOString() : null,
              lastHandoffAt:
                typeof this.lastHandoffAtMs.get(queueName) === 'number'
                  ? new Date(this.lastHandoffAtMs.get(queueName)!).toISOString()
                  : null,
            },
          ];
        }),
      ) as DefaultWebhookLeaseSummary['queues'],
      workerLoads: plan.workerLoads,
      liveWorkerGroups: [...aliveWorkerGroups],
    };
  }

  private async persistSummary(summary: DefaultWebhookLeaseSummary): Promise<void> {
    await this.redis.set(
      DEFAULT_WEBHOOK_LEASE_SUMMARY_KEY,
      JSON.stringify(summary),
      'PX',
      this.summaryTtlMs,
    );
  }

  private async releaseLocalDynamicClaims(): Promise<void> {
    if (!this.workerGroupName) {
      return;
    }

    const claims = await this.loadClaims();
    await Promise.all(
      DEFAULT_WEBHOOK_QUEUE_NAMES.map(async (queueName) => {
        if (claims[queueName]?.ownerId === this.workerGroupName) {
          await this.releaseClaim(queueName);
        }
      }),
    );
  }

  private async renewLocalClaims(): Promise<void> {
    if (!this.workerGroupName) {
      return;
    }

    const queueNames = [...this.workers.keys()].filter(
      (queueName) => this.isDynamicQueue(queueName) && !this.closingWorkers.has(queueName),
    );
    if (queueNames.length === 0) {
      return;
    }

    const pipeline = this.redis.pipeline();
    for (const queueName of queueNames) {
      pipeline.get(buildDefaultWebhookLeaseKey(queueName));
    }
    const results = await pipeline.exec();
    if (!results) {
      return;
    }

    const nowMs = Date.now();
    const renewPipeline = this.redis.pipeline();
    queueNames.forEach((queueName, index) => {
      const parsed = this.parseClaim(results[index]?.[1], queueName);
      if (!parsed || parsed.ownerId !== this.workerGroupName) {
        return;
      }

      const renewedClaim: DefaultWebhookShardClaim = {
        ...parsed,
        updatedAtMs: nowMs,
        leaseUntilMs: nowMs + this.leaseTtlMs,
      };
      renewPipeline.set(
        buildDefaultWebhookLeaseKey(queueName),
        JSON.stringify(renewedClaim),
        'PX',
        this.leaseTtlMs,
      );
    });

    await renewPipeline.exec();
  }

  private async bootstrapHomeClaims(): Promise<void> {
    if (!this.workerGroupName) {
      return;
    }

    const claims = await this.loadClaims();
    const handoffs = await this.loadHandoffs();
    for (const queueName of this.homeQueues) {
      if (!this.isDynamicQueue(queueName)) {
        continue;
      }
      if (claims[queueName] || handoffs[queueName]) {
        continue;
      }
      const claimed = await this.claimQueue(queueName);
      if (claimed) {
        this.lastHandoffAtMs.set(queueName, Date.now());
        await this.ensureWorkerRunning(queueName);
      }
    }
  }

  private async writeHeartbeat(): Promise<void> {
    if (!this.workerGroupName) {
      return;
    }

    const payload: WorkerHeartbeat = {
      workerGroupName: this.workerGroupName,
      updatedAtMs: Date.now(),
      mode: this.mode,
    };
    await this.redis.set(
      buildDefaultWebhookWorkerHeartbeatKey(this.workerGroupName),
      JSON.stringify(payload),
      'PX',
      Math.max(this.leaseTtlMs * 2, this.heartbeatMs * 3),
    );
  }

  private async loadAliveWorkerGroups(): Promise<Set<DefaultWebhookWorkerGroupName>> {
    const pipeline = this.redis.pipeline();
    for (const groupName of DEFAULT_WEBHOOK_WORKER_GROUP_NAMES) {
      pipeline.get(buildDefaultWebhookWorkerHeartbeatKey(groupName));
    }
    const results = await pipeline.exec();
    const aliveGroups = new Set<DefaultWebhookWorkerGroupName>();
    if (!results) {
      return new Set(DEFAULT_WEBHOOK_WORKER_GROUP_NAMES);
    }

    DEFAULT_WEBHOOK_WORKER_GROUP_NAMES.forEach((groupName, index) => {
      const raw = results[index]?.[1];
      const parsed = this.parseHeartbeat(raw);
      if (parsed) {
        aliveGroups.add(groupName);
      }
    });
    return aliveGroups.size > 0 ? aliveGroups : new Set(DEFAULT_WEBHOOK_WORKER_GROUP_NAMES);
  }

  private async loadClaims(): Promise<
    Partial<Record<DefaultWebhookQueueName, DefaultWebhookShardClaim>>
  > {
    const pipeline = this.redis.pipeline();
    for (const queueName of DEFAULT_WEBHOOK_QUEUE_NAMES) {
      pipeline.get(buildDefaultWebhookLeaseKey(queueName));
    }
    const results = await pipeline.exec();
    const claims: Partial<Record<DefaultWebhookQueueName, DefaultWebhookShardClaim>> = {};
    if (!results) {
      return claims;
    }

    DEFAULT_WEBHOOK_QUEUE_NAMES.forEach((queueName, index) => {
      const parsed = this.parseClaim(results[index]?.[1], queueName);
      if (parsed && parsed.leaseUntilMs > Date.now()) {
        claims[queueName] = parsed;
      }
    });
    return claims;
  }

  private async loadHandoffs(): Promise<
    Partial<Record<DefaultWebhookQueueName, DefaultWebhookShardHandoff>>
  > {
    const pipeline = this.redis.pipeline();
    for (const queueName of DEFAULT_WEBHOOK_QUEUE_NAMES) {
      pipeline.get(buildDefaultWebhookHandoffKey(queueName));
    }
    const results = await pipeline.exec();
    const handoffs: Partial<Record<DefaultWebhookQueueName, DefaultWebhookShardHandoff>> = {};
    if (!results) {
      return handoffs;
    }

    DEFAULT_WEBHOOK_QUEUE_NAMES.forEach((queueName, index) => {
      const parsed = this.parseHandoff(results[index]?.[1], queueName);
      if (parsed && parsed.expiresAtMs > Date.now()) {
        handoffs[queueName] = parsed;
      }
    });
    return handoffs;
  }

  private parseHeartbeat(raw: unknown): WorkerHeartbeat | null {
    if (typeof raw !== 'string' || raw.length === 0) {
      return null;
    }

    try {
      const parsed = JSON.parse(raw) as Partial<WorkerHeartbeat>;
      if (
        !parsed ||
        !parsed.workerGroupName ||
        !parsed.updatedAtMs ||
        !parsed.mode ||
        !DEFAULT_WEBHOOK_WORKER_GROUP_NAMES.includes(parsed.workerGroupName)
      ) {
        return null;
      }
      return parsed as WorkerHeartbeat;
    } catch {
      return null;
    }
  }

  private parseClaim(
    raw: unknown,
    queueName: DefaultWebhookQueueName,
  ): DefaultWebhookShardClaim | null {
    if (typeof raw !== 'string' || raw.length === 0) {
      return null;
    }
    try {
      const parsed = JSON.parse(raw) as Partial<DefaultWebhookShardClaim>;
      if (
        !parsed ||
        parsed.queueName !== queueName ||
        !parsed.ownerId ||
        !DEFAULT_WEBHOOK_WORKER_GROUP_NAMES.includes(parsed.ownerId) ||
        typeof parsed.fencingToken !== 'number' ||
        typeof parsed.claimedAtMs !== 'number' ||
        typeof parsed.updatedAtMs !== 'number' ||
        typeof parsed.leaseUntilMs !== 'number'
      ) {
        return null;
      }
      return parsed as DefaultWebhookShardClaim;
    } catch {
      return null;
    }
  }

  private parseHandoff(
    raw: unknown,
    queueName: DefaultWebhookQueueName,
  ): DefaultWebhookShardHandoff | null {
    if (typeof raw !== 'string' || raw.length === 0) {
      return null;
    }
    try {
      const parsed = JSON.parse(raw) as Partial<DefaultWebhookShardHandoff>;
      if (
        !parsed ||
        parsed.queueName !== queueName ||
        !parsed.fromOwnerId ||
        !parsed.toOwnerId ||
        !DEFAULT_WEBHOOK_WORKER_GROUP_NAMES.includes(parsed.fromOwnerId) ||
        !DEFAULT_WEBHOOK_WORKER_GROUP_NAMES.includes(parsed.toOwnerId) ||
        typeof parsed.issuedAtMs !== 'number' ||
        typeof parsed.expiresAtMs !== 'number'
      ) {
        return null;
      }
      return parsed as DefaultWebhookShardHandoff;
    } catch {
      return null;
    }
  }

  private async claimQueue(queueName: DefaultWebhookQueueName): Promise<boolean> {
    if (!this.workerGroupName) {
      return false;
    }

    const existing = await this.redis.get(buildDefaultWebhookLeaseKey(queueName));
    const parsed = this.parseClaim(existing, queueName);
    if (parsed && parsed.ownerId !== this.workerGroupName && parsed.leaseUntilMs > Date.now()) {
      return false;
    }

    const claim: DefaultWebhookShardClaim = {
      queueName,
      ownerId: this.workerGroupName,
      fencingToken: (parsed?.fencingToken ?? 0) + 1,
      claimedAtMs: parsed?.claimedAtMs ?? Date.now(),
      updatedAtMs: Date.now(),
      leaseUntilMs: Date.now() + this.leaseTtlMs,
    };
    await this.redis.set(
      buildDefaultWebhookLeaseKey(queueName),
      JSON.stringify(claim),
      'PX',
      this.leaseTtlMs,
    );
    return true;
  }

  private async releaseClaim(queueName: DefaultWebhookQueueName): Promise<void> {
    await this.redis.del(buildDefaultWebhookLeaseKey(queueName));
  }

  private async issueHandoff(
    queueName: DefaultWebhookQueueName,
    fromOwnerId: DefaultWebhookWorkerGroupName,
    toOwnerId: DefaultWebhookWorkerGroupName,
  ): Promise<void> {
    const payload: DefaultWebhookShardHandoff = {
      queueName,
      fromOwnerId,
      toOwnerId,
      issuedAtMs: Date.now(),
      expiresAtMs: Date.now() + this.handoffTtlMs,
    };
    await this.redis.set(
      buildDefaultWebhookHandoffKey(queueName),
      JSON.stringify(payload),
      'PX',
      this.handoffTtlMs,
    );
  }

  private async ensureStaticHomeWorkers(): Promise<void> {
    for (const queueName of this.homeQueues) {
      await this.ensureWorkerRunning(queueName);
    }
  }

  private async ensureWorkerRunning(queueName: DefaultWebhookQueueName): Promise<void> {
    if (this.workers.has(queueName)) {
      return;
    }

    const worker = new BullWorker<ProcessWebhookJob>(
      queueName,
      async (job: Job<ProcessWebhookJob>) => {
        await this.moderationService.processWebhookEvent(job.data.webhookEventId);
      },
      {
        connection: {
          url: this.redisUrl,
        },
        concurrency: this.shardConcurrencies[queueName] ?? 1,
      },
    );
    worker.on('error', (error) => {
      this.logger.warn(
        { queueName, err: error instanceof Error ? error.message : String(error) },
        'Default webhook BullMQ worker failed',
      );
    });
    this.workers.set(queueName, worker);
  }

  private async closeWorker(queueName: DefaultWebhookQueueName): Promise<void> {
    const worker = this.workers.get(queueName);
    if (!worker || this.closingWorkers.has(queueName)) {
      return;
    }

    this.closingWorkers.add(queueName);
    try {
      await Promise.race([
        worker.close(),
        new Promise<never>((_, reject) => {
          const timeout = setTimeout(() => {
            reject(new Error(`Timed out after ${this.closeTimeoutMs}ms`));
          }, this.closeTimeoutMs);
          timeout.unref();
        }),
      ]);
    } catch (error: unknown) {
      this.logger.warn(
        {
          queueName,
          err: error instanceof Error ? error.message : String(error),
        },
        'Default webhook BullMQ worker close timed out; detaching local reference',
      );
    } finally {
      this.closingWorkers.delete(queueName);
      this.workers.delete(queueName);
    }
  }

  private async closeWorkersExcept(allowedQueues: ReadonlySet<DefaultWebhookQueueName>): Promise<void> {
    for (const queueName of [...this.workers.keys()]) {
      if (!allowedQueues.has(queueName)) {
        await this.closeWorker(queueName);
      }
    }
  }

  private isDynamicQueue(queueName: DefaultWebhookQueueName): boolean {
    return this.mode === 'on' || (this.mode === 'canary' && this.canaryQueues.has(queueName));
  }
}
