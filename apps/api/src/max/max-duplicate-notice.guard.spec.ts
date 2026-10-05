import { ConfigService } from '@nestjs/config';
import { of } from 'rxjs';
import { UnrecoverableError } from 'bullmq';
import {
  MESSAGE_DUPLICATE_NOTICE_AUTHORITY,
  MessageDuplicateGuardRejectedError,
} from '../moderation/message-duplicate/message-duplicate-guard.contract';
import {
  buildMessageDuplicateNoticeContext,
  messageDuplicateNoticeSettingsDigest,
  readMessageDuplicateNoticeProof,
  type MessageDuplicateNoticeProof,
} from '../moderation/message-duplicate/message-duplicate-notice-proof';
import { MESSAGE_DUPLICATE_MEDIA_VERSION } from '../moderation/message-duplicate/message-duplicate-state';
import { duplicateSettings } from '../moderation/message-duplicate/message-duplicate-test-fixtures';
import { MaxBotContextService } from './max-bot-context.service';
import { MaxClientService, type MaxActionJob } from './max-client.service';
import {
  MaxDuplicateNoticeGuardService,
  isMaxDuplicateNoticeAction,
} from './max-duplicate-notice.guard';

jest.mock('ioredis', () => jest.fn().mockImplementation(() => ({ quit: jest.fn() })));

function fixture() {
  const eventTimestampMs = Date.now() - 10_000;
  const binding: MessageDuplicateNoticeProof['binding'] = {
    version: 3,
    enforcementScope: 'full',
    lifecycleRevision: 'a'.repeat(64),
    policyRevision: 1,
    authorization: { eventTimestampMs, deadlineAtMs: eventTimestampMs + 600_000 },
    original: {
      member: 'b'.repeat(64),
      author: 'c'.repeat(64),
      messageId: 'original',
      senderId: 'user-1',
      publishedAtMs: eventTimestampMs - 1_000,
      observedAtMs: eventTimestampMs - 1_000,
      expiresAtMs: eventTimestampMs + 3_600_000,
      sourceDigest: 'd'.repeat(64),
      contentDigest: 'e'.repeat(64),
      mediaHashes: [],
      epoch: 0,
      revision: 'f'.repeat(64),
      originalId: '0'.repeat(64),
    },
    senderId: 'user-1',
    messageId: 'source',
    eventTimestampMs,
    controlRevision: 1,
    settingsDigest: '1'.repeat(64),
    sourceDigest: 'd'.repeat(64),
    contentDigest: 'e'.repeat(64),
    fingerprint: '2'.repeat(64),
    compareMode: 'TEXT',
    mediaHashes: [],
    mediaVersion: MESSAGE_DUPLICATE_MEDIA_VERSION,
    hasPhotos: false,
    photoControlRevision: null,
    windowSeconds: 3_600,
    requiredCount: 2,
  };
  const settings = duplicateSettings();
  const proof: MessageDuplicateNoticeProof = {
    version: 3,
    chatId: '-123',
    intentId: 'intent',
    reasonKey: `MESSAGE_DUPLICATE:v1:${eventTimestampMs}`,
    deadlineAtMs: binding.authorization!.deadlineAtMs,
    noticePolicySha256: messageDuplicateNoticeSettingsDigest(settings),
    binding,
    stage: { kind: 'hit', repeatCount: 1, threshold: null },
  };
  const action = {
    actionType: 'SEND_MESSAGE',
    chatId: '-123',
    botId: 'peer-2',
    text: 'Synthetic explanation',
    idempotencyKey: 'message_v1-duplicate:-123:source:explanation',
    ledgerContext: { duplicateNotice: proof },
    createdAt: new Date().toISOString(),
    attempt: 1,
  } as MaxActionJob;
  const authority = { assertMessageStillActionable: jest.fn(async (_input: unknown) => 'allowed') };
  const modules = { get: jest.fn(() => authority) };
  const guard = new MaxDuplicateNoticeGuardService(modules as never);
  return { proof, binding, action, authority, modules, guard, settings };
}

