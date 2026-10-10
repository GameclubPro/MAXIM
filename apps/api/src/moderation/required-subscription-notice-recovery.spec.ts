import { ConfigService } from '@nestjs/config';
import { SanctionAction } from '../prisma/prisma-client';
import { markMaxMessageSendAttempted } from '../max/max-mutation-outcome.util';
import { RequiredSubscriptionExecutionGuardService } from './required-subscription-execution-guard.service';
import { fingerprintModerationSettings } from './moderation-settings-fingerprint';
import { createRequiredSubscriptionNoticeHandoff } from './moderation-execution-guard-callbacks';
import {
  RequiredSubscriptionMediaNoticeCoordinator,
  createRequiredSubscriptionMediaNoticePlannedState,
  resolveRequiredSubscriptionMediaNoticeScope,
} from './required-subscription-media-notice';
import type { RequiredSubscriptionNoticePlan } from './required-subscription-notice-plan';

function fixture(mode: 'persisted' | 'album' | 'leader' = 'persisted') {
  const now = Date.now();
  const settings = {
    requiredSubscriptionEnabled: true,
    requiredSubscriptionChannelIds: ['target'],
    chat: { entityType: 'CHAT', admins: [] },
  };
  const proof = {
    version: 1 as const,
    chatId: '-123',
    userId: 'user',
    messageId: 'original',
    reasonKey: 'REQUIRED_SUBSCRIPTION:message-delete',
    policySha256: fingerprintModerationSettings(settings as never, 'REQUIRED_SUBSCRIPTION'),
    sourceAtMs: now,
    deadlineAtMs: now + 300_000,
  };
  const plan: RequiredSubscriptionNoticePlan = {
    version: 1,
    action: SanctionAction.NONE,
    renderedText: 'Subscribe',
    messageOptions: {},
    mediaFieldKey: null,
    deleteBotMessagesEnabled: false,
    deleteBotMessagesDelayMinutes: 5,
    executionProof: proof,
  };
  const sourceError = Object.assign(new Error('source unavailable'), { response: { status: 404 } });
  const max = {
    getChatMemberAccess: jest.fn(async () => ({ userId: 'user', isAdmin: false, isOwner: false })),
    getExactMessageRow: jest.fn(async (): Promise<Record<string, unknown> | null> => {
      throw sourceError;
    }),
  };
  const prisma = {
    chatSettings: { findUnique: jest.fn(async () => settings) },
    moderationDeleteIntent: { findUnique: jest.fn(async () => null) },
  };
  const immunity = { consumeForMessage: jest.fn(async () => 'not_granted') };
  const guard = new RequiredSubscriptionExecutionGuardService(
    prisma as never,
    max as never,
    { isKnownBotUserId: () => false } as never,
    { getMembershipResolution: async () => ({ fresh: true, membership: false }) } as never,
    immunity as never,
    new ConfigService(),
  );
  const remoteSend = jest.fn(async () => true);
  const handoff = createRequiredSubscriptionNoticeHandoff(
    guard,
    () => 'selected',
    proof,
    async (notice) => {
      await notice.beforeSend();
      return remoteSend();
    },
  );
  const scope =
    mode === 'album'
      ? resolveRequiredSubscriptionMediaNoticeScope({
          chatId: proof.chatId,
          userId: proof.userId,
          sourceCreatedAt: new Date(now).toISOString(),
          mediaGroupId: 'album',
          mediaEligible: true,
        })
      : null;
  const state = scope
    ? createRequiredSubscriptionMediaNoticePlannedState({
        scope,
        anchorMessageId: proof.messageId,
        noticeIdempotencyKey: 'original-notice',
      })
    : null;
  const redis = {
    acquireLock: jest.fn(async () => 'lease'),
    renewLock: jest.fn(async () => true),
    releaseLock: jest.fn(async () => true),
    getString: jest.fn(async () => JSON.stringify(state)),
    setStringWithTtl: jest.fn(async () => undefined),
  };
  const coverage = { findUnique: jest.fn(async () => null), upsert: jest.fn() };
  const coordinator = new RequiredSubscriptionMediaNoticeCoordinator(coverage, redis as never);
  const executeDelete = jest.fn(async () => undefined);
  const run = () =>
    coordinator.run({
      chatId: proof.chatId,
      userId: proof.userId,
      messageId: mode === 'album' ? 'another-member' : proof.messageId,
      mediaScope: scope,
      readNoticePlan: async () => (mode === 'leader' ? null : plan),
      handoffNoticePlan: handoff,
      executeDelete,
      lead: async ({ settleNoticePlan }) => {
        await settleNoticePlan(plan);
        return true;
      },
    });
  return {
    run,
    max,
    remoteSend,
    executeDelete,
    redis,
    coverage,
    immunity,
    sourceError,
    plan,
    prisma,
  };
}

