import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { createHash } from 'node:crypto';
import { getAppRole, roleRunsEnqueue, roleRunsIngress } from '../runtime/app-role';
import {
  PUBLISHER_AUTO_REPLY_FLOOD_GATE_BOUNDS,
  PUBLISHER_AUTO_REPLY_FLOOD_GATE_BURST_WINDOW_SEC,
  PUBLISHER_AUTO_REPLY_FLOOD_GATE_DECISION_TTL_SEC,
  PUBLISHER_AUTO_REPLY_FLOOD_GATE_DEFAULTS,
  PUBLISHER_AUTO_REPLY_FLOOD_GATE_ROLLING_WINDOW_SEC,
} from './publisher-auto-reply-flood-gate.config';

const FLOOD_GATE_KEY_PREFIX = 'publisher:auto-reply:flood:v1';
const AMBIGUOUS_LOG_INTERVAL_MS = 10_000;
const DENIAL_LOG_INTERVAL_MS = 10_000;
const UNAVAILABLE_LOG_INTERVAL_MS = 10_000;

const PUBLISHER_AUTO_REPLY_FLOOD_GATE_SCRIPT = `
-- MAXIM_PUBLISHER_AUTO_REPLY_FLOOD_GATE_V1
local replay_only = tonumber(ARGV[12])
if replay_only ~= 0 and replay_only ~= 1 then
  return {-1, 0}
end

local decision_raw = redis.call('GET', KEYS[1])
if decision_raw then
  local decision = tonumber(decision_raw)
  if not decision then
    return {-1, 0}
  end
  if decision == 1 then
    return {2, 0}
  end
  if decision >= 11 and decision <= 16 then
    return {0, decision - 10}
  end
  return {-1, 0}
end

if replay_only == 1 then
  return {3, 0}
end

local redis_time = redis.call('TIME')
local now_ms = (tonumber(redis_time[1]) * 1000) + math.floor(tonumber(redis_time[2]) / 1000)
if now_ms >= tonumber(ARGV[1]) then
  return {-2, 0}
end

local upstream_denial = tonumber(ARGV[11])
if not upstream_denial or (upstream_denial ~= 0 and upstream_denial ~= 5 and upstream_denial ~= 6) then
  return {-1, 0}
end
if upstream_denial ~= 0 then
  redis.call('SET', KEYS[1], tostring(upstream_denial + 10), 'EX', ARGV[5])
  return {0, upstream_denial}
end

local rolling_window_ms = tonumber(ARGV[4]) * 1000
local rolling_cutoff_ms = now_ms - rolling_window_ms
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', rolling_cutoff_ms)
redis.call('ZREMRANGEBYSCORE', KEYS[3], '-inf', rolling_cutoff_ms)

local user_member = redis.call('ZSCORE', KEYS[2], ARGV[2])
local chat_member = redis.call('ZSCORE', KEYS[3], ARGV[2])
if user_member and chat_member then
  redis.call('SET', KEYS[1], '1', 'EX', ARGV[5])
  return {2, 0}
end
if user_member or chat_member then
  return {-1, 0}
end

local burst_min = '(' .. tostring(now_ms - (tonumber(ARGV[3]) * 1000))
local user_burst = redis.call('ZCOUNT', KEYS[2], burst_min, '+inf')
local user_rolling = redis.call('ZCARD', KEYS[2])
local chat_burst = redis.call('ZCOUNT', KEYS[3], burst_min, '+inf')
local chat_rolling = redis.call('ZCARD', KEYS[3])
local deny_reason = 0
if user_burst >= tonumber(ARGV[7]) then
  deny_reason = 1
elseif user_rolling >= tonumber(ARGV[8]) then
  deny_reason = 2
elseif chat_burst >= tonumber(ARGV[9]) then
  deny_reason = 3
elseif chat_rolling >= tonumber(ARGV[10]) then
  deny_reason = 4
end
if deny_reason ~= 0 then
  redis.call('SET', KEYS[1], tostring(deny_reason + 10), 'EX', ARGV[5])
  return {0, deny_reason, user_burst, user_rolling, chat_burst, chat_rolling}
end

redis.call('ZADD', KEYS[2], now_ms, ARGV[2])
redis.call('ZADD', KEYS[3], now_ms, ARGV[2])
redis.call('PEXPIRE', KEYS[2], tonumber(ARGV[6]) * 1000)
redis.call('PEXPIRE', KEYS[3], tonumber(ARGV[6]) * 1000)
redis.call('SET', KEYS[1], '1', 'EX', ARGV[5])
user_burst = user_burst + 1
user_rolling = user_rolling + 1
chat_burst = chat_burst + 1
chat_rolling = chat_rolling + 1
return {1, 0, user_burst, user_rolling, chat_burst, chat_rolling}
`;