describe('durable duplicate explanation envelope', () => {
  it('preserves the original hit stage and own deadline when a shared intent has a later deadline', async () => {
    const s = fixture();
    const prisma = {
      moderationDeleteIntent: {
        findUnique: jest.fn(async () => ({
          id: 'intent',
          subjectUserId: 'user-1',
          retryUntilAt: new Date(s.proof.deadlineAtMs + 60_000),
        })),
      },
    };
    const context = await buildMessageDuplicateNoticeContext(
      prisma as never,
      {
        chatId: '-123',
        messageId: 'source',
        reasonKey: s.proof.reasonKey,
        retryUntilAt: new Date(s.proof.deadlineAtMs),
        event: { metadata: { duplicateSource: 'message_v1', messageDuplicate: s.binding } },
      },
      s.proof.noticePolicySha256,
      { count: 1 },
    );
    expect(readMessageDuplicateNoticeProof(context.duplicateNotice)).toEqual(s.proof);
    expect(s.binding.sanction).toBeUndefined();
  });

  it.each(['version', 'deadline', 'reason', 'scope', 'stage', 'extra'])(
    'rejects a malformed %s proof',
    async (change) => {
      const s = fixture();
      if (change === 'version') Object.assign(s.proof, { version: 2 });
      if (change === 'deadline') s.proof.deadlineAtMs += 1;
      if (change === 'reason') s.proof.reasonKey = 'MESSAGE_DUPLICATE:borrowed';
      if (change === 'scope') s.binding.enforcementScope = 'delete_only';
      if (change === 'stage') s.proof.stage.kind = 'WARN';
      if (change === 'extra') Object.assign(s.proof, { originBot: 'other' });
      await expect(s.guard.assertAllowed(s.action, 'peer-2')).rejects.toMatchObject({
        code: 'message_duplicate_notice_no_longer_authorized',
      });
      expect(s.modules.get).not.toHaveBeenCalled();
    },
  );

  it('resolves the acyclic authority alias and uses the actual final executor without sanction mode', async () => {
    const s = fixture();
    const route = async () => undefined;
    await s.guard.assertAllowed(s.action, 'last-peer', route);
    expect(s.modules.get).toHaveBeenCalledWith(MESSAGE_DUPLICATE_NOTICE_AUTHORITY, {
      strict: false,
    });
    expect(s.authority.assertMessageStillActionable).toHaveBeenCalledWith(
      expect.objectContaining({ botId: 'last-peer', notice: s.proof, beforeFinalAuthority: route }),
    );
    expect(
      (s.authority.assertMessageStillActionable.mock.calls[0]![0] as any).sanctionIntentId,
    ).toBeUndefined();
  });

  it('converts proven revocation and propagates unknown authority failures', async () => {
    const s = fixture();
    s.authority.assertMessageStillActionable.mockRejectedValue(
      new MessageDuplicateGuardRejectedError('reset'),
    );
    await expect(s.guard.assertAllowed(s.action, 'peer-2')).rejects.toMatchObject({
      code: 'message_duplicate_notice_no_longer_authorized',
    });
    const unknown = new Error('Redis unavailable');
    s.authority.assertMessageStillActionable.mockRejectedValue(unknown);
    await expect(s.guard.assertAllowed(s.action, 'peer-2')).rejects.toBe(unknown);
  });

  it.each([
    'message_v1-duplicate:-123:source:explanation',
    'photo-duplicate:-123:source:explanation',
    'max-action__explicit__send-message__message-v1-duplicate-123-source-explanation__digest',
    'max-action__explicit__send-message__photo-duplicate-123-source-explanation__digest',
  ])('recognizes retained legacy explanation namespace %s', (idempotencyKey) => {
    expect(isMaxDuplicateNoticeAction({ actionType: 'SEND_MESSAGE', idempotencyKey })).toBe(true);
  });
});

