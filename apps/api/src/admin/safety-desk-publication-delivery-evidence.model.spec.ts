import {
  projectPublicationDeliveryEvidence,
  projectPublicationSavedDelivery,
  publicationDeliveryEvidenceKeys,
  type PublicationDeliveryLedgerRow,
  type PublicationDeliveryEvidenceRow,
} from './safety-desk-publication-delivery-evidence.model';

import { deliveryFixture } from './safety-desk-publication-delivery-test-fixture';
function contextFixture(patch: Partial<PublicationDeliveryEvidenceRow> = {}) {
  const row = deliveryFixture();
  return deliveryFixture({
    contextRecorded: true,
    broadcastStatus: 'ACTIVE',
    broadcastLockedAt: null,
    broadcastHasLockToken: false,
    occurrenceStatus: 'IN_PROGRESS',
    occurrenceScheduleId: 'schedule',
    occurrenceScheduleRevision: 1,
    parentPublicationId: 'publication',
    publicationLifecycle: 'ACTIVE',
    publicationCreatedAt: row.createdAt,
    parentScheduleId: 'schedule',
    schedulePublicationId: 'publication',
    currentScheduleRevision: 1,
    scheduleMode: 'ONCE',
    scheduleStatus: 'ACTIVE',
    scheduleCreatedAt: row.createdAt,
    ...patch,
  });
}
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
  it('includes parent-only wait reasons and deduplicates matching recipient blockers', () => {
    const row = deliveryFixture({
      status: 'PENDING',
      effectiveStatus: 'PENDING',
      remoteMessageId: null,
      sentAt: null,
      parentBlockerCode: 'PUBLISHER_ACTOR_ACCESS_REQUIRED',
    });
    expect(projectPublicationSavedDelivery(row).waiting.reasons).toContain('actor_access_required');
    const matching = projectPublicationSavedDelivery({
      ...row,
      dispatchBlockerCode: row.parentBlockerCode,
    }).waiting.reasons;
    expect(matching.filter((reason) => reason === 'actor_access_required')).toHaveLength(1);
    expect(
      projectPublicationSavedDelivery({ ...row, dispatchBlockerCode: 'bot_not_admin' }).waiting
        .reasons,
    ).toEqual(expect.arrayContaining(['actor_access_required', 'target_setup_required']));
  });
  it('exposes original timing and stopped parents without manufacturing completion or retry', () => {
    const row = contextFixture({
      status: 'PENDING',
      effectiveStatus: 'PENDING',
      remoteMessageId: null,
      sentAt: null,
      broadcastStatus: 'CANCELED',
      occurrenceStatus: 'CANCELED',
      publicationLifecycle: 'CANCELED',
      scheduleStatus: 'CANCELED',
    });
    expect(projectPublicationDeliveryEvidence(row, [])).toMatchObject({
      storedStatus: 'PENDING',
      context: {
        scheduleBinding: 'exact',
        scheduleMode: 'ONCE',
        scheduledAt: row.scheduledAt!.toISOString(),
        deliveryDeadlineAt: row.deliveryDeadlineAt!.toISOString(),
        broadcastStatus: 'CANCELED',
        occurrenceStatus: 'CANCELED',
        publicationLifecycle: 'CANCELED',
        scheduleStatus: 'CANCELED',
        broadcastLease: { state: 'none', lockedAt: null },
      },
      recipient: { state: 'missing' },
      automaticRetryAllowed: false,
    });
  });
  it.each([
    [{ currentScheduleRevision: 2 }, 'revision_changed'],
    [{ schedulePublicationId: 'other' }, 'invalid_evidence'],
    [{ parentScheduleId: null }, 'not_recorded'],
    [{ scheduleCreatedAt: new Date('2027-01-01') }, 'invalid_evidence'],
    [{ occurrenceScheduleRevision: 0 }, 'invalid_evidence'],
  ] as const)(
    'never attributes current mode to unproven schedule facts %j',
    (patch, scheduleBinding) => {
      const result = projectPublicationDeliveryEvidence(contextFixture(patch), []);
      expect(result.context).toMatchObject({ scheduleBinding, scheduleMode: 'UNKNOWN' });
      expect(result.automaticRetryAllowed).toBe(false);
    },
  );
  it('keeps old diagnostic responses compatible and distinguishes parent lease states', () => {
    expect(projectPublicationDeliveryEvidence(deliveryFixture(), [])).not.toHaveProperty('context');
    const row = contextFixture();
    for (const [lockedAt, hasToken, state] of [
      [row.observedAt, true, 'active'],
      [row.createdAt, true, 'stale'],
      [row.observedAt, false, 'invalid_evidence'],
      [new Date('2027-01-01'), true, 'invalid_evidence'],
    ] as const) {
      expect(
        projectPublicationDeliveryEvidence(
          {
            ...row,
            broadcastLockedAt: lockedAt,
            broadcastHasLockToken: hasToken,
          },
          [],
        ).context?.broadcastLease.state,
      ).toBe(state);
    }
  });
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
