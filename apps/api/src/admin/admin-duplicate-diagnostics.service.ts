import { Injectable } from '@nestjs/common';
import {
  duplicateDiagnosticsResponseSchema,
  type DuplicateDeletionAttempt,
  type DuplicateDeletionCapability,
  type DuplicateDiagnosticsResponse,
} from '@maxim/contracts/settings';
import { Prisma, type ModerationDeleteIntentStatus } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { MaxBotLinkService } from '../max/max-bot-link.service';
import { MaxBotExecutionPlannerService } from '../max/max-bot-execution-planner.service';
import { MessageDuplicatePolicyService } from '../moderation/message-duplicate/message-duplicate-policy.service';

const STATUSES: ModerationDeleteIntentStatus[] = [
  'OBSERVED',
  'PENDING',
  'IN_PROGRESS',
  'RETRYABLE',
  'WAITING_CAPABILITY',
  'AMBIGUOUS',
  'SUCCEEDED',
  'ALREADY_ABSENT',
  'EXPIRED',
  'FAILED_TERMINAL',
];
const SAMPLE_PER_STATUS = 20;
type AttemptRow = {
  id: string;
  status: ModerationDeleteIntentStatus;
  createdAt: Date;
  updatedAt: Date;
  nextAttemptAt: Date;
  retryUntilAt: Date;
  remoteDeleteSucceededAt: Date | null;
  absenceVerifiedAt: Date | null;
  lastErrorCode: string | null;
  duplicate: boolean;
  reasonsLimited: boolean;
};

export function presentDuplicateDeletionAttempt(
  row: AttemptRow,
  now: number,
): DuplicateDeletionAttempt {
  let outcome: DuplicateDeletionAttempt['outcome'];
  if (row.remoteDeleteSucceededAt) outcome = 'DELETED';
  else if (row.absenceVerifiedAt) outcome = 'ALREADY_ABSENT';
  else if (
    row.status === 'SUCCEEDED' ||
    row.status === 'ALREADY_ABSENT' ||
    row.status === 'AMBIGUOUS'
  )
    outcome = 'UNCONFIRMED';
  else if (row.status === 'FAILED_TERMINAL') outcome = 'CANCELLED';
  else if (row.status === 'OBSERVED') outcome = 'OBSERVED';
  else if (row.status === 'EXPIRED' || row.retryUntilAt.getTime() <= now) outcome = 'EXPIRED';
  else if (row.status === 'WAITING_CAPABILITY') outcome = 'WAITING_ACCESS';
  else if (row.status === 'RETRYABLE') outcome = 'RETRYING';
  else outcome = 'PENDING';
  const reasons: Record<string, DuplicateDeletionAttempt['reason']> = {
    message_duplicate_author_immune: 'IMMUNITY',
    message_duplicate_author_not_member: 'AUTHOR_LEFT',
    message_duplicate_content_changed: 'CONTENT_CHANGED',
    message_duplicate_identity_changed: 'CONTENT_CHANGED',
    message_duplicate_history_changed: 'CONTENT_CHANGED',
    message_duplicate_policy_changed: 'POLICY_CHANGED',
    message_duplicate_settings_changed: 'POLICY_CHANGED',
    message_duplicate_photo_policy_changed: 'POLICY_CHANGED',
    message_duplicate_manual_release: 'IMMUNITY',
  };
  return {
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    outcome,
    reason:
      outcome === 'CANCELLED'
        ? Object.hasOwn(reasons, row.lastErrorCode ?? '')
          ? reasons[row.lastErrorCode!]!
          : 'UNKNOWN'
        : null,
    nextAttemptAt:
      ['PENDING', 'RETRYING', 'WAITING_ACCESS'].includes(outcome) &&
      row.nextAttemptAt.getTime() > now
        ? row.nextAttemptAt.toISOString()
        : null,
  };
}

