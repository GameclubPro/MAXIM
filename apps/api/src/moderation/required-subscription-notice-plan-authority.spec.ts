import {
  buildRequiredSubscriptionNoticePlan,
  parseRequiredSubscriptionNoticePlanMetadata,
  RequiredSubscriptionNoticePlanStore,
  serializeRequiredSubscriptionNoticePlan,
} from './required-subscription-notice-plan';
import type { RequiredSubscriptionNoticeAuthority } from './required-subscription-notice-authority';

function proof(messageId: string, sourceAtMs: number): RequiredSubscriptionNoticeAuthority {
  return {
    version: 1,
    chatId: '-123',
    userId: 'user-1',
    messageId,
    reasonKey: 'REQUIRED_SUBSCRIPTION:message-delete',
    policySha256: 'a'.repeat(64),
    sourceAtMs,
    deadlineAtMs: sourceAtMs + 300_000,
  };
}

async function plan(executionProof?: RequiredSubscriptionNoticeAuthority) {
  return buildRequiredSubscriptionNoticePlan({
    action: 'WARN',
    sanctionEventId: null,
    deleteBotMessagesEnabled: false,
    deleteBotMessagesDelayMinutes: 1,
    executionProof,
    copy: {
      explanation: async () => 'Subscribe first',
      warning: async () => 'Subscription warning',
      mute: () => 'Muted',
      ban: () => 'Banned',
    },
  });
}

function metadata(value: Awaited<ReturnType<typeof plan>>) {
  return {
    requiredSubscriptionNoticePlan: {
      version: 1,
      payload: serializeRequiredSubscriptionNoticePlan(value),
    },
  };
}

describe('required-subscription immutable notice source', () => {
  it('preserves the original anchor proof through durable plan serialization and recovery', async () => {
    const original = await plan(proof('anchor', Date.now() - 20_000));
    const row = { metadata: metadata(original) };
    const model = { upsert: jest.fn(async () => row), findUnique: jest.fn(async () => row) };
    const store = new RequiredSubscriptionNoticePlanStore(model);
    const replacement = await plan(proof('new-member', Date.now()));
    expect(
      await store.persist({
        chatId: '-123',
        userId: 'user-1',
        messageId: 'anchor',
        plan: replacement,
      }),
    ).toEqual(original);
    expect((await store.read('-123', 'anchor'))?.executionProof).toEqual(original.executionProof);
    expect(model.upsert).toHaveBeenCalledWith(expect.objectContaining({ update: {} }));
  });

  it('retains legacy plans for inspection without inventing a new source proof', async () => {
    const old = await plan();
    expect(parseRequiredSubscriptionNoticePlanMetadata(metadata(old))).toEqual(old);
    expect(
      parseRequiredSubscriptionNoticePlanMetadata(metadata(old))?.executionProof,
    ).toBeUndefined();
  });

  it.each(['null', 'unknown-version', 'borrowed-time', 'extra-member'])(
    'rejects a malformed persisted %s proof',
    async (change) => {
      const original = await plan(proof('anchor', Date.now() - 10_000));
      if (change === 'null') (original as any).executionProof = null;
      if (change === 'unknown-version') (original.executionProof as any).version = 2;
      if (change === 'borrowed-time') original.executionProof!.deadlineAtMs += 1;
      if (change === 'extra-member')
        Object.assign(original.executionProof!, { albumMember: 'new-member' });
      expect(parseRequiredSubscriptionNoticePlanMetadata(metadata(original))).toBeNull();
    },
  );
});
