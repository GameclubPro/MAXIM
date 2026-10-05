import { ConfigService } from '@nestjs/config';
import { MessageLimitsDeleteGuardService } from './message-limits-delete-guard.service';

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
