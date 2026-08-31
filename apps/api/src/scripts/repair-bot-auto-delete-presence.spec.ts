import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  buildMessageScopedModerationActionClaimKey,
  buildModerationMessageViolationProcessingClaimKey,
} from '../moderation/moderation-message-action-claim';
import {
  BOT_AUTO_DELETE_PRESENCE_REPAIR_USAGE,
  assertBotAutoDeletePresenceRepairRole,
  botAutoDeletePresenceRepairHasFailures,
  classifyBotAutoDeletePresenceRepairIntent,
  readBotAutoDeletePresenceRepairOptions,
  runBotAutoDeletePresenceRepair,
  type BotAutoDeletePresenceRepairIntent,
  type BotAutoDeletePresenceRepairLegacyClaim,
  type BotAutoDeletePresenceRepairLegacyOutboundDelete,
  type BotAutoDeletePresenceRepairLegacyOutboundSend,
  type BotAutoDeletePresenceRepairOptions,
} from './repair-bot-auto-delete-presence';

const NOW = new Date('2026-08-31T18:00:00.000Z');
const LEGACY_CLAIM_CREATED_AT = new Date('2026-08-31T15:04:00.000Z');
const LEGACY_MESSAGE_AT = new Date('2026-08-31T15:03:58.000Z');

function legacyOutboundSend(
  overrides: Partial<BotAutoDeletePresenceRepairLegacyOutboundSend> = {},
): BotAutoDeletePresenceRepairLegacyOutboundSend {
  return {
    id: 'send-ledger-1',
    jobId: 'send-job-1',
    actionType: 'SEND_MESSAGE',
    chatId: 'chat-1',
    sourceTag: 'moderation_notice',
    trafficClass: 'background',
    actionHealthLane: 'background',
    status: 'SUCCEEDED',
    ambiguous: false,
    terminal: true,
    dispatchBotId: 'bot-1',
    remoteMessageId: 'message-1',
    metadata: { autoDeleteDelayMs: 120_000 },
    completedAt: LEGACY_MESSAGE_AT,
    updatedAt: new Date('2026-08-31T15:04:01.000Z'),
    ...overrides,
  };
}

function legacyOutboundDelete(
  overrides: Partial<BotAutoDeletePresenceRepairLegacyOutboundDelete> = {},
): BotAutoDeletePresenceRepairLegacyOutboundDelete {
  return {
    id: 'delete-ledger-1',
    jobId: 'delete-job-1',
    actionType: 'DELETE_MESSAGE',
    chatId: 'chat-1',
    botId: 'bot-1',
    messageId: 'message-1',
    sourceTag: 'moderation_notice',
    trafficClass: 'background',
    actionHealthLane: 'background',
    status: 'SUCCEEDED',
    ambiguous: false,
    terminal: true,
    attemptCount: 1,
    lastStatusCode: null,
    lastErrorCode: null,
    lastError: null,
    dispatchBotId: null,
    metadata: {
      createdAt: '2026-08-31T15:04:00.000Z',
      scheduledFor: '2026-08-31T15:06:00.000Z',
      routing: null,
      candidateBotIds: [],
      attemptedBotIds: [],
      autoDeleteDelayMs: null,
      sendAutoDelete: null,
      hasText: false,
      textLength: 0,
      hasOptions: false,
      optionKeys: [],
    },
    createdAt: new Date('2026-08-31T15:04:00.100Z'),
    enqueuedAt: new Date('2026-08-31T15:04:00.200Z'),
    firstAttemptAt: new Date('2026-08-31T15:06:00.500Z'),
    lastAttemptAt: new Date('2026-08-31T15:06:00.500Z'),
    completedAt: new Date('2026-08-31T15:06:01.000Z'),
    updatedAt: new Date('2026-08-31T15:06:01.000Z'),
    ...overrides,
  };
}

function legacyClaim(
  overrides: Partial<BotAutoDeletePresenceRepairLegacyClaim> = {},
): BotAutoDeletePresenceRepairLegacyClaim {
  const chatId = overrides.chatId ?? 'chat-1';
  const userId = overrides.userId ?? 'bot-user-1';
  const messageId = overrides.messageId ?? 'message-1';
  const ruleCode = overrides.ruleCode ?? 'BOT_MESSAGE_AUTO_DELETE';
  const updateType = overrides.updateType ?? 'message_action';
  return {
    id: 'claim-1',
    dedupeKey: buildModerationMessageViolationProcessingClaimKey({
      chatId,
      userId,
      messageId,
      ruleCode,
      updateType,
    }).dedupeKey,
    messageActionKey: buildMessageScopedModerationActionClaimKey(chatId, messageId),
    chatId,
    userId,
    messageId,
    ruleCode,
    updateType,
    createdAt: LEGACY_CLAIM_CREATED_AT,
    ...overrides,
  };
}

function intent(
  overrides: Partial<BotAutoDeletePresenceRepairIntent> = {},
): BotAutoDeletePresenceRepairIntent {
  return {
    id: 'intent-1',
    chatId: 'chat-1',
    messageId: 'message-1',
    subjectUserId: 'bot-user-1',
    sourceMessageAt: new Date('2026-08-31T12:00:00.000Z'),
    entityType: 'CHAT',
    messageAuthorKind: 'bot',
    originBotId: 'bot-1',
    routingPolicy: 'origin_only',
    status: 'SUCCEEDED',
    updatedAt: new Date('2026-08-31T13:00:00.000Z'),
    attemptCount: 1,
    lastBotId: 'bot-1',
    succeededBotId: 'bot-1',
    deleteDispatchStartedAt: null,
    deleteDispatchStartedBotId: null,
    remoteDeleteSucceededAt: new Date('2026-08-31T13:00:00.000Z'),
    remoteDeleteSucceededBotId: 'bot-1',
    lastStatusCode: 200,
    lastErrorCode: null,
    completedAt: new Date('2026-08-31T13:00:00.000Z'),
    absenceVerifiedAt: null,
    absenceVerifiedBotId: null,
    absenceVerificationCode: null,
    reasons: [
      {
        ruleCode: 'BOT_MESSAGE_AUTO_DELETE',
      },
    ],
    ...overrides,
  };
}

