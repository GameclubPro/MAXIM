import { ConfigService } from '@nestjs/config';
import { stopWordsPolicySchema } from '@maxim/contracts/settings';
import {
  MessageLimitsDeleteGuardService,
  bindMessageLimitEvidence,
  fingerprintModerationSettings,
} from './message-limits-delete-guard.service';

const input = {
  chatId: '-123',
  messageId: 'message-1',
  subjectUserId: 'user-1',
  botId: 'executor-b',
  reasons: [{ ruleCode: 'MESSAGE_TOO_LONG_DELETE', reasonKey: 'length' }],
};

function fixture() {
  const settings = {
    maxMessageLengthEnabled: true,
    maxMessageLength: 10,
    phoneNumbersEnabled: true,
    photoMessagesEnabled: true,
    videoMessagesEnabled: true,
    fileMessagesEnabled: true,
    voiceMessagesEnabled: true,
    forwardedMessagesEnabled: true,
    nightModeTimezone: 'UTC',
    chat: { entityType: 'CHAT', admins: [] as { userId: string }[] },
  };
  const message = {
    sender: { user_id: 'user-1' },
    recipient: { chat_id: '-123', chat_type: 'chat' },
    timestamp: Date.now(),
    body: { mid: 'message-1', text: '12345678901' },
  };
  const prisma = { chatSettings: { findUnique: jest.fn(async () => settings) } };
  const max = {
    getChatMemberAccess: jest.fn(async () => ({
      userId: 'user-1',
      isAdmin: false,
      isOwner: false,
    })),
    getExactMessageRow: jest.fn(async () => message as unknown),
  };
  const bots = { isKnownBotUserId: jest.fn(() => false) };
  const immunity = { consumeForMessage: jest.fn(async () => 'not_granted') };
  const service = new MessageLimitsDeleteGuardService(
    prisma as never,
    max as never,
    bots as never,
    immunity as never,
    new ConfigService(),
  );
  return { service, max, settings, message, immunity, prisma, bots };
}