export type PublisherAutoReplyFloodGateDenialReason =
  | 'user_burst'
  | 'user_rolling'
  | 'chat_burst'
  | 'chat_rolling'
  | 'backlog_limit'
  | 'backlog_unavailable'
  | 'decision_missing'
  | 'unavailable';

export type PublisherAutoReplyFloodGateResult =
  | { allowed: true; replayed: boolean }
  | { allowed: false; reason: PublisherAutoReplyFloodGateDenialReason };

export class PublisherAutoReplyFloodGateAmbiguousError extends Error {
  readonly code = 'PUBLISHER_AUTO_REPLY_FLOOD_GATE_AMBIGUOUS';

  constructor(cause?: unknown) {
    super('Publisher auto-reply flood-gate outcome is ambiguous', { cause });
    this.name = 'PublisherAutoReplyFloodGateAmbiguousError';
  }
}

type FloodGateLimits = {
  userBurstLimit: number;
  userRollingLimit: number;
  chatBurstLimit: number;
  chatRollingLimit: number;
};

type ObservableDenialReason = Exclude<PublisherAutoReplyFloodGateDenialReason, 'unavailable'>;

type FloodGateIdentity = {
  publisherBotId: string;
  chatId: string;
  senderUserId: string;
  sourceMessageId: string;
};

@Injectable()
export class PublisherAutoReplyFloodGateService implements OnModuleDestroy {
  private readonly logger = new Logger(PublisherAutoReplyFloodGateService.name);
  private readonly redis: Redis | null;
  private readonly limits: FloodGateLimits;
  private readonly commandTimeoutMs: number;
  private readonly denialCounts: Record<ObservableDenialReason, number> = {
    user_burst: 0,
    user_rolling: 0,
    chat_burst: 0,
    chat_rolling: 0,
    backlog_limit: 0,
    backlog_unavailable: 0,
    decision_missing: 0,
  };
  private lastAmbiguousLogAtMs = 0;
  private lastDenialLogAtMs = 0;
  private lastUnavailableLogAtMs = 0;

  constructor(configService: ConfigService) {
    this.limits = {
      userBurstLimit: this.readBoundedInt(
        configService,
        'PUBLISHER_AUTO_REPLY_USER_BURST_LIMIT',
        PUBLISHER_AUTO_REPLY_FLOOD_GATE_DEFAULTS.userBurstLimit,
        PUBLISHER_AUTO_REPLY_FLOOD_GATE_BOUNDS.userBurstLimit,
      ),
      userRollingLimit: this.readBoundedInt(
        configService,
        'PUBLISHER_AUTO_REPLY_USER_ROLLING_LIMIT',
        PUBLISHER_AUTO_REPLY_FLOOD_GATE_DEFAULTS.userRollingLimit,
        PUBLISHER_AUTO_REPLY_FLOOD_GATE_BOUNDS.userRollingLimit,
      ),
      chatBurstLimit: this.readBoundedInt(
        configService,
        'PUBLISHER_AUTO_REPLY_CHAT_BURST_LIMIT',
        PUBLISHER_AUTO_REPLY_FLOOD_GATE_DEFAULTS.chatBurstLimit,
        PUBLISHER_AUTO_REPLY_FLOOD_GATE_BOUNDS.chatBurstLimit,
      ),
      chatRollingLimit: this.readBoundedInt(
        configService,
        'PUBLISHER_AUTO_REPLY_CHAT_ROLLING_LIMIT',
        PUBLISHER_AUTO_REPLY_FLOOD_GATE_DEFAULTS.chatRollingLimit,
        PUBLISHER_AUTO_REPLY_FLOOD_GATE_BOUNDS.chatRollingLimit,
      ),
    };
    if (
      this.limits.userRollingLimit < this.limits.userBurstLimit ||
      this.limits.chatRollingLimit < this.limits.chatBurstLimit ||
      this.limits.chatBurstLimit < this.limits.userBurstLimit ||
      this.limits.chatRollingLimit < this.limits.userRollingLimit
    ) {
      throw new Error(
        'Publisher auto-reply rolling limits must cover burst limits and chat limits must cover user limits',
      );
    }

    this.commandTimeoutMs = this.readBoundedInt(
      configService,
      'PUBLISHER_AUTO_REPLY_FLOOD_GATE_REDIS_TIMEOUT_MS',
      PUBLISHER_AUTO_REPLY_FLOOD_GATE_DEFAULTS.redisTimeoutMs,
      PUBLISHER_AUTO_REPLY_FLOOD_GATE_BOUNDS.redisTimeoutMs,
    );
    const role = getAppRole();
    if (!roleRunsIngress(role) && !roleRunsEnqueue(role)) {
      this.redis = null;
      return;
    }

    this.redis = new Redis(configService.getOrThrow<string>('REDIS_URL'), {
      commandTimeout: this.commandTimeoutMs,
      connectTimeout: Math.max(250, this.commandTimeoutMs),
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
    });
    this.redis.on('error', (error) => this.logUnavailable(error));
  }

