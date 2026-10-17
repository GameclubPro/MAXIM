import {
  projectPublicationDeliveryEvidence,
  projectPublicationSavedDelivery,
  publicationDeliveryEvidenceKeys,
  type PublicationDeliveryLedgerRow,
} from './safety-desk-publication-delivery-evidence.model';

import { deliveryFixture } from './safety-desk-publication-delivery-test-fixture';
function ledger(
  row = deliveryFixture(),
  patch: Partial<PublicationDeliveryLedgerRow> = {},
): PublicationDeliveryLedgerRow {
  return {
    jobId: publicationDeliveryEvidenceKeys(row)!.currentKey,
    actionType: 'SEND_MESSAGE',
    chatId: row.targetChatId,
    sourceTag: 'managed_broadcast',
    botId: 'publisher',
    dispatchBotId: 'publisher',
    status: 'SUCCEEDED',
    ambiguous: false,
    terminal: true,
    hasDispatchToken: true,
    dispatchStartedAt: new Date(row.sentAt!.getTime() - 1000),
    remoteMessageId: row.remoteMessageId,
    firstAttemptAt: row.createdAt,
    lastAttemptAt: row.sentAt,
    completedAt: row.sentAt,
    createdAt: row.createdAt,
    requiredBotId: 'publisher',
    ...patch,
  };
}
describe('Saved Publisher recipient evidence', () => {
  it('keeps action receipt, saved send clock, verification and client visibility separate', () => {
    const row = deliveryFixture(),
      result = projectPublicationDeliveryEvidence(row, [ledger(row)]);
    expect(result).toMatchObject({
      binding: 'exact',
      action: { state: 'confirmed', keyBasis: 'current' },
      recipient: { state: 'saved', agreesWithAction: true, savedSendAt: row.sentAt!.toISOString() },
      verification: { state: 'not_recorded' },
      completionTimingEvidence: 'not_recorded',
      clientVisibility: 'not_observed',
      automaticRetryAllowed: false,
    });
    expect(JSON.stringify(result)).not.toContain('private-');
  });
  it.each(['bot', 'parent', 'content', 'clock'] as const)(
    'rejects conflicting %s binding or receipt',
    (failure) => {
      const row = deliveryFixture(
        failure === 'bot'
          ? { botId: 'other' }
          : failure === 'parent'
            ? { broadcastOccurrenceId: 'other' }
            : failure === 'content'
              ? { contentPublicationId: 'other' }
              : { sentAt: new Date('2027-01-01') },
      );
      expect(projectPublicationSavedDelivery(row).recipient.state).toBe('invalid_evidence');
    },
  );
  it.each(['', ' ', 'x'.repeat(513)])('rejects invalid matching immutable IDs %j', (value) => {
    const groups = [
      ['id'],
      ['broadcastId', 'parentBroadcastId'],
      ['publicationOccurrenceId', 'parentOccurrenceId', 'broadcastOccurrenceId'],
      ['contentRevisionId', 'parentContentRevisionId'],
      ['publicationId', 'contentPublicationId'],
      ['requiredBotId', 'broadcastRequiredBotId', 'occurrenceRequiredBotId'],
      ['targetChatId'],
    ] as const;
    for (const fields of groups) {
      const row = deliveryFixture(Object.fromEntries(fields.map((field) => [field, value])));
      expect(projectPublicationSavedDelivery(row).binding).toBe('invalid_evidence');
      expect(publicationDeliveryEvidenceKeys(row)).toBeNull();
    }
  });
  it('keeps manual legacy sends without remote identity unproven', () => {
    expect(
      projectPublicationSavedDelivery(
        deliveryFixture({
          legacySentWithoutRemoteId: true,
          remoteMessageId: null,
          remoteMessageVerificationSource: 'MANUAL_CONFIRMED',
        }),
      ),
    ).toMatchObject({
      recipient: { state: 'legacy_unproven' },
      verification: { state: 'legacy_unproven' },
    });
  });
  it('distinguishes operator and stable automated verification', () => {
    const row = deliveryFixture();
    expect(
      projectPublicationSavedDelivery({
        ...row,
        remoteMessageVerificationSource: 'MANUAL_CONFIRMED',
        remoteMessageVerifiedAt: row.observedAt,
      }).verification.state,
    ).toBe('operator_confirmed');
    const verified = {
      ...row,
      remoteMessageVerificationSource: 'AUTOMATED_STABLE' as const,
      remoteMessageVerifiedAt: row.observedAt,
      remoteMessageVerificationAttemptedAt: row.observedAt,
      remoteMessageVerificationAttemptCount: 2,
      remoteMessageVerificationPresentCount: 2,
    };
    expect(projectPublicationSavedDelivery(verified).verification.state).toBe('automated_stable');
    expect(
      projectPublicationSavedDelivery({ ...verified, remoteMessageVerificationPresentCount: 1 })
        .verification.state,
    ).toBe('invalid_evidence');
    expect(
      projectPublicationSavedDelivery({
        ...verified,
        remoteMessageVerificationNextAt: row.observedAt,
      }).verification.state,
    ).toBe('invalid_evidence');
  });
  it('reports overlapping saved waits without replacing recipient blockers or clamping retries', () => {
    const row = deliveryFixture({
      status: 'PENDING',
      effectiveStatus: 'PENDING',
      remoteMessageId: null,
      sentAt: null,
      waitReason: 'local_capacity',
      dispatchBlockerCode: 'bot_not_admin',
      parentBlockerCode: 'PUBLISHER_ACTOR_ACCESS_REQUIRED',
      deliveryDeadlineAt: new Date('2026-10-17T00:09:59Z'),
      nextAttemptAt: new Date('2026-10-18'),
      lockedAt: new Date('2026-10-17T00:05:00Z'),
      hasLockToken: true,
      pinStatus: 'AMBIGUOUS',
    });
    const waiting = projectPublicationSavedDelivery(row).waiting;
    expect(waiting).toMatchObject({
      deadline: 'expired',
      nextAttemptAt: row.nextAttemptAt!.toISOString(),
      recipientBlocker: 'target_setup_required',
      parentBlocker: 'actor_access_required',
    });
    expect(waiting.reasons).toEqual(
      expect.arrayContaining([
        'deadline_elapsed',
        'local_capacity',
        'retry_not_due',
        'lease_active',
        'post_action_unknown',
      ]),
    );
    expect(
      projectPublicationSavedDelivery({ ...row, lockedAt: new Date('2027-01-01') }).waiting.reasons,
    ).toContain('lease_invalid');
  });
  it('does not classify explicit retry authorization as a blocker or use inverted authority', () => {
    const row = deliveryFixture({
      parentBlockerCode: 'PUBLISHER_EXPLICIT_RETRY',
      retryAuthorizedAt: new Date('2026-10-17T00:09:00Z'),
      retryExpiresAt: new Date('2026-10-17T00:08:00Z'),
    });
    expect(projectPublicationSavedDelivery(row).waiting).toMatchObject({
      deadline: 'unknown',
      parentBlocker: null,
    });
  });
  it('keeps remote disagreement, started unknown and missing handoff marker fenced', () => {
    const row = deliveryFixture();
    expect(
      projectPublicationDeliveryEvidence(row, [ledger(row, { remoteMessageId: 'other' })]),
    ).toMatchObject({ action: { state: 'unknown' }, recipient: { agreesWithAction: false } });
    expect(
      projectPublicationDeliveryEvidence(row, [
        ledger(row, {
          remoteMessageId: null,
          completedAt: null,
          status: 'IN_PROGRESS',
          terminal: false,
        }),
      ]).action.state,
    ).toBe('unknown');
    const sending = deliveryFixture({
      status: 'SENDING',
      effectiveStatus: 'SENDING',
      remoteMessageId: null,
      sentAt: null,
    });
    expect(projectPublicationDeliveryEvidence(sending, [ledger(row)]).action.state).toBe('unknown');
    expect(
      projectPublicationDeliveryEvidence({ ...sending, hasDispatchMarker: true }, [ledger(row)])
        .action.state,
    ).toBe('confirmed');
  });
  it.each(['action', 'chat', 'source', 'bot', 'metadata'] as const)(
    'does not confirm mismatched or incomplete %s ledger proof',
    (failure) => {
      const row = deliveryFixture(),
        patch: Partial<PublicationDeliveryLedgerRow> =
          failure === 'action'
            ? { actionType: 'DELETE_MESSAGE' }
            : failure === 'chat'
              ? { chatId: 'other' }
              : failure === 'source'
                ? { sourceTag: 'other' }
                : failure === 'bot'
                  ? { dispatchBotId: 'other' }
                  : { requiredBotId: null };
      expect(projectPublicationDeliveryEvidence(row, [ledger(row, patch)]).action.state).not.toBe(
        'confirmed',
      );
    },
  );
  it('uses immutable current content/attempt identity and bounded eligible legacy fallback', () => {
    const row = deliveryFixture({ attemptCount: 3, lockedAt: new Date('2026-10-17T00:01:00Z') }),
      keys = publicationDeliveryEvidenceKeys(row)!;
    expect(keys.currentKey).toContain('content:publication-saved-content:attempt:3');
    const old = ledger(row, { jobId: keys.legacyKey });
    expect(projectPublicationDeliveryEvidence(row, [old]).action).toMatchObject({
      keyBasis: 'legacy',
      state: 'confirmed',
    });
    expect(projectPublicationDeliveryEvidence({ ...row, lockedAt: null }, [old]).action.state).toBe(
      'unknown',
    );
    expect(
      projectPublicationDeliveryEvidence(row, [old, ledger(row, { ambiguous: true })]).action,
    ).toMatchObject({ keyBasis: 'current', state: 'unknown' });
  });
  it('does not turn absent ledger or canceled recipient into no-effect or retry permission', () => {
    const row = deliveryFixture({ status: 'CANCELED', effectiveStatus: 'CANCELED' });
    expect(projectPublicationDeliveryEvidence(row, [])).toMatchObject({
      action: { state: 'unknown' },
      recipient: { state: 'saved' },
      automaticRetryAllowed: false,
    });
  });

  it('binds a saved newer revision only through retained explicit retry timing', () => {
    const row = deliveryFixture({
      contentCreatedAt: new Date('2026-10-17T00:01:00Z'),
      retryAuthorizedAt: new Date('2026-10-17T00:02:00Z'),
      retryExpiresAt: new Date('2026-10-18T00:02:00Z'),
    });
    expect(projectPublicationSavedDelivery(row).binding).toBe('exact');
    expect(projectPublicationSavedDelivery({ ...row, retryAuthorizedAt: null }).binding).toBe(
      'invalid_evidence',
    );
    expect(
      projectPublicationSavedDelivery({
        ...row,
        retryAuthorizedAt: new Date('2026-10-17T00:00:30Z'),
      }).binding,
    ).toBe('invalid_evidence');
  });

  it('rejects receipt and ledger clocks that predate the immutable saved content', () => {
    const row = deliveryFixture({
      contentCreatedAt: new Date('2026-10-17T00:05:00Z'),
      retryAuthorizedAt: new Date('2026-10-17T00:06:00Z'),
      retryExpiresAt: new Date('2026-10-18T00:06:00Z'),
    });
    expect(projectPublicationSavedDelivery(row).recipient.state).toBe('invalid_evidence');
    expect(projectPublicationDeliveryEvidence(row, [ledger(row)]).action.state).not.toBe(
      'confirmed',
    );
  });

  it('never uses a future or inverted legacy activity clock to authorize fallback evidence', () => {
    const row = deliveryFixture({ attemptCount: 3, lockedAt: new Date('2026-10-17T00:09:00Z') }),
      keys = publicationDeliveryEvidenceKeys(row)!;
    expect(
      projectPublicationDeliveryEvidence(row, [
        ledger(row, { jobId: keys.legacyKey, lastAttemptAt: new Date('2027-01-01') }),
      ]).action,
    ).toMatchObject({ keyBasis: 'unavailable', state: 'unknown' });
    expect(
      projectPublicationDeliveryEvidence(row, [
        ledger(row, {
          jobId: keys.legacyKey,
          lastAttemptAt: new Date('2026-10-17T00:09:30Z'),
          completedAt: new Date('2025-01-01'),
        }),
      ]).action.state,
    ).toBe('unknown');
  });

  it('preserves AMBIGUOUS ledger status even when its boolean marker disagrees', () => {
    const row = deliveryFixture();
    expect(
      projectPublicationDeliveryEvidence(row, [
        ledger(row, { status: 'AMBIGUOUS', ambiguous: false }),
      ]).action.state,
    ).toBe('unknown');
  });
});
