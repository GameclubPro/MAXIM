import { normalizeAllowlistLink } from '@maxim/contracts/settings';
import { createHash } from 'node:crypto';
import type { ChatSettings } from '../prisma/prisma-client';
import { raceWithTimeout } from '../common/promise-timeout.util';
import { stripUrlsFromText } from '../common/url-text.util';
import { buildDuplicateStageKey } from './duplicate-state';
import { extractUrlsFromText } from './rule-engine-link-detector';
import { extractDetectedPhoneNumbers } from './rule-engine-message-limits.detector';
import { normalizeForDetection } from './rule-engine-normalization';
import { RedisCounterService } from './redis-counter.service';
import type {
  DuplicateAction,
  DuplicateDecision,
  DuplicateFingerprintType,
  DuplicateHit,
} from './rule-engine.contract';

export type {
  DuplicateAction,
  DuplicateDecision,
  DuplicateFingerprintType,
  DuplicateHit,
} from './rule-engine.contract';

type DuplicateReactionStage = {
  action: DuplicateAction | null;
};

type DuplicateFingerprint = {
  type: DuplicateFingerprintType;
  value: string;
};

const DUPLICATE_STATE_LOOKUP_TIMEOUT_MS = 250;
const PHONE_NUMBER_PATTERN = /(?:^|[^\d+])(\+?\d[\d\s().-]{7,}\d)(?=$|[^\d])/gu;
const NEAR_DUPLICATE_MIN_TOKEN_COUNT = 6;
const NEAR_DUPLICATE_MIN_UNIQUE_TOKENS = 5;

export class RuleEngineDuplicateDetector {
  private duplicateTimeoutWarnAtMs = 0;

  constructor(private readonly redisCounter: RedisCounterService) {}

  async detectWithin(params: {
    chatId: string;
    userId: string;
    messageId?: string;
    rawText: string;
    compactText: string;
    settings: ChatSettings;
  }): Promise<
    | {
        hit?: DuplicateHit;
        decision?: DuplicateDecision;
      }
    | undefined
  > {
    const operationPromise = this.detectState(params);

    const result = await raceWithTimeout({
      operation: operationPromise,
      timeoutMs: DUPLICATE_STATE_LOOKUP_TIMEOUT_MS,
      onTimeout: () => undefined,
    });
    if (typeof result === 'undefined') {
      this.logStateTimeout(params.chatId, params.userId);
    }
    return result;
  }

  private async detectState(params: {
    chatId: string;
    userId: string;
    messageId?: string;
    rawText: string;
    compactText: string;
    settings: ChatSettings;
  }): Promise<{
    hit?: DuplicateHit;
    decision?: DuplicateDecision;
  }> {
    const { chatId, userId, compactText, settings } = params;
    const flow = this.getFlowConfig(settings);
    const fingerprints = this.buildFingerprints(compactText, params.rawText, settings);
    let strongestHit: DuplicateHit | undefined;

    for (const fingerprint of fingerprints) {
      const hash = createHash('sha256').update(fingerprint.value).digest('hex').slice(0, 20);
      const flowKey = buildDuplicateStageKey(chatId, userId, hash, `flow:${fingerprint.type}`);
      const countResult = await this.incrementFingerprintCount({
        flowKey,
        chatId,
        userId,
        hash,
        fingerprintType: fingerprint.type,
        messageId: params.messageId,
        ttlSec: flow.windowSec + 1,
      });
      if (!countResult.inserted) {
        continue;
      }
      const total = countResult.count;
      const repeatCount = Math.max(0, total - 1);

      if (repeatCount <= flow.allowedCount) {
        continue;
      }

      if (flow.reactions.length === 0) {
        continue;
      }

      const hit: DuplicateHit = {
        count: repeatCount,
        windowSec: flow.windowSec,
        hash,
        fingerprintType: fingerprint.type,
      };
      strongestHit = this.pickStrongerHit(strongestHit, hit);

      const reactionIndex = Math.min(
        flow.reactions.length - 1,
        repeatCount - flow.allowedCount - 1,
      );
      const reaction = flow.reactions[reactionIndex];

      if (!reaction || reaction.action === null) {
        continue;
      }

      return {
        hit,
        decision: {
          action: reaction.action,
          count: repeatCount,
          threshold: flow.allowedCount + reactionIndex + 1,
          windowSec: flow.windowSec,
          hash,
          fingerprintType: fingerprint.type,
          nextAction: this.resolveNextAction(flow.reactions, reactionIndex),
        },
      };
    }

    return strongestHit ? { hit: strongestHit } : {};
  }

