import type { Prisma } from '../prisma/prisma-client';
import { isSourceAbandonmentCheckpointSupported } from './webhook-source-abandonment-checkpoint';
import { MULTIBOT_EXECUTION_AUTHORITY_VERSION } from './webhook-semantic-authority';

function fixture() {
  const owner = {
    id: 'owner-id',
    semanticKey: 'message:message_created:-chat:source',
    executionDeadlineAt: new Date('2026-10-06T12:05:00.000Z') as Date | null,
  };
  const checkpoint = {
    kind: 'EXECUTION_WAITING',
    authorityVersion: MULTIBOT_EXECUTION_AUTHORITY_VERSION,
    webhookEventId: owner.id,
    semanticKey: owner.semanticKey,
    deadlineAt: owner.executionDeadlineAt!.toISOString(),
  };
  const claim = {
    webhookEventId: owner.id,
    semanticKey: owner.semanticKey,
    businessStartedAt: new Date('2026-10-06T12:04:00.000Z') as Date | null,
    commandResult: checkpoint as Prisma.JsonValue,
  };
  return { owner, claim, checkpoint };
}

describe('started source abandonment readiness checkpoint', () => {
  it('accepts the exact historical marker without rewriting the expired deadline or claim', () => {
    const f = fixture();
    const before = structuredClone(f);
    expect(isSourceAbandonmentCheckpointSupported(f.owner, f.claim)).toBe(true);
    expect(f).toEqual(before);
  });

  it('preserves the original null-checkpoint profile', () => {
    const f = fixture();
    f.claim.commandResult = null;
    f.owner.executionDeadlineAt = null;
    expect(isSourceAbandonmentCheckpointSupported(f.owner, f.claim)).toBe(true);
  });

  it.each([false, 1, 'EXECUTION_WAITING', [], {}, { kind: 'EXECUTION_WAITING' }])(
    'refuses incomplete/nonobject checkpoints %j',
    (commandResult) => {
      const f = fixture();
      f.claim.commandResult = commandResult;
      expect(isSourceAbandonmentCheckpointSupported(f.owner, f.claim)).toBe(false);
    },
  );

  it.each([
    ['kind', 'EXECUTION_COMPLETED'],
    ['authorityVersion', 'semantic-owner-lease-v2'],
    ['authorityVersion', 1],
    ['webhookEventId', 'another-receipt'],
    ['semanticKey', 'message:message_edited:-chat:source:another-revision'],
    ['deadlineAt', '2026-10-06T12:05:00Z'],
    ['deadlineAt', '2026-10-06T15:05:00.000+03:00'],
    ['deadlineAt', '2026-10-06T12:05:00.001Z'],
    ['deadlineAt', 'not-a-date'],
    ['deadlineAt', null],
    ['result', { status: 'completed' }],
    ['remoteMessageId', 'unrelated-effect'],
    ['checkpoint', { kind: 'EXECUTION_WAITING' }],
  ])('refuses altered identity/shape %s=%j', (key, value) => {
    const f = fixture();
    f.claim.commandResult = { ...f.checkpoint, [key as string]: value } as Prisma.JsonValue;
    expect(isSourceAbandonmentCheckpointSupported(f.owner, f.claim)).toBe(false);
  });

  it.each(['kind', 'authorityVersion', 'webhookEventId', 'semanticKey', 'deadlineAt'])(
    'requires checkpoint field %s',
    (key) => {
      const f = fixture();
      delete (f.checkpoint as Record<string, unknown>)[key];
      expect(isSourceAbandonmentCheckpointSupported(f.owner, f.claim)).toBe(false);
    },
  );

  it.each([
    'missing-deadline',
    'invalid-deadline',
    'missing-start',
    'invalid-start',
    'at-deadline',
    'after-deadline',
    'wrong-owner',
    'wrong-semantic',
  ])('refuses unproved original state %s', (fault) => {
    const f = fixture();
    if (fault === 'missing-deadline') f.owner.executionDeadlineAt = null;
    if (fault === 'invalid-deadline') f.owner.executionDeadlineAt = new Date(NaN);
    if (fault === 'missing-start') f.claim.businessStartedAt = null;
    if (fault === 'invalid-start') f.claim.businessStartedAt = new Date(NaN);
    if (fault === 'at-deadline') f.claim.businessStartedAt = f.owner.executionDeadlineAt;
    if (fault === 'after-deadline')
      f.claim.businessStartedAt = new Date(f.owner.executionDeadlineAt!.getTime() + 1);
    if (fault === 'wrong-owner') f.claim.webhookEventId = 'other-owner';
    if (fault === 'wrong-semantic') f.claim.semanticKey = 'other-semantic';
    expect(isSourceAbandonmentCheckpointSupported(f.owner, f.claim)).toBe(false);
  });
});
