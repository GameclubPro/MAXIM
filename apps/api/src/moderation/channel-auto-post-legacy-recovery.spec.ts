import { ChannelAutoPostLegacyRecovery } from './channel-auto-post-legacy-recovery';

function candidate(chatId: string, messageId = `message-${chatId}`) {
  return {
    chatId,
    messageId,
    evidence: 'marker' as const,
    evidenceId: `marker-${chatId}-${messageId}`,
    evidenceAt: new Date('2026-08-09T10:00:00.000Z'),
  };
}

function contextRow(
  chatId: string,
  overrides: { commentsEnabled?: boolean; postSuggestionsEnabled?: boolean } = {},
) {
  return {
    chatId,
    commentsEnabled: overrides.commentsEnabled ?? true,
    postSuggestionsEnabled: overrides.postSuggestionsEnabled ?? false,
    postSignatureEnabled: true,
    chat: { admins: [{ userId: `admin-${chatId}` }] },
  };
}

function createHarness(options: {
  candidates?: ReturnType<typeof candidate>[];
  contextRows?: ReturnType<typeof contextRow>[];
  lookup?: jest.Mock;
}) {
  let nowMs = Date.parse('2026-08-09T12:00:00.000Z');
  const listCandidates = jest.fn().mockResolvedValue({
    candidates: options.candidates ?? [],
    nextAuditCursor: {
      createdAt: new Date('2026-08-09T10:30:00.000Z'),
      id: 'audit-next',
    },
    auditScanExhausted: true,
  });
  const claimChannelAutoPost = jest
    .fn()
    .mockImplementation(async ({ messageId }: { messageId: string }) => ({
      status: 'claimed',
      lockToken: `lock-${messageId}`,
    }));
  const completeChannelAutoPost = jest.fn().mockResolvedValue(undefined);
  const findMany = jest.fn().mockResolvedValue(options.contextRows ?? []);
  const lookup = options.lookup ?? jest.fn().mockResolvedValue([]);
  const attach = jest.fn().mockResolvedValue('attached');
  const resolveUnifiedLookupBotId = jest.fn().mockResolvedValue('scan-bot');
  const logger = { warn: jest.fn() };
  const runner = new ChannelAutoPostLegacyRecovery({
    prisma: { channelSettings: { findMany } } as never,
    markerStore: {
      listLegacyChannelEditRecoveryCandidates: listCandidates,
      claimChannelAutoPost,
      completeChannelAutoPost,
    },
    lookupExactButtonIdentities: lookup,
    resolveUnifiedLookupBotId,
    attach,
    logger,
    now: () => nowMs,
  });

  return {
    runner,
    listCandidates,
    claimChannelAutoPost,
    completeChannelAutoPost,
    findMany,
    lookup,
    attach,
    resolveUnifiedLookupBotId,
    logger,
    advance(ms: number) {
      nowMs += ms;
    },
  };
}