  private async incrementFingerprintCount(params: {
    flowKey: string;
    chatId: string;
    userId: string;
    hash: string;
    fingerprintType: DuplicateFingerprintType;
    messageId?: string;
    ttlSec: number;
  }): Promise<{ inserted: boolean; count: number }> {
    const messageId = params.messageId?.trim();
    if (!messageId) {
      return {
        inserted: true,
        count: await this.redisCounter.incrementWithTtl(params.flowKey, params.ttlSec),
      };
    }

    const messageHash = createHash('sha256').update(messageId).digest('hex').slice(0, 20);
    const messageKey = buildDuplicateStageKey(
      params.chatId,
      params.userId,
      params.hash,
      `flow:${params.fingerprintType}:msg:${messageHash}`,
    );
    return this.redisCounter.incrementOncePerMemberWithTtl(
      params.flowKey,
      messageKey,
      params.ttlSec,
    );
  }

  private getFlowConfig(settings: ChatSettings): {
    allowedCount: number;
    windowSec: number;
    reactions: DuplicateReactionStage[];
  } {
    const firstThreshold = settings.duplicateWarnEnabled
      ? settings.duplicateWarnMaxCount
      : settings.duplicateMuteEnabled
        ? settings.duplicateMuteMaxCount
        : settings.duplicateBanEnabled
          ? settings.duplicateBanMaxCount
          : settings.duplicateWarnMaxCount;
    const windowSec = settings.duplicateWarnEnabled
      ? settings.duplicateWarnWindowSec
      : settings.duplicateMuteEnabled
        ? settings.duplicateMuteWindowSec
        : settings.duplicateBanEnabled
          ? settings.duplicateBanWindowSec
          : settings.duplicateWarnWindowSec;
    const allowedCount = Math.max(
      0,
      firstThreshold - (settings.duplicateBotMessageEnabled ? 2 : 1),
    );

    return {
      allowedCount,
      windowSec,
      reactions: this.getEnabledReactions(settings),
    };
  }

  private getEnabledReactions(settings: ChatSettings): DuplicateReactionStage[] {
    const reactions: DuplicateReactionStage[] = [];

    if (settings.duplicateBotMessageEnabled) {
      reactions.push({ action: null });
    }

    if (settings.duplicateWarnEnabled) {
      reactions.push({ action: 'WARN' });
    }

    if (settings.duplicateMuteEnabled) {
      reactions.push({ action: 'MUTE' });
    }

    if (settings.duplicateBanEnabled) {
      reactions.push({ action: 'BAN' });
    }

    return reactions;
  }

  private buildFingerprints(
    compactText: string,
    rawText: string,
    settings: ChatSettings,
  ): DuplicateFingerprint[] {
    const fingerprints: DuplicateFingerprint[] = [];
    const seen = new Set<string>();
    const push = (type: DuplicateFingerprintType, value: string) => {
      const normalized = value.replace(/\s+/g, ' ').trim();
      if (!normalized || seen.has(normalized)) {
        return;
      }
      seen.add(normalized);
      fingerprints.push({ type, value: normalized });
    };

    push('exact', compactText);

    const config = this.resolveFingerprintConfig(settings);
    if (config.matchLinkValues) {
      for (const link of this.extractNormalizedLinks(rawText)) {
        push('link', link);
      }
    }

    if (config.matchPhoneValues) {
      for (const phone of extractDetectedPhoneNumbers(rawText)) {
        push('phone', phone);
      }
    }

    if (config.ignoreLinks || config.ignorePhones) {
      const content = this.normalizeContentFingerprint(rawText, config);
      push('content', content);
    }

    if (config.nearMatch) {
      const near = this.buildNearDuplicateFingerprint(rawText, config);
      if (near) {
        push('near', near);
      }
    }

    return fingerprints;
  }

