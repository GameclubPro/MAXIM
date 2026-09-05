import { DUPLICATE_THRESHOLD_MAX, normalizeAllowlistLink } from '@maxim/contracts/settings';
import { createHash } from 'node:crypto';
import type { ChatSettings } from '../prisma/prisma-client';
import { raceWithTimeout } from '../common/promise-timeout.util';
import { stripUrlsFromText } from '../common/url-text.util';
import {
  buildDuplicateFingerprintMembershipKey,
  buildDuplicateMessageStateKey,
  buildDuplicateStageKey,
  resolveDuplicateHistoryRetentionSeconds,
} from './duplicate-state';
import { isEnforceableLinkPolicyTarget } from './navigation/link-policy-target.util';
import type { NavigationTargetEvidence } from './navigation/navigation-evidence.types';
import { extractUrlsFromText } from './rule-engine-link-detector';
import { extractDetectedPhoneNumbers } from './rule-engine-message-limits.detector';
import { normalizeForDetection } from './rule-engine-normalization';
import { RedisCounterService } from './redis-counter.service';
import { resolveDuplicateFlowConfig, type DuplicateReactionStage } from './duplicate-flow-policy';
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

type DuplicateFingerprint = {
  type: DuplicateFingerprintType;
  value: string;
};

type ResolvedDuplicateFingerprint = DuplicateFingerprint & {
  hash: string;
  membershipKey: string;
};

const PHONE_NUMBER_PATTERN = /(?:^|[^\d+])(\+?\d[\d\s().-]{7,}\d)(?=$|[^\d])/gu;
const NEAR_DUPLICATE_MIN_TOKEN_COUNT = 6;
const NEAR_DUPLICATE_MIN_UNIQUE_TOKENS = 5;
const DUPLICATE_APPROXIMATE_MIN_LENGTH = 50;
const DUPLICATE_APPROXIMATE_MIN_UNIQUE_LONG_TOKENS = 4;
const DUPLICATE_NEAR_SIGNIFICANT_SHORT_TOKENS = new Set(['без', 'не', 'нет', 'ни']);
const DUPLICATE_ACTION_PRIORITY: Readonly<Record<DuplicateAction, number>> = {
  WARN: 1,
  MUTE: 2,
  BAN: 3,
};
export const DUPLICATE_STATE_BUDGET_MS = 250;

export type DuplicateStateBudgetExceededEvent = {
  chatId: string;
  userId: string;
  timeoutMs: number;
  source: 'caller_deadline' | 'redis_deadline';
};

export class DuplicateStateBudgetExceededError extends Error {
  readonly code = 'DUPLICATE_STATE_BUDGET_EXCEEDED';
  readonly retryable = true;

  constructor(readonly source: DuplicateStateBudgetExceededEvent['source']) {
    super(`Duplicate state budget exceeded after ${DUPLICATE_STATE_BUDGET_MS}ms`);
    this.name = 'DuplicateStateBudgetExceededError';
  }
}

type DuplicateBudgetContext = {
  reported: boolean;
};

export class RuleEngineDuplicateDetector {
  private duplicateBudgetWarnAtMs: number | null = null;

  constructor(
    private readonly redisCounter: RedisCounterService,
    private readonly onBudgetExceeded?: (event: DuplicateStateBudgetExceededEvent) => void,
  ) {}

  async detectWithin(params: {
    chatId: string;
    userId: string;
    messageId?: string;
    eventTimestampMs?: number;
    rawText: string;
    compactText: string;
    settings: ChatSettings;
    navigationTargets?: readonly NavigationTargetEvidence[];
    trackCurrentText?: boolean;
  }): Promise<{
    hit?: DuplicateHit;
    decision?: DuplicateDecision;
  }> {
    const messageId = params.messageId?.trim();
    if (!messageId) {
      return this.detectLegacyState(params);
    }

    const eventTimestampMs = Math.trunc(params.eventTimestampMs ?? Number.NaN);
    if (!Number.isSafeInteger(eventTimestampMs) || eventTimestampMs <= 0) {
      return {};
    }
    if (typeof this.redisCounter.replaceRevisionedSetMembershipsBeforeDeadline !== 'function') {
      throw new Error('Revisioned duplicate state mutation is unavailable');
    }

    const deadlineAtMs = Date.now() + DUPLICATE_STATE_BUDGET_MS;
    const budgetContext: DuplicateBudgetContext = { reported: false };
    return raceWithTimeout({
      operation: () =>
        this.detectRevisionedState(
          {
            ...params,
            messageId,
            eventTimestampMs,
          },
          deadlineAtMs,
          budgetContext,
        ),
      timeoutMs: DUPLICATE_STATE_BUDGET_MS,
      onTimeout: () => {
        throw this.createBudgetExceededError(params, 'caller_deadline', budgetContext);
      },
    });
  }

