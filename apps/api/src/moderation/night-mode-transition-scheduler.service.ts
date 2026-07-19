import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Queue } from 'bullmq';
import { buildMaxActionNoExecutableRouteMessage } from '../max/max-action-dispatch-error';
import { ChatBotMembershipStatus, ChatEntityType } from '../prisma/prisma-client';
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
  resolveCurrentNightModeOpenOccurrence,
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

        await this.enqueueChatSettingsRows(settingsRows, {
          includeCurrentClose: true,
          includeCurrentOpen: true,
        });

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
        includeCurrentOpen: true,
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
        includeCurrentOpen: true,
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
        includeCurrentOpen: true,
      });
    }
  }

  private async enqueueChatSettingsRows(
    settingsRows: readonly (NightModeTransitionScheduleSettings & { chatId: string })[],
    options: { includeCurrentClose?: boolean; includeCurrentOpen?: boolean } = {},
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
    if (typeof this.prisma.chat?.findUnique === 'function' && !(await this.isChatEntity(chatId))) {
      return false;
    }

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

  private async isChatEntity(chatId: string): Promise<boolean> {
    const chat = await this.prisma.chat.findUnique({
      where: { id: chatId },
      select: {
        entityType: true,
      },
    });
    return chat?.entityType === ChatEntityType.CHAT;
  }

  private buildActiveOrLegacyBotMembershipFilter() {
    return {
      entityType: ChatEntityType.CHAT,
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
    options: { includeCurrentClose?: boolean; includeCurrentOpen?: boolean } = {},
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
      const jobId = buildNightModeTransitionJobId(
        chatId,
        occurrence.transition,
        scheduledFor,
        occurrence.sessionKey,
      );
      const isCurrentCatchUp =
        occurrence.dueAt.getTime() <= nowMs &&
        ((options.includeCurrentOpen === true && occurrence.transition === 'open') ||
          (options.includeCurrentClose === true && occurrence.transition === 'close'));
      if (
        isCurrentCatchUp &&
        !(await this.canEnqueueCurrentCatchUp({
          chatId,
          jobId,
          sessionKey: occurrence.sessionKey,
          transition: occurrence.transition,
        }))
      ) {
        continue;
      }

      await this.queue.add(
        NIGHT_MODE_TRANSITION_JOB_NAME,
        {
          chatId,
          transition: occurrence.transition,
          scheduledFor,
          sessionKey: occurrence.sessionKey,
          retryPolicyName: 'night-mode-transition',
          transitionRuntimeVersion: 2,
          createdAt: new Date().toISOString(),
        },
        {
          jobId,
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

  private async canEnqueueCurrentCatchUp(params: {
    chatId: string;
    jobId: string;
    sessionKey: string;
    transition: NightModeTransitionOccurrence['transition'];
  }): Promise<boolean> {
    if (!this.queue || typeof this.queue.getJob !== 'function') {
      return true;
    }

    try {
      const existing = await this.queue.getJob(params.jobId);
      if (!existing || typeof existing.getState !== 'function') {
        return true;
      }

      if ((await existing.getState()) !== 'failed') {
        return true;
      }

      const transitionRuntimeVersion = existing.data.transitionRuntimeVersion;
      const legacyPreDispatchNoRouteFailure =
        existing.failedReason ===
        buildMaxActionNoExecutableRouteMessage('SEND_MESSAGE', params.chatId);
      const recoverableLegacyOpenFailure =
        params.transition === 'open' &&
        transitionRuntimeVersion === undefined &&
        this.isRecoverableCurrentOpenFailure(existing.failedReason);
      if (!legacyPreDispatchNoRouteFailure && !recoverableLegacyOpenFailure) {
        this.logger.warn(
          {
            chatId: params.chatId,
            jobId: params.jobId,
            sessionKey: params.sessionKey,
            transitionRuntimeVersion: transitionRuntimeVersion ?? null,
            failedReason: existing.failedReason ?? null,
          },
          'Skipped night mode catch-up after an ambiguous or terminal prior failure',
        );
        return false;
      }

      await existing.remove();
      return true;
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId: params.chatId,
          jobId: params.jobId,
          sessionKey: params.sessionKey,
          error: error instanceof Error ? error.message : String(error),
        },
        'Could not safely inspect a failed night mode opening job for catch-up',
      );
      return false;
    }
  }

  private isRecoverableCurrentOpenFailure(failedReason: string | undefined): boolean {
    const normalized = failedReason?.trim().toLowerCase() ?? '';
    return normalized.includes('user.not.admin') || normalized.includes('user is not an admin');
  }

  private resolveTransitionOccurrences(
    settings: NightModeTransitionScheduleSettings,
    options: { includeCurrentClose?: boolean; includeCurrentOpen?: boolean },
  ): NightModeTransitionOccurrence[] {
    const occurrences = resolveNextNightModeTransitionOccurrences(settings);
    if (!options.includeCurrentClose && !options.includeCurrentOpen) {
      return occurrences;
    }

    const currentOccurrences = [
      ...(options.includeCurrentClose ? [resolveCurrentNightModeCloseOccurrence(settings)] : []),
      ...(options.includeCurrentOpen ? [resolveCurrentNightModeOpenOccurrence(settings)] : []),
    ].filter((occurrence): occurrence is NightModeTransitionOccurrence => occurrence !== null);

    if (currentOccurrences.length === 0) {
      return occurrences;
    }

    const currentOccurrenceKeys = new Set(
      currentOccurrences.map((occurrence) => `${occurrence.transition}:${occurrence.sessionKey}`),
    );
    return [
      ...currentOccurrences,
      ...occurrences.filter(
        (occurrence) =>
          !currentOccurrenceKeys.has(`${occurrence.transition}:${occurrence.sessionKey}`),
      ),
    ].sort((left, right) => left.dueAt.getTime() - right.dueAt.getTime());
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
