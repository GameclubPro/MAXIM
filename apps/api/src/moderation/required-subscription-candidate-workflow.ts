import type { RequiredSubscriptionMediaNoticeScope } from './required-subscription-media-notice';
import type { RequiredSubscriptionNoticeAuthority } from './required-subscription-notice-authority';
import type { RequiredSubscriptionNoticePlan } from './required-subscription-notice-plan';
import { REQUIRED_SUBSCRIPTION_MAX_CHANNELS } from '@maxim/contracts';
import {
  executeRuleFollowupSanction,
  RuleFollowupBanOutcomeUnknownError,
  RuleFollowupSanctionDeferredError,
  type RuleFollowupSanctionState,
  type RuleFollowupBanOutcome,
  type FrozenRuleFollowupSanctionPlan,
  type RuleFollowupSanctionDependencies,
  type RuleFollowupSanctionJournal,
} from './moderation-rule-followup-sanction';

export type RequiredSubscriptionCandidateSource = Readonly<{
  version: 1;
  chatId: string;
  userId: string;
  messageId: string;
  sourceAtMs: number;
  deadlineAtMs: number;
  policySha256: string;
  originBotId: string | null;
  updateType: 'message_created' | 'message_edited';
  mediaScope: RequiredSubscriptionMediaNoticeScope | null;
  userLabel: string;
  maskedExcerpt: string | null;
  rulesPublishedUrl: string | null;
  rulesPublishedMessageId: string | null;
}>;

export type RequiredSubscriptionCandidateQualification = Readonly<{
  requiredChannelIds: readonly string[];
  missingChannelIds: readonly string[];
}>;

export type FrozenRequiredSubscriptionCandidatePlan = Readonly<{
  version: 1;
  candidateId: string;
  source: RequiredSubscriptionCandidateSource;
  qualification: RequiredSubscriptionCandidateQualification;
  violationCount24h: number;
  sanction: FrozenRuleFollowupSanctionPlan;
  notice: RequiredSubscriptionNoticePlan & {
    executionProof: RequiredSubscriptionNoticeAuthority;
  };
}>;

export type RequiredSubscriptionCandidateReadRetry = Readonly<{
  kind: 'retry_read';
  retryAfterMs?: number;
}>;

type CandidateSourceReceipt = Readonly<{
  candidateId: string;
  chatId: string;
  userId: string;
  messageId: string;
  sourceAtMs: number;
  deadlineAtMs: number;
  policySha256: string;
}>;

export type RequiredSubscriptionCandidateNoticeReceipt = CandidateSourceReceipt &
  Readonly<{
    kind: 'notice_handoff' | 'media_coverage';
    noticeKey: string;
    receiptId: string;
  }>;

export type RequiredSubscriptionCandidateDeleteReceipt = CandidateSourceReceipt &
  Readonly<{
    intentId: string;
    reasonKey: 'REQUIRED_SUBSCRIPTION:message-delete';
    rollout: 'execute';
    status:
      | 'PENDING'
      | 'IN_PROGRESS'
      | 'RETRYABLE'
      | 'WAITING_CAPABILITY'
      | 'SUCCEEDED'
      | 'ALREADY_ABSENT';
  }>;

export type RequiredSubscriptionCandidateHandoff<Receipt> =
  | Readonly<{ kind: 'committed'; receipt: Receipt }>
  | Readonly<{ kind: 'revoked'; reason: string }>
  | RequiredSubscriptionCandidateReadRetry
  | Readonly<{ kind: 'effect_unknown' }>;

export type RequiredSubscriptionCandidateWorkflowOutcome =
  | RequiredSubscriptionCandidateReadRetry
  | Readonly<{ kind: 'not_actionable'; reason: string }>
  | Readonly<{ kind: 'foreign_claim_blocked' }>
  | Readonly<{ kind: 'expired' }>
  | Readonly<{ kind: 'effect_unknown'; effect: 'sanction' | 'notice' | 'delete' }>
  | Readonly<{
      kind: 'delete_transferred';
      receipt: RequiredSubscriptionCandidateDeleteReceipt;
    }>;

export type RequiredSubscriptionCandidateWorkflowInput = Readonly<{
  candidateId: string;
  source: RequiredSubscriptionCandidateSource;
}> &
  (
    | Readonly<{ frozenPlan: FrozenRequiredSubscriptionCandidatePlan | null }>
    | Readonly<{
        noticeReceipt: RequiredSubscriptionCandidateNoticeReceipt & { kind: 'media_coverage' };
      }>
  );