  private resolveFingerprintConfig(settings: ChatSettings): {
    ignoreLinks: boolean;
    ignorePhones: boolean;
    matchLinkValues: boolean;
    matchPhoneValues: boolean;
    nearMatch: boolean;
  } {
    if (settings.duplicateDetectionPreset === 'STRICT') {
      return {
        ignoreLinks: true,
        ignorePhones: true,
        matchLinkValues: false,
        matchPhoneValues: false,
        nearMatch: true,
      };
    }

    if (settings.duplicateDetectionPreset === 'CUSTOM') {
      // Legacy field names say "ignore"; the CUSTOM UI uses them as value-match toggles.
      return {
        ignoreLinks: false,
        ignorePhones: false,
        matchLinkValues: settings.duplicateIgnoreLinksEnabled,
        matchPhoneValues: settings.duplicateIgnorePhonesEnabled,
        nearMatch: settings.duplicateNearMatchEnabled,
      };
    }

    return {
      ignoreLinks: false,
      ignorePhones: false,
      matchLinkValues: false,
      matchPhoneValues: false,
      nearMatch: false,
    };
  }

  private extractNormalizedLinks(rawText: string): string[] {
    const normalizedLinks = new Set<string>();

    for (const rawLink of extractUrlsFromText(rawText)) {
      const normalizedLink = normalizeAllowlistLink(rawLink);
      if (normalizedLink) {
        normalizedLinks.add(normalizedLink);
      }
    }

    return Array.from(normalizedLinks);
  }

  private normalizeContentFingerprint(
    compactText: string,
    config: { ignoreLinks: boolean; ignorePhones: boolean },
  ): string {
    let value = compactText;
    if (config.ignoreLinks) {
      value = stripUrlsFromText(value);
    }
    if (config.ignorePhones) {
      value = stripPhoneNumbersFromText(value);
    }
    return normalizeForDetection(value).replace(/\s+/g, ' ').trim();
  }

  private buildNearDuplicateFingerprint(
    compactText: string,
    config: { ignoreLinks: boolean; ignorePhones: boolean },
  ): string | null {
    const normalized = this.normalizeContentFingerprint(compactText, config);
    const tokens = normalized.match(/[a-zа-яё0-9]+/giu) ?? [];
    const meaningfulTokens = tokens.filter((token) => token.length >= 4);
    const uniqueTokens = Array.from(new Set(meaningfulTokens)).sort();
    if (
      tokens.length < NEAR_DUPLICATE_MIN_TOKEN_COUNT ||
      uniqueTokens.length < NEAR_DUPLICATE_MIN_UNIQUE_TOKENS
    ) {
      return null;
    }

    return uniqueTokens.join(' ');
  }

  private pickStrongerHit(
    current: DuplicateHit | undefined,
    candidate: DuplicateHit,
  ): DuplicateHit {
    if (!current || candidate.count > current.count) {
      return candidate;
    }

    return current;
  }

  private resolveNextAction(
    reactions: DuplicateReactionStage[],
    currentIndex: number,
  ): DuplicateAction | null {
    for (let index = currentIndex + 1; index < reactions.length; index += 1) {
      const nextAction = reactions[index]?.action;
      if (nextAction) {
        return nextAction;
      }
    }

    return null;
  }

  private logStateTimeout(chatId: string, userId: string): void {
    const now = Date.now();
    if (now - this.duplicateTimeoutWarnAtMs < 30_000) {
      return;
    }

    this.duplicateTimeoutWarnAtMs = now;
    console.warn(
      JSON.stringify({
        level: 'warn',
        context: 'RuleEngineService',
        chatId,
        userId,
        timeoutMs: DUPLICATE_STATE_LOOKUP_TIMEOUT_MS,
        msg: 'Duplicate state lookup timed out; skipping duplicate enforcement in hot path',
      }),
    );
  }
}

function stripPhoneNumbersFromText(value: string): string {
  return value.replace(PHONE_NUMBER_PATTERN, ' ').replace(/\s+/g, ' ').trim();
}