  private async detectRevisionedState(
    params: {
      chatId: string;
      userId: string;
      messageId: string;
      eventTimestampMs: number;
      rawText: string;
      compactText: string;
      settings: ChatSettings;
      navigationTargets?: readonly NavigationTargetEvidence[];
      trackCurrentText?: boolean;
    },
    deadlineAtMs: number,
    budgetContext: DuplicateBudgetContext,
  ): Promise<{
    hit?: DuplicateHit;
    decision?: DuplicateDecision;
  }> {
    const { chatId, userId, settings } = params;
    const flow = this.getFlowConfig(settings);
    const fingerprints =
      (params.trackCurrentText ?? true)
        ? this.resolveFingerprints(
            chatId,
            userId,
            params.compactText,
            params.rawText,
            settings,
            params.navigationTargets,
          )
        : [];
    const messageHash = createHash('sha256').update(params.messageId).digest('hex').slice(0, 20);
    const mutation = await this.redisCounter.replaceRevisionedSetMembershipsBeforeDeadline({
      stateKey: buildDuplicateMessageStateKey(chatId, userId, messageHash),
      member: messageHash,
      revision: params.eventTimestampMs,
      membershipKeys: fingerprints.map((fingerprint) => fingerprint.membershipKey),
      windowSeconds: flow.windowSec,
      ttlSeconds: resolveDuplicateHistoryRetentionSeconds(flow.windowSec),
      countLimit: DUPLICATE_THRESHOLD_MAX + 1,
      deadlineAtMs,
    });
    if (mutation.kind === 'deadline_exceeded') {
      throw this.createBudgetExceededError(params, 'redis_deadline', budgetContext);
    }
    if (mutation.kind === 'stale') {
      return {};
    }

    return this.resolveOutcomeFromCounts(fingerprints, mutation.counts, flow);
  }

  private async detectLegacyState(params: {
    chatId: string;
    userId: string;
    rawText: string;
    compactText: string;
    settings: ChatSettings;
    navigationTargets?: readonly NavigationTargetEvidence[];
    trackCurrentText?: boolean;
  }): Promise<{
    hit?: DuplicateHit;
    decision?: DuplicateDecision;
  }> {
    if (params.trackCurrentText === false) {
      return {};
    }

    const { chatId, userId, settings } = params;
    const flow = this.getFlowConfig(settings);
    const fingerprints = this.resolveFingerprints(
      chatId,
      userId,
      params.compactText,
      params.rawText,
      settings,
      params.navigationTargets,
    );
    const counts: number[] = [];

    for (const fingerprint of fingerprints) {
      const flowKey = buildDuplicateStageKey(
        chatId,
        userId,
        fingerprint.hash,
        `legacy:flow:${fingerprint.type}`,
      );
      counts.push(await this.redisCounter.incrementWithTtl(flowKey, flow.windowSec + 1));
    }

    return this.resolveOutcomeFromCounts(fingerprints, counts, flow);
  }

