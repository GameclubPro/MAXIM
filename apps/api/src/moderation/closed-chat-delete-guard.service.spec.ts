import { ConfigService } from '@nestjs/config';
import { ClosedChatDeleteGuardService } from './closed-chat-delete-guard.service';

const now = Date.parse('2026-10-05T00:04:00Z');
const sourceAt = new Date(now - 60_000);
const nightReason = {
  ruleCode: 'NIGHT_MODE_DELETE',
  reasonKey: 'night',
  metadata: { nightModeTimezone: 'UTC', nightModeStartTime: '23:00', nightModeEndTime: '08:00' },
};
const input = {
  chatId: '-123',
  messageId: 'm1',
  subjectUserId: 'u1',
  sourceMessageAt: sourceAt,
  botId: 'reserve-last',
  reasons: [nightReason],
};

function fixture() {
  const settings = {
    nightModeEnabled: true,
    nightModeStartTimeMinutes: 1380,
    nightModeEndTimeMinutes: 480,
    nightModeTimezone: 'UTC',
    nightModeForceCloseEnabled: false,
    nightModeForceCloseForever: false,
    nightModeForceCloseUntil: '',
    chat: {
      entityType: 'CHAT',
      admins: [] as { userId: string }[],
      chatControlOrderAt: null as Date | null,
    },
  };
  const row = {
    sender: { user_id: 'u1' },
    recipient: { chat_id: '-123', chat_type: 'chat' },
    timestamp: sourceAt.getTime(),
    body: { mid: 'm1', text: 'hello' },
  };
  const prisma = { chatSettings: { findUnique: jest.fn(async () => settings) } };
  const max = {
    getChatMemberAccess: jest.fn(async () => ({ userId: 'u1', isAdmin: false, isOwner: false })),
    getExactMessageRow: jest.fn(async () => row as unknown),
  };
  const bots = { isKnownBotUserId: jest.fn(() => false) };
  const immunity = { consumeForMessage: jest.fn(async () => 'not_granted') };
  const guard = new ClosedChatDeleteGuardService(
    prisma as never,
    max as never,
    bots as never,
    immunity as never,
    new ConfigService(),
  );
  return { settings, row, prisma, max, bots, immunity, guard };
}

