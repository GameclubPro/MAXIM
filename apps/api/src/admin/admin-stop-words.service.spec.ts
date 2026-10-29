import { ConfigService } from '@nestjs/config';
import { stopWordsPolicySchema } from '@maxim/contracts/settings';
import { AdminStopWordsService } from './admin-stop-words.service';
import { chatSettingsSchema } from '@maxim/contracts/settings';
import { sanitizeStoredChatSettings } from './admin-chat-settings';
import { stopWordsPolicyStorage } from '../moderation/stop-words/stop-words.policy';

function harness() {
  const row = {
    chatId: 'chat-1',
    stopWordsPolicy: stopWordsPolicySchema.parse({}),
    stopWordsRevision: 2,
    updatedAt: new Date(),
  };
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([{ id: 'chat-1' }]),
    chatSettings: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUniqueOrThrow: jest
        .fn()
        .mockResolvedValue({ updatedAt: new Date('2026-10-29T16:00:00.000Z') }),
    },
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
  it('reports invalid stored policies without replacing them or changing unrelated settings', async () => {
    const h = harness();
    const malformed = { ...h.row, stopWordsPolicy: { version: 99 } };
    h.prisma.chatSettings.findUnique.mockResolvedValue(malformed);
    await expect(h.service.read('chat-1', h.user)).resolves.toMatchObject({
      storageStatus: 'invalid',
      revision: 2,
      policy: { enabled: false },
    });
    expect(malformed.stopWordsPolicy).toEqual({ version: 99 });
    expect(h.tx.chatSettings.updateMany).not.toHaveBeenCalled();
  });
  it('normalizes legacy button state on a copy before opening the editor', async () => {
    const h = harness();
    const legacy = {
      ...h.row,
      stopWordsPolicy: null,
      messageLimitsBlockedWords: ['casino'],
      messageLimitsBotButtonEnabled: true,
    };
    h.prisma.chatSettings.findUnique.mockResolvedValue(legacy);
    await expect(h.service.read('chat-1', h.user)).resolves.toMatchObject({
      storageStatus: 'legacy',
      policy: { enabled: true, sanctions: { botButtonEnabled: false } },
    });
    expect(legacy.messageLimitsBotButtonEnabled).toBe(true);
    expect(h.tx.chatSettings.updateMany).not.toHaveBeenCalled();
  });
  it('keeps invalid separate media intact and shows a disabled editable fallback', async () => {
    const h = harness();
    const malformed = {
      ...h.row,
      stopWordsPolicy: stopWordsPolicySchema.parse({ enabled: true }),
      stopWordsMedia: { explanation: { base64: 17 } },
    };
    h.prisma.chatSettings.findUnique.mockResolvedValue(malformed);
    await expect(h.service.read('chat-1', h.user)).resolves.toMatchObject({
      storageStatus: 'invalid',
      policy: { enabled: false },
    });
    expect(malformed.stopWordsMedia.explanation.base64).toBe(17);
    expect(h.tx.chatSettings.updateMany).not.toHaveBeenCalled();
  });
  it.each([undefined, false])(
    'refuses an old client replacing invalid storage without explicit true intent: %s',
    async (replaceInvalidStorage) => {
      const h = harness();
      const malformed = { ...h.row, stopWordsPolicy: { version: 999 } };
      h.prisma.chatSettings.findUnique.mockResolvedValue(malformed);
      await expect(
        h.service.update('chat-1', h.user, {
          expectedRevision: 2,
          policy: { sanctions: { warnEnabled: true } },
          replaceInvalidStorage,
        }),
      ).rejects.toMatchObject({
        response: { code: 'STOP_WORDS_POLICY_REVIEW_REQUIRED', revision: 2, fieldPaths: [] },
      });
      expect(h.prisma.$transaction).not.toHaveBeenCalled();
      expect(h.capabilities.assertChatSettingsBotCapabilities).not.toHaveBeenCalled();
      expect(h.cache.invalidate).not.toHaveBeenCalled();
      expect(malformed.stopWordsPolicy).toEqual({ version: 999 });
    },
  );
  it('allows explicit replacement only at the matching standalone revision', async () => {
    const h = harness();
    h.prisma.chatSettings.findUnique.mockResolvedValue({
      ...h.row,
      stopWordsPolicy: { version: 999 },
    });
    await expect(
      h.service.update('chat-1', h.user, {
        expectedRevision: 1,
        replaceInvalidStorage: true,
        policy: {},
      }),
    ).rejects.toMatchObject({ response: { code: 'STOP_WORDS_REVISION_CONFLICT' } });
    expect(h.tx.chatSettings.updateMany).not.toHaveBeenCalled();
    await expect(
      h.service.update('chat-1', h.user, {
        expectedRevision: 2,
        replaceInvalidStorage: true,
        policy: {},
      }),
    ).resolves.toMatchObject({ storageStatus: 'valid', revision: 3 });
    expect(h.tx.chatSettings.updateMany).toHaveBeenCalledTimes(1);
    expect(h.tx.auditLog.create).toHaveBeenCalledTimes(1);
  });
  it.each([true, false])(
    'refuses replacement intent on an invalid network request (validation-only: %s)',
    async (validateOnly) => {
      const h = harness();
      h.prisma.chatSettings.findUnique.mockResolvedValue({
        ...h.row,
        stopWordsPolicy: { version: 999 },
      });
      await expect(
        h.service.update(
          'chat-1',
          h.user,
          { expectedRevision: 2, replaceInvalidStorage: true, policy: {} },
          { validateOnly },
        ),
      ).rejects.toMatchObject({ response: { code: 'STOP_WORDS_POLICY_REVIEW_REQUIRED' } });
      expect(h.prisma.$transaction).not.toHaveBeenCalled();
      expect(h.cache.invalidate).not.toHaveBeenCalled();
    },
  );
  it('returns a structured review requirement without exposing unconvertible legacy values', async () => {
    const h = harness();
    h.prisma.chatSettings.findUnique.mockResolvedValue({
      ...h.row,
      stopWordsPolicy: null,
      messageLimitsBlockedWords: ['private-legacy\u200bword'],
    });
    await expect(h.service.read('chat-1', h.user)).rejects.toMatchObject({
      response: { code: 'STOP_WORDS_POLICY_REVIEW_REQUIRED', revision: 2 },
    });
    try {
      await h.service.read('chat-1', h.user);
    } catch (error) {
      expect(JSON.stringify(error)).not.toContain('private-legacy');
    }
    expect(h.tx.chatSettings.updateMany).not.toHaveBeenCalled();
  });
  it('recovers an exact committed write after Redis failure without a second audit or revision', async () => {
    const h = harness();
    const policy = stopWordsPolicySchema.parse({
      rules: [{ id: 'one', kind: 'WORD', value: 'casino' }],
    });
    const body = { expectedRevision: 2, policy };
    h.cache.invalidate.mockRejectedValueOnce(new Error('Redis unavailable'));
    await expect(h.service.update('chat-1', h.user, body)).rejects.toThrow('Redis unavailable');
    h.prisma.chatSettings.findUnique.mockResolvedValue({
      ...h.row,
      ...stopWordsPolicyStorage(policy),
      stopWordsRevision: 3,
    });
    await expect(h.service.update('chat-1', h.user, body)).resolves.toMatchObject({
      revision: 3,
      policy,
    });
    expect(h.cache.invalidate).toHaveBeenCalledTimes(2);
    expect(h.tx.chatSettings.updateMany).toHaveBeenCalledTimes(1);
    expect(h.tx.auditLog.create).toHaveBeenCalledTimes(1);
  });
  it('does not accept a different policy as a lost-response retry', async () => {
    const h = harness();
    await expect(
      h.service.update('chat-1', h.user, {
        expectedRevision: 1,
        policy: { rules: [{ id: 'different', kind: 'WORD', value: 'other' }] },
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(h.cache.invalidate).not.toHaveBeenCalled();
    expect(h.tx.auditLog.create).not.toHaveBeenCalled();
  });
  it('keeps network retries under their existing commit protocol', async () => {
    const h = harness();
    await expect(
      h.service.update(
        'chat-1',
        h.user,
        { expectedRevision: 1, policy: {} },
        { deferFollowup: true },
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(h.cache.invalidate).not.toHaveBeenCalled();
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
    expect(result.settingsRevision).toBe('2026-10-29T16:00:00.000Z');
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
        h.service.update('chat-1', h.user, { expectedRevision: before ? 0 : 2, policy: {} }),
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
