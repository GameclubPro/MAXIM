import { Logger } from '@nestjs/common';
import type { MaxUpdate } from '@maxim/contracts';
import type { ManualModerationService } from '../admin/manual-moderation.service';
import {
  MAX_API_SOURCE_TAGS,
  type MaxChatMemberAccess,
  type MaxClientService,
} from '../max/max-client.service';
import { SanctionAction } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import {
  extractMaxCallbackId,
  extractMaxCallbackPayloadRaw,
  extractMaxCallbackUserId,
} from './max-callback-update.util';
import {
  parseModerationReleaseCallbackPayload,
  type ModerationReleaseCallback,
} from './moderation-release-callback.util';
import {
  ModerationSanctionStateChangedError,
  ModerationSanctionStateLockBusyError,
  ModerationSanctionStateLockLeaseLostError,
  ModerationSanctionStateLockUnavailableError,
} from './moderation-sanction-state-lock.service';
import { ModerationSanctionStateFenceService } from './moderation-sanction-state-fence.service';
import { CALLBACK_TERMINAL_FAILURE_METRIC_STATUSES } from './moderation.service.support';

type ManualModerationReleaseBridge = Pick<ManualModerationService, 'applyManualModerationAction'>;
type ModerationSanctionStateFenceBridge = Pick<
  ModerationSanctionStateFenceService,
  'isSanctionEventInvalidated'
>;

type ModerationReleaseSanctionEvent = {
  id: string;
  chatId: string;
  userId: string;
  action: SanctionAction;
  ruleCode: string;
  metadata: unknown;
  createdAt: Date;
};

export class ModerationReleaseCallbackService {
  private readonly logger = new Logger(ModerationReleaseCallbackService.name);
  private readonly sanctionStateFence: ModerationSanctionStateFenceBridge;

  constructor(
    private readonly prisma: PrismaService,
    private readonly maxClient: MaxClientService,
    private readonly manualModeration: ManualModerationReleaseBridge | null,
    sanctionStateFence?: ModerationSanctionStateFenceBridge,
  ) {
    this.sanctionStateFence = sanctionStateFence ?? new ModerationSanctionStateFenceService(prisma);
  }

  async tryHandle(update: MaxUpdate): Promise<boolean> {
    const release = parseModerationReleaseCallbackPayload(extractMaxCallbackPayloadRaw(update));
    if (!release) {
      return false;
    }

    await this.handle(update, release);
    return true;
  }

  private async handle(update: MaxUpdate, release: ModerationReleaseCallback): Promise<void> {
    const callbackId = extractMaxCallbackId(update);
    const actorUserId = extractMaxCallbackUserId(update);
    const messageChatId = update.message?.chatId.trim() ?? '';
    const botId = readString(update.botId) ?? undefined;
    const acknowledgeSilently = async () => {
      if (callbackId) {
        await this.answerCallbackSafe(callbackId, undefined, botId, messageChatId);
      }
    };

    if (
      !callbackId ||
      !actorUserId ||
      readLowerString(update.type) !== 'message_callback' ||
      !messageChatId ||
      !this.manualModeration
    ) {
      await acknowledgeSilently();
      return;
    }

    let actorAccess: MaxChatMemberAccess | null;
    try {
      actorAccess = await this.maxClient.getChatMemberAccess(messageChatId, actorUserId, {
        bypassCache: true,
        trafficClass: 'critical',
        actionHealthLane: 'critical',
        sourceTag: MAX_API_SOURCE_TAGS.MODERATION_SANCTION,
        ...(botId ? { botId } : {}),
      });
    } catch (error: unknown) {
      this.logger.debug(
        {
          chatId: messageChatId,
          actorUserId,
          error: error instanceof Error ? error.message : 'Unknown error',
        },
        'Failed to verify moderation release callback actor',
      );
      await acknowledgeSilently();
      return;
    }

    if (!actorAccess || (!actorAccess.isAdmin && !actorAccess.isOwner)) {
      await acknowledgeSilently();
      return;
    }

    const sanctionEvent = await this.loadSanctionEvent(release, messageChatId);
    if (!sanctionEvent) {
      await this.answerCallbackSafe(
        callbackId,
        'Санкция уже снята или изменилась',
        botId,
        messageChatId,
      );
      return;
    }

    try {
      if (!(await this.hasMatchingActiveSanction(release, sanctionEvent))) {
        await this.answerCallbackSafe(
          callbackId,
          'Санкция уже снята или изменилась',
          botId,
          messageChatId,
        );
        return;
      }

      const result = await this.manualModeration.applyManualModerationAction(
        sanctionEvent.chatId,
        sanctionEvent.userId,
        {
          userId: actorUserId,
          launchBotId: botId ?? null,
          username: null,
          displayName: null,
          chatId: sanctionEvent.chatId,
          chatTitle: update.message?.chatTitle ?? null,
          chatType: 'chat',
        },
        { action: release.action },
        'group_command',
        {
          actorAlreadyVerified: true,
          allowTargetDisplayNameRemoteLookup: false,
          expectedSanctionEventId: sanctionEvent.id,
        },
      );
      await this.answerCallbackSafe(callbackId, result.message, botId, messageChatId);
    } catch (error: unknown) {
      if (error instanceof ModerationSanctionStateChangedError) {
        await this.answerCallbackSafe(
          callbackId,
          'Санкция уже снята или изменилась',
          botId,
          messageChatId,
        );
        return;
      }
      if (
        error instanceof ModerationSanctionStateLockBusyError ||
        error instanceof ModerationSanctionStateLockUnavailableError ||
        error instanceof ModerationSanctionStateLockLeaseLostError
      ) {
        await acknowledgeSilently();
        return;
      }

      this.logger.warn(
        {
          chatId: sanctionEvent.chatId,
          targetUserId: sanctionEvent.userId,
          actorUserId,
          action: release.action,
          error: error instanceof Error ? error.message : 'Unknown error',
        },
        'Failed to apply moderation release callback action',
      );
      await this.answerCallbackSafe(
        callbackId,
        'Не удалось выполнить действие',
        botId,
        messageChatId,
      );
    }
  }

