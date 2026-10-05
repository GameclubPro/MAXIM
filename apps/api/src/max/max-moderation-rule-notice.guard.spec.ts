import { ConfigService } from '@nestjs/config';
import { of } from 'rxjs';
import { UnrecoverableError } from 'bullmq';
import { fingerprintModerationSettings } from '../moderation/moderation-settings-fingerprint';
import { MaxBotContextService } from './max-bot-context.service';
import { MaxClientService, type MaxActionJob } from './max-client.service';
import { MaxModerationRuleNoticeGuardService } from './max-moderation-rule-notice.guard';
import { wasMaxPreDispatchGuardRejected } from './max-action-pre-dispatch-guard';
import { wasMaxMessageSendAttempted } from './max-mutation-outcome.util';
import { CommercialDeleteGuardService } from '../moderation/commercial/commercial-delete-guard.service';
import { buildCommercialTextDeleteBinding } from '../moderation/commercial/commercial-delete-binding';
import { createCommercialNoticeDispatchOptions } from '../moderation/moderation-execution-guard-callbacks';

jest.mock('ioredis', () => jest.fn().mockImplementation(() => ({ quit: jest.fn() })));

function fixture() {
  const sourceAt = new Date(Date.now() - 10_000);
  const settings = {
    maxMessageLengthEnabled: true,
    maxMessageLength: 10,
    messageLimitsWarnEnabled: true,
    nightModeTimezone: 'UTC',
    chat: { entityType: 'CHAT', admins: [] as unknown[] },
  };
  const proof = {
    version: 1,
    chatId: '-123',
    messageId: 'source-message',
    userId: 'user-1',
    reasonKey: 'length',
    ruleCode: 'MESSAGE_TOO_LONG_DELETE',
    policySha256: fingerprintModerationSettings(settings, 'MESSAGE_TOO_LONG'),
    deadlineAtMs: sourceAt.getTime() + 300_000,
  };
  const intent = {
    id: 'delete-intent',
    status: 'SUCCEEDED',
    subjectUserId: proof.userId,
    sourceMessageAt: sourceAt,
  };
  const reason = {
    ruleCode: proof.ruleCode,
    userId: proof.userId,
    metadata: { moderationDeleteVerified: true },
  };
  const prisma = {
    chatSettings: { findUnique: jest.fn(async () => settings) },
    moderationDeleteIntent: {
      findUnique: jest.fn(async ({ where }: any) =>
        where.chatId_messageId.chatId === '-123' &&
        where.chatId_messageId.messageId === 'source-message'
          ? intent
          : null,
      ),
    },
    moderationDeleteIntentReason: {
      findUnique: jest.fn(async ({ where }: any) =>
        where.intentId_reasonKey.intentId === intent.id &&
        where.intentId_reasonKey.reasonKey === 'length'
          ? reason
          : null,
      ),
    },
  };
  const registry = { isKnownBotUserId: jest.fn(() => false) };
  const immunity = { consumeForMessage: jest.fn(async () => 'not_granted') };
  const guard = new MaxModerationRuleNoticeGuardService(
    prisma as never,
    registry as never,
    immunity as never,
    new ConfigService(),
  );
  const action = {
    actionType: 'SEND_MESSAGE',
    chatId: proof.chatId,
    botId: 'peer-2',
    text: 'Synthetic warning',
    idempotencyKey: 'ordinary-notice',
    createdAt: new Date().toISOString(),
    attempt: 1,
    ledgerContext: { moderationRuleNotice: proof },
  } as MaxActionJob;
  const memberAccess = jest.fn(async () => ({ userId: 'user-1', isAdmin: false, isOwner: false }));
  return {
    proof,
    action,
    settings,
    intent,
    reason,
    prisma,
    registry,
    immunity,
    guard,
    memberAccess,
  };
}