export interface RequiredSubscriptionCandidateWorkflowDependencies {
  now(): number;
  assertOwned(): Promise<void>;
  qualify(source: RequiredSubscriptionCandidateSource): Promise<
    | RequiredSubscriptionCandidateReadRetry
    | Readonly<{ kind: 'not_actionable'; reason: string }>
    | Readonly<{
        kind: 'qualified';
        qualification: RequiredSubscriptionCandidateQualification;
      }>
  >;
  // FLAG: The adapter commits its exact claim, one violation, frozen decision and
  // candidate binding atomically under the live candidate lease. A false/duplicate
  // claim is never sufficient proof that this candidate owns continuation.
  freezeOwnClaimAndDecision(input: {
    source: RequiredSubscriptionCandidateSource;
    qualification: RequiredSubscriptionCandidateQualification;
    startedAtMs: number;
  }): Promise<
    | Readonly<{ kind: 'owned'; plan: FrozenRequiredSubscriptionCandidatePlan }>
    | Readonly<{ kind: 'foreign_claim_blocked' }>
    | Readonly<{ kind: 'authority_revoked'; reason: string }>
  >;
  sanctionJournal: RuleFollowupSanctionJournal;
  sanctionDependencies(
    plan: FrozenRequiredSubscriptionCandidatePlan,
    context: { receiptOnly: boolean; assertOwned: () => Promise<void> },
  ): Omit<RuleFollowupSanctionDependencies, 'sendNotice' | 'recordReputation'>;
  handoffNotice(
    plan: FrozenRequiredSubscriptionCandidatePlan,
  ): Promise<RequiredSubscriptionCandidateHandoff<RequiredSubscriptionCandidateNoticeReceipt>>;
  handoffDelete(
    source: RequiredSubscriptionCandidateSource,
    noticeReceipt: RequiredSubscriptionCandidateNoticeReceipt,
  ): Promise<RequiredSubscriptionCandidateHandoff<RequiredSubscriptionCandidateDeleteReceipt>>;
  // FLAG: Every transition, including retry/unknown and terminal settlement, must
  // use the exact live SQL lease CAS. An unknown effect retains receipt recovery.
  settle(outcome: RequiredSubscriptionCandidateWorkflowOutcome): Promise<void>;
}

export class RequiredSubscriptionCandidateInvalidError extends Error {
  readonly code = 'required_subscription_candidate_invalid';
}

export function readRequiredSubscriptionCandidateSource(
  value: unknown,
): RequiredSubscriptionCandidateSource | null {
  const row = record(value);
  if (
    row.version !== 1 ||
    !['chatId', 'userId', 'messageId', 'userLabel'].every((key) => text(row[key], 1_024)) ||
    !positiveTime(row.sourceAtMs) ||
    !positiveTime(row.deadlineAtMs) ||
    row.deadlineAtMs !== Number(row.sourceAtMs) + 300_000 ||
    !sha256(row.policySha256) ||
    !nullableText(row.originBotId, 1_024) ||
    !['message_created', 'message_edited'].includes(String(row.updateType)) ||
    !nullableText(row.maskedExcerpt, 8_192, true) ||
    !nullableText(row.rulesPublishedUrl, 2_048) ||
    !nullableText(row.rulesPublishedMessageId, 1_024)
  )
    return null;
  const media = record(row.mediaScope);
  if (
    row.mediaScope !== null &&
    (!['media_group', 'burst'].includes(String(media.kind)) ||
      !sha256(media.scopeDigest) ||
      !positiveTime(media.sourceCreatedAtMs) ||
      Number(media.sourceCreatedAtMs) > Number(row.sourceAtMs))
  )
    return null;
  return Object.freeze({
    version: 1,
    chatId: row.chatId as string,
    userId: row.userId as string,
    messageId: row.messageId as string,
    sourceAtMs: row.sourceAtMs as number,
    deadlineAtMs: row.deadlineAtMs as number,
    policySha256: row.policySha256 as string,
    originBotId: row.originBotId as string | null,
    updateType: row.updateType as RequiredSubscriptionCandidateSource['updateType'],
    mediaScope:
      row.mediaScope === null
        ? null
        : Object.freeze({
            kind: media.kind as RequiredSubscriptionMediaNoticeScope['kind'],
            scopeDigest: media.scopeDigest as string,
            sourceCreatedAtMs: media.sourceCreatedAtMs as number,
          }),
    userLabel: row.userLabel as string,
    maskedExcerpt: row.maskedExcerpt as string | null,
    rulesPublishedUrl: row.rulesPublishedUrl as string | null,
    rulesPublishedMessageId: row.rulesPublishedMessageId as string | null,
  });
}

