import { ConfigService } from '@nestjs/config';

import { ModerationDeleteIntentService } from './moderation-delete-intent.service';

type ServiceInternals = {
  classifyDeleteError(
    error: unknown,
    attemptCount: number,
  ): {
    status: string;
    errorCode: string;
    retryDelayMs: number | null;
  };
  normalizeInput(input: Record<string, unknown>): {
    executeAt: Date;
    retryUntilAt: Date;
    routingPolicy: string;
    event: { eventType: string | null };
  };
  selectDueIntentIds(): Promise<unknown[]>;
  claimOne(intentId: string): Promise<unknown>;
  enqueueWakeup(intent: Record<string, unknown>): Promise<void>;
  enqueueCurrentWakeup(intentId: string): Promise<void>;
  orderCandidateBotIds(intent: Record<string, unknown>, values: readonly string[]): string[];
  resolveDeleteRouteWithRefresh(
    intent: Record<string, unknown>,
    heartbeat: { renew: () => Promise<boolean>; stop: () => void },
  ): Promise<unknown>;
  recordCandidateFailure(
    intentId: string,
    leaseToken: string,
    botId: string,
    details: {
      status: string;
      statusCode: number | null;
      errorCode: string;
      message: string;
      retryDelayMs: number | null;
    },
  ): Promise<void>;
  isExecutionEnabledForIntent(intent: Record<string, unknown>): boolean;
};

const ownedHeartbeat = {
  renew: jest.fn().mockResolvedValue(true),
  stop: jest.fn(),
};

function createService(
  overrides: Record<string, unknown> = {},
  prismaOverrides: Record<string, unknown> = {},
  maxClientOverrides: Record<string, unknown> = {},
  maxBotLinkOverrides: Record<string, unknown> = {},
) {
  const config = {
    MODERATION_DELETE_INTENT_MODE: 'on',
    ...overrides,
  };
  const prisma = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    $executeRaw: jest.fn().mockResolvedValue(0),
    $transaction: jest.fn(async (callback: (tx: unknown) => Promise<unknown>) =>
      callback({ $executeRaw: jest.fn().mockResolvedValue(1) }),
    ),
    managedBroadcastDelivery: {
      findFirst: jest.fn().mockResolvedValue(null),
    },
    managedGiveaway: {
      findFirst: jest.fn().mockResolvedValue(null),
    },
    vkParsingPost: {
      findFirst: jest.fn().mockResolvedValue(null),
    },
    chatRules: {
      findUnique: jest.fn().mockResolvedValue(null),
    },
    chatAutoCommentAttachMarker: {
      findFirst: jest.fn().mockResolvedValue(null),
    },
    moderationEvent: {
      findFirst: jest.fn().mockResolvedValue(null),
    },
    ...prismaOverrides,
  };
  const queue = { add: jest.fn().mockResolvedValue(undefined) };
  const deleteMessageOverride = maxClientOverrides.deleteMessage;
  const maxClient = {
    getCurrentChatMemberAccess: jest.fn(),
    getMessageSnapshot: jest.fn(),
    getExactMessagePresence: jest.fn(),
    ...maxClientOverrides,
    deleteMessage: jest.fn(
      async (
        chatId: string,
        messageId: string,
        options?: { beforeImmediateDeleteMutation?: () => Promise<void> },
      ) => {
        await options?.beforeImmediateDeleteMutation?.();
        if (typeof deleteMessageOverride === 'function') {
          return deleteMessageOverride(chatId, messageId, options);
        }
      },
    ),
  };
  const maxBotLink = {
    resolveDeleteMessageBotRoute: jest.fn(),
    recordBotAccessProbe: jest.fn().mockResolvedValue(true),
    getExecutableBotById: jest.fn().mockReturnValue({ id: 'configured-bot' }),
    ...maxBotLinkOverrides,
  };
  const service = new ModerationDeleteIntentService(
    prisma as never,
    maxClient as never,
    maxBotLink as never,
    queue as never,
    new ConfigService(config),
  );
  return { service, prisma, queue, maxClient, maxBotLink };
}

const baseIntent = {
  id: 'intent-1',
  chatId: 'chat-1',
  messageId: 'message-1',
  subjectUserId: 'user-1',
  sourceMessageAt: new Date(),
  entityType: 'CHAT',
  messageAuthorKind: 'user',
  originBotId: 'bot-1',
  routingPolicy: 'delete_capable',
  status: 'IN_PROGRESS',
  executeAt: new Date(Date.now() - 1_000),
  nextAttemptAt: new Date(Date.now() - 1_000),
  retryUntilAt: new Date(Date.now() + 60_000),
  attemptCount: 1,
  lastBotId: null,
  succeededBotId: null,
  deleteDispatchStartedAt: null,
  deleteDispatchStartedBotId: null,
  remoteDeleteSucceededAt: null,
  remoteDeleteSucceededBotId: null,
  candidateFailures: {},
  lastStatusCode: null,
  lastErrorCode: null,
  lastError: null,
  leaseToken: 'lease-1',
  leaseExpiresAt: new Date(Date.now() + 60_000),
  leasedFromStatus: 'PENDING',
} as const;

const confirmedRoute = {
  purpose: 'moderation_action',
  action: 'delete_message',
  chatId: 'chat-1',
  entityType: 'CHAT',
  routingState: 'READY',
  routingVersion: 1,
  primaryBotId: 'bot-1',
  botId: 'bot-1',
  candidateBotIds: ['bot-1', 'bot-2'],
  reason: 'primary_confirmed',
  capabilityState: 'confirmed_capable',
  capabilityReason: 'confirmed',
  checkedAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  candidateCapabilities: ['bot-1', 'bot-2'].map((botId) => ({
    botId,
    state: 'confirmed_capable',
    reason: 'confirmed',
    checkedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    routeEligible: true,
  })),
} as const;

