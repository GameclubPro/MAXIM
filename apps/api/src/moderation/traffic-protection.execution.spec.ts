import { ModerationService, createSettings, createUpdate } from './moderation.service.spec-support';
import { RuleEngineService } from './rule-engine.service';
import { TrafficProtectionDetector } from './traffic-protection.detector';

function harness() {
  const settings = createSettings({
    antiSpamEnabled: false,
    antiDuplicateEnabled: false,
    slowModeEnabled: true,
    messageLimitsWarnEnabled: true,
    messageLimitsMuteEnabled: true,
    messageLimitsBanEnabled: true,
  });
  const prisma = {
    chat: {
      upsert: jest.fn().mockResolvedValue({ id: 'chat-1', title: 'Chat', settings, domains: [] }),
    },
    violation: { create: jest.fn(), count: jest.fn() },
    moderationEvent: { findFirst: jest.fn().mockResolvedValue(null), create: jest.fn() },
    webhookEvent: { findUnique: jest.fn(), update: jest.fn() },
  };
  const max = {
    deleteMessage: jest.fn(),
    sendMessage: jest.fn(),
    banMember: jest.fn(),
    kickMember: jest.fn(),
    notifyModerators: jest.fn(),
  };
  const sanctions = { resolveAction: jest.fn() };
  const rules = { detect: jest.fn() };
  const intents = {
    ensureIntent: jest.fn(),
    ensureAndAttempt: jest
      .fn()
      .mockResolvedValue({ kind: 'confirmed', confirmed: true, botId: 'bot' }),
    getRolloutForInput: jest.fn().mockReturnValue('execute'),
  };
  const service = new ModerationService(
    prisma as never,
    rules as never,
    sanctions as never,
    max as never,
  );
  Object.assign(service, { moderationDeleteIntentService: intents });
  return { service, settings, prisma, max, sanctions, rules, intents };
}

describe('traffic protection execution', () => {
  it.each(['SLOW_MODE', 'MEDIA_RATE_LIMIT', 'STICKER_BLOCKED'])(
    'keeps %s delete-only even when the shared sanction ladder is enabled',
    async (ruleCode) => {
      const h = harness();
      h.rules.detect.mockResolvedValue({
        violations: [
          {
            ruleCode,
            score: 0.85,
            reason: 'Traffic',
            metadata: {
              trafficPolicyVersion: 1,
              trafficPolicyRevision: 0,
              trafficEventTimestampMs: Date.now(),
              trafficDeadlineAtMs: Date.now() + 30_000,
            },
          },
        ],
      });
      await h.service.handleUpdate(createUpdate());
      expect(h.intents.ensureAndAttempt).toHaveBeenCalledWith(
        expect.objectContaining({ ruleCode: `${ruleCode}_DELETE`, retryUntilAt: expect.any(Date) }),
        undefined,
      );
      expect(h.prisma.violation.create).not.toHaveBeenCalled();
      expect(h.prisma.violation.count).not.toHaveBeenCalled();
      expect(h.sanctions.resolveAction).not.toHaveBeenCalled();
      expect(h.max.banMember).not.toHaveBeenCalled();
      expect(h.max.kickMember).not.toHaveBeenCalled();
      expect(h.max.sendMessage).not.toHaveBeenCalled();
      expect(h.max.deleteMessage).not.toHaveBeenCalled();
    },
  );
  it('never falls back to an unguarded delete when durable execution is unavailable', async () => {
    const h = harness();
    h.rules.detect.mockResolvedValue({
      violations: [{ ruleCode: 'SLOW_MODE', score: 0.85, reason: 'Traffic' }],
    });
    h.intents.ensureAndAttempt.mockRejectedValue(new Error('intent unavailable'));
    h.intents.getRolloutForInput.mockReturnValue('off');
    await expect(h.service.handleUpdate(createUpdate())).rejects.toThrow('intent unavailable');
    expect(h.max.deleteMessage).not.toHaveBeenCalled();
  });
  it('does not hide existing rules when traffic state fails', async () => {
    const h = harness();
    const redis = {
      claimEventCooldown: jest.fn().mockRejectedValue(new Error('Redis unavailable')),
    };
    const rules = new RuleEngineService(redis as never);
    const spy = jest.spyOn(TrafficProtectionDetector.prototype, 'detect');
    const result = await rules.detect({
      chatId: 'chat-1',
      userId: 'user-1',
      messageId: 'message',
      duplicateStateEventType: 'message_created',
      duplicateStateEventTimestampMs: Date.now(),
      text: 'a'.repeat(100),
      settings: { ...h.settings, maxMessageLengthEnabled: true, maxMessageLength: 50 } as never,
      domainAllowlist: [],
      skipDuplicateState: true,
    });
    expect(result.violations).toEqual(
      expect.arrayContaining([expect.objectContaining({ ruleCode: 'MESSAGE_TOO_LONG' })]),
    );
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
