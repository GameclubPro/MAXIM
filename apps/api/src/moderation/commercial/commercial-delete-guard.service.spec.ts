import { ConfigService } from '@nestjs/config';
import { CommercialAdDetector } from './commercial-ad.detector';
import {
  buildCommercialTextDeleteBinding,
  commercialTextDeleteReasonKey,
  COMMERCIAL_TEXT_DELETE_RULE_CODE,
  COMMERCIAL_TEXT_DELETE_MAX_AGE_MS,
} from './commercial-delete-binding';
import { CommercialDeleteGuardService } from './commercial-delete-guard.service';

const text = 'Такси +7 900 000 10 42';
const input = {
  intentId: 'intent',
  chatId: 'chat',
  messageId: 'message',
  subjectUserId: 'user',
  botId: 'bot',
};
const message = (value = text) => ({
  body: { mid: 'message', text: value },
  sender: { user_id: 'user' },
  recipient: { chat_id: 'chat', chat_type: 'chat' },
  timestamp: Date.now(),
});

function harness() {
  const settings = {
    commercialAdsFilterEnabled: true,
    commercialAdsSensitivity: 'BALANCED' as const,
    commercialAdsWarnThreshold: 45,
    commercialAdsDeleteThreshold: 65,
    nightModeTimezone: 'Europe/Moscow',
    textFiltersWarnEnabled: true,
    textFiltersMuteEnabled: true,
    textFiltersBanEnabled: true,
    textFiltersMuteDurationHours: 1,
    textFiltersBotMessageEnabled: true,
    chat: { entityType: 'CHAT', admins: [] as { userId: string }[] },
  };
  const binding = buildCommercialTextDeleteBinding({
    text,
    settings,
    eventTimestampMs: Date.now(),
    campaignContext: null,
  });
  const reason = {
    ruleCode: COMMERCIAL_TEXT_DELETE_RULE_CODE,
    reasonKey: commercialTextDeleteReasonKey(binding),
    score: 0.45,
    metadata: { messageDisposition: 'DELETE', commercialTextBinding: binding },
  };
  const prisma = {
    chatSettings: { findUnique: jest.fn().mockImplementation(async () => settings) },
    moderationDeleteIntentReason: {
      findMany: jest.fn().mockResolvedValue([reason]),
      findFirst: jest.fn().mockResolvedValue(null),
    },
  };
  const max = {
    getExactMessageRow: jest.fn().mockResolvedValue(message()),
    getChatMemberAccess: jest
      .fn()
      .mockResolvedValue({ userId: 'user', isAdmin: false, isOwner: false }),
  };
  const botLink = { isKnownBotUserId: jest.fn().mockReturnValue(false) };
  const immunity = { consumeForMessage: jest.fn().mockResolvedValue('not_granted') };
  const service = new CommercialDeleteGuardService(
    prisma as never,
    max as never,
    botLink as never,
    immunity as never,
    new ConfigService({ MODERATION_DELETE_INTENT_TIMEOUT_MS: 5000 }),
  );
  return { service, settings, binding, reason, prisma, max, botLink, immunity };
}