export function readFrozenRequiredSubscriptionCandidatePlan(
  value: unknown,
  source: RequiredSubscriptionCandidateSource,
  candidateId: string,
): FrozenRequiredSubscriptionCandidatePlan | null {
  const row = record(value);
  const ownSource = readRequiredSubscriptionCandidateSource(row.source);
  const expectedSource = readRequiredSubscriptionCandidateSource(source);
  const qualification = readQualification(row.qualification);
  const sanction = record(row.sanction);
  const notice = record(row.notice);
  const proof = record(notice.executionProof);
  const action = sanction.action;
  if (
    row.version !== 1 ||
    row.candidateId !== candidateId ||
    !text(candidateId, 1_024) ||
    !ownSource ||
    !expectedSource ||
    JSON.stringify(ownSource) !== JSON.stringify(expectedSource) ||
    !qualification ||
    !Number.isSafeInteger(row.violationCount24h) ||
    Number(row.violationCount24h) < 1 ||
    !['NONE', 'WARN', 'MUTE', 'BAN'].includes(String(action)) ||
    !positiveTime(sanction.issuedAtMs) ||
    Number(sanction.issuedAtMs) < source.sourceAtMs ||
    Number(sanction.issuedAtMs) >= source.deadlineAtMs ||
    !text(sanction.eventId, 1_024) ||
    !text(sanction.noticeKey, 2_048) ||
    sanction.eventId !== `${candidateId}:decision` ||
    sanction.noticeKey !== `required-subscription:notice:v1:${source.chatId}:${source.messageId}` ||
    !Number.isSafeInteger(sanction.muteDurationHours) ||
    Number(sanction.muteDurationHours) < 0 ||
    Number(sanction.muteDurationHours) > 336 ||
    (action === 'MUTE'
      ? Number(sanction.muteDurationHours) < 1 ||
        sanction.muteExpiresAtMs !==
          Number(sanction.issuedAtMs) + Number(sanction.muteDurationHours) * 3_600_000
      : sanction.muteExpiresAtMs !== null) ||
    notice.version !== 1 ||
    notice.action !== action ||
    !text(notice.renderedText, 64 * 1_024) ||
    !isRecord(notice.messageOptions) ||
    (notice.mediaFieldKey !== null &&
      !['requiredSubscriptionBotMessageText', 'requiredSubscriptionWarnMessageText'].includes(
        String(notice.mediaFieldKey),
      )) ||
    typeof notice.deleteBotMessagesEnabled !== 'boolean' ||
    !Number.isSafeInteger(notice.deleteBotMessagesDelayMinutes) ||
    Number(notice.deleteBotMessagesDelayMinutes) < 0 ||
    proof.version !== 1 ||
    proof.reasonKey !== 'REQUIRED_SUBSCRIPTION:message-delete' ||
    !matchesSource(proof, source)
  )
    return null;
  try {
    const serializedNotice = JSON.stringify(notice);
    if (Buffer.byteLength(serializedNotice, 'utf8') > 64 * 1_024) return null;
    return Object.freeze({
      version: 1,
      candidateId,
      source: ownSource,
      qualification,
      violationCount24h: row.violationCount24h as number,
      sanction: Object.freeze({ ...sanction }) as FrozenRuleFollowupSanctionPlan,
      notice: freezeJson(
        JSON.parse(serializedNotice),
      ) as FrozenRequiredSubscriptionCandidatePlan['notice'],
    });
  } catch {
    return null;
  }
}

