import { ConfigService } from '@nestjs/config';
import { stopWordsPolicySchema } from '@maxim/contracts/settings';
import { StopWordsDeleteGuardService } from './stop-words-delete-guard.service';
import { detectStopWordsViolations } from './stop-words.detection';

function harness() {
  const policy = stopWordsPolicySchema.parse({
    enabled: true,
    rules: [{ id: 'casino', kind: 'WORD', value: 'casino' }],
    sanctions: { warnEnabled: true, muteEnabled: true },
  });
  const settings = {
    stopWordsPolicy: policy,
    stopWordsRevision: 3,
    messageLimitsBlockedWords: [],
    messageLimitsBlockedDomains: [],
    nightModeTimezone: 'Europe/Moscow',
    chat: {
      entityType: 'CHAT',
      admins: [] as { userId: string }[],
      domains: [] as { domain: string }[],
    },
  };
  const metadata = detectStopWordsViolations({ text: 'casino', settings })[0]!.metadata;
  const reasons = [{ ruleCode: 'MESSAGE_BLOCKED_WORD_DELETE', metadata }];
  const prisma = {
    chatSettings: { findUnique: jest.fn().mockImplementation(async () => settings) },
    moderationDeleteIntentReason: { findMany: jest.fn().mockResolvedValue(reasons) },
    moderationDeleteIntent: { findFirst: jest.fn().mockResolvedValue(null) },
  };
  const message = (text: string) => ({
    body: { mid: 'message-1', text },
    sender: { user_id: 'user-1' },
    recipient: { chat_id: 'chat-1', chat_type: 'chat' },
    timestamp: Date.now(),
  });
  const max = {
    getExactMessageRow: jest.fn().mockResolvedValue(message('casino')),
    getChatMemberAccess: jest
      .fn()
      .mockResolvedValue({ userId: 'user-1', isAdmin: false, isOwner: false }),
  };
  const bots = { isKnownBotUserId: jest.fn().mockReturnValue(false) };
  const immunity = { consumeForMessage: jest.fn().mockResolvedValue('not_granted') };
  const guard = new StopWordsDeleteGuardService(
    prisma as never,
    max as never,
    bots as never,
    immunity as never,
    new ConfigService(),
  );
  const input = {
    intentId: 'intent-1',
    chatId: 'chat-1',
    messageId: 'message-1',
    subjectUserId: 'user-1',
  };
  return { settings, metadata, reasons, prisma, max, bots, immunity, guard, input, message };
}

describe('StopWordsDeleteGuardService', () => {
  it('keeps legacy sanctions on their existing path only before policy activation', async () => {
    const h = harness();
    h.prisma.chatSettings.findUnique.mockResolvedValue({ ...h.settings, stopWordsPolicy: null });
    await expect(h.guard.assertSanctionStillActionable({ ...h.input, ruleCode: 'MESSAGE_BLOCKED_WORD', metadata: {}, action: 'MUTE' })).resolves.toBeUndefined();
    expect(h.max.getExactMessageRow).not.toHaveBeenCalled();
  });
  it('rechecks exact source, rule identity and settings before deletion', async () => {
    const h = harness();
    await expect(h.guard.assertIntentStillActionable(h.input)).resolves.toBe('allowed');
    expect(h.prisma.chatSettings.findUnique).toHaveBeenCalledTimes(2);
    expect(h.max.getExactMessageRow).toHaveBeenCalledTimes(1);
  });
  it.each(['enabled', 'rule', 'revision', 'admin', 'bot', 'immunity', 'edited'])(
    'rejects %s changes',
    async (change) => {
      const h = harness();
      if (change === 'enabled') h.settings.stopWordsPolicy.enabled = false;
      if (change === 'rule') h.settings.stopWordsPolicy.rules[0]!.enabled = false;
      if (change === 'revision') h.settings.stopWordsRevision += 1;
      if (change === 'admin')
        h.max.getChatMemberAccess.mockResolvedValue({
          userId: 'user-1',
          isAdmin: true,
          isOwner: false,
        });
      if (change === 'bot') h.bots.isKnownBotUserId.mockReturnValue(true);
      if (change === 'immunity') h.immunity.consumeForMessage.mockResolvedValue('granted');
      if (change === 'edited') h.max.getExactMessageRow.mockResolvedValue(h.message('Спасибо'));
      await expect(h.guard.assertIntentStillActionable(h.input)).rejects.toMatchObject({
        code: 'stop_words_delete_no_longer_authorized',
      });
    },
  );
  it('rejects a settings change after remote verification', async () => {
    const h = harness();
    h.prisma.chatSettings.findUnique
      .mockResolvedValueOnce(h.settings)
      .mockResolvedValueOnce({ ...h.settings, stopWordsRevision: 4 });
    await expect(h.guard.assertIntentStillActionable(h.input)).rejects.toMatchObject({
      code: 'stop_words_delete_no_longer_authorized',
    });
  });
  it('does not cancel independent reasons when the stop-list is disabled', async () => {
    const h = harness();
    h.settings.stopWordsPolicy.enabled = false;
    h.reasons.push({ ruleCode: 'NIGHT_MODE_DELETE', metadata: {} });
    await expect(h.guard.assertIntentStillActionable(h.input)).resolves.toBe('not_applicable');
    expect(h.max.getExactMessageRow).not.toHaveBeenCalled();
  });
  it('handles exact absence without assuming it authorizes a participant sanction', async () => {
    const h = harness();
    h.max.getExactMessageRow.mockResolvedValue(null);
    await expect(h.guard.assertIntentStillActionable(h.input)).resolves.toBe('absent');
    await expect(
      h.guard.assertSanctionStillActionable({
        ...h.input,
        ruleCode: 'MESSAGE_BLOCKED_WORD',
        metadata: h.metadata,
        action: 'MUTE',
      }),
    ).rejects.toMatchObject({ code: 'stop_words_delete_no_longer_authorized' });
  });
  it('allows a configured sanction after this exact guarded deletion succeeded', async () => {
    const h = harness();
    h.max.getExactMessageRow.mockResolvedValue(null);
    h.prisma.moderationDeleteIntent.findFirst.mockResolvedValue({ id: 'intent-1' });
    await expect(
      h.guard.assertSanctionStillActionable({
        ...h.input,
        ruleCode: 'MESSAGE_BLOCKED_WORD',
        metadata: h.metadata,
        action: 'MUTE',
      }),
    ).resolves.toBeUndefined();
  });
  it('does not permit a disabled sanction or a stronger action', async () => {
    const h = harness();
    await expect(
      h.guard.assertSanctionStillActionable({
        ...h.input,
        ruleCode: 'MESSAGE_BLOCKED_WORD',
        metadata: h.metadata,
        action: 'BAN',
      }),
    ).rejects.toMatchObject({ code: 'stop_words_delete_no_longer_authorized' });
  });
});
