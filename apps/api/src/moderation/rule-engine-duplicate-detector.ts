import type { ChatSettings } from '../prisma/prisma-client';
import { createHash } from 'node:crypto';
import { raceWithTimeout } from '../common/promise-timeout.util';
import { buildDuplicateStageKey } from './duplicate-state';
import { RedisCounterService } from './redis-counter.service';

export type DuplicateAction = 'WARN' | 'MUTE' | 'BAN';

export type DuplicateDecision = {
  action: DuplicateAction;
  count: number;
  threshold: number;
  windowSec: number;
  hash: string;
  nextAction: DuplicateAction | null;
};

export type DuplicateHit = {
  count: number;
  windowSec: number;
  hash: string;
};

type DuplicateReactionStage = {
  action: DuplicateAction | null;
};

const DUPLICATE_STATE_LOOKUP_TIMEOUT_MS = 250;

export class RuleEngineDuplicateDetector {
  private duplicateTimeoutWarnAtMs = 0;

  constructor(private readonly redisCounter: RedisCounterService) {}

  async detectWithin(params: {
    chatId: string;
    userId: string;
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
    compactText: string;
    settings: ChatSettings;
  }): Promise<{
    hit?: DuplicateHit;
    decision?: DuplicateDecision;
  }> {
    const { chatId, userId, compactText, settings } = params;
    const hash = createHash('sha256').update(compactText).digest('hex').slice(0, 20);
    const flow = this.getFlowConfig(settings);
    const flowKey = buildDuplicateStageKey(chatId, userId, hash, 'flow');
    const total = await this.redisCounter.incrementWithTtl(flowKey, flow.windowSec + 1);
    const repeatCount = Math.max(0, total - 1);

    if (repeatCount <= flow.allowedCount) {
      return {};
    }

    const hit: DuplicateHit = {
      count: repeatCount,
      windowSec: flow.windowSec,
      hash,
    };

    if (flow.reactions.length === 0) {
      return {};
    }

    const reactionIndex = Math.min(flow.reactions.length - 1, repeatCount - flow.allowedCount - 1);
    const reaction = flow.reactions[reactionIndex];

    if (!reaction || reaction.action === null) {
      return { hit };
    }

    return {
      hit,
      decision: {
        action: reaction.action,
        count: repeatCount,
        threshold: flow.allowedCount + reactionIndex + 1,
        windowSec: flow.windowSec,
        hash,
        nextAction: this.resolveNextAction(flow.reactions, reactionIndex),
      },
    };
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
