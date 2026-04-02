import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { QueueMetricsSnapshot } from './queue-metrics.service';
import type { SystemModeSnapshot } from './system-mode.service';
import Redis from 'ioredis';

type HotPathStageSummary = {
  stage: string;
  count: number;
  slowCount: number;
  timeoutCount: number;
  skipCount: number;
  failOpenCount: number;
  avgElapsedMs: number;
  maxElapsedMs: number;
  lastObservedAt: string | null;
};

type HotChatSummary = {
  chatId: string;
  messageCreatedCount: number;
  botsSeen: number;
  lastSeenAt: string;
};

type BackgroundPauseReasonSummary = {
  component: string;
  sourceTag: string;
  action: 'run' | 'slow' | 'pause';
  reason: string;
  count: number;
  lastObservedAt: string | null;
};

type MembershipLookupSample = {
  chatId: string;
  policyName: string;
  lastObservedAt: string;
  retryAfterMs: number | null;
};

type MembershipLookupIssueSample = MembershipLookupSample & {
  kind: 'transient' | 'terminal';
};

export type RuntimeDiagnosticsDashboardSnapshot = {
  burst: {
    active: boolean;
    peakLagSec: number;
    peakBotId: string | null;
    startedAt: string | null;
    lastRecoveredAt: string | null;
    sampleAgeMs: number;
  };
  hotPath: {
    windowSec: number;
    failOpenCount: number;
    stages: HotPathStageSummary[];
  };
  hotChats: {
    windowSec: number;
    items: HotChatSummary[];
  };
  membershipLookup: {
    windowSec: number;
    hotChannels: number;
    backoffActiveChats: number;
    transientIssues: number;
    terminalIssues: number;
    hotChannelsSample: MembershipLookupSample[];
    backoffSample: MembershipLookupSample[];
    issueSample: MembershipLookupIssueSample[];
  };
};

const HOT_PATH_BUCKET_PREFIX = 'runtime:diag:hot-path:v1';
const HOT_CHAT_COUNT_BUCKET_PREFIX = 'runtime:diag:hot-chat:count:v1';
const HOT_CHAT_LAST_BUCKET_PREFIX = 'runtime:diag:hot-chat:last:v1';
const HOT_CHAT_BOT_BUCKET_PREFIX = 'runtime:diag:hot-chat:bot:v1';
const BACKGROUND_REASON_COUNT_BUCKET_PREFIX = 'runtime:diag:bg:reason:count:v1';
const BACKGROUND_REASON_LAST_BUCKET_PREFIX = 'runtime:diag:bg:reason:last:v1';
const MEMBERSHIP_HOT_PREFIX = 'runtime:diag:membership:hot:v1';
const MEMBERSHIP_BACKOFF_PREFIX = 'runtime:diag:membership:backoff:v1';
const MEMBERSHIP_ISSUE_PREFIX = 'runtime:diag:membership:issue:v1';
const BURST_STATE_KEY = 'runtime:diag:burst-state:v1';

const BUCKET_SPAN_SEC = 60;
const HOT_PATH_SLOW_ELAPSED_MS = 1_500;
const DEFAULT_HOT_PATH_WINDOW_SEC = 15 * 60;
const DEFAULT_HOT_CHAT_WINDOW_SEC = 30 * 60;
const DEFAULT_BACKGROUND_REASON_WINDOW_SEC = 15 * 60;
const DEFAULT_MEMBERSHIP_WINDOW_SEC = 15 * 60;
const DEFAULT_BURST_LAG_THRESHOLD_SEC = 2;
const DEFAULT_REDIS_SCAN_COUNT = 250;

@Injectable()
export class RuntimeDiagnosticsService implements OnModuleDestroy {
  private readonly logger = new Logger(RuntimeDiagnosticsService.name);
  private readonly redis: Redis;
  private readonly hotPathWindowSec: number;
  private readonly hotChatWindowSec: number;
  private readonly backgroundReasonWindowSec: number;
  private readonly membershipWindowSec: number;
  private readonly burstLagThresholdSec: number;
  private readonly redisScanCount: number;

