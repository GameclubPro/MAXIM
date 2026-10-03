import { AdminManualModerationRuntime } from './admin-manual-moderation-runtime';
import {
  createAdminManualModerationRuntimeContext,
  type AdminManualModerationRuntimeContext,
} from './admin-manual-moderation-runtime-context';

function baseContext(): AdminManualModerationRuntimeContext {
  return {
    logger: {} as never,
    adminSuperBanQueue: {} as never,
    adminManualFanoutQueue: {} as never,
    enqueueManualModerationFanout: jest.fn(),
    isKnownRuntimeBotUserId: jest.fn(),
    isSuperBanDeveloperUserId: jest.fn(),
    processDeveloperSuperBanJob: jest.fn(),
    processManualSystemBan: jest.fn(),
    processManualModerationAction: jest.fn(),
    resolveManualCommandFanoutChats: jest.fn(),
    runManualSourceCleanupWithLedger: jest.fn(),
    applyManualMuteFanout: jest.fn(),
    applyManualSystemBanFanout: jest.fn(),
    resolveManualGroupCommandCleanupBotId: jest.fn(),
    resolveManualModerationTargetDisplayName: jest.fn(),
    deleteManualGroupCommandTargetMessage: jest.fn(),
    deleteManualGroupCommandMessage: jest.fn(),
    readManualModerationFanoutIntentRow: jest.fn(),
    resolveManualModerationActionBotAssignment: jest.fn(),
    assertBotCanDeleteMessages: jest.fn(),
    deleteRecentTrackedMessagesForManualAction: jest.fn(),
    runManualBanSourceCleanup: jest.fn(),
    runManualBanFanoutInlineSummary: jest.fn(),
    normalizeManualModerationBotId: jest.fn(),
    canResolveCurrentChatMemberAccess: jest.fn(),
    resolveDeliveryBotAssignment: jest.fn(),
    claimManualModerationFanoutLedgerEntry: jest.fn(),
    completeManualModerationFanoutLedgerEntry: jest.fn(),
    markManualModerationFanoutLedgerFailed: jest.fn(),
    findSettledManualGroupCommandOutcomeRows: jest.fn(),
    sendMessage: jest.fn(),
  };
}

describe('AdminManualModerationRuntimeContext', () => {
  it('exposes queue and logger through typed accessors', () => {
    const target = {
      ...baseContext(),
      logger: { warn: jest.fn() } as unknown as AdminManualModerationRuntimeContext['logger'],
      adminSuperBanQueue: { add: jest.fn() } as never,
      enqueueManualModerationFanout: jest.fn(),
      isKnownRuntimeBotUserId: jest.fn(),
      isSuperBanDeveloperUserId: jest.fn(),
      processDeveloperSuperBanJob: jest.fn(),
      readTrimmedString: jest.fn(),
    };
    const context = createAdminManualModerationRuntimeContext(target);

    expect(context.logger).toBe(target.logger);
    expect(context.adminSuperBanQueue).toBe(target.adminSuperBanQueue);
  });

  it('delegates manual moderation helpers without losing the legacy target context', async () => {
    const target = {
      ...baseContext(),
      prefix: 'legacy',
      logger: { warn: jest.fn() } as unknown as AdminManualModerationRuntimeContext['logger'],
      async enqueueManualModerationFanout(job: { kind: string }): Promise<boolean> {
        this.logger.warn(`${this.prefix}:fanout:${job.kind}`);
        return true;
      },
      isKnownRuntimeBotUserId(userId: string | null | undefined): boolean {
        return userId === `${this.prefix}-bot`;
      },
      isSuperBanDeveloperUserId(userId: string | null | undefined): boolean {
        return userId === `${this.prefix}-dev`;
      },
      async processDeveloperSuperBanJob(job: { jobId: string }): Promise<void> {
        this.logger.warn(`${this.prefix}:super-ban:${job.jobId}`);
      },
      readTrimmedString(value: unknown): string | null {
        return typeof value === 'string' ? `${this.prefix}:${value.trim()}` : null;
      },
    };
    const context = createAdminManualModerationRuntimeContext(target);

    await expect(
      context.enqueueManualModerationFanout({ kind: 'manual_group_moderation_command' } as never),
    ).resolves.toBe(true);
    expect(context.isKnownRuntimeBotUserId('legacy-bot')).toBe(true);
    expect(context.isSuperBanDeveloperUserId('legacy-dev')).toBe(true);
    await context.processDeveloperSuperBanJob({ jobId: 'job-1' } as never);
    expect(target.logger.warn).toHaveBeenCalledWith(
      'legacy:fanout:manual_group_moderation_command',
    );
    expect(target.logger.warn).toHaveBeenCalledWith('legacy:super-ban:job-1');
  });
});