function options(
  overrides: Partial<BotAutoDeletePresenceRepairOptions> = {},
): BotAutoDeletePresenceRepairOptions {
  return {
    apply: false,
    help: false,
    json: false,
    actorUserId: null,
    targets: [{ chatId: 'chat-1', messageId: 'message-1' }],
    ...overrides,
  };
}

function fixture(
  params: {
    storedIntent?: BotAutoDeletePresenceRepairIntent | null;
    presence?: 'present' | 'absent';
    casRows?: Array<{ id: string }>;
    claim?: BotAutoDeletePresenceRepairLegacyClaim | null;
    outboundSends?: BotAutoDeletePresenceRepairLegacyOutboundSend[];
    outboundDeletes?: BotAutoDeletePresenceRepairLegacyOutboundDelete[];
    membership?: {
      id: string;
      chatId: string;
      botId: string;
      status: 'ACTIVE' | 'REMOVED';
      chat: { entityType: 'CHAT' | 'CHANNEL' };
    } | null;
    exactRow?: Record<string, unknown> | null;
  } = {},
) {
  const storedIntent = params.storedIntent === undefined ? intent() : params.storedIntent;
  const auditCreate = jest.fn().mockResolvedValue({ id: 'audit-1' });
  const queryRaw = jest.fn().mockResolvedValue(params.casRows ?? [{ id: 'intent-1' }]);
  const transaction = jest.fn(async (callback: (tx: unknown) => Promise<unknown>) =>
    callback({
      $queryRaw: queryRaw,
      auditLog: { create: auditCreate },
    }),
  );
  const prisma = {
    moderationDeleteIntent: {
      findUnique: jest.fn().mockResolvedValue(storedIntent),
    },
    moderationViolationMessageClaim: {
      findUnique: jest
        .fn()
        .mockResolvedValue(params.claim === undefined ? legacyClaim() : params.claim),
    },
    maxActionLedgerEntry: {
      findMany: jest.fn((args: { where?: { actionType?: string } }) =>
        Promise.resolve(
          args.where?.actionType === 'DELETE_MESSAGE'
            ? (params.outboundDeletes ?? [])
            : (params.outboundSends ?? []),
        ),
      ),
    },
    chatBotMembership: {
      findUnique: jest.fn().mockResolvedValue(
        params.membership === undefined
          ? {
              id: 'membership-1',
              chatId: 'chat-1',
              botId: 'bot-1',
              status: 'ACTIVE',
              chat: { entityType: 'CHAT' },
            }
          : params.membership,
      ),
    },
    $transaction: transaction,
  };
  const maxClient = {
    getExactMessagePresence: jest.fn().mockResolvedValue(params.presence ?? 'present'),
    getExactMessageRow: jest.fn().mockResolvedValue(
      params.exactRow === undefined
        ? {
            message_id: 'message-1',
            chat_id: 'chat-1',
            sender_id: 'bot-user-1',
            timestamp: LEGACY_MESSAGE_AT.getTime(),
          }
        : params.exactRow,
    ),
  };
  const botRegistry = {
    resolveBotIdFromUserId: jest.fn((userId: string | number | null | undefined): string | null =>
      String(userId ?? '') === 'bot-user-1' ? 'bot-1' : null,
    ),
    getBotById: jest.fn((botId: string | null | undefined) =>
      botId === 'bot-1' ? { id: 'bot-1', state: 'active' } : null,
    ),
  };
  const intentService = {
    getRolloutForRuleCodes: jest.fn().mockReturnValue('execute'),
    ensureBotMessageAutoDeleteRepairIntentWithAudit: jest.fn().mockResolvedValue({
      created: true,
      intentId: 'intent-created-1',
      rollout: 'execute',
      status: 'PENDING',
    }),
    enqueueCurrentIntentWakeupStrict: jest.fn().mockResolvedValue(undefined),
  };

  return {
    dependencies: {
      prisma: prisma as never,
      maxClient: maxClient as never,
      botRegistry: botRegistry as never,
      intentService: intentService as never,
    },
    prisma,
    maxClient,
    botRegistry,
    intentService,
    transaction,
    queryRaw,
    auditCreate,
  };
}

