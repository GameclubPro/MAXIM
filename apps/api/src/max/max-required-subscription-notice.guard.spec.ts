import { ConfigService } from '@nestjs/config';
import { of } from 'rxjs';
import { UnrecoverableError } from 'bullmq';
import { fingerprintModerationSettings } from '../moderation/moderation-settings-fingerprint';
import type { RequiredSubscriptionNoticeAuthority } from '../moderation/required-subscription-notice-authority';
import { MaxBotContextService } from './max-bot-context.service';
import { MaxClientService, type MaxActionJob } from './max-client.service';
import { MaxRequiredSubscriptionNoticeGuardService } from './max-required-subscription-notice.guard';

jest.mock('ioredis', () => jest.fn().mockImplementation(() => ({ quit: jest.fn() })));

function fixture() {
  const sourceAtMs = Date.now() - 10_000;
  const settings = {
    requiredSubscriptionEnabled: true,
    requiredSubscriptionChannelIds: ['target-1', 'target-2'],
    requiredSubscriptionWarnEnabled: true,
    nightModeTimezone: 'UTC',
    chat: { entityType: 'CHAT', admins: [] as unknown[] },
  };
  const proof: RequiredSubscriptionNoticeAuthority = {
    version: 1,
    chatId: '-123',
    messageId: 'source-message',
    userId: 'user-1',
    reasonKey: 'REQUIRED_SUBSCRIPTION:message-delete',
    policySha256: fingerprintModerationSettings(settings, 'REQUIRED_SUBSCRIPTION'),
    sourceAtMs,
    deadlineAtMs: sourceAtMs + 300_000,
  };
  const source = {
    sender: { user_id: proof.userId, is_bot: false },
    recipient: { chat_id: proof.chatId, chat_type: 'chat' },
    timestamp: sourceAtMs,
    body: { mid: proof.messageId, text: 'Synthetic source' },
  };
  const intent = {
    id: 'delete-intent',
    status: 'SUCCEEDED',
    subjectUserId: proof.userId,
    sourceMessageAt: new Date(sourceAtMs),
  };
  const reason = {
    ruleCode: 'REQUIRED_SUBSCRIPTION_DELETE',
    userId: proof.userId,
    metadata: {
      moderationDeleteVerified: true,
      requiredSubscriptionGuardVersion: 1,
      requiredSubscriptionPolicySha256: proof.policySha256,
      requiredSubscriptionSourceAtMs: proof.sourceAtMs,
      requiredSubscriptionDeadlineAtMs: proof.deadlineAtMs,
    },
  };
  const prisma = {
    chatSettings: { findUnique: jest.fn(async () => settings) },
    moderationDeleteIntent: { findUnique: jest.fn(async () => intent) },
    moderationDeleteIntentReason: { findUnique: jest.fn(async () => reason) },
  };
  const registry = { isKnownBotUserId: jest.fn(() => false) };
  const immunity = { consumeForMessage: jest.fn(async () => 'not_granted') };
  const guard = new MaxRequiredSubscriptionNoticeGuardService(
    prisma as never,
    registry as never,
    immunity as never,
    new ConfigService(),
  );
  const action = {
    actionType: 'SEND_MESSAGE',
    chatId: proof.chatId,
    botId: 'peer-2',
    text: 'Synthetic subscription notice',
    idempotencyKey: 'required-subscription:notice:v1:-123:source-message',
    createdAt: new Date().toISOString(),
    attempt: 1,
    ledgerContext: { requiredSubscriptionNotice: proof },
  } as MaxActionJob;
  const readers = {
    getMemberAccess: jest.fn(async () => ({
      userId: proof.userId,
      isAdmin: false,
      isOwner: false,
    })),
    getSource: jest.fn(async () => source as Record<string, unknown> | null),
    getMembership: jest.fn(async ({ targetId }: { targetId: string }) => targetId === 'target-2'),
  };
  return {
    settings,
    proof,
    source,
    intent,
    reason,
    prisma,
    registry,
    immunity,
    guard,
    action,
    readers,
  };
}

