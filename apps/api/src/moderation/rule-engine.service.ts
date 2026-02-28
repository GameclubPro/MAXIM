import { Injectable } from '@nestjs/common';
import { LinkPolicy, ProfanityLevel, type ChatSettings } from '@prisma/client';
import { createHash } from 'node:crypto';
import { RedisCounterService } from './redis-counter.service';

export type RuleViolation = {
  ruleCode: string;
  score: number;
  reason: string;
};

export type DuplicateAction = 'WARN' | 'KICK' | 'BAN';

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

export type DetectionResult = {
  violations: RuleViolation[];
  duplicateHit?: DuplicateHit;
  duplicateDecision?: DuplicateDecision;
};

type DuplicateStageName = 'warn' | 'kick' | 'ban';

type DuplicateStage = {
  name: DuplicateStageName;
  action: DuplicateAction;
  windowSec: number;
  threshold: number;
};

const BASE_PROFANITY = ['бляд', 'хуй', 'пизд', 'еба'];
const SOFT_PROFANITY = ['сука', 'нахер'];
const EXCEPTIONS = ['бляха', 'страхуй'];

@Injectable()
export class RuleEngineService {
  constructor(private readonly redisCounter: RedisCounterService) {}

  async detect(params: {
    chatId: string;
    userId: string;
    text: string;
    settings: ChatSettings;
    domainAllowlist: string[];
    effectiveLength?: number;
  }): Promise<DetectionResult> {
    const { chatId, userId, text, settings, domainAllowlist, effectiveLength } = params;
    const violations: RuleViolation[] = [];
    const normalized = text.toLowerCase();
    const measuredLength = typeof effectiveLength === 'number' ? effectiveLength : text.length;

    if (this.hasProfanity(normalized, settings.profanityLevel)) {
      violations.push({ ruleCode: 'PROFANITY', score: 0.95, reason: 'Detected profanity pattern' });
    }

    const linkViolation = this.hasBlockedLink(normalized, settings.linkPolicy, domainAllowlist);
    if (linkViolation) {
      violations.push({ ruleCode: 'LINK_BLOCKED', score: 0.9, reason: linkViolation });
    }

    if (measuredLength > settings.maxMessageLength) {
      violations.push({
        ruleCode: 'MESSAGE_TOO_LONG',
        score: 0.82,
        reason: `Message length ${measuredLength} exceeds limit ${settings.maxMessageLength}`,
      });
    }

    if (this.isCapsAbuse(text, settings.capsThreshold)) {
      violations.push({ ruleCode: 'CAPS_ABUSE', score: 0.7, reason: 'Excessive uppercase ratio' });
    }

    const floodKey = `flood:${chatId}:${userId}:${Math.floor(Date.now() / (settings.floodWindowSec * 1000))}`;
    const floodCount = await this.redisCounter.incrementWithTtl(
      floodKey,
      settings.floodWindowSec + 1,
    );
    if (floodCount > settings.floodMaxMessages) {
      violations.push({ ruleCode: 'FLOOD', score: 0.85, reason: 'Message flood detected' });
    }

    const compactText = normalized.replace(/\s+/g, ' ').trim();
    const duplicateState =
      compactText.length > 0
        ? await this.detectDuplicateState({
            chatId,
            userId,
            compactText,
            settings,
          })
        : undefined;

    return {
      violations,
      ...(duplicateState?.hit ? { duplicateHit: duplicateState.hit } : {}),
      ...(duplicateState?.decision ? { duplicateDecision: duplicateState.decision } : {}),
    };
  }