  onModuleDestroy(): void {
    this.redis?.disconnect(false);
  }

  async reserve(
    params: FloodGateIdentity & {
      upstreamDenialReason?: 'backlog_limit' | 'backlog_unavailable';
    },
  ): Promise<PublisherAutoReplyFloodGateResult> {
    return this.evaluate(params, false);
  }

  async replay(params: FloodGateIdentity): Promise<PublisherAutoReplyFloodGateResult> {
    return this.evaluate(params, true);
  }

  private async evaluate(
    params: FloodGateIdentity & {
      upstreamDenialReason?: 'backlog_limit' | 'backlog_unavailable';
    },
    replayOnly: boolean,
  ): Promise<PublisherAutoReplyFloodGateResult> {
    if (!this.redis) {
      this.logUnavailable({ code: 'REDIS_CLIENT_UNAVAILABLE' });
      return { allowed: false, reason: 'unavailable' };
    }
    let keys: string[];
    let memberDigest: string;
    try {
      ({ keys, memberDigest } = this.buildKeys(params));
    } catch (error: unknown) {
      this.logUnavailable(error);
      return { allowed: false, reason: 'unavailable' };
    }
    if (this.redis.status !== 'ready') {
      this.logUnavailable({ code: `REDIS_${this.redis.status.toUpperCase()}` });
      return { allowed: false, reason: 'unavailable' };
    }

    let raw: unknown;
    try {
      raw = await this.redis.eval(
        PUBLISHER_AUTO_REPLY_FLOOD_GATE_SCRIPT,
        keys.length,
        ...keys,
        Date.now() + this.commandTimeoutMs,
        memberDigest,
        PUBLISHER_AUTO_REPLY_FLOOD_GATE_BURST_WINDOW_SEC,
        PUBLISHER_AUTO_REPLY_FLOOD_GATE_ROLLING_WINDOW_SEC,
        PUBLISHER_AUTO_REPLY_FLOOD_GATE_DECISION_TTL_SEC,
        PUBLISHER_AUTO_REPLY_FLOOD_GATE_ROLLING_WINDOW_SEC + 1,
        this.limits.userBurstLimit,
        this.limits.userRollingLimit,
        this.limits.chatBurstLimit,
        this.limits.chatRollingLimit,
        this.encodeUpstreamDenialReason(params.upstreamDenialReason),
        replayOnly ? 1 : 0,
      );
    } catch (error: unknown) {
      this.logAmbiguous(error);
      throw new PublisherAutoReplyFloodGateAmbiguousError(error);
    }

    try {
      const result = this.parseResult(raw);
      if (replayOnly && result.allowed && !result.replayed) {
        throw new Error('Redis returned a new reservation from replay-only flood-gate mode');
      }
      return result;
    } catch (error: unknown) {
      if (this.isDefinitiveNoAdmissionResult(raw)) {
        this.logUnavailable(error);
        return { allowed: false, reason: 'unavailable' };
      }
      this.logAmbiguous(error);
      throw new PublisherAutoReplyFloodGateAmbiguousError(error);
    }
  }

  private buildKeys(params: {
    publisherBotId: string;
    chatId: string;
    senderUserId: string;
    sourceMessageId: string;
  }): { keys: string[]; memberDigest: string } {
    const publisherBotId = this.requireIdentity(params.publisherBotId, 'publisherBotId');
    const chatId = this.requireIdentity(params.chatId, 'chatId');
    const senderUserId = this.requireIdentity(params.senderUserId, 'senderUserId');
    const sourceMessageId = this.requireIdentity(params.sourceMessageId, 'sourceMessageId');
    const chatDigest = this.digestIdentity('chat', publisherBotId, chatId);
    const userDigest = this.digestIdentity('user', publisherBotId, chatId, senderUserId);
    const decisionDigest = this.digestIdentity('decision', publisherBotId, chatId, sourceMessageId);
    return {
      keys: [
        `${FLOOD_GATE_KEY_PREFIX}:{${chatDigest}}:decision:${decisionDigest}`,
        `${FLOOD_GATE_KEY_PREFIX}:{${chatDigest}}:user:${userDigest}`,
        `${FLOOD_GATE_KEY_PREFIX}:{${chatDigest}}:chat`,
      ],
      memberDigest: decisionDigest,
    };
  }