export async function executeRequiredSubscriptionCandidateWorkflow(
  input: RequiredSubscriptionCandidateWorkflowInput,
  dependencies: RequiredSubscriptionCandidateWorkflowDependencies,
): Promise<RequiredSubscriptionCandidateWorkflowOutcome> {
  // FLAG: Capture the invocation before any adapter can write. Recovery keeps the
  // original event deadline and its own frozen decision; it never replays a webhook.
  const startedAtMs = dependencies.now();
  const source = readRequiredSubscriptionCandidateSource(input.source);
  if (
    !source ||
    !text(input.candidateId, 1_024) ||
    !positiveTime(startedAtMs) ||
    source.sourceAtMs > startedAtMs
  )
    throw invalid('source');
  const live = () => {
    const now = dependencies.now();
    if (!positiveTime(now)) throw invalid('clock');
    return now >= source.sourceAtMs && now < source.deadlineAtMs;
  };
  const finish = async (outcome: RequiredSubscriptionCandidateWorkflowOutcome) => {
    if (
      outcome.kind === 'retry_read' &&
      outcome.retryAfterMs !== undefined &&
      (!Number.isSafeInteger(outcome.retryAfterMs) || outcome.retryAfterMs <= 0)
    )
      throw invalid('retry');
    await dependencies.assertOwned();
    await dependencies.settle(outcome);
    return outcome;
  };
  await dependencies.assertOwned();
  const transferDelete = async (receipt: RequiredSubscriptionCandidateNoticeReceipt) => {
    if (!validNoticeReceipt(receipt, source, input.candidateId)) throw invalid('notice receipt');
    if (!live()) return finish({ kind: 'expired' });
    await dependencies.assertOwned();
    const result = await dependencies.handoffDelete(source, receipt);
    await dependencies.assertOwned();
    if (result.kind === 'committed') {
      if (!validDeleteReceipt(result.receipt, source, input.candidateId))
        throw invalid('DELETE receipt');
      return finish({ kind: 'delete_transferred', receipt: result.receipt });
    }
    return finish(handoffOutcome(result, 'delete'));
  };
  if ('noticeReceipt' in input) {
    // FLAG: A follower supplies exact durable per-message coverage, never a
    // coordinator boolean. It cannot claim a strike or execute leader sanctions.
    if (input.noticeReceipt.kind !== 'media_coverage') throw invalid('coverage receipt');
    return transferDelete(input.noticeReceipt);
  }
  let plan = input.frozenPlan;
  if (!plan) {
    if (!live()) return finish({ kind: 'expired' });
    const result = await dependencies.qualify(source);
    await dependencies.assertOwned();
    if (result.kind === 'retry_read' || result.kind === 'not_actionable') return finish(result);
    if (result.kind !== 'qualified') throw invalid('qualification result');
    const qualification = readQualification(result.qualification);
    if (!qualification) throw invalid('qualification');
    if (!live()) return finish({ kind: 'expired' });
    const frozen = await dependencies.freezeOwnClaimAndDecision({
      source,
      qualification,
      startedAtMs,
    });
    await dependencies.assertOwned();
    if (frozen.kind === 'foreign_claim_blocked') return finish(frozen);
    if (frozen.kind === 'authority_revoked')
      return finish({ kind: 'not_actionable', reason: frozen.reason });
    plan = frozen.plan;
  }
  const frozen = readFrozenRequiredSubscriptionCandidatePlan(plan, source, input.candidateId);
  if (!frozen || dependencies.sanctionJournal.id !== input.candidateId)
    throw invalid('frozen plan');
  const journal = dependencies.sanctionJournal;
  const state = await journal.readState();
  await dependencies.assertOwned();
  const receiptOnly = !live();
  if (receiptOnly && state.phase === 'UNSTARTED') return finish({ kind: 'expired' });
  const adapter = dependencies.sanctionDependencies(frozen, {
    receiptOnly,
    assertOwned: dependencies.assertOwned,
  });
  const assertLease = async () => {
    await dependencies.assertOwned();
    await journal.assertLease();
  };
  try {
    const applied = await executeRuleFollowupSanction(
      frozen.sanction,
      {
        ...journal,
        assertLease,
        // FLAG: Required subscription does not contribute global-spammer reputation.
        claimReputation: async () => 'done',
        completeReputation: async () => undefined,
      },
      {
        ...adapter,
        authorize: async () => {
          if (!live()) return false;
          await assertLease();
          const allowed = await adapter.authorize();
          await assertLease();
          return allowed && live();
        },
        ban: async (params): Promise<RuleFollowupBanOutcome> => {
          await assertLease();
          if (!live()) return { kind: 'no_effect' };
          return adapter.ban(params);
        },
        persistDeterministicEvent: async (params) => {
          await assertLease();
          const current: RuleFollowupSanctionState = await journal.readState();
          if (!live() && !(frozen.sanction.action === 'BAN' && current.phase === 'BAN_CONFIRMED'))
            throw new CandidateDeadlineReachedError();
          return adapter.persistDeterministicEvent(params);
        },
        recordReputation: async () => undefined,
        // FLAG: The existing core settles only the sanction here. Mandatory notice and
        // DELETE handoffs below retain their independent proofs and ordering.
        sendNotice: async () => undefined,
      },
    );
    await dependencies.assertOwned();
    if (!applied)
      return finish(
        live() ? { kind: 'not_actionable', reason: 'authority_revoked' } : { kind: 'expired' },
      );
  } catch (error) {
    if (error instanceof RuleFollowupBanOutcomeUnknownError)
      return finish({ kind: 'effect_unknown', effect: 'sanction' });
    if (error instanceof CandidateDeadlineReachedError) return finish({ kind: 'expired' });
    if (error instanceof RuleFollowupSanctionDeferredError)
      return finish(live() ? { kind: 'retry_read' } : { kind: 'expired' });
    throw error;
  }
  if (!live()) return finish({ kind: 'expired' });
  await dependencies.assertOwned();
  const notice = await dependencies.handoffNotice(frozen);
  await dependencies.assertOwned();
  if (notice.kind !== 'committed') return finish(handoffOutcome(notice, 'notice'));
  if (
    !validNoticeReceipt(notice.receipt, source, input.candidateId) ||
    (notice.receipt.kind === 'notice_handoff' &&
      notice.receipt.noticeKey !== frozen.sanction.noticeKey)
  )
    throw invalid('notice receipt');
  return transferDelete(notice.receipt);
}