describe('durable required-subscription notice authority', () => {
  it.each([1, 86_400_000])(
    'preserves the original event deadline when MAX creation precedes that event by %ims',
    async (difference) => {
      const s = fixture();
      s.source.timestamp -= difference;
      const originalDeadline = s.proof.deadlineAtMs;
      await expect(s.guard.assertAllowed(s.action, 'peer-2', s.readers)).resolves.toBeUndefined();
      expect(s.proof.deadlineAtMs).toBe(originalDeadline);
    },
  );
  it('authorizes the original current source before DELETE with fresh selected-peer author and bounded targets', async () => {
    const s = fixture();
    await s.guard.assertAllowed(s.action, 'peer-2', s.readers);
    expect(s.readers.getMemberAccess).toHaveBeenCalledWith({
      chatId: '-123',
      userId: 'user-1',
      botId: 'peer-2',
      timeoutMs: 5_000,
    });
    expect(s.readers.getSource).toHaveBeenCalledWith({
      chatId: '-123',
      messageId: 'source-message',
      botId: 'peer-2',
      timeoutMs: 5_000,
    });
    expect(s.readers.getMembership.mock.calls.map(([params]) => params.targetId)).toEqual([
      'target-1',
      'target-2',
    ]);
    expect(s.prisma.moderationDeleteIntent.findUnique).not.toHaveBeenCalled();
  });

  it('allows delayed notice after this exact original required-subscription DELETE receipt', async () => {
    const s = fixture();
    s.readers.getSource.mockResolvedValue(null);
    await s.guard.assertAllowed(s.action, 'peer-2', s.readers);
    expect(s.prisma.moderationDeleteIntent.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { chatId_messageId: { chatId: '-123', messageId: 'source-message' } },
      }),
    );
    expect(s.prisma.moderationDeleteIntentReason.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { intentId_reasonKey: { intentId: 'delete-intent', reasonKey: s.proof.reasonKey } },
      }),
    );
  });

  it.each([
    'source-author',
    'source-time',
    'source-time-malformed',
    'source-chat',
    'source-message',
    'admin',
    'local-admin',
    'disabled',
    'targets',
    'own-receipt',
    'own-binding',
    'own-user',
    'expired',
    'extra-key',
    'reason-key',
  ])('rejects a revoked or mismatched %s proof', async (change) => {
    const s = fixture();
    if (change === 'source-author') s.source.sender.user_id = 'another-user';
    if (change === 'source-time') s.source.timestamp += 1;
    if (change === 'source-time-malformed') s.source.timestamp = Number.NaN;
    if (change === 'source-chat') s.source.recipient.chat_id = '-other';
    if (change === 'source-message') s.source.body.mid = 'other-message';
    if (change === 'admin')
      s.readers.getMemberAccess.mockResolvedValue({
        userId: 'user-1',
        isAdmin: true,
        isOwner: false,
      });
    if (change === 'local-admin') s.settings.chat.admins = [{ userId: 'user-1' }];
    if (change === 'disabled') s.settings.requiredSubscriptionEnabled = false;
    if (change === 'targets') s.settings.requiredSubscriptionChannelIds = ['other-target'];
    if (change.startsWith('own-')) s.readers.getSource.mockResolvedValue(null);
    if (change === 'own-receipt') s.reason.metadata.moderationDeleteVerified = false;
    if (change === 'own-binding') s.reason.metadata.requiredSubscriptionSourceAtMs += 1;
    if (change === 'own-user') s.intent.subjectUserId = 'another-user';
    if (change === 'expired') {
      s.proof.sourceAtMs = Date.now() - 300_001;
      s.proof.deadlineAtMs = s.proof.sourceAtMs + 300_000;
    }
    if (change === 'extra-key') Object.assign(s.proof, { borrowedMember: 'another-message' });
    if (change === 'reason-key') s.proof.reasonKey = 'REQUIRED_SUBSCRIPTION:borrowed-reason';
    await expect(s.guard.assertAllowed(s.action, 'peer-2', s.readers)).rejects.toMatchObject({
      code: 'required_subscription_notice_no_longer_authorized',
    });
  });

  it('does not turn an unknown target result into missing-subscription authority', async () => {
    const s = fixture();
    s.readers.getMembership.mockResolvedValue(null as never);
    await expect(s.guard.assertAllowed(s.action, 'peer-2', s.readers)).rejects.toThrow(
      'fresh membership unavailable',
    );
  });

  it('rejects when the user subscribes to every target during queue delay', async () => {
    const s = fixture();
    s.readers.getMembership.mockResolvedValue(true);
    await expect(s.guard.assertAllowed(s.action, 'peer-2', s.readers)).rejects.toMatchObject({
      code: 'required_subscription_notice_no_longer_authorized',
    });
  });

  it('rechecks policy after target probes and immunity work', async () => {
    const s = fixture();
    s.immunity.consumeForMessage.mockImplementation(async () => {
      s.settings.requiredSubscriptionWarnEnabled = false;
      return 'not_granted';
    });
    await expect(s.guard.assertAllowed(s.action, 'peer-2', s.readers)).rejects.toMatchObject({
      code: 'required_subscription_notice_no_longer_authorized',
    });
  });
  it('rechecks settings and the original deadline after the final route epoch probe', async () => {
    const s = fixture();
    const beforeFinalAuthority = jest.fn(async () => {
      s.settings.requiredSubscriptionWarnEnabled = false;
    });
    await expect(
      s.guard.assertAllowed(s.action, 'peer-2', {
        ...s.readers,
        beforeFinalAuthority,
      }),
    ).rejects.toMatchObject({ code: 'required_subscription_notice_no_longer_authorized' });
    expect(beforeFinalAuthority).toHaveBeenCalledTimes(1);
  });
});

