import type {
  SafetyDeskPublicationDeliveryEvidenceResponse as Evidence,
  SafetyDeskPublicationDeliveryWaiting,
  SafetyDeskPublicationDeliveryWaitReason,
} from '@maxim/contracts/safety-desk';
import type {
  ManagedBroadcastDelivery,
  ManagedBroadcastDeliveryStatus,
  PublicationDispatchProfile,
  MaxActionLedgerEntry,
} from '../prisma/prisma-client';
import { hasPublicationDeliveryAutomatedVerificationState } from './publication-delivery-verification-state';
import {
  MANAGED_BROADCAST_LOCK_STALE_MS,
  PUBLICATION_POST_SEND_STABILITY_WINDOW_MS,
} from './admin.service.support';
import {
  resolvePublicationDispatchIssue,
  PUBLISHER_EXPLICIT_RETRY_CODE,
} from './publication-dispatch-issue';
import { buildPublicationDeliveryActionKey } from './publication-delivery-action-key';

export type PublicationDeliveryEvidenceRow = Pick<
  ManagedBroadcastDelivery,
  | 'id'
  | 'broadcastId'
  | 'occurrenceIndex'
  | 'targetChatId'
  | 'botId'
  | 'requiredBotId'
  | 'publicationOccurrenceId'
  | 'contentRevisionId'
  | 'dispatchProfile'
  | 'status'
  | 'createdAt'
  | 'attemptCount'
  | 'remoteMessageId'
  | 'sentAt'
  | 'legacySentWithoutRemoteId'
  | 'lockedAt'
  | 'remoteMessageVerifiedAt'
  | 'remoteMessageVerificationAttemptCount'
  | 'remoteMessageVerificationAbsentCount'
  | 'remoteMessageVerificationPresentCount'
  | 'remoteMessageVerificationAttemptedAt'
  | 'remoteMessageVerificationNextAt'
  | 'remoteMessageVerificationSource'
  | 'nextAttemptAt'
  | 'firstDeferredAt'
  | 'lastDeferredAt'
  | 'capacityDeferralCount'
  | 'rateLimitDeferralCount'
  | 'dispatchBlockedAt'
  | 'pinStatus'
  | 'deleteStatus'
  | 'postActionsNextAt'
  | 'waitReason'
  | 'dispatchBlockerCode'
> & {
  effectiveStatus: ManagedBroadcastDeliveryStatus;
  hasLockToken: boolean;
  hasDispatchMarker: boolean;
  hasVerificationError: boolean;
  parentBroadcastId: string | null;
  broadcastOccurrenceId: string | null;
  broadcastProfile: PublicationDispatchProfile | null;
  broadcastRequiredBotId: string | null;
  broadcastCreatedAt: Date | null;
  parentOccurrenceId: string | null;
  publicationId: string | null;
  occurrenceRequiredBotId: string | null;
  occurrenceProfile: PublicationDispatchProfile | null;
  occurrenceCreatedAt: Date | null;
  scheduledAt: Date | null;
  deliveryDeadlineAt: Date | null;
  retryAuthorizedAt: Date | null;
  retryExpiresAt: Date | null;
  parentBlockerCode: string | null;
  parentBlockedAt: Date | null;
  parentContentRevisionId: string | null;
  contentPublicationId: string | null;
  contentCreatedAt: Date | null;
  observedAt: Date;
};
export type PublicationDeliveryLedgerRow = Pick<
  MaxActionLedgerEntry,
  | 'jobId'
  | 'actionType'
  | 'chatId'
  | 'sourceTag'
  | 'botId'
  | 'dispatchBotId'
  | 'status'
  | 'ambiguous'
  | 'terminal'
  | 'dispatchStartedAt'
  | 'remoteMessageId'
  | 'firstAttemptAt'
  | 'lastAttemptAt'
  | 'completedAt'
  | 'createdAt'
> & { hasDispatchToken: boolean; requiredBotId: string | null };
export const finiteDate = (date: Date | null | undefined): date is Date =>
  date instanceof Date && Number.isFinite(date.getTime());
const identity = (value: string | null | undefined): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 512 && value.trim() === value;
const within = (value: Date | null | undefined, from: Date, to: Date): value is Date =>
  finiteDate(value) && value >= from && value <= to;
const iso = (value: Date | null | undefined) => (finiteDate(value) ? value.toISOString() : null);