  private resolveOutcomeFromCounts(
    fingerprints: readonly ResolvedDuplicateFingerprint[],
    counts: readonly number[],
    flow: ReturnType<typeof resolveDuplicateFlowConfig>,
  ): { hit?: DuplicateHit; decision?: DuplicateDecision } {
    let strongestHit: DuplicateHit | undefined;
    let strongestDecision: DuplicateDecision | undefined;

    for (let index = 0; index < fingerprints.length; index += 1) {
      const fingerprint = fingerprints[index];
      if (!fingerprint) {
        continue;
      }
      const total = counts[index] ?? 0;
      const repeatCount = Math.max(0, total - 1);

      if (repeatCount <= flow.allowedCount) {
        continue;
      }

      const hit: DuplicateHit = {
        count: repeatCount,
        windowSec: flow.windowSec,
        hash: fingerprint.hash,
        fingerprintType: fingerprint.type,
      };
      strongestHit = this.pickStrongerHit(strongestHit, hit);

      if (flow.reactions.length === 0) {
        continue;
      }

      const reactionIndex = Math.min(
        flow.reactions.length - 1,
        repeatCount - flow.allowedCount - 1,
      );
      const reaction = flow.reactions[reactionIndex];

      if (!reaction || reaction.action === null) {
        continue;
      }

      const decision: DuplicateDecision = {
        action: reaction.action,
        count: repeatCount,
        threshold: flow.allowedCount + reactionIndex + 1,
        windowSec: flow.windowSec,
        hash: fingerprint.hash,
        fingerprintType: fingerprint.type,
        nextAction: this.resolveNextAction(flow.reactions, reactionIndex),
      };
      strongestDecision = this.pickStrongerDecision(strongestDecision, decision);
    }

    return {
      ...(strongestHit ? { hit: strongestHit } : {}),
      ...(strongestDecision ? { decision: strongestDecision } : {}),
    };
  }

  private createBudgetExceededError(
    params: { chatId: string; userId: string },
    source: DuplicateStateBudgetExceededEvent['source'],
    context: DuplicateBudgetContext,
  ): DuplicateStateBudgetExceededError {
    if (!context.reported) {
      context.reported = true;
      const event: DuplicateStateBudgetExceededEvent = {
        chatId: params.chatId,
        userId: params.userId,
        timeoutMs: DUPLICATE_STATE_BUDGET_MS,
        source,
      };
      try {
        this.onBudgetExceeded?.(event);
      } catch {
        // Diagnostics must not replace the retryable moderation error.
      }
      this.logBudgetExceeded(event);
    }
    return new DuplicateStateBudgetExceededError(source);
  }

  private logBudgetExceeded(event: DuplicateStateBudgetExceededEvent): void {
    const now = Date.now();
    if (this.duplicateBudgetWarnAtMs !== null && now - this.duplicateBudgetWarnAtMs < 30_000) {
      return;
    }
    this.duplicateBudgetWarnAtMs = now;
    console.warn(
      JSON.stringify({
        level: 'warn',
        context: 'RuleEngineService',
        ...event,
        retryable: true,
        msg: 'Duplicate state budget exceeded; retrying webhook without acknowledging partial work',
      }),
    );
  }

  private getFlowConfig(settings: ChatSettings): {
    allowedCount: number;
    windowSec: number;
    reactions: DuplicateReactionStage[];
  } {
    return resolveDuplicateFlowConfig(settings);
  }

