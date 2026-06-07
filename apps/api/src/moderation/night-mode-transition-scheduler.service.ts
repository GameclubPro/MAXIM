import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Queue } from 'bullmq';
import { ChatBotMembershipStatus } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { getAppRole, roleRunsModeration } from '../runtime/app-role';
import { moderationBackgroundTasksEnabled } from '../runtime/moderation-runtime';
import { DEFAULT_NIGHT_MODE_TRANSITION_STARTUP_DELAY_MS } from './moderation.service.support';
import {
  buildNightModeTransitionJobId,
  buildNightModeTransitionJobIdPrefix,
  NIGHT_MODE_TRANSITION_JOB_NAME,
  NIGHT_MODE_TRANSITION_QUEUE,
  type NightModeTransitionJob,
} from './night-mode-transition.queue';
import {
  resolveCurrentNightModeCloseOccurrence,
  resolveNextNightModeTransitionOccurrences,
  type NightModeTransitionOccurrence,
  type NightModeTransitionScheduleSettings,
} from './night-mode-transition-time.util';

const NIGHT_MODE_TRANSITION_JOB_ATTEMPTS = 3;
const NIGHT_MODE_TRANSITION_JOB_BACKOFF_MS = 15_000;
const NIGHT_MODE_TRANSITION_BOOTSTRAP_BATCH_SIZE = 200;