export function projectPublicationDeliveryBinding(
  row: PublicationDeliveryEvidenceRow,
): Evidence['binding'] {
  if (
    row.publicationOccurrenceId === null ||
    row.contentRevisionId === null ||
    row.requiredBotId === null
  )
    return 'not_recorded';
  if (
    ![
      row.id,
      row.broadcastId,
      row.publicationOccurrenceId,
      row.contentRevisionId,
      row.requiredBotId,
      row.targetChatId,
      row.parentBroadcastId,
      row.broadcastOccurrenceId,
      row.broadcastRequiredBotId,
      row.parentOccurrenceId,
      row.publicationId,
      row.occurrenceRequiredBotId,
      row.parentContentRevisionId,
      row.contentPublicationId,
    ].every(identity) ||
    row.dispatchProfile !== 'PUBLIK_V1' ||
    row.parentBroadcastId !== row.broadcastId ||
    row.broadcastOccurrenceId !== row.publicationOccurrenceId ||
    row.parentOccurrenceId !== row.publicationOccurrenceId ||
    row.parentContentRevisionId !== row.contentRevisionId ||
    row.contentPublicationId !== row.publicationId ||
    row.broadcastProfile !== 'PUBLIK_V1' ||
    row.occurrenceProfile !== 'PUBLIK_V1' ||
    row.broadcastRequiredBotId !== row.requiredBotId ||
    row.occurrenceRequiredBotId !== row.requiredBotId ||
    !Number.isSafeInteger(row.occurrenceIndex) ||
    row.occurrenceIndex < 1 ||
    !Number.isSafeInteger(row.attemptCount) ||
    row.attemptCount < 0 ||
    !finiteDate(row.createdAt) ||
    row.createdAt > row.observedAt
  )
    return 'invalid_evidence';
  if (
    ![row.broadcastCreatedAt, row.occurrenceCreatedAt].every(
      (value) => finiteDate(value) && value <= row.createdAt,
    )
  )
    return 'invalid_evidence';
  // FLAG: An explicit latest-content retry keeps this recipient's original creation
  // time. Its saved revision may be newer; the retained retry clock must attest that.
  if (
    !finiteDate(row.contentCreatedAt) ||
    row.contentCreatedAt > row.observedAt ||
    (row.contentCreatedAt > row.createdAt &&
      !within(row.retryAuthorizedAt, row.contentCreatedAt, row.observedAt))
  )
    return 'invalid_evidence';
  return 'exact';
}
function receipt(
  row: PublicationDeliveryEvidenceRow,
  binding: Evidence['binding'],
): Evidence['recipient']['state'] {
  if (row.legacySentWithoutRemoteId) return 'legacy_unproven';
  if (row.remoteMessageId === null) return 'missing';
  return binding === 'exact' &&
    identity(row.remoteMessageId) &&
    identity(row.botId) &&
    row.botId === row.requiredBotId &&
    within(row.sentAt, row.createdAt, row.observedAt) &&
    finiteDate(row.contentCreatedAt) &&
    row.sentAt >= row.contentCreatedAt
    ? 'saved'
    : 'invalid_evidence';
}
function verification(
  row: PublicationDeliveryEvidenceRow,
  saved: Evidence['recipient']['state'],
): Evidence['verification']['state'] {
  if (
    saved === 'legacy_unproven' ||
    row.remoteMessageVerificationSource === 'LEGACY_SINGLE_OBSERVATION'
  )
    return 'legacy_unproven';
  const counts = [
    row.remoteMessageVerificationAttemptCount,
    row.remoteMessageVerificationAbsentCount,
    row.remoteMessageVerificationPresentCount,
  ];
  if (
    counts.some((value) => !Number.isSafeInteger(value) || value < 0) ||
    row.remoteMessageVerificationPresentCount > row.remoteMessageVerificationAttemptCount ||
    row.remoteMessageVerificationAbsentCount > row.remoteMessageVerificationAttemptCount
  )
    return 'invalid_evidence';
  if (row.remoteMessageVerificationSource === 'MANUAL_CONFIRMED')
    return saved === 'saved' && within(row.remoteMessageVerifiedAt, row.sentAt!, row.observedAt)
      ? 'operator_confirmed'
      : 'invalid_evidence';
  if (row.remoteMessageVerificationSource === 'AUTOMATED_STABLE')
    return saved === 'saved' &&
      within(
        row.remoteMessageVerifiedAt,
        new Date(row.sentAt!.getTime() + PUBLICATION_POST_SEND_STABILITY_WINDOW_MS),
        row.observedAt,
      ) &&
      within(row.remoteMessageVerificationAttemptedAt, row.sentAt!, row.observedAt) &&
      row.remoteMessageVerificationAttemptedAt!.getTime() ===
        row.remoteMessageVerifiedAt!.getTime() &&
      row.remoteMessageVerificationPresentCount >= 2 &&
      row.remoteMessageVerificationAbsentCount === 0 &&
      row.remoteMessageVerificationNextAt === null &&
      !row.hasVerificationError
      ? 'automated_stable'
      : 'invalid_evidence';
  if (row.remoteMessageVerificationSource !== null) return 'invalid_evidence';
  if (row.remoteMessageVerifiedAt) return 'legacy_unproven';
  if (!hasPublicationDeliveryAutomatedVerificationState(row)) return 'not_recorded';
  if (
    saved !== 'saved' ||
    (row.remoteMessageVerificationAttemptedAt !== null &&
      !within(row.remoteMessageVerificationAttemptedAt, row.sentAt!, row.observedAt)) ||
    (row.remoteMessageVerificationNextAt !== null &&
      (!finiteDate(row.remoteMessageVerificationNextAt) ||
        row.remoteMessageVerificationNextAt < row.sentAt!))
  )
    return 'invalid_evidence';
  return row.status === 'SENT' ? 'pending' : 'not_recorded';
}
// FLAG: Saved deadlines describe evidence, never renew or authorize a dispatch.
export function projectPublicationSavedDeadline(
  row: Pick<
    PublicationDeliveryEvidenceRow,
    | 'scheduledAt'
    | 'deliveryDeadlineAt'
    | 'retryAuthorizedAt'
    | 'retryExpiresAt'
    | 'parentBlockerCode'
    | 'parentBlockedAt'
    | 'occurrenceCreatedAt'
  >,
  observedAt: Date,
): SafetyDeskPublicationDeliveryWaiting['deadline'] {
  if (!finiteDate(row.scheduledAt)) return 'unknown';
  const original =
    finiteDate(row.deliveryDeadlineAt) && row.deliveryDeadlineAt >= row.scheduledAt
      ? row.deliveryDeadlineAt
      : null;
  const retryPresent =
    row.retryAuthorizedAt !== null ||
    row.retryExpiresAt !== null ||
    row.parentBlockerCode === PUBLISHER_EXPLICIT_RETRY_CODE;
  const retryValid =
    finiteDate(row.occurrenceCreatedAt) &&
    within(row.retryAuthorizedAt, row.occurrenceCreatedAt, observedAt) &&
    finiteDate(row.retryExpiresAt) &&
    row.retryExpiresAt >= row.retryAuthorizedAt;
  const effective = !retryPresent
    ? original
    : retryValid && original
      ? new Date(Math.max(original.getTime(), row.retryExpiresAt!.getTime()))
      : retryValid && row.retryExpiresAt! >= observedAt
        ? row.retryExpiresAt
        : null;
  if (row.scheduledAt > observedAt) return 'future';
  return !effective ? 'unknown' : effective < observedAt ? 'expired' : 'due';
}
function blocker(code: string | null): SafetyDeskPublicationDeliveryWaiting['recipientBlocker'] {
  const issue = resolvePublicationDispatchIssue([code]);
  if (!issue) return null;
  if (issue === 'actor_access_required' || issue === 'target_setup_required') return issue;
  return ['PUBLISHER_RUNTIME_UNAVAILABLE', 'PUBLISHER_AUTH_PAUSED'].includes(
    code?.trim().toUpperCase() ?? '',
  )
    ? 'publisher_unavailable'
    : 'other_blocker';
}
export function projectPublicationSavedDelivery(
  row: PublicationDeliveryEvidenceRow,
): Pick<Evidence, 'binding' | 'recipient' | 'verification' | 'waiting'> {
  const binding = projectPublicationDeliveryBinding(row),
    saved = receipt(row, binding),
    verified = verification(row, saved);
  const deadline =
    binding === 'exact' ? projectPublicationSavedDeadline(row, row.observedAt) : 'unknown';
  const reasons = new Set<SafetyDeskPublicationDeliveryWaitReason>();
  const pending = ['PENDING', 'SENDING'].includes(row.status);
  if (deadline === 'future') reasons.add('scheduled_not_due');
  if (deadline === 'expired') reasons.add('deadline_elapsed');
  if (deadline === 'unknown') reasons.add('deadline_unknown');
  if (row.waitReason)
    reasons.add(
      row.waitReason === 'local_capacity' ||
        row.waitReason === 'max_rate_limit' ||
        row.waitReason === 'circuit_open'
        ? row.waitReason
        : 'other_capacity_reason',
    );
  if (finiteDate(row.nextAttemptAt))
    reasons.add(row.nextAttemptAt > row.observedAt ? 'retry_not_due' : 'retry_due');
  const recipientBlocker = blocker(row.dispatchBlockerCode),
    parentBlocker = blocker(row.parentBlockerCode);
  if (recipientBlocker) reasons.add(recipientBlocker);
  if (row.lockedAt !== null || row.hasLockToken)
    reasons.add(
      !within(row.lockedAt, new Date(0), row.observedAt) || !row.hasLockToken
        ? 'lease_invalid'
        : row.lockedAt.getTime() >= row.observedAt.getTime() - MANAGED_BROADCAST_LOCK_STALE_MS
          ? 'lease_active'
          : 'lease_stale',
    );
  if (verified === 'pending')
    reasons.add(
      finiteDate(row.remoteMessageVerificationNextAt) &&
        row.remoteMessageVerificationNextAt > row.observedAt
        ? 'receipt_verification_wait'
        : 'receipt_verification_due',
    );
  if (row.status === 'SENT' && verified === 'not_recorded')
    reasons.add('verification_not_enrolled');
  const obligations = [row.pinStatus, row.deleteStatus];
  if (obligations.some((status) => status === 'AMBIGUOUS' || status === 'FAILED'))
    reasons.add('post_action_unknown');
  if (obligations.some((status) => status === 'PENDING' || status === 'RUNNING'))
    reasons.add(
      !finiteDate(row.postActionsNextAt)
        ? 'post_action_unknown'
        : row.postActionsNextAt > row.observedAt
          ? 'post_action_wait'
          : 'post_action_due',
    );
  if (row.effectiveStatus === 'AMBIGUOUS') reasons.add('effect_unknown');
  if (pending && reasons.size === 0) reasons.add('unspecified_pending');
  const first = within(row.firstDeferredAt, row.createdAt, row.observedAt)
    ? row.firstDeferredAt
    : null;
  return {
    binding,
    recipient: { state: saved, savedSendAt: iso(row.sentAt), agreesWithAction: null },
    verification: { state: verified, observedAt: iso(row.remoteMessageVerifiedAt) },
    waiting: {
      reasons: [...reasons],
      reasonsOverlap: true,
      deadline,
      nextAttemptAt: iso(row.nextAttemptAt),
      firstDeferredAt: iso(row.firstDeferredAt),
      lastDeferredAt: iso(row.lastDeferredAt),
      ageSinceFirstDeferralMs: first ? row.observedAt.getTime() - first.getTime() : null,
      recipientBlocker,
      parentBlocker,
      postActions: {
        pin: row.pinStatus,
        deletion: row.deleteStatus,
        nextAt: iso(row.postActionsNextAt),
      },
    },
  };
}
export function publicationDeliveryEvidenceKeys(
  row: PublicationDeliveryEvidenceRow,
): { currentKey: string; legacyKey: string } | null {
  if (projectPublicationDeliveryBinding(row) !== 'exact' || !row.contentRevisionId) return null;
  const input = {
    broadcastId: row.broadcastId,
    occurrenceIndex: row.occurrenceIndex,
    targetChatId: row.targetChatId,
    contentRevisionId: row.contentRevisionId,
  };
  return {
    currentKey: buildPublicationDeliveryActionKey({ ...input, attemptCount: row.attemptCount }),
    legacyKey: buildPublicationDeliveryActionKey(input),
  };
}
export function projectPublicationDeliveryEvidence(
  row: PublicationDeliveryEvidenceRow,
  ledgers: readonly PublicationDeliveryLedgerRow[],
): Evidence {
  const saved = projectPublicationSavedDelivery(row),
    keys = publicationDeliveryEvidenceKeys(row);
  let action: Evidence['action'] = {
    keyBasis: 'unavailable',
    state: 'not_recorded',
    dispatchStartedAt: null,
    journalCompletedAt: null,
  };
  let selected = keys ? ledgers.find((ledger) => ledger.jobId === keys.currentKey) : undefined;
  if (selected) action.keyBasis = 'current';
  if (!selected && keys && keys.legacyKey !== keys.currentKey) {
    const legacy = ledgers.find((ledger) => ledger.jobId === keys.legacyKey);
    const activityClocksValid =
      legacy &&
      finiteDate(legacy.createdAt) &&
      legacy.createdAt <= row.observedAt &&
      [legacy.lastAttemptAt, legacy.dispatchStartedAt, legacy.completedAt].every(
        (value) => value === null || within(value, legacy.createdAt, row.observedAt),
      ) &&
      (legacy.dispatchStartedAt === null ||
        legacy.completedAt === null ||
        legacy.completedAt >= legacy.dispatchStartedAt);
    const activity = legacy
      ? Math.max(
          ...[legacy.lastAttemptAt, legacy.dispatchStartedAt, legacy.completedAt]
            .filter(finiteDate)
            .map((value) => value.getTime()),
        )
      : -Infinity;
    if (
      legacy &&
      activityClocksValid &&
      within(row.lockedAt, row.createdAt, row.observedAt) &&
      activity >= row.lockedAt.getTime()
    ) {
      selected = legacy;
      action.keyBasis = 'legacy';
    } else if (legacy) action.state = 'unknown';
  }
  if (saved.binding === 'invalid_evidence') action.state = 'invalid_evidence';
  else if (selected) {
    const expected = row.requiredBotId;
    const mismatch =
      selected.actionType !== 'SEND_MESSAGE' ||
      selected.sourceTag !== 'managed_broadcast' ||
      selected.chatId !== row.targetChatId ||
      (selected.requiredBotId !== null && selected.requiredBotId !== expected) ||
      (selected.dispatchBotId !== null && selected.dispatchBotId !== expected) ||
      (selected.botId !== null && selected.botId !== expected);
    const exact =
      saved.binding === 'exact' &&
      selected.requiredBotId === expected &&
      selected.dispatchBotId === expected;
    const started =
      selected.hasDispatchToken ||
      selected.dispatchStartedAt !== null ||
      selected.dispatchBotId !== null;
    const contentClock =
      finiteDate(row.contentCreatedAt) &&
      within(selected.createdAt, row.contentCreatedAt, row.observedAt);
    const clocks =
      contentClock &&
      within(selected.createdAt, row.createdAt, row.observedAt) &&
      within(selected.dispatchStartedAt, selected.createdAt, row.observedAt) &&
      within(selected.completedAt, selected.dispatchStartedAt!, row.observedAt);
    const remote = identity(selected.remoteMessageId);
    const handoff =
      row.status !== 'SENDING' || saved.recipient.state === 'saved' || row.hasDispatchMarker;
    const disagreement =
      row.remoteMessageId !== null &&
      selected.remoteMessageId !== null &&
      (row.remoteMessageId !== selected.remoteMessageId ||
        row.botId !== selected.dispatchBotId ||
        saved.recipient.state !== 'saved');
    saved.recipient.agreesWithAction =
      remote && identity(row.remoteMessageId) ? !disagreement : null;
    action = {
      ...action,
      dispatchStartedAt: iso(selected.dispatchStartedAt),
      journalCompletedAt: iso(selected.completedAt),
      state: mismatch
        ? 'invalid_evidence'
        : !handoff || disagreement || selected.ambiguous || selected.status === 'AMBIGUOUS'
          ? 'unknown'
          : exact && remote && clocks && selected.status === 'SUCCEEDED' && selected.terminal
            ? 'confirmed'
            : exact &&
                contentClock &&
                remote &&
                within(selected.dispatchStartedAt, selected.createdAt, row.observedAt)
              ? 'acknowledged'
              : started
                ? 'unknown'
                : selected.terminal
                  ? 'stopped'
                  : 'pending',
    };
  } else if (
    row.effectiveStatus === 'AMBIGUOUS' ||
    row.status === 'SENDING' ||
    row.remoteMessageId !== null
  )
    action.state = 'unknown';
  return {
    schemaVersion: 1,
    observedAt: row.observedAt.toISOString(),
    deliveryId: row.id,
    storedStatus: row.status,
    effectiveStatus: row.effectiveStatus,
    acceptedAt: row.createdAt.toISOString(),
    completionTimingEvidence: 'not_recorded',
    ...saved,
    action,
    clientVisibility: 'not_observed',
    automaticRetryAllowed: false,
  };
}
