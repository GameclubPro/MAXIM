import { LinkPolicy, ProfanityLevel, type ChatSettings } from '@prisma/client';
import { RuleEngineService } from './rule-engine.service';

class MockRedisCounterService {
  private readonly counters = new Map<string, number>();

  async incrementWithTtl(key: string): Promise<number> {
    const next = (this.counters.get(key) ?? 0) + 1;
    this.counters.set(key, next);
    return next;
  }
}

const settings: ChatSettings = {
  id: '1',
  chatId: 'chat-1',
  profanityLevel: ProfanityLevel.MEDIUM,
  capsThreshold: 70,
  floodWindowSec: 10,
  floodMaxMessages: 2,
  duplicateWindowSec: 60,
  duplicateMaxCount: 2,
  linkPolicy: LinkPolicy.ALLOWLIST_ONLY,
  warnThreshold: 3,
  repeatBanWindowDays: 7,
  logRetentionDays: 90,
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe('RuleEngineService', () => {
  it('detects profanity and blocked links', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'ты сука иди на http://bad.com',
      settings,
      domainAllowlist: ['example.com'],
    });

    expect(result.some((item) => item.ruleCode === 'PROFANITY')).toBe(true);
    expect(result.some((item) => item.ruleCode === 'LINK_BLOCKED')).toBe(true);
  });

  it('detects duplicates across repeated messages', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);

    await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'same text',
      settings,
      domainAllowlist: [],
    });

    const second = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'same text',
      settings,
      domainAllowlist: [],
    });

    expect(second.some((item) => item.ruleCode === 'DUPLICATE')).toBe(true);
  });
});
