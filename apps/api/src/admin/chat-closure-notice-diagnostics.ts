import type {
  ChatClosureStatus,
  ChatSettings,
  NightModeNoticeDiagnostics,
  NightModeNoticeObservation,
} from '@maxim/contracts/settings';
import { buildNightModeNoticeIdempotencyKey } from '../max/max-action-idempotency.util';
import {
  classifyNightModeNoticeLedger,
  NIGHT_MODE_NOTICE_DIAGNOSTIC_LEDGER_SELECT,
} from '../moderation/night-mode-notice-diagnostics';
import { matchesNightModeRecoveryBoundaryTime } from '../moderation/night-mode-recovery-time-compat.util';
import { buildNightModeTransitionScheduleFingerprint } from '../moderation/night-mode-transition-generation.util';
import {
  buildNightModeTransitionJobId,
  buildNightModeTransitionRecoveryJobId,
  parseNightModeTransitionRecoveryObligation,
} from '../moderation/night-mode-transition.queue';
import {
  resolveEffectiveChatClosure,
  resolveLatestNightModeTransitionOccurrences,
  resolveNightModeNoticeCatchUpWindow,
  type NightModeTransitionOccurrence,
} from '../moderation/night-mode-transition-time.util';
import type { Prisma } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';

export const NIGHT_MODE_DIAGNOSTIC_RECOVERY_ROW_LIMIT = 32;
const RECOVERY_ROW_LIMIT = NIGHT_MODE_DIAGNOSTIC_RECOVERY_ROW_LIMIT;
const REGISTRY_SELECT = {
  chatId: true,
  jobId: true,
  transition: true,
  sessionKey: true,
  scheduledFor: true,
  scheduleFingerprint: true,
  runtimeVersion: true,
  recoveryPayload: true,
} satisfies Prisma.NightModeTransitionScheduledJobSelect;
type RegistryRow = Prisma.NightModeTransitionScheduledJobGetPayload<{
  select: typeof REGISTRY_SELECT;
}>;
const RECONCILE_SELECT = {
  firstRequestedAt: true,
  manualBlockedAt: true,
  manualBlockedCategory: true,
  manualBlockedJobId: true,
  manualBlockedSessionKey: true,
  manualBlockedFingerprint: true,
  manualAcknowledgedAt: true,
  generation: true,
  manualBlockedGeneration: true,
} satisfies Prisma.NightModeTransitionReconcileRequestSelect;
type ReconcileRow = Prisma.NightModeTransitionReconcileRequestGetPayload<{
  select: typeof RECONCILE_SELECT;
}>;

type DiagnosticsPrisma = Pick<
  PrismaService,
  'maxActionLedgerEntry' | 'nightModeTransitionScheduledJob' | 'nightModeTransitionReconcileRequest'
>;

export function loadChatClosureRecoveryRegistryRows(
  prisma: Pick<PrismaService, 'nightModeTransitionScheduledJob'>,
  chatId: string,
): Promise<RegistryRow[]> {
  return prisma.nightModeTransitionScheduledJob.findMany({
    where: { chatId },
    select: REGISTRY_SELECT,
    orderBy: [{ scheduledFor: 'desc' }, { jobId: 'desc' }],
    take: RECOVERY_ROW_LIMIT + 1,
  });
}

