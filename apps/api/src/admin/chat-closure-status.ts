import type { ChatSettings, ChatClosureStatus } from '@maxim/contracts/settings';
import { buildNightModeNoticeIdempotencyKey } from '../max/max-action-idempotency.util';
import { executionRouteProof } from '../max/max-execution-route-proof';
import {
  resolveCurrentNightModeCloseOccurrence,
  resolveNextNightModeTransitionOccurrences,
  resolveNightModeTransitionSnapshot,
} from '../moderation/night-mode-transition-time.util';
import type { PrismaService } from '../prisma/prisma.service';

export async function readChatClosureStatus(
  prisma: PrismaService,
  chatId: string,
  settings: ChatSettings,
  actionableBotIds: readonly string[],
  now = new Date(),
): Promise<ChatClosureStatus> {
  const night = resolveCurrentNightModeCloseOccurrence(settings, now);
  const manual =
    settings.nightModeForceCloseEnabled &&
    (settings.nightModeForceCloseForever ||
      Date.parse(settings.nightModeForceCloseUntil) > now.getTime());
  const nightClosed = resolveNightModeTransitionSnapshot(settings, now)?.status === 'closed';
  const manualEndsAt =
    manual && !settings.nightModeForceCloseForever
      ? new Date(settings.nightModeForceCloseUntil)
      : null;
  const openingReference = manualEndsAt ?? now;
  const nightStillClosed =
    resolveNightModeTransitionSnapshot(settings, openingReference)?.status === 'closed';
  const opensAt =
    manual && settings.nightModeForceCloseForever
      ? null
      : nightStillClosed
        ? (resolveNextNightModeTransitionOccurrences(settings, openingReference)
            .find((item) => item.transition === 'open')
            ?.dueAt.toISOString() ?? null)
        : (manualEndsAt?.toISOString() ?? null);
  const status: ChatClosureStatus = {
    observedAt: now.toISOString(),
    scheduleEnabled: settings.nightModeEnabled,
    restriction: manual ? 'manual' : nightClosed ? 'night' : 'open',
    timezone: settings.nightModeTimezone,
    opensAt,
    deleteRoute: 'unknown',
    notice: settings.nightModeBotMessageEnabled ? 'unknown' : 'disabled',
    recovery: 'unknown',
  };
  // FLAG: This is an exact-chat SQL read model, never a live rights check or SEND proof.
  // Failure to read diagnostics cannot prevent the settings screen from opening.
  const [chatResult, recoveryResult, noticeResult] = await Promise.allSettled([
    prisma.chat.findUnique({
      where: { id: chatId },
      select: {
        id: true,
        entityType: true,
        primaryBotId: true,
        routingVersion: true,
        routingState: true,
        botMemberships: {
          where: { botId: { in: [...actionableBotIds] } },
          select: {
            botId: true,
            status: true,
            botAccessState: true,
            botAccessCheckedAt: true,
            botAccessExpiresAt: true,
            botAccessSource: true,
            permissionsSnapshot: true,
          },
        },
      },
    }),
    prisma.nightModeTransitionReconcileRequest.findUnique({
      where: { chatId },
      select: {
        firstRequestedAt: true,
        lastErrorCode: true,
        manualBlockedAt: true,
        generation: true,
        manualBlockedGeneration: true,
      },
    }),
    night && settings.nightModeBotMessageEnabled
      ? prisma.maxActionLedgerEntry.findUnique({
          where: { jobId: buildNightModeNoticeIdempotencyKey('close', chatId, night.sessionKey) },
          select: {
            chatId: true,
            actionType: true,
            sourceTag: true,
            status: true,
            ambiguous: true,
            terminal: true,
            attemptCount: true,
            remoteMessageId: true,
            dispatchBotId: true,
            completedAt: true,
          },
        })
      : Promise.resolve(null),
  ]);
  if (chatResult.status === 'fulfilled') {
    const chat = chatResult.value;
    status.deleteRoute =
      chat?.routingState === 'READY' &&
      chat.botMemberships.some((candidate) => {
        const state = {
          chatId,
          entityType: chat.entityType,
          primaryBotId: chat.primaryBotId,
          routingVersion: chat.routingVersion,
          candidates: chat.botMemberships,
        };
        return (
          executionRouteProof(state, candidate.botId, 'moderation') &&
          executionRouteProof(state, candidate.botId, 'delete_message')
        );
      })
        ? 'available'
        : 'unavailable';
  }
  if (recoveryResult.status === 'fulfilled') {
    const request = recoveryResult.value;
    status.recovery = !request
      ? 'idle'
      : request.manualBlockedAt && request.manualBlockedGeneration === request.generation
        ? 'action_required'
        : now.getTime() - request.firstRequestedAt.getTime() >= 5 * 60_000
          ? 'delayed'
          : 'waiting';
  }
  if (!night)
    status.notice = settings.nightModeBotMessageEnabled
      ? manual || nightClosed
        ? 'unknown'
        : 'not_expected'
      : 'disabled';
  else if (settings.nightModeBotMessageEnabled && noticeResult.status === 'fulfilled') {
    const ledger = noticeResult.value;
    status.notice = !ledger
      ? 'not_recorded'
      : ledger.chatId !== chatId ||
          ledger.actionType !== 'SEND_MESSAGE' ||
          ledger.sourceTag !== 'night_mode_transition'
        ? 'unknown'
        : ledger.ambiguous || ledger.status === 'AMBIGUOUS'
          ? 'unknown'
          : ledger.status === 'SUCCEEDED' &&
              ledger.terminal &&
              ledger.dispatchBotId &&
              ledger.remoteMessageId &&
              ledger.completedAt
            ? 'delivered'
            : ledger.terminal
              ? 'failed'
              : ledger.attemptCount > 0
                ? 'unknown'
                : 'pending';
  }
  return status;
}