@Injectable()
export class AdminDuplicateDiagnosticsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bots: MaxBotLinkService,
    private readonly planner: MaxBotExecutionPlannerService,
    private readonly policy: MessageDuplicatePolicyService,
  ) {}

  async read(chatId: string, recheck = false): Promise<DuplicateDiagnosticsResponse> {
    const settings = await this.prisma.chatSettings.findUnique({
      where: { chatId },
      select: { antiDuplicateEnabled: true },
    });
    let mode: DuplicateDiagnosticsResponse['mode'] = 'UNKNOWN';
    try {
      const policy = await this.policy.resolve(chatId, true);
      mode =
        policy.mode === 'full'
          ? 'FULL'
          : policy.mode === 'delete_only'
            ? 'DELETE_ONLY'
            : 'LEGACY_TEXT';
    } catch {
      /* FLAG: Unknown runtime state must not promise enforcement. */
    }
    const capability = await this.readCapability(chatId, recheck);
    const since = new Date(Date.now() - 24 * 60 * 60_000);
    const history: DuplicateDiagnosticsResponse['history'] = {
      available: false,
      since: since.toISOString(),
      sampledIntents: 0,
      limited: false,
      attempts: [],
    };
    try {
      // FLAG: Bound each indexed chat/status walk before inspecting reasons. No raw messages,
      // excerpts, bot identities or free-form errors may enter this admin-facing response.
      const rows = await this.prisma.$transaction(
        async (tx) => {
          await tx.$executeRaw`SET LOCAL statement_timeout = '2000ms'`;
          return tx.$queryRaw<AttemptRow[]>(Prisma.sql`
          WITH statuses(status) AS (VALUES ${Prisma.join(STATUSES.map((status) => Prisma.sql`(CAST(${status} AS "ModerationDeleteIntentStatus"))`))})
          SELECT recent.*, reason."duplicate", reason."reasonsLimited"
          FROM statuses
          CROSS JOIN LATERAL (
            SELECT id, status, created_at AS "createdAt", updated_at AS "updatedAt",
              next_attempt_at AS "nextAttemptAt", retry_until_at AS "retryUntilAt",
              remote_delete_succeeded_at AS "remoteDeleteSucceededAt",
              absence_verified_at AS "absenceVerifiedAt", last_error_code AS "lastErrorCode"
            FROM moderation_delete_intents
            WHERE chat_id = ${chatId} AND status = statuses.status AND created_at >= ${since}
            ORDER BY created_at DESC
            LIMIT ${SAMPLE_PER_STATUS + 1}
          ) recent
          CROSS JOIN LATERAL (
            SELECT COALESCE(bool_or(rule_code = 'DUPLICATE_DELETE'), false) AS "duplicate",
              count(*) > 8 AS "reasonsLimited"
            FROM (
              SELECT rule_code FROM moderation_delete_intent_reasons
              WHERE intent_id = recent.id ORDER BY reason_key ASC LIMIT 9
            ) bounded_reasons
          ) reason
        `);
        },
        { timeout: 3000, maxWait: 1000 },
      );
      const counts = new Map<string, number>();
      const sample = rows
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id))
        .filter((row) => {
          const count = (counts.get(row.status) ?? 0) + 1;
          counts.set(row.status, count);
          return count <= SAMPLE_PER_STATUS;
        });
      history.available = true;
      history.sampledIntents = sample.length;
      history.limited =
        rows.some((row) => row.reasonsLimited) ||
        [...counts.values()].some((count) => count > SAMPLE_PER_STATUS);
      history.attempts = sample
        .filter((row) => row.duplicate)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id))
        .slice(0, 5)
        .map((row) => presentDuplicateDeletionAttempt(row, Date.now()));
    } catch {
      /* FLAG: A bounded audit failure is unavailable history, never an empty successful audit. */
    }
    return duplicateDiagnosticsResponseSchema.parse({
      generatedAt: new Date().toISOString(),
      enabled: settings?.antiDuplicateEnabled ?? false,
      mode,
      capability,
      history,
    });
  }

  private async readCapability(
    chatId: string,
    recheck: boolean,
  ): Promise<DuplicateDeletionCapability> {
    const startedAt = Date.now();
    try {
      if (recheck) {
        await this.planner.refreshChatBotCapabilitySnapshots({
          chatId,
          entityType: 'chat',
          force: true,
        });
      }
      const route = await this.bots.resolveStrictWriteModerationBotRoute({ chatId });
      const checkedAt = route.checkedAt ? Date.parse(route.checkedAt) : Number.NaN;
      // FLAG: Shared backoff may return an old snapshot; it cannot prove a requested live recheck.
      if (
        !Number.isFinite(checkedAt) ||
        checkedAt > Date.now() ||
        (recheck && checkedAt < startedAt)
      ) {
        return {
          state: 'UNKNOWN',
          checkedAt: Number.isFinite(checkedAt) && checkedAt <= Date.now() ? route.checkedAt : null,
        };
      }
      return {
        state:
          route.botId && route.capabilityState === 'confirmed_capable'
            ? 'CONFIRMED'
            : route.capabilityState === 'explicitly_incapable'
              ? 'MISSING'
              : 'UNKNOWN',
        checkedAt: route.checkedAt,
      };
    } catch {
      return { state: 'UNKNOWN', checkedAt: null };
    }
  }
}