export async function readChatClosureNoticeDiagnostics(
  prisma: DiagnosticsPrisma,
  chatId: string,
  settings: ChatSettings,
  now: Date,
): Promise<{ notices: NightModeNoticeDiagnostics; recovery: ChatClosureStatus['recovery'] }> {
  const latest = resolveLatestNightModeTransitionOccurrences(settings, now);
  const occurrences = [latest.close, latest.open].filter(
    (value): value is NightModeTransitionOccurrence => value !== null,
  );
  const sessions = new Set(occurrences.map((occurrence) => occurrence.sessionKey));
  const ledgerIds = occurrences.map((occurrence) =>
    buildNightModeNoticeIdempotencyKey(occurrence.transition, chatId, occurrence.sessionKey),
  );
  const registryIds = occurrences.map((occurrence) =>
    buildNightModeTransitionJobId(
      chatId,
      occurrence.transition,
      occurrence.dueAt.toISOString(),
      occurrence.sessionKey,
    ),
  );
  // FLAG: Read exact SEND keys independently of current enabling/access. The bounded unfiltered
  // registry prefix uses the chat/due/job index; truncation is a coverage gap, never absence proof.
  const [ledgerRead, registryRead, recoveryRead, reconcileRead] = await Promise.allSettled([
    Promise.resolve().then(() =>
      ledgerIds.length
        ? prisma.maxActionLedgerEntry.findMany({
            where: { jobId: { in: ledgerIds } },
            select: NIGHT_MODE_NOTICE_DIAGNOSTIC_LEDGER_SELECT,
          })
        : [],
    ),
    Promise.resolve().then(() =>
      registryIds.length
        ? prisma.nightModeTransitionScheduledJob.findMany({
            where: { chatId, jobId: { in: registryIds } },
            select: REGISTRY_SELECT,
          })
        : [],
    ),
    Promise.resolve().then(() =>
      sessions.size ? loadChatClosureRecoveryRegistryRows(prisma, chatId) : [],
    ),
    Promise.resolve().then(() =>
      prisma.nightModeTransitionReconcileRequest.findUnique({
        where: { chatId },
        select: RECONCILE_SELECT,
      }),
    ),
  ]);
  const ledgers = new Map(
    (ledgerRead.status === 'fulfilled' ? ledgerRead.value : []).map((row) => [row.jobId, row]),
  );
  const registry = new Map(
    (registryRead.status === 'fulfilled' ? registryRead.value : []).map((row) => [row.jobId, row]),
  );
  const scheduleFingerprint = buildNightModeTransitionScheduleFingerprint({
    ...settings,
    nightModeEnabled: true,
  });
  const observe = (
    occurrence: NightModeTransitionOccurrence | null,
    enabledNow: boolean,
  ): NightModeNoticeObservation => {
    if (!occurrence) return { enabledNow, latest: null };
    const ledgerId = buildNightModeNoticeIdempotencyKey(
      occurrence.transition,
      chatId,
      occurrence.sessionKey,
    );
    const jobId = buildNightModeTransitionJobId(
      chatId,
      occurrence.transition,
      occurrence.dueAt.toISOString(),
      occurrence.sessionKey,
    );
    const row = registry.get(jobId);
    const catchUp = resolveNightModeNoticeCatchUpWindow(occurrence, settings, now);
    return {
      enabledNow,
      latest: {
        sessionKey: occurrence.sessionKey,
        scheduledFor: occurrence.dueAt.toISOString(),
        catchUp: { state: catchUp.state, endsAt: catchUp.endsAt.toISOString() },
        scheduling:
          registryRead.status === 'rejected'
            ? 'unknown'
            : !row
              ? 'not_recorded'
              : row.chatId === chatId &&
                  row.transition === occurrence.transition &&
                  row.sessionKey === occurrence.sessionKey &&
                  row.scheduledFor.getTime() === occurrence.dueAt.getTime() &&
                  row.scheduleFingerprint === scheduleFingerprint &&
                  row.runtimeVersion === 4 &&
                  row.recoveryPayload === null
                ? 'recorded'
                : 'mismatch',
        delivery: classifyNightModeNoticeLedger({
          chatId,
          transition: occurrence.transition,
          sessionKey: occurrence.sessionKey,
          ledger:
            ledgerRead.status === 'fulfilled'
              ? { state: 'read', row: ledgers.get(ledgerId) ?? null }
              : { state: 'unavailable' },
        }),
      },
    };
  };
  const recovery: NightModeNoticeDiagnostics['recovery'] = {
    scope: 'latest_occurrences',
    observation:
      recoveryRead.status === 'rejected'
        ? 'unavailable'
        : recoveryRead.value.length > RECOVERY_ROW_LIMIT || reconcileRead.status === 'rejected'
          ? 'partial'
          : 'complete',
    obligations: [],
  };
  const request = reconcileRead.status === 'fulfilled' ? reconcileRead.value : null;
  if (recoveryRead.status === 'fulfilled') {
    for (const row of recoveryRead.value.slice(0, RECOVERY_ROW_LIMIT)) {
      if (!sessions.has(row.sessionKey) || row.recoveryPayload === null) continue;
      const payload = parseNightModeTransitionRecoveryObligation(row.recoveryPayload);
      const transition = payload?.kind === 'close_notice_event' ? 'close' : 'open';
      if (
        !payload ||
        row.chatId !== chatId ||
        row.runtimeVersion !== 4 ||
        payload.sessionKey !== row.sessionKey ||
        row.transition !== transition ||
        row.jobId !== buildNightModeTransitionRecoveryJobId(chatId, payload) ||
        row.scheduleFingerprint !==
          buildNightModeTransitionScheduleFingerprint({
            nightModeEnabled: true,
            nightModeStartTimeMinutes: payload.startMinutes,
            nightModeEndTimeMinutes: payload.endMinutes,
            nightModeTimezone: payload.timezone,
          }) ||
        !matchesNightModeRecoveryBoundaryTime({
          sessionKey: row.sessionKey,
          transition,
          scheduledFor: row.scheduledFor.toISOString(),
        })
      ) {
        recovery.observation = 'partial';
        continue;
      }
      recovery.obligations.push({
        kind: payload.kind,
        sessionKey: row.sessionKey,
        scheduledFor: row.scheduledFor.toISOString(),
        state: exactManualBlock(request, row) ? 'action_required' : 'recorded',
      });
    }
  }
  return {
    notices: {
      expectationBasis: 'current_schedule',
      evidenceScope: 'exact_send_ledger',
      boundary: resolveEffectiveChatClosure(settings, now).boundary,
      sendRouteNow: 'unknown',
      close: observe(latest.close, settings.nightModeBotMessageEnabled),
      open: observe(latest.open, settings.nightModeOpenMessageEnabled),
      recovery,
    },
    recovery:
      reconcileRead.status === 'rejected'
        ? 'unknown'
        : !request
          ? 'idle'
          : request.manualBlockedAt &&
              !request.manualAcknowledgedAt &&
              request.manualBlockedGeneration === request.generation
            ? 'action_required'
            : now.getTime() - request.firstRequestedAt.getTime() >= 5 * 60_000
              ? 'delayed'
              : 'waiting',
  };
}

function exactManualBlock(request: ReconcileRow | null, row: RegistryRow): boolean {
  return Boolean(
    request?.manualBlockedAt &&
    !request.manualAcknowledgedAt &&
    [
      'unsafe_prior_dispatch',
      'unsafe_prior_provenance',
      'no_fresh_access',
      'failed_job_unclassified',
    ].includes(request.manualBlockedCategory ?? '') &&
    request.manualBlockedJobId === row.jobId &&
    request.manualBlockedSessionKey === row.sessionKey &&
    request.manualBlockedFingerprint === row.scheduleFingerprint,
  );
}
