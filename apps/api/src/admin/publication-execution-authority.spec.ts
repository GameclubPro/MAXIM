import { resolvePublicationExecutionIntent } from './publication-execution-authority';

describe('Publisher accepted execution intent', () => {
  const now = new Date('2026-10-20T00:00:00Z');
  const deadline = new Date(now.getTime() + 86_400_000);

  it('uses the persisted finite deadline without renewing it', () => {
    expect(resolvePublicationExecutionIntent({ deliveryDeadlineAt: deadline }, now)).toEqual({
      kind: 'entity',
      deadlineAt: deadline,
    });
    expect(
      resolvePublicationExecutionIntent(
        { deliveryDeadlineAt: deadline },
        new Date(deadline.getTime() + 1),
      ),
    ).toEqual({ kind: 'entity', deadlineAt: deadline });
  });

  it('keeps old indefinite and original five-minute retries behind legacy authority', () => {
    expect(resolvePublicationExecutionIntent({}, now)).toEqual({ kind: 'legacy_actor' });
    expect(resolvePublicationExecutionIntent({ retryAuthorizedAt: now }, now)).toEqual({
      kind: 'legacy_actor',
    });
  });

  it('preserves the original finite explicit retry, including its legacy marker', () => {
    expect(
      resolvePublicationExecutionIntent({ retryAuthorizedAt: now, retryExpiresAt: deadline }, now),
    ).toEqual({ kind: 'entity', deadlineAt: deadline });
    expect(
      resolvePublicationExecutionIntent(
        {
          dispatchBlockerCode: 'PUBLISHER_EXPLICIT_RETRY',
          dispatchBlockedAt: now,
          retryExpiresAt: deadline,
        },
        now,
      ),
    ).toEqual({ kind: 'entity', deadlineAt: deadline });
  });

  it.each([
    { deliveryDeadlineAt: new Date(NaN) },
    { retryExpiresAt: deadline },
    { retryAuthorizedAt: deadline, retryExpiresAt: now },
    { retryAuthorizedAt: deadline, retryExpiresAt: new Date(deadline.getTime() + 1) },
  ])('does not downgrade malformed or future intent to legacy authority: %p', (intent) => {
    expect(resolvePublicationExecutionIntent(intent, now)).toEqual({ kind: 'invalid' });
  });
});