describe('ModerationDeleteIntentService', () => {
  it('classifies a bare 404 as waiting for verification, never as already absent', () => {
    const { service } = createService();
    const result = (service as unknown as ServiceInternals).classifyDeleteError(
      { response: { status: 404, data: { code: 'message.not.found' } } },
      1,
    );

    expect(result.status).toBe('WAITING_CAPABILITY');
    expect(result.errorCode).toBe('unverified_message_not_found');
  });

  it('classifies HTTP 200 success=false message.not.found for exact absence verification', () => {
    const { service } = createService();
    const result = (service as unknown as ServiceInternals).classifyDeleteError(
      {
        response: {
          status: 200,
          data: { success: false, code: 'message.not.found', message: 'Message not found' },
        },
      },
      1,
    );

    expect(result.status).toBe('WAITING_CAPABILITY');
    expect(result.errorCode).toBe('unverified_message_not_found');
  });

  it('classifies HTTP 200 success=false access.denied for candidate failover', () => {
    const { service } = createService();
    const result = (service as unknown as ServiceInternals).classifyDeleteError(
      {
        response: {
          status: 200,
          data: { success: false, code: 'access.denied', message: 'Access denied' },
        },
      },
      1,
    );

    expect(result.status).toBe('WAITING_CAPABILITY');
    expect(result.errorCode).toBe('access.denied');
  });

  it('casts dynamic candidate failure JSON values for PostgreSQL polymorphic functions', async () => {
    const { service, prisma } = createService();

    await (service as unknown as ServiceInternals).recordCandidateFailure(
      'intent-1',
      'lease-1',
      'bot-1',
      {
        status: 'WAITING_CAPABILITY',
        statusCode: null,
        errorCode: 'missing_chat_delete_permission',
        message: 'No delete permission',
        retryDelayMs: 30_000,
      },
    );

    const query = prisma.$executeRaw.mock.calls[0]?.[0] as
      | { strings?: readonly string[]; values?: readonly unknown[] }
      | undefined;
    const sql = query?.strings?.join('?') ?? '';
    expect(sql.match(/CAST\(\? AS text\)/g)).toHaveLength(4);
    expect(sql).toContain('CAST(? AS integer)');
    expect(query?.values?.[0]).toBe('bot-1');
    expect(query?.values?.[3]).toBe('missing_chat_delete_permission');
    expect(query?.values?.[4]).toBeNull();
  });

  it('classifies an outbound timeout as ambiguous', () => {
    const { service } = createService();
    const result = (service as unknown as ServiceInternals).classifyDeleteError(
      Object.assign(new Error('request timeout'), { code: 'ETIMEDOUT' }),
      1,
    );

    expect(result.status).toBe('AMBIGUOUS');
  });

  it('uses a fresh DELETE idempotency key after an ambiguous transport attempt', async () => {
    const ambiguous = {
      ...baseIntent,
      status: 'AMBIGUOUS',
      nextAttemptAt: new Date(Date.now() - 1_000),
      leaseToken: null,
      leaseExpiresAt: null,
      lastErrorCode: 'delete_transport_ambiguous',
    };
    const retried = {
      ...ambiguous,
      status: 'IN_PROGRESS',
      attemptCount: 2,
      leaseToken: 'lease-2',
      leaseExpiresAt: new Date(Date.now() + 60_000),
    };
    const succeeded = {
      ...retried,
      status: 'SUCCEEDED',
      succeededBotId: 'bot-1',
      remoteDeleteSucceededAt: new Date(),
      remoteDeleteSucceededBotId: 'bot-1',
      leaseToken: null,
      leaseExpiresAt: null,
      lastErrorCode: null,
    };
    const queryRaw = jest
      .fn()
      .mockResolvedValueOnce([{ ...baseIntent }])
      .mockResolvedValueOnce([ambiguous])
      .mockResolvedValueOnce([retried])
      .mockResolvedValueOnce([succeeded]);
    const deleteMessage = jest
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('request timeout'), { code: 'ETIMEDOUT' }))
      .mockResolvedValueOnce(undefined);
    const { service } = createService(
      {},
      { $queryRaw: queryRaw, $executeRaw: jest.fn().mockResolvedValue(1) },
      {
        deleteMessage,
        getExactMessagePresence: jest.fn().mockResolvedValue('present'),
      },
      { resolveDeleteMessageBotRoute: jest.fn().mockResolvedValue(confirmedRoute) },
    );

    await expect(service.executeLeasedIntent('intent-1', 'lease-1')).resolves.toMatchObject({
      kind: 'ambiguous',
    });
    await expect(service.executeLeasedIntent('intent-1', 'lease-2')).resolves.toMatchObject({
      kind: 'confirmed',
      status: 'SUCCEEDED',
    });

    expect(deleteMessage).toHaveBeenNthCalledWith(
      1,
      'chat-1',
      'message-1',
      expect.objectContaining({
        idempotencyKey: 'moderation-delete-intent-intent-1-attempt-1',
      }),
    );
    expect(deleteMessage).toHaveBeenNthCalledWith(
      2,
      'chat-1',
      'message-1',
      expect.objectContaining({
        idempotencyKey: 'moderation-delete-intent-intent-1-attempt-2',
      }),
    );
  });

  it('honors a longer MAX Retry-After on 429 responses', () => {
    const { service } = createService();
    const result = (service as unknown as ServiceInternals).classifyDeleteError(
      { response: { status: 429, headers: { 'retry-after': '45' } } },
      1,
    );

    expect(result.status).toBe('RETRYABLE');
    expect(result.retryDelayMs).toBeGreaterThanOrEqual(45_000);
  });

  it('keeps the retry window after delayed executeAt', () => {
    const { service } = createService({ MODERATION_DELETE_INTENT_RETRY_HORIZON_MS: 60_000 });
    const executeAt = new Date(Date.now() + 3_600_000);
    const normalized = (service as unknown as ServiceInternals).normalizeInput({
      chatId: 'chat-1',
      messageId: 'message-1',
      reasonKey: 'BOT_NOTICE_DELETE',
      executeAt,
      entityType: 'CHAT',
      messageAuthorKind: 'bot',
      originBotId: 'bot-1',
    });

    expect(normalized.retryUntilAt.getTime()).toBe(executeAt.getTime() + 60_000);
    expect(normalized.retryUntilAt.getTime()).toBeGreaterThanOrEqual(
      normalized.executeAt.getTime(),
    );
  });

  it('requires a separate canary before user-authored chat deletes can use another bot', () => {
    const input = {
      chatId: 'chat-1',
      messageId: 'message-1',
      reasonKey: 'DUPLICATE',
      entityType: 'CHAT',
      messageAuthorKind: 'user',
      originBotId: 'bot-1',
      routingPolicy: 'delete_capable',
    };
    const withoutCanary = createService().service;
    const withCanary = createService({
      MODERATION_DELETE_CROSS_BOT_CANARY_CHAT_IDS: 'chat-1',
    }).service;

    expect((withoutCanary as unknown as ServiceInternals).normalizeInput(input).routingPolicy).toBe(
      'origin_only',
    );
    expect((withCanary as unknown as ServiceInternals).normalizeInput(input).routingPolicy).toBe(
      'delete_capable',
    );
  });

  it('retains exact replacement routing while the kill switch controls its effective use', () => {
    const input = {
      chatId: 'chat-1',
      messageId: 'message-1',
      reasonKey: 'chat_auto_comment_admin_message_replacement_cleanup',
      ruleCode: 'CHAT_AUTO_COMMENT_ADMIN_MESSAGE_REPLACEMENT_CLEANUP',
      entityType: 'CHAT' as const,
      messageAuthorKind: 'user' as const,
      originBotId: 'bot-1',
      routingPolicy: 'origin_first' as const,
    };
    const disabled = createService({
      MODERATION_DELETE_INTENT_REPLACEMENT_CLEANUP_ENABLED: false,
    }).service;

    expect((disabled as unknown as ServiceInternals).normalizeInput(input).routingPolicy).toBe(
      'origin_first',
    );
    expect(
      disabled.resolveEffectiveRoutingPolicy({
        ...input,
        replacementCleanup: true,
      }),
    ).toBe('origin_only');
  });

  it('executes safety-critical cleanup rules outside the global canary', () => {
    const enabled = createService({
      MODERATION_DELETE_INTENT_MODE: 'canary',
      MODERATION_DELETE_INTENT_CANARY_CHAT_IDS: 'other-chat',
    }).service;
    const disabled = createService({
      MODERATION_DELETE_INTENT_MODE: 'canary',
      MODERATION_DELETE_INTENT_CANARY_CHAT_IDS: 'other-chat',
      MODERATION_DELETE_INTENT_REPLACEMENT_CLEANUP_ENABLED: false,
    }).service;

    expect(
      enabled.getRolloutForRule('chat-1', 'CHANNEL_AUTO_POST_FORWARD_REPLACEMENT_CLEANUP'),
    ).toBe('execute');
    expect(
      enabled.getRolloutForRule('chat-1', 'CHAT_AUTO_COMMENT_ADMIN_MESSAGE_REPLACEMENT_CLEANUP'),
    ).toBe('execute');
    expect(
      enabled.getRolloutForRule('chat-1', 'CHAT_RULES_REPUBLISH_PREVIOUS_MESSAGE_CLEANUP'),
    ).toBe('execute');
    expect(
      enabled.getRolloutForRule('chat-1', 'CHAT_RULES_REPUBLISH_PREVIOUS_MESSAGE_CLEANUP_EXTRA'),
    ).toBe('observed');
    expect(
      disabled.getRolloutForRule('chat-1', 'CHAT_RULES_REPUBLISH_PREVIOUS_MESSAGE_CLEANUP'),
    ).toBe('observed');
    expect(enabled.getRolloutForRule('chat-1', 'BOT_MESSAGE_AUTO_DELETE')).toBe('execute');
    expect(enabled.getRolloutForRule('chat-1', 'BOT_MESSAGE_AUTO_DELETE_EXTRA')).toBe('observed');
  });

  it('rechecks the replacement cleanup switch at execution time', () => {
    const enabled = createService({
      MODERATION_DELETE_INTENT_MODE: 'canary',
      MODERATION_DELETE_INTENT_CANARY_CHAT_IDS: 'other-chat',
    }).service as unknown as ServiceInternals;
    const disabled = createService({
      MODERATION_DELETE_INTENT_MODE: 'canary',
      MODERATION_DELETE_INTENT_CANARY_CHAT_IDS: 'other-chat',
      MODERATION_DELETE_INTENT_REPLACEMENT_CLEANUP_ENABLED: false,
    }).service as unknown as ServiceInternals;

    expect(
      enabled.isExecutionEnabledForIntent({ chatId: 'chat-1', replacementCleanup: true }),
    ).toBe(true);
    expect(
      enabled.isExecutionEnabledForIntent({ chatId: 'chat-1', replacementCleanup: false }),
    ).toBe(false);
    expect(
      disabled.isExecutionEnabledForIntent({ chatId: 'chat-1', replacementCleanup: true }),
    ).toBe(false);
  });

  it('keeps BOT_MESSAGE_AUTO_DELETE durable outside the global canary', () => {
    const service = createService({
      MODERATION_DELETE_INTENT_MODE: 'canary',
      MODERATION_DELETE_INTENT_CANARY_CHAT_IDS: 'other-chat',
    }).service as unknown as ServiceInternals;

    expect(
      service.isExecutionEnabledForIntent({
        chatId: 'chat-1',
        replacementCleanup: false,
        botMessageAutoDeleteOnly: true,
      }),
    ).toBe(true);
  });

  it('rejects executable origin-only intents without an origin bot', () => {
    const { service } = createService();

    expect(() =>
      (service as unknown as ServiceInternals).normalizeInput({
        chatId: 'chat-1',
        messageId: 'message-1',
        reasonKey: 'BOT_NOTICE_DELETE',
        entityType: 'CHAT',
        messageAuthorKind: 'bot',
        routingPolicy: 'origin_only',
      }),
    ).toThrow('originBotId is required');
  });

  it('uses the current cross-bot gate instead of a permissive stored policy', () => {
    const disabled = createService().service as unknown as ServiceInternals;
    const enabled = createService({
      MODERATION_DELETE_CROSS_BOT_CANARY_CHAT_IDS: 'chat-1',
    }).service as unknown as ServiceInternals;

    expect(
      disabled.orderCandidateBotIds({ ...baseIntent, routingPolicy: 'delete_capable' }, [
        'bot-2',
        'bot-1',
      ]),
    ).toEqual(['bot-1']);
    expect(
      enabled.orderCandidateBotIds({ ...baseIntent, routingPolicy: 'origin_only' }, [
        'bot-2',
        'bot-1',
      ]),
    ).toEqual(['bot-1', 'bot-2']);
    expect(
      enabled.orderCandidateBotIds(
        { ...baseIntent, entityType: 'CHANNEL', routingPolicy: 'delete_capable' },
        ['bot-2', 'bot-1'],
      ),
    ).toEqual(['bot-1']);
  });

  it('re-probes an active denied candidate after its per-intent backoff expires', async () => {
    const deniedRoute = {
      ...confirmedRoute,
      botId: null,
      candidateBotIds: [],
      reason: null,
      capabilityState: 'explicitly_incapable',
      capabilityReason: 'access_denied',
      candidateCapabilities: [
        {
          botId: 'bot-1',
          state: 'explicitly_incapable',
          reason: 'access_denied',
          checkedAt: new Date(Date.now() - 60_000).toISOString(),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          routeEligible: false,
        },
      ],
    } as const;
    const restoredRoute = {
      ...confirmedRoute,
      candidateBotIds: ['bot-1'],
      candidateCapabilities: [confirmedRoute.candidateCapabilities[0]],
    } as const;
    const resolveDeleteMessageBotRoute = jest
      .fn()
      .mockResolvedValueOnce(deniedRoute)
      .mockResolvedValueOnce(restoredRoute);
    const getCurrentChatMemberAccess = jest.fn().mockResolvedValue({
      userId: 'bot-user-1',
      isAdmin: true,
      isOwner: false,
      permissions: ['read_all_messages', 'write'],
    });
    const { service, maxBotLink } = createService(
      {},
      {},
      { getCurrentChatMemberAccess },
      { resolveDeleteMessageBotRoute },
    );
    const intent = {
      ...baseIntent,
      routingPolicy: 'origin_only',
      candidateFailures: {
        'bot-1': {
          failedAt: new Date(Date.now() - 60_000).toISOString(),
          retryAt: new Date(Date.now() - 1_000).toISOString(),
          errorCode: 'access.denied',
          statusCode: 403,
        },
      },
    };

    const route = await (service as unknown as ServiceInternals).resolveDeleteRouteWithRefresh(
      intent,
      ownedHeartbeat,
    );

    expect(route).toEqual(restoredRoute);
    expect(getCurrentChatMemberAccess).toHaveBeenCalledWith(
      'chat-1',
      expect.objectContaining({
        botId: 'bot-1',
        bypassCache: true,
        ignoreFailureMetricStatuses: [403, 404],
      }),
    );
    expect(maxBotLink.recordBotAccessProbe).toHaveBeenCalledWith(
      expect.objectContaining({ botId: 'bot-1', source: 'moderation_delete_intent_probe' }),
    );
  });

  it('preserves an explicit null event type so callers can suppress delete events', () => {
    const { service } = createService();
    const normalized = (service as unknown as ServiceInternals).normalizeInput({
      chatId: 'chat-1',
      messageId: 'message-1',
      reasonKey: 'ADMIN_CLEANUP',
      subjectUserId: 'user-1',
      originBotId: 'bot-1',
      event: { eventType: null },
    });

    expect(normalized.event.eventType).toBeNull();
  });

  it.each([
    {
      label: 'managed publication',
      ownerKind: 'managed_publication',
      prismaOwner: {
        managedBroadcastDelivery: {
          findFirst: jest.fn().mockResolvedValue({ id: 'delivery-1' }),
        },
      },
    },
    {
      label: 'giveaway publication',
      ownerKind: 'managed_giveaway_publication',
      prismaOwner: {
        managedGiveaway: {
          findFirst: jest.fn().mockResolvedValue({
            id: 'giveaway-1',
            publicationMessageId: 'message-1',
            resultsMessageId: null,
          }),
        },
      },
    },
    {
      label: 'giveaway results',
      ownerKind: 'managed_giveaway_results',
      prismaOwner: {
        managedGiveaway: {
          findFirst: jest.fn().mockResolvedValue({
            id: 'giveaway-1',
            publicationMessageId: 'publication-message',
            resultsMessageId: 'message-1',
          }),
        },
      },
    },
    {
      label: 'VK parsing post',
      ownerKind: 'vk_parsing_post',
      prismaOwner: {
        vkParsingPost: {
          findFirst: jest.fn().mockResolvedValue({ id: 'vk-post-1' }),
        },
      },
    },
    {
      label: 'published chat rules',
      ownerKind: 'published_chat_rules',
      prismaOwner: {
        chatRules: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'chat-rules-1',
            publishedMessageId: 'message-1',
          }),
        },
      },
    },
    {
      label: 'chat auto-comment replacement',
      ownerKind: 'chat_auto_comment_replacement',
      prismaOwner: {
        chatAutoCommentAttachMarker: {
          findFirst: jest.fn().mockResolvedValue({
            id: 'chat-comment-marker-1',
            replacementMessageId: 'message-1',
            replyMessageId: null,
          }),
        },
      },
    },
    {
      label: 'chat auto-comment fallback reply',
      ownerKind: 'chat_auto_comment_reply',
      prismaOwner: {
        chatAutoCommentAttachMarker: {
          findFirst: jest.fn().mockResolvedValue({
            id: 'chat-comment-marker-2',
            replacementMessageId: null,
            replyMessageId: 'message-1',
          }),
        },
      },
    },
    {
      label: 'persisted night-mode transition notice',
      ownerKind: 'night_mode_transition_notice',
      prismaOwner: {
        moderationEvent: {
          findFirst: jest.fn().mockResolvedValue({ id: 'night-close-event-1' }),
        },
      },
    },
  ])(
    'blocks BOT_MESSAGE_AUTO_DELETE at dispatch time for a late $label owner',
    async ({ ownerKind, prismaOwner }) => {
      const autoDeleteIntent = {
        ...baseIntent,
        messageAuthorKind: 'bot',
        routingPolicy: 'origin_only',
        botMessageAutoDeleteOnly: true,
      };
      const blockedIntent = {
        ...autoDeleteIntent,
        status: 'FAILED_TERMINAL',
        leaseToken: null,
        leaseExpiresAt: null,
        lastErrorCode: 'managed_output_auto_delete_blocked',
        lastError: 'Managed bot output is protected',
      };
      const queryRaw = jest
        .fn()
        .mockResolvedValueOnce([autoDeleteIntent])
        .mockResolvedValueOnce([blockedIntent]);
      const executeRaw = jest.fn().mockResolvedValue(1);
      const deleteMessage = jest.fn();
      const { service, prisma, maxBotLink } = createService(
        {},
        {
          $queryRaw: queryRaw,
          $executeRaw: executeRaw,
          ...prismaOwner,
        },
        { deleteMessage },
        { resolveDeleteMessageBotRoute: jest.fn().mockResolvedValue(confirmedRoute) },
      );

      const result = await service.executeLeasedIntent('intent-1', 'lease-1');

      expect(result).toMatchObject({
        kind: 'terminal',
        confirmed: false,
        status: 'FAILED_TERMINAL',
      });
      expect(deleteMessage).not.toHaveBeenCalled();
      expect(maxBotLink.resolveDeleteMessageBotRoute).not.toHaveBeenCalled();
      const loadQuery = queryRaw.mock.calls[0]?.[0] as { strings?: readonly string[] } | undefined;
      expect(loadQuery?.strings?.join('?')).toContain('AS "botMessageAutoDeleteOnly"');
      const guardQuery = executeRaw.mock.calls
        .map(([query]) => query as { strings?: readonly string[] })
        .find((query) =>
          (query.strings?.join('?') ?? '').includes('managed_output_auto_delete_blocked'),
        );
      expect(guardQuery).toBeDefined();
      expect(guardQuery?.strings?.join('?')).toContain(
        `other_reason."rule_code" <> 'BOT_MESSAGE_AUTO_DELETE'`,
      );
      expect(
        executeRaw.mock.calls.some(([query]) =>
          ((query as { values?: readonly unknown[] }).values ?? []).some(
            (value) => typeof value === 'string' && value.includes(ownerKind),
          ),
        ),
      ).toBe(true);
      if (ownerKind === 'night_mode_transition_notice') {
        expect(prisma.moderationEvent.findFirst).toHaveBeenCalledWith({
          where: {
            chatId: 'chat-1',
            messageId: 'message-1',
            ruleCode: {
              in: ['NIGHT_MODE_CLOSE_NOTICE', 'NIGHT_MODE_OPEN_NOTICE'],
            },
          },
          select: { id: true },
        });
      }
    },
  );

  it('blocks a transition notice that becomes protected inside the final MAX delete guard', async () => {
    const autoDeleteIntent = {
      ...baseIntent,
      messageAuthorKind: 'bot',
      routingPolicy: 'origin_only',
      botMessageAutoDeleteOnly: true,
    };
    const blockedIntent = {
      ...autoDeleteIntent,
      status: 'FAILED_TERMINAL',
      leaseToken: null,
      leaseExpiresAt: null,
      lastErrorCode: 'managed_output_auto_delete_blocked',
      lastError: 'Night mode transition notice is protected',
    };
    const queryRaw = jest
      .fn()
      .mockResolvedValueOnce([autoDeleteIntent])
      .mockResolvedValueOnce([blockedIntent]);
    const transitionEventLookup = jest
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'night-close-event-1' });
    const deleteMessageOverride = jest.fn();
    const { service, prisma, maxBotLink } = createService(
      {},
      {
        $queryRaw: queryRaw,
        $executeRaw: jest.fn().mockResolvedValue(1),
        moderationEvent: { findFirst: transitionEventLookup },
      },
      { deleteMessage: deleteMessageOverride },
      { resolveDeleteMessageBotRoute: jest.fn().mockResolvedValue(confirmedRoute) },
    );

    await expect(service.executeLeasedIntent('intent-1', 'lease-1')).resolves.toMatchObject({
      kind: 'terminal',
      confirmed: false,
      status: 'FAILED_TERMINAL',
    });

    expect(transitionEventLookup).toHaveBeenCalledTimes(2);
    expect(maxBotLink.resolveDeleteMessageBotRoute).toHaveBeenCalledTimes(1);
    expect(deleteMessageOverride).not.toHaveBeenCalled();
    const executedSql = prisma.$executeRaw.mock.calls
      .map((call: unknown[]) => {
        const query = call[0] as { strings?: readonly string[] };
        return query.strings?.join('?') ?? '';
      })
      .join('\n');
    expect(executedSql).not.toContain('"delete_dispatch_started_at" = CURRENT_TIMESTAMP');
  });

  it('allows BOT_MESSAGE_AUTO_DELETE when no managed output owns the message', async () => {
    const autoDeleteIntent = {
      ...baseIntent,
      messageAuthorKind: 'bot',
      routingPolicy: 'origin_only',
      botMessageAutoDeleteOnly: true,
    };
    const completedIntent = {
      ...autoDeleteIntent,
      status: 'SUCCEEDED',
      lastBotId: 'bot-1',
      succeededBotId: 'bot-1',
      leaseToken: null,
      leaseExpiresAt: null,
    };
    const queryRaw = jest
      .fn()
      .mockResolvedValueOnce([autoDeleteIntent])
      .mockResolvedValueOnce([completedIntent]);
    const deleteMessage = jest.fn().mockResolvedValue(undefined);
    const { service, prisma } = createService(
      {},
      {
        $queryRaw: queryRaw,
        $executeRaw: jest.fn().mockResolvedValue(1),
      },
      { deleteMessage },
      { resolveDeleteMessageBotRoute: jest.fn().mockResolvedValue(confirmedRoute) },
    );

    const result = await service.executeLeasedIntent('intent-1', 'lease-1');

    expect(result).toMatchObject({ kind: 'confirmed', confirmed: true, status: 'SUCCEEDED' });
    expect(prisma.managedBroadcastDelivery.findFirst).toHaveBeenCalledTimes(2);
    expect(prisma.managedGiveaway.findFirst).toHaveBeenCalledTimes(2);
    expect(prisma.vkParsingPost.findFirst).toHaveBeenCalledTimes(2);
    expect(prisma.chatRules.findUnique).toHaveBeenCalledTimes(2);
    expect(prisma.chatAutoCommentAttachMarker.findFirst).toHaveBeenCalledTimes(2);
    expect(prisma.moderationEvent.findFirst).toHaveBeenCalledTimes(2);
    expect(deleteMessage).toHaveBeenCalledWith(
      'chat-1',
      'message-1',
      expect.objectContaining({ botId: 'bot-1', immediate: true }),
    );
  });

  it('does not dispatch auto-delete when the managed delivery guard cannot be read', async () => {
    const autoDeleteIntent = {
      ...baseIntent,
      messageAuthorKind: 'bot',
      routingPolicy: 'origin_only',
      botMessageAutoDeleteOnly: true,
    };
    const retryableIntent = {
      ...autoDeleteIntent,
      status: 'RETRYABLE',
      leaseToken: null,
      leaseExpiresAt: null,
      lastErrorCode: 'delete_failed',
      lastError: 'publication delivery lookup failed',
    };
    const queryRaw = jest
      .fn()
      .mockResolvedValueOnce([autoDeleteIntent])
      .mockResolvedValueOnce([retryableIntent]);
    const findFirst = jest.fn().mockRejectedValue(new Error('publication delivery lookup failed'));
    const deleteMessage = jest.fn();
    const { service } = createService(
      {},
      {
        $queryRaw: queryRaw,
        $executeRaw: jest.fn().mockResolvedValue(1),
        managedBroadcastDelivery: { findFirst },
      },
      { deleteMessage },
      { resolveDeleteMessageBotRoute: jest.fn().mockResolvedValue(confirmedRoute) },
    );

    const result = await service.executeLeasedIntent('intent-1', 'lease-1');

    expect(result).toMatchObject({ kind: 'pending', confirmed: false, status: 'RETRYABLE' });
    expect(findFirst).toHaveBeenCalledTimes(1);
    expect(deleteMessage).not.toHaveBeenCalled();
  });

  it('allows a managed bot message delete when another executable reason shares the intent', async () => {
    const mixedReasonIntent = {
      ...baseIntent,
      messageAuthorKind: 'bot',
      routingPolicy: 'origin_only',
      botMessageAutoDeleteOnly: false,
    };
    const completedIntent = {
      ...mixedReasonIntent,
      status: 'SUCCEEDED',
      lastBotId: 'bot-1',
      succeededBotId: 'bot-1',
      leaseToken: null,
      leaseExpiresAt: null,
    };
    const queryRaw = jest
      .fn()
      .mockResolvedValueOnce([mixedReasonIntent])
      .mockResolvedValueOnce([completedIntent]);
    const deleteMessage = jest.fn().mockResolvedValue(undefined);
    const { service, prisma } = createService(
      {},
      {
        $queryRaw: queryRaw,
        $executeRaw: jest.fn().mockResolvedValue(1),
        managedBroadcastDelivery: {
          findFirst: jest.fn().mockResolvedValue({ id: 'delivery-1' }),
        },
      },
      { deleteMessage },
      { resolveDeleteMessageBotRoute: jest.fn().mockResolvedValue(confirmedRoute) },
    );

    await expect(service.executeLeasedIntent('intent-1', 'lease-1')).resolves.toMatchObject({
      kind: 'confirmed',
      confirmed: true,
      status: 'SUCCEEDED',
    });
    expect(prisma.managedBroadcastDelivery.findFirst).not.toHaveBeenCalled();
    expect(deleteMessage).toHaveBeenCalledTimes(1);
  });

  it('allows NIGHT_MODE_CLOSE_NOTICE_CLEANUP for a persisted close notice', async () => {
    const cleanupIntent = {
      ...baseIntent,
      messageAuthorKind: 'bot',
      routingPolicy: 'origin_only',
      botMessageAutoDeleteOnly: false,
    };
    const completedIntent = {
      ...cleanupIntent,
      status: 'SUCCEEDED',
      lastBotId: 'bot-1',
      succeededBotId: 'bot-1',
      leaseToken: null,
      leaseExpiresAt: null,
    };
    const queryRaw = jest
      .fn()
      .mockResolvedValueOnce([cleanupIntent])
      .mockResolvedValueOnce([completedIntent]);
    const deleteMessage = jest.fn().mockResolvedValue(undefined);
    const transitionEventLookup = jest.fn().mockResolvedValue({ id: 'night-close-event-1' });
    const { service } = createService(
      {},
      {
        $queryRaw: queryRaw,
        $executeRaw: jest.fn().mockResolvedValue(1),
        moderationEvent: { findFirst: transitionEventLookup },
      },
      { deleteMessage },
      { resolveDeleteMessageBotRoute: jest.fn().mockResolvedValue(confirmedRoute) },
    );

    await expect(service.executeLeasedIntent('intent-1', 'lease-1')).resolves.toMatchObject({
      kind: 'confirmed',
      confirmed: true,
      status: 'SUCCEEDED',
    });
    expect(transitionEventLookup).not.toHaveBeenCalled();
    expect(deleteMessage).toHaveBeenCalledTimes(1);
  });

  it('refreshes a denied candidate and tries the next freshly capable bot', async () => {
    const queryRaw = jest
      .fn()
      .mockResolvedValueOnce([{ ...baseIntent }])
      .mockResolvedValueOnce([
        {
          ...baseIntent,
          status: 'SUCCEEDED',
          lastBotId: 'bot-2',
          succeededBotId: 'bot-2',
          leaseToken: null,
          leaseExpiresAt: null,
        },
      ]);
    const deleteMessage = jest
      .fn()
      .mockRejectedValueOnce({
        response: {
          status: 200,
          data: { success: false, code: 'access.denied', message: 'Access denied' },
        },
      })
      .mockResolvedValueOnce(undefined);
    const getCurrentChatMemberAccess = jest.fn().mockResolvedValue({
      userId: 'bot-user-1',
      isAdmin: true,
      isOwner: false,
      permissions: ['read_all_messages', 'write'],
    });
    const resolveDeleteMessageBotRoute = jest.fn().mockResolvedValue(confirmedRoute);
    const { service, maxBotLink } = createService(
      { MODERATION_DELETE_CROSS_BOT_CANARY_CHAT_IDS: 'chat-1' },
      { $queryRaw: queryRaw, $executeRaw: jest.fn().mockResolvedValue(1) },
      { deleteMessage, getCurrentChatMemberAccess },
      { resolveDeleteMessageBotRoute },
    );

    const result = await service.executeLeasedIntent('intent-1', 'lease-1');

    expect(result).toMatchObject({ kind: 'confirmed', confirmed: true, botId: 'bot-2' });
    expect(deleteMessage).toHaveBeenNthCalledWith(
      1,
      'chat-1',
      'message-1',
      expect.objectContaining({ botId: 'bot-1', immediate: true }),
    );
    expect(deleteMessage).toHaveBeenNthCalledWith(
      2,
      'chat-1',
      'message-1',
      expect.objectContaining({ botId: 'bot-2', immediate: true }),
    );
    expect(maxBotLink.recordBotAccessProbe).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: 'chat-1', botId: 'bot-1' }),
    );
  });

  it('uses a survivor after exact replacement cleanup gets HTTP 403 outside cross-bot canary', async () => {
    const replacementIntent = {
      ...baseIntent,
      routingPolicy: 'origin_first',
      replacementCleanup: true,
    };
    const queryRaw = jest
      .fn()
      .mockResolvedValueOnce([replacementIntent])
      .mockResolvedValueOnce([
        {
          ...replacementIntent,
          status: 'SUCCEEDED',
          lastBotId: 'bot-2',
          succeededBotId: 'bot-2',
          leaseToken: null,
          leaseExpiresAt: null,
        },
      ]);
    const deleteMessage = jest
      .fn()
      .mockRejectedValueOnce({
        response: { status: 403, data: { code: 'access.denied', message: 'Access denied' } },
      })
      .mockResolvedValueOnce(undefined);
    const { service } = createService(
      { MODERATION_DELETE_INTENT_MODE: 'off' },
      { $queryRaw: queryRaw, $executeRaw: jest.fn().mockResolvedValue(1) },
      {
        deleteMessage,
        getCurrentChatMemberAccess: jest.fn().mockResolvedValue({
          userId: 'bot-user-1',
          isAdmin: false,
          isOwner: false,
          permissions: [],
        }),
      },
      { resolveDeleteMessageBotRoute: jest.fn().mockResolvedValue(confirmedRoute) },
    );

    const result = await service.executeLeasedIntent('intent-1', 'lease-1');

    expect(result).toMatchObject({ kind: 'confirmed', confirmed: true, botId: 'bot-2' });
    expect(deleteMessage).toHaveBeenNthCalledWith(
      1,
      'chat-1',
      'message-1',
      expect.objectContaining({ botId: 'bot-1' }),
    );
    expect(deleteMessage).toHaveBeenNthCalledWith(
      2,
      'chat-1',
      'message-1',
      expect.objectContaining({ botId: 'bot-2' }),
    );
  });

  it('keeps survivor routing behind the replacement cleanup kill switch', async () => {
    const replacementIntent = {
      ...baseIntent,
      routingPolicy: 'origin_first',
      replacementCleanup: true,
    };
    const waitingIntent = {
      ...replacementIntent,
      status: 'WAITING_CAPABILITY',
      leaseToken: null,
      leaseExpiresAt: null,
    };
    const queryRaw = jest
      .fn()
      .mockResolvedValueOnce([replacementIntent])
      .mockResolvedValueOnce([waitingIntent]);
    const deleteMessage = jest.fn().mockRejectedValue({
      response: { status: 403, data: { code: 'access.denied', message: 'Access denied' } },
    });
    const { service } = createService(
      {
        MODERATION_DELETE_INTENT_MODE: 'on',
        MODERATION_DELETE_INTENT_REPLACEMENT_CLEANUP_ENABLED: false,
      },
      { $queryRaw: queryRaw, $executeRaw: jest.fn().mockResolvedValue(1) },
      {
        deleteMessage,
        getCurrentChatMemberAccess: jest.fn().mockResolvedValue({
          userId: 'bot-user-1',
          isAdmin: false,
          isOwner: false,
          permissions: [],
        }),
      },
      { resolveDeleteMessageBotRoute: jest.fn().mockResolvedValue(confirmedRoute) },
    );

    const result = await service.executeLeasedIntent('intent-1', 'lease-1');

    expect(result).toMatchObject({ kind: 'waiting_capability', confirmed: false });
    expect(deleteMessage).toHaveBeenCalledTimes(1);
    expect(deleteMessage).toHaveBeenCalledWith(
      'chat-1',
      'message-1',
      expect.objectContaining({ botId: 'bot-1' }),
    );
  });

  it('bounds the replacement survivor bypass to user-authored chats and cross-bot policies', () => {
    const { service } = createService({ MODERATION_DELETE_INTENT_MODE: 'off' });
    const exactInput = {
      chatId: 'chat-outside-canary',
      messageId: 'message-1',
      reasonKey: 'chat_auto_comment_admin_message_replacement_cleanup',
      ruleCode: 'CHAT_AUTO_COMMENT_ADMIN_MESSAGE_REPLACEMENT_CLEANUP',
      entityType: 'CHAT' as const,
      messageAuthorKind: 'user' as const,
      originBotId: 'bot-1',
      routingPolicy: 'origin_first' as const,
    };

    expect((service as unknown as ServiceInternals).normalizeInput(exactInput).routingPolicy).toBe(
      'origin_first',
    );
    expect(
      (service as unknown as ServiceInternals).normalizeInput({
        ...exactInput,
        routingPolicy: 'delete_capable',
      }).routingPolicy,
    ).toBe('delete_capable');
    expect(
      service.resolveEffectiveRoutingPolicy({
        ...exactInput,
        routingPolicy: 'delete_capable',
        replacementCleanup: true,
      }),
    ).toBe('delete_capable');
    expect(
      service.resolveEffectiveRoutingPolicy({
        ...exactInput,
        entityType: 'CHANNEL',
        replacementCleanup: true,
      }),
    ).toBe('origin_only');
    expect(
      service.resolveEffectiveRoutingPolicy({
        ...exactInput,
        messageAuthorKind: 'bot',
        replacementCleanup: true,
      }),
    ).toBe('origin_only');
    expect(
      service.resolveEffectiveRoutingPolicy({
        ...exactInput,
        routingPolicy: 'origin_only',
        replacementCleanup: true,
      }),
    ).toBe('origin_only');
    expect(
      service.resolveEffectiveRoutingPolicy({
        ...exactInput,
        replacementCleanup: false,
      }),
    ).toBe('origin_only');
  });

  it('marks absence only after an exact lookup with fresh delete capability', async () => {
    const queryRaw = jest
      .fn()
      .mockResolvedValueOnce([{ ...baseIntent }])
      .mockResolvedValueOnce([
        {
          ...baseIntent,
          status: 'ALREADY_ABSENT',
          lastBotId: 'bot-1',
          leaseToken: null,
          leaseExpiresAt: null,
        },
      ]);
    const deleteMessage = jest.fn().mockRejectedValue({
      response: {
        status: 200,
        data: { success: false, code: 'message.not.found', message: 'Message not found' },
      },
    });
    const getExactMessagePresence = jest.fn().mockResolvedValue('absent');
    const { service } = createService(
      {},
      { $queryRaw: queryRaw, $executeRaw: jest.fn().mockResolvedValue(1) },
      {
        deleteMessage,
        getExactMessagePresence,
        getCurrentChatMemberAccess: jest.fn().mockResolvedValue({
          userId: 'bot-user-1',
          isAdmin: true,
          isOwner: false,
          permissions: ['read_all_messages', 'write'],
        }),
      },
      { resolveDeleteMessageBotRoute: jest.fn().mockResolvedValue(confirmedRoute) },
    );

    const result = await service.executeLeasedIntent('intent-1', 'lease-1');

    expect(result).toMatchObject({ kind: 'already_absent', confirmed: true });
    expect(getExactMessagePresence).toHaveBeenCalledWith(
      'chat-1',
      'message-1',
      expect.objectContaining({ botId: 'bot-1', bypassCache: true }),
    );
  });

  it('rejects a stale worker lease without making an outbound delete', async () => {
    const queryRaw = jest.fn().mockResolvedValueOnce([
      {
        ...baseIntent,
        leaseToken: 'newer-lease',
      },
    ]);
    const deleteMessage = jest.fn();
    const { service } = createService({}, { $queryRaw: queryRaw }, { deleteMessage });

    const result = await service.executeLeasedIntent('intent-1', 'stale-lease');

    expect(result).toMatchObject({ kind: 'pending', confirmed: false });
    expect(deleteMessage).not.toHaveBeenCalled();
  });

  it('does not dispatch after its matching lease has expired', async () => {
    const queryRaw = jest.fn().mockResolvedValueOnce([
      {
        ...baseIntent,
        leaseExpiresAt: new Date(Date.now() - 1),
      },
    ]);
    const deleteMessage = jest.fn();
    const { service } = createService({}, { $queryRaw: queryRaw }, { deleteMessage });

    const result = await service.executeLeasedIntent('intent-1', 'lease-1');

    expect(result).toMatchObject({ kind: 'pending', confirmed: false });
    expect(deleteMessage).not.toHaveBeenCalled();
  });

  it('does not accept a bare verification 404 as proof that the message is absent', async () => {
    const waiting = {
      ...baseIntent,
      status: 'WAITING_CAPABILITY',
      leaseToken: null,
      leaseExpiresAt: null,
      lastStatusCode: 404,
      lastErrorCode: 'unverified_message_not_found',
    };
    const queryRaw = jest
      .fn()
      .mockResolvedValueOnce([{ ...baseIntent }])
      .mockResolvedValueOnce([waiting]);
    const { service } = createService(
      {},
      { $queryRaw: queryRaw, $executeRaw: jest.fn().mockResolvedValue(1) },
      {
        deleteMessage: jest.fn().mockRejectedValue({ response: { status: 404, data: {} } }),
        getCurrentChatMemberAccess: jest.fn().mockResolvedValue({
          userId: 'bot-user-1',
          isAdmin: true,
          isOwner: false,
          permissions: ['read_all_messages', 'write'],
        }),
        getExactMessagePresence: jest
          .fn()
          .mockRejectedValue({ response: { status: 404, data: {} } }),
      },
      { resolveDeleteMessageBotRoute: jest.fn().mockResolvedValue(confirmedRoute) },
    );

    const result = await service.executeLeasedIntent('intent-1', 'lease-1');

    expect(result).toMatchObject({ kind: 'waiting_capability', confirmed: false });
  });

  it('tries another confirmed bot when retry presence is unknown for the first candidate', async () => {
    const retriedIntent = {
      ...baseIntent,
      attemptCount: 2,
      leasedFromStatus: 'AMBIGUOUS',
      deleteDispatchStartedAt: new Date(),
      deleteDispatchStartedBotId: 'bot-1',
    };
    const queryRaw = jest
      .fn()
      .mockResolvedValueOnce([retriedIntent])
      .mockResolvedValueOnce([
        {
          ...retriedIntent,
          status: 'SUCCEEDED',
          lastBotId: 'bot-2',
          succeededBotId: 'bot-2',
          leaseToken: null,
          leaseExpiresAt: null,
        },
      ]);
    const getExactMessagePresence = jest
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('presence timeout'), { code: 'ETIMEDOUT' }))
      .mockResolvedValueOnce('present');
    const deleteMessage = jest.fn().mockResolvedValue(undefined);
    const { service } = createService(
      { MODERATION_DELETE_CROSS_BOT_CANARY_CHAT_IDS: 'chat-1' },
      { $queryRaw: queryRaw, $executeRaw: jest.fn().mockResolvedValue(1) },
      {
        deleteMessage,
        getExactMessagePresence,
        getCurrentChatMemberAccess: jest.fn().mockResolvedValue({
          userId: 'bot-user-1',
          isAdmin: true,
          isOwner: false,
          permissions: ['read_all_messages', 'write'],
        }),
      },
      { resolveDeleteMessageBotRoute: jest.fn().mockResolvedValue(confirmedRoute) },
    );

    const result = await service.executeLeasedIntent('intent-1', 'lease-1');

    expect(result).toMatchObject({ kind: 'confirmed', confirmed: true, botId: 'bot-2' });
    expect(getExactMessagePresence).toHaveBeenNthCalledWith(
      1,
      'chat-1',
      'message-1',
      expect.objectContaining({ botId: 'bot-1' }),
    );
    expect(getExactMessagePresence).toHaveBeenNthCalledWith(
      2,
      'chat-1',
      'message-1',
      expect.objectContaining({ botId: 'bot-2' }),
    );
    expect(deleteMessage).toHaveBeenCalledTimes(1);
    expect(deleteMessage).toHaveBeenCalledWith(
      'chat-1',
      'message-1',
      expect.objectContaining({ botId: 'bot-2' }),
    );
  });

  it('does not delete on retry when exact presence is unknown for the only candidate', async () => {
    const retriedIntent = {
      ...baseIntent,
      attemptCount: 2,
      leasedFromStatus: 'AMBIGUOUS',
      deleteDispatchStartedAt: new Date(),
      deleteDispatchStartedBotId: 'bot-1',
    };
    const ambiguous = {
      ...retriedIntent,
      status: 'AMBIGUOUS',
      leaseToken: null,
      leaseExpiresAt: null,
      lastErrorCode: 'predelete_presence_unknown',
    };
    const originOnlyRoute = {
      ...confirmedRoute,
      candidateBotIds: ['bot-1'],
      candidateCapabilities: [confirmedRoute.candidateCapabilities[0]],
    };
    const queryRaw = jest
      .fn()
      .mockResolvedValueOnce([retriedIntent])
      .mockResolvedValueOnce([ambiguous]);
    const deleteMessage = jest.fn();
    const { service } = createService(
      {},
      { $queryRaw: queryRaw, $executeRaw: jest.fn().mockResolvedValue(1) },
      {
        deleteMessage,
        getExactMessagePresence: jest
          .fn()
          .mockRejectedValue(Object.assign(new Error('presence timeout'), { code: 'ETIMEDOUT' })),
        getCurrentChatMemberAccess: jest.fn().mockResolvedValue({
          userId: 'bot-user-1',
          isAdmin: true,
          isOwner: false,
          permissions: ['read_all_messages', 'write'],
        }),
      },
      { resolveDeleteMessageBotRoute: jest.fn().mockResolvedValue(originOnlyRoute) },
    );

    const result = await service.executeLeasedIntent('intent-1', 'lease-1');

    expect(result).toMatchObject({ kind: 'ambiguous', confirmed: false });
    expect(deleteMessage).not.toHaveBeenCalled();
  });

  it('finishes a retry as already absent before issuing another DELETE', async () => {
    const retriedIntent = {
      ...baseIntent,
      attemptCount: 2,
      leasedFromStatus: 'AMBIGUOUS',
      deleteDispatchStartedAt: new Date(),
      deleteDispatchStartedBotId: 'bot-1',
    };
    const queryRaw = jest
      .fn()
      .mockResolvedValueOnce([retriedIntent])
      .mockResolvedValueOnce([
        {
          ...retriedIntent,
          status: 'ALREADY_ABSENT',
          leaseToken: null,
          leaseExpiresAt: null,
        },
      ]);
    const deleteMessage = jest.fn();
    const { service } = createService(
      {},
      { $queryRaw: queryRaw, $executeRaw: jest.fn().mockResolvedValue(1) },
      { deleteMessage, getExactMessagePresence: jest.fn().mockResolvedValue('absent') },
      { resolveDeleteMessageBotRoute: jest.fn().mockResolvedValue(confirmedRoute) },
    );

    const result = await service.executeLeasedIntent('intent-1', 'lease-1');

    expect(result).toMatchObject({ kind: 'already_absent', confirmed: true });
    expect(deleteMessage).not.toHaveBeenCalled();
  });

  it('preflights a stale reclaimed PENDING lease when a durable dispatch fence exists', async () => {
    const dispatchedBeforeCrash = {
      ...baseIntent,
      attemptCount: 2,
      leasedFromStatus: 'PENDING',
      deleteDispatchStartedAt: new Date(Date.now() - 120_000),
      deleteDispatchStartedBotId: 'bot-1',
    };
    const completed = {
      ...dispatchedBeforeCrash,
      status: 'ALREADY_ABSENT',
      leaseToken: null,
      leaseExpiresAt: null,
      deleteDispatchStartedAt: null,
      deleteDispatchStartedBotId: null,
    };
    const queryRaw = jest
      .fn()
      .mockResolvedValueOnce([dispatchedBeforeCrash])
      .mockResolvedValueOnce([completed]);
    const deleteMessage = jest.fn();
    const getExactMessagePresence = jest.fn().mockResolvedValue('absent');
    const { service } = createService(
      {},
      { $queryRaw: queryRaw, $executeRaw: jest.fn().mockResolvedValue(1) },
      { deleteMessage, getExactMessagePresence },
      { resolveDeleteMessageBotRoute: jest.fn().mockResolvedValue(confirmedRoute) },
    );

    const result = await service.executeLeasedIntent('intent-1', 'lease-1');

    expect(result).toMatchObject({ kind: 'already_absent', confirmed: true });
    expect(getExactMessagePresence).toHaveBeenCalledTimes(1);
    expect(deleteMessage).not.toHaveBeenCalled();
  });

  it('keeps the dispatch preflight after an ambiguous attempt transitions through RETRYABLE', async () => {
    const transitionedIntent = {
      ...baseIntent,
      attemptCount: 3,
      leasedFromStatus: 'RETRYABLE',
      lastErrorCode: 'route_lookup_failed',
      deleteDispatchStartedAt: new Date(Date.now() - 60_000),
      deleteDispatchStartedBotId: 'bot-1',
    };
    const completed = {
      ...transitionedIntent,
      status: 'ALREADY_ABSENT',
      leaseToken: null,
      leaseExpiresAt: null,
      deleteDispatchStartedAt: null,
      deleteDispatchStartedBotId: null,
    };
    const queryRaw = jest
      .fn()
      .mockResolvedValueOnce([transitionedIntent])
      .mockResolvedValueOnce([completed]);
    const deleteMessage = jest.fn();
    const getExactMessagePresence = jest.fn().mockResolvedValue('absent');
    const { service } = createService(
      {},
      { $queryRaw: queryRaw, $executeRaw: jest.fn().mockResolvedValue(1) },
      { deleteMessage, getExactMessagePresence },
      { resolveDeleteMessageBotRoute: jest.fn().mockResolvedValue(confirmedRoute) },
    );

    await expect(service.executeLeasedIntent('intent-1', 'lease-1')).resolves.toMatchObject({
      kind: 'already_absent',
    });
    expect(getExactMessagePresence).toHaveBeenCalledTimes(1);
    expect(deleteMessage).not.toHaveBeenCalled();
  });

  it('persists the durable dispatch fence before calling MAX DELETE', async () => {
    const completed = {
      ...baseIntent,
      status: 'SUCCEEDED',
      succeededBotId: 'bot-1',
      remoteDeleteSucceededAt: new Date(),
      remoteDeleteSucceededBotId: 'bot-1',
      leaseToken: null,
      leaseExpiresAt: null,
    };
    const events: string[] = [];
    const executeRaw = jest.fn().mockImplementation(async (query: { strings?: string[] }) => {
      const sql = query.strings?.join('?') ?? '';
      if (sql.includes('"delete_dispatch_started_at" = CURRENT_TIMESTAMP')) {
        events.push('dispatch-fence');
      }
      return 1;
    });
    const deleteMessage = jest.fn().mockImplementation(async () => {
      events.push('max-delete');
    });
    const queryRaw = jest
      .fn()
      .mockResolvedValueOnce([{ ...baseIntent }])
      .mockResolvedValueOnce([completed]);
    const { service } = createService(
      {},
      { $queryRaw: queryRaw, $executeRaw: executeRaw },
      { deleteMessage },
      { resolveDeleteMessageBotRoute: jest.fn().mockResolvedValue(confirmedRoute) },
    );

    await service.executeLeasedIntent('intent-1', 'lease-1');

    expect(events).toEqual(expect.arrayContaining(['dispatch-fence', 'max-delete']));
    expect(events.indexOf('dispatch-fence')).toBeLessThan(events.indexOf('max-delete'));
  });

  it('rechecks its database lease inside MaxClient before persisting the dispatch fence', async () => {
    let leaseRenewals = 0;
    const executeRaw = jest.fn().mockImplementation(async (query: { strings?: string[] }) => {
      const sql = query.strings?.join('?') ?? '';
      if (sql.includes('SET "lease_expires_at" =')) {
        leaseRenewals += 1;
        return leaseRenewals < 3 ? 1 : 0;
      }
      return 1;
    });
    const events: string[] = [];
    const deleteMessage = jest.fn(async () => {
      events.push('max-http');
    });
    const queryRaw = jest
      .fn()
      .mockResolvedValueOnce([{ ...baseIntent }])
      .mockResolvedValueOnce([{ ...baseIntent }]);
    const { service, prisma } = createService(
      {},
      { $queryRaw: queryRaw, $executeRaw: executeRaw },
      { deleteMessage },
      { resolveDeleteMessageBotRoute: jest.fn().mockResolvedValue(confirmedRoute) },
    );

    await expect(service.executeLeasedIntent('intent-1', 'lease-1')).resolves.toMatchObject({
      confirmed: false,
    });

    expect(leaseRenewals).toBe(3);
    expect(events).toEqual([]);
    const executedSql = prisma.$executeRaw.mock.calls
      .map((call: unknown[]) => {
        const query = call[0] as { strings?: readonly string[] };
        return query.strings?.join('?') ?? '';
      })
      .join('\n');
    expect(executedSql).not.toContain('"delete_dispatch_started_at" = CURRENT_TIMESTAMP');
  });

  it('clears the dispatch fence and stays retryable when the final delete guard rejects', async () => {
    const orderingLeaseLost = new Error('photo ordering lease lost');
    const retryable = {
      ...baseIntent,
      status: 'RETRYABLE',
      nextAttemptAt: new Date(Date.now() + 1_000),
      leaseToken: null,
      leaseExpiresAt: null,
      leasedFromStatus: null,
      deleteDispatchStartedAt: null,
      deleteDispatchStartedBotId: null,
      lastErrorCode: 'delete_pre_dispatch_guard_rejected',
      lastError: orderingLeaseLost.message,
    };
    const events: string[] = [];
    const executeRaw = jest.fn().mockImplementation(async (query: { strings?: string[] }) => {
      const sql = query.strings?.join('?') ?? '';
      if (sql.includes('"delete_dispatch_started_at" = CURRENT_TIMESTAMP')) {
        events.push('dispatch-fence');
      } else if (
        sql.includes('"delete_dispatch_started_at" = NULL') &&
        sql.includes('AND "delete_dispatch_started_at" IS NOT NULL')
      ) {
        events.push('clear-fence');
      } else if (sql.includes('"status" = CAST(? AS "ModerationDeleteIntentStatus")')) {
        events.push('retryable-status');
      }
      return 1;
    });
    const beforeDeleteMutation = jest
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(orderingLeaseLost);
    const deleteMessage = jest.fn(async () => {
      events.push('max-http');
    });
    const queryRaw = jest
      .fn()
      .mockResolvedValueOnce([{ ...baseIntent }])
      .mockResolvedValueOnce([retryable]);
    const { service, prisma } = createService(
      {},
      { $queryRaw: queryRaw, $executeRaw: executeRaw },
      { deleteMessage },
      { resolveDeleteMessageBotRoute: jest.fn().mockResolvedValue(confirmedRoute) },
    );

    await expect(
      service.executeLeasedIntent('intent-1', 'lease-1', { beforeDeleteMutation }),
    ).rejects.toBe(orderingLeaseLost);

    expect(beforeDeleteMutation).toHaveBeenCalledTimes(2);
    expect(events).toEqual(['dispatch-fence', 'clear-fence', 'retryable-status']);
    const statusUpdate = prisma.$executeRaw.mock.calls
      .map(
        (call: unknown[]) =>
          call[0] as { strings?: readonly string[]; values?: readonly unknown[] },
      )
      .find((query) =>
        (query.strings?.join('?') ?? '').includes(
          '"status" = CAST(? AS "ModerationDeleteIntentStatus")',
        ),
      );
    expect(statusUpdate?.values).toContain('RETRYABLE');
    expect(statusUpdate?.values).not.toContain('AMBIGUOUS');
  });

  it('clears a definitively rejected dispatch before trying another bot', async () => {
    const completed = {
      ...baseIntent,
      status: 'SUCCEEDED',
      lastBotId: 'bot-2',
      succeededBotId: 'bot-2',
      remoteDeleteSucceededAt: new Date(),
      remoteDeleteSucceededBotId: 'bot-2',
      leaseToken: null,
      leaseExpiresAt: null,
    };
    const events: string[] = [];
    const executeRaw = jest
      .fn()
      .mockImplementation(async (query: { strings?: string[]; values?: unknown[] }) => {
        const sql = query.strings?.join('?') ?? '';
        const botId = query.values?.find((value) => value === 'bot-1' || value === 'bot-2');
        if (sql.includes('"delete_dispatch_started_at" = CURRENT_TIMESTAMP')) {
          events.push(`fence:${botId}`);
        } else if (
          sql.includes('"delete_dispatch_started_at" = NULL') &&
          sql.includes('AND "delete_dispatch_started_at" IS NOT NULL')
        ) {
          events.push(`clear:${botId}`);
        }
        return 1;
      });
    const deleteMessage = jest
      .fn()
      .mockImplementationOnce(async () => {
        events.push('delete:bot-1');
        throw { response: { status: 403, data: { code: 'access.denied' } } };
      })
      .mockImplementationOnce(async () => {
        events.push('delete:bot-2');
      });
    const queryRaw = jest
      .fn()
      .mockResolvedValueOnce([{ ...baseIntent }])
      .mockResolvedValueOnce([completed]);
    const { service } = createService(
      { MODERATION_DELETE_CROSS_BOT_CANARY_CHAT_IDS: 'chat-1' },
      { $queryRaw: queryRaw, $executeRaw: executeRaw },
      {
        deleteMessage,
        getExactMessagePresence: jest.fn(),
        getCurrentChatMemberAccess: jest.fn().mockResolvedValue({
          userId: 'bot-user-1',
          isAdmin: true,
          isOwner: false,
          permissions: ['write'],
        }),
      },
      { resolveDeleteMessageBotRoute: jest.fn().mockResolvedValue(confirmedRoute) },
    );

    await expect(service.executeLeasedIntent('intent-1', 'lease-1')).resolves.toMatchObject({
      kind: 'confirmed',
      botId: 'bot-2',
    });
    expect(events).toEqual([
      'fence:bot-1',
      'delete:bot-1',
      'clear:bot-1',
      'fence:bot-2',
      'delete:bot-2',
    ]);
  });

  it('does not run an exact presence preflight when the previous attempt never dispatched DELETE', async () => {
    const retriedIntent = {
      ...baseIntent,
      attemptCount: 2,
      leasedFromStatus: 'RETRYABLE',
      lastErrorCode: 'route_lookup_failed',
    };
    const succeeded = {
      ...retriedIntent,
      status: 'SUCCEEDED',
      lastBotId: 'bot-1',
      succeededBotId: 'bot-1',
      remoteDeleteSucceededAt: new Date(),
      remoteDeleteSucceededBotId: 'bot-1',
      leaseToken: null,
      leaseExpiresAt: null,
      leasedFromStatus: null,
    };
    const queryRaw = jest
      .fn()
      .mockResolvedValueOnce([retriedIntent])
      .mockResolvedValueOnce([succeeded]);
    const deleteMessage = jest.fn().mockResolvedValue(undefined);
    const getExactMessagePresence = jest.fn();
    const { service } = createService(
      {},
      { $queryRaw: queryRaw, $executeRaw: jest.fn().mockResolvedValue(1) },
      { deleteMessage, getExactMessagePresence },
      { resolveDeleteMessageBotRoute: jest.fn().mockResolvedValue(confirmedRoute) },
    );

    const result = await service.executeLeasedIntent('intent-1', 'lease-1');

    expect(result).toMatchObject({ kind: 'confirmed', confirmed: true, botId: 'bot-1' });
    expect(getExactMessagePresence).not.toHaveBeenCalled();
    expect(deleteMessage).toHaveBeenCalledTimes(1);
  });

  it('recovers a missing origin membership from a live probe before origin-only deletion', async () => {
    const emptyRoute = {
      ...confirmedRoute,
      primaryBotId: null,
      botId: null,
      candidateBotIds: [],
      candidateCapabilities: [],
      capabilityState: 'stale_or_unknown',
      capabilityReason: 'no_active_membership',
    };
    const originRoute = {
      ...confirmedRoute,
      candidateBotIds: ['bot-1'],
      candidateCapabilities: [confirmedRoute.candidateCapabilities[0]],
    };
    const succeeded = {
      ...baseIntent,
      status: 'SUCCEEDED',
      lastBotId: 'bot-1',
      succeededBotId: 'bot-1',
      remoteDeleteSucceededAt: new Date(),
      remoteDeleteSucceededBotId: 'bot-1',
      leaseToken: null,
      leaseExpiresAt: null,
      leasedFromStatus: null,
    };
    const queryRaw = jest
      .fn()
      .mockResolvedValueOnce([{ ...baseIntent }])
      .mockResolvedValueOnce([succeeded]);
    const resolveDeleteMessageBotRoute = jest
      .fn()
      .mockResolvedValueOnce(emptyRoute)
      .mockResolvedValue(originRoute);
    const recordBotAccessProbe = jest.fn().mockResolvedValue(true);
    const getCurrentChatMemberAccess = jest.fn().mockResolvedValue({
      userId: 'bot-user-1',
      isAdmin: true,
      isOwner: false,
      permissions: ['read_all_messages', 'write'],
    });
    const deleteMessage = jest.fn().mockResolvedValue(undefined);
    const { service } = createService(
      {},
      { $queryRaw: queryRaw, $executeRaw: jest.fn().mockResolvedValue(1) },
      { deleteMessage, getCurrentChatMemberAccess },
      { resolveDeleteMessageBotRoute, recordBotAccessProbe },
    );

    const result = await service.executeLeasedIntent('intent-1', 'lease-1');

    expect(result).toMatchObject({ kind: 'confirmed', confirmed: true, botId: 'bot-1' });
    expect(getCurrentChatMemberAccess).toHaveBeenCalledWith(
      'chat-1',
      expect.objectContaining({ botId: 'bot-1', bypassCache: true }),
    );
    expect(recordBotAccessProbe).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: 'chat-1',
        botId: 'bot-1',
        allowMembershipRecovery: true,
      }),
    );
    expect(deleteMessage).toHaveBeenCalledWith(
      'chat-1',
      'message-1',
      expect.objectContaining({ botId: 'bot-1' }),
    );
  });

  it('keeps a remote success marker retryable past the horizon and never deletes twice', async () => {
    const expiredHorizonIntent = {
      ...baseIntent,
      retryUntilAt: new Date(Date.now() - 1_000),
    };
    const markedAt = new Date();
    const ambiguousWithMarker = {
      ...expiredHorizonIntent,
      status: 'AMBIGUOUS',
      nextAttemptAt: new Date(Date.now() + 60_000),
      remoteDeleteSucceededAt: markedAt,
      remoteDeleteSucceededBotId: 'bot-1',
      leaseToken: null,
      leaseExpiresAt: null,
      lastErrorCode: 'remote_success_finalize_failed',
    };
    const leasedMarker = {
      ...ambiguousWithMarker,
      status: 'IN_PROGRESS',
      attemptCount: 2,
      leaseToken: 'lease-2',
      leaseExpiresAt: new Date(Date.now() + 60_000),
    };
    const succeeded = {
      ...leasedMarker,
      status: 'SUCCEEDED',
      succeededBotId: 'bot-1',
      leaseToken: null,
      leaseExpiresAt: null,
      lastErrorCode: null,
    };
    const queryRaw = jest
      .fn()
      .mockResolvedValueOnce([expiredHorizonIntent])
      .mockResolvedValueOnce([ambiguousWithMarker])
      .mockResolvedValueOnce([leasedMarker])
      .mockResolvedValueOnce([succeeded]);
    const transaction = jest
      .fn()
      .mockRejectedValueOnce(new Error('finalization transaction failed'))
      .mockImplementationOnce(
        async (callback: (tx: { $executeRaw: jest.Mock }) => Promise<unknown>) =>
          callback({ $executeRaw: jest.fn().mockResolvedValue(1) }),
      );
    const deleteMessage = jest.fn().mockResolvedValue(undefined);
    const { service } = createService(
      {},
      {
        $queryRaw: queryRaw,
        $executeRaw: jest.fn().mockResolvedValue(1),
        $transaction: transaction,
      },
      { deleteMessage },
      { resolveDeleteMessageBotRoute: jest.fn().mockResolvedValue(confirmedRoute) },
    );

    const first = await service.executeLeasedIntent('intent-1', 'lease-1');
    const second = await service.executeLeasedIntent('intent-1', 'lease-2');

    expect(first).toMatchObject({ kind: 'ambiguous', status: 'AMBIGUOUS' });
    expect(second).toMatchObject({ kind: 'confirmed', status: 'SUCCEEDED', botId: 'bot-1' });
    expect(deleteMessage).toHaveBeenCalledTimes(1);
  });

  it('keeps a timed-out delete dispatch reclaimable past the retry horizon', async () => {
    const horizonIntent = {
      ...baseIntent,
      retryUntilAt: new Date(Date.now() + 100),
    };
    const ambiguous = {
      ...horizonIntent,
      status: 'AMBIGUOUS',
      deleteDispatchStartedAt: new Date(),
      deleteDispatchStartedBotId: 'bot-1',
      leaseToken: null,
      leaseExpiresAt: null,
    };
    const queryRaw = jest
      .fn()
      .mockResolvedValueOnce([horizonIntent])
      .mockResolvedValueOnce([ambiguous]);
    const deleteMessage = jest
      .fn()
      .mockRejectedValue(Object.assign(new Error('delete timeout'), { code: 'ETIMEDOUT' }));
    const { service } = createService(
      { MODERATION_DELETE_INTENT_RETRY_BASE_MS: 1_000 },
      { $queryRaw: queryRaw, $executeRaw: jest.fn().mockResolvedValue(1) },
      { deleteMessage },
      { resolveDeleteMessageBotRoute: jest.fn().mockResolvedValue(confirmedRoute) },
    );

    await expect(service.executeLeasedIntent('intent-1', 'lease-1')).resolves.toMatchObject({
      kind: 'ambiguous',
      status: 'AMBIGUOUS',
    });
  });

  it('clears the dispatch fence and terminates an explicitly rejected DELETE', async () => {
    const terminal = {
      ...baseIntent,
      status: 'FAILED_TERMINAL',
      deleteDispatchStartedAt: null,
      deleteDispatchStartedBotId: null,
      leaseToken: null,
      leaseExpiresAt: null,
      lastStatusCode: 422,
    };
    const queryRaw = jest
      .fn()
      .mockResolvedValueOnce([{ ...baseIntent }])
      .mockResolvedValueOnce([terminal]);
    const executeRaw = jest.fn().mockResolvedValue(1);
    const deleteMessage = jest.fn().mockRejectedValue({
      response: { status: 422, data: { code: 'invalid.request' } },
    });
    const { service } = createService(
      {},
      { $queryRaw: queryRaw, $executeRaw: executeRaw },
      { deleteMessage },
      { resolveDeleteMessageBotRoute: jest.fn().mockResolvedValue(confirmedRoute) },
    );

    await expect(service.executeLeasedIntent('intent-1', 'lease-1')).resolves.toMatchObject({
      kind: 'terminal',
      status: 'FAILED_TERMINAL',
    });
    const sqlCalls = executeRaw.mock.calls.map((call) => call[0]?.strings?.join('?') ?? '');
    const clearIndex = sqlCalls.findIndex(
      (sql) =>
        sql.includes('"delete_dispatch_started_at" = NULL') &&
        sql.includes('AND "delete_dispatch_started_at" IS NOT NULL'),
    );
    const terminalIndex = sqlCalls.findIndex((sql) => sql.includes('CAST(? AS'));
    expect(clearIndex).toBeGreaterThanOrEqual(0);
    expect(terminalIndex).toBeGreaterThan(clearIndex);
  });

  it('atomically records remote success as ambiguous when the first marker write fails', async () => {
    const markedAt = new Date();
    const fallbackState = {
      ...baseIntent,
      status: 'AMBIGUOUS',
      remoteDeleteSucceededAt: markedAt,
      remoteDeleteSucceededBotId: 'bot-1',
      leaseToken: null,
      leaseExpiresAt: null,
      lastErrorCode: 'remote_success_marker_persist_failed',
    };
    const queryRaw = jest
      .fn()
      .mockResolvedValueOnce([{ ...baseIntent }])
      .mockResolvedValueOnce([fallbackState]);
    const executeRaw = jest.fn().mockImplementation(async (query: { strings?: string[] }) => {
      const sql = query.strings?.join('?') ?? '';
      if (
        sql.includes('"remote_delete_succeeded_at" = COALESCE') &&
        !sql.includes("CAST('AMBIGUOUS' AS")
      ) {
        throw new Error('marker write failed');
      }
      return 1;
    });
    const deleteMessage = jest.fn().mockResolvedValue(undefined);
    const { service } = createService(
      {},
      { $queryRaw: queryRaw, $executeRaw: executeRaw },
      { deleteMessage },
      { resolveDeleteMessageBotRoute: jest.fn().mockResolvedValue(confirmedRoute) },
    );

    const result = await service.executeLeasedIntent('intent-1', 'lease-1');

    expect(result).toMatchObject({ kind: 'ambiguous', status: 'AMBIGUOUS' });
    expect(deleteMessage).toHaveBeenCalledTimes(1);
    const fallbackSql = executeRaw.mock.calls
      .map((call) => call[0]?.strings?.join('?') ?? '')
      .find(
        (sql) => sql.includes("CAST('AMBIGUOUS' AS") && sql.includes('remote_delete_succeeded_at'),
      );
    expect(fallbackSql).toBeDefined();
  });

  it('renews a short lease during a slow capability probe and dispatches once', async () => {
    const deniedRoute = {
      ...confirmedRoute,
      botId: null,
      candidateBotIds: [],
      capabilityState: 'stale_or_unknown',
      capabilityReason: 'snapshot_missing',
      candidateCapabilities: [
        {
          ...confirmedRoute.candidateCapabilities[0],
          state: 'stale_or_unknown',
          reason: 'snapshot_missing',
          routeEligible: false,
        },
      ],
    } as const;
    const restoredRoute = {
      ...confirmedRoute,
      candidateBotIds: ['bot-1'],
      candidateCapabilities: [confirmedRoute.candidateCapabilities[0]],
    } as const;
    const queryRaw = jest
      .fn()
      .mockResolvedValueOnce([{ ...baseIntent }])
      .mockResolvedValueOnce([
        {
          ...baseIntent,
          status: 'SUCCEEDED',
          succeededBotId: 'bot-1',
          leaseToken: null,
          leaseExpiresAt: null,
        },
      ]);
    const executeRaw = jest.fn().mockResolvedValue(1);
    const deleteMessage = jest.fn().mockResolvedValue(undefined);
    const getCurrentChatMemberAccess = jest.fn().mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(
            () =>
              resolve({
                userId: 'bot-user-1',
                isAdmin: true,
                isOwner: false,
                permissions: ['read_all_messages', 'write'],
              }),
            85,
          ),
        ),
    );
    const { service } = createService(
      { MODERATION_DELETE_INTENT_LEASE_MS: 90 },
      { $queryRaw: queryRaw, $executeRaw: executeRaw },
      { deleteMessage, getCurrentChatMemberAccess },
      {
        resolveDeleteMessageBotRoute: jest
          .fn()
          .mockResolvedValueOnce(deniedRoute)
          .mockResolvedValueOnce(restoredRoute),
      },
    );

    const result = await service.executeLeasedIntent('intent-1', 'lease-1');

    expect(result).toMatchObject({ kind: 'confirmed', status: 'SUCCEEDED' });
    expect(deleteMessage).toHaveBeenCalledTimes(1);
    const renewals = executeRaw.mock.calls.filter((call) =>
      (call[0]?.strings?.join('?') ?? '').includes('SET "lease_expires_at" ='),
    );
    expect(renewals.length).toBeGreaterThanOrEqual(3);
  });

  it('releases the lease when candidate failure persistence throws unexpectedly', async () => {
    const ambiguous = {
      ...baseIntent,
      status: 'AMBIGUOUS',
      leaseToken: null,
      leaseExpiresAt: null,
      lastErrorCode: 'delete_intent_execution_failed',
    };
    const queryRaw = jest
      .fn()
      .mockResolvedValueOnce([{ ...baseIntent }])
      .mockResolvedValueOnce([ambiguous]);
    const executeRaw = jest.fn().mockImplementation(async (query: { strings?: string[] }) => {
      const sql = query.strings?.join('?') ?? '';
      if (sql.includes('"candidate_failures" =')) {
        throw new Error('candidate failure write failed');
      }
      return 1;
    });
    const deleteMessage = jest.fn().mockRejectedValue({
      response: { status: 403, data: { code: 'access.denied' } },
    });
    const { service } = createService(
      {},
      { $queryRaw: queryRaw, $executeRaw: executeRaw },
      {
        deleteMessage,
        getCurrentChatMemberAccess: jest.fn().mockResolvedValue({
          userId: 'bot-user-1',
          isAdmin: true,
          isOwner: false,
          permissions: ['read_all_messages', 'write'],
        }),
      },
      { resolveDeleteMessageBotRoute: jest.fn().mockResolvedValue(confirmedRoute) },
    );

    const result = await service.executeLeasedIntent('intent-1', 'lease-1');

    expect(result).toMatchObject({ kind: 'ambiguous', status: 'AMBIGUOUS' });
    expect(deleteMessage).toHaveBeenCalledTimes(1);
    const recoveryQuery = executeRaw.mock.calls.at(-1)?.[0];
    const recoverySql = recoveryQuery?.strings?.join('?') ?? '';
    expect(recoverySql).toContain('"lease_token" = NULL');
    expect(recoveryQuery?.values).toContain('delete_intent_execution_failed');
  });

  it('uses one stable BullMQ job id per intent', async () => {
    const { service, queue } = createService();

    await (service as unknown as ServiceInternals).enqueueWakeup({
      ...baseIntent,
      status: 'PENDING',
    });
    await (service as unknown as ServiceInternals).enqueueWakeup({
      ...baseIntent,
      status: 'PENDING',
    });

    expect(queue.add).toHaveBeenCalledTimes(2);
    expect(queue.add.mock.calls[0]?.[2]?.jobId).toBe('mdi-intent-1');
    expect(queue.add.mock.calls[1]?.[2]?.jobId).toBe('mdi-intent-1');
  });

  it('leaves DB state unleased when the DB-to-Redis handoff fails', async () => {
    const queryRaw = jest.fn().mockResolvedValueOnce([{ id: 'intent-1' }]);
    const executeRaw = jest.fn().mockResolvedValue(1);
    const { service, queue } = createService({}, { $queryRaw: queryRaw, $executeRaw: executeRaw });
    queue.add.mockRejectedValueOnce(new Error('redis unavailable'));

    await expect(service.sweepDueIntents()).resolves.toBe(1);

    const selectionSql = queryRaw.mock.calls[0]?.[0]?.strings?.join('?') ?? '';
    expect(selectionSql).toContain('SELECT candidates."id"');
    expect(selectionSql).not.toContain('UPDATE "moderation_delete_intents" intent');
    expect(selectionSql).toContain('intent."remote_delete_succeeded_at" IS NOT NULL');

    const expirySql = executeRaw.mock.calls[0]?.[0]?.strings?.join('?') ?? '';
    expect(expirySql).toContain('intent."remote_delete_succeeded_at" IS NOT NULL');
    expect(expirySql).toContain('intent."remote_delete_succeeded_bot_id" IS NOT NULL');
    expect(expirySql).toContain('intent."delete_dispatch_started_at" IS NOT NULL');
    expect(expirySql).toContain('intent."delete_dispatch_started_bot_id" IS NOT NULL');
  });

  it('uses SKIP LOCKED to select a bounded unleased DB recovery batch', async () => {
    const queryRaw = jest.fn().mockResolvedValue([]);
    const { service } = createService({}, { $queryRaw: queryRaw });

    await (service as unknown as ServiceInternals).selectDueIntentIds();

    const query = queryRaw.mock.calls[0]?.[0];
    const sql = query?.strings?.join('?') ?? String(query);
    expect(sql).toContain('FOR UPDATE SKIP LOCKED');
    expect(sql).toContain('LIMIT');
    expect(sql).not.toContain('UPDATE "moderation_delete_intents" intent');
    expect(sql).toContain('intent."remote_delete_succeeded_at" IS NOT NULL');
    expect(sql).toContain('intent."remote_delete_succeeded_bot_id" IS NOT NULL');
    expect(sql).toContain('intent."delete_dispatch_started_at" IS NOT NULL');
    expect(sql).toContain('intent."delete_dispatch_started_bot_id" IS NOT NULL');
    expect(query?.values).toEqual(
      expect.arrayContaining([
        'CHANNEL_AUTO_POST_FORWARD_REPLACEMENT_CLEANUP',
        'CHAT_AUTO_COMMENT_ADMIN_MESSAGE_REPLACEMENT_CLEANUP',
        'CHAT_RULES_REPUBLISH_PREVIOUS_MESSAGE_CLEANUP',
      ]),
    );
  });

  it('allows a recorded remote success to be claimed after the retry horizon', async () => {
    const queryRaw = jest.fn().mockResolvedValue([]);
    const { service } = createService({}, { $queryRaw: queryRaw });

    await (service as unknown as ServiceInternals).claimOne('intent-1');

    const sql = queryRaw.mock.calls[0]?.[0]?.strings?.join('?') ?? '';
    expect(sql).toContain('"retry_until_at" >');
    expect(sql).toContain('"remote_delete_succeeded_at" IS NOT NULL');
    expect(sql).toContain('"remote_delete_succeeded_bot_id" IS NOT NULL');
    expect(sql).toContain('"delete_dispatch_started_at" IS NOT NULL');
    expect(sql).toContain('"delete_dispatch_started_bot_id" IS NOT NULL');
  });

  it('links a replacement marker in the intent transaction before enqueueing execution', async () => {
    const persisted = {
      ...baseIntent,
      status: 'PENDING',
      leaseToken: null,
      leaseExpiresAt: null,
    };
    const txExecuteRaw = jest.fn().mockResolvedValue(1);
    const transaction = jest.fn(
      async (callback: (tx: { $queryRaw: jest.Mock; $executeRaw: jest.Mock }) => unknown) =>
        callback({
          $queryRaw: jest.fn().mockResolvedValue([persisted]),
          $executeRaw: txExecuteRaw,
        }),
    );
    const { service, queue } = createService(
      {
        MODERATION_DELETE_INTENT_MODE: 'canary',
        MODERATION_DELETE_INTENT_CANARY_CHAT_IDS: 'other-chat',
      },
      { $transaction: transaction },
    );

    await expect(
      service.ensureIntent({
        chatId: 'chat-1',
        messageId: 'message-1',
        reasonKey: 'chat_auto_comment_admin_message_replacement_cleanup',
        ruleCode: 'CHAT_AUTO_COMMENT_ADMIN_MESSAGE_REPLACEMENT_CLEANUP',
        entityType: 'CHAT',
        messageAuthorKind: 'user',
        originBotId: 'bot-1',
        routingPolicy: 'origin_first',
      }),
    ).resolves.toMatchObject({ rollout: 'execute', status: 'PENDING' });

    const linkCall = txExecuteRaw.mock.calls.find((call) =>
      (call[0]?.strings?.join('?') ?? '').includes('UPDATE "chat_auto_comment_attach_markers"'),
    );
    expect(linkCall).toBeDefined();
    expect(linkCall?.[0]?.strings?.join('?') ?? '').toContain('"cleanup_intent_id" =');
    expect(linkCall?.[0]?.values).toEqual(
      expect.arrayContaining(['intent-1', 'chat-1', 'message-1']),
    );
    expect(txExecuteRaw.mock.invocationCallOrder.at(-1)).toBeLessThan(
      queue.add.mock.invocationCallOrder[0]!,
    );
  });

  it('upgrades legacy replacement reason and routing before linking and waking', async () => {
    const persisted = {
      ...baseIntent,
      routingPolicy: 'origin_first',
      status: 'PENDING',
      leaseToken: null,
      leaseExpiresAt: null,
    };
    const txExecuteRaw = jest.fn().mockResolvedValue(1);
    const txQueryRaw = jest.fn().mockResolvedValue([persisted]);
    const transaction = jest.fn(
      async (callback: (tx: { $queryRaw: jest.Mock; $executeRaw: jest.Mock }) => unknown) =>
        callback({
          $queryRaw: txQueryRaw,
          $executeRaw: txExecuteRaw,
        }),
    );
    const { service, queue } = createService(
      {
        MODERATION_DELETE_INTENT_MODE: 'shadow',
      },
      { $transaction: transaction },
    );

    await expect(
      service.ensureIntent({
        chatId: 'chat-1',
        messageId: 'message-1',
        reasonKey: 'chat_auto_comment_admin_message_replacement_cleanup',
        ruleCode: 'CHAT_AUTO_COMMENT_ADMIN_MESSAGE_REPLACEMENT_CLEANUP',
        entityType: 'CHAT',
        messageAuthorKind: 'user',
        originBotId: 'bot-1',
        routingPolicy: 'origin_first',
      }),
    ).resolves.toMatchObject({ rollout: 'execute', status: 'PENDING' });

    const reasonCall = txExecuteRaw.mock.calls.find((call) =>
      (call[0]?.strings?.join('?') ?? '').includes(
        'INSERT INTO "moderation_delete_intent_reasons"',
      ),
    );
    const linkCall = txExecuteRaw.mock.calls.find((call) =>
      (call[0]?.strings?.join('?') ?? '').includes('UPDATE "chat_auto_comment_attach_markers"'),
    );
    expect(reasonCall).toBeDefined();
    expect(reasonCall?.[0]?.strings?.join('?') ?? '').toContain(
      'ON CONFLICT ("intent_id", "reason_key") DO UPDATE SET',
    );
    expect(reasonCall?.[0]?.strings?.join('?') ?? '').toContain(
      '"rule_code" = EXCLUDED."rule_code"',
    );
    expect(reasonCall?.[0]?.values).toEqual(
      expect.arrayContaining([
        'CHANNEL_AUTO_POST_FORWARD_REPLACEMENT_CLEANUP',
        'CHAT_AUTO_COMMENT_ADMIN_MESSAGE_REPLACEMENT_CLEANUP',
        'CHAT_RULES_REPUBLISH_PREVIOUS_MESSAGE_CLEANUP',
      ]),
    );
    const upsertSql = txQueryRaw.mock.calls[0]?.[0]?.strings?.join('?') ?? '';
    expect(upsertSql).toContain('EXCLUDED."routing_policy" = \'delete_capable\'');
    expect(upsertSql).toContain('"moderation_delete_intents"."routing_policy" = \'origin_only\'');
    expect(txQueryRaw.mock.calls[0]?.[0]?.values).toContain(true);
    expect(txExecuteRaw.mock.calls.indexOf(reasonCall!)).toBeLessThan(
      txExecuteRaw.mock.calls.indexOf(linkCall!),
    );
    expect(txExecuteRaw.mock.invocationCallOrder.at(-1)).toBeLessThan(
      queue.add.mock.invocationCallOrder[0]!,
    );
  });

  it('promotes OBSERVED only when a new ensure arrives in execute rollout', async () => {
    const queryRaw = jest.fn().mockResolvedValue([
      {
        ...baseIntent,
        status: 'PENDING',
        routingPolicy: 'delete_capable',
        originBotId: 'bot-2',
        leaseToken: null,
        leaseExpiresAt: null,
      },
    ]);
    const transaction = jest.fn(
      async (callback: (tx: { $queryRaw: typeof queryRaw; $executeRaw: jest.Mock }) => unknown) =>
        callback({ $queryRaw: queryRaw, $executeRaw: jest.fn().mockResolvedValue(1) }),
    );
    const { service } = createService(
      { MODERATION_DELETE_CROSS_BOT_CANARY_CHAT_IDS: 'chat-1' },
      { $transaction: transaction },
    );

    await expect(
      service.ensureIntent({
        chatId: 'chat-1',
        messageId: 'message-1',
        reasonKey: 'DUPLICATE',
        entityType: 'CHAT',
        messageAuthorKind: 'user',
        originBotId: 'bot-2',
        routingPolicy: 'delete_capable',
      }),
    ).resolves.toMatchObject({ rollout: 'execute', status: 'PENDING' });

    const sql = queryRaw.mock.calls[0]?.[0]?.strings?.join('?') ?? '';
    expect(sql).toContain('ON CONFLICT');
    expect(sql).toContain("CAST('OBSERVED' AS");
    expect(sql).toContain('EXCLUDED."status"');
    expect(sql).toContain('"routing_policy" = CASE');
    expect(sql).toContain('EXCLUDED."routing_policy"');
    expect(sql).toContain('EXCLUDED."origin_bot_id"');
    expect(sql).toContain('EXCLUDED."entity_type"');
  });

  it('does not promote a historical OBSERVED bot-message auto-delete on replay', async () => {
    const observed = {
      ...baseIntent,
      status: 'OBSERVED',
      messageAuthorKind: 'bot',
      routingPolicy: 'origin_only',
      leaseToken: null,
      leaseExpiresAt: null,
    };
    const queryRaw = jest.fn().mockResolvedValue([observed]);
    const transaction = jest.fn(
      async (callback: (tx: { $queryRaw: typeof queryRaw; $executeRaw: jest.Mock }) => unknown) =>
        callback({ $queryRaw: queryRaw, $executeRaw: jest.fn().mockResolvedValue(1) }),
    );
    const { service, queue } = createService(
      {
        MODERATION_DELETE_INTENT_MODE: 'canary',
        MODERATION_DELETE_INTENT_CANARY_CHAT_IDS: 'other-chat',
      },
      { $transaction: transaction },
    );

    await expect(
      service.ensureIntent({
        chatId: 'chat-1',
        messageId: 'message-1',
        reasonKey: 'bot-message-auto-delete:message-1',
        ruleCode: 'BOT_MESSAGE_AUTO_DELETE',
        entityType: 'CHAT',
        messageAuthorKind: 'bot',
        originBotId: 'bot-1',
        routingPolicy: 'origin_only',
      }),
    ).resolves.toEqual({ intentId: 'intent-1', rollout: 'observed', status: 'OBSERVED' });

    const upsertSql = queryRaw.mock.calls[0]?.[0]?.strings?.join('?') ?? '';
    expect(upsertSql).toContain('WHEN FALSE');
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('does not reopen an expired intent for a generic repeated ensure', async () => {
    const expired = {
      ...baseIntent,
      status: 'EXPIRED',
      completedAt: new Date(),
      leaseToken: null,
      leaseExpiresAt: null,
    };
    const queryRaw = jest.fn().mockResolvedValue([expired]);
    const transaction = jest.fn(
      async (callback: (tx: { $queryRaw: jest.Mock; $executeRaw: jest.Mock }) => unknown) =>
        callback({ $queryRaw: queryRaw, $executeRaw: jest.fn().mockResolvedValue(1) }),
    );
    const { service, queue } = createService({}, { $transaction: transaction });

    await expect(
      service.ensureIntent({
        chatId: 'chat-1',
        messageId: 'message-1',
        reasonKey: 'DUPLICATE',
        entityType: 'CHAT',
        messageAuthorKind: 'user',
        originBotId: 'bot-1',
      }),
    ).resolves.toMatchObject({ status: 'EXPIRED' });

    expect(queryRaw).toHaveBeenCalledTimes(1);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('reopens an expired replacement cleanup exactly when its recovery reason is first inserted', async () => {
    const expired = {
      ...baseIntent,
      status: 'EXPIRED',
      completedAt: new Date(),
      leaseToken: null,
      leaseExpiresAt: null,
    };
    const reopened = {
      ...expired,
      status: 'PENDING',
      completedAt: null,
      nextAttemptAt: new Date(Date.now() - 1_000),
      retryUntilAt: new Date(Date.now() + 60_000),
    };
    const queryRaw = jest.fn().mockResolvedValueOnce([expired]).mockResolvedValueOnce([reopened]);
    const transaction = jest.fn(
      async (callback: (tx: { $queryRaw: jest.Mock; $executeRaw: jest.Mock }) => unknown) =>
        callback({ $queryRaw: queryRaw, $executeRaw: jest.fn().mockResolvedValue(1) }),
    );
    const { service, queue } = createService({}, { $transaction: transaction });

    await expect(
      service.ensureIntent({
        chatId: 'chat-1',
        messageId: 'message-1',
        reasonKey: 'replacement-cleanup-recovery:channel_auto_post:marker-1',
        ruleCode: 'CHANNEL_AUTO_POST_FORWARD_REPLACEMENT_CLEANUP',
        entityType: 'CHANNEL',
        messageAuthorKind: 'user',
        originBotId: 'bot-1',
      }),
    ).resolves.toMatchObject({ status: 'PENDING' });

    expect(queryRaw).toHaveBeenCalledTimes(2);
    expect(queue.add).toHaveBeenCalledWith(
      'execute-moderation-delete-intent',
      { intentId: 'intent-1' },
      expect.objectContaining({ priority: 1 }),
    );
  });

  it('does not repeatedly reopen replacement cleanup when the recovery reason already exists', async () => {
    const expired = {
      ...baseIntent,
      status: 'EXPIRED',
      completedAt: new Date(),
      leaseToken: null,
      leaseExpiresAt: null,
    };
    const queryRaw = jest.fn().mockResolvedValue([expired]);
    const transaction = jest.fn(
      async (callback: (tx: { $queryRaw: jest.Mock; $executeRaw: jest.Mock }) => unknown) =>
        callback({ $queryRaw: queryRaw, $executeRaw: jest.fn().mockResolvedValue(0) }),
    );
    const { service, queue } = createService({}, { $transaction: transaction });

    await expect(
      service.ensureIntent({
        chatId: 'chat-1',
        messageId: 'message-1',
        reasonKey: 'replacement-cleanup-recovery:channel_auto_post:marker-1',
        ruleCode: 'CHANNEL_AUTO_POST_FORWARD_REPLACEMENT_CLEANUP',
        entityType: 'CHANNEL',
        messageAuthorKind: 'user',
        originBotId: 'bot-1',
      }),
    ).resolves.toMatchObject({ status: 'EXPIRED' });

    expect(queryRaw).toHaveBeenCalledTimes(1);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('reopens a managed-output auto-delete block when a later lawful cleanup reason arrives', async () => {
    const blocked = {
      ...baseIntent,
      status: 'FAILED_TERMINAL',
      lastErrorCode: 'managed_output_auto_delete_blocked',
      lastError: 'Managed bot output is protected',
      leaseToken: null,
      leaseExpiresAt: null,
    };
    const reopened = {
      ...blocked,
      status: 'PENDING',
      lastErrorCode: null,
      lastError: null,
      nextAttemptAt: new Date(Date.now() - 1_000),
      retryUntilAt: new Date(Date.now() + 60_000),
    };
    const queryRaw = jest.fn().mockResolvedValueOnce([blocked]).mockResolvedValueOnce([reopened]);
    const executeRaw = jest.fn().mockResolvedValue(1);
    const transaction = jest.fn(
      async (callback: (tx: { $queryRaw: jest.Mock; $executeRaw: jest.Mock }) => unknown) =>
        callback({ $queryRaw: queryRaw, $executeRaw: executeRaw }),
    );
    const { service, queue } = createService({}, { $transaction: transaction });

    await expect(
      service.ensureIntent({
        chatId: 'chat-1',
        messageId: 'message-1',
        reasonKey: 'chat-rules-republish:message-1',
        ruleCode: 'CHAT_RULES_REPUBLISH_PREVIOUS_MESSAGE_CLEANUP',
        entityType: 'CHAT',
        messageAuthorKind: 'bot',
        originBotId: 'bot-1',
      }),
    ).resolves.toMatchObject({ status: 'PENDING' });

    expect(queryRaw).toHaveBeenCalledTimes(2);
    const reopenSql = queryRaw.mock.calls[1]?.[0]?.strings?.join('?') ?? '';
    expect(reopenSql).toContain("last_error_code\" = 'managed_output_auto_delete_blocked'");
    expect(reopenSql).toContain('CAST(\'PENDING\' AS "ModerationDeleteIntentStatus")');
    expect(queue.add).toHaveBeenCalledWith(
      'execute-moderation-delete-intent',
      { intentId: 'intent-1' },
      expect.objectContaining({ priority: 1 }),
    );
  });

  it('manually reopens a terminal intent with its dispatch fence and audit preserved', async () => {
    const dispatchStartedAt = new Date(Date.now() - 30_000);
    const expired = {
      ...baseIntent,
      status: 'EXPIRED',
      completedAt: new Date(),
      leaseToken: null,
      leaseExpiresAt: null,
      deleteDispatchStartedAt: dispatchStartedAt,
      deleteDispatchStartedBotId: 'bot-1',
    };
    const reopened = {
      ...expired,
      status: 'AMBIGUOUS',
      completedAt: null,
      nextAttemptAt: new Date(Date.now() - 1_000),
      retryUntilAt: new Date(Date.now() + 60_000),
    };
    const rootQueryRaw = jest.fn().mockResolvedValueOnce([expired]);
    const txQueryRaw = jest.fn().mockResolvedValueOnce([reopened]);
    const auditCreate = jest.fn().mockResolvedValue({ id: 'audit-1' });
    const transaction = jest.fn(
      async (
        callback: (tx: { $queryRaw: jest.Mock; auditLog: { create: jest.Mock } }) => unknown,
      ) => callback({ $queryRaw: txQueryRaw, auditLog: { create: auditCreate } }),
    );
    const { service, queue } = createService(
      {},
      { $queryRaw: rootQueryRaw, $transaction: transaction },
    );
    const changePriority = jest.fn().mockResolvedValue(undefined);
    queue.add.mockResolvedValueOnce({ opts: { priority: 10 }, changePriority });

    const expectedUpdatedAt = new Date('2026-07-16T12:00:00.000Z');
    const result = await service.retryTerminalIntent(
      'intent-1',
      'EXPIRED',
      { updatedAt: expectedUpdatedAt, attemptCount: 1 },
      { actorUserId: 'owner' },
    );

    expect(result).toMatchObject({
      reopened: true,
      intent: {
        status: 'AMBIGUOUS',
        deleteDispatchStartedAt: dispatchStartedAt,
        deleteDispatchStartedBotId: 'bot-1',
        attemptCount: 1,
      },
    });
    expect(auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'SAFETY_DESK_REOPEN_DELETE_INTENT',
        actorUserId: 'owner',
      }),
    });
    expect(txQueryRaw.mock.calls[0]?.[0]?.values).toEqual(
      expect.arrayContaining([expectedUpdatedAt, 1]),
    );
    expect(queue.add).toHaveBeenCalledWith(
      'execute-moderation-delete-intent',
      { intentId: 'intent-1' },
      expect.objectContaining({ priority: 1 }),
    );
    expect(changePriority).toHaveBeenCalledWith({ priority: 1 });
  });

  it('materializes a late reason attached to an already succeeded intent', async () => {
    const persisted = {
      ...baseIntent,
      status: 'SUCCEEDED',
      succeededBotId: 'bot-1',
      remoteDeleteSucceededAt: new Date(),
      remoteDeleteSucceededBotId: 'bot-1',
      leaseToken: null,
      leaseExpiresAt: null,
      leasedFromStatus: null,
    };
    const executeRaw = jest.fn().mockResolvedValue(1);
    const transaction = jest.fn(
      async (callback: (tx: { $queryRaw: jest.Mock; $executeRaw: jest.Mock }) => unknown) =>
        callback({
          $queryRaw: jest.fn().mockResolvedValue([persisted]),
          $executeRaw: executeRaw,
        }),
    );
    const { service, queue } = createService({}, { $transaction: transaction });

    await expect(
      service.ensureIntent({
        chatId: 'chat-1',
        messageId: 'message-1',
        reasonKey: 'LATE_REASON',
        ruleCode: 'LATE_REASON_DELETE',
        subjectUserId: 'user-1',
        entityType: 'CHAT',
        messageAuthorKind: 'user',
        originBotId: 'bot-1',
        event: { userId: 'user-1', eventType: 'MESSAGE' },
      }),
    ).resolves.toMatchObject({ status: 'SUCCEEDED' });

    const executedSql = executeRaw.mock.calls
      .map((call) => call[0]?.strings?.join('?') ?? '')
      .join('\n');
    expect(executedSql).toContain('INSERT INTO "moderation_events"');
    expect(executedSql).toContain('UPDATE "moderation_delete_intent_reasons"');
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('keeps a persisted intent durable when BullMQ enqueue is temporarily unavailable', async () => {
    const persisted = {
      ...baseIntent,
      status: 'PENDING',
      leaseToken: null,
      leaseExpiresAt: null,
    };
    const transaction = jest.fn(
      async (callback: (tx: { $queryRaw: jest.Mock; $executeRaw: jest.Mock }) => unknown) =>
        callback({
          $queryRaw: jest.fn().mockResolvedValue([persisted]),
          $executeRaw: jest.fn().mockResolvedValue(1),
        }),
    );
    const { service, queue } = createService({}, { $transaction: transaction });
    queue.add.mockRejectedValueOnce(new Error('redis unavailable'));

    await expect(
      service.ensureIntent({
        chatId: 'chat-1',
        messageId: 'message-1',
        reasonKey: 'DUPLICATE',
        entityType: 'CHAT',
        messageAuthorKind: 'user',
        originBotId: 'bot-1',
      }),
    ).resolves.toMatchObject({ intentId: 'intent-1', rollout: 'execute', status: 'PENDING' });
  });

  it('quarantines stale replacement send fences in shadow mode without creating delete intents', async () => {
    const channelUpdateMany = jest.fn().mockResolvedValue({ count: 2 });
    const chatUpdateMany = jest
      .fn()
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 });
    const { service } = createService(
      { MODERATION_DELETE_INTENT_MODE: 'shadow' },
      {
        channelAutoPostAttachMarker: { updateMany: channelUpdateMany },
        chatAutoCommentAttachMarker: { updateMany: chatUpdateMany },
      },
    );
    const ensureIntent = jest.spyOn(service, 'ensureIntent');

    await expect(service.quarantineStaleReplacementSendFences()).resolves.toBe(4);

    expect(ensureIntent).not.toHaveBeenCalled();
    expect(channelUpdateMany).toHaveBeenCalledWith({
      where: {
        status: 'IN_PROGRESS',
        replacementSendStartedAt: { lte: expect.any(Date) },
        replacementMessageId: null,
      },
      data: expect.objectContaining({
        status: 'SKIPPED',
        lockToken: null,
        lockedAt: null,
        lastError: expect.stringContaining('[max.send_ambiguous]'),
      }),
    });
    expect(chatUpdateMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: expect.objectContaining({
          status: 'IN_PROGRESS',
          deliveryMode: 'reply_message',
          replyMessageId: { not: null },
        }),
        data: expect.objectContaining({ status: 'SUCCEEDED' }),
      }),
    );
    expect(chatUpdateMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: expect.objectContaining({
          status: 'IN_PROGRESS',
          replacementMessageId: null,
        }),
      }),
    );
  });

  it('promotes, links, and wakes observed replacement cleanup outside the global canary', async () => {
    const candidate = {
      sourceId: 'marker-1',
      source: 'chat_auto_comment',
      chatId: 'chat-1',
      messageId: 'message-1',
      originBotId: 'bot-1',
      entityType: 'CHAT',
      messageAuthorKind: 'user',
      routingPolicy: 'origin_first',
      existingIntentId: 'intent-observed-1',
      existingIntentStatus: 'OBSERVED',
      createdAt: new Date(),
    } as const;
    const { service, prisma } = createService(
      {
        MODERATION_DELETE_INTENT_MODE: 'canary',
        MODERATION_DELETE_INTENT_CANARY_CHAT_IDS: 'other-chat',
      },
      { $queryRaw: jest.fn().mockResolvedValue([candidate]) },
    );
    const persistIntent = jest.fn().mockResolvedValue({
      intentId: 'intent-recovered-1',
      rollout: 'execute',
      status: 'PENDING',
    });
    (service as unknown as { persistIntent: typeof persistIntent }).persistIntent = persistIntent;
    const enqueueCurrentWakeup = jest.fn().mockResolvedValue(undefined);
    (service as unknown as ServiceInternals).enqueueCurrentWakeup = enqueueCurrentWakeup;

    await expect(service.recoverReplacementCleanupSources()).resolves.toBe(1);

    expect(persistIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: 'chat-1',
        messageId: 'message-1',
        originBotId: 'bot-1',
        routingPolicy: 'origin_first',
        ruleCode: 'CHAT_AUTO_COMMENT_ADMIN_MESSAGE_REPLACEMENT_CLEANUP',
      }),
      false,
    );
    const sql = prisma.$queryRaw.mock.calls[0]?.[0]?.strings?.join('?') ?? '';
    expect(sql).toContain('channel_auto_post_attach_markers');
    expect(sql).toContain('chat_auto_comment_attach_markers');
    expect(sql).toContain('rules."pending_cleanup_message_id"');
    expect(sql).toContain('PUBLISH_CHAT_RULES');
    expect(sql).toContain('marker."bot_id" IS NOT NULL');
    expect(sql).toContain('previousPublishedBotId');
    expect(sql).not.toContain('marker."chat_id" IN');
    expect(sql).toContain('CAST(\'OBSERVED\' AS "ModerationDeleteIntentStatus")');
    expect(enqueueCurrentWakeup).toHaveBeenCalledWith('intent-recovered-1');
  });

  it('returns replacement recovery to the base rollout when the kill switch is disabled', async () => {
    const candidate = {
      sourceId: 'marker-1',
      source: 'chat_auto_comment',
      chatId: 'chat-1',
      messageId: 'message-1',
      originBotId: 'bot-1',
      entityType: 'CHAT',
      messageAuthorKind: 'user',
      routingPolicy: 'origin_first',
      existingIntentId: 'intent-observed-1',
      existingIntentStatus: 'OBSERVED',
      createdAt: new Date(),
    } as const;
    const queryRaw = jest.fn().mockResolvedValue([candidate]);
    const { service } = createService(
      {
        MODERATION_DELETE_INTENT_MODE: 'canary',
        MODERATION_DELETE_INTENT_CANARY_CHAT_IDS: 'other-chat',
        MODERATION_DELETE_INTENT_REPLACEMENT_CLEANUP_ENABLED: false,
      },
      { $queryRaw: queryRaw },
    );
    const persistIntent = jest.fn();
    (service as unknown as { persistIntent: typeof persistIntent }).persistIntent = persistIntent;

    await expect(service.recoverReplacementCleanupSources()).resolves.toBe(0);

    expect(persistIntent).not.toHaveBeenCalled();
    expect(queryRaw.mock.calls[0]?.[0]?.strings?.join('?') ?? '').toContain('marker."chat_id" IN');
  });

  it('adopts persisted chat rules cleanup state after a publish crash', async () => {
    const candidate = {
      sourceId: 'rules-state-1',
      source: 'chat_rules_state',
      chatId: 'chat-1',
      messageId: 'previous-rules-message-1',
      originBotId: 'bot-1',
      entityType: 'CHAT',
      messageAuthorKind: 'bot',
      routingPolicy: 'origin_only',
      existingIntentId: null,
      existingIntentStatus: null,
      createdAt: new Date(),
    } as const;
    const executeRaw = jest.fn().mockResolvedValue(1);
    const { service } = createService(
      {},
      { $queryRaw: jest.fn().mockResolvedValue([candidate]), $executeRaw: executeRaw },
    );
    const persistIntent = jest.fn().mockResolvedValue({
      intentId: 'intent-rules-cleanup-1',
      rollout: 'execute',
      status: 'PENDING',
    });
    (service as unknown as { persistIntent: typeof persistIntent }).persistIntent = persistIntent;
    const enqueueCurrentWakeup = jest.fn().mockResolvedValue(undefined);
    (service as unknown as ServiceInternals).enqueueCurrentWakeup = enqueueCurrentWakeup;

    await expect(service.recoverReplacementCleanupSources()).resolves.toBe(1);

    const stateSql = executeRaw.mock.calls[0]?.[0]?.strings?.join('?') ?? '';
    expect(stateSql).toContain('UPDATE "chat_rules"');
    expect(stateSql).toContain('"pending_cleanup_intent_id" =');
    expect(executeRaw.mock.calls[0]?.[0]?.values).toEqual(
      expect.arrayContaining(['intent-rules-cleanup-1', 'rules-state-1']),
    );
    expect(enqueueCurrentWakeup).toHaveBeenCalledWith('intent-rules-cleanup-1');
  });

  it('finalizes an in-progress marker when its existing intent already succeeded', async () => {
    const candidate = {
      sourceId: 'marker-success-1',
      source: 'channel_auto_post',
      chatId: 'channel-1',
      messageId: 'message-1',
      originBotId: null,
      entityType: 'CHANNEL',
      messageAuthorKind: 'user',
      routingPolicy: 'origin_only',
      existingIntentId: 'intent-success-1',
      existingIntentStatus: 'SUCCEEDED',
      createdAt: new Date(),
    } as const;
    const executeRaw = jest.fn().mockResolvedValue(1);
    const { service } = createService(
      {},
      { $queryRaw: jest.fn().mockResolvedValue([candidate]), $executeRaw: executeRaw },
    );
    const ensureIntent = jest.spyOn(service, 'ensureIntent');

    await expect(service.recoverReplacementCleanupSources()).resolves.toBe(1);

    expect(ensureIntent).not.toHaveBeenCalled();
    const syncSql = executeRaw.mock.calls[0]?.[0]?.strings?.join('?') ?? '';
    expect(syncSql).toContain('"status" = CAST(\'SUCCEEDED\' AS "ChannelAutoPostAttachStatus")');
    expect(syncSql).toContain('"lock_token" = NULL');
    expect(syncSql).toContain('"cleanup_intent_id" =');
    expect(syncSql).toContain('"replacement_message_id" IS NOT NULL');
  });

  it('finalizes a rules audit when its already-absent intent has no origin bot', async () => {
    const candidate = {
      sourceId: 'audit-absent-1',
      source: 'chat_rules_republish',
      chatId: 'chat-1',
      messageId: 'previous-rules-message-1',
      originBotId: null,
      entityType: 'CHAT',
      messageAuthorKind: 'bot',
      routingPolicy: 'origin_only',
      existingIntentId: 'intent-absent-1',
      existingIntentStatus: 'ALREADY_ABSENT',
      createdAt: new Date(),
    } as const;
    const executeRaw = jest.fn().mockResolvedValue(1);
    const { service } = createService(
      {},
      { $queryRaw: jest.fn().mockResolvedValue([candidate]), $executeRaw: executeRaw },
    );
    const ensureIntent = jest.spyOn(service, 'ensureIntent');

    await expect(service.recoverReplacementCleanupSources()).resolves.toBe(1);

    expect(ensureIntent).not.toHaveBeenCalled();
    const syncQuery = executeRaw.mock.calls[0]?.[0];
    const syncSql = syncQuery?.strings?.join('?') ?? '';
    expect(syncSql).toContain('UPDATE "audit_logs"');
    expect(syncSql).toContain("'{previousCleanupOutcome}'");
    expect(syncSql).toContain('\'"confirmed"\'::jsonb');
    expect(syncQuery?.values).toEqual(
      expect.arrayContaining(['intent-absent-1', 'chat-1', 'previous-rules-message-1']),
    );
  });

  it('filters null-origin candidates without an intent before LIMIT and never creates one', async () => {
    const candidate = {
      sourceId: 'marker-without-origin-1',
      source: 'chat_auto_comment',
      chatId: 'chat-1',
      messageId: 'message-1',
      originBotId: null,
      entityType: 'CHAT',
      messageAuthorKind: 'user',
      routingPolicy: 'origin_first',
      existingIntentId: null,
      existingIntentStatus: null,
      createdAt: new Date(),
    } as const;
    const queryRaw = jest.fn().mockResolvedValue([candidate]);
    const { service } = createService({}, { $queryRaw: queryRaw });
    const ensureIntent = jest.spyOn(service, 'ensureIntent');

    await expect(service.recoverReplacementCleanupSources()).resolves.toBe(0);

    expect(ensureIntent).not.toHaveBeenCalled();
    const sql = queryRaw.mock.calls[0]?.[0]?.strings?.join('?') ?? '';
    const markerEligibility = sql.lastIndexOf('marker."bot_id" IS NOT NULL');
    const auditEligibility = sql.indexOf(
      ') IS NOT NULL\n              OR intent."status" IN',
      sql.indexOf('FROM "audit_logs"'),
    );
    const limit = sql.lastIndexOf('LIMIT');
    expect(sql.match(/marker\."bot_id" IS NOT NULL/g)).toHaveLength(2);
    expect(markerEligibility).toBeGreaterThanOrEqual(0);
    expect(auditEligibility).toBeGreaterThanOrEqual(0);
    expect(markerEligibility).toBeLessThan(limit);
    expect(auditEligibility).toBeLessThan(limit);
    expect(sql).toContain('CAST(\'SUCCEEDED\' AS "ModerationDeleteIntentStatus")');
    expect(sql).toContain('CAST(\'ALREADY_ABSENT\' AS "ModerationDeleteIntentStatus")');
  });

  it('adds the exact cleanup reason before adopting and waking an existing pending intent', async () => {
    const candidate = {
      sourceId: 'marker-pending-1',
      source: 'chat_auto_comment',
      chatId: 'chat-1',
      messageId: 'message-1',
      originBotId: 'bot-1',
      entityType: 'CHAT',
      messageAuthorKind: 'user',
      routingPolicy: 'origin_first',
      existingIntentId: 'intent-pending-1',
      existingIntentStatus: 'PENDING',
      createdAt: new Date(),
    } as const;
    const executeRaw = jest.fn().mockResolvedValue(1);
    const { service } = createService(
      {},
      { $queryRaw: jest.fn().mockResolvedValue([candidate]), $executeRaw: executeRaw },
    );
    const persistIntent = jest.fn().mockResolvedValue({
      intentId: 'intent-pending-1',
      rollout: 'execute',
      status: 'PENDING',
    });
    (service as unknown as { persistIntent: typeof persistIntent }).persistIntent = persistIntent;
    const enqueueCurrentWakeup = jest.fn().mockResolvedValue(undefined);
    (service as unknown as ServiceInternals).enqueueCurrentWakeup = enqueueCurrentWakeup;

    await expect(service.recoverReplacementCleanupSources()).resolves.toBe(1);

    expect(persistIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        reasonKey: 'replacement-cleanup-recovery:chat_auto_comment:marker-pending-1',
        ruleCode: 'CHAT_AUTO_COMMENT_ADMIN_MESSAGE_REPLACEMENT_CLEANUP',
      }),
      false,
    );
    const adoptSql = executeRaw.mock.calls[0]?.[0]?.strings?.join('?') ?? '';
    expect(adoptSql).toContain('"status" = CAST(\'SUCCEEDED\' AS "ChatAutoCommentAttachStatus")');
    expect(adoptSql).toContain('"lock_token" = NULL');
    expect(executeRaw.mock.calls[0]?.[0]?.values).toContain('intent-pending-1');
    expect(enqueueCurrentWakeup).toHaveBeenCalledWith('intent-pending-1');
  });

  it('bounds replacement recovery independently and gates expired retries by stable reasons', async () => {
    const queryRaw = jest.fn().mockResolvedValue([]);
    const { service } = createService({}, { $queryRaw: queryRaw });

    await expect(service.recoverReplacementCleanupSources()).resolves.toBe(0);

    const query = queryRaw.mock.calls[0]?.[0];
    const sql = query?.strings?.join('?') ?? '';
    expect(query?.values).toContain(10);
    expect(sql).toContain('replacement-cleanup-recovery:channel_auto_post:');
    expect(sql).toContain('replacement-cleanup-recovery:chat_auto_comment:');
    expect(sql).toContain('replacement-cleanup-recovery:chat_rules_state:');
    expect(sql).toContain('replacement-cleanup-recovery:chat_rules_republish:');
    expect(sql).toContain('NOT EXISTS');
  });

  it('does not purge intents still owned by unresolved replacement cleanup sources', async () => {
    const executeRaw = jest.fn().mockResolvedValue(0);
    const { service } = createService({}, { $executeRaw: executeRaw });

    await expect(service.purgeRetainedIntents()).resolves.toBe(0);

    const sql = executeRaw.mock.calls[0]?.[0]?.strings?.join('?') ?? '';
    expect(sql).toContain('FROM "channel_auto_post_attach_markers" marker');
    expect(sql).toContain('FROM "chat_auto_comment_attach_markers" marker');
    expect(sql).toContain('FROM "chat_rules" rules');
    expect(sql).toContain('marker."original_deleted" = false');
    expect(sql).toContain('rules."pending_cleanup_message_id" = intent."message_id"');
  });

  it('keeps the default hourly retention budget bounded above observed daily intake', async () => {
    const executeRaw = jest.fn().mockResolvedValue(100);
    const { service } = createService({}, { $executeRaw: executeRaw });

    const hourlyPurged = await service.purgeRetainedIntents();

    expect(hourlyPurged).toBe(4_000);
    expect(hourlyPurged * 24).toBeGreaterThan(58_000);
    expect(executeRaw).toHaveBeenCalledTimes(40);
    for (const [query] of executeRaw.mock.calls) {
      expect(query?.values).toContain(100);
    }
  });
});
