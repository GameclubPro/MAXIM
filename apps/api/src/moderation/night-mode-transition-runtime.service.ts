import { Injectable, Optional } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ChatEntityType, type ChatSettings, type Prisma } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import {
  NIGHT_MODE_TRANSITION_PROCESS_CONTINUE,
  NIGHT_MODE_TRANSITION_PROCESS_STOP,
  type NightModeTransitionJob,
  type NightModeTransitionProcessResult,
} from './night-mode-transition.queue';
import {
  resolveNightModeTransitionSnapshot as resolveNightModeTransitionSnapshotValue,
  type NightModeTransitionSnapshot,
} from './night-mode-transition-time.util';
import {
  NIGHT_MODE_TRANSITION_LOCK_TTL_MS,
  NIGHT_MODE_TRANSITION_STATE_TTL_SEC,
  type NightModeTransitionState,
} from './moderation.service.support';
import { RedisCounterService } from './redis-counter.service';

export type NightModeTransitionNoticeResult = NightModeTransitionProcessResult & {
  messageId: string | null;
};

export type NightModeTransitionRuntimeSettings = Pick<
  ChatSettings,
  | 'chatId'
  | 'nightModeEnabled'
  | 'nightModeStartTimeMinutes'
  | 'nightModeEndTimeMinutes'
  | 'nightModeTimezone'
  | 'nightModeBotMessageEnabled'
  | 'nightModeBotMessageText'
  | 'nightModeCommentsEnabled'
  | 'nightModeOpenMessageEnabled'
  | 'nightModeOpenMessageText'
  | 'nightModeBotButtons'
  | 'nightModeBotButtonEnabled'
  | 'nightModeBotButtonUrl'
  | 'nightModeBotButtonText'
  | 'nightModeRulesButtonEnabled'
  | 'commentsEnabled'
  | 'botSpeechStyle'
  | 'botSpeechMedia'
> & {
  chat?: {
    entityType?: ChatEntityType | null;
    rules?: {
      publishedUrl: string | null;
      publishedMessageId: string | null;
    } | null;
  } | null;
};

export type NightModeTransitionRuntimeHooks = {
  sendClosedNotice(
    settings: NightModeTransitionRuntimeSettings,
    snapshot: {
      startMinutes: number;
      endMinutes: number;
      timezone: string;
      sessionKey: string;
    },
  ): Promise<NightModeTransitionNoticeResult>;
  sendOpenedNotice(
    settings: Pick<
      NightModeTransitionRuntimeSettings,
      'chatId' | 'nightModeOpenMessageText' | 'botSpeechStyle' | 'botSpeechMedia'
    >,
    snapshot: {
      startMinutes: number;
      endMinutes: number;
      timezone: string;
      sessionKey: string;
    },
  ): Promise<NightModeTransitionProcessResult>;
  deleteClosedNotice(
    chatId: string,
    messageId: string,
  ): Promise<NightModeTransitionProcessResult>;
};

type NightModeTransitionLock = {
  key: string;
  token: string;
  redis: boolean;
};