  constructor(configService: ConfigService) {
    this.redis = new Redis(configService.getOrThrow<string>('REDIS_URL'));
    this.hotPathWindowSec = this.readPositiveInt(
      configService.get('SYSTEM_RUNTIME_DIAGNOSTICS_HOT_PATH_WINDOW_SEC'),
      DEFAULT_HOT_PATH_WINDOW_SEC,
    );
    this.hotChatWindowSec = this.readPositiveInt(
      configService.get('SYSTEM_RUNTIME_DIAGNOSTICS_HOT_CHAT_WINDOW_SEC'),
      DEFAULT_HOT_CHAT_WINDOW_SEC,
    );
    this.backgroundReasonWindowSec = this.readPositiveInt(
      configService.get('SYSTEM_RUNTIME_DIAGNOSTICS_BACKGROUND_WINDOW_SEC'),
      DEFAULT_BACKGROUND_REASON_WINDOW_SEC,
    );
    this.membershipWindowSec = this.readPositiveInt(
      configService.get('SYSTEM_RUNTIME_DIAGNOSTICS_MEMBERSHIP_WINDOW_SEC'),
      DEFAULT_MEMBERSHIP_WINDOW_SEC,
    );
    this.burstLagThresholdSec = this.readPositiveNumber(
      configService.get('SYSTEM_RUNTIME_DIAGNOSTICS_BURST_LAG_SEC'),
      DEFAULT_BURST_LAG_THRESHOLD_SEC,
    );
    this.redisScanCount = this.readPositiveInt(
      configService.get('SYSTEM_RUNTIME_DIAGNOSTICS_SCAN_COUNT'),
      DEFAULT_REDIS_SCAN_COUNT,
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.redis.quit();
  }

  async recordHotPathProfile(params: {
    snapshot: Record<string, unknown> | null | undefined;
    stagePrefix?: string;
  }): Promise<void> {
    const stageDurations = this.readNumericRecord(params.snapshot?.stageDurations);
    const now = Date.now();
    const bucketKey = this.buildBucketKey(HOT_PATH_BUCKET_PREFIX, now);
    const ttlSec = this.resolveBucketTtlSec(this.hotPathWindowSec);
    const stagePrefix = params.stagePrefix?.trim() ?? '';
    let touched = false;
    const normalizedEntries = Object.entries(stageDurations)
      .map(([rawStage, rawElapsedMs]) => ({
        stage: stagePrefix ? `${stagePrefix}${rawStage}` : rawStage,
        elapsedMs: Math.max(0, Math.trunc(rawElapsedMs)),
      }))
      .filter((entry) => entry.stage.length > 0);
    if (normalizedEntries.length === 0) {
      return;
    }

    const maxElapsedFields = normalizedEntries.map((entry) => `${entry.stage}|maxElapsedMs`);
    const existingMaxElapsedValues = await this.redis.hmget(bucketKey, ...maxElapsedFields);
    const pipeline = this.redis.pipeline();

    normalizedEntries.forEach((entry, index) => {
      const { stage, elapsedMs } = entry;
      const existingMaxElapsedMs = this.parseNonNegativeInt(existingMaxElapsedValues[index] ?? null);
      pipeline.hincrby(bucketKey, `${stage}|count`, 1);
      pipeline.hincrby(bucketKey, `${stage}|elapsedTotalMs`, elapsedMs);
      pipeline.hset(bucketKey, `${stage}|lastObservedAtMs`, String(now));
      if (elapsedMs >= existingMaxElapsedMs) {
        pipeline.hset(bucketKey, `${stage}|maxElapsedMs`, String(elapsedMs));
      }
      if (elapsedMs >= HOT_PATH_SLOW_ELAPSED_MS) {
        pipeline.hincrby(bucketKey, `${stage}|slowCount`, 1);
      }
      touched = true;
    });

    if (!touched) {
      return;
    }

    pipeline.expire(bucketKey, ttlSec);
    await this.execPipeline(pipeline, 'recordHotPathProfile');
  }

  async recordHotPathStageOutcome(params: {
    stage: string;
    outcome: 'timeout' | 'skip';
    failOpen?: boolean;
  }): Promise<void> {
    const stage = params.stage.trim();
    if (!stage) {
      return;
    }

    const now = Date.now();
    const bucketKey = this.buildBucketKey(HOT_PATH_BUCKET_PREFIX, now);
    const ttlSec = this.resolveBucketTtlSec(this.hotPathWindowSec);
    const fieldName = `${stage}|${params.outcome === 'timeout' ? 'timeoutCount' : 'skipCount'}`;
    const pipeline = this.redis.pipeline();
    pipeline.hincrby(bucketKey, fieldName, 1);
    if (params.failOpen) {
      pipeline.hincrby(bucketKey, `${stage}|failOpenCount`, 1);
    }
    pipeline.hset(bucketKey, `${stage}|lastObservedAtMs`, String(now));
    pipeline.expire(bucketKey, ttlSec);
    await this.execPipeline(pipeline, 'recordHotPathStageOutcome');
  }

  async recordHotChatMessage(params: {
    chatId: string;
    botId?: string | null;
  }): Promise<void> {
    const chatId = params.chatId.trim();
    if (!chatId) {
      return;
    }

    const now = Date.now();
    const countBucketKey = this.buildBucketKey(HOT_CHAT_COUNT_BUCKET_PREFIX, now);
    const lastBucketKey = this.buildBucketKey(HOT_CHAT_LAST_BUCKET_PREFIX, now);
    const botBucketKey = this.buildBucketKey(HOT_CHAT_BOT_BUCKET_PREFIX, now);
    const ttlSec = this.resolveBucketTtlSec(this.hotChatWindowSec);
    const pipeline = this.redis.pipeline();
    pipeline.hincrby(countBucketKey, chatId, 1);
    pipeline.hset(lastBucketKey, chatId, String(now));
    pipeline.expire(countBucketKey, ttlSec);
    pipeline.expire(lastBucketKey, ttlSec);
    const botId = typeof params.botId === 'string' ? params.botId.trim() : '';
    if (botId) {
      pipeline.hincrby(botBucketKey, `${chatId}\t${botId}`, 1);
      pipeline.expire(botBucketKey, ttlSec);
    }
    await this.execPipeline(pipeline, 'recordHotChatMessage');
  }

  async recordBackgroundDecision(params: {
    component: string;
    sourceTag: string;
    action: 'run' | 'slow' | 'pause';
    reason: string;
  }): Promise<void> {
    const component = params.component.trim();
    const sourceTag = params.sourceTag.trim();
    const reason = params.reason.trim();
    if (!component || !sourceTag || !reason) {
      return;
    }

    const now = Date.now();
    const countBucketKey = this.buildBucketKey(BACKGROUND_REASON_COUNT_BUCKET_PREFIX, now);
    const lastBucketKey = this.buildBucketKey(BACKGROUND_REASON_LAST_BUCKET_PREFIX, now);
    const ttlSec = this.resolveBucketTtlSec(this.backgroundReasonWindowSec);
    const field = JSON.stringify({
      component,
      sourceTag,
      action: params.action,
      reason,
    });
    const pipeline = this.redis.pipeline();
    pipeline.hincrby(countBucketKey, field, 1);
    pipeline.hset(lastBucketKey, field, String(now));
    pipeline.expire(countBucketKey, ttlSec);
    pipeline.expire(lastBucketKey, ttlSec);
    await this.execPipeline(pipeline, 'recordBackgroundDecision');
  }

  async recordMembershipHotChannel(params: {
    chatId: string;
    policyName: string;
    hotDurationMs: number;
  }): Promise<void> {
    const key = this.buildMembershipKey(MEMBERSHIP_HOT_PREFIX, params.policyName, params.chatId);
    if (!key) {
      return;
    }
    await this.setEphemeralMembershipEntry(key, {
      observedAtMs: Date.now(),
      retryAfterMs: Math.max(0, Math.ceil(params.hotDurationMs)),
    });
  }

  async recordMembershipBackoff(params: {
    chatId: string;
    policyName: string;
    retryAfterMs: number;
  }): Promise<void> {
    const key = this.buildMembershipKey(
      MEMBERSHIP_BACKOFF_PREFIX,
      params.policyName,
      params.chatId,
    );
    if (!key) {
      return;
    }
    await this.setEphemeralMembershipEntry(key, {
      observedAtMs: Date.now(),
      retryAfterMs: Math.max(0, Math.ceil(params.retryAfterMs)),
    });
  }

  async recordMembershipIssue(params: {
    chatId: string;
    policyName: string;
    kind: 'transient' | 'terminal';
    retryAfterMs: number;
  }): Promise<void> {
    const key = this.buildMembershipKey(
      `${MEMBERSHIP_ISSUE_PREFIX}:${params.kind}`,
      params.policyName,
      params.chatId,
    );
    if (!key) {
      return;
    }
    await this.setEphemeralMembershipEntry(key, {
      observedAtMs: Date.now(),
      retryAfterMs: Math.max(0, Math.ceil(params.retryAfterMs)),
    });
  }

  async recordQueueLagSnapshot(params: {
    queues: Pick<
      QueueMetricsSnapshot,
      'effectiveLagSec' | 'userFacingEffectiveLagSec' | 'generatedAt' | 'bots'
    >;
    mode: Pick<SystemModeSnapshot, 'mode' | 'reason'>;
  }): Promise<void> {
    const lagSec = params.queues.userFacingEffectiveLagSec ?? params.queues.effectiveLagSec ?? 0;
    const now = Date.now();
    const current = await this.readBurstState();
    const peakBotId = this.resolvePeakLagBotId(params.queues.bots);
    const shouldTreatAsBurst =
      params.mode.mode === 'degrade' || lagSec >= this.burstLagThresholdSec;

    const nextState = current ?? {
      active: false,
      peakLagSec: 0,
      peakBotId: null,
      startedAtMs: null,
      lastRecoveredAtMs: null,
      updatedAtMs: 0,
    };

    if (shouldTreatAsBurst) {
      if (!nextState.active) {
        nextState.startedAtMs = now;
        nextState.peakLagSec = lagSec;
        nextState.peakBotId = peakBotId;
      } else if (lagSec >= nextState.peakLagSec) {
        nextState.peakLagSec = lagSec;
        nextState.peakBotId = peakBotId;
      }
      nextState.active = true;
    } else if (nextState.active) {
      nextState.active = false;
      nextState.lastRecoveredAtMs = now;
    }

    nextState.updatedAtMs = now;
    await this.redis.set(
      BURST_STATE_KEY,
      JSON.stringify(nextState),
      'EX',
      Math.max(60, Math.ceil(this.resolveBucketTtlSec(this.hotPathWindowSec))),
    );
  }

  async getDashboardSnapshot(): Promise<RuntimeDiagnosticsDashboardSnapshot> {
    const [burst, hotPath, hotChats, membershipLookup] = await Promise.all([
      this.getBurstSnapshot(),
      this.getHotPathSummary(),
      this.getHotChatsSummary(),
      this.getMembershipLookupSummary(),
    ]);

    return {
      burst,
      hotPath,
      hotChats,
      membershipLookup,
    };
  }

  async getBackgroundDecisionSummary(): Promise<{
    windowSec: number;
    pauseReasons: BackgroundPauseReasonSummary[];
  }> {
    const bucketKeys = this.buildWindowBucketKeys(
      BACKGROUND_REASON_COUNT_BUCKET_PREFIX,
      this.backgroundReasonWindowSec,
    );
    const lastBucketKeys = this.buildWindowBucketKeys(
      BACKGROUND_REASON_LAST_BUCKET_PREFIX,
      this.backgroundReasonWindowSec,
    );
    const [countHashes, lastHashes] = await Promise.all([
      this.readHashes(bucketKeys),
      this.readHashes(lastBucketKeys),
    ]);
    const aggregate = new Map<
      string,
      {
        descriptor: BackgroundPauseReasonSummary;
        lastObservedAtMs: number;
      }
    >();

    for (let index = 0; index < countHashes.length; index += 1) {
      const countHash = countHashes[index] ?? {};
      const lastHash = lastHashes[index] ?? {};
      for (const [field, rawCount] of Object.entries(countHash)) {
        const parsed = this.parseBackgroundDecisionField(field);
        if (!parsed) {
          continue;
        }
        const count = this.parseNonNegativeInt(rawCount);
        const lastObservedAtMs = this.parseNonNegativeInt(lastHash[field]);
        const key = `${parsed.component}\u0000${parsed.sourceTag}\u0000${parsed.action}\u0000${parsed.reason}`;
        const existing = aggregate.get(key);
        if (existing) {
          existing.descriptor.count += count;
          existing.lastObservedAtMs = Math.max(existing.lastObservedAtMs, lastObservedAtMs);
          continue;
        }
        aggregate.set(key, {
          descriptor: {
            ...parsed,
            count,
            lastObservedAt: null,
          },
          lastObservedAtMs,
        });
      }
    }

    const pauseReasons = [...aggregate.values()]
      .map((entry) => ({
        ...entry.descriptor,
        lastObservedAt:
          entry.lastObservedAtMs > 0 ? new Date(entry.lastObservedAtMs).toISOString() : null,
      }))
      .sort(
        (left, right) =>
          right.count - left.count ||
          Date.parse(right.lastObservedAt ?? '') - Date.parse(left.lastObservedAt ?? ''),
      )
      .slice(0, 8);

    return {
      windowSec: this.backgroundReasonWindowSec,
      pauseReasons,
    };
  }

  private async getBurstSnapshot(): Promise<RuntimeDiagnosticsDashboardSnapshot['burst']> {
    const state = await this.readBurstState();
    if (!state) {
      return {
        active: false,
        peakLagSec: 0,
        peakBotId: null,
        startedAt: null,
        lastRecoveredAt: null,
        sampleAgeMs: 0,
      };
    }

    return {
      active: state.active,
      peakLagSec: Number(state.peakLagSec.toFixed(3)),
      peakBotId: state.peakBotId,
      startedAt: state.startedAtMs ? new Date(state.startedAtMs).toISOString() : null,
      lastRecoveredAt: state.lastRecoveredAtMs
        ? new Date(state.lastRecoveredAtMs).toISOString()
        : null,
      sampleAgeMs: Math.max(0, Date.now() - state.updatedAtMs),
    };
  }

  private async getHotPathSummary(): Promise<RuntimeDiagnosticsDashboardSnapshot['hotPath']> {
    const bucketKeys = this.buildWindowBucketKeys(HOT_PATH_BUCKET_PREFIX, this.hotPathWindowSec);
    const hashes = await this.readHashes(bucketKeys);
    const stages = new Map<
      string,
      {
        count: number;
        slowCount: number;
        timeoutCount: number;
        skipCount: number;
        failOpenCount: number;
        elapsedTotalMs: number;
        maxElapsedMs: number;
        lastObservedAtMs: number;
      }
    >();

    for (const hash of hashes) {
      for (const [field, rawValue] of Object.entries(hash)) {
        const separatorIndex = field.lastIndexOf('|');
        if (separatorIndex <= 0) {
          continue;
        }
        const stage = field.slice(0, separatorIndex);
        const metric = field.slice(separatorIndex + 1);
        const numericValue = this.parseNonNegativeInt(rawValue);
        const bucket =
          stages.get(stage) ??
          {
            count: 0,
            slowCount: 0,
            timeoutCount: 0,
            skipCount: 0,
            failOpenCount: 0,
            elapsedTotalMs: 0,
            maxElapsedMs: 0,
            lastObservedAtMs: 0,
          };
        if (metric === 'count') {
          bucket.count += numericValue;
        } else if (metric === 'slowCount') {
          bucket.slowCount += numericValue;
        } else if (metric === 'timeoutCount') {
          bucket.timeoutCount += numericValue;
        } else if (metric === 'skipCount') {
          bucket.skipCount += numericValue;
        } else if (metric === 'failOpenCount') {
          bucket.failOpenCount += numericValue;
        } else if (metric === 'elapsedTotalMs') {
          bucket.elapsedTotalMs += numericValue;
        } else if (metric === 'lastObservedAtMs') {
          bucket.lastObservedAtMs = Math.max(bucket.lastObservedAtMs, numericValue);
        } else if (metric === 'maxElapsedMs') {
          bucket.maxElapsedMs = Math.max(bucket.maxElapsedMs, numericValue);
        }
        stages.set(stage, bucket);
      }
    }

    const allNormalizedStages: HotPathStageSummary[] = [...stages.entries()]
      .map(([stage, value]) => ({
        stage,
        count: value.count,
        slowCount: value.slowCount,
        timeoutCount: value.timeoutCount,
        skipCount: value.skipCount,
        failOpenCount: value.failOpenCount,
        avgElapsedMs:
          value.count > 0 ? Number((value.elapsedTotalMs / value.count).toFixed(1)) : 0,
        maxElapsedMs: value.maxElapsedMs,
        lastObservedAt:
          value.lastObservedAtMs > 0 ? new Date(value.lastObservedAtMs).toISOString() : null,
      }))
      .sort(
        (left, right) =>
          right.timeoutCount - left.timeoutCount ||
          right.slowCount - left.slowCount ||
          right.skipCount - left.skipCount ||
          right.maxElapsedMs - left.maxElapsedMs ||
          right.count - left.count,
      );
    const normalizedStages = allNormalizedStages.slice(0, 12);

    return {
      windowSec: this.hotPathWindowSec,
      failOpenCount: allNormalizedStages.reduce((sum, item) => sum + item.failOpenCount, 0),
      stages: normalizedStages,
    };
  }

  private async getHotChatsSummary(): Promise<RuntimeDiagnosticsDashboardSnapshot['hotChats']> {
    const countHashes = await this.readHashes(
      this.buildWindowBucketKeys(HOT_CHAT_COUNT_BUCKET_PREFIX, this.hotChatWindowSec),
    );
    const lastHashes = await this.readHashes(
      this.buildWindowBucketKeys(HOT_CHAT_LAST_BUCKET_PREFIX, this.hotChatWindowSec),
    );
    const botHashes = await this.readHashes(
      this.buildWindowBucketKeys(HOT_CHAT_BOT_BUCKET_PREFIX, this.hotChatWindowSec),
    );

    const aggregate = new Map<
      string,
      {
        count: number;
        lastObservedAtMs: number;
        botIds: Set<string>;
      }
    >();

    for (const hash of countHashes) {
      for (const [chatId, rawCount] of Object.entries(hash)) {
        const entry =
          aggregate.get(chatId) ??
          {
            count: 0,
            lastObservedAtMs: 0,
            botIds: new Set<string>(),
          };
        entry.count += this.parseNonNegativeInt(rawCount);
        aggregate.set(chatId, entry);
      }
    }

    for (const hash of lastHashes) {
      for (const [chatId, rawLastObservedAtMs] of Object.entries(hash)) {
        const entry =
          aggregate.get(chatId) ??
          {
            count: 0,
            lastObservedAtMs: 0,
            botIds: new Set<string>(),
          };
        entry.lastObservedAtMs = Math.max(
          entry.lastObservedAtMs,
          this.parseNonNegativeInt(rawLastObservedAtMs),
        );
        aggregate.set(chatId, entry);
      }
    }

    for (const hash of botHashes) {
      for (const field of Object.keys(hash)) {
        const separatorIndex = field.indexOf('\t');
        if (separatorIndex <= 0) {
          continue;
        }
        const chatId = field.slice(0, separatorIndex);
        const botId = field.slice(separatorIndex + 1);
        const entry =
          aggregate.get(chatId) ??
          {
            count: 0,
            lastObservedAtMs: 0,
            botIds: new Set<string>(),
          };
        if (botId) {
          entry.botIds.add(botId);
        }
        aggregate.set(chatId, entry);
      }
    }

    const items = [...aggregate.entries()]
      .map(([chatId, entry]) => ({
        chatId,
        messageCreatedCount: entry.count,
        botsSeen: Math.max(1, entry.botIds.size || 0),
        lastSeenAt: new Date(entry.lastObservedAtMs || Date.now()).toISOString(),
      }))
      .sort(
        (left, right) =>
          right.messageCreatedCount - left.messageCreatedCount ||
          Date.parse(right.lastSeenAt) - Date.parse(left.lastSeenAt),
      )
      .slice(0, 12);

    return {
      windowSec: this.hotChatWindowSec,
      items,
    };
  }

  private async getMembershipLookupSummary(): Promise<
    RuntimeDiagnosticsDashboardSnapshot['membershipLookup']
  > {
    const [hotChannels, backoffKeys, transientKeys, terminalKeys] = await Promise.all([
      this.scanKeys(`${MEMBERSHIP_HOT_PREFIX}:*`),
      this.scanKeys(`${MEMBERSHIP_BACKOFF_PREFIX}:*`),
      this.scanKeys(`${MEMBERSHIP_ISSUE_PREFIX}:transient:*`),
      this.scanKeys(`${MEMBERSHIP_ISSUE_PREFIX}:terminal:*`),
    ]);

    const [hotChannelSamples, backoffSample, transientIssues, terminalIssues] = await Promise.all([
      this.readMembershipSamples(hotChannels, 'sample'),
      this.readMembershipSamples(backoffKeys, 'sample'),
      this.readMembershipIssueSamples(transientKeys, 'transient'),
      this.readMembershipIssueSamples(terminalKeys, 'terminal'),
    ]);

    return {
      windowSec: this.membershipWindowSec,
      hotChannels: hotChannels.length,
      backoffActiveChats: backoffKeys.length,
      transientIssues: transientIssues.length,
      terminalIssues: terminalIssues.length,
      hotChannelsSample: hotChannelSamples.slice(0, 6),
      backoffSample: backoffSample.slice(0, 6),
      issueSample: [...transientIssues, ...terminalIssues]
        .sort((left, right) => Date.parse(right.lastObservedAt) - Date.parse(left.lastObservedAt))
        .slice(0, 8),
    };
  }

  private async readMembershipSamples(
    keys: readonly string[],
    _kind: 'sample',
  ): Promise<MembershipLookupSample[]> {
    const values = await this.readStrings(keys);
    return keys
      .map((key, index) => {
        const parsedKey = this.parseMembershipKey(key);
        const parsedValue = this.parseMembershipValue(values[index] ?? null);
        if (!parsedKey || !parsedValue) {
          return null;
        }
        return {
          chatId: parsedKey.chatId,
          policyName: parsedKey.policyName,
          lastObservedAt: new Date(parsedValue.observedAtMs).toISOString(),
          retryAfterMs: parsedValue.retryAfterMs,
        };
      })
      .filter((item): item is MembershipLookupSample => item !== null)
      .sort((left, right) => Date.parse(right.lastObservedAt) - Date.parse(left.lastObservedAt));
  }

  private async readMembershipIssueSamples(
    keys: readonly string[],
    kind: 'transient' | 'terminal',
  ): Promise<MembershipLookupIssueSample[]> {
    const values = await this.readStrings(keys);
    return keys
      .map((key, index) => {
        const parsedKey = this.parseMembershipKey(key);
        const parsedValue = this.parseMembershipValue(values[index] ?? null);
        if (!parsedKey || !parsedValue) {
          return null;
        }
        return {
          chatId: parsedKey.chatId,
          policyName: parsedKey.policyName,
          kind,
          lastObservedAt: new Date(parsedValue.observedAtMs).toISOString(),
          retryAfterMs: parsedValue.retryAfterMs,
        };
      })
      .filter((item): item is MembershipLookupIssueSample => item !== null)
      .sort((left, right) => Date.parse(right.lastObservedAt) - Date.parse(left.lastObservedAt));
  }

  private resolvePeakLagBotId(
    bots: Record<
      string,
      {
        effectiveLagSec?: number;
        userFacingEffectiveLagSec?: number;
      }
    > | null | undefined,
  ): string | null {
    let bestBotId: string | null = null;
    let bestLag = Number.NEGATIVE_INFINITY;
    for (const [botId, metrics] of Object.entries(bots ?? {})) {
      const lag =
        typeof metrics.userFacingEffectiveLagSec === 'number'
          ? metrics.userFacingEffectiveLagSec
          : typeof metrics.effectiveLagSec === 'number'
            ? metrics.effectiveLagSec
            : Number.NEGATIVE_INFINITY;
      if (lag > bestLag) {
        bestLag = lag;
        bestBotId = botId;
      }
    }
    return bestBotId;
  }

  private async readBurstState(): Promise<{
    active: boolean;
    peakLagSec: number;
    peakBotId: string | null;
    startedAtMs: number | null;
    lastRecoveredAtMs: number | null;
    updatedAtMs: number;
  } | null> {
    const raw = await this.redis.get(BURST_STATE_KEY);
    if (!raw) {
      return null;
    }

    try {
      const parsed = JSON.parse(raw) as {
        active?: unknown;
        peakLagSec?: unknown;
        peakBotId?: unknown;
        startedAtMs?: unknown;
        lastRecoveredAtMs?: unknown;
        updatedAtMs?: unknown;
      };
      if (
        typeof parsed.active !== 'boolean' ||
        typeof parsed.peakLagSec !== 'number' ||
        typeof parsed.updatedAtMs !== 'number'
      ) {
        return null;
      }
      return {
        active: parsed.active,
        peakLagSec: parsed.peakLagSec,
        peakBotId: typeof parsed.peakBotId === 'string' ? parsed.peakBotId : null,
        startedAtMs: typeof parsed.startedAtMs === 'number' ? parsed.startedAtMs : null,
        lastRecoveredAtMs:
          typeof parsed.lastRecoveredAtMs === 'number' ? parsed.lastRecoveredAtMs : null,
        updatedAtMs: parsed.updatedAtMs,
      };
    } catch {
      return null;
    }
  }

  private buildWindowBucketKeys(prefix: string, windowSec: number): string[] {
    const nowMs = Date.now();
    const windowBucketCount = Math.max(1, Math.ceil(windowSec / BUCKET_SPAN_SEC));
    const keys: string[] = [];
    for (let index = 0; index < windowBucketCount; index += 1) {
      keys.push(
        this.buildBucketKey(prefix, nowMs - index * BUCKET_SPAN_SEC * 1_000),
      );
    }
    return keys;
  }

  private buildBucketKey(prefix: string, nowMs: number): string {
    const bucketStartSec = Math.floor(nowMs / (BUCKET_SPAN_SEC * 1_000)) * BUCKET_SPAN_SEC;
    return `${prefix}:${bucketStartSec}`;
  }

  private resolveBucketTtlSec(windowSec: number): number {
    return Math.max(windowSec + BUCKET_SPAN_SEC * 2, BUCKET_SPAN_SEC * 4);
  }

  private async readHashes(keys: readonly string[]): Promise<Array<Record<string, string>>> {
    if (keys.length === 0) {
      return [];
    }
    const pipeline = this.redis.pipeline();
    keys.forEach((key) => pipeline.hgetall(key));
    const results = await pipeline.exec();
    if (!results) {
      return keys.map(() => ({}));
    }
    return results.map((entry) => {
      const [, value] = entry;
      return this.isStringRecord(value) ? value : {};
    });
  }

  private async readStrings(keys: readonly string[]): Promise<Array<string | null>> {
    if (keys.length === 0) {
      return [];
    }

    const values = await this.redis.mget(...keys);
    return values.map((value) => (typeof value === 'string' ? value : null));
  }

  private parseBackgroundDecisionField(
    value: string,
  ): Omit<BackgroundPauseReasonSummary, 'count' | 'lastObservedAt'> | null {
    try {
      const parsed = JSON.parse(value) as {
        component?: unknown;
        sourceTag?: unknown;
        action?: unknown;
        reason?: unknown;
      };
      if (
        typeof parsed.component !== 'string' ||
        typeof parsed.sourceTag !== 'string' ||
        (parsed.action !== 'run' && parsed.action !== 'slow' && parsed.action !== 'pause') ||
        typeof parsed.reason !== 'string'
      ) {
        return null;
      }
      return {
        component: parsed.component,
        sourceTag: parsed.sourceTag,
        action: parsed.action,
        reason: parsed.reason,
      };
    } catch {
      return null;
    }
  }

  private async setEphemeralMembershipEntry(
    key: string,
    value: {
      observedAtMs: number;
      retryAfterMs: number | null;
    },
  ): Promise<void> {
    const retryAfterMs = Math.max(1_000, Math.ceil(value.retryAfterMs ?? 0));
    await this.redis.set(
      key,
      JSON.stringify({
        observedAtMs: value.observedAtMs,
        retryAfterMs: value.retryAfterMs,
      }),
      'PX',
      retryAfterMs,
    );
  }

  private buildMembershipKey(prefix: string, policyName: string, chatId: string): string | null {
    const normalizedPolicy = policyName.trim();
    const normalizedChatId = chatId.trim();
    if (!normalizedPolicy || !normalizedChatId) {
      return null;
    }
    return `${prefix}:${normalizedPolicy}:${normalizedChatId}`;
  }

  private parseMembershipKey(key: string): { policyName: string; chatId: string } | null {
    const parts = key.split(':');
    if (parts.length < 2) {
      return null;
    }
    const chatId = parts.at(-1)?.trim() ?? '';
    const policyName = parts.at(-2)?.trim() ?? '';
    if (!chatId || !policyName) {
      return null;
    }
    return {
      policyName,
      chatId,
    };
  }

  private parseMembershipValue(raw: string | null): { observedAtMs: number; retryAfterMs: number | null } | null {
    if (!raw) {
      return null;
    }
    try {
      const parsed = JSON.parse(raw) as {
        observedAtMs?: unknown;
        retryAfterMs?: unknown;
      };
      if (typeof parsed.observedAtMs !== 'number') {
        return null;
      }
      return {
        observedAtMs: parsed.observedAtMs,
        retryAfterMs:
          typeof parsed.retryAfterMs === 'number' ? Math.max(0, Math.ceil(parsed.retryAfterMs)) : null,
      };
    } catch {
      return null;
    }
  }

  private async scanKeys(pattern: string): Promise<string[]> {
    const keys: string[] = [];
    let cursor = '0';
    do {
      const [nextCursor, chunk] = await this.redis.scan(
        cursor,
        'MATCH',
        pattern,
        'COUNT',
        String(this.redisScanCount),
      );
      cursor = nextCursor;
      if (Array.isArray(chunk) && chunk.length > 0) {
        keys.push(...chunk);
      }
    } while (cursor !== '0');
    return keys;
  }

  private readNumericRecord(value: unknown): Record<string, number> {
    if (!this.isNumberRecord(value)) {
      return {};
    }

    return Object.fromEntries(
      Object.entries(value)
        .filter((entry): entry is [string, number] => Number.isFinite(entry[1]))
        .map(([key, numericValue]) => [key, numericValue]),
    );
  }

  private isStringRecord(value: unknown): value is Record<string, string> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  private isNumberRecord(value: unknown): value is Record<string, number> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  private parseNonNegativeInt(value: unknown): number {
    const numericValue =
      typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
    if (!Number.isFinite(numericValue) || numericValue < 0) {
      return 0;
    }
    return Math.trunc(numericValue);
  }

  private async execPipeline(
    pipeline: ReturnType<Redis['pipeline']>,
    context: string,
  ): Promise<void> {
    try {
      await pipeline.exec();
    } catch (error: unknown) {
      this.logger.debug(
        { context, err: error instanceof Error ? error.message : String(error) },
        'Runtime diagnostics write failed',
      );
    }
  }

  private readPositiveInt(value: unknown, fallback: number): number {
    const numericValue = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(numericValue) || numericValue <= 0) {
      return fallback;
    }
    return Math.max(1, Math.trunc(numericValue));
  }

  private readPositiveNumber(value: unknown, fallback: number): number {
    const numericValue = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(numericValue) || numericValue <= 0) {
      return fallback;
    }
    return numericValue;
  }
}
