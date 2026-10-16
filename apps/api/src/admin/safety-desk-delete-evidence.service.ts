import {
  safetyDeskDeleteEvidenceResponseSchema,
  type SafetyDeskDeleteEvidenceResponse,
} from '@maxim/contracts/safety-desk';
import {
  BadRequestException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { buildMaxActionIdempotencyKey } from '../max/max-action-idempotency';
import { Prisma, type ModerationDeleteIntent } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import {
  DELETE_EVIDENCE_SAMPLE_LIMIT,
  buildDeleteEvidenceFollowupsQuery,
  buildDeleteEvidenceLedgerQuery,
  buildDeleteEvidenceReasonsQuery,
} from './safety-desk-delete-evidence.query';

type ReasonEvidence = SafetyDeskDeleteEvidenceResponse['reasons']['items'][number];
type NoticeEvidence = SafetyDeskDeleteEvidenceResponse['followups']['items'][number]['explanation'];
type IntentEvidence = Pick<
  ModerationDeleteIntent,
  | 'id'
  | 'chatId'
  | 'messageId'
  | 'subjectUserId'
  | 'status'
  | 'createdAt'
  | 'sourceMessageAt'
  | 'firstAttemptAt'
  | 'deleteDispatchStartedAt'
  | 'remoteDeleteSucceededAt'
  | 'remoteDeleteSucceededBotId'
  | 'completedAt'
  | 'absenceVerifiedAt'
  | 'absenceVerifiedBotId'
  | 'absenceVerificationCode'
  | 'originBotId'
  | 'succeededBotId'
>;
export type DeleteFollowupEvidenceRow = {
  id: string;
  chatId: string;
  messageId: string;
  userId: string;
  reasonKey: string;
  ruleCode: string;
  status: string;
  sourceAt: Date;
  deadlineAt: Date;
  completedAt: Date | null;
  policySha256: string;
  originBotId: string | null;
  plan: unknown;
  phase: string | null;
  effectEventId: string | null;
  banBotId: string | null;
  decisionRecorded: boolean;
};
export type DeleteNoticeLedgerRow = {
  jobId: string;
  chatId: string;
  botId: string | null;
  actionType: string;
  status: string;
  terminal: boolean;
  ambiguous: boolean;
  dispatchStartedAt: Date | null;
  completedAt: Date | null;
  remoteMessageId: string | null;
  followupProof: unknown;
  noticeProof: unknown;
};

const date = (value: Date | null): string | null => value?.toISOString() ?? null;
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const nonempty = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= 512;
const ABSENCE_RECEIPT_CODES = new Set([
  'guarded_current_message_absence',
  'guarded_traffic_protection_absence',
  'guarded_report_absence',
  'guarded_stop_words_absence',
  'retry_predelete_exact_presence',
  'postdelete_exact_presence',
  'guarded_link_predispatch_exact_absence',
  'guarded_commercial_ocr_predispatch_exact_absence',
  'guarded_profanity_predispatch_exact_absence',
  'guarded_commercial_text_absence',
  'guarded_message_duplicate_absence',
  'guarded_image_text_stop_list_predispatch_exact_absence',
  'retention_reconciliation_absence',
]);

function validPlan(row: DeleteFollowupEvidenceRow): boolean {
  const plan = record(row.plan);
  return (
    plan.version === 1 &&
    ['NONE', 'WARN', 'MUTE', 'BAN'].includes(String(plan.action)) &&
    Number.isSafeInteger(plan.issuedAtMs) &&
    Number(plan.issuedAtMs) >= row.sourceAt.getTime() &&
    Number(plan.issuedAtMs) < row.deadlineAt.getTime() &&
    row.deadlineAt.getTime() === row.sourceAt.getTime() + 300_000 &&
    Number.isSafeInteger(plan.violationCount) &&
    Number(plan.violationCount) > 0 &&
    plan.eventId === `${row.id}:decision` &&
    plan.noticeKey === `${row.id}:sanction-notice` &&
    typeof plan.muteDurationHours === 'number' &&
    Number.isFinite(plan.muteDurationHours) &&
    plan.muteDurationHours >= 0 &&
    (plan.action === 'MUTE'
      ? Number.isSafeInteger(plan.muteExpiresAtMs) &&
        plan.muteDurationHours > 0 &&
        plan.muteExpiresAtMs === Number(plan.issuedAtMs) + plan.muteDurationHours * 3_600_000
      : plan.muteExpiresAtMs === null)
  );
}

export function deleteNoticeKeys(logicalKey: string, botIds: readonly (string | null)[]): string[] {
  return [
    ...new Set([
      logicalKey,
      buildMaxActionIdempotencyKey('explicit', ['SEND_MESSAGE', logicalKey]),
      ...botIds
        .filter(nonempty)
        .map((botId) =>
          buildMaxActionIdempotencyKey('explicit', [botId, 'SEND_MESSAGE', logicalKey]),
        ),
    ]),
  ];
}

// FLAG: This projection is observer-only. A missing/malformed receipt never proves no effect,
// and even a confirmed notice proves only this SEND, not complete moderation or client visibility.
export function projectDeleteNoticeEvidence(
  row: DeleteFollowupEvidenceRow,
  kind: 'explanation' | 'sanction-notice',
  ledgerRows: readonly DeleteNoticeLedgerRow[],
  candidateKeys: readonly string[],
  observedAt: Date,
): NoticeEvidence {
  const empty = (state: NoticeEvidence['state']): NoticeEvidence => ({
    state,
    completedAt: null,
    remoteMessageId: null,
  });
  const matches = ledgerRows.filter((ledger) => candidateKeys.includes(ledger.jobId));
  if (!matches.length) return empty('not_recorded');
  if (!validPlan(row)) return empty('invalid_evidence');
  const plan = record(row.plan);
  const valid = matches.every((ledger) => {
    const proof = record(ledger.followupProof),
      notice = record(ledger.noticeProof);
    return (
      ledger.chatId === row.chatId &&
      ledger.actionType === 'SEND_MESSAGE' &&
      proof.version === 1 &&
      proof.id === row.id &&
      proof.issuedAtMs === plan.issuedAtMs &&
      notice.version === 1 &&
      notice.chatId === row.chatId &&
      notice.messageId === row.messageId &&
      notice.userId === row.userId &&
      notice.reasonKey === row.reasonKey &&
      notice.ruleCode === row.ruleCode &&
      /^[a-f0-9]{64}$/u.test(row.policySha256) &&
      notice.policySha256 === row.policySha256 &&
      notice.deadlineAtMs === row.deadlineAt.getTime() &&
      (kind === 'explanation' ||
        (row.decisionRecorded &&
          row.effectEventId === plan.eventId &&
          ['SQL_COMMITTED', 'SETTLED'].includes(row.phase ?? '')))
    );
  });
  if (!valid) return empty('invalid_evidence');
  if (matches.some((ledger) => ledger.ambiguous || ledger.status === 'AMBIGUOUS'))
    return empty('unknown');
  const confirmed = matches.filter(
    (ledger) =>
      ledger.status === 'SUCCEEDED' &&
      ledger.terminal &&
      nonempty(ledger.remoteMessageId) &&
      ledger.remoteMessageId.length <= 256 &&
      ledger.completedAt &&
      ledger.completedAt.getTime() >= Number(plan.issuedAtMs) &&
      ledger.completedAt <= observedAt,
  );
  if (matches.length === 1 && confirmed.length === 1)
    return {
      state: 'confirmed',
      completedAt: date(confirmed[0]!.completedAt),
      remoteMessageId: confirmed[0]!.remoteMessageId,
    };
  if (
    matches.some(
      (ledger) =>
        ledger.dispatchStartedAt || ledger.remoteMessageId || ledger.status === 'SUCCEEDED',
    ) ||
    matches.length > 1
  )
    return empty('unknown');
  return empty(matches.every((ledger) => ledger.terminal) ? 'stopped' : 'pending');
}

export function projectDeleteOutcome(
  intent: IntentEvidence,
  observedAt: Date,
): SafetyDeskDeleteEvidenceResponse['deletion']['outcome'] {
  const plausible = (at: Date | null) =>
    at !== null && Number.isFinite(at.getTime()) && at >= intent.createdAt && at <= observedAt;
  if (
    intent.status === 'ALREADY_ABSENT' &&
    intent.absenceVerifiedAt &&
    nonempty(intent.absenceVerifiedBotId) &&
    plausible(intent.absenceVerifiedAt) &&
    ABSENCE_RECEIPT_CODES.has(intent.absenceVerificationCode ?? '')
  )
    return 'already_absent';
  // FLAG: MAX success is retained before local finalization. Bot-message cleanup deliberately
  // stays AMBIGUOUS until exact absence verification; its acknowledgement cannot prove completion.
  if (plausible(intent.remoteDeleteSucceededAt) && nonempty(intent.remoteDeleteSucceededBotId)) {
    return intent.status === 'SUCCEEDED' &&
      plausible(intent.completedAt) &&
      intent.completedAt!.getTime() >= intent.remoteDeleteSucceededAt!.getTime() &&
      intent.succeededBotId === intent.remoteDeleteSucceededBotId
      ? 'confirmed'
      : 'acknowledged';
  }
  if (
    intent.status === 'AMBIGUOUS' ||
    intent.deleteDispatchStartedAt ||
    intent.remoteDeleteSucceededAt ||
    intent.remoteDeleteSucceededBotId ||
    intent.status === 'SUCCEEDED' ||
    intent.status === 'ALREADY_ABSENT'
  )
    return 'unknown';
  if (['EXPIRED', 'FAILED_TERMINAL'].includes(intent.status)) return 'stopped';
  return intent.status === 'OBSERVED' ? 'observed' : 'pending';
}

@Injectable()
export class SafetyDeskDeleteEvidenceService {
  constructor(private readonly prisma: PrismaService) {}

  async getEvidence(intentId: string): Promise<SafetyDeskDeleteEvidenceResponse> {
    if (!nonempty(intentId) || intentId.length > 128 || intentId !== intentId.trim())
      throw new BadRequestException('Некорректный идентификатор удаления.');
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          await tx.$executeRaw`SET TRANSACTION READ ONLY`;
          await tx.$executeRaw`SET LOCAL statement_timeout = '2000ms'`;
          await tx.$executeRaw`SET LOCAL lock_timeout = '250ms'`;
          const intent = await tx.moderationDeleteIntent.findUnique({
            where: { id: intentId },
            select: {
              id: true,
              chatId: true,
              messageId: true,
              subjectUserId: true,
              status: true,
              createdAt: true,
              sourceMessageAt: true,
              firstAttemptAt: true,
              deleteDispatchStartedAt: true,
              remoteDeleteSucceededAt: true,
              remoteDeleteSucceededBotId: true,
              completedAt: true,
              absenceVerifiedAt: true,
              absenceVerifiedBotId: true,
              absenceVerificationCode: true,
              originBotId: true,
              succeededBotId: true,
            },
          });
          if (!intent) throw new NotFoundException('Удаление не найдено.');
          const reasons = await tx.$queryRaw<ReasonEvidence[]>(
            buildDeleteEvidenceReasonsQuery(intentId),
          );
          const followups = await tx.$queryRaw<DeleteFollowupEvidenceRow[]>(
            buildDeleteEvidenceFollowupsQuery(intentId),
          );
          const sampled = followups.slice(0, DELETE_EVIDENCE_SAMPLE_LIMIT);
          const keysFor = (
            row: DeleteFollowupEvidenceRow,
            kind: 'explanation' | 'sanction-notice',
          ) =>
            deleteNoticeKeys(`${row.id}:${kind}`, [
              row.originBotId,
              row.banBotId,
              intent.originBotId,
              intent.succeededBotId,
            ]);
          const keys = [
            ...new Set(
              sampled.flatMap((row) => [
                ...keysFor(row, 'explanation'),
                ...keysFor(row, 'sanction-notice'),
              ]),
            ),
          ];
          const ledgers = keys.length
            ? await tx.$queryRaw<DeleteNoticeLedgerRow[]>(buildDeleteEvidenceLedgerQuery(keys))
            : [];
          const [clock] = await tx.$queryRaw<Array<{ observedAt: Date }>>`
            SELECT clock_timestamp() AT TIME ZONE 'UTC' AS "observedAt"`;
          if (!clock) throw new Error('Observation clock unavailable');
          const observedAt = clock.observedAt;
          return safetyDeskDeleteEvidenceResponseSchema.parse({
            version: 1,
            observedAt: observedAt.toISOString(),
            intentId,
            webhookLink: 'not_recorded',
            deletion: {
              status: intent.status,
              outcome: projectDeleteOutcome(intent, observedAt),
              createdAt: intent.createdAt.toISOString(),
              sourceMessageAt: date(intent.sourceMessageAt),
              firstAttemptAt: date(intent.firstAttemptAt),
              dispatchStartedAt: date(intent.deleteDispatchStartedAt),
              acknowledgedAt: date(intent.remoteDeleteSucceededAt ?? intent.absenceVerifiedAt),
              completedAt: date(intent.completedAt),
            },
            reasons: {
              sampleComplete: reasons.length <= DELETE_EVIDENCE_SAMPLE_LIMIT,
              items: reasons.slice(0, DELETE_EVIDENCE_SAMPLE_LIMIT),
            },
            followups: {
              sampleComplete: followups.length <= DELETE_EVIDENCE_SAMPLE_LIMIT,
              items: sampled.map((row) => {
                const bound =
                  row.chatId === intent.chatId &&
                  row.messageId === intent.messageId &&
                  row.userId === intent.subjectUserId &&
                  row.sourceAt.getTime() === intent.sourceMessageAt?.getTime();
                const unknown: NoticeEvidence = {
                  state: 'invalid_evidence',
                  completedAt: null,
                  remoteMessageId: null,
                };
                return {
                  id: row.id,
                  ruleCode: row.ruleCode,
                  status: row.status,
                  sourceAt: row.sourceAt.toISOString(),
                  deadlineAt: row.deadlineAt.toISOString(),
                  completedAt: date(row.completedAt),
                  decisionRecorded: bound && validPlan(row) && row.decisionRecorded,
                  explanation: bound
                    ? projectDeleteNoticeEvidence(
                        row,
                        'explanation',
                        ledgers,
                        keysFor(row, 'explanation'),
                        observedAt,
                      )
                    : unknown,
                  sanctionNotice: bound
                    ? projectDeleteNoticeEvidence(
                        row,
                        'sanction-notice',
                        ledgers,
                        keysFor(row, 'sanction-notice'),
                        observedAt,
                      )
                    : unknown,
                };
              }),
            },
          });
        },
        {
          isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
          maxWait: 2_000,
          timeout: 5_000,
        },
      );
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
      throw new ServiceUnavailableException('Подтверждения удаления временно недоступны.');
    }
  }
}
