import type { ChatSettings, ChatClosureStatus } from '@maxim/contracts/settings';
import { executionRouteProof } from '../max/max-execution-route-proof';
import { classifyNightModeNoticeSendRoute } from '../moderation/night-mode-notice-diagnostics';
import {
  resolveCurrentNightModeCloseOccurrence,
  resolveEffectiveChatClosure,
} from '../moderation/night-mode-transition-time.util';
import type { PrismaService } from '../prisma/prisma.service';
import { readChatClosureNoticeDiagnostics } from './chat-closure-notice-diagnostics';

export async function readChatClosureStatus(
  prisma: PrismaService,
  chatId: string,
  settings: ChatSettings,
  actionableBotIds: readonly string[],
  now = new Date(),
): Promise<ChatClosureStatus> {
  const night = resolveCurrentNightModeCloseOccurrence(settings, now);
  const effective = resolveEffectiveChatClosure(settings, now);
  const status: ChatClosureStatus = {
    observedAt: now.toISOString(),
    scheduleEnabled: settings.nightModeEnabled,
    restriction: effective.restriction,
    timezone: settings.nightModeTimezone,
    opensAt: effective.opensAt?.toISOString() ?? null,
    nextTransitionAt: effective.nextTransitionAt?.toISOString() ?? null,
    deleteRoute: 'unknown',
    notice: settings.nightModeBotMessageEnabled ? 'unknown' : 'disabled',
    recovery: 'unknown',
  };
  // FLAG: This is an exact-chat SQL read model, never a live rights check or SEND proof.
  // Failure to read diagnostics cannot prevent the settings screen from opening.
  const [chatResult, noticeResult] = await Promise.allSettled([
    prisma.chat.findUnique({
      where: { id: chatId },
      select: {
        id: true,
        entityType: true,
        primaryBotId: true,
        fixedModeratorBotId: true,
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
            sendRouteFailureCount: true,
            sendRouteQuarantinedUntil: true,
            sendRouteLastFailureCode: true,
          },
        },
      },
    }),
    readChatClosureNoticeDiagnostics(prisma, chatId, settings, now),
  ]);
  if (noticeResult.status === 'fulfilled') {
    status.notices = noticeResult.value.notices;
    status.recovery = noticeResult.value.recovery;
  }
  if (chatResult.status === 'fulfilled') {
    const chat = chatResult.value;
    if (status.notices)
      status.notices.sendRouteNow = classifyNightModeNoticeSendRoute(
        chat ? { ...chat, chatId } : null,
        now,
      );
    status.deleteRoute =
      chat?.routingState === 'READY' &&
      chat.botMemberships.some((candidate) => {
        const state = {
          chatId,
          entityType: chat.entityType,
          primaryBotId: chat.primaryBotId,
          fixedModeratorBotId: chat.fixedModeratorBotId,
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
  if (!night)
    status.notice = settings.nightModeBotMessageEnabled
      ? effective.closed
        ? 'unknown'
        : 'not_expected'
      : 'disabled';
  else if (settings.nightModeBotMessageEnabled && status.notices?.close.latest) {
    const outcome = status.notices.close.latest.delivery.outcome;
    status.notice = outcome === 'sent' ? 'delivered' : outcome === 'not_sent' ? 'failed' : outcome;
  }
  return status;
}