@Injectable()
export class NightModeTransitionSchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NightModeTransitionSchedulerService.name);
  private readonly startupDelayMs: number;
  private readonly backgroundTasksEnabled: boolean;
  private startupTimer: NodeJS.Timeout | null = null;
  private bootstrapInFlight = false;

  constructor(
    private readonly prisma: PrismaService,
    @Optional()
    @InjectQueue(NIGHT_MODE_TRANSITION_QUEUE)
    private readonly queue?: Queue<NightModeTransitionJob>,
    @Optional() configService?: ConfigService,
  ) {
    this.startupDelayMs = this.readNonNegativeConfigInt(
      configService?.get<number>('NIGHT_MODE_TRANSITION_STARTUP_DELAY_MS'),
      DEFAULT_NIGHT_MODE_TRANSITION_STARTUP_DELAY_MS,
    );
    this.backgroundTasksEnabled = moderationBackgroundTasksEnabled(
      configService?.get<boolean | string>('MODERATION_BACKGROUND_TASKS_ENABLED'),
    );
  }

  onModuleInit(): void {
    if (!roleRunsModeration(getAppRole()) || !this.backgroundTasksEnabled) {
      return;
    }

    this.startupTimer = setTimeout(() => {
      this.startupTimer = null;
      void this.bootstrapEnabledChats();
    }, this.startupDelayMs);
    this.startupTimer.unref();
  }

  onModuleDestroy(): void {
    if (this.startupTimer) {
      clearTimeout(this.startupTimer);
      this.startupTimer = null;
    }
  }

  async bootstrapEnabledChats(): Promise<void> {
    if (
      this.bootstrapInFlight ||
      !this.queue ||
      typeof this.prisma.chatSettings?.findMany !== 'function'
    ) {
      return;
    }

    this.bootstrapInFlight = true;
    try {
      let cursor: { chatId: string } | undefined;
      for (;;) {
        const settingsRows = await this.prisma.chatSettings.findMany({
          where: {
            nightModeEnabled: true,
            chat: this.buildActiveOrLegacyBotMembershipFilter(),
          },
          select: {
            chatId: true,
            nightModeEnabled: true,
            nightModeStartTimeMinutes: true,
            nightModeEndTimeMinutes: true,
            nightModeTimezone: true,
          },
          orderBy: {
            chatId: 'asc',
          },
          take: NIGHT_MODE_TRANSITION_BOOTSTRAP_BATCH_SIZE,
          ...(cursor
            ? {
                skip: 1,
                cursor,
              }
            : {}),
        });

        await this.enqueueChatSettingsRows(settingsRows, { includeCurrentClose: true });

        if (settingsRows.length < NIGHT_MODE_TRANSITION_BOOTSTRAP_BATCH_SIZE) {
          break;
        }
        cursor = { chatId: settingsRows[settingsRows.length - 1]!.chatId };
      }
    } catch (error: unknown) {
      this.logger.warn(
        {
          error: error instanceof Error ? error.message : String(error),
        },
        'Failed to bootstrap night mode transition jobs',
      );
    } finally {
      this.bootstrapInFlight = false;
    }
  }

  async reconcileChat(chatId: string): Promise<void> {
    const normalizedChatIds = this.normalizeChatIds([chatId]);
    if (normalizedChatIds.length === 0 || !this.queue) {
      return;
    }

    const settings = await this.findEnabledSettingsForChat(normalizedChatIds[0]!);

    await this.clearChatJobsForChatIds(normalizedChatIds);
    if (settings) {
      await this.enqueueChatSettingsOccurrences(settings.chatId, settings, {
        includeCurrentClose: true,
      });
    }
  }

  async enqueueNextTransitionsForChat(chatId: string): Promise<void> {
    const normalizedChatIds = this.normalizeChatIds([chatId]);
    if (normalizedChatIds.length === 0 || !this.queue) {
      return;
    }

    const settings = await this.findEnabledSettingsForChat(normalizedChatIds[0]!);
    if (settings) {
      await this.enqueueChatSettingsOccurrences(settings.chatId, settings);
    }
  }

  async reconcileChats(chatIds: readonly string[]): Promise<void> {
    const normalizedChatIds = this.normalizeChatIds(chatIds);
    if (normalizedChatIds.length === 0 || !this.queue) {
      return;
    }

    const settingsRows = await this.findEnabledSettingsForChats(normalizedChatIds);

    await this.reconcileChatSettingsRows(settingsRows, normalizedChatIds);
  }

  async reconcileChatSettings(
    chatId: string,
    settings: NightModeTransitionScheduleSettings,
  ): Promise<void> {
    if (!this.queue) {
      return;
    }

    await this.clearChatJobsForChatIds([chatId]);
    if (await this.hasActiveBotMembership(chatId)) {
      await this.enqueueChatSettingsOccurrences(chatId, settings, {
        includeCurrentClose: true,
      });
    }
  }

  async clearChatJobs(chatId: string): Promise<void> {
    await this.clearChatJobsForChatIds([chatId]);
  }

  private async reconcileChatSettingsRows(
    settingsRows: readonly (NightModeTransitionScheduleSettings & { chatId: string })[],
    chatIds: readonly string[] = settingsRows.map((settings) => settings.chatId),
  ): Promise<void> {
    if (!this.queue) {
      return;
    }

    await this.clearChatJobsForChatIds(chatIds);
    for (const settings of settingsRows) {
      await this.enqueueChatSettingsOccurrences(settings.chatId, settings, {
        includeCurrentClose: true,
      });
    }
  }

  private async enqueueChatSettingsRows(
    settingsRows: readonly (NightModeTransitionScheduleSettings & { chatId: string })[],
    options: { includeCurrentClose?: boolean } = {},
  ): Promise<void> {
    if (!this.queue) {
      return;
    }

    for (const settings of settingsRows) {
      await this.enqueueChatSettingsOccurrences(settings.chatId, settings, options);
    }
  }

  private async findEnabledSettingsForChat(
    chatId: string,
  ): Promise<(NightModeTransitionScheduleSettings & { chatId: string }) | null> {
    if (typeof this.prisma.chatSettings?.findFirst === 'function') {
      return this.prisma.chatSettings.findFirst({
        where: {
          chatId,
          nightModeEnabled: true,
          chat: this.buildActiveOrLegacyBotMembershipFilter(),
        },
        select: {
          chatId: true,
          nightModeEnabled: true,
          nightModeStartTimeMinutes: true,
          nightModeEndTimeMinutes: true,
          nightModeTimezone: true,
        },
      });
    }

    const settings = await this.prisma.chatSettings.findUnique({
      where: { chatId },
      select: {
        chatId: true,
        nightModeEnabled: true,
        nightModeStartTimeMinutes: true,
        nightModeEndTimeMinutes: true,
        nightModeTimezone: true,
      },
    });
    if (!settings?.nightModeEnabled || !(await this.hasActiveBotMembership(chatId))) {
      return null;
    }

    return settings;
  }

  private async findEnabledSettingsForChats(
    chatIds: readonly string[],
  ): Promise<(NightModeTransitionScheduleSettings & { chatId: string })[]> {
    if (typeof this.prisma.chatSettings?.findMany !== 'function') {
      return [];
    }

    return this.prisma.chatSettings.findMany({
      where: {
        chatId: {
          in: [...chatIds],
        },
        nightModeEnabled: true,
        chat: this.buildActiveOrLegacyBotMembershipFilter(),
      },
      select: {
        chatId: true,
        nightModeEnabled: true,
        nightModeStartTimeMinutes: true,
        nightModeEndTimeMinutes: true,
        nightModeTimezone: true,
      },
    });
  }

  private async hasActiveBotMembership(chatId: string): Promise<boolean> {
    if (typeof this.prisma.chatBotMembership?.count !== 'function') {
      return true;
    }

    const count = await this.prisma.chatBotMembership.count({
      where: {
        chatId,
      },
    });
    if (count === 0) {
      return true;
    }

    const activeCount = await this.prisma.chatBotMembership.count({
      where: {
        chatId,
        status: ChatBotMembershipStatus.ACTIVE,
      },
    });
    return activeCount > 0;
  }

  private buildActiveOrLegacyBotMembershipFilter() {
    return {
      OR: [
        {
          botMemberships: {
            some: {
              status: ChatBotMembershipStatus.ACTIVE,
            },
          },
        },
        {
          botMemberships: {
            none: {},
          },
        },
      ],
    };
  }

  private async enqueueChatSettingsOccurrences(
    chatId: string,
    settings: NightModeTransitionScheduleSettings,
    options: { includeCurrentClose?: boolean } = {},
  ): Promise<void> {
    if (!this.queue) {
      return;
    }

    const occurrences = this.resolveTransitionOccurrences(settings, options);
    if (occurrences.length === 0) {
      return;
    }

    const nowMs = Date.now();
    for (const occurrence of occurrences) {
      const scheduledFor = occurrence.dueAt.toISOString();
      await this.queue.add(
        NIGHT_MODE_TRANSITION_JOB_NAME,
        {
          chatId,
          transition: occurrence.transition,
          scheduledFor,
          sessionKey: occurrence.sessionKey,
          retryPolicyName: 'night-mode-transition',
          createdAt: new Date().toISOString(),
        },
        {
          jobId: buildNightModeTransitionJobId(
            chatId,
            occurrence.transition,
            scheduledFor,
            occurrence.sessionKey,
          ),
          delay: Math.max(0, occurrence.dueAt.getTime() - nowMs),
          attempts: NIGHT_MODE_TRANSITION_JOB_ATTEMPTS,
          backoff: {
            type: 'fixed',
            delay: NIGHT_MODE_TRANSITION_JOB_BACKOFF_MS,
          },
          removeOnComplete: true,
          removeOnFail: 1_000,
        },
      );
    }
  }

  private resolveTransitionOccurrences(
    settings: NightModeTransitionScheduleSettings,
    options: { includeCurrentClose?: boolean },
  ): NightModeTransitionOccurrence[] {
    const occurrences = resolveNextNightModeTransitionOccurrences(settings);
    if (!options.includeCurrentClose) {
      return occurrences;
    }

    const currentClose = resolveCurrentNightModeCloseOccurrence(settings);
    if (
      !currentClose ||
      occurrences.some(
        (occurrence) =>
          occurrence.transition === currentClose.transition &&
          occurrence.sessionKey === currentClose.sessionKey,
      )
    ) {
      return occurrences;
    }

    return [currentClose, ...occurrences].sort(
      (left, right) => left.dueAt.getTime() - right.dueAt.getTime(),
    );
  }

  private async clearChatJobsForChatIds(chatIds: readonly string[]): Promise<void> {
    if (!this.queue) {
      return;
    }

    const prefixes = new Set(
      this.normalizeChatIds(chatIds).map(buildNightModeTransitionJobIdPrefix),
    );
    if (prefixes.size === 0) {
      return;
    }
    const prefixList = Array.from(prefixes);

    const jobs = await this.queue.getJobs(['delayed', 'waiting', 'prioritized', 'paused'], 0, -1);
    for (const job of jobs) {
      if (typeof job.id === 'string' && prefixList.some((prefix) => job.id?.startsWith(prefix))) {
        await this.removeJob(job);
      }
    }
  }

  private normalizeChatIds(chatIds: readonly string[]): string[] {
    return Array.from(new Set(chatIds.map((item) => item.trim()).filter(Boolean)));
  }

  private async removeJob(job: { id?: string; remove(): Promise<void> }): Promise<void> {
    try {
      await job.remove();
    } catch (error: unknown) {
      this.logger.debug(
        {
          jobId: job.id,
          error: error instanceof Error ? error.message : String(error),
        },
        'Failed to remove old night mode transition job',
      );
    }
  }

  private readNonNegativeConfigInt(value: unknown, fallback: number): number {
    const numericValue =
      typeof value === 'number'
        ? value
        : typeof value === 'string' && value.trim().length > 0
          ? Number(value)
          : Number.NaN;
    if (Number.isFinite(numericValue) && numericValue >= 0) {
      return Math.trunc(numericValue);
    }

    return fallback;
  }
}