describe('bot auto-delete exact-presence repair', () => {
  it('defaults to dry-run and requires unique exact target pairs', () => {
    expect(
      readBotAutoDeletePresenceRepairOptions([
        '--target',
        ' chat-1 ',
        ' message-1 ',
        '--target',
        'chat-2',
        'message-2',
      ]),
    ).toEqual({
      apply: false,
      help: false,
      json: false,
      actorUserId: null,
      targets: [
        { chatId: 'chat-1', messageId: 'message-1' },
        { chatId: 'chat-2', messageId: 'message-2' },
      ],
    });
    expect(() =>
      readBotAutoDeletePresenceRepairOptions([
        '--target',
        'chat-1',
        'message-1',
        '--target',
        'chat-1',
        'message-1',
      ]),
    ).toThrow('must be unique');
    expect(() => readBotAutoDeletePresenceRepairOptions([])).toThrow(
      'At least one explicit --target',
    );
  });

  it('requires an audited actor for apply and keeps help side-effect free', () => {
    expect(() =>
      readBotAutoDeletePresenceRepairOptions(['--apply', '--target', 'chat-1', 'message-1']),
    ).toThrow('--apply requires --actor-user-id');
    expect(() =>
      readBotAutoDeletePresenceRepairOptions([
        '--apply',
        '--dry-run',
        '--actor-user-id',
        'operator-1',
        '--target',
        'chat-1',
        'message-1',
      ]),
    ).toThrow('cannot be combined');
    expect(readBotAutoDeletePresenceRepairOptions(['--help'])).toMatchObject({
      help: true,
      targets: [],
    });
    expect(BOT_AUTO_DELETE_PRESENCE_REPAIR_USAGE).toContain('Dry-run is the default');
  });

  it('bounds the explicit target count', () => {
    const argv = Array.from({ length: 21 }, (_, index) => [
      '--target',
      `chat-${index}`,
      `message-${index}`,
    ]).flat();
    expect(() => readBotAutoDeletePresenceRepairOptions(argv)).toThrow('At most 20');
  });

  it('accepts only repairable BOT_MESSAGE_AUTO_DELETE-only origin-pinned bot chat intents', () => {
    expect(classifyBotAutoDeletePresenceRepairIntent(intent())).toMatchObject({
      eligible: true,
      originBotId: 'bot-1',
    });
    expect(classifyBotAutoDeletePresenceRepairIntent(null)).toEqual({
      eligible: false,
      reason: 'intent_missing',
    });
    expect(classifyBotAutoDeletePresenceRepairIntent(intent({ status: 'OBSERVED' }))).toEqual({
      eligible: false,
      reason: 'observed_intent_not_promotable',
    });
    for (const status of [
      'PENDING',
      'RETRYABLE',
      'WAITING_CAPABILITY',
      'AMBIGUOUS',
      'SUCCEEDED',
      'ALREADY_ABSENT',
      'EXPIRED',
      'FAILED_TERMINAL',
    ] as const) {
      expect(classifyBotAutoDeletePresenceRepairIntent(intent({ status }))).toMatchObject({
        eligible: true,
      });
    }
    expect(classifyBotAutoDeletePresenceRepairIntent(intent({ status: 'IN_PROGRESS' }))).toEqual({
      eligible: false,
      reason: 'intent_in_progress',
    });
    expect(
      classifyBotAutoDeletePresenceRepairIntent(
        intent({
          reasons: [
            ...intent().reasons,
            {
              ruleCode: 'REQUIRED_SUBSCRIPTION_DELETE',
            },
          ],
        }),
      ),
    ).toEqual({ eligible: false, reason: 'not_bot_message_auto_delete_only' });
    expect(
      classifyBotAutoDeletePresenceRepairIntent(intent({ messageAuthorKind: 'user' })),
    ).toEqual({ eligible: false, reason: 'not_bot_authored_chat_message' });
    expect(
      classifyBotAutoDeletePresenceRepairIntent(intent({ routingPolicy: 'origin_first' })),
    ).toEqual({ eligible: false, reason: 'non_origin_only_routing' });
    expect(
      classifyBotAutoDeletePresenceRepairIntent(
        intent({
          status: 'FAILED_TERMINAL',
          lastErrorCode: 'managed_output_auto_delete_blocked',
        }),
      ),
    ).toEqual({ eligible: false, reason: 'managed_output_auto_delete_blocked' });
  });

  it('requires the dedicated admin runtime role', () => {
    expect(() => assertBotAutoDeletePresenceRepairRole(undefined)).toThrow('APP_ROLE=admin');
    expect(() => assertBotAutoDeletePresenceRepairRole('action')).toThrow('APP_ROLE=admin');
    expect(() => assertBotAutoDeletePresenceRepairRole(' admin ')).not.toThrow();
  });

  it('makes partial apply ineligibility a failing operator result', () => {
    const summary = {
      apply: true,
      requested: 1,
      wouldReopen: 0,
      reopened: 0,
      wouldCreate: 0,
      created: 0,
      reconciledExisting: 0,
      alreadyAbsent: 0,
      ineligible: 1,
      casConflicts: 0,
      errors: 0,
      outcomes: [],
    };
    expect(botAutoDeletePresenceRepairHasFailures(summary)).toBe(true);
    expect(botAutoDeletePresenceRepairHasFailures({ ...summary, apply: false })).toBe(false);
    expect(
      botAutoDeletePresenceRepairHasFailures({
        ...summary,
        ineligible: 0,
        alreadyAbsent: 1,
      }),
    ).toBe(false);
  });

  it('fails closed before live presence or CAS when execution rollout is disabled', async () => {
    const { dependencies, maxClient, transaction, intentService } = fixture();
    intentService.getRolloutForRuleCodes.mockReturnValueOnce('observed');

    await expect(
      runBotAutoDeletePresenceRepair(
        dependencies,
        options({ apply: true, actorUserId: 'operator-1' }),
        () => NOW,
      ),
    ).resolves.toMatchObject({
      ineligible: 1,
      outcomes: [
        expect.objectContaining({
          result: 'ineligible',
          reason: 'execution_rollout_disabled',
        }),
      ],
    });

    expect(maxClient.getExactMessagePresence).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
    expect(intentService.enqueueCurrentIntentWakeupStrict).not.toHaveBeenCalled();
  });

  it('performs exact live presence through the origin bot without mutating in dry-run', async () => {
    const { dependencies, maxClient, transaction, intentService } = fixture();

    await expect(
      runBotAutoDeletePresenceRepair(dependencies, options(), () => NOW),
    ).resolves.toMatchObject({
      apply: false,
      requested: 1,
      wouldReopen: 1,
      reopened: 0,
      errors: 0,
      outcomes: [
        expect.objectContaining({
          result: 'would_reopen',
          intentId: 'intent-1',
          presenceBotId: 'bot-1',
        }),
      ],
    });

    expect(maxClient.getExactMessagePresence).toHaveBeenCalledWith('chat-1', 'message-1', {
      botId: 'bot-1',
      bypassCache: true,
      trafficClass: 'interactive',
      actionHealthLane: 'interactive',
      sourceTag: 'moderation_delete',
      timeoutMs: 5_000,
    });
    expect(transaction).not.toHaveBeenCalled();
    expect(intentService.enqueueCurrentIntentWakeupStrict).not.toHaveBeenCalled();
  });

  it('does not reopen when exact live presence says the message is absent', async () => {
    const { dependencies, transaction, intentService } = fixture({ presence: 'absent' });

    await expect(
      runBotAutoDeletePresenceRepair(
        dependencies,
        options({ apply: true, actorUserId: 'operator-1' }),
        () => NOW,
      ),
    ).resolves.toMatchObject({
      alreadyAbsent: 1,
      reopened: 0,
      outcomes: [expect.objectContaining({ result: 'already_absent' })],
    });

    expect(transaction).not.toHaveBeenCalled();
    expect(intentService.enqueueCurrentIntentWakeupStrict).not.toHaveBeenCalled();
  });

  it('fails closed without mutation when exact live presence is unknown', async () => {
    const { dependencies, maxClient, transaction, intentService } = fixture();
    maxClient.getExactMessagePresence.mockRejectedValueOnce(new Error('MAX lookup timeout'));

    await expect(
      runBotAutoDeletePresenceRepair(
        dependencies,
        options({ apply: true, actorUserId: 'operator-1' }),
        () => NOW,
      ),
    ).resolves.toMatchObject({
      errors: 1,
      outcomes: [
        expect.objectContaining({
          result: 'error',
          error: expect.stringContaining('Exact live presence lookup failed'),
        }),
      ],
    });

    expect(transaction).not.toHaveBeenCalled();
    expect(intentService.enqueueCurrentIntentWakeupStrict).not.toHaveBeenCalled();
  });

  it('CAS reopens a still-present exact BOT-only intent, audits it, then hands off enqueue', async () => {
    const { dependencies, maxClient, queryRaw, auditCreate, intentService } = fixture();

    const summary = await runBotAutoDeletePresenceRepair(
      dependencies,
      options({ apply: true, actorUserId: 'operator-1' }),
      () => NOW,
    );

    expect(summary).toMatchObject({
      reopened: 1,
      errors: 0,
      casConflicts: 0,
      outcomes: [expect.objectContaining({ result: 'reopened' })],
    });
    expect(maxClient.getExactMessagePresence.mock.invocationCallOrder[0]).toBeLessThan(
      queryRaw.mock.invocationCallOrder[0],
    );
    const query = queryRaw.mock.calls[0]?.[0] as {
      strings?: readonly string[];
      values?: readonly unknown[];
    };
    const sql = query.strings?.join('?') ?? '';
    expect(sql).toContain('"status" = CAST(\'PENDING\'');
    expect(sql).toContain('"delete_dispatch_started_at" = NULL');
    expect(sql).toContain('"delete_dispatch_started_bot_id" = NULL');
    expect(sql).toContain('"remote_delete_succeeded_at" = NULL');
    expect(sql).not.toContain('INSERT INTO "moderation_delete_intent_reasons"');
    expect(sql).toContain('"updated_at" = ?');
    expect(sql).toContain('"attempt_count" = ?');
    expect(sql).toContain(
      '"last_error_code" IS DISTINCT FROM \'managed_output_auto_delete_blocked\'',
    );
    expect(sql).toContain('AND EXISTS');
    expect(sql).toContain('AND NOT EXISTS');
    expect(sql).toContain('other_reason."rule_code" <> ?');
    expect(query.values).toEqual(
      expect.arrayContaining([
        'intent-1',
        'chat-1',
        'message-1',
        'SUCCEEDED',
        'BOT_MESSAGE_AUTO_DELETE',
      ]),
    );
    expect(auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        chatId: 'chat-1',
        actorUserId: 'operator-1',
        action: 'OPERATOR_REOPEN_BOT_MESSAGE_AUTO_DELETE_PRESENT',
        payload: expect.objectContaining({
          intentId: 'intent-1',
          messageId: 'message-1',
          previousStatus: 'SUCCEEDED',
          exactPresence: 'present',
          presenceBotId: 'bot-1',
          presenceCheckedAt: NOW.toISOString(),
        }),
      }),
    });
    expect(auditCreate.mock.invocationCallOrder[0]).toBeLessThan(
      intentService.enqueueCurrentIntentWakeupStrict.mock.invocationCallOrder[0],
    );
    expect(intentService.enqueueCurrentIntentWakeupStrict).toHaveBeenCalledWith('intent-1');
  });

  it('does not audit or enqueue when the exact CAS version changed', async () => {
    const { dependencies, auditCreate, intentService } = fixture({ casRows: [] });

    await expect(
      runBotAutoDeletePresenceRepair(
        dependencies,
        options({ apply: true, actorUserId: 'operator-1' }),
        () => NOW,
      ),
    ).resolves.toMatchObject({
      casConflicts: 1,
      reopened: 0,
      outcomes: [expect.objectContaining({ result: 'cas_conflict' })],
    });

    expect(auditCreate).not.toHaveBeenCalled();
    expect(intentService.enqueueCurrentIntentWakeupStrict).not.toHaveBeenCalled();
  });

  it('reports an enqueue handoff failure after the audited CAS without repeating MAX reads', async () => {
    const { dependencies, maxClient, auditCreate, intentService } = fixture();
    intentService.enqueueCurrentIntentWakeupStrict.mockRejectedValueOnce(
      new Error('queue.add failed: redis unavailable'),
    );

    await expect(
      runBotAutoDeletePresenceRepair(
        dependencies,
        options({ apply: true, actorUserId: 'operator-1' }),
        () => NOW,
      ),
    ).resolves.toMatchObject({
      errors: 1,
      outcomes: [
        expect.objectContaining({
          result: 'reopened_enqueue_failed',
          error: 'queue.add failed: redis unavailable',
        }),
      ],
    });

    expect(maxClient.getExactMessagePresence).toHaveBeenCalledTimes(1);
    expect(auditCreate).toHaveBeenCalledTimes(1);
    expect(intentService.enqueueCurrentIntentWakeupStrict).toHaveBeenCalledWith('intent-1');
  });

  it('requires an exact legacy claim or bounded outbound send ledger evidence', async () => {
    const { dependencies, prisma, maxClient, intentService } = fixture({
      storedIntent: null,
      claim: null,
    });

    await expect(
      runBotAutoDeletePresenceRepair(dependencies, options(), () => NOW),
    ).resolves.toMatchObject({
      ineligible: 1,
      outcomes: [
        expect.objectContaining({ result: 'ineligible', reason: 'legacy_outbound_send_missing' }),
      ],
    });

    expect(prisma.moderationViolationMessageClaim.findUnique).toHaveBeenCalledWith({
      where: {
        messageActionKey: buildMessageScopedModerationActionClaimKey('chat-1', 'message-1'),
      },
      select: expect.any(Object),
    });
    expect(prisma.maxActionLedgerEntry.findMany).toHaveBeenCalledWith({
      where: {
        chatId: 'chat-1',
        actionType: 'SEND_MESSAGE',
        updatedAt: {
          gte: new Date('2026-08-24T18:00:00.000Z'),
          lte: new Date('2026-08-31T18:05:00.000Z'),
        },
      },
      select: expect.any(Object),
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: 1_000,
    });
    expect(maxClient.getExactMessageRow).not.toHaveBeenCalled();
    expect(intentService.ensureBotMessageAutoDeleteRepairIntentWithAudit).not.toHaveBeenCalled();
  });

  it.each([
    [
      'ambiguous duplicate rows',
      [legacyOutboundSend(), legacyOutboundSend({ id: 'send-ledger-2', jobId: 'send-job-2' })],
      'legacy_outbound_send_ambiguous',
    ],
    [
      'non-terminal send identity',
      [legacyOutboundSend({ terminal: false })],
      'legacy_outbound_send_identity_mismatch',
    ],
    [
      'foreign source tag',
      [legacyOutboundSend({ sourceTag: 'managed_broadcast' })],
      'legacy_outbound_send_identity_mismatch',
    ],
    [
      'missing auto-delete metadata',
      [legacyOutboundSend({ metadata: { autoDeleteDelayMs: null } })],
      'legacy_outbound_delete_missing',
    ],
    [
      'unsupported auto-delete delay',
      [legacyOutboundSend({ metadata: { autoDeleteDelayMs: 45_000 } })],
      'legacy_outbound_delete_missing',
    ],
    [
      'missing dispatch bot',
      [legacyOutboundSend({ dispatchBotId: null })],
      'legacy_outbound_send_origin_bot_missing',
    ],
  ])('rejects outbound send ledger evidence with %s', async (_label, outboundSends, reason) => {
    const { dependencies, maxClient, intentService } = fixture({
      storedIntent: null,
      claim: null,
      outboundSends,
    });

    await expect(
      runBotAutoDeletePresenceRepair(dependencies, options(), () => NOW),
    ).resolves.toMatchObject({
      ineligible: 1,
      outcomes: [expect.objectContaining({ result: 'ineligible', reason })],
    });

    expect(maxClient.getExactMessageRow).not.toHaveBeenCalled();
    expect(intentService.ensureBotMessageAutoDeleteRepairIntentWithAudit).not.toHaveBeenCalled();
  });

  it.each([
    [
      'ambiguous duplicate rows',
      [
        legacyOutboundDelete(),
        legacyOutboundDelete({ id: 'delete-ledger-2', jobId: 'delete-job-2' }),
      ],
      'legacy_outbound_delete_ambiguous',
    ],
    [
      'foreign origin bot',
      [legacyOutboundDelete({ botId: 'bot-2' })],
      'legacy_outbound_delete_identity_mismatch',
    ],
    [
      'foreign source tag',
      [legacyOutboundDelete({ sourceTag: 'moderation_delete' })],
      'legacy_outbound_delete_identity_mismatch',
    ],
    [
      'unverified terminal state',
      [legacyOutboundDelete({ terminal: false })],
      'legacy_outbound_delete_identity_mismatch',
    ],
    [
      'missing delayed schedule',
      [legacyOutboundDelete({ metadata: { createdAt: '2026-08-31T15:04:00.000Z' } })],
      'legacy_outbound_delete_schedule_missing',
    ],
  ])('rejects outbound DELETE ledger evidence with %s', async (_label, outboundDeletes, reason) => {
    const { dependencies, maxClient, intentService } = fixture({
      storedIntent: null,
      claim: null,
      outboundSends: [legacyOutboundSend({ metadata: { autoDeleteDelayMs: null } })],
      outboundDeletes,
    });

    await expect(
      runBotAutoDeletePresenceRepair(dependencies, options(), () => NOW),
    ).resolves.toMatchObject({
      ineligible: 1,
      outcomes: [expect.objectContaining({ result: 'ineligible', reason })],
    });

    expect(maxClient.getExactMessageRow).not.toHaveBeenCalled();
    expect(intentService.ensureBotMessageAutoDeleteRepairIntentWithAudit).not.toHaveBeenCalled();
  });

  it('creates an audited intent from exact outbound delayed DELETE evidence', async () => {
    const { dependencies, prisma, intentService } = fixture({
      storedIntent: null,
      claim: null,
      outboundSends: [legacyOutboundSend({ metadata: { autoDeleteDelayMs: null } })],
      outboundDeletes: [legacyOutboundDelete()],
    });

    await expect(
      runBotAutoDeletePresenceRepair(
        dependencies,
        options({ apply: true, actorUserId: 'operator-1' }),
        () => NOW,
      ),
    ).resolves.toMatchObject({
      created: 1,
      ineligible: 0,
      errors: 0,
      outcomes: [expect.objectContaining({ result: 'created', presenceBotId: 'bot-1' })],
    });

    expect(prisma.maxActionLedgerEntry.findMany).toHaveBeenNthCalledWith(2, {
      where: {
        chatId: 'chat-1',
        actionType: 'DELETE_MESSAGE',
        messageId: 'message-1',
        status: 'SUCCEEDED',
        updatedAt: {
          gte: new Date('2026-08-24T18:00:00.000Z'),
          lte: new Date('2026-08-31T18:05:00.000Z'),
        },
      },
      select: expect.any(Object),
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: 2,
    });

    expect(intentService.ensureBotMessageAutoDeleteRepairIntentWithAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: 'chat-1',
        messageId: 'message-1',
        subjectUserId: 'bot-user-1',
        sourceMessageAt: LEGACY_MESSAGE_AT,
        originBotId: 'bot-1',
        event: expect.objectContaining({
          metadata: expect.objectContaining({
            repairSource: 'exact_outbound_scheduled_delete_ledger',
          }),
        }),
      }),
      {
        actorUserId: 'operator-1',
        auditPayload: expect.objectContaining({
          repairVersion: 1,
          evidenceVersion: 3,
          evidenceSource: 'outbound_delete_ledger',
          sendLedgerId: 'send-ledger-1',
          deleteLedgerId: 'delete-ledger-1',
          deleteLedgerJobId: 'delete-job-1',
          deleteLedgerStatus: 'SUCCEEDED',
          deleteLedgerSourceTag: 'moderation_notice',
          deleteLedgerScheduledFor: '2026-08-31T15:06:00.000Z',
          deleteScheduledDelayMs: 120_000,
          deleteAnchoredDelayMs: 122_000,
          deleteScheduleEvidenceMode: 'fresh_full_delay',
          liveMessageId: 'message-1',
          liveSenderId: 'bot-user-1',
          originBotId: 'bot-1',
        }),
      },
    );
    expect(intentService.enqueueCurrentIntentWakeupStrict).toHaveBeenCalledWith('intent-created-1');
  });

  it('accepts a recovered legacy DELETE with a partial delay anchored to SEND completion', async () => {
    const recoveredDelete = legacyOutboundDelete({
      metadata: {
        createdAt: '2026-08-31T15:05:00.000Z',
        scheduledFor: '2026-08-31T15:05:58.000Z',
        routing: null,
        candidateBotIds: [],
        attemptedBotIds: [],
        autoDeleteDelayMs: null,
        sendAutoDelete: null,
        hasText: false,
        textLength: 0,
        hasOptions: false,
        optionKeys: [],
      },
      createdAt: new Date('2026-08-31T15:05:00.100Z'),
      enqueuedAt: new Date('2026-08-31T15:05:00.200Z'),
      firstAttemptAt: new Date('2026-08-31T15:05:58.500Z'),
      lastAttemptAt: new Date('2026-08-31T15:05:58.500Z'),
      completedAt: new Date('2026-08-31T15:05:59.000Z'),
      updatedAt: new Date('2026-08-31T15:05:59.000Z'),
    });
    const { dependencies, intentService } = fixture({
      storedIntent: null,
      claim: null,
      outboundSends: [legacyOutboundSend({ metadata: { autoDeleteDelayMs: null } })],
      outboundDeletes: [recoveredDelete],
    });

    await expect(
      runBotAutoDeletePresenceRepair(dependencies, options(), () => NOW),
    ).resolves.toMatchObject({
      wouldCreate: 1,
      ineligible: 0,
      errors: 0,
      outcomes: [expect.objectContaining({ result: 'would_create', presenceBotId: 'bot-1' })],
    });

    expect(intentService.ensureBotMessageAutoDeleteRepairIntentWithAudit).not.toHaveBeenCalled();
  });

  it('accepts exact outbound SEND auto-delete evidence without inventing a claim', async () => {
    const { dependencies, prisma, maxClient, intentService } = fixture({
      storedIntent: null,
      claim: null,
      outboundSends: [legacyOutboundSend()],
    });

    await expect(
      runBotAutoDeletePresenceRepair(dependencies, options(), () => NOW),
    ).resolves.toMatchObject({
      wouldCreate: 1,
      ineligible: 0,
      errors: 0,
      outcomes: [
        expect.objectContaining({
          result: 'would_create',
          presenceBotId: 'bot-1',
        }),
      ],
    });

    expect(prisma.chatBotMembership.findUnique).toHaveBeenCalledWith({
      where: { chatId_botId: { chatId: 'chat-1', botId: 'bot-1' } },
      select: expect.any(Object),
    });
    expect(maxClient.getExactMessageRow).toHaveBeenCalledWith('chat-1', 'message-1', {
      botId: 'bot-1',
      bypassCache: true,
      trafficClass: 'interactive',
      actionHealthLane: 'interactive',
      sourceTag: 'moderation_delete',
      timeoutMs: 5_000,
    });
    expect(intentService.ensureBotMessageAutoDeleteRepairIntentWithAudit).not.toHaveBeenCalled();
  });

  it('creates an audited intent from exact outbound SEND auto-delete evidence', async () => {
    const { dependencies, intentService } = fixture({
      storedIntent: null,
      claim: null,
      outboundSends: [legacyOutboundSend()],
    });

    await expect(
      runBotAutoDeletePresenceRepair(
        dependencies,
        options({ apply: true, actorUserId: 'operator-1' }),
        () => NOW,
      ),
    ).resolves.toMatchObject({
      created: 1,
      ineligible: 0,
      errors: 0,
      outcomes: [expect.objectContaining({ result: 'created' })],
    });

    expect(intentService.ensureBotMessageAutoDeleteRepairIntentWithAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: 'chat-1',
        messageId: 'message-1',
        subjectUserId: 'bot-user-1',
        sourceMessageAt: LEGACY_MESSAGE_AT,
        originBotId: 'bot-1',
        event: expect.objectContaining({
          userId: 'bot-user-1',
          metadata: expect.objectContaining({
            repairSource: 'exact_outbound_send_auto_delete_ledger',
          }),
        }),
      }),
      {
        actorUserId: 'operator-1',
        auditPayload: expect.objectContaining({
          repairVersion: 1,
          evidenceVersion: 2,
          evidenceSource: 'outbound_send_ledger',
          sendLedgerId: 'send-ledger-1',
          sendLedgerJobId: 'send-job-1',
          sendLedgerStatus: 'SUCCEEDED',
          sendLedgerSourceTag: 'moderation_notice',
          sendLedgerCompletedAt: LEGACY_MESSAGE_AT.toISOString(),
          autoDeleteDelayMs: 120_000,
          liveMessageId: 'message-1',
          liveSenderId: 'bot-user-1',
          originBotId: 'bot-1',
        }),
      },
    );
    expect(intentService.enqueueCurrentIntentWakeupStrict).toHaveBeenCalledWith('intent-created-1');
  });

  it.each([
    ['dedupe key', legacyClaim({ dedupeKey: 'v1:wrong' })],
    ['message action key', legacyClaim({ messageActionKey: 'v1:wrong' })],
    ['rule', legacyClaim({ ruleCode: 'REQUIRED_SUBSCRIPTION' })],
    ['update type', legacyClaim({ updateType: 'message_created' })],
  ])('rejects a legacy claim with mismatched %s', async (_label, claim) => {
    const { dependencies, maxClient, intentService } = fixture({ storedIntent: null, claim });

    await expect(
      runBotAutoDeletePresenceRepair(dependencies, options(), () => NOW),
    ).resolves.toMatchObject({
      ineligible: 1,
      outcomes: [
        expect.objectContaining({
          result: 'ineligible',
          reason: 'legacy_claim_identity_mismatch',
        }),
      ],
    });

    expect(maxClient.getExactMessageRow).not.toHaveBeenCalled();
    expect(intentService.ensureBotMessageAutoDeleteRepairIntentWithAudit).not.toHaveBeenCalled();
  });

  it('requires an executable registry mapping and exact active CHAT membership', async () => {
    const unresolved = fixture({ storedIntent: null });
    unresolved.botRegistry.resolveBotIdFromUserId.mockReturnValueOnce(null);
    await expect(
      runBotAutoDeletePresenceRepair(unresolved.dependencies, options(), () => NOW),
    ).resolves.toMatchObject({
      outcomes: [expect.objectContaining({ reason: 'legacy_claim_bot_unresolved' })],
    });
    expect(unresolved.prisma.chatBotMembership.findUnique).not.toHaveBeenCalled();

    const draining = fixture({ storedIntent: null });
    draining.botRegistry.getBotById.mockReturnValueOnce({ id: 'bot-1', state: 'draining' });
    await expect(
      runBotAutoDeletePresenceRepair(draining.dependencies, options(), () => NOW),
    ).resolves.toMatchObject({
      outcomes: [expect.objectContaining({ reason: 'legacy_origin_bot_not_executable' })],
    });
    expect(draining.prisma.chatBotMembership.findUnique).not.toHaveBeenCalled();

    const removed = fixture({
      storedIntent: null,
      membership: {
        id: 'membership-1',
        chatId: 'chat-1',
        botId: 'bot-1',
        status: 'REMOVED',
        chat: { entityType: 'CHAT' },
      },
    });
    await expect(
      runBotAutoDeletePresenceRepair(removed.dependencies, options(), () => NOW),
    ).resolves.toMatchObject({
      outcomes: [expect.objectContaining({ reason: 'legacy_active_membership_missing' })],
    });
    expect(removed.maxClient.getExactMessageRow).not.toHaveBeenCalled();

    const channel = fixture({
      storedIntent: null,
      membership: {
        id: 'membership-1',
        chatId: 'chat-1',
        botId: 'bot-1',
        status: 'ACTIVE',
        chat: { entityType: 'CHANNEL' },
      },
    });
    await expect(
      runBotAutoDeletePresenceRepair(channel.dependencies, options(), () => NOW),
    ).resolves.toMatchObject({
      outcomes: [expect.objectContaining({ reason: 'legacy_chat_not_chat' })],
    });
    expect(channel.maxClient.getExactMessageRow).not.toHaveBeenCalled();
  });

  it('requires the live sender and timestamp to match the exact legacy claim', async () => {
    const senderMismatch = fixture({
      storedIntent: null,
      exactRow: {
        message_id: 'message-1',
        chat_id: 'chat-1',
        sender_id: 'bot-user-2',
        timestamp: LEGACY_MESSAGE_AT.getTime(),
      },
    });
    senderMismatch.botRegistry.resolveBotIdFromUserId.mockImplementation(
      (userId: string | number | null | undefined) =>
        String(userId ?? '') === 'bot-user-1'
          ? 'bot-1'
          : String(userId ?? '') === 'bot-user-2'
            ? 'bot-2'
            : null,
    );
    await expect(
      runBotAutoDeletePresenceRepair(senderMismatch.dependencies, options(), () => NOW),
    ).resolves.toMatchObject({
      outcomes: [expect.objectContaining({ reason: 'legacy_live_sender_mismatch' })],
    });

    const timestampMismatch = fixture({
      storedIntent: null,
      exactRow: {
        message_id: 'message-1',
        chat_id: 'chat-1',
        sender_id: 'bot-user-1',
        timestamp: LEGACY_CLAIM_CREATED_AT.getTime() - 11 * 60_000,
      },
    });
    await expect(
      runBotAutoDeletePresenceRepair(timestampMismatch.dependencies, options(), () => NOW),
    ).resolves.toMatchObject({
      outcomes: [expect.objectContaining({ reason: 'legacy_live_timestamp_mismatch' })],
    });
    expect(
      timestampMismatch.intentService.ensureBotMessageAutoDeleteRepairIntentWithAudit,
    ).not.toHaveBeenCalled();
  });

  it('does not mutate a missing intent when the exact row is absent or lookup is unknown', async () => {
    const absent = fixture({ storedIntent: null, exactRow: null });
    await expect(
      runBotAutoDeletePresenceRepair(
        absent.dependencies,
        options({ apply: true, actorUserId: 'operator-1' }),
        () => NOW,
      ),
    ).resolves.toMatchObject({
      alreadyAbsent: 1,
      outcomes: [expect.objectContaining({ result: 'already_absent', intentId: null })],
    });
    expect(
      absent.intentService.ensureBotMessageAutoDeleteRepairIntentWithAudit,
    ).not.toHaveBeenCalled();

    const unknown = fixture({ storedIntent: null });
    unknown.maxClient.getExactMessageRow.mockRejectedValueOnce(new Error('MAX timeout'));
    await expect(
      runBotAutoDeletePresenceRepair(
        unknown.dependencies,
        options({ apply: true, actorUserId: 'operator-1' }),
        () => NOW,
      ),
    ).resolves.toMatchObject({
      errors: 1,
      outcomes: [
        expect.objectContaining({
          result: 'error',
          error: expect.stringContaining('Exact live message lookup failed'),
        }),
      ],
    });
    expect(
      unknown.intentService.ensureBotMessageAutoDeleteRepairIntentWithAudit,
    ).not.toHaveBeenCalled();
  });

  it('reports would_create for a live exact legacy message without mutating', async () => {
    const { dependencies, prisma, maxClient, intentService } = fixture({ storedIntent: null });

    await expect(
      runBotAutoDeletePresenceRepair(dependencies, options(), () => NOW),
    ).resolves.toMatchObject({
      wouldCreate: 1,
      created: 0,
      outcomes: [
        expect.objectContaining({
          result: 'would_create',
          intentId: null,
          presenceBotId: 'bot-1',
        }),
      ],
    });

    expect(prisma.chatBotMembership.findUnique).toHaveBeenCalledWith({
      where: { chatId_botId: { chatId: 'chat-1', botId: 'bot-1' } },
      select: expect.any(Object),
    });
    expect(maxClient.getExactMessageRow).toHaveBeenCalledWith('chat-1', 'message-1', {
      botId: 'bot-1',
      bypassCache: true,
      trafficClass: 'interactive',
      actionHealthLane: 'interactive',
      sourceTag: 'moderation_delete',
      timeoutMs: 5_000,
    });
    expect(maxClient.getExactMessagePresence).not.toHaveBeenCalled();
    expect(intentService.ensureBotMessageAutoDeleteRepairIntentWithAudit).not.toHaveBeenCalled();
    expect(intentService.enqueueCurrentIntentWakeupStrict).not.toHaveBeenCalled();
  });

  it('atomically creates and audits a missing intent before strict enqueue', async () => {
    const { dependencies, intentService } = fixture({ storedIntent: null });

    await expect(
      runBotAutoDeletePresenceRepair(
        dependencies,
        options({ apply: true, actorUserId: 'operator-1' }),
        () => NOW,
      ),
    ).resolves.toMatchObject({
      created: 1,
      errors: 0,
      outcomes: [expect.objectContaining({ result: 'created', intentId: 'intent-created-1' })],
    });

    expect(intentService.ensureBotMessageAutoDeleteRepairIntentWithAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: 'chat-1',
        messageId: 'message-1',
        reasonKey: 'BOT_MESSAGE_AUTO_DELETE',
        ruleCode: 'BOT_MESSAGE_AUTO_DELETE',
        subjectUserId: 'bot-user-1',
        sourceMessageAt: LEGACY_MESSAGE_AT,
        entityType: 'CHAT',
        messageAuthorKind: 'bot',
        originBotId: 'bot-1',
        routingPolicy: 'origin_only',
        executeAt: NOW,
        event: expect.objectContaining({ userId: 'bot-user-1', eventType: 'MESSAGE' }),
      }),
      {
        actorUserId: 'operator-1',
        auditPayload: expect.objectContaining({
          repairVersion: 1,
          claimId: 'claim-1',
          claimMessageActionKey: buildMessageScopedModerationActionClaimKey('chat-1', 'message-1'),
          claimUserId: 'bot-user-1',
          liveMessageId: 'message-1',
          liveSenderId: 'bot-user-1',
          liveMessageAt: LEGACY_MESSAGE_AT.toISOString(),
          presenceCheckedAt: NOW.toISOString(),
          originBotId: 'bot-1',
        }),
      },
    );
    expect(
      intentService.ensureBotMessageAutoDeleteRepairIntentWithAudit.mock.invocationCallOrder[0],
    ).toBeLessThan(intentService.enqueueCurrentIntentWakeupStrict.mock.invocationCallOrder[0]);
    expect(intentService.enqueueCurrentIntentWakeupStrict).toHaveBeenCalledWith('intent-created-1');
  });

  it('strictly enqueues a concurrently reconciled missing intent and surfaces queue failure', async () => {
    const reconciled = fixture({ storedIntent: null });
    reconciled.intentService.ensureBotMessageAutoDeleteRepairIntentWithAudit.mockResolvedValueOnce({
      created: false,
      intentId: 'intent-concurrent-1',
      rollout: 'execute',
      status: 'PENDING',
    });
    await expect(
      runBotAutoDeletePresenceRepair(
        reconciled.dependencies,
        options({ apply: true, actorUserId: 'operator-1' }),
        () => NOW,
      ),
    ).resolves.toMatchObject({
      reconciledExisting: 1,
      outcomes: [
        expect.objectContaining({
          result: 'reconciled_existing',
          intentId: 'intent-concurrent-1',
        }),
      ],
    });
    expect(reconciled.intentService.enqueueCurrentIntentWakeupStrict).toHaveBeenCalledWith(
      'intent-concurrent-1',
    );

    const failed = fixture({ storedIntent: null });
    failed.intentService.enqueueCurrentIntentWakeupStrict.mockRejectedValueOnce(
      new Error('queue.add failed'),
    );
    await expect(
      runBotAutoDeletePresenceRepair(
        failed.dependencies,
        options({ apply: true, actorUserId: 'operator-1' }),
        () => NOW,
      ),
    ).resolves.toMatchObject({
      errors: 1,
      outcomes: [
        expect.objectContaining({
          result: 'created_enqueue_failed',
          intentId: 'intent-created-1',
          error: 'queue.add failed',
        }),
      ],
    });
  });

  it('uses a narrow operator module without runtime processors or reconcilers', () => {
    const source = readFileSync(
      resolve(__dirname, 'bot-auto-delete-presence-repair.module.ts'),
      'utf8',
    );

    expect(source).not.toContain('ModerationDeleteIntentModule');
    expect(source).not.toContain('AppModule');
    expect(source).not.toContain('AdminModule');
    expect(source).not.toContain('MaxModule');
    expect(source).not.toContain('MaxBotModule');
    expect(source).not.toContain('ModerationModule');
    expect(source).not.toContain('SystemModule');
    expect(source).not.toContain('ModerationDeleteIntentProcessor');
    expect(source).not.toContain('ModerationDeleteIntentReconcilerService');
    expect(source).toContain('BullModule.registerQueue({ name: MODERATION_DELETE_INTENT_QUEUE })');
    expect(source).toContain('useFactory:');
  });
});