describe('ChannelAutoPostLegacyRecovery', () => {
  it('uses a 24-hour bounded page, persists the audit cursor, and sweeps at most every five minutes', async () => {
    const harness = createHarness({});

    await expect(harness.runner.runIfDue()).resolves.toEqual({
      status: 'completed',
      deferReason: null,
      stopCurrentTick: false,
      scannedCandidates: 0,
      remoteLookups: 0,
      mutationAttempts: 0,
      terminalizedCandidates: 0,
    });
    expect(harness.listCandidates).toHaveBeenNthCalledWith(1, {
      now: new Date('2026-08-09T12:00:00.000Z'),
      limit: 100,
      lookbackMs: 24 * 60 * 60_000,
      minimumAgeMs: 5 * 60_000,
      auditCursor: null,
    });

    harness.advance(5 * 60_000 - 1);
    await expect(harness.runner.runIfDue()).resolves.toEqual({
      status: 'not_due',
      deferReason: null,
      stopCurrentTick: false,
      scannedCandidates: 0,
      remoteLookups: 0,
      mutationAttempts: 0,
      terminalizedCandidates: 0,
    });
    expect(harness.listCandidates).toHaveBeenCalledTimes(1);

    harness.advance(1);
    await harness.runner.runIfDue();
    expect(harness.listCandidates).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        auditCursor: {
          createdAt: new Date('2026-08-09T10:30:00.000Z'),
          id: 'audit-next',
        },
      }),
    );
  });

  it('terminalizes missing contexts, disabled features, absent posts, and already-complete posts without mutation', async () => {
    const candidates = [
      candidate('missing-context'),
      candidate('disabled'),
      candidate('absent'),
      candidate('complete'),
    ];
    const lookup = jest.fn().mockImplementation(async (chatId: string) => {
      if (chatId === 'absent') {
        return null;
      }
      if (chatId === 'complete') {
        return [
          { chatId, kind: 'comments', threadId: 'thread-existing' },
          { chatId, kind: 'suggest', threadId: 'thread-existing' },
        ];
      }
      throw new Error(`Unexpected lookup for ${chatId}`);
    });
    const harness = createHarness({
      candidates,
      contextRows: [
        contextRow('disabled', { commentsEnabled: false, postSuggestionsEnabled: false }),
        contextRow('absent', { commentsEnabled: true }),
        contextRow('complete', { commentsEnabled: true, postSuggestionsEnabled: true }),
      ],
      lookup,
    });

    await expect(harness.runner.runIfDue()).resolves.toEqual({
      status: 'completed',
      deferReason: null,
      stopCurrentTick: false,
      scannedCandidates: 4,
      remoteLookups: 2,
      mutationAttempts: 0,
      terminalizedCandidates: 4,
    });
    expect(harness.attach).not.toHaveBeenCalled();
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(harness.claimChannelAutoPost).toHaveBeenCalledTimes(4);
    expect(harness.claimChannelAutoPost).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'poll',
        linkType: null,
        hasEngagementButtons: true,
      }),
    );
    expect(harness.completeChannelAutoPost).toHaveBeenCalledTimes(4);
    expect(harness.completeChannelAutoPost).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: 'message-absent',
        status: 'SKIPPED',
        lastStatusCode: 404,
      }),
    );
    expect(harness.completeChannelAutoPost).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: 'message-complete',
        status: 'SUCCEEDED',
        lastError: null,
      }),
    );
  });

  it('passes existing kinds and thread to attach while disabling signature decoration', async () => {
    const lookup = jest.fn().mockResolvedValue([
      { chatId: 'channel-1', kind: 'comments', threadId: 'existing-thread' },
      { chatId: 'other-channel', kind: 'suggest', threadId: 'wrong-thread' },
    ]);
    const harness = createHarness({
      candidates: [candidate('channel-1')],
      contextRows: [
        contextRow('channel-1', { commentsEnabled: true, postSuggestionsEnabled: true }),
      ],
      lookup,
    });

    await expect(harness.runner.runIfDue()).resolves.toEqual({
      status: 'completed',
      deferReason: null,
      stopCurrentTick: false,
      scannedCandidates: 1,
      remoteLookups: 1,
      mutationAttempts: 1,
      terminalizedCandidates: 0,
    });
    expect(harness.lookup).toHaveBeenCalledWith('channel-1', 'message-channel-1', {
      trafficClass: 'background',
      actionHealthLane: 'background',
      sourceTag: 'channel_auto_post',
      botId: 'scan-bot',
    });
    expect(harness.attach).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: 'channel-1',
        messageId: 'message-channel-1',
        text: null,
        textFormat: null,
        linkType: null,
        existingDialogButtonKinds: ['comments'],
        existingDialogThreadId: 'existing-thread',
        source: 'poll',
        senderId: null,
        managedChannel: expect.objectContaining({
          channelSettings: expect.objectContaining({
            commentsEnabled: true,
            postSuggestionsEnabled: true,
            postSignatureEnabled: false,
          }),
        }),
      }),
    );
    expect(harness.claimChannelAutoPost).not.toHaveBeenCalled();
  });

  it('limits mutations to three per sweep and one candidate per channel', async () => {
    const candidates = [
      candidate('channel-1', 'message-channel-1-a'),
      candidate('channel-1', 'message-channel-1-b'),
      candidate('channel-2'),
      candidate('channel-3'),
      candidate('channel-4'),
      candidate('channel-5'),
    ];
    const harness = createHarness({
      candidates,
      contextRows: [1, 2, 3, 4, 5].map((index) => contextRow(`channel-${index}`)),
    });

    await expect(harness.runner.runIfDue()).resolves.toEqual({
      status: 'deferred',
      deferReason: 'same_channel_limit',
      stopCurrentTick: false,
      scannedCandidates: 6,
      remoteLookups: 5,
      mutationAttempts: 3,
      terminalizedCandidates: 0,
    });
    expect(harness.attach).toHaveBeenCalledTimes(3);
    expect(harness.attach.mock.calls.map(([input]) => input.chatId)).toEqual([
      'channel-1',
      'channel-2',
      'channel-3',
    ]);
    expect(harness.lookup).toHaveBeenCalledTimes(5);

    harness.advance(5 * 60_000);
    await harness.runner.runIfDue();
    expect(harness.listCandidates).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ auditCursor: null }),
    );
  });

  it('defers a transient exact lookup without claiming or advancing the audit cursor', async () => {
    const transientError = Object.assign(new Error('MAX throttle'), {
      response: { status: 429 },
    });
    const harness = createHarness({
      candidates: [candidate('channel-1')],
      contextRows: [contextRow('channel-1')],
      lookup: jest.fn().mockRejectedValue(transientError),
    });

    await expect(harness.runner.runIfDue()).resolves.toEqual({
      status: 'deferred',
      deferReason: 'lookup_error',
      stopCurrentTick: true,
      scannedCandidates: 1,
      remoteLookups: 1,
      mutationAttempts: 0,
      terminalizedCandidates: 0,
    });
    expect(harness.claimChannelAutoPost).not.toHaveBeenCalled();
    expect(harness.completeChannelAutoPost).not.toHaveBeenCalled();
    expect(harness.attach).not.toHaveBeenCalled();
    expect(harness.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: 'channel-1',
        messageId: 'message-channel-1',
        error: 'MAX throttle',
      }),
      'Deferred legacy channel button recovery after lookup error',
    );

    harness.advance(5 * 60_000);
    await harness.runner.runIfDue();
    expect(harness.listCandidates).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ auditCursor: null }),
    );
  });

  it('holds the cursor so a second message from the same channel is recovered next sweep', async () => {
    const harness = createHarness({
      contextRows: [contextRow('channel-1')],
    });
    harness.listCandidates
      .mockReset()
      .mockResolvedValueOnce({
        candidates: [
          candidate('channel-1', 'message-channel-1-a'),
          candidate('channel-1', 'message-channel-1-b'),
        ],
        nextAuditCursor: {
          createdAt: new Date('2026-08-09T10:30:00.000Z'),
          id: 'audit-second',
        },
        auditScanExhausted: true,
      })
      .mockResolvedValueOnce({
        candidates: [candidate('channel-1', 'message-channel-1-b')],
        nextAuditCursor: {
          createdAt: new Date('2026-08-09T10:30:00.000Z'),
          id: 'audit-second',
        },
        auditScanExhausted: true,
      });

    await expect(harness.runner.runIfDue()).resolves.toEqual(
      expect.objectContaining({
        status: 'deferred',
        deferReason: 'same_channel_limit',
        mutationAttempts: 1,
      }),
    );
    harness.advance(5 * 60_000);
    await expect(harness.runner.runIfDue()).resolves.toEqual(
      expect.objectContaining({ status: 'completed', mutationAttempts: 1 }),
    );
    expect(harness.attach.mock.calls.map(([input]) => input.messageId)).toEqual([
      'message-channel-1-a',
      'message-channel-1-b',
    ]);
    expect(harness.listCandidates).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ auditCursor: null }),
    );
  });

  it('caps exact remote lookups at eight and holds the cursor', async () => {
    const candidates = Array.from({ length: 9 }, (_, index) => candidate(`channel-${index + 1}`));
    const lookup = jest
      .fn()
      .mockImplementation(async (chatId: string) => [
        { chatId, kind: 'comments', threadId: `thread-${chatId}` },
      ]);
    const harness = createHarness({
      candidates,
      contextRows: candidates.map((item) => contextRow(item.chatId)),
      lookup,
    });

    await expect(harness.runner.runIfDue()).resolves.toEqual({
      status: 'deferred',
      deferReason: 'lookup_limit',
      stopCurrentTick: false,
      scannedCandidates: 9,
      remoteLookups: 8,
      mutationAttempts: 0,
      terminalizedCandidates: 8,
    });
    expect(lookup).toHaveBeenCalledTimes(8);
    expect(harness.attach).not.toHaveBeenCalled();
  });

  it('holds the cursor when a terminal no-op claim is still in progress', async () => {
    const harness = createHarness({
      candidates: [candidate('channel-1')],
      contextRows: [contextRow('channel-1')],
      lookup: jest.fn().mockResolvedValue(null),
    });
    harness.claimChannelAutoPost.mockResolvedValue({ status: 'in_progress' });

    await expect(harness.runner.runIfDue()).resolves.toEqual({
      status: 'deferred',
      deferReason: 'marker_in_progress',
      stopCurrentTick: false,
      scannedCandidates: 1,
      remoteLookups: 1,
      mutationAttempts: 0,
      terminalizedCandidates: 0,
    });
    expect(harness.completeChannelAutoPost).not.toHaveBeenCalled();
  });

  it('contains terminal marker persistence errors inside the recovery sweep', async () => {
    const harness = createHarness({
      candidates: [candidate('channel-1')],
      contextRows: [contextRow('channel-1')],
      lookup: jest.fn().mockResolvedValue(null),
    });
    harness.claimChannelAutoPost.mockRejectedValue(new Error('database unavailable'));

    await expect(harness.runner.runIfDue()).resolves.toEqual(
      expect.objectContaining({
        status: 'deferred',
        deferReason: 'marker_in_progress',
        stopCurrentTick: false,
      }),
    );
    expect(harness.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'database unavailable' }),
      'Deferred legacy channel button recovery after marker error',
    );
  });

  it('holds the cursor when attach reports an in-progress marker', async () => {
    const harness = createHarness({
      candidates: [candidate('channel-1')],
      contextRows: [contextRow('channel-1')],
    });
    harness.attach.mockResolvedValue('in_progress');

    await expect(harness.runner.runIfDue()).resolves.toEqual(
      expect.objectContaining({
        status: 'deferred',
        deferReason: 'marker_in_progress',
        mutationAttempts: 1,
      }),
    );
  });
});
