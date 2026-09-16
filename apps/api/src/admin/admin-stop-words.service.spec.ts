import { ConfigService } from '@nestjs/config';
import { stopWordsPolicySchema } from '@maxim/contracts/settings';
import { AdminStopWordsService } from './admin-stop-words.service';
import { chatSettingsSchema } from '@maxim/contracts/settings';
import { sanitizeStoredChatSettings } from './admin-chat-settings';

function harness() {
  const row = {
    chatId: 'chat-1',
    stopWordsPolicy: stopWordsPolicySchema.parse({}),
    stopWordsRevision: 2,
    updatedAt: new Date(),
  };
  const tx = {
    chatSettings: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  };
  const prisma = {
    chatSettings: { findUnique: jest.fn().mockResolvedValue(row) },
    domainAllowlist: { findMany: jest.fn().mockResolvedValue([]) },
    $transaction: jest.fn(async (callback) => callback(tx)),
  };
  const admin = { assertChatAdminAccess: jest.fn().mockResolvedValue(undefined) };
  const capabilities = {
    assertChatSettingsBotCapabilities: jest.fn().mockResolvedValue(undefined),
  };
  const cache = { invalidate: jest.fn().mockResolvedValue(undefined) };
  const service = new AdminStopWordsService(
    prisma as never,
    admin as never,
    {} as never,
    capabilities as never,
    cache as never,
    new ConfigService(),
  );
  const user = { userId: 'admin-1' } as never;
  return { row, tx, prisma, admin, capabilities, cache, service, user };
}

describe('AdminStopWordsService', () => {
  it('does not reset other settings when the stored policy is malformed', () => {
    const row = {
      ...chatSettingsSchema.parse({ antiSpamEnabled: true }),
      stopWordsPolicy: { version: 99 },
    };
    const settings = chatSettingsSchema.parse(sanitizeStoredChatSettings(row));
    expect(settings.antiSpamEnabled).toBe(true);
    expect(settings.stopWordsPolicy?.enabled).toBe(false);
    expect(row.stopWordsPolicy.version).toBe(99);
  });
  it('checks chat access before every endpoint, including preview', async () => {
    const h = harness();
    h.admin.assertChatAdminAccess.mockRejectedValue(new Error('denied'));
    await expect(h.service.read('chat-1', h.user)).rejects.toThrow('denied');
    await expect(h.service.update('chat-1', h.user, {})).rejects.toThrow('denied');
    await expect(h.service.preview('chat-1', h.user, {})).rejects.toThrow('denied');
    expect(h.prisma.chatSettings.findUnique).not.toHaveBeenCalled();
  });
  it('returns a runtime ceiling separately from the per-chat checkbox', async () => {
    const h = harness();
    expect(await h.service.read('chat-1', h.user)).toMatchObject({
      revision: 2,
      imageScanStatus: 'shadow',
    });
  });
  it('writes only policy and revision with an atomic metadata-only audit', async () => {
    const h = harness();
    const result = await h.service.update('chat-1', h.user, {
      expectedRevision: 2,
      policy: {
        enabled: true,
        rules: [{ id: 'one', kind: 'WORD', value: 'casino' }],
        sanctions: { botMessageText: 'private-template' },
      },
    });
    expect(result.revision).toBe(3);
    expect(h.tx.chatSettings.updateMany).toHaveBeenCalledWith({
      where: { chatId: 'chat-1', stopWordsRevision: 2, updatedAt: h.row.updatedAt },
      data: {
        stopWordsPolicy: result.policy,
        stopWordsMedia: {},
        stopWordsRevision: { increment: 1 },
      },
    });
    expect(JSON.stringify(h.tx.auditLog.create.mock.calls)).not.toContain('private-template');
    expect(h.cache.invalidate).toHaveBeenCalledWith('chat-1');
    expect(h.capabilities.assertChatSettingsBotCapabilities).toHaveBeenCalled();
  });
  it.each([true, false])(
    'rejects stale revision before or during the transaction: %s',
    async (before) => {
      const h = harness();
      if (!before) h.tx.chatSettings.updateMany.mockResolvedValue({ count: 0 });
      await expect(
        h.service.update('chat-1', h.user, { expectedRevision: before ? 1 : 2, policy: {} }),
      ).rejects.toMatchObject({ status: 409 });
      expect(h.tx.auditLog.create).not.toHaveBeenCalled();
    },
  );
  it('previews with the production matcher without writes, MAX actions or audit text', async () => {
    const h = harness();
    const result = await h.service.preview('chat-1', h.user, {
      policy: {
        enabled: true,
        rules: [{ id: 'one', kind: 'PHRASE', value: 'доход без вложений' }],
      },
      text: 'Доход без вложений',
    });
    expect(result.matches[0]).toMatchObject({ ruleId: 'one', fragment: 'Доход без вложений' });
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
    expect(h.capabilities.assertChatSettingsBotCapabilities).not.toHaveBeenCalled();
  });
});
