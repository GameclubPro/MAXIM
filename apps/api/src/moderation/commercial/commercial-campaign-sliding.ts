import { createHash } from 'node:crypto';
import type { CommercialCampaignContext } from '../commercial-campaign.util';

export const COMMERCIAL_SLIDING_CAMPAIGN_COHORT = 'sliding-campaign-v1';
export const COMMERCIAL_SLIDING_CAMPAIGN_MAX_MEMBERS = 256;
export const COMMERCIAL_SLIDING_CAMPAIGN_MAX_KEYS_PER_WINDOW = 20_000;
export const COMMERCIAL_SLIDING_CAMPAIGN_MAX_FUTURE_SKEW_MS = 30_000;

export function buildCommercialCampaignSlidingSenderVelocityChatsKey(
  senderId: string,
  windowSeconds: number,
): string {
  const senderDigest = createHash('sha256').update(senderId).digest('hex');
  return `commercial-campaign:sliding:v1:sender:${senderDigest}:velocity:${windowSeconds}:chats`;
}

export function fingerprintCommercialCampaignSlidingMember(chatId: string): string {
  return createHash('sha256').update(chatId).digest('hex');
}

// FLAG: Server time bounds storage; an older event never reads newer chats or regresses lastSeen.
// LastSeen-only history can undercount an older event after the same chat has a newer observation.
export const COMMERCIAL_CAMPAIGN_SLIDING_WINDOW_SCRIPT = `
local time = redis.call('TIME')
local now_ms = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local event_ms = tonumber(ARGV[2])
local window_ms = tonumber(ARGV[3]) * 1000
local member_limit = tonumber(ARGV[4])
if event_ms <= now_ms - window_ms or event_ms > now_ms + tonumber(ARGV[5]) then
  return {0, 0}
end
event_ms = math.min(event_ms, now_ms)
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now_ms - window_ms)
local previous = tonumber(redis.call('ZSCORE', KEYS[1], ARGV[1]))
if not previous or event_ms > previous then
  redis.call('ZADD', KEYS[1], event_ms, ARGV[1])
end
local stored_size = redis.call('ZCARD', KEYS[1])
local saturated = 0
if stored_size > member_limit then
  redis.call('ZREMRANGEBYRANK', KEYS[1], 0, stored_size - member_limit - 1)
  saturated = 1
end
redis.call('PEXPIRE', KEYS[1], window_ms)
local size = redis.call('ZCOUNT', KEYS[1], '(' .. tostring(event_ms - window_ms), event_ms)
return {size, saturated}
`;

const SLIDING_VELOCITY_FIELDS = [
  ['senderDistinctChatCount5m', 'shadowSlidingSenderDistinctChatCount5m'],
  ['senderDistinctChatCount30m', 'shadowSlidingSenderDistinctChatCount30m'],
  ['senderDistinctChatCount120m', 'shadowSlidingSenderDistinctChatCount120m'],
] as const;

export function resolveCommercialSlidingCampaignPolicyContext(
  context: CommercialCampaignContext | null | undefined,
  promotedPolicyCohorts: readonly string[] = [],
): { context: CommercialCampaignContext | null | undefined; requiredPolicyCohorts: string[] } {
  if (!context || !promotedPolicyCohorts.includes(COMMERCIAL_SLIDING_CAMPAIGN_COHORT)) {
    return { context, requiredPolicyCohorts: [] };
  }
  const effectiveContext = { ...context };
  let changed = false;
  for (const [currentField, shadowField] of SLIDING_VELOCITY_FIELDS) {
    const shadowCount = context[shadowField];
    if (shadowCount === undefined) continue;
    effectiveContext[currentField] = shadowCount;
    if (shadowCount !== (context[currentField] ?? 0)) changed = true;
  }
  return {
    context: effectiveContext,
    requiredPolicyCohorts: changed ? [COMMERCIAL_SLIDING_CAMPAIGN_COHORT] : [],
  };
}

type SlidingSet = { expiresAtMs: number; members: Map<string, number> };

export class InMemoryCommercialCampaignSlidingWindow {
  private readonly windows = new Map<number, Map<string, SlidingSet>>();
  private highWatermarkMs = 0;

  constructor(
    private readonly maxMembers = COMMERCIAL_SLIDING_CAMPAIGN_MAX_MEMBERS,
    private readonly maxKeysPerWindow = COMMERCIAL_SLIDING_CAMPAIGN_MAX_KEYS_PER_WINDOW,
  ) {}

  get retainedKeyCount(): number {
    return [...this.windows.values()].reduce((total, keys) => total + keys.size, 0);
  }

  observe(params: {
    key: string;
    chatId: string;
    eventTimestampMs: number;
    nowMs: number;
    windowSeconds: number;
  }): { size: number; saturated: boolean } {
    const nowMs = Math.max(this.highWatermarkMs, params.nowMs);
    this.highWatermarkMs = nowMs;
    this.pruneExpiredKeys(nowMs);
    const windowMs = params.windowSeconds * 1_000;
    if (
      params.eventTimestampMs <= nowMs - windowMs ||
      params.eventTimestampMs > nowMs + COMMERCIAL_SLIDING_CAMPAIGN_MAX_FUTURE_SKEW_MS
    )
      return { size: 0, saturated: false };
    const eventMs = Math.min(params.eventTimestampMs, nowMs);
    const keys = this.windows.get(params.windowSeconds) ?? new Map<string, SlidingSet>();
    this.windows.set(params.windowSeconds, keys);
    const state = keys.get(params.key) ?? {
      expiresAtMs: nowMs + windowMs,
      members: new Map<string, number>(),
    };
    for (const [member, lastSeen] of state.members) {
      if (lastSeen <= nowMs - windowMs) state.members.delete(member);
    }
    const member = fingerprintCommercialCampaignSlidingMember(params.chatId);
    state.members.set(member, Math.max(state.members.get(member) ?? 0, eventMs));
    let saturated = false;
    if (state.members.size > this.maxMembers) {
      const oldest = [...state.members.entries()].sort(
        ([leftMember, leftTime], [rightMember, rightTime]) =>
          leftTime - rightTime ||
          (leftMember < rightMember ? -1 : leftMember > rightMember ? 1 : 0),
      );
      for (let index = 0; index < oldest.length - this.maxMembers; index += 1)
        state.members.delete(oldest[index]![0]);
      saturated = true;
    }
    state.expiresAtMs = nowMs + windowMs;
    keys.delete(params.key);
    keys.set(params.key, state);
    if (keys.size > this.maxKeysPerWindow) keys.delete(keys.keys().next().value!);
    let size = 0;
    for (const lastSeen of state.members.values()) {
      if (lastSeen > eventMs - windowMs && lastSeen <= eventMs) size += 1;
    }
    return { size, saturated };
  }

  private pruneExpiredKeys(nowMs: number): void {
    for (const keys of this.windows.values()) {
      for (const [key, state] of keys) {
        if (state.expiresAtMs > nowMs) break;
        keys.delete(key);
      }
    }
  }
}