function transportFixture() {
  const s = fixture();
  const order: string[] = [];
  const context = new MaxBotContextService();
  const bot = { id: 'peer-2', token: 'synthetic-token', state: 'active' };
  const config = new ConfigService({
    MAX_API_BASE_URL: 'https://max-harness.invalid',
    REDIS_URL: 'redis://fixture.invalid',
    MAX_ACTION_DISPATCH_ENABLED: true,
  });
  const http = {
    request: jest.fn(() => {
      order.push('http');
      return of({ status: 200, data: { message: { body: { mid: 'notice-sent' } } } });
    }),
  };
  const ledger = {
    getCompletedSendDispatchResult: jest.fn(async () => null as any),
    claimSendDispatch: jest.fn(async () => ({ kind: 'claimed', dispatchToken: 'send-token' })),
    completeSendDispatch: jest.fn(async () => new Date()),
    releaseSendDispatch: jest.fn(async () => undefined),
  };
  const links = { resolveBotIdForRead: jest.fn(async () => 'target-reader') };
  const client = new MaxClientService(
    http as never,
    config,
    { recordSuccessForLane: jest.fn(), recordFailureForLane: jest.fn() } as never,
    { ...s.registry, getDefaultBot: () => bot, getBotById: () => bot } as never,
    context,
    undefined,
    undefined,
    ledger as never,
    links as never,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    s.guard,
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
    order.push('author');
    expect(context.getActiveBotId()).toBe('peer-2');
    expect(options).toEqual(expect.objectContaining({ botId: 'peer-2', bypassCache: true }));
    return { userId: 'user-1', isAdmin: false, isOwner: false } as never;
  });
  jest.spyOn(client, 'getExactMessageRow').mockImplementation(async () => {
    order.push('source');
    return s.source;
  });
  jest
    .spyOn(client, 'getChatMembersAccess')
    .mockImplementation(async (_target, _users, options) => {
      order.push('membership');
      expect(options).toEqual(
        expect.objectContaining({ botId: 'target-reader', bypassCache: true }),
      );
      return new Map();
    });
  const authority = jest.spyOn(s.guard, 'assertAllowed');
  return { ...s, client, http, quota, ledger, authority, order, links };
}

describe('required-subscription queued SEND boundary', () => {
  it('checks after preparation and quota through selected author/source bot and each current target read route', async () => {
    const s = transportFixture();
    try {
      await s.client.executeActionJob(JSON.parse(JSON.stringify(s.action)));
      expect(s.order).toEqual([
        'prepare',
        'quota',
        'author',
        'source',
        'membership',
        'membership',
        'http',
      ]);
      expect(s.http.request).toHaveBeenCalledTimes(1);
      expect(s.links.resolveBotIdForRead).toHaveBeenCalledTimes(2);
    } finally {
      await s.client.onModuleDestroy();
    }
  });

  it('revokes after a queue/quota-time policy change and releases only the untouched SEND claim', async () => {
    const s = transportFixture();
    try {
      s.quota.mockImplementation(async () => {
        s.settings.requiredSubscriptionEnabled = false;
      });
      await expect(s.client.executeActionJob(s.action)).rejects.toMatchObject({
        code: 'required_subscription_notice_no_longer_authorized',
      });
      expect(s.http.request).not.toHaveBeenCalled();
      expect(s.ledger.releaseSendDispatch).toHaveBeenCalledTimes(1);
    } finally {
      await s.client.onModuleDestroy();
    }
  });

  it.each([
    'required-subscription:notice:v1:-123:source',
    'max-action__explicit__send-message__required-subscription-notice-v1-123-source__digest',
  ])('fails closed for an unbound legacy notice namespace %s', async (key) => {
    const s = transportFixture();
    try {
      const unbound = { ...s.action };
      delete unbound.ledgerContext;
      await expect(
        s.client.executeActionJob({ ...unbound, idempotencyKey: key }),
      ).rejects.toMatchObject({ code: 'required_subscription_notice_no_longer_authorized' });
      expect(s.http.request).not.toHaveBeenCalled();
    } finally {
      await s.client.onModuleDestroy();
    }
  });

  it('settles known receipt before malformed or missing legacy proof', async () => {
    const s = transportFixture();
    try {
      s.action.ledgerContext!.requiredSubscriptionNotice = null;
      s.ledger.getCompletedSendDispatchResult.mockResolvedValue({
        remoteMessageId: 'saved-notice',
        dispatchBotId: 'peer-2',
        completedAt: new Date(),
      });
      await expect(s.client.executeActionJob(s.action)).resolves.toMatchObject({
        messageId: 'saved-notice',
      });
      expect(s.authority).not.toHaveBeenCalled();
      expect(s.http.request).not.toHaveBeenCalled();
    } finally {
      await s.client.onModuleDestroy();
    }
  });

  it('retains unknown SEND fencing before any current-policy guard and never sends again', async () => {
    const s = transportFixture();
    try {
      const unknown = new UnrecoverableError('Ambiguous MAX SEND_MESSAGE fixture');
      s.ledger.claimSendDispatch.mockRejectedValue(unknown);
      await expect(s.client.executeActionJob(s.action)).rejects.toBe(unknown);
      expect(s.authority).not.toHaveBeenCalled();
      expect(s.http.request).not.toHaveBeenCalled();
      expect(s.ledger.releaseSendDispatch).not.toHaveBeenCalled();
    } finally {
      await s.client.onModuleDestroy();
    }
  });
});
