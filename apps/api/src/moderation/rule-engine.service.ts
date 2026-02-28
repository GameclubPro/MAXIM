import { Injectable } from '@nestjs/common';
import { LinkPolicy, ProfanityLevel, type ChatSettings } from '@prisma/client';
import { createHash } from 'node:crypto';
import { RedisCounterService } from './redis-counter.service';

export type RuleViolation = {
  ruleCode: string;
  score: number;
  reason: string;
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
  }): Promise<RuleViolation[]> {
    const { chatId, userId, text, settings, domainAllowlist } = params;
    const violations: RuleViolation[] = [];
    const normalized = text.toLowerCase();

    if (this.hasProfanity(normalized, settings.profanityLevel)) {
      violations.push({ ruleCode: 'PROFANITY', score: 0.95, reason: 'Detected profanity pattern' });
    }

    const linkViolation = this.hasBlockedLink(normalized, settings.linkPolicy, domainAllowlist);
    if (linkViolation) {
      violations.push({ ruleCode: 'LINK_BLOCKED', score: 0.9, reason: linkViolation });
    }

    if (this.isCapsAbuse(text, settings.capsThreshold)) {
      violations.push({ ruleCode: 'CAPS_ABUSE', score: 0.7, reason: 'Excessive uppercase ratio' });
    }

    const floodKey = `flood:${chatId}:${userId}:${Math.floor(Date.now() / (settings.floodWindowSec * 1000))}`;
    const floodCount = await this.redisCounter.incrementWithTtl(floodKey, settings.floodWindowSec + 1);
    if (floodCount > settings.floodMaxMessages) {
      violations.push({ ruleCode: 'FLOOD', score: 0.85, reason: 'Message flood detected' });
    }

    const compactText = normalized.replace(/\s+/g, ' ').trim();
    if (compactText.length > 0) {
      const hash = createHash('sha256').update(compactText).digest('hex').slice(0, 20);
      const duplicateKey = `duplicate:${chatId}:${userId}:${hash}`;
      const duplicateCount = await this.redisCounter.incrementWithTtl(
        duplicateKey,
        settings.duplicateWindowSec + 1,
      );
      if (duplicateCount >= settings.duplicateMaxCount) {
        violations.push({ ruleCode: 'DUPLICATE', score: 0.8, reason: 'Duplicate message detected' });
      }
    }

    return violations;
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
      return null;
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
