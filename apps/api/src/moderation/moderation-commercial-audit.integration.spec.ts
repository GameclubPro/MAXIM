import { RuleEngineService } from './rule-engine.service';
import { WebhookParser } from '../webhook/webhook.parser';
import {
  ModerationService,
  createRedisCounterMock,
  createSettings,
} from './moderation.service.spec-support';

describe('commercial audit regressions in moderation execution', () => {
  const protectedTexts = [
    'Продам соковыжималку рабочая. При переезде утеряна деталь. Цена 500 рублей. Пишите в личку.',
    'Продам раму на УАЗ. Целая без сварки. Цена 40000. +7 900 000 10 42',
    'Мастер мне сегодня восстановил компьютер. Рекомендую, вот его номер +7 900 000 10 42.',
    'Срочно нужна машина: грузоперевозки или машина с прицепом. Звонить +7 900 000 10 42',
    'Нужно 2 места на завтра из города в посёлок. +7 900 000 10 42',
  ];

  function createAuditUpdate(
    text: string,
    type: 'message_created' | 'message_edited' = 'message_created',
  ): ReturnType<WebhookParser['parse']> {
    const timestamp = Date.now();
    // FLAG: Parse the same source that moderation inspects; changing normalized text alone
    // cannot stand in for a real visible webhook message.
    return new WebhookParser().parse({
      update_type: type,
      update_id: `audit-${type}`,
      timestamp,
      message: {
        timestamp,
        recipient: { chat_id: 'chat-1', chat_type: 'chat' },
        sender: { user_id: 'user-1', name: 'Алексей' },
        body: { mid: 'msg-1', text },
      },
    });
  }

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
        await service.handleUpdate(createAuditUpdate(text, type));
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

  it.each(['message_created', 'message_edited'] as const)(
    'preserves an independent stop-word violation in an otherwise protected %s request',
    async (type) => {
      const { service, prisma, intents } = setup();
      await service.handleUpdate(createAuditUpdate(`${protectedTexts[3]} Стопслово.`, type));
      expect(intents.ensureIntent).toHaveBeenCalledWith(
        expect.objectContaining({ ruleCode: 'MESSAGE_BLOCKED_WORD_DELETE' }),
        { enqueue: false },
      );
      expect(prisma.violation.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ ruleCode: 'MESSAGE_BLOCKED_WORD' }),
      });
    },
  );
});