const notice = {
  chatId: 'chat-1',
  botId: 'major-1',
  text: 'Result',
  deleteBotMessagesEnabled: false,
  deleteBotMessagesDelayMinutes: 1,
  ledger: {
    jobId: 'job-1',
    outcome: 'SUCCESS' as const,
    actorUserId: 'admin-1',
    targetUserId: 'user-1',
    commandMessageId: 'command-1',
    action: 'MUTE' as const,
  },
};

function noticeFixture() {
  const order: string[] = [];
  const findSettledManualGroupCommandOutcomeRows = jest.fn().mockResolvedValue([]);
  const claimManualModerationFanoutLedgerEntry = jest.fn(
    async (
      _params: Parameters<
        AdminManualModerationRuntimeContext['claimManualModerationFanoutLedgerEntry']
      >[0],
    ) => {
      order.push('claim');
      return { claimed: true, lockToken: 'lease-1' };
    },
  );
  const markManualModerationFanoutLedgerFailed = jest.fn(async () => {
    order.push('record-attempt');
    return true;
  });
  const completeManualModerationFanoutLedgerEntry = jest.fn(async () => {
    order.push('complete');
  });
  const sendMessage: jest.MockedFunction<AdminManualModerationRuntimeContext['sendMessage']> =
    jest.fn(async (_chatId, _text, _options, dispatch) => {
      await dispatch.beforeImmediateSendMutation?.();
      order.push('send');
      return { messageId: 'sent-1' } as never;
    });
  const context: AdminManualModerationRuntimeContext = {
    ...baseContext(),
    logger: { debug: jest.fn(), warn: jest.fn() } as never,
    findSettledManualGroupCommandOutcomeRows,
    claimManualModerationFanoutLedgerEntry,
    markManualModerationFanoutLedgerFailed,
    completeManualModerationFanoutLedgerEntry,
    sendMessage,
  };
  return {
    runtime: new AdminManualModerationRuntime(context),
    order,
    findSettledManualGroupCommandOutcomeRows,
    claimManualModerationFanoutLedgerEntry,
    markManualModerationFanoutLedgerFailed,
    completeManualModerationFanoutLedgerEntry,
    sendMessage,
  };
}

describe('manual moderation notice boundary', () => {
  it('records the dispatch attempt before sending and commits the exact receipt afterwards', async () => {
    const f = noticeFixture();
    await f.runtime.sendManualGroupCommandNotice(notice);
    expect(f.order).toEqual(['claim', 'record-attempt', 'send', 'complete']);
    expect(f.markManualModerationFanoutLedgerFailed).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'AMBIGUOUS', retainClaim: true, requireClaim: true }),
    );
    const claim = f.claimManualModerationFanoutLedgerEntry.mock.calls[0][0];
    expect(f.sendMessage.mock.calls[0][3].idempotencyKey).toBe(claim.operationKey);
    expect(f.completeManualModerationFanoutLedgerEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        operationKey: claim.operationKey,
        lockToken: 'lease-1',
        remoteMessageId: 'sent-1',
      }),
    );
  });

  it('does not repeat an already settled notice', async () => {
    const f = noticeFixture();
    f.findSettledManualGroupCommandOutcomeRows.mockResolvedValue([
      { operation: 'COMMAND_NOTICE_OUTCOME' },
    ]);
    await f.runtime.sendManualGroupCommandNotice(notice);
    expect(f.claimManualModerationFanoutLedgerEntry).not.toHaveBeenCalled();
    expect(f.sendMessage).not.toHaveBeenCalled();
  });

  it('does not send if another worker already claimed the notice', async () => {
    const f = noticeFixture();
    f.claimManualModerationFanoutLedgerEntry.mockResolvedValue({ claimed: false, lockToken: '' });
    await f.runtime.sendManualGroupCommandNotice(notice);
    expect(f.sendMessage).not.toHaveBeenCalled();
  });

  it('quarantines a lost MAX response after dispatch instead of requesting a retry', async () => {
    const f = noticeFixture();
    f.sendMessage.mockImplementation(async (_chatId, _text, _options, dispatch) => {
      await dispatch.beforeImmediateSendMutation?.();
      throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' });
    });
    await expect(f.runtime.sendManualGroupCommandNotice(notice)).resolves.toBeUndefined();
    expect(f.markManualModerationFanoutLedgerFailed).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: 'AMBIGUOUS' }),
    );
    expect(f.completeManualModerationFanoutLedgerEntry).not.toHaveBeenCalled();
  });

  it('preserves ambiguity when receipt persistence fails after confirmed delivery', async () => {
    const f = noticeFixture();
    f.completeManualModerationFanoutLedgerEntry.mockRejectedValueOnce(new Error('commit failed'));
    await expect(f.runtime.sendManualGroupCommandNotice(notice)).resolves.toBeUndefined();
    expect(f.sendMessage).toHaveBeenCalledTimes(1);
    expect(f.markManualModerationFanoutLedgerFailed).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: 'AMBIGUOUS' }),
    );
  });
});
