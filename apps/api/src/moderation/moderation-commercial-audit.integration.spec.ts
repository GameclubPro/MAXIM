import { RuleEngineService } from './rule-engine.service';
import {
  ModerationService,
  createRedisCounterMock,
  createSettings,
  createUpdate,
} from './moderation.service.spec-support';

describe('commercial audit regressions in moderation execution', () => {
  const protectedTexts = [
    'Продам соковыжималку рабочая. При переезде утеряна деталь. Цена 500 рублей. Пишите в личку.',
    'Продам раму на УАЗ. Целая без сварки. Цена 40000. +7 900 000 10 42',
    'Мастер мне сегодня восстановил компьютер. Рекомендую, вот его номер +7 900 000 10 42.',
    'Срочно нужна машина: грузоперевозки или машина с прицепом. Звонить +7 900 000 10 42',
    'Нужно 2 места на завтра из города в посёлок. +7 900 000 10 42',
  ];

  function setup() {
    const settings = createSettings({
      antiDuplicateEnabled: false,
      commercialAdsFilterEnabled: true,
      commercialAdsSensitivity: 'STRICT',
      commercialAdsWarnThreshold: 38,
      commercialAdsDeleteThreshold: 55,
      textFiltersWarnEnabled: true,
      textFiltersMuteEnabled: true,
      textFiltersBanEnabled: true,
      messageLimitsBlockedWords: ['стопслово'],
    });
    const prisma = {
      chat: {
        upsert: jest
          .fn()
          .mockResolvedValue({ id: 'chat-1', title: 'Chat 1', settings, domains: [] }),
      },
      violation: { create: jest.fn(), count: jest.fn() },
      moderationEvent: { findFirst: jest.fn().mockResolvedValue(null), create: jest.fn() },
      webhookEvent: { findUnique: jest.fn(), update: jest.fn() },
    };
    const maxClient = {
      deleteMessage: jest.fn(),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };
    const sanctions = { resolveAction: jest.fn() };
    const ruleEngine = new RuleEngineService(createRedisCounterMock() as never);
    const service = new ModerationService(
      prisma as never,
      ruleEngine,
      sanctions as never,
      maxClient as never,
    );
    const intents = {
      ensureIntent: jest.fn(),
      ensureAndAttempt: jest.fn().mockResolvedValue({ status: 'deleted' }),
      getRolloutForInput: jest.fn().mockReturnValue('off'),
    };
    Object.assign(service, { moderationDeleteIntentService: intents });
    return { service, prisma, maxClient, sanctions, intents };
  }

  it.each(protectedTexts)(
    'does not create a commercial intent or sanction for %s',
    async (text) => {
      const { service, prisma, maxClient, sanctions, intents } = setup();
      for (const type of ['message_created', 'message_edited'] as const) {
        const update = createUpdate();
        update.type = type;
        update.updateId = `audit-${type}`;
        update.message!.text = text;
        await service.handleUpdate(update);
      }
      expect(intents.ensureIntent).not.toHaveBeenCalled();
      expect(intents.ensureAndAttempt).not.toHaveBeenCalled();
      expect(maxClient.deleteMessage).not.toHaveBeenCalled();
      expect(maxClient.banMember).not.toHaveBeenCalled();
      expect(maxClient.kickMember).not.toHaveBeenCalled();
      expect(prisma.violation.create).not.toHaveBeenCalled();
      expect(prisma.violation.count).not.toHaveBeenCalled();
      expect(sanctions.resolveAction).not.toHaveBeenCalled();
    },
  );

  it('preserves an independent stop-word violation in an otherwise protected request', async () => {
    const { service, prisma, intents } = setup();
    const update = createUpdate();
    update.message!.text = `${protectedTexts[3]} Стопслово.`;
    await service.handleUpdate(update);
    expect(intents.ensureIntent).toHaveBeenCalledWith(
      expect.objectContaining({ ruleCode: 'MESSAGE_BLOCKED_WORD_DELETE' }),
    );
    expect(prisma.violation.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ ruleCode: 'MESSAGE_BLOCKED_WORD' }),
    });
  });
});