  private async detectDuplicateState(params: {
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
    const hitKey = `dup:v3:${chatId}:${userId}:${hash}:hit`;
    const hitTotal = await this.redisCounter.incrementWithTtl(hitKey, settings.duplicateWindowSec + 1);
    const hitCount = Math.max(0, hitTotal - 1);
    const hit =
      hitCount > 0
        ? {
            count: hitCount,
            windowSec: settings.duplicateWindowSec,
            hash,
          }
        : undefined;

    const stages = this.getEnabledDuplicateStages(settings);
    if (stages.length === 0) {
      return { hit };
    }

    const repeatCounts = new Map<DuplicateStageName, number>();

    for (const stage of stages) {
      const key = `dup:v3:${chatId}:${userId}:${hash}:${stage.name}`;
      const count = await this.redisCounter.incrementWithTtl(key, stage.windowSec + 1);
      repeatCounts.set(stage.name, Math.max(0, count - 1));
    }

    const priority: DuplicateStageName[] = ['ban', 'kick', 'warn'];
    for (const stageName of priority) {
      const stage = stages.find((candidate) => candidate.name === stageName);
      if (!stage) {
        continue;
      }

      const count = repeatCounts.get(stageName) ?? 0;
      if (count < stage.threshold) {
        continue;
      }

      return {
        hit,
        decision: {
          action: stage.action,
          count,
          threshold: stage.threshold,
          windowSec: stage.windowSec,
          hash,
          nextAction: this.resolveNextDuplicateAction(stages, stageName),
        },
      };
    }

    return { hit };
  }

  private getEnabledDuplicateStages(settings: ChatSettings): DuplicateStage[] {
    const stages: Array<DuplicateStage | null> = [
      settings.duplicateWarnEnabled
        ? {
            name: 'warn',
            action: 'WARN',
            windowSec: settings.duplicateWarnWindowSec,
            threshold: settings.duplicateWarnMaxCount,
          }
        : null,
      settings.duplicateKickEnabled
        ? {
            name: 'kick',
            action: 'KICK',
            windowSec: settings.duplicateKickWindowSec,
            threshold: settings.duplicateKickMaxCount,
          }
        : null,
      settings.duplicateBanEnabled
        ? {
            name: 'ban',
            action: 'BAN',
            windowSec: settings.duplicateBanWindowSec,
            threshold: settings.duplicateBanMaxCount,
          }
        : null,
    ];

    return stages.filter((item): item is DuplicateStage => item !== null);
  }

  private resolveNextDuplicateAction(
    stages: DuplicateStage[],
    actionName: DuplicateStageName,
  ): DuplicateAction | null {
    const order: DuplicateStageName[] = ['warn', 'kick', 'ban'];
    const stageNames = stages.map((stage) => stage.name);
    const currentIndex = order.indexOf(actionName);

    for (let index = currentIndex + 1; index < order.length; index += 1) {
      const nextName = order[index];
      if (!stageNames.includes(nextName)) {
        continue;
      }

      if (nextName === 'warn') {
        return 'WARN';
      }
      if (nextName === 'kick') {
        return 'KICK';
      }
      return 'BAN';
    }

    return null;
  }

  private hasProfanity(text: string, level: ProfanityLevel): boolean {
    if (EXCEPTIONS.some((allowed) => text.includes(allowed))) {
      return false;
    }

    const severeHit = BASE_PROFANITY.some((word) => text.includes(word));
    if (level === ProfanityLevel.LOW) {
      return severeHit;
    }

    if (level === ProfanityLevel.MEDIUM) {
      return severeHit || SOFT_PROFANITY.some((word) => text.includes(word));
    }

    return severeHit || SOFT_PROFANITY.some((word) => text.includes(word));
  }

  private hasBlockedLink(text: string, policy: LinkPolicy, allowlist: string[]): string | null {
    if (policy === LinkPolicy.ALERT_ONLY) {
      return null;
    }

    const linkRegex = /((https?:\/\/)?([a-z0-9-]+\.)+[a-z]{2,})(\/\S*)?/gi;
    const matches = [...text.matchAll(linkRegex)];

    if (matches.length === 0) {
      return null;
    }

    if (policy === LinkPolicy.BLOCKLIST_ONLY) {
      return 'Links are not allowed by policy';
    }

    for (const match of matches) {
      const full = match[0];
      const domain = full
        .replace(/^https?:\/\//, '')
        .split('/')[0]
        .toLowerCase();
      const allowed = allowlist.some((entry) => domain === entry || domain.endsWith(`.${entry}`));
      if (!allowed) {
        return `Domain ${domain} is not in allowlist`;
      }
    }

    return null;
  }

  private isCapsAbuse(text: string, threshold: number): boolean {
    const letters = text.match(/[a-zа-яё]/gi);
    if (!letters || letters.length <= 20) {
      return false;
    }

    const upper = text.match(/[A-ZА-ЯЁ]/g)?.length ?? 0;
    const ratio = (upper / letters.length) * 100;
    return ratio > threshold;
  }
}