function transportFixture() {
  const s = fixture();
  const order: string[] = [];
  const bot = { id: 'peer-2', token: 'synthetic-token', state: 'active' };
  const context = new MaxBotContextService();
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
    claimSendDispatch: jest.fn(async () => {
      order.push('claim');
      return { kind: 'claimed', dispatchToken: 'send-token' };
    }),
    completeSendDispatch: jest.fn(async () => new Date()),
    releaseSendDispatch: jest.fn(async () => undefined),
  };
  const client = new MaxClientService(
    http as never,
    config,
    { recordSuccessForLane: jest.fn(), recordFailureForLane: jest.fn() } as never,
    { getDefaultBot: () => bot, getBotById: () => bot } as never,
    context,
    undefined,
    undefined,
    ledger as never,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    s.guard,
  );
  jest.spyOn(client as any, 'acquireCircuitPermit').mockResolvedValue({ halfOpenProbe: false });
  jest.spyOn(client as any, 'closeCircuitAfterSuccessfulProbe').mockResolvedValue(undefined);
  const route = jest
    .spyOn(client as any, 'assertChatMutationExecutionProof')
    .mockResolvedValue(null);
  const quota = jest.spyOn(client as any, 'reserveRateLimitSlot').mockImplementation(async () => {
    order.push('quota');
  });
  jest
    .spyOn(client as any, 'prepareMarketplacePublicationOptions')
    .mockImplementation(async (_chat: any, options: any) => {
      order.push('prepare');
      return options;
    });
  s.authority.assertMessageStillActionable.mockImplementation(async (input: any) => {
    order.push('authority');
    expect(context.getActiveBotId()).toBe('peer-2');
    await input.beforeFinalAuthority?.();
    return 'allowed';
  });
  return { ...s, order, http, ledger, client, route, quota };
}

describe('duplicate queued SEND transport boundary', () => {
  it('runs current authority after preparation/claim/quota before the final HTTP dispatch', async () => {
    const s = transportFixture();
    try {
      await s.client.executeActionJob(s.action);
      expect(s.order).toEqual(['prepare', 'claim', 'quota', 'authority', 'http']);
      expect(s.http.request).toHaveBeenCalledTimes(1);
    } finally {
      await s.client.onModuleDestroy();
    }
  });

  it('rejects a quota-delayed history reset and releases only the untouched SEND fence', async () => {
    const s = transportFixture();
    try {
      s.quota.mockImplementation(async () => {
        s.authority.assertMessageStillActionable.mockRejectedValue(
          new MessageDuplicateGuardRejectedError('history-reset'),
        );
      });
      await expect(s.client.executeActionJob(s.action)).rejects.toMatchObject({
        code: 'message_duplicate_notice_no_longer_authorized',
      });
      expect(s.http.request).not.toHaveBeenCalled();
      expect(s.ledger.releaseSendDispatch).toHaveBeenCalledTimes(1);
    } finally {
      await s.client.onModuleDestroy();
    }
  });

  it('fails closed for an unbound retained explanation before a new HTTP dispatch', async () => {
    const s = transportFixture();
    try {
      const action = { ...s.action };
      delete action.ledgerContext;
      await expect(s.client.executeActionJob(action)).rejects.toMatchObject({
        code: 'message_duplicate_notice_no_longer_authorized',
      });
      expect(s.http.request).not.toHaveBeenCalled();
    } finally {
      await s.client.onModuleDestroy();
    }
  });

  it('settles an existing receipt before malformed proof without reauthorization or resend', async () => {
    const s = transportFixture();
    try {
      s.action.ledgerContext!.duplicateNotice = null;
      s.ledger.getCompletedSendDispatchResult.mockResolvedValue({
        remoteMessageId: 'saved',
        dispatchBotId: 'peer-2',
        completedAt: new Date(),
      });
      await expect(s.client.executeActionJob(s.action)).resolves.toMatchObject({
        messageId: 'saved',
      });
      expect(s.modules.get).not.toHaveBeenCalled();
      expect(s.http.request).not.toHaveBeenCalled();
    } finally {
      await s.client.onModuleDestroy();
    }
  });

  it('preserves an unknown outcome fence before current-policy checks and never sends again', async () => {
    const s = transportFixture();
    try {
      const unknown = new UnrecoverableError('Ambiguous MAX SEND_MESSAGE fixture');
      s.ledger.claimSendDispatch.mockRejectedValue(unknown);
      await expect(s.client.executeActionJob(s.action)).rejects.toBe(unknown);
      expect(s.modules.get).not.toHaveBeenCalled();
      expect(s.http.request).not.toHaveBeenCalled();
      expect(s.ledger.releaseSendDispatch).not.toHaveBeenCalled();
    } finally {
      await s.client.onModuleDestroy();
    }
  });
});
