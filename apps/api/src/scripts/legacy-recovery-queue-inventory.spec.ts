import {
  classifyLegacyRecoveryQueues,
  isLegacyRecoveryWebhookQueue,
  scanLegacyRecoveryQueueCatalog,
  type LegacyQueueSnapshot,
} from './legacy-recovery-queue-inventory';
import type { LegacyRecoveryCandidate } from '../webhook/webhook-legacy-cold-install';

const candidates = [
  { source: { chatId: '-1', messageId: 'message', userId: 'user' } },
] as LegacyRecoveryCandidate[];
function snapshot(data: unknown, name = 'max-actions-interactive'): LegacyQueueSnapshot {
  return { name, count: 1, jobs: [{ id: 'job', data }] };
}
const send = {
  actionType: 'SEND_MESSAGE',
  chatId: '-1',
  idempotencyKey: 'key',
  createdAt: '2099-01-01',
  ledgerContext: {
    moderationSource: { version: 1, chatId: '-1', messageId: 'message', userId: 'user' },
  },
};

describe('finite legacy child inventory', () => {
  it('fails closed for a refused, malformed or oversized catalog reply', async () => {
    for (const reply of [
      [0],
      [1, 'invalid', 'bull:q:meta'],
      [1, '0', 123],
      [1, '0', ...Array.from({ length: 201 }, () => 'bull:q:meta')],
      [1, '0', 'x'.repeat(64 * 1024 + 1)],
    ]) {
      await expect(
        scanLegacyRecoveryQueueCatalog({ eval_ro: async () => reply }, '0'),
      ).rejects.toMatchObject({ code: 'queue_catalog_budget_exceeded' });
    }
    const eval_ro = jest.fn(async () => [1, '0', 'bull:q:meta']);
    await expect(scanLegacyRecoveryQueueCatalog({ eval_ro }, 'bad')).rejects.toMatchObject({
      code: 'queue_inventory_unproved',
    });
    expect(eval_ro).not.toHaveBeenCalled();
  });
  it('binds exact attributed children regardless of future-dated clocks', () => {
    const [hold] = classifyLegacyRecoveryQueues(candidates, [snapshot(send)]);
    expect(hold).toMatchObject({
      jobKey: 'key',
      queueName: 'max-actions-interactive',
      chatId: '-1',
      messageId: 'message',
      userId: 'user',
    });
    expect(hold!.jobPayloadDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(
      classifyLegacyRecoveryQueues(candidates, [snapshot({ ...send, createdAt: '2000-01-01' })])[0]!
        .jobPayloadDigest,
    ).not.toBe(hold!.jobPayloadDigest);
  });
  it('uses nested duplicate source and inspects every available notice proof', () => {
    const duplicate = {
      ...send,
      ledgerContext: {
        duplicateNotice: {
          version: 3,
          chatId: '-1',
          binding: { messageId: 'message', senderId: 'user' },
        },
      },
    };
    expect(classifyLegacyRecoveryQueues(candidates, [snapshot(duplicate)])[0]).toMatchObject({
      messageId: 'message',
      userId: 'user',
    });
    const masked = {
      ...send,
      ledgerContext: {
        moderationSource: { version: 1, chatId: '-1' },
        duplicateNotice: duplicate.ledgerContext.duplicateNotice,
      },
    };
    expect(classifyLegacyRecoveryQueues(candidates, [snapshot(masked)])[0]).toMatchObject({
      messageId: 'message',
      userId: 'user',
    });
  });
  it('refuses missing-origin SEND even when its destination seems unrelated', () => {
    for (const chatId of ['-1', '-2'])
      expect(() =>
        classifyLegacyRecoveryQueues(candidates, [
          snapshot({ ...send, chatId, ledgerContext: undefined }),
        ]),
      ).toThrow('Unattributed SEND');
  });
  it('refuses truncated counts, duplicate IDs, queue collisions and budget overflow', () => {
    const row = snapshot(send);
    expect(() => classifyLegacyRecoveryQueues(candidates, [{ ...row, count: 2 }])).toThrow(
      'Incomplete',
    );
    expect(() =>
      classifyLegacyRecoveryQueues(candidates, [
        { ...row, count: 2, jobs: [...row.jobs, ...row.jobs] },
      ]),
    ).toThrow('Incomplete');
    expect(() => classifyLegacyRecoveryQueues(candidates, [row, row])).toThrow('Duplicate');
    const jobs = Array.from({ length: 5_001 }, (_, index) => ({ id: String(index), data: send }));
    expect(() =>
      classifyLegacyRecoveryQueues(candidates, [{ name: row.name, count: jobs.length, jobs }]),
    ).toThrow('budget');
  });
  it('refuses every unclassified nonempty child queue', () => {
    expect(() =>
      classifyLegacyRecoveryQueues(candidates, [
        snapshot({ userId: 'user' }, 'global-spammer-denorm'),
      ]),
    ).toThrow('Unclassified');
    expect(
      classifyLegacyRecoveryQueues(candidates, [
        { name: 'publisher-video-upload', count: 0, jobs: [] },
      ]),
    ).toEqual([]);
  });
  it('rejects conflicting child identities and source/destination aliases', () => {
    expect(() =>
      classifyLegacyRecoveryQueues(candidates, [
        snapshot(send),
        snapshot({ ...send, text: 'different' }, 'moderation-actions'),
      ]),
    ).toThrow('Conflicting');
    expect(() =>
      classifyLegacyRecoveryQueues(candidates, [
        snapshot({ ...send, ledgerContext: { moderationSource: { chatId: '-2' } } }),
      ]),
    ).toThrow('Conflicting');
    expect(() =>
      classifyLegacyRecoveryQueues(candidates, [
        snapshot({
          ...send,
          chatId: '-2',
          ledgerContext: { moderationSource: { userId: 'user' } },
        }),
      ]),
    ).toThrow('Cross-chat');
  });
  it('does not classify an invented queue or a larger shard range as a safe webhook', () => {
    for (const name of ['moderation-default-15', 'moderation-join-3', 'moderation'])
      expect(isLegacyRecoveryWebhookQueue(name)).toBe(true);
    for (const name of [
      'moderation-default-16',
      'moderation-join-4',
      'moderation-dynamic-unsafe',
      'moderation-delete-intents',
    ])
      expect(isLegacyRecoveryWebhookQueue(name)).toBe(false);
  });
});
