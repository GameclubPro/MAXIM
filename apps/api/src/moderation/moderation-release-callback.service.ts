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
      messageChatId !== release.chatId ||
      !this.manualModeration
    ) {
      await acknowledgeSilently();
      return;
    }

    let actorAccess: MaxChatMemberAccess | null;
    try {
      actorAccess = await this.maxClient.getChatMemberAccess(release.chatId, actorUserId, {
        bypassCache: true,
        trafficClass: 'critical',
        actionHealthLane: 'critical',
        sourceTag: MAX_API_SOURCE_TAGS.MODERATION_SANCTION,
        ...(botId ? { botId } : {}),
      });
    } catch (error: unknown) {
      this.logger.debug(
        {
          chatId: release.chatId,
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

    const lock = await this.acquireLock(release);
    if (!lock) {
      await acknowledgeSilently();
      return;
    }

    try {
      if (!(await this.hasMatchingActiveSanction(release))) {
        await this.answerCallbackSafe(callbackId, 'Санкция уже снята или изменилась', botId);
        return;
      }

      const result = await this.manualModeration.applyManualModerationAction(
        release.chatId,
        release.targetUserId,
        {
          userId: actorUserId,
          launchBotId: botId ?? null,
          username: null,
          displayName: null,
          chatId: release.chatId,
          chatTitle: update.message?.chatTitle ?? null,
          chatType: 'chat',
        },
        { action: release.action },
        'group_command',
        {
          actorAlreadyVerified: true,
          allowTargetDisplayNameRemoteLookup: false,
        },
      );
      await this.answerCallbackSafe(callbackId, result.message, botId);
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId: release.chatId,
          targetUserId: release.targetUserId,
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

  private async hasMatchingActiveSanction(release: ModerationReleaseCallback): Promise<boolean> {
    const expectedAction = release.action === 'UNBAN' ? SanctionAction.BAN : SanctionAction.MUTE;
    const latestEvent = await this.prisma.moderationEvent.findFirst({
      where: {
        chatId: release.chatId,
        userId: release.targetUserId,
        OR: [
          { action: { in: [SanctionAction.BAN, SanctionAction.MUTE] } },
          { ruleCode: { in: ['MANUAL_UNBAN', 'MANUAL_UNMUTE'] } },
        ],
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: {
        action: true,
        ruleCode: true,
      },
    });

    return latestEvent?.action === expectedAction;
  }

  private async acquireLock(
    release: ModerationReleaseCallback,
  ): Promise<{ key: string; token: string; mode: 'redis' | 'memory' } | null> {
    const key = this.buildLockKey(release);
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
            chatId: release.chatId,
            targetUserId: release.targetUserId,
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

  private buildLockKey(release: ModerationReleaseCallback): string {
    const digest = createHash('sha256')
      .update(`${release.chatId}\u0000${release.targetUserId}`)
      .digest('hex');
    return `moderation-release-action:v1:${digest}`;
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