  private parseResult(raw: unknown): PublisherAutoReplyFloodGateResult {
    if (!Array.isArray(raw) || raw.length < 2) {
      throw new Error('Redis returned an invalid Publisher auto-reply flood-gate result');
    }
    const status = Number(raw[0]);
    const reason = Number(raw[1]);
    if ((status === 1 || status === 2) && reason === 0) {
      return { allowed: true, replayed: status === 2 };
    }
    if (status === 3 && reason === 0) {
      this.recordDenial('decision_missing');
      return { allowed: false, reason: 'decision_missing' };
    }
    const denialReasons = [
      'user_burst',
      'user_rolling',
      'chat_burst',
      'chat_rolling',
      'backlog_limit',
      'backlog_unavailable',
    ] as const;
    if (status === 0 && Number.isSafeInteger(reason) && reason >= 1 && reason <= 6) {
      const denialReason = denialReasons[reason - 1]!;
      this.recordDenial(denialReason);
      return { allowed: false, reason: denialReason };
    }
    throw new Error('Redis returned an invalid Publisher auto-reply flood-gate decision');
  }

  private digestIdentity(domain: string, ...parts: string[]): string {
    return createHash('sha256')
      .update(JSON.stringify([domain, ...parts]))
      .digest('hex')
      .slice(0, 32);
  }

  private isDefinitiveNoAdmissionResult(raw: unknown): boolean {
    if (!Array.isArray(raw) || raw.length < 2) {
      return false;
    }
    const status = Number(raw[0]);
    const reason = Number(raw[1]);
    return (status === -1 || status === -2) && reason === 0;
  }

  private encodeUpstreamDenialReason(
    reason: 'backlog_limit' | 'backlog_unavailable' | undefined,
  ): number {
    if (!reason) {
      return 0;
    }
    return reason === 'backlog_limit' ? 5 : 6;
  }

  private requireIdentity(value: string, label: string): string {
    const normalized = value.trim();
    if (!normalized) {
      throw new Error(`Publisher auto-reply flood gate ${label} is required`);
    }
    return normalized;
  }

  private readBoundedInt(
    configService: ConfigService,
    key: string,
    fallback: number,
    bounds: { min: number; max: number },
  ): number {
    const value = configService.get<number>(key, fallback);
    if (!Number.isSafeInteger(value) || value < bounds.min || value > bounds.max) {
      throw new Error(`${key} must be an integer between ${bounds.min} and ${bounds.max}`);
    }
    return value;
  }

  private recordDenial(reason: ObservableDenialReason): void {
    this.denialCounts[reason] += 1;
    const nowMs = Date.now();
    if (nowMs - this.lastDenialLogAtMs < DENIAL_LOG_INTERVAL_MS) {
      return;
    }
    this.lastDenialLogAtMs = nowMs;
    const reasonCounts = Object.fromEntries(
      Object.entries(this.denialCounts).filter(([, count]) => count > 0),
    );
    for (const key of Object.keys(this.denialCounts) as ObservableDenialReason[]) {
      this.denialCounts[key] = 0;
    }
    this.logger.warn({ reasonCounts }, 'Publisher auto-reply admission suppressed deliveries');
  }

  private logAmbiguous(error: unknown): void {
    const nowMs = Date.now();
    if (nowMs - this.lastAmbiguousLogAtMs < AMBIGUOUS_LOG_INTERVAL_MS) {
      return;
    }
    this.lastAmbiguousLogAtMs = nowMs;
    const code = (error as { code?: unknown } | null)?.code;
    this.logger.warn(
      { code: typeof code === 'string' && code.trim() ? code.trim().slice(0, 80) : 'UNKNOWN' },
      'Publisher auto-reply flood-gate outcome is ambiguous; webhook preparation will retry',
    );
  }

  private logUnavailable(error: unknown): void {
    const nowMs = Date.now();
    if (nowMs - this.lastUnavailableLogAtMs < UNAVAILABLE_LOG_INTERVAL_MS) {
      return;
    }
    this.lastUnavailableLogAtMs = nowMs;
    const code = (error as { code?: unknown } | null)?.code;
    this.logger.warn(
      { code: typeof code === 'string' && code.trim() ? code.trim().slice(0, 80) : 'UNKNOWN' },
      'Publisher auto-reply flood gate is unavailable; delivery was suppressed',
    );
  }
}
