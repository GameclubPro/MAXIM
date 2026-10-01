import {
  chatSettingsSchema,
  settingsApplyPartialErrorSchema,
  type ChatSummary,
} from '@maxim/contracts';
import { applySettingsToAllChats } from './admin-settings-apply';
import { SETTINGS_SECTION_KEYS } from './admin.service.support';

const baseline = new Date('2026-10-01T10:00:00.000Z');

function setup(targetCount = 2) {
  const targets = Array.from({ length: targetCount }, (_, index) => ({
    id: `target-${index + 1}`,
    title: `Чат ${index + 1}`,
  })) as ChatSummary[];
  const rows = new Map(
    targets.map((target) => [
      target.id,
      { ...chatSettingsSchema.parse({}), chatId: target.id, updatedAt: baseline },
    ]),
  );
  const source = { ...chatSettingsSchema.parse({}), chatId: 'source', updatedAt: baseline };
  const prisma = {
    chatSettings: {
      findMany: jest.fn(async () => [...rows.values()].map((row) => ({ ...row }))),
      findUnique: jest.fn(async ({ where }: { where: { chatId: string } }) =>
        where.chatId === 'source' ? source : (rows.get(where.chatId) ?? null),
      ),
      updateMany: jest.fn(async () => ({ count: 1 })),
      create: jest.fn(async () => ({})),
    },
    chat: { upsert: jest.fn(async () => ({})) },
    auditLog: { create: jest.fn(async () => ({})) },
    $transaction: jest.fn(),
  };
  prisma.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(prisma));
  const params: Parameters<typeof applySettingsToAllChats>[0] = {
    prisma: prisma as never,
    chatContextCache: { invalidate: jest.fn(async () => undefined) },
    sourceChatId: 'source',
    actorUserId: 'admin',
    source: 'miniapp',
    body: chatSettingsSchema.parse({
      reportsEnabled: true,
      reportsAliases: ['signal'],
      settingsRevision: baseline.toISOString(),
    }),
    settingKeys: SETTINGS_SECTION_KEYS.reports,
    targetOrSettingKeys: { mode: 'all', chatIds: [], favoriteTypes: [] },
    confirmedTargetChatIds: targets.map((chat) => chat.id),
    expectedSourceSettingsRevision: baseline.toISOString(),
    normalizeSettings: (settings) => settings,
    resolveTargetChats: jest.fn(async () => targets),
    resolveBotAssignmentData: jest.fn(() => ({})),
    assertRequiredSubscriptionSettings: jest.fn(async () => undefined),
    reportsAvailable: () => true,
    assertBotCapabilities: jest.fn(async () => undefined),
    recordConcurrentWriteConflict: jest.fn(),
    onPartialApplied: jest.fn(async () => undefined),
    isRequiredSubscriptionCurrentlyActive: () => false,
    scheduleReadinessRefresh: jest.fn(),
  };
  return { params, prisma, rows, source, targets };
}