describe('required subscription notice recovery before dispatch', () => {
  it.each(['persisted', 'album', 'leader'] as const)(
    'finishes a %s notice source GET 404 without send, deletion or delivered coverage',
    async (mode) => {
      const s = fixture(mode);
      await expect(s.run()).resolves.toBe(true);
      expect(s.remoteSend).not.toHaveBeenCalled();
      expect(s.executeDelete).not.toHaveBeenCalled();
      expect(s.coverage.upsert).not.toHaveBeenCalled();
      expect(s.redis.setStringWithTtl).not.toHaveBeenCalled();
      expect(s.immunity.consumeForMessage).not.toHaveBeenCalled();
      expect(s.redis.releaseLock).toHaveBeenCalledTimes(1);
    },
  );

  it('allows a later proven notice through the released lease', async () => {
    const s = fixture();
    await expect(s.run()).resolves.toBe(true);
    s.max.getExactMessageRow.mockResolvedValue({
      sender: { user_id: 'user' },
      recipient: { chat_id: '-123', chat_type: 'chat' },
      timestamp: s.plan.executionProof!.sourceAtMs,
      body: { mid: 'original', text: 'hello' },
    });
    await expect(s.run()).resolves.toBe(true);
    expect(s.remoteSend).toHaveBeenCalledTimes(1);
    expect(s.executeDelete).toHaveBeenCalledTimes(1);
  });

  it.each(['source-503', 'member-404', 'lease', 'attempted-source', 'source-other'])(
    'retains the original %s failure fence',
    async (kind) => {
      const s = fixture();
      const error = Object.assign(new Error('unknown failure'), {
        response: { status: kind === 'source-503' ? 503 : 404 },
      });
      if (kind === 'member-404') s.max.getChatMemberAccess.mockRejectedValue(error);
      else if (kind === 'lease') s.redis.renewLock.mockRejectedValue(error);
      else if (kind === 'attempted-source')
        s.max.getExactMessageRow.mockRejectedValue(markMaxMessageSendAttempted(error));
      else if (kind === 'source-other')
        s.max.getExactMessageRow.mockRejectedValue(
          Object.assign(error, { response: { status: 400 } }),
        );
      else s.max.getExactMessageRow.mockRejectedValue(error);
      await expect(s.run()).rejects.toBe(error);
      expect(s.remoteSend).not.toHaveBeenCalled();
      expect(s.executeDelete).not.toHaveBeenCalled();
      expect(s.coverage.upsert).not.toHaveBeenCalled();
    },
  );

  it('does not swallow a send failure after successful authority', async () => {
    const s = fixture();
    s.max.getExactMessageRow.mockResolvedValue({
      sender: { user_id: 'user' },
      recipient: { chat_id: '-123', chat_type: 'chat' },
      timestamp: s.plan.executionProof!.sourceAtMs,
      body: { mid: 'original', text: 'hello' },
    });
    const failure = Object.assign(new Error('send failed'), { response: { status: 404 } });
    s.remoteSend.mockRejectedValue(failure);
    await expect(s.run()).rejects.toBe(failure);
    expect(s.executeDelete).not.toHaveBeenCalled();
  });

  it('denies an expired notice without asserting delivery or deleting the source', async () => {
    const s = fixture();
    s.plan.executionProof!.sourceAtMs -= 600_000;
    s.plan.executionProof!.deadlineAtMs -= 600_000;
    await expect(s.run()).resolves.toBe(true);
    expect(s.max.getExactMessageRow).not.toHaveBeenCalled();
    expect(s.remoteSend).not.toHaveBeenCalled();
    expect(s.executeDelete).not.toHaveBeenCalled();
  });
});