  private buildFingerprints(
    compactText: string,
    rawText: string,
    settings: ChatSettings,
    navigationTargets?: readonly NavigationTargetEvidence[],
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

    const navigationIdentityKeys = this.resolveNavigationIdentityKeys(navigationTargets);
    push('exact', this.buildExactFingerprint(compactText, navigationIdentityKeys));

    const config = this.resolveFingerprintConfig(settings);
    if (config.matchLinkValues) {
      for (const link of this.extractNormalizedLinks(rawText, navigationTargets)) {
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
      if (this.hasSufficientApproximateContent(content)) {
        push('content', content);
      }
    }

    if (config.nearMatch) {
      const near = this.buildNearDuplicateFingerprint(rawText, config);
      if (near) {
        push('near', near);
      }
    }

    return fingerprints;
  }

  private resolveFingerprints(
    chatId: string,
    userId: string,
    compactText: string,
    rawText: string,
    settings: ChatSettings,
    navigationTargets?: readonly NavigationTargetEvidence[],
  ): ResolvedDuplicateFingerprint[] {
    return this.buildFingerprints(compactText, rawText, settings, navigationTargets).map(
      (fingerprint) => {
        const hash = createHash('sha256').update(fingerprint.value).digest('hex').slice(0, 20);
        return {
          ...fingerprint,
          hash,
          membershipKey: buildDuplicateFingerprintMembershipKey(
            chatId,
            userId,
            hash,
            fingerprint.type,
          ),
        };
      },
    );
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

  private extractNormalizedLinks(
    rawText: string,
    navigationTargets?: readonly NavigationTargetEvidence[],
  ): string[] {
    const normalizedLinks = new Set<string>();

    for (const rawLink of extractUrlsFromText(rawText)) {
      const normalizedLink = normalizeAllowlistLink(rawLink);
      if (normalizedLink) {
        normalizedLinks.add(normalizedLink);
      }
    }

    for (const target of navigationTargets ?? []) {
      if (isEnforceableLinkPolicyTarget(target) && target.normalizedTarget.trim()) {
        const normalizedHttpTarget = normalizeAllowlistLink(target.normalizedTarget);
        normalizedLinks.add(
          normalizedHttpTarget ?? `${target.kind}:${target.normalizedTarget.trim()}`,
        );
      }
    }

    return Array.from(normalizedLinks);
  }

  private resolveNavigationIdentityKeys(
    navigationTargets?: readonly NavigationTargetEvidence[],
  ): string[] {
    const keys = new Set<string>();
    for (const target of navigationTargets ?? []) {
      for (const candidate of [target, ...(target.allowlistAliases ?? [])]) {
        const normalizedTarget = candidate.normalizedTarget.trim();
        if (normalizedTarget) {
          keys.add(`target:${candidate.kind}:${normalizedTarget}`);
        }
      }
      for (const origin of target.origins) {
        const navigationFingerprint = origin.navigationFingerprint?.trim();
        if (navigationFingerprint) {
          keys.add(`actions:${origin.provenance}:${navigationFingerprint}`);
        }
      }
    }
    return Array.from(keys).sort();
  }

  private buildExactFingerprint(
    compactText: string,
    navigationIdentityKeys: readonly string[],
  ): string {
    if (navigationIdentityKeys.length === 0) {
      return compactText;
    }

    return JSON.stringify({ text: compactText, navigationIdentity: navigationIdentityKeys });
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
    if (!this.hasSufficientApproximateContent(normalized)) {
      return null;
    }
    const tokens = normalized.match(/[a-zа-яё0-9]+/giu) ?? [];
    const meaningfulTokens = tokens.filter(
      (token) => token.length >= 4 || DUPLICATE_NEAR_SIGNIFICANT_SHORT_TOKENS.has(token),
    );
    const numericTokens = this.extractNearNumericTokens(compactText, config).map(
      (token) => `number:${token}`,
    );
    const uniqueTokens = Array.from(new Set([...meaningfulTokens, ...numericTokens])).sort();
    const uniqueLongTokens = new Set(tokens.filter((token) => token.length >= 4));
    if (
      tokens.length < NEAR_DUPLICATE_MIN_TOKEN_COUNT ||
      uniqueLongTokens.size < NEAR_DUPLICATE_MIN_UNIQUE_TOKENS
    ) {
      return null;
    }

    return uniqueTokens.join(' ');
  }

  private extractNearNumericTokens(
    value: string,
    config: { ignoreLinks: boolean; ignorePhones: boolean },
  ): string[] {
    let source = value;
    if (config.ignoreLinks) {
      source = stripUrlsFromText(source);
    }
    if (config.ignorePhones) {
      source = stripPhoneNumbersFromText(source);
    }
    return source.match(/\d+(?:[.,:]\d+)*/gu) ?? [];
  }

  private hasSufficientApproximateContent(value: string): boolean {
    if (value.length < DUPLICATE_APPROXIMATE_MIN_LENGTH) {
      return false;
    }

    const tokens = value.match(/[a-zа-яё0-9]+/giu) ?? [];
    const uniqueLongTokens = new Set(tokens.filter((token) => token.length >= 4));
    return (
      tokens.length >= NEAR_DUPLICATE_MIN_TOKEN_COUNT &&
      uniqueLongTokens.size >= DUPLICATE_APPROXIMATE_MIN_UNIQUE_LONG_TOKENS
    );
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

  private pickStrongerDecision(
    current: DuplicateDecision | undefined,
    candidate: DuplicateDecision,
  ): DuplicateDecision {
    if (!current) {
      return candidate;
    }

    const currentPriority = DUPLICATE_ACTION_PRIORITY[current.action];
    const candidatePriority = DUPLICATE_ACTION_PRIORITY[candidate.action];
    if (candidatePriority > currentPriority) {
      return candidate;
    }
    if (candidatePriority === currentPriority && candidate.count > current.count) {
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
}

function stripPhoneNumbersFromText(value: string): string {
  return value.replace(PHONE_NUMBER_PATTERN, ' ').replace(/\s+/g, ' ').trim();
}