describe('report policy bulk preflight and committed outcomes', () => {
  it('checks target administrator command collisions before any target transaction', async () => {
    const { params, prisma, rows } = setup();
    rows.get('target-2')!.adminBanCommandName = 'signal';
    await expect(applySettingsToAllChats(params)).rejects.toMatchObject({
      status: 400,
      response: { code: 'REPORTS_COMMAND_CONFLICT', chatId: 'target-2' },
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.chatSettings.updateMany).not.toHaveBeenCalled();
  });

  it('rejects a changed target selection rather than silently applying to newly available chats', async () => {
    const { params, prisma } = setup();
    params.confirmedTargetChatIds = ['target-1'];
    await expect(applySettingsToAllChats(params)).rejects.toMatchObject({
      status: 409,
      response: { code: 'CHAT_SETTINGS_TARGETS_CHANGED', partialApplied: false, appliedCount: 0 },
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rechecks the source after remote capability preflight and writes no target if it changed', async () => {
    const { params, prisma, source } = setup();
    params.assertBotCapabilities = jest.fn(async () => {
      source.updatedAt = new Date('2026-10-01T10:01:00.000Z');
    });
    await expect(applySettingsToAllChats(params)).rejects.toMatchObject({
      status: 409,
      response: { code: 'CHAT_SETTINGS_CONCURRENT_UPDATE', partialApplied: false, appliedCount: 0 },
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('repeats command validation during each transaction and reports every committed target', async () => {
    const { params, prisma, rows } = setup();
    prisma.chatSettings.findUnique.mockImplementation(async ({ where }) => {
      if (where.chatId === 'target-2')
        return { ...rows.get('target-2')!, adminBanCommandName: 'signal' };
      return where.chatId === 'source'
        ? { ...chatSettingsSchema.parse({}), chatId: 'source', updatedAt: baseline }
        : rows.get(where.chatId)!;
    });
    const error = await applySettingsToAllChats(params).catch((caught: unknown) => caught);
    const result = settingsApplyPartialErrorSchema.parse((error as { response: unknown }).response);
    expect(result).toMatchObject({
      code: 'SETTINGS_APPLY_PARTIAL',
      targetCount: 2,
      appliedCount: 1,
      unchangedCount: 1,
      failedCount: 1,
      notAttemptedCount: 0,
      appliedChatIds: ['target-1'],
      unchangedChatIds: ['target-2'],
      causeCode: 'REPORTS_COMMAND_CONFLICT',
      outcomesTruncated: false,
    });
    expect(result.outcomes).toEqual(
      expect.arrayContaining([
        { chatId: 'target-1', status: 'APPLIED' },
        expect.objectContaining({ chatId: 'target-2', status: 'FAILED' }),
      ]),
    );
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
  });

  it('does not claim a rollback when cache invalidation fails after a transaction committed', async () => {
    const { params } = setup(1);
    params.chatContextCache.invalidate = jest.fn(async () => {
      throw new Error('redis unavailable');
    });
    const error = await applySettingsToAllChats(params).catch((caught: unknown) => caught);
    expect(
      settingsApplyPartialErrorSchema.parse((error as { response: unknown }).response),
    ).toMatchObject({
      appliedCount: 1,
      unchangedCount: 0,
      failedCount: 0,
      causeCode: 'POST_COMMIT_REFRESH_FAILED',
      outcomes: [expect.objectContaining({ chatId: 'target-1', status: 'APPLIED' })],
    });
  });

  it.each([false, true])(
    'returns our own source commit revision even if a later writer intervenes (partial=%s)',
    async (partial) => {
      const { params, prisma, rows, source, targets } = setup(1);
      rows.delete(targets[0]!.id);
      targets[0]!.id = 'source';
      rows.set('source', source);
      source.reportsEnabled = true;
      source.reportsAliases = ['signal'];
      params.confirmedTargetChatIds = ['source'];
      prisma.chatSettings.updateMany.mockImplementation(async () => {
        source.updatedAt = new Date('2026-10-01T10:01:00.000Z');
        return { count: 1 };
      });
      params.chatContextCache.invalidate = jest.fn(async () => {
        source.updatedAt = new Date('2026-10-01T10:02:00.000Z');
        if (partial) throw new Error('cache unavailable after commit');
      });
      const result = await applySettingsToAllChats(params).catch((error: { response: unknown }) =>
        settingsApplyPartialErrorSchema.parse(error.response),
      );
      expect(result.sourceSettingsRevision).toBe('2026-10-01T10:01:00.000Z');
    },
  );

  it('preserves the full commit result if follow-up scheduling fails', async () => {
    const { params } = setup();
    params.scheduleReadinessRefresh = jest.fn(() => {
      throw new Error('queue unavailable');
    });
    const error = await applySettingsToAllChats(params).catch((caught: unknown) => caught);
    expect(
      settingsApplyPartialErrorSchema.parse((error as { response: unknown }).response),
    ).toMatchObject({
      appliedCount: 2,
      unchangedCount: 0,
      failedCount: 0,
      causeCode: 'POST_COMMIT_REFRESH_FAILED',
    });
  });

  it('keeps exact totals with bounded samples when a late failure stops a large operation', async () => {
    const { params, prisma } = setup(30);
    params.chatContextCache.invalidate = jest.fn(async (chatId) => {
      if (chatId === 'target-25') throw new Error('redis unavailable');
    });
    const error = await applySettingsToAllChats(params).catch((caught: unknown) => caught);
    const result = settingsApplyPartialErrorSchema.parse((error as { response: unknown }).response);
    expect(result.appliedCount + result.unchangedCount).toBe(30);
    expect(result.appliedCount).toBe(prisma.auditLog.create.mock.calls.length);
    expect(result.appliedChatIds.length).toBeLessThanOrEqual(20);
    expect(result.unchangedChatIds.length).toBeLessThanOrEqual(20);
    expect(result.outcomes.length).toBeLessThanOrEqual(20);
    expect(result.outcomesTruncated).toBe(true);
  });
});