class CandidateDeadlineReachedError extends Error {}

function handoffOutcome(
  result: Exclude<RequiredSubscriptionCandidateHandoff<unknown>, { kind: 'committed' }>,
  effect: 'notice' | 'delete',
): RequiredSubscriptionCandidateWorkflowOutcome {
  if (result.kind === 'revoked') return { kind: 'not_actionable', reason: result.reason };
  if (result.kind === 'effect_unknown') return { kind: 'effect_unknown', effect };
  if (result.kind === 'retry_read') return result;
  throw invalid('handoff result');
}

function validNoticeReceipt(
  value: unknown,
  source: RequiredSubscriptionCandidateSource,
  id: string,
): value is RequiredSubscriptionCandidateNoticeReceipt {
  const row = record(value);
  return (
    row.candidateId === id &&
    matchesSource(row, source) &&
    ['notice_handoff', 'media_coverage'].includes(String(row.kind)) &&
    text(row.noticeKey, 2_048) &&
    text(row.receiptId, 2_048)
  );
}

function validDeleteReceipt(
  value: unknown,
  source: RequiredSubscriptionCandidateSource,
  id: string,
): value is RequiredSubscriptionCandidateDeleteReceipt {
  const row = record(value);
  return (
    row.candidateId === id &&
    matchesSource(row, source) &&
    text(row.intentId, 1_024) &&
    row.reasonKey === 'REQUIRED_SUBSCRIPTION:message-delete' &&
    row.rollout === 'execute' &&
    [
      'PENDING',
      'IN_PROGRESS',
      'RETRYABLE',
      'WAITING_CAPABILITY',
      'SUCCEEDED',
      'ALREADY_ABSENT',
    ].includes(String(row.status))
  );
}

function matchesSource(
  row: Record<string, unknown>,
  source: RequiredSubscriptionCandidateSource,
): boolean {
  return (
    row.chatId === source.chatId &&
    row.userId === source.userId &&
    row.messageId === source.messageId &&
    row.sourceAtMs === source.sourceAtMs &&
    row.deadlineAtMs === source.deadlineAtMs &&
    row.policySha256 === source.policySha256
  );
}

function readQualification(value: unknown): RequiredSubscriptionCandidateQualification | null {
  const row = record(value);
  const required = row.requiredChannelIds;
  const missing = row.missingChannelIds;
  if (
    !Array.isArray(required) ||
    !Array.isArray(missing) ||
    !required.length ||
    !missing.length ||
    required.length > REQUIRED_SUBSCRIPTION_MAX_CHANNELS ||
    new Set(required).size !== required.length ||
    new Set(missing).size !== missing.length ||
    !required.every((id) => text(id, 1_024)) ||
    !missing.every((id) => text(id, 1_024) && required.includes(id))
  )
    return null;
  return Object.freeze({
    requiredChannelIds: Object.freeze([...required]),
    missingChannelIds: Object.freeze([...missing]),
  });
}

function invalid(boundary: string): RequiredSubscriptionCandidateInvalidError {
  return new RequiredSubscriptionCandidateInvalidError(
    `Invalid required subscription candidate ${boundary}`,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}
function text(value: unknown, bytes: number, empty = false): value is string {
  return (
    typeof value === 'string' &&
    (empty || Boolean(value.trim())) &&
    Buffer.byteLength(value, 'utf8') <= bytes
  );
}
function nullableText(value: unknown, bytes: number, empty = false): boolean {
  return value === null || text(value, bytes, empty);
}
function sha256(value: unknown): boolean {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}
function positiveTime(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}
function freezeJson(value: unknown): unknown {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) freezeJson(item);
    Object.freeze(value);
  }
  return value;
}