describe('durable ordinary moderation notice authority', () => {
  it('checks the selected bot and this reason through two unique indexed probes', async () => {
    const s = fixture();
    await s.guard.assertAllowed(s.action, 'peer-2', s.memberAccess);
    expect(s.memberAccess).toHaveBeenCalledWith({
      chatId: '-123',
      userId: 'user-1',
      botId: 'peer-2',
      timeoutMs: 5_000,
    });
    expect(s.prisma.moderationDeleteIntent.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { chatId_messageId: { chatId: '-123', messageId: 'source-message' } },
      }),
    );
    expect(s.prisma.moderationDeleteIntentReason.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { intentId_reasonKey: { intentId: 'delete-intent', reasonKey: 'length' } },
      }),
    );
  });

  it.each([
    'null',
    'version',
    'chat',
    'message',
    'user',
    'reason',
    'rule',
    'deadline',
    'policy',
    'receipt',
    'admin',
    'bot',
    'immunity',
  ])('rejects altered or stale %s without inheriting an independent deletion', async (change) => {
    const s = fixture();
    const bound = s.action.ledgerContext!.moderationRuleNotice as Record<string, unknown>;
    if (change === 'null') s.action.ledgerContext!.moderationRuleNotice = null;
    if (change === 'version') bound.version = 2;
    if (change === 'chat') bound.chatId = '-other';
    if (change === 'message') bound.messageId = 'other-source';
    if (change === 'user') {
      bound.userId = 'other-user';
      s.memberAccess.mockResolvedValue({ userId: 'other-user', isAdmin: false, isOwner: false });
    }
    if (change === 'reason') bound.reasonKey = 'independent';
    if (change === 'rule') bound.ruleCode = 'PHONE_NUMBER_BLOCKED_DELETE';
    if (change === 'deadline') bound.deadlineAtMs = s.proof.deadlineAtMs + 60_000;
    if (change === 'policy') s.settings.messageLimitsWarnEnabled = false;
    if (change === 'receipt') s.reason.metadata.moderationDeleteVerified = false;
    if (change === 'admin')
      s.memberAccess.mockResolvedValue({ userId: 'user-1', isAdmin: true, isOwner: false });
    if (change === 'bot') s.registry.isKnownBotUserId.mockReturnValue(true);
    if (change === 'immunity') s.immunity.consumeForMessage.mockResolvedValue('granted');
    await expect(s.guard.assertAllowed(s.action, 'peer-2', s.memberAccess)).rejects.toMatchObject({
      code: 'moderation_rule_notice_no_longer_authorized',
    });
  });

  it('lets legacy unbound jobs use their existing path', async () => {
    const s = fixture();
    const unbound = { ...s.action, ledgerContext: undefined };
    await expect(s.guard.assertAllowed(unbound, 'peer-2', s.memberAccess)).resolves.toBeUndefined();
    expect(s.memberAccess).not.toHaveBeenCalled();
    expect(s.prisma.chatSettings.findUnique).not.toHaveBeenCalled();
  });

  it('preserves transient access failures for a durable retry', async () => {
    const s = fixture();
    const error = new Error('Synthetic access timeout');
    s.memberAccess.mockRejectedValue(error);
    await expect(s.guard.assertAllowed(s.action, 'peer-2', s.memberAccess)).rejects.toBe(error);
  });

  it('keeps final policy and deadline checks after route revalidation', async () => {
    const s = fixture();
    const revalidateRoute = jest.fn(async () => {
      s.settings.messageLimitsWarnEnabled = false;
    });
    await expect(
      s.guard.assertAllowed(s.action, 'peer-2', s.memberAccess, revalidateRoute),
    ).rejects.toMatchObject({ code: 'moderation_rule_notice_no_longer_authorized' });
    expect(revalidateRoute).toHaveBeenCalledTimes(1);
    expect(s.prisma.chatSettings.findUnique).toHaveBeenCalledTimes(2);
  });
});

