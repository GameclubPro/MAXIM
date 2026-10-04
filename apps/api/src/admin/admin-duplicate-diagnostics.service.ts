import {
  messageDuplicateBindingSchema,
  messageDuplicateOriginalSchema,
} from '../moderation/message-duplicate/message-duplicate-state';
import { Injectable, Optional } from '@nestjs/common';
import {
  duplicateDiagnosticsResponseSchema,
  duplicateMessageLinkResponseSchema,
  type DuplicateDeletionAttempt,
  type DuplicateDeletionCapability,
  type DuplicateDiagnosticsResponse,
  type DuplicateMessageLinkResponse,
} from '@maxim/contracts/settings';
import { Prisma, type ModerationDeleteIntentStatus } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { MaxBotLinkService } from '../max/max-bot-link.service';
import { MaxBotExecutionPlannerService } from '../max/max-bot-execution-planner.service';
import { MessageDuplicatePolicyService } from '../moderation/message-duplicate/message-duplicate-policy.service';
import { MessageDuplicateMetricsService } from '../moderation/message-duplicate/message-duplicate-metrics.service';
import { emptyDuplicateObservationDiagnostics } from '../moderation/message-duplicate/message-duplicate-telemetry';
import { MaxClientService, MAX_API_SOURCE_TAGS } from '../max/max-client.service';
import {
  duplicateHistoryQuery,
  encodeDuplicateHistoryCursor,
  readDuplicateHistoryPage,
} from './admin-duplicate-diagnostics-history';

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
  messageId?: string;
  sourceMessageAt?: Date | null;
  registeredAt?: Date;
  cursorAt?: string;
  binding?: unknown;
  kind?: unknown;
  sanctionEvidence?: unknown;
  original?: unknown;
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
    message_duplicate_original_missing: 'CONTENT_CHANGED',
    message_duplicate_original_changed: 'CONTENT_CHANGED',
    message_duplicate_policy_changed: 'POLICY_CHANGED',
    message_duplicate_settings_changed: 'POLICY_CHANGED',
    message_duplicate_photo_policy_changed: 'POLICY_CHANGED',
    message_duplicate_manual_release: 'IMMUNITY',
  };
  const original = messageDuplicateOriginalSchema.safeParse(row.original);
  const binding = messageDuplicateBindingSchema.safeParse(row.binding);
  const verifiedBinding =
    binding.success && binding.data.messageId === row.messageId ? binding.data : null;
  const boundOriginal = verifiedBinding?.original ?? (original.success ? original.data : undefined);
  const kinds = new Set(['exact', 'content', 'near', 'link', 'phone', 'image', 'image_set']);
  const sanction = verifiedBinding?.sanction;
  const confirmedSanction =
    sanction &&
    Array.isArray(row.sanctionEvidence) &&
    row.sanctionEvidence.some((entry) => {
      // FLAG: A durable WARN decision is terminal without the BAN/MUTE remote receipt flag.
      // An explicit failure marker still cannot confirm any sanction.
      if (
        !entry ||
        typeof entry !== 'object' ||
        entry.action !== sanction.action ||
        (sanction.action === 'WARN' ? entry.applied === false : entry.applied !== true)
      )
        return false;
      const candidate = messageDuplicateBindingSchema.safeParse(entry.binding);
    // FLAG: The strict schema supplies canonical field order, including every authority fence
      // and the full sanction tuple. A previous revision's receipt never confirms this one.
      return (
        candidate.success && JSON.stringify(candidate.data) === JSON.stringify(verifiedBinding)
      );
    });
  return {
    ...(row.messageId
      ? {
          target: {
            messageId: row.messageId,
            publishedAt: row.sourceMessageAt?.toISOString() ?? null,
          },
        }
      : {}),
    ...(row.registeredAt ? { registeredAt: row.registeredAt.toISOString() } : {}),
    ...(verifiedBinding
      ? {
          comparison: {
            mode: verifiedBinding.compareMode,
            kind:
              typeof row.kind === 'string' && kinds.has(row.kind)
                ? (row.kind as NonNullable<DuplicateDeletionAttempt['comparison']>['kind'])
                : 'unknown',
            windowSeconds: verifiedBinding.windowSeconds,
            firstDeletedMessageNumber: verifiedBinding.requiredCount,
          },
        }
      : {}),
    ...(sanction
      ? {
          sanction: {
            action: sanction.action,
            state: confirmedSanction ? ('CONFIRMED' as const) : ('REQUESTED' as const),
          },
        }
      : {}),
    ...(boundOriginal
      ? {
          original: {
            messageId: boundOriginal.messageId,
            publishedAt: new Date(boundOriginal.publishedAtMs).toISOString(),
            repeatAllowedAt: new Date(boundOriginal.expiresAtMs).toISOString(),
          },
        }
      : {}),
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
    @Optional() private readonly metrics?: MessageDuplicateMetricsService,
    @Optional() private readonly maxClient?: MaxClientService,
  ) {}

  async read(
    chatId: string,
    recheck = false,
    query: unknown = {},
  ): Promise<DuplicateDiagnosticsResponse> {
    const page = readDuplicateHistoryPage(chatId, query);
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
            : policy.mode === 'off'
              ? 'OFF'
              : 'OBSERVE';
    } catch {
      /* FLAG: Unknown runtime state must not promise enforcement. */
    }
    const capability = await this.readCapability(chatId, recheck);
    const history: DuplicateDiagnosticsResponse['history'] = {
      available: false,
      since: page.since,
      sampledIntents: 0,
      // FLAG: Legacy reasons may not have been projected. Even an empty page is not proof
      // of no historical attempts; bounded diagnostic recovery is an explicit operation.
      limited: true,
      coverage: 'PROJECTED_ONLY',
      nextCursor: null,
      attempts: [],
    };
    try {
      const rows = await this.prisma.$transaction(
        async (tx) => {
          await tx.$executeRaw`SET LOCAL statement_timeout = '2000ms'`;
          return tx.$queryRaw<AttemptRow[]>(duplicateHistoryQuery(chatId, page));
        },
        { timeout: 3000, maxWait: 1000 },
      );
      const sample = rows.slice(0, page.limit);
      history.available = true;
      history.sampledIntents = sample.length;
      history.attempts = sample.map((row) => presentDuplicateDeletionAttempt(row, Date.now()));
      const last = sample.at(-1);
      if (rows.length > page.limit && last)
        history.nextCursor = encodeDuplicateHistoryCursor({
          version: 1,
          chatId,
          until: page.until,
          at: last.cursorAt ?? last.createdAt.toISOString(),
          id: last.id,
        });
    } catch {
      /* FLAG: A bounded audit failure is unavailable history, never an empty successful audit. */
    }
    return duplicateDiagnosticsResponseSchema.parse({
      generatedAt: new Date().toISOString(),
      enabled: settings?.antiDuplicateEnabled ?? false,
      mode,
      capability,
      observation: this.metrics
        ? await this.metrics.readObservations(chatId)
        : emptyDuplicateObservationDiagnostics('UNAVAILABLE'),
      history,
    });
  }

  async readMessageLink(
    chatId: string,
    intentId: string,
    role: 'target' | 'original',
  ): Promise<DuplicateMessageLinkResponse> {
    const unavailable: DuplicateMessageLinkResponse = { state: 'UNAVAILABLE', url: null };
    if (!this.maxClient) return unavailable;
    const row = await this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SET LOCAL statement_timeout = '2000ms'`;
        const rows = await tx.$queryRaw<Array<{ messageId: string; binding: unknown }>>(Prisma.sql`
        SELECT intent.message_id AS "messageId", reason.metadata->'messageDuplicate' AS binding
        FROM duplicate_diagnostics_history history
        JOIN moderation_delete_intents intent ON intent.id = history.intent_id AND intent.chat_id = ${chatId}
        LEFT JOIN LATERAL (
          SELECT metadata FROM moderation_delete_intent_reasons
          WHERE intent_id = intent.id AND rule_code = 'DUPLICATE_DELETE'
          ORDER BY updated_at DESC, id DESC LIMIT 1
        ) reason ON TRUE
        WHERE history.chat_id = ${chatId} AND history.intent_id = ${intentId}
        LIMIT 1
      `);
        return rows[0];
      },
      { timeout: 3000, maxWait: 1000 },
    );
    if (!row) return unavailable;
    const binding = messageDuplicateBindingSchema.safeParse(row.binding);
    const messageId =
      role === 'target'
        ? row.messageId
        : binding.success && binding.data.messageId === row.messageId
          ? binding.data.original?.messageId
          : null;
    if (!messageId) return unavailable;
    try {
      const route = await this.bots.resolveStrictWriteModerationBotRoute({ chatId });
      if (!route.botId) return unavailable;
      // FLAG: Links come only from an exact-chat MAX lookup and the existing deep-link
      // parser. Missing/deleted messages never acquire a guessed URL from their IDs.
      const message = await this.maxClient.getExactMessageRow(chatId, messageId, {
        botId: route.botId,
        trafficClass: 'background',
        sourceTag: MAX_API_SOURCE_TAGS.PHOTO_DUPLICATE_ADMIN_CHECK,
        timeoutMs: 2000,
      });
      const snapshot = message ? this.maxClient.parseChannelMessageSnapshot(chatId, message) : null;
      if (snapshot?.messageId !== messageId || !snapshot.url) return unavailable;
      const result = duplicateMessageLinkResponseSchema.safeParse({
        state: 'AVAILABLE',
        url: snapshot.url,
      });
      return result.success ? result.data : unavailable;
    } catch {
      return unavailable;
    }
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