describe('current message limit deletion authorization', () => {
  it('normalizes full settings and a semantic DTO and ignores unrelated UI changes', () => {
    const subset = {
      maxMessageLengthEnabled: true,
      maxMessageLength: 10,
      messageLimitsWarnEnabled: true,
    };
    const full = {
      ...subset,
      id: 'row',
      updatedAt: new Date(),
      greetingEnabled: true,
      publisherAutoReplyEnabled: true,
    };
    expect(fingerprintModerationSettings(full, 'MESSAGE_TOO_LONG_DELETE')).toBe(
      fingerprintModerationSettings(subset, 'MESSAGE_TOO_LONG'),
    );
    expect(
      fingerprintModerationSettings(
        { ...full, greetingEnabled: false, updatedAt: new Date(0) },
        'MESSAGE_TOO_LONG',
      ),
    ).toBe(fingerprintModerationSettings(full, 'MESSAGE_TOO_LONG'));
    expect(
      fingerprintModerationSettings({ ...full, maxMessageLength: 20 }, 'MESSAGE_TOO_LONG'),
    ).not.toBe(fingerprintModerationSettings(full, 'MESSAGE_TOO_LONG'));
  });

  it.each(['MESSAGE_BLOCKED_WORD', 'MESSAGE_BLOCKED_DOMAIN'])(
    'binds %s sanctions to the settings actually used by legacy and configured policies',
    (rule) => {
      const legacy = {
        stopWordsPolicy: null,
        stopWordsRevision: 0,
        messageLimitsBlockedWords: ['casino'],
        messageLimitsBlockedDomains: ['spam.test'],
        textFiltersWarnEnabled: true,
        textFiltersMuteEnabled: true,
        textFiltersBanEnabled: true,
        textFiltersMuteDurationHours: 1,
        messageLimitsWarnEnabled: true,
        messageLimitsMuteEnabled: true,
        messageLimitsBanEnabled: true,
        messageLimitsMuteDurationHours: 1,
      };
      const original = fingerprintModerationSettings(legacy, rule);
      for (const patch of [
        { messageLimitsWarnEnabled: false },
        { messageLimitsMuteEnabled: false },
        { messageLimitsBanEnabled: false },
        { messageLimitsMuteDurationHours: 2 },
      ])
        expect(fingerprintModerationSettings({ ...legacy, ...patch }, rule)).not.toBe(original);
      for (const patch of [
        { textFiltersWarnEnabled: false },
        { textFiltersMuteEnabled: false },
        { textFiltersBanEnabled: false },
        { textFiltersMuteDurationHours: 2 },
      ])
        expect(fingerprintModerationSettings({ ...legacy, ...patch }, rule)).toBe(original);
      const stopWordsPolicy = stopWordsPolicySchema.parse({
        enabled: true,
        rules: [{ id: 'casino', kind: 'WORD', value: 'casino' }],
        sanctions: { warnEnabled: true },
      });
      const configured = { ...legacy, stopWordsPolicy };
      expect(
        fingerprintModerationSettings({ ...configured, textFiltersWarnEnabled: false }, rule),
      ).toBe(fingerprintModerationSettings(configured, rule));
      expect(
        fingerprintModerationSettings({ ...configured, messageLimitsBanEnabled: false }, rule),
      ).toBe(fingerprintModerationSettings(configured, rule));
      expect(
        fingerprintModerationSettings(
          {
            ...configured,
            stopWordsPolicy: {
              ...stopWordsPolicy,
              sanctions: { ...stopWordsPolicy.sanctions, warnEnabled: false },
            },
          },
          rule,
        ),
      ).not.toBe(fingerprintModerationSettings(configured, rule));
    },
  );

  it.each(['MESSAGE_RATE_LIMIT', 'MESSAGE_COUNT_LIMIT', 'PHOTO_RATE_LIMIT', 'STICKER_RATE_LIMIT'])(
    'requires unchanged bounded evidence for %s without counting a retry',
    async (rule) => {
      const s = fixture();
      Object.assign(s.settings, {
        antiSpamEnabled: true,
        messageCountLimitEnabled: true,
        messageCountLimitMessages: 2,
        messageCountLimitWindowHours: 1,
        photoMessageCooldownEnabled: true,
        photoMessageCooldownHours: 1,
        stickerMessageCooldownEnabled: true,
        stickerMessageCooldownMinutes: 5,
      });
      if (rule === 'PHOTO_RATE_LIMIT')
        Object.assign(s.message.body, {
          attachments: [{ type: 'image', payload: { photo_id: 'p1' } }],
        });
      if (rule === 'STICKER_RATE_LIMIT')
        Object.assign(s.message.body, {
          attachments: [{ type: 'sticker', payload: { code: 's1' } }],
        });
      const metadata = bindMessageLimitEvidence(s.settings as never, Date.now(), rule);
      const reasons = [{ reasonKey: 'rate', ruleCode: `${rule}_DELETE`, metadata }];
      await expect(s.service.authorize({ ...input, reasons })).resolves.toEqual({
        reasonKeys: ['rate'],
        deadlineAtMs: metadata.messageLimitDeadlineAtMs,
        reasonDeadlines: [{ reasonKey: 'rate', deadlineAtMs: metadata.messageLimitDeadlineAtMs }],
      });
      await expect(s.service.authorize({ ...input, reasons })).resolves.toEqual({
        reasonKeys: ['rate'],
        deadlineAtMs: metadata.messageLimitDeadlineAtMs,
        reasonDeadlines: [{ reasonKey: 'rate', deadlineAtMs: metadata.messageLimitDeadlineAtMs }],
      });
      Object.assign(
        s.settings,
        rule === 'MESSAGE_RATE_LIMIT'
          ? { antiSpamEnabled: false }
          : rule === 'MESSAGE_COUNT_LIMIT'
            ? { messageCountLimitMessages: 5 }
            : rule === 'PHOTO_RATE_LIMIT'
              ? { photoMessageCooldownEnabled: false }
              : { stickerMessageCooldownEnabled: false },
      );
      await expect(s.service.authorize({ ...input, reasons })).rejects.toMatchObject({
        code: 'message_limits_delete_no_longer_authorized',
      });
    },
  );

  it('retains a rate reason deadline when current content independently authorizes deletion', async () => {
    const s = fixture();
    Object.assign(s.settings, { antiSpamEnabled: true });
    const metadata = bindMessageLimitEvidence(
      s.settings as never,
      Date.now(),
      'MESSAGE_RATE_LIMIT',
    );
    const reasons = [
      ...input.reasons,
      { ruleCode: 'MESSAGE_RATE_LIMIT_DELETE', reasonKey: 'rate', metadata },
    ];
    await expect(s.service.authorize({ ...input, reasons })).resolves.toEqual({
      reasonKeys: ['length', 'rate'],
      reasonDeadlines: [{ reasonKey: 'rate', deadlineAtMs: metadata.messageLimitDeadlineAtMs }],
    });
    s.settings.maxMessageLengthEnabled = false;
    await expect(s.service.authorize({ ...input, reasons })).resolves.toEqual({
      reasonKeys: ['rate'],
      deadlineAtMs: metadata.messageLimitDeadlineAtMs,
      reasonDeadlines: [{ reasonKey: 'rate', deadlineAtMs: metadata.messageLimitDeadlineAtMs }],
    });
  });

  it('rejects historical frequency reasons without evidence and expired evidence', async () => {
    const s = fixture();
    Object.assign(s.settings, { antiSpamEnabled: true });
    const reason = { ruleCode: 'MESSAGE_RATE_LIMIT_DELETE', reasonKey: 'burst' };
    await expect(s.service.authorize({ ...input, reasons: [reason] })).rejects.toMatchObject({
      code: 'message_limits_delete_no_longer_authorized',
    });
    const metadata = bindMessageLimitEvidence(
      s.settings as never,
      Date.now() - 5 * 60_000,
      'MESSAGE_RATE_LIMIT',
    );
    await expect(
      s.service.authorize({ ...input, reasons: [{ ...reason, metadata }] }),
    ).rejects.toMatchObject({ code: 'message_limits_delete_no_longer_authorized' });
  });
  it.each([1, 4, 9, 13])('uses the selected executor for %s receiving bots', async (count) => {
    const s = fixture();
    for (let receiver = 0; receiver < count; receiver++) {
      expect(await s.service.authorize(input)).toEqual({ reasonKeys: ['length'] });
    }
    expect(s.max.getExactMessageRow.mock.calls).toHaveLength(count);
    expect(s.max.getExactMessageRow).toHaveBeenCalledWith(
      '-123',
      'message-1',
      expect.objectContaining({ botId: 'executor-b', bypassCache: true }),
    );
  });

  it.each(['edit', 'disabled', 'raised', 'changed-during-check'] as const)(
    'cancels a delayed length reason after %s',
    async (change) => {
      const s = fixture();
      if (change === 'edit') s.message.body.text = 'short';
      if (change === 'disabled') s.settings.maxMessageLengthEnabled = false;
      if (change === 'raised') s.settings.maxMessageLength = 50;
      if (change === 'changed-during-check')
        s.immunity.consumeForMessage.mockImplementation(async () => {
          s.settings.maxMessageLengthEnabled = false;
          return 'not_granted';
        });
      await expect(s.service.authorize(input)).rejects.toMatchObject({
        code: 'message_limits_delete_no_longer_authorized',
      });
    },
  );

  it('includes nested forwarded text in the current effective length', async () => {
    const s = fixture();
    s.message.body.text = '';
    Object.assign(s.message, {
      link: { type: 'forward', message: { body: { text: '12345678901' } } },
    });
    await expect(s.service.authorize(input)).resolves.toEqual({ reasonKeys: ['length'] });
  });

  it.each(['admin', 'local-admin', 'bot', 'immunity', 'wrong-author', 'channel'] as const)(
    'rejects protected or mismatched %s',
    async (kind) => {
      const s = fixture();
      if (kind === 'admin')
        s.max.getChatMemberAccess.mockResolvedValue({
          userId: 'user-1',
          isAdmin: true,
          isOwner: false,
        });
      if (kind === 'local-admin') s.settings.chat.admins.push({ userId: 'user-1' });
      if (kind === 'bot') s.bots.isKnownBotUserId.mockReturnValue(true);
      if (kind === 'immunity') s.immunity.consumeForMessage.mockResolvedValue('granted');
      if (kind === 'wrong-author') s.message.sender.user_id = 'other';
      if (kind === 'channel') s.message.recipient.chat_type = 'channel';
      await expect(s.service.authorize(input)).rejects.toMatchObject({
        code: 'message_limits_delete_no_longer_authorized',
      });
    },
  );

  it('never reclassifies unavailable remote evidence as a stale reason', async () => {
    const s = fixture();
    const error = Object.assign(new Error('unavailable'), { response: { status: 503 } });
    s.max.getExactMessageRow.mockRejectedValue(error);
    await expect(s.service.authorize(input)).rejects.toBe(error);
  });

  it.each([
    { userId: null, isAdmin: false, isOwner: false },
    { userId: 'other', isAdmin: false, isOwner: false },
    { userId: 'user-1', isAdmin: undefined, isOwner: false },
    { userId: 'user-1', isAdmin: false, isOwner: undefined },
  ])('stops all deletion reasons when fresh author access is incomplete: %p', async (access) => {
    const s = fixture();
    s.max.getChatMemberAccess.mockResolvedValue(access as never);
    await expect(s.service.authorize(input)).rejects.toThrow(
      'Message limits author access unavailable',
    );
    expect(s.max.getExactMessageRow).not.toHaveBeenCalled();
  });

  it('checks phones and attachment reasons independently against current settings', async () => {
    const s = fixture();
    s.settings.maxMessageLengthEnabled = false;
    s.settings.phoneNumbersEnabled = false;
    s.message.body.text = 'Телефон +7 999 123-45-67';
    const reasons = [
      ...input.reasons,
      { ruleCode: 'PHONE_NUMBER_BLOCKED_DELETE', reasonKey: 'phone' },
    ];
    await expect(s.service.authorize({ ...input, reasons })).resolves.toEqual({
      reasonKeys: ['phone'],
    });
    s.message.body.text = '';
    s.settings.photoMessagesEnabled = false;
    Object.assign(s.message.body, {
      attachments: [{ type: 'image', payload: { photo_id: 'photo' } }],
    });
    await expect(
      s.service.authorize({
        ...input,
        reasons: [{ ruleCode: 'PHOTO_BLOCKED_DELETE', reasonKey: 'photo' }],
      }),
    ).resolves.toEqual({ reasonKeys: ['photo'] });
    s.settings.photoMessagesEnabled = true;
    await expect(
      s.service.authorize({
        ...input,
        reasons: [{ ruleCode: 'PHOTO_BLOCKED_DELETE', reasonKey: 'photo' }],
      }),
    ).rejects.toMatchObject({ code: 'message_limits_delete_no_longer_authorized' });
  });
});