function clientFixture(withGuard = true, routedMode = 'shadow') {
  const s = fixture();
  const order: string[] = [];
  const config = new ConfigService({
    MAX_API_BASE_URL: 'https://max.invalid',
    REDIS_URL: 'redis://127.0.0.1:1',
    NODE_ENV: 'test',
    MAX_ACTION_DISPATCH_ENABLED: true,
    MAX_ROUTED_MUTATIONS_MODE: routedMode,
  });
  const context = new MaxBotContextService();
  const bot = { id: 'peer-2', token: 'synthetic-token', state: 'active' };
  const registry = {
    ...s.registry,
    getDefaultBot: () => bot,
    getBotById: (id: string) => (id === bot.id ? bot : null),
  };
  const http = {
    request: jest.fn(() => {
      order.push('http');
      return of({ status: 200, data: { message: { body: { mid: 'sent-warning' } } } });
    }),
  };
  let serialized: MaxActionJob | undefined;
  const queue = {
    getJob: jest.fn(async () => null),
    add: jest.fn(async (_name: string, data: MaxActionJob) => {
      serialized = JSON.parse(JSON.stringify(data));
      return undefined;
    }),
  };
  const ledger = {
    isIrreversibleAction: jest.fn(() => true),
    assertCanEnqueue: jest.fn(async () => undefined),
    recordStarted: jest.fn(async (_job: MaxActionJob) => undefined),
    recordSucceeded: jest.fn(async () => undefined),
    recordFailed: jest.fn(async () => undefined),
    recordEnqueuedIfAbsent: jest.fn(async () => undefined),
    getCompletedSendDispatchResult: jest.fn(async () => null as any),
    claimSendDispatch: jest.fn(async (_job: MaxActionJob, _botId: string) => ({
      kind: 'claimed',
      dispatchToken: 'send-token',
    })),
    completeSendDispatch: jest.fn(async () => new Date()),
    releaseSendDispatch: jest.fn(async () => undefined),
  };
  const client = new MaxClientService(
    http as never,
    config,
    { recordSuccessForLane: jest.fn(), recordFailureForLane: jest.fn() } as never,
    registry as never,
    context,
    queue as never,
    undefined,
    ledger as never,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    withGuard ? s.guard : undefined,
  );
  jest.spyOn(client as any, 'acquireCircuitPermit').mockResolvedValue({ halfOpenProbe: false });
  jest.spyOn(client as any, 'closeCircuitAfterSuccessfulProbe').mockResolvedValue(undefined);
  jest.spyOn(client as any, 'assertChatMutationExecutionProof').mockResolvedValue(null);
  const quota = jest.spyOn(client as any, 'reserveRateLimitSlot').mockImplementation(async () => {
    order.push('quota');
  });
  jest
    .spyOn(client as any, 'prepareMarketplacePublicationOptions')
    .mockImplementation(async (_chat: any, options: any) => {
      order.push('prepare');
      return options;
    });
  jest.spyOn(client, 'getChatMemberAccess').mockImplementation(async (_chat, _user, options) => {
    order.push('member');
    expect(context.getActiveBotId()).toBe('peer-2');
    expect(options).toEqual(expect.objectContaining({ botId: 'peer-2', bypassCache: true }));
    return { userId: 'user-1', isAdmin: false, isOwner: false } as never;
  });
  const authority = jest.spyOn(s.guard, 'assertAllowed');
  const enqueue = async () => {
    await client.sendMessage(s.proof.chatId, 'Synthetic warning', undefined, {
      botId: 'peer-2',
      idempotencyKey: 'ordinary-notice',
      ledgerContext: s.action.ledgerContext,
    });
    expect(queue.add).toHaveBeenCalledTimes(1);
    return serialized!;
  };
  return { ...s, client, http, ledger, quota, authority, order, enqueue };
}

