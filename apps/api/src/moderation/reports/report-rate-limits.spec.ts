import { chatSettingsSchema } from '@maxim/contracts';
import { RuleEngineService } from '../rule-engine.service';
import { RuleEngineMessageLimitsDetector } from '../rule-engine-message-limits.detector';
import { TrafficProtectionDetector } from '../traffic-protection.detector';

describe('report commands retain ordinary traffic protection', () => {
  afterEach(() => jest.restoreAllMocks());
  it('does not bypass burst, message-count or length limits', async () => {
    jest
      .spyOn(RuleEngineMessageLimitsDetector.prototype, 'detectAntiSpamBurstLimit')
      .mockResolvedValue({ ruleCode: 'MESSAGE_RATE_LIMIT', score: 1, reason: 'burst' });
    jest
      .spyOn(RuleEngineMessageLimitsDetector.prototype, 'detectMessageCountLimit')
      .mockResolvedValue({ ruleCode: 'MESSAGE_COUNT_LIMIT', score: 1, reason: 'count' });
    const engine = new RuleEngineService({} as never);
    const settings = {
      ...chatSettingsSchema.parse({
        maxMessageLengthEnabled: true,
        maxMessageLength: 50,
        russianProfanityFilterEnabled: true,
        messageLimitsBlockedWords: ['жалоба'],
      }),
      stopWordsPolicy: null,
    };
    const result = await engine.detect({
      chatId: 'chat',
      userId: 'user',
      text: 'жалоба',
      settings: settings as never,
      domainAllowlist: [],
      effectiveLength: 51,
      skipContentFiltersForReport: true,
      skipDuplicateState: true,
    });
    expect(result.violations.map((v) => v.ruleCode)).toEqual(
      expect.arrayContaining(['MESSAGE_RATE_LIMIT', 'MESSAGE_COUNT_LIMIT', 'MESSAGE_TOO_LONG']),
    );
    expect(result.violations.some((v) => v.ruleCode === 'MESSAGE_BLOCKED_WORD')).toBe(false);
  });
  it('keeps slow-mode checks for report commands', async () => {
    const detect = jest
      .spyOn(TrafficProtectionDetector.prototype, 'detect')
      .mockResolvedValue({ ruleCode: 'SLOW_MODE', score: 1, reason: 'interval' } as never);
    const engine = new RuleEngineService({} as never);
    const result = await engine.detect({
      chatId: 'chat',
      userId: 'user',
      messageId: 'command',
      text: 'жалоба',
      settings: chatSettingsSchema.parse({ slowModeEnabled: true }) as never,
      domainAllowlist: [],
      skipContentFiltersForReport: true,
      skipDuplicateState: true,
    });
    expect(detect).toHaveBeenCalled();
    expect(result.violations[0]?.ruleCode).toBe('SLOW_MODE');
  });
});