  private async loadSanctionEvent(
    release: ModerationReleaseCallback,
    messageChatId: string,
  ): Promise<ModerationReleaseSanctionEvent | null> {
    const expectedAction = release.action === 'UNBAN' ? SanctionAction.BAN : SanctionAction.MUTE;
    const event = await this.prisma.moderationEvent.findUnique({
      where: { id: release.sanctionEventId },
      select: {
        id: true,
        chatId: true,
        userId: true,
        action: true,
        ruleCode: true,
        metadata: true,
        createdAt: true,
      },
    });

    if (!event || event.chatId !== messageChatId || event.action !== expectedAction) {
      return null;
    }

    return event;
  }

  private async hasMatchingActiveSanction(
    release: ModerationReleaseCallback,
    sanctionEvent: ModerationReleaseSanctionEvent,
  ): Promise<boolean> {
    if (release.action === 'UNMUTE' && !this.isActiveMuteEvent(sanctionEvent)) {
      return false;
    }

    if (
      await this.sanctionStateFence.isSanctionEventInvalidated({
        chatId: sanctionEvent.chatId,
        userId: sanctionEvent.userId,
        sanctionEventId: sanctionEvent.id,
        eventCreatedAt: sanctionEvent.createdAt,
      })
    ) {
      return false;
    }

    const latestEvent = await this.prisma.moderationEvent.findFirst({
      where: {
        chatId: sanctionEvent.chatId,
        userId: sanctionEvent.userId,
        OR: [
          { action: { in: [SanctionAction.BAN, SanctionAction.MUTE] } },
          { ruleCode: { in: ['MANUAL_UNBAN', 'MANUAL_UNMUTE'] } },
        ],
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: {
        id: true,
      },
    });

    return latestEvent?.id === sanctionEvent.id;
  }

  private isActiveMuteEvent(event: ModerationReleaseSanctionEvent): boolean {
    const metadata = asRecord(event.metadata);
    if (metadata?.mutePermanent === true) {
      return true;
    }

    const expiresAt = readString(metadata?.muteExpiresAt);
    const expiresAtMs = expiresAt ? Date.parse(expiresAt) : Number.NaN;
    return Number.isFinite(expiresAtMs) && expiresAtMs > Date.now();
  }

  private async answerCallbackSafe(
    callbackId: string,
    notification?: string,
    botId?: string,
    rateLimitEntityId?: string,
  ): Promise<void> {
    try {
      await this.maxClient.answerCallback(callbackId, notification, undefined, {
        ignoreFailureMetricStatuses: CALLBACK_TERMINAL_FAILURE_METRIC_STATUSES,
        ...(botId ? { botId } : {}),
        ...(rateLimitEntityId?.trim() ? { rateLimitEntityId: rateLimitEntityId.trim() } : {}),
      });
    } catch (error: unknown) {
      this.logger.debug(
        {
          callbackId,
          error: error instanceof Error ? error.message : 'Unknown error',
        },
        'Failed to answer callback',
      );
    }
  }
}

function readString(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') {
    return null;
  }
  const normalized = String(value).trim();
  return normalized || null;
}

function readLowerString(value: unknown): string | null {
  return readString(value)?.toLowerCase() ?? null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