describe('ordinary moderation notice queued transport', () => {
  it.each(['moderation_notice', 'unrelated_source'])(
    'rejects mixed feature permits for %s before authority reads or HTTP',
    async (sourceTag) => {
      const s = clientFixture();
      try {
        const job = await s.enqueue();
        const mixed = {
          ...job,
          sourceTag,
          ledgerContext: { ...job.ledgerContext, duplicateNotice: { version: 1 } },
        };
        const error = await s.client.executeActionJob(mixed).catch((caught: unknown) => caught);
        expect(error).toMatchObject({ code: 'moderation_notice_legacy_envelope_unverified' });
        expect(wasMaxPreDispatchGuardRejected(error)).toBe(true);
        expect(wasMaxMessageSendAttempted(error)).toBe(false);
        expect(s.authority).not.toHaveBeenCalled();
        expect(s.client.getChatMemberAccess).not.toHaveBeenCalled();
        expect(s.http.request).not.toHaveBeenCalled();
        expect(s.ledger.releaseSendDispatch).toHaveBeenCalledTimes(1);
      } finally {
        await s.client.onModuleDestroy();
      }
    },
  );

  it.each([undefined, { moderationNoticeEnvelope: { version: 2 } }])(
    'blocks an unverified legacy group moderation notice only before a new HTTP send: %o',
    async (ledgerContext) => {
      const s = clientFixture();
      try {
        const job = { ...(await s.enqueue()), sourceTag: 'moderation_notice', ledgerContext };
        await expect(s.client.executeActionJob(job)).rejects.toMatchObject({
          code: 'moderation_notice_legacy_envelope_unverified',
        });
        expect(s.authority).not.toHaveBeenCalled();
        expect(s.http.request).not.toHaveBeenCalled();
        expect(s.ledger.releaseSendDispatch).toHaveBeenCalledTimes(1);
      } finally {
        await s.client.onModuleDestroy();
      }
    },
  );

  it('allows a compatible product notice marker without inventing a moderation feature proof', async () => {
    const s = clientFixture();
    try {
      const job = {
        ...(await s.enqueue()),
        sourceTag: 'moderation_notice',
        ledgerContext: { moderationNoticeEnvelope: { version: 1 } },
      };
      await s.client.executeActionJob(job);
      expect(s.authority).not.toHaveBeenCalled();
      expect(s.memberAccess).not.toHaveBeenCalled();
      expect(s.http.request).toHaveBeenCalledTimes(1);
    } finally {
      await s.client.onModuleDestroy();
    }
  });

  it.each(['completed', 'unknown'] as const)(
    'preserves an unbound legacy %s journal before the envelope compatibility fence',
    async (state) => {
      const s = clientFixture();
      try {
        const job = {
          ...(await s.enqueue()),
          ledgerContext: undefined,
          sourceTag: 'moderation_notice',
        };
        const unknown = new UnrecoverableError('Unknown legacy SEND fixture');
        if (state === 'completed') {
          s.ledger.getCompletedSendDispatchResult.mockResolvedValue({
            remoteMessageId: 'legacy-sent',
            dispatchBotId: 'peer-2',
            completedAt: new Date(),
          });
          await expect(s.client.executeActionJob(job)).resolves.toMatchObject({
            messageId: 'legacy-sent',
          });
        } else {
          s.ledger.claimSendDispatch.mockRejectedValue(unknown);
          await expect(s.client.executeActionJob(job)).rejects.toBe(unknown);
        }
        expect(s.authority).not.toHaveBeenCalled();
        expect(s.http.request).not.toHaveBeenCalled();
        expect(s.ledger.releaseSendDispatch).not.toHaveBeenCalled();
      } finally {
        await s.client.onModuleDestroy();
      }
    },
  );

  it('serializes the proof through enqueue and checks it after preparation and quota at the selected executor', async () => {
    const s = clientFixture();
    try {
      const job = await s.enqueue();
      expect(job.ledgerContext).toEqual(s.action.ledgerContext);
      await s.client.executeActionJob(job);
      expect(s.order).toEqual(['prepare', 'quota', 'member', 'http']);
      expect(s.http.request).toHaveBeenCalledTimes(1);
    } finally {
      await s.client.onModuleDestroy();
    }
  });

  it('revokes a queued warning when policy changes during its quota wait and releases its untouched fence', async () => {
    const s = clientFixture();
    try {
      const job = await s.enqueue();
      s.quota.mockImplementation(async () => {
        s.settings.maxMessageLength = 100;
      });
      await expect(s.client.executeActionJob(job)).rejects.toMatchObject({
        code: 'moderation_rule_notice_no_longer_authorized',
      });
      expect(s.http.request).not.toHaveBeenCalled();
      expect(s.ledger.releaseSendDispatch).toHaveBeenCalledTimes(1);
    } finally {
      await s.client.onModuleDestroy();
    }
  });

  it('rejects local executor demotion during fresh author qualification without reaching HTTP', async () => {
    const s = clientFixture();
    const proof = {
      botId: 'peer-2',
      routingVersion: 2,
      accessEpoch: { checkedAt: new Date(), source: 'test' },
      changed: false,
    };
    let currentEpoch = true;
    const verify = jest.fn(async () => currentEpoch);
    Object.defineProperty(s.client, 'maxBotLinkService', {
      value: { verifyChatExecutionProof: verify },
    });
    jest.spyOn(s.client as any, 'assertChatMutationExecutionProof').mockResolvedValue(proof);
    jest.spyOn(s.client, 'getChatMemberAccess').mockImplementation(async () => {
      await Promise.resolve();
      currentEpoch = false;
      return { userId: 'user-1', isAdmin: false, isOwner: false } as never;
    });
    try {
      const job = await s.enqueue();
      const error = await s.client.executeActionJob(job).catch((caught: unknown) => caught);
      expect(error).toMatchObject({
        code: 'max_action_executor_proof_rejected',
        message: 'MAX action executor proof changed during feature qualification',
      });
      expect(wasMaxPreDispatchGuardRejected(error)).toBe(true);
      expect(wasMaxMessageSendAttempted(error)).toBe(false);
      expect(verify).toHaveBeenCalledTimes(2);
      expect(s.quota).toHaveBeenCalledTimes(1);
      expect(s.http.request).not.toHaveBeenCalled();
      expect(s.ledger.releaseSendDispatch).toHaveBeenCalledTimes(1);
    } finally {
      await s.client.onModuleDestroy();
    }
  });

  it('fails closed when the serialized proof is present but the guard provider is missing', async () => {
    const s = clientFixture(false);
    try {
      const job = await s.enqueue();
      await expect(s.client.executeActionJob(job)).rejects.toThrow(
        'Moderation rule notice guard unavailable',
      );
      expect(s.http.request).not.toHaveBeenCalled();
    } finally {
      await s.client.onModuleDestroy();
    }
  });

  it('settles a known SEND receipt before malformed or expired policy proof without sending again', async () => {
    const s = clientFixture();
    try {
      const job = await s.enqueue();
      job.ledgerContext!.moderationRuleNotice = { version: 99 };
      s.ledger.getCompletedSendDispatchResult.mockResolvedValue({
        remoteMessageId: 'saved-warning',
        dispatchBotId: 'peer-2',
        completedAt: new Date(),
      });
      await expect(s.client.executeActionJob(job)).resolves.toMatchObject({
        messageId: 'saved-warning',
        recoveredSendDispatch: { dispatchBotId: 'peer-2' },
      });
      expect(s.authority).not.toHaveBeenCalled();
      expect(s.http.request).not.toHaveBeenCalled();
    } finally {
      await s.client.onModuleDestroy();
    }
  });

  it('keeps an ambiguous SEND fenced before policy checks and never republishes it', async () => {
    const s = clientFixture();
    try {
      const job = await s.enqueue();
      job.ledgerContext!.moderationRuleNotice = null;
      const ambiguity = new UnrecoverableError('Ambiguous MAX SEND_MESSAGE fixture');
      s.ledger.claimSendDispatch.mockRejectedValue(ambiguity);
      await expect(s.client.executeActionJob(job)).rejects.toBe(ambiguity);
      expect(s.authority).not.toHaveBeenCalled();
      expect(s.http.request).not.toHaveBeenCalled();
      expect(s.ledger.releaseSendDispatch).not.toHaveBeenCalled();
    } finally {
      await s.client.onModuleDestroy();
    }
  });
});