describe('CommercialDeleteGuardService', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('checks the exact current message and permissions once per dispatch, using the executable bot', async () => {
    const h = harness();
    await expect(h.service.assertIntentStillActionable(input)).resolves.toEqual({
      kind: 'allowed',
      reasonKeys: [h.reason.reasonKey],
    });
    expect(h.max.getExactMessageRow).toHaveBeenCalledTimes(1);
    expect(h.max.getExactMessageRow).toHaveBeenCalledWith(
      'chat',
      'message',
      expect.objectContaining({
        botId: 'bot',
        bypassCache: true,
        timeoutMs: 5000,
        trafficClass: 'critical',
      }),
    );
    expect(h.max.getChatMemberAccess).toHaveBeenCalledTimes(1);
    expect(h.prisma.chatSettings.findUnique).toHaveBeenCalledTimes(2);
  });

  it('does not delete an edited source under its previous binding', async () => {
    const h = harness();
    h.max.getExactMessageRow.mockResolvedValue(message('Спасибо за помощь'));
    await expect(h.service.assertIntentStillActionable(input)).rejects.toMatchObject({
      code: 'commercial_text_message_changed',
      reasonFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect(h.immunity.consumeForMessage).not.toHaveBeenCalled();
  });

  it('uses the latest event revision, not arrival order or an older expired decision', async () => {
    const h = harness();
    const old = buildCommercialTextDeleteBinding({
      text: 'Старое объявление',
      settings: h.settings,
      eventTimestampMs: Date.now() - COMMERCIAL_TEXT_DELETE_MAX_AGE_MS - 1,
      campaignContext: null,
    });
    h.prisma.moderationDeleteIntentReason.findMany.mockResolvedValue([
      h.reason,
      {
        ...h.reason,
        reasonKey: commercialTextDeleteReasonKey(old),
        score: 1,
        metadata: { commercialTextBinding: old },
      },
    ]);
    await expect(h.service.assertIntentStillActionable(input)).resolves.toEqual({
      kind: 'allowed',
      reasonKeys: [h.reason.reasonKey],
    });
  });

  it('fails closed for conflicting sources at the same event timestamp', async () => {
    const h = harness();
    const other = buildCommercialTextDeleteBinding({
      text: 'Другое объявление',
      settings: h.settings,
      eventTimestampMs: h.binding.eventTimestampMs,
      campaignContext: null,
    });
    h.prisma.moderationDeleteIntentReason.findMany.mockResolvedValue([
      h.reason,
      {
        ...h.reason,
        reasonKey: commercialTextDeleteReasonKey(other),
        metadata: { commercialTextBinding: other },
      },
    ]);
    await expect(h.service.assertIntentStillActionable(input)).rejects.toMatchObject({
      code: 'commercial_text_binding_invalid',
    });
    expect(h.max.getExactMessageRow).not.toHaveBeenCalled();
  });

  it.each([
    { version: 2 },
    { sourceSha256: 'invalid' },
    { extra: true },
    { campaignContext: { rawText: 'private' } },
  ])('rejects malformed bindings before network calls: %j', async (change) => {
    const h = harness();
    h.prisma.moderationDeleteIntentReason.findMany.mockResolvedValue([
      { ...h.reason, metadata: { commercialTextBinding: { ...h.binding, ...change } } },
    ]);
    await expect(h.service.assertIntentStillActionable(input)).rejects.toMatchObject({
      code: 'commercial_text_binding_invalid',
    });
    expect(h.max.getExactMessageRow).not.toHaveBeenCalled();
  });

  it.each([
    { decisionVersion: 'old' },
    { detectorSourceSha256: '0'.repeat(64) },
    { deadlineAtMs: 1 },
    { eventTimestampMs: Date.now() + 120_000 },
  ])('rejects obsolete behavior or deadlines: %j', async (change) => {
    const h = harness();
    h.prisma.moderationDeleteIntentReason.findMany.mockResolvedValue([
      { ...h.reason, metadata: { commercialTextBinding: { ...h.binding, ...change } } },
    ]);
    await expect(h.service.assertIntentStillActionable(input)).rejects.toMatchObject({
      code: 'commercial_text_binding_stale',
    });
  });

  it.each(['KEEP', null, 'UNKNOWN'])(
    'rejects explicit non-deletion metadata: %j',
    async (disposition) => {
      const h = harness();
      h.prisma.moderationDeleteIntentReason.findMany.mockResolvedValue([
        { ...h.reason, metadata: { messageDisposition: disposition } },
      ]);
      await expect(h.service.assertIntentStillActionable(input)).rejects.toMatchObject({
        code: 'commercial_text_binding_invalid',
      });
    },
  );

  it('rechecks a legacy decision without trusting unbound campaign evidence', async () => {
    const h = harness();
    h.prisma.moderationDeleteIntentReason.findMany.mockResolvedValue([
      { ...h.reason, metadata: { campaignContext: { senderDistinctChatCount: 999 } } },
    ]);
    const detect = jest.spyOn(CommercialAdDetector.prototype, 'detect');
    await expect(h.service.assertIntentStillActionable(input)).resolves.toMatchObject({
      kind: 'allowed',
    });
    expect(detect).toHaveBeenLastCalledWith(
      expect.objectContaining({ commercialCampaignContext: null }),
    );
    h.max.getExactMessageRow.mockResolvedValue(message('Ищу такси, кто сможет отвезти?'));
    await expect(h.service.assertIntentStillActionable(input)).rejects.toMatchObject({
      code: 'commercial_text_violation_no_longer_present',
    });
  });

  it('does not delete under weaker current evidence than the selected stored decision', async () => {
    const h = harness();
    h.prisma.moderationDeleteIntentReason.findMany.mockResolvedValue([{ ...h.reason, score: 1 }]);
    await expect(h.service.assertIntentStillActionable(input)).rejects.toMatchObject({
      code: 'commercial_text_violation_no_longer_present',
    });
  });

  it('checks disabled settings before MAX calls', async () => {
    const h = harness();
    h.settings.commercialAdsFilterEnabled = false;
    await expect(h.service.assertIntentStillActionable(input)).rejects.toMatchObject({
      code: 'commercial_text_settings_disabled',
    });
    expect(h.max.getChatMemberAccess).not.toHaveBeenCalled();
  });

  it.each(['commercialAdsWarnThreshold', 'textFiltersMuteDurationHours'] as const)(
    'rejects changed current policy: %s',
    async (key) => {
      const h = harness();
      h.settings[key] += 1;
      await expect(h.service.assertIntentStillActionable(input)).rejects.toMatchObject({
        code: 'commercial_text_binding_stale',
      });
    },
  );

  it('rechecks policy after MAX work and immunity', async () => {
    const h = harness();
    h.immunity.consumeForMessage.mockImplementation(async () => {
      h.settings.textFiltersBanEnabled = false;
      return 'not_granted';
    });
    await expect(h.service.assertIntentStillActionable(input)).rejects.toMatchObject({
      code: 'commercial_text_binding_stale',
    });
  });

  it('rechecks the absolute deadline after remote work', async () => {
    jest.useFakeTimers();
    const h = harness();
    h.max.getExactMessageRow.mockImplementation(async () => {
      jest.setSystemTime(h.binding.deadlineAtMs);
      return message();
    });
    await expect(h.service.assertIntentStillActionable(input)).rejects.toMatchObject({
      code: 'commercial_text_binding_stale',
    });
  });

  it.each(['bot', 'local-admin', 'remote-admin', 'participant'])(
    'protects current author access: %s',
    async (kind) => {
      const h = harness();
      if (kind === 'bot') h.botLink.isKnownBotUserId.mockReturnValue(true);
      if (kind === 'local-admin') h.settings.chat.admins.push({ userId: 'user' });
      if (kind === 'remote-admin')
        h.max.getChatMemberAccess.mockResolvedValue({
          userId: 'user',
          isAdmin: true,
          isOwner: false,
        });
      if (kind === 'participant') h.immunity.consumeForMessage.mockResolvedValue('granted');
      await expect(h.service.assertIntentStillActionable(input)).rejects.toMatchObject({
        code: 'commercial_text_author_immune',
      });
    },
  );

  it('does not leave an extant bound ad in the chat merely because its author left', async () => {
    const h = harness();
    h.max.getChatMemberAccess.mockResolvedValue(null);
    await expect(h.service.assertIntentStillActionable(input)).resolves.toEqual({
      kind: 'allowed',
      reasonKeys: [h.reason.reasonKey],
    });
    expect(h.max.getExactMessageRow).toHaveBeenCalledTimes(1);
    expect(h.immunity.consumeForMessage).toHaveBeenCalledTimes(1);
  });

  it('does not treat an unavailable membership check as a verified departure', async () => {
    const h = harness();
    h.max.getChatMemberAccess.mockRejectedValue(new Error('Invalid MAX chat members response'));
    await expect(h.service.assertIntentStillActionable(input)).rejects.toThrow(
      'Invalid MAX chat members response',
    );
    expect(h.max.getExactMessageRow).not.toHaveBeenCalled();
  });

  it('treats exact absence as absence, not proof for a new strike', async () => {
    const h = harness();
    h.max.getExactMessageRow.mockResolvedValue(null);
    await expect(h.service.assertIntentStillActionable(input)).resolves.toBe('absent');
    expect(h.immunity.consumeForMessage).not.toHaveBeenCalled();
  });

  it('propagates uncertain network failures for bounded retry', async () => {
    const h = harness();
    h.max.getExactMessageRow.mockRejectedValue(new Error('network timeout'));
    await expect(h.service.assertIntentStillActionable(input)).rejects.toThrow('network timeout');
  });

  it('preserves independent reasons and distinguishes a missing reason', async () => {
    const h = harness();
    h.prisma.moderationDeleteIntentReason.findMany.mockResolvedValue([
      { ...h.reason, ruleCode: 'LINK_BLOCKED_DELETE' },
      h.reason,
    ]);
    await expect(h.service.assertIntentStillActionable(input)).resolves.toBe('not_applicable');
    h.prisma.moderationDeleteIntentReason.findMany.mockResolvedValue([]);
    await expect(h.service.assertIntentStillActionable(input)).resolves.toBe('missing_reason');
    expect(h.max.getExactMessageRow).not.toHaveBeenCalled();
  });

  it('bounds reason fanout while preserving independently authorized deletion', async () => {
    const h = harness();
    h.prisma.moderationDeleteIntentReason.findMany.mockResolvedValue(
      Array.from({ length: 65 }, (_, index) => ({ ...h.reason, reasonKey: `reason-${index}` })),
    );
    await expect(h.service.assertIntentStillActionable(input)).rejects.toMatchObject({
      code: 'commercial_text_binding_invalid',
    });
    h.prisma.moderationDeleteIntentReason.findFirst.mockResolvedValue({ id: 'independent' });
    await expect(h.service.assertIntentStillActionable(input)).resolves.toBe('not_applicable');
    expect(h.max.getExactMessageRow).not.toHaveBeenCalled();
  });
});
