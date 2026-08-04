import { Logger } from '@nestjs/common';
import type { MaxUpdate } from '@maxim/contracts';
import { createHash, randomUUID } from 'node:crypto';
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
import type { RedisCounterService } from './redis-counter.service';
import { CALLBACK_TERMINAL_FAILURE_METRIC_STATUSES } from './moderation.service.support';

const MODERATION_RELEASE_ACTION_LOCK_TTL_MS = 60_000;

type ManualModerationReleaseBridge = Pick<ManualModerationService, 'applyManualModerationAction'>;

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
  private readonly memoryLocks = new Map<string, string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly maxClient: MaxClientService,
    private readonly manualModeration: ManualModerationReleaseBridge | null,
    private readonly redisCounter?: RedisCounterService,
  ) {}

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
        await this.answerCallbackSafe(callbackId, undefined, botId);
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
      await this.answerCallbackSafe(callbackId, 'Санкция уже снята или изменилась', botId);
      return;
    }

    const subject = {
      chatId: sanctionEvent.chatId,
      targetUserId: sanctionEvent.userId,
    };
    const lock = await this.acquireLock(subject);
    if (!lock) {
      await acknowledgeSilently();
      return;
    }

    try {
      if (!(await this.hasMatchingActiveSanction(release, sanctionEvent))) {
        await this.answerCallbackSafe(callbackId, 'Санкция уже снята или изменилась', botId);
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
      await this.answerCallbackSafe(callbackId, result.message, botId);
    } catch (error: unknown) {
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
      await this.answerCallbackSafe(callbackId, 'Не удалось выполнить действие', botId);
    } finally {
      await this.releaseLock(lock);
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

  private async acquireLock(subject: {
    chatId: string;
    targetUserId: string;
  }): Promise<{ key: string; token: string; mode: 'redis' | 'memory' } | null> {
    const key = this.buildLockKey(subject);
    const acquireLock = (this.redisCounter as Partial<RedisCounterService> | undefined)
      ?.acquireLock;
    if (typeof acquireLock === 'function' && this.redisCounter) {
      try {
        const token = await acquireLock.call(
          this.redisCounter,
          key,
          MODERATION_RELEASE_ACTION_LOCK_TTL_MS,
        );
        return token ? { key, token, mode: 'redis' } : null;
      } catch (error: unknown) {
        this.logger.warn(
          {
            chatId: subject.chatId,
            targetUserId: subject.targetUserId,
            error: error instanceof Error ? error.message : 'Unknown error',
          },
          'Failed to acquire moderation release callback lock',
        );
        return null;
      }
    }

    if (this.memoryLocks.has(key)) {
      return null;
    }
    const token = randomUUID();
    this.memoryLocks.set(key, token);
    return { key, token, mode: 'memory' };
  }

  private async releaseLock(lock: {
    key: string;
    token: string;
    mode: 'redis' | 'memory';
  }): Promise<void> {
    if (lock.mode === 'memory') {
      if (this.memoryLocks.get(lock.key) === lock.token) {
        this.memoryLocks.delete(lock.key);
      }
      return;
    }

    try {
      await this.redisCounter?.releaseLock(lock.key, lock.token);
    } catch (error: unknown) {
      this.logger.debug(
        {
          key: lock.key,
          error: error instanceof Error ? error.message : 'Unknown error',
        },
        'Failed to release moderation release callback lock',
      );
    }
  }

  private buildLockKey(subject: { chatId: string; targetUserId: string }): string {
    const digest = createHash('sha256')
      .update(`${subject.chatId}\u0000${subject.targetUserId}`)
      .digest('hex');
    return `moderation-release-action:v2:${digest}`;
  }

  private async answerCallbackSafe(
    callbackId: string,
    notification?: string,
    botId?: string,
  ): Promise<void> {
    try {
      await this.maxClient.answerCallback(callbackId, notification, undefined, {
        ignoreFailureMetricStatuses: CALLBACK_TERMINAL_FAILURE_METRIC_STATUSES,
        ...(botId ? { botId } : {}),
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