describe('ephemeral commercial notice final transport authority', () => {
  function commercialFixture(routedMode = 'shadow') {
    const s = clientFixture(true, routedMode);
    const settings = {
      commercialAdsFilterEnabled: true,
      commercialAdsSensitivity: 'BALANCED' as const,
      commercialAdsWarnThreshold: 45,
      commercialAdsDeleteThreshold: 65,
      nightModeTimezone: 'UTC',
      textFiltersWarnEnabled: true,
      textFiltersMuteEnabled: true,
      textFiltersBanEnabled: true,
      textFiltersMuteDurationHours: 1,
      textFiltersBotMessageEnabled: true,
      chat: { entityType: 'CHAT', admins: [] },
    };
    const binding = buildCommercialTextDeleteBinding({
      text: 'Такси +7 900 000 10 42',
      settings,
      eventTimestampMs: Date.now(),
      campaignContext: null,
    });
    const commercial = new CommercialDeleteGuardService(
      { chatSettings: { findUnique: jest.fn(async () => settings) } } as never,
      s.client,
      { isKnownBotUserId: () => false } as never,
      { consumeForMessage: async () => 'not_granted' } as never,
      new ConfigService(),
      {
        authority: async () => ({
          revision: 0,
          baselineAllowed: true,
          promotedPolicyCohorts: [],
          mode: 'baseline',
        }),
      } as never,
    );
    const permit = commercial.createSanctionPermit({
      chatId: s.proof.chatId,
      messageId: s.proof.messageId,
      subjectUserId: s.proof.userId,
      botId: 'original-delete-peer',
      evidence: [
        { reasonKey: 'commercial', score: 0.8, metadata: { commercialTextBinding: binding } },
      ],
      deleted: true,
      commercialVerified: true,
    })!;
    const send = (botId = 'peer-2') =>
      s.client.sendMessage(s.proof.chatId, 'Synthetic commercial notice', undefined, {
        botId,
        candidateBotIds: ['peer-2', 'peer-3'],
        idempotencyKey: 'commercial-source:notice',
        sourceTag: 'moderation_notice',
        ledgerContext: { moderationNoticeEnvelope: { version: 1 } },
        ...createCommercialNoticeDispatchOptions((beforeFinalAuthority) =>
          commercial.authorizeSanction(permit, {
            botId: (s.client as any).botContext.getActiveBotId() ?? botId,
            beforeFinalAuthority,
          }),
        ),
      });
    return { ...s, commercial, settings, permit, send };
  }

  it('uses the original live permit at actual request with the selected executor', async () => {
    const s = commercialFixture();
    try {
      await s.send();
      expect(s.http.request).toHaveBeenCalledTimes(1);
      expect(s.order).toEqual(['prepare', 'quota', 'member', 'http']);
      expect(s.ledger.recordStarted).toHaveBeenCalledTimes(1);
      expect(s.ledger.completeSendDispatch).toHaveBeenCalledTimes(1);
    } finally {
      await s.client.onModuleDestroy();
    }
  });

  it('does not send or extend a commercial permit expired during its quota wait', async () => {
    const s = commercialFixture();
    const originalExpiry = s.permit.expiresAtMs;
    const now = jest.spyOn(Date, 'now');
    s.quota.mockImplementation(async () => {
      now.mockReturnValue(originalExpiry + 1);
    });
    try {
      const error = await s.send().catch((caught: unknown) => caught);
      expect(wasMaxPreDispatchGuardRejected(error)).toBe(true);
      expect(wasMaxMessageSendAttempted(error)).toBe(false);
      expect(s.http.request).not.toHaveBeenCalled();
      expect(s.ledger.releaseSendDispatch).toHaveBeenCalledTimes(1);
      expect(s.permit.expiresAtMs).toBe(originalExpiry);
    } finally {
      now.mockRestore();
      await s.client.onModuleDestroy();
    }
  });

  it('preserves a proven pre-dispatch demotion and permits the same live commercial identity on a backup', async () => {
    const s = commercialFixture();
    const originalExpiry = s.permit.expiresAtMs;
    (s.client as any).botRegistry.getBotById = (id: string) => ({
      id,
      token: `synthetic-${id}`,
      state: 'active',
    });
    let demoted = false;
    const verify = jest.fn(async ({ botId }: { botId: string }) => botId !== 'peer-2' || !demoted);
    Object.defineProperty(s.client, 'maxBotLinkService', {
      value: { verifyChatExecutionProof: verify },
    });
    jest
      .spyOn(s.client as any, 'assertChatMutationExecutionProof')
      .mockImplementation(async (_chatId: unknown, botId: unknown) => ({
        botId,
        routingVersion: 2,
        accessEpoch: { checkedAt: new Date(), source: 'test' },
        changed: false,
      }));
    const readMember = jest
      .spyOn(s.client, 'getChatMemberAccess')
      .mockImplementation(async (_chatId, _userId, options) => {
        if ((options as { botId?: string }).botId === 'peer-2') demoted = true;
        return { userId: 'user-1', isAdmin: false, isOwner: false } as never;
      });
    try {
      const error = await s.send().catch((caught: unknown) => caught);
      expect(error).toMatchObject({ code: 'max_action_executor_proof_rejected' });
      expect(wasMaxPreDispatchGuardRejected(error)).toBe(true);
      expect(wasMaxMessageSendAttempted(error)).toBe(false);
      expect(s.http.request).not.toHaveBeenCalled();
      expect(s.ledger.releaseSendDispatch).toHaveBeenCalledTimes(1);
      await s.send('peer-3');
      expect(s.http.request).toHaveBeenCalledTimes(1);
      expect(s.http.request).toHaveBeenCalledWith(
        expect.objectContaining({ headers: { Authorization: 'synthetic-peer-3' } }),
      );
      expect(readMember).toHaveBeenLastCalledWith(
        s.proof.chatId,
        s.proof.userId,
        expect.objectContaining({ botId: 'peer-3', bypassCache: true }),
      );
      const firstJob = s.ledger.recordStarted.mock.calls[0][0];
      const retryJob = s.ledger.recordStarted.mock.calls[1][0];
      expect(firstJob.idempotencyKey).toBe(retryJob.idempotencyKey);
      expect(s.ledger.completeSendDispatch).toHaveBeenCalledTimes(1);
      expect(s.permit.expiresAtMs).toBe(originalExpiry);
      expect(verify).toHaveBeenCalledTimes(4);
    } finally {
      await s.client.onModuleDestroy();
    }
  });

  it('automatically continues a commercial SEND on a surviving administrator with one original permit and identity', async () => {
    const s = commercialFixture('on');
    const originalExpiry = s.permit.expiresAtMs;
    (s.client as any).botRegistry.getBotById = (id: string) => ({
      id,
      token: `synthetic-${id}`,
      state: 'active',
    });
    let demoted = false;
    const resolveBotRoute = jest.fn(async () => ({
      purpose: 'send_message',
      chatId: s.proof.chatId,
      primaryBotId: 'peer-3',
      botId: 'peer-3',
      candidateBotIds: ['peer-3'],
      routingVersion: 3,
      reason: 'alternate_confirmed',
    }));
    Object.defineProperty(s.client, 'maxBotLinkService', {
      value: {
        resolveBotRoute,
        verifyChatExecutionProof: async ({ botId }: { botId: string }) =>
          botId !== 'peer-2' || !demoted,
      },
    });
    jest
      .spyOn(s.client as any, 'assertChatMutationExecutionProof')
      .mockImplementation(async (_chatId: unknown, botId: unknown) => ({
        botId,
        routingVersion: botId === 'peer-2' ? 2 : 3,
        accessEpoch: { checkedAt: new Date(), source: 'test' },
        changed: false,
      }));
    const member = jest
      .spyOn(s.client, 'getChatMemberAccess')
      .mockImplementation(async (_chatId, _userId, options) => {
        if ((options as { botId?: string }).botId === 'peer-2') demoted = true;
        return { userId: 'user-1', isAdmin: false, isOwner: false } as never;
      });
    try {
      await s.send();
      expect(s.http.request).toHaveBeenCalledTimes(1);
      expect(s.http.request).toHaveBeenCalledWith(
        expect.objectContaining({ headers: { Authorization: 'synthetic-peer-3' } }),
      );
      expect(member).toHaveBeenCalledTimes(2);
      expect(member).toHaveBeenLastCalledWith(
        s.proof.chatId,
        s.proof.userId,
        expect.objectContaining({ botId: 'peer-3', bypassCache: true }),
      );
      expect(s.ledger.recordStarted).toHaveBeenCalledTimes(1);
      expect(s.ledger.releaseSendDispatch).toHaveBeenCalledTimes(1);
      expect(s.ledger.completeSendDispatch).toHaveBeenCalledTimes(1);
      expect(s.ledger.recordSucceeded).toHaveBeenCalledWith(
        expect.objectContaining({ botId: 'peer-3', idempotencyKey: expect.any(String) }),
      );
      const firstClaim = s.ledger.claimSendDispatch.mock.calls[0][0];
      const nextClaim = s.ledger.claimSendDispatch.mock.calls[1][0];
      expect(firstClaim.idempotencyKey).toBe(nextClaim.idempotencyKey);
      expect(resolveBotRoute).toHaveBeenCalledTimes(1);
      expect(s.permit.expiresAtMs).toBe(originalExpiry);
    } finally {
      await s.client.onModuleDestroy();
    }
  });

  it.each(['policy', 'route'] as const)(
    'rejects a %s change during final commercial qualification before HTTP',
    async (change) => {
      const s = commercialFixture();
      let currentEpoch = true;
      const verify = jest.fn(async () => {
        if (verify.mock.calls.length > 1 && change === 'policy')
          s.settings.commercialAdsFilterEnabled = false;
        return currentEpoch;
      });
      Object.defineProperty(s.client, 'maxBotLinkService', {
        value: { verifyChatExecutionProof: verify },
      });
      jest.spyOn(s.client as any, 'assertChatMutationExecutionProof').mockResolvedValue({
        botId: 'peer-2',
        routingVersion: 2,
        accessEpoch: { checkedAt: new Date(), source: 'test' },
        changed: false,
      });
      jest.spyOn(s.client, 'getChatMemberAccess').mockImplementation(async () => {
        if (change === 'route') currentEpoch = false;
        return { userId: 'user-1', isAdmin: false, isOwner: false } as never;
      });
      try {
        const error = await s.send().catch((caught: unknown) => caught);
        expect(wasMaxPreDispatchGuardRejected(error)).toBe(true);
        expect(wasMaxMessageSendAttempted(error)).toBe(false);
        expect(verify).toHaveBeenCalledTimes(2);
        expect(s.quota).toHaveBeenCalledTimes(1);
        expect(s.http.request).not.toHaveBeenCalled();
        expect(s.ledger.releaseSendDispatch).toHaveBeenCalledTimes(1);
      } finally {
        await s.client.onModuleDestroy();
      }
    },
  );
});