describe('closed-chat final delete authority', () => {
  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    jest.setSystemTime(now);
  });
  afterEach(() => jest.useRealTimers());

  it('reads the exact author/message through the replacement executor', async () => {
    const h = fixture();
    await expect(h.guard.authorize(input)).resolves.toEqual({
      reasonKeys: ['night'],
      deadlineAtMs: sourceAt.getTime() + 300_000,
      reasonDeadlines: [{ reasonKey: 'night', deadlineAtMs: sourceAt.getTime() + 300_000 }],
    });
    expect(h.max.getChatMemberAccess).toHaveBeenCalledWith(
      '-123',
      'u1',
      expect.objectContaining({ botId: 'reserve-last', bypassCache: true }),
    );
    expect(h.max.getExactMessageRow).toHaveBeenCalledWith(
      '-123',
      'm1',
      expect.objectContaining({ botId: 'reserve-last' }),
    );
  });

  it.each([
    'disabled',
    'opened',
    'new-session',
    'schedule',
    'future',
    'deadline',
    'reclosed',
  ] as const)('rejects a saved night reason after %s', async (change) => {
    const h = fixture();
    let source = sourceAt;
    if (change === 'disabled') h.settings.nightModeEnabled = false;
    if (change === 'opened') jest.setSystemTime(Date.parse('2026-10-05T08:00:00Z'));
    if (change === 'new-session') jest.setSystemTime(now + 24 * 60 * 60_000);
    if (change === 'schedule') h.settings.nightModeStartTimeMinutes = 22 * 60;
    if (change === 'future') source = new Date(now + 60_001);
    if (change === 'deadline') source = new Date(now - 300_000);
    if (change === 'reclosed') h.settings.chat.chatControlOrderAt = new Date(now - 30_000);
    await expect(h.guard.authorize({ ...input, sourceMessageAt: source })).rejects.toMatchObject({
      code: 'closed_chat_delete_no_longer_authorized',
    });
    expect(h.max.getExactMessageRow).not.toHaveBeenCalled();
  });

  it.each([
    'admin',
    'local-admin',
    'bot',
    'immunity',
    'wrong-author',
    'channel',
    'changed-source',
  ] as const)('protects %s at dispatch', async (change) => {
    const h = fixture();
    if (change === 'admin')
      h.max.getChatMemberAccess.mockResolvedValue({ userId: 'u1', isAdmin: true, isOwner: false });
    if (change === 'local-admin') h.settings.chat.admins.push({ userId: 'u1' });
    if (change === 'bot') h.bots.isKnownBotUserId.mockReturnValue(true);
    if (change === 'immunity') h.immunity.consumeForMessage.mockResolvedValue('granted');
    if (change === 'wrong-author') h.row.sender.user_id = 'another';
    if (change === 'channel') h.row.recipient.chat_type = 'channel';
    if (change === 'changed-source') h.row.timestamp += 1;
    await expect(h.guard.authorize(input)).rejects.toMatchObject({
      code: 'closed_chat_delete_no_longer_authorized',
    });
  });

  it('checks the policy again after remote work and immunity', async () => {
    const h = fixture();
    h.immunity.consumeForMessage.mockImplementation(async () => {
      h.settings.nightModeEnabled = false;
      return 'not_granted';
    });
    await expect(h.guard.authorize(input)).rejects.toMatchObject({
      code: 'closed_chat_delete_no_longer_authorized',
    });
  });

  it('cannot interpret unavailable author or message evidence as a policy rejection', async () => {
    const h = fixture();
    h.max.getChatMemberAccess.mockResolvedValue({
      userId: 'wrong',
      isAdmin: false,
      isOwner: false,
    });
    await expect(h.guard.authorize(input)).rejects.toThrow('Closed chat author access unavailable');
    h.max.getChatMemberAccess.mockResolvedValue({ userId: 'u1', isAdmin: false, isOwner: false });
    const error = new Error('MAX unavailable');
    h.max.getExactMessageRow.mockRejectedValue(error);
    await expect(h.guard.authorize(input)).rejects.toBe(error);
  });

  it('reports exact absence and ignores independently owned reasons', async () => {
    const h = fixture();
    h.max.getExactMessageRow.mockResolvedValue(null);
    await expect(h.guard.authorize(input)).resolves.toBe('absent');
    await expect(
      h.guard.authorize({
        ...input,
        reasons: [{ ruleCode: 'MESSAGE_TOO_LONG_DELETE', reasonKey: 'length', metadata: {} }],
      }),
    ).resolves.toBe('not_applicable');
  });

  it('expires timed manual closure at its absolute end and rejects a changed closure', async () => {
    const h = fixture();
    h.settings.nightModeForceCloseEnabled = true;
    h.settings.nightModeForceCloseUntil = new Date(now + 30_000).toISOString();
    const reason = {
      ruleCode: 'MANUAL_GROUP_CLOSE_DELETE',
      reasonKey: 'manual',
      metadata: { closeMode: 'timed', closeUntil: h.settings.nightModeForceCloseUntil },
    };
    await expect(h.guard.authorize({ ...input, reasons: [reason] })).resolves.toEqual({
      reasonKeys: ['manual'],
      deadlineAtMs: now + 30_000,
      reasonDeadlines: [{ reasonKey: 'manual', deadlineAtMs: now + 30_000 }],
    });
    h.settings.nightModeForceCloseUntil = new Date(now + 90_000).toISOString();
    await expect(h.guard.authorize({ ...input, reasons: [reason] })).rejects.toMatchObject({
      code: 'closed_chat_delete_no_longer_authorized',
    });
    h.settings.nightModeForceCloseUntil = reason.metadata.closeUntil;
    jest.setSystemTime(now + 30_000);
    await expect(h.guard.authorize({ ...input, reasons: [reason] })).rejects.toMatchObject({
      code: 'closed_chat_delete_no_longer_authorized',
    });
  });

  it('bounds night authorization by the opening boundary', async () => {
    const h = fixture();
    const boundaryNow = Date.parse('2026-10-05T07:59:30Z');
    jest.setSystemTime(boundaryNow);
    const source = new Date(boundaryNow - 60_000);
    h.row.timestamp = source.getTime();
    await expect(h.guard.authorize({ ...input, sourceMessageAt: source })).resolves.toEqual({
      reasonKeys: ['night'],
      deadlineAtMs: boundaryNow + 30_000,
      reasonDeadlines: [{ reasonKey: 'night', deadlineAtMs: boundaryNow + 30_000 }],
    });
  });

  it('keeps the timed manual end independent of the longer night authorization', async () => {
    const h = fixture();
    h.settings.nightModeForceCloseEnabled = true;
    h.settings.nightModeForceCloseUntil = new Date(now + 30_000).toISOString();
    const manual = {
      ruleCode: 'MANUAL_GROUP_CLOSE_DELETE',
      reasonKey: 'manual',
      metadata: { closeMode: 'timed', closeUntil: h.settings.nightModeForceCloseUntil },
    };
    await expect(h.guard.authorize({ ...input, reasons: [manual, nightReason] })).resolves.toEqual({
      reasonKeys: ['manual', 'night'],
      deadlineAtMs: sourceAt.getTime() + 300_000,
      reasonDeadlines: [
        { reasonKey: 'manual', deadlineAtMs: now + 30_000 },
        { reasonKey: 'night', deadlineAtMs: sourceAt.getTime() + 300_000 },
      ],
    });
    jest.setSystemTime(now + 30_000);
    await expect(h.guard.authorize({ ...input, reasons: [manual, nightReason] })).resolves.toEqual({
      reasonKeys: ['night'],
      deadlineAtMs: sourceAt.getTime() + 300_000,
      reasonDeadlines: [{ reasonKey: 'night', deadlineAtMs: sourceAt.getTime() + 300_000 }],
    });
  });
});
