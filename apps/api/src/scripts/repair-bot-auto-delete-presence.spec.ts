import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  BOT_AUTO_DELETE_PRESENCE_REPAIR_USAGE,
  assertBotAutoDeletePresenceRepairRole,
  botAutoDeletePresenceRepairHasFailures,
  classifyBotAutoDeletePresenceRepairIntent,
  readBotAutoDeletePresenceRepairOptions,
  runBotAutoDeletePresenceRepair,
  type BotAutoDeletePresenceRepairIntent,
  type BotAutoDeletePresenceRepairOptions,
} from './repair-bot-auto-delete-presence';

const NOW = new Date('2026-08-31T18:00:00.000Z');

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
    $transaction: transaction,
  };
  const maxClient = {
    getExactMessagePresence: jest.fn().mockResolvedValue(params.presence ?? 'present'),
  };
  const intentService = {
    getRolloutForRuleCodes: jest.fn().mockReturnValue('execute'),
    enqueueCurrentIntentWakeupStrict: jest.fn().mockResolvedValue(undefined),
  };

  return {
    dependencies: {
      prisma: prisma as never,
      maxClient: maxClient as never,
      intentService: intentService as never,
    },
    prisma,
    maxClient,
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