@Injectable()
export class NightModeTransitionRuntimeService {
  private readonly nightModeTransitionMemoryState = new Map<string, NightModeTransitionState>();
  private readonly nightModeTransitionMemoryLocks = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly redisCounter?: RedisCounterService,
  ) {}

  async processNightModeTransitionJob(
    job: NightModeTransitionJob,
    hooks: NightModeTransitionRuntimeHooks,
  ): Promise<NightModeTransitionProcessResult> {
    if (typeof this.prisma.chatSettings?.findUnique !== 'function') {
      return NIGHT_MODE_TRANSITION_PROCESS_CONTINUE;
    }

    const settings = await this.prisma.chatSettings.findUnique({
      where: { chatId: job.chatId },
      include: {
        chat: {
          select: {
            entityType: true,
            rules: {
              select: {
                publishedUrl: true,
                publishedMessageId: true,
              },
            },
          },
        },
      },
    });
    if (!settings?.nightModeEnabled) {
      return NIGHT_MODE_TRANSITION_PROCESS_CONTINUE;
    }
    if (settings.chat?.entityType === ChatEntityType.CHANNEL) {
      return NIGHT_MODE_TRANSITION_PROCESS_STOP;
    }

    const scheduledFor = new Date(job.scheduledFor);
    if (Number.isNaN(scheduledFor.getTime())) {
      return NIGHT_MODE_TRANSITION_PROCESS_CONTINUE;
    }

    const scheduledSnapshot = this.resolveNightModeTransitionSnapshot(settings, scheduledFor);
    const currentSnapshot = this.resolveNightModeTransitionSnapshot(settings);
    if (
      !scheduledSnapshot ||
      !currentSnapshot ||
      scheduledSnapshot.startMinutes === scheduledSnapshot.endMinutes ||
      currentSnapshot.startMinutes === currentSnapshot.endMinutes
    ) {
      return NIGHT_MODE_TRANSITION_PROCESS_CONTINUE;
    }

    if (
      scheduledSnapshot.sessionKey !== job.sessionKey ||
      currentSnapshot.sessionKey !== job.sessionKey
    ) {
      return NIGHT_MODE_TRANSITION_PROCESS_CONTINUE;
    }
    if (job.transition === 'close') {
      if (
        scheduledSnapshot.status !== 'closed' ||
        !scheduledSnapshot.isCloseBoundary ||
        currentSnapshot.status !== 'closed'
      ) {
        return NIGHT_MODE_TRANSITION_PROCESS_CONTINUE;
      }

      return this.processNightModeTransitionForChat(settings, hooks, scheduledSnapshot);
    }

    if (
      scheduledSnapshot.status !== 'open' ||
      !scheduledSnapshot.isOpenBoundary ||
      currentSnapshot.status !== 'open'
    ) {
      return NIGHT_MODE_TRANSITION_PROCESS_CONTINUE;
    }

    return this.processNightModeTransitionForChat(settings, hooks, scheduledSnapshot);
  }

  async processNightModeTransitionForChat(
    settings: NightModeTransitionRuntimeSettings,
    hooks: NightModeTransitionRuntimeHooks,
    providedSnapshot?: NightModeTransitionSnapshot,
  ): Promise<NightModeTransitionProcessResult> {
    const snapshot = providedSnapshot ?? this.resolveNightModeTransitionSnapshot(settings);
    if (!snapshot) {
      return NIGHT_MODE_TRANSITION_PROCESS_CONTINUE;
    }

    const lock = await this.acquireNightModeTransitionLock(settings.chatId);
    if (!lock) {
      return NIGHT_MODE_TRANSITION_PROCESS_CONTINUE;
    }

    try {
      const currentState = await this.readNightModeTransitionState(settings.chatId);
      if (snapshot.status === 'closed') {
        const alreadyClosedForSession =
          currentState?.status === 'closed' && currentState.sessionKey === snapshot.sessionKey;
        if (
          alreadyClosedForSession &&
          (!snapshot.isCloseBoundary ||
            !settings.nightModeBotMessageEnabled ||
            currentState.closeNoticeMessageId)
        ) {
          return NIGHT_MODE_TRANSITION_PROCESS_CONTINUE;
        }

        let closeNoticeMessageId = alreadyClosedForSession
          ? (currentState.closeNoticeMessageId ?? null)
          : null;
        if (
          snapshot.isCloseBoundary &&
          settings.nightModeBotMessageEnabled &&
          !closeNoticeMessageId
        ) {
          closeNoticeMessageId = await this.findPersistedCloseNoticeMessageId(
            settings.chatId,
            snapshot.sessionKey,
          );
        }
        if (
          snapshot.isCloseBoundary &&
          settings.nightModeBotMessageEnabled &&
          !closeNoticeMessageId
        ) {
          const noticeResult = await hooks.sendClosedNotice(settings, snapshot);
          if (!noticeResult.shouldEnqueueNext) {
            return noticeResult;
          }
          closeNoticeMessageId = noticeResult.messageId;
        }

        await this.writeNightModeTransitionState(settings.chatId, {
          status: 'closed',
          sessionKey: snapshot.sessionKey,
          closeNoticeMessageId,
          updatedAt: new Date().toISOString(),
        });
        return NIGHT_MODE_TRANSITION_PROCESS_CONTINUE;
      }

      const previousCloseNoticeMessageId =
        currentState?.status === 'closed' ? currentState.closeNoticeMessageId : null;
      const transitionAlreadyRecorded =
        currentState?.status === 'open' && currentState.sessionKey === snapshot.sessionKey;

      if (previousCloseNoticeMessageId) {
        const deleteResult = await hooks.deleteClosedNotice(
          settings.chatId,
          previousCloseNoticeMessageId,
        );
        if (!deleteResult.shouldEnqueueNext) {
          return deleteResult;
        }
      }

      if (
        snapshot.isOpenBoundary &&
        settings.nightModeOpenMessageEnabled &&
        !transitionAlreadyRecorded
      ) {
        const noticeResult = await hooks.sendOpenedNotice(settings, snapshot);
        if (!noticeResult.shouldEnqueueNext) {
          return noticeResult;
        }
      }

      await this.writeNightModeTransitionState(settings.chatId, {
        status: 'open',
        sessionKey: snapshot.sessionKey,
        closeNoticeMessageId: null,
        updatedAt: new Date().toISOString(),
      });
      return NIGHT_MODE_TRANSITION_PROCESS_CONTINUE;
    } finally {
      await this.releaseNightModeTransitionLock(lock);
    }
  }

  resolveNightModeTransitionSnapshot(
    settings: Pick<
      ChatSettings,
      | 'nightModeEnabled'
      | 'nightModeStartTimeMinutes'
      | 'nightModeEndTimeMinutes'
      | 'nightModeTimezone'
    >,
    now = new Date(),
  ): NightModeTransitionSnapshot | null {
    return resolveNightModeTransitionSnapshotValue(settings, now);
  }

  private buildNightModeTransitionStateKey(chatId: string): string {
    return `night-mode-transition-state:v1:${chatId}`;
  }

  private buildNightModeTransitionLockKey(chatId: string): string {
    return `night-mode-transition-lock:v1:${chatId}`;
  }

  private async findPersistedCloseNoticeMessageId(
    chatId: string,
    sessionKey: string,
  ): Promise<string | null> {
    if (typeof this.prisma.moderationEvent?.findFirst !== 'function') {
      return null;
    }

    const event = await this.prisma.moderationEvent.findFirst({
      where: {
        chatId,
        ruleCode: 'NIGHT_MODE_CLOSE_NOTICE',
        messageId: {
          not: null,
        },
        metadata: {
          path: ['sessionKey'],
          equals: sessionKey,
        } satisfies Prisma.JsonFilter,
      },
      select: {
        messageId: true,
      },
      orderBy: {
        createdAt: 'desc',
      },
    });
    const messageId = event?.messageId?.trim() ?? '';
    return messageId ? messageId : null;
  }

  private async readNightModeTransitionState(
    chatId: string,
  ): Promise<NightModeTransitionState | null> {
    const key = this.buildNightModeTransitionStateKey(chatId);
    const raw = this.redisCounter
      ? await this.redisCounter.getString(key)
      : JSON.stringify(this.nightModeTransitionMemoryState.get(key) ?? null);
    if (!raw) {
      return null;
    }

    try {
      const parsed = JSON.parse(raw) as unknown;
      return this.parseNightModeTransitionState(parsed);
    } catch {
      return null;
    }
  }

  private async writeNightModeTransitionState(
    chatId: string,
    state: NightModeTransitionState,
  ): Promise<void> {
    const key = this.buildNightModeTransitionStateKey(chatId);
    if (this.redisCounter) {
      await this.redisCounter.setStringWithTtl(
        key,
        JSON.stringify(state),
        NIGHT_MODE_TRANSITION_STATE_TTL_SEC,
      );
      return;
    }

    this.nightModeTransitionMemoryState.set(key, state);
  }

  private parseNightModeTransitionState(value: unknown): NightModeTransitionState | null {
    const record = this.asRecord(value);
    if (!record) {
      return null;
    }

    const status = record.status;
    const sessionKey = record.sessionKey;
    if ((status !== 'open' && status !== 'closed') || typeof sessionKey !== 'string') {
      return null;
    }

    const closeNoticeMessageId =
      typeof record.closeNoticeMessageId === 'string' && record.closeNoticeMessageId.trim()
        ? record.closeNoticeMessageId.trim()
        : null;
    const updatedAt =
      typeof record.updatedAt === 'string' && record.updatedAt.trim()
        ? record.updatedAt.trim()
        : undefined;

    return {
      status,
      sessionKey,
      closeNoticeMessageId,
      ...(updatedAt ? { updatedAt } : {}),
    };
  }

  private async acquireNightModeTransitionLock(
    chatId: string,
  ): Promise<NightModeTransitionLock | null> {
    const key = this.buildNightModeTransitionLockKey(chatId);
    if (this.redisCounter) {
      const token = await this.redisCounter.acquireLock(key, NIGHT_MODE_TRANSITION_LOCK_TTL_MS);
      return token ? { key, token, redis: true } : null;
    }

    if (this.nightModeTransitionMemoryLocks.has(key)) {
      return null;
    }

    const token = randomUUID();
    this.nightModeTransitionMemoryLocks.add(key);
    return { key, token, redis: false };
  }

  private async releaseNightModeTransitionLock(lock: NightModeTransitionLock): Promise<void> {
    if (lock.redis) {
      await this.redisCounter?.releaseLock(lock.key, lock.token);
      return;
    }

    this.nightModeTransitionMemoryLocks.delete(lock.key);
  }

  private asRecord(value: unknown): Record<string, unknown> | null {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
    return null;
  }
}
