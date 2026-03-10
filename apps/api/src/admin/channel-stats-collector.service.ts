import { ChatEntityType, Prisma } from '@prisma/client';
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { getAppRole, roleRunsAction } from '../runtime/app-role';
import { MaxClientService, type MaxChannelMessageSnapshot } from '../max/max-client.service';
import { PrismaService } from '../prisma/prisma.service';

const CHANNEL_STATS_SYNC_INTERVAL_MS = 60 * 60 * 1000;
const CHANNEL_STATS_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;
const CHANNEL_STATS_STALE_MS = 2 * 60 * 60 * 1000;
const CHANNEL_STATS_ALL_LOCK_TTL_MS = 30 * 60 * 1000;
const CHANNEL_STATS_CHAT_LOCK_TTL_MS = 10 * 60 * 1000;
const CHANNEL_STATS_SUBSCRIPTIONS_LOCK_TTL_MS = 60 * 1000;
const CHANNEL_STATS_REQUIRED_UPDATE_TYPES = [
  'message_created',
  'message_callback',
  'user_added',
  'user_removed',
  'bot_added',
  'bot_removed',
  'bot_started',
] as const;

@Injectable()
export class ChannelStatsCollectorService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ChannelStatsCollectorService.name);
  private readonly redis: Redis;
  private readonly backgroundEnabled = roleRunsAction(getAppRole());
  private readonly syncIntervalMs: number;
  private timer: NodeJS.Timeout | null = null;
  private scheduledSyncInFlight = false;
  private subscriptionCoverageFrom: Date | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly maxClient: MaxClientService,
    configService: ConfigService,
  ) {
    this.redis = new Redis(configService.getOrThrow<string>('REDIS_URL'));
    this.syncIntervalMs = CHANNEL_STATS_SYNC_INTERVAL_MS;
  }

  onModuleInit() {
    if (!this.backgroundEnabled) {
      return;
    }

    this.timer = setInterval(() => {
      void this.syncAllChannels('scheduled');
    }, this.syncIntervalMs);
    this.timer.unref();

    void this.syncAllChannels('startup');
  }

  async onModuleDestroy() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    await this.redis.quit();
  }

  async syncChannelIfStale(
    chatId: string,
    options?: {
      staleMs?: number;
      reason?: string;
    },
  ) {
    const staleMs = options?.staleMs ?? CHANNEL_STATS_STALE_MS;
    const [latestAudienceSnapshot, syncState] = await Promise.all([
      this.prisma.channelAudienceSnapshot.findFirst({
        where: { chatId },
        orderBy: { capturedAt: 'desc' },
        select: { capturedAt: true },
      }),
      this.prisma.channelStatsSyncState.findUnique({
        where: { chatId },
        select: {
          lastViewsSyncAt: true,
          lastAudienceSyncAt: true,
        },
      }),
    ]);

    const nowMs = Date.now();
    const audienceStale =
      !latestAudienceSnapshot ||
      nowMs - latestAudienceSnapshot.capturedAt.getTime() > staleMs ||
      !syncState?.lastAudienceSyncAt ||
      nowMs - syncState.lastAudienceSyncAt.getTime() > staleMs;
    const viewsStale =
      !syncState?.lastViewsSyncAt || nowMs - syncState.lastViewsSyncAt.getTime() > staleMs;

    if (!audienceStale && !viewsStale) {
      return;
    }

    await this.syncChannel(chatId, {
      reason: options?.reason ?? 'opportunistic',
      markOpportunistic: true,
    });
  }

  async syncAllChannels(reason: 'startup' | 'scheduled') {
    if (!this.backgroundEnabled || this.scheduledSyncInFlight) {
      return;
    }

    this.scheduledSyncInFlight = true;
    try {
      await this.withRedisLock(
        'channel-stats:sync-all',
        CHANNEL_STATS_ALL_LOCK_TTL_MS,
        async () => {
          await this.ensureWebhookCoverage();
          const channels = await this.prisma.chat.findMany({
            where: { entityType: ChatEntityType.CHANNEL },
            select: { id: true },
            orderBy: { updatedAt: 'desc' },
          });

          for (const channel of channels) {
            await this.syncChannel(channel.id, { reason });
          }
        },
      );
    } catch (error: unknown) {
      this.logger.warn(
        {
          reason,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to sync channel stats in background',
      );
    } finally {
      this.scheduledSyncInFlight = false;
    }
  }

  async syncChannel(
    chatId: string,
    options?: {
      reason?: string;
      markOpportunistic?: boolean;
    },
  ) {
    await this.withRedisLock(
      `channel-stats:chat:${chatId}`,
      CHANNEL_STATS_CHAT_LOCK_TTL_MS,
      async () => {
        const now = new Date();
        const lookbackFrom = new Date(now.getTime() - CHANNEL_STATS_LOOKBACK_MS);
        const state = await this.prisma.channelStatsSyncState.findUnique({
          where: { chatId },
        });
        const ensuredCoverageFrom = await this.ensureWebhookCoverage();

        let audienceSynced = false;
        try {
          const snapshot = await this.maxClient.getChatSnapshot(chatId);
          await this.prisma.$transaction([
            this.prisma.chat.update({
              where: { id: chatId },
              data: {
                title: snapshot.title?.trim() || `Канал ${chatId}`,
                entityType: ChatEntityType.CHANNEL,
              },
            }),
            this.prisma.channelAudienceSnapshot.create({
              data: {
                chatId,
                participantsCount: snapshot.participantsCount,
                status: snapshot.status,
                isPublic: snapshot.isPublic,
                link: snapshot.link,
                lastEventAt: snapshot.lastEventAt ? new Date(snapshot.lastEventAt) : null,
                capturedAt: now,
              },
            }),
          ]);
          audienceSynced = true;
        } catch (error: unknown) {
          this.logger.warn(
            {
              chatId,
              reason: options?.reason ?? 'manual',
              err: error instanceof Error ? error.message : String(error),
            },
            'Failed to sync official channel audience snapshot',
          );
        }

        let viewsSynced = false;
        try {
          const messages = await this.maxClient.listMessageSnapshots(chatId, {
            from: lookbackFrom,
            to: now,
            count: 100,
            maxPages: 80,
          });
          await this.upsertOfficialMessages(chatId, messages, now);
          viewsSynced = true;
        } catch (error: unknown) {
          this.logger.warn(
            {
              chatId,
              reason: options?.reason ?? 'manual',
              err: error instanceof Error ? error.message : String(error),
            },
            'Failed to sync official channel posts and views',
          );
        }

        const nextStateCreate = {
          chatId,
          viewsCoverageFrom: state?.viewsCoverageFrom ?? lookbackFrom,
          membershipCoverageFrom: state?.membershipCoverageFrom ?? ensuredCoverageFrom,
          lastAudienceSyncAt: audienceSynced ? now : (state?.lastAudienceSyncAt ?? null),
          lastViewsSyncAt: viewsSynced ? now : (state?.lastViewsSyncAt ?? null),
          lastOpportunisticSyncAt: options?.markOpportunistic
            ? now
            : (state?.lastOpportunisticSyncAt ?? null),
        };

        await this.prisma.channelStatsSyncState.upsert({
          where: { chatId },
          create: nextStateCreate,
          update: {
            viewsCoverageFrom: state?.viewsCoverageFrom ?? lookbackFrom,
            membershipCoverageFrom: state?.membershipCoverageFrom ?? ensuredCoverageFrom,
            ...(audienceSynced ? { lastAudienceSyncAt: now } : {}),
            ...(viewsSynced ? { lastViewsSyncAt: now } : {}),
            ...(options?.markOpportunistic ? { lastOpportunisticSyncAt: now } : {}),
          },
        });
      },
    );
  }

  private async upsertOfficialMessages(
    chatId: string,
    messages: MaxChannelMessageSnapshot[],
    capturedAt: Date,
  ) {
    for (const message of messages) {
      const views = Math.max(message.views ?? 0, 0);
      const reactions = message.reactions
        .filter((item) => item.count > 0)
        .map((item) => ({
          emoji: item.emoji,
          count: item.count,
        }));
      const reactionsTotal = reactions.reduce((total, item) => total + item.count, 0);
      const post = await this.prisma.channelPost.upsert({
        where: {
          chatId_messageId: {
            chatId,
            messageId: message.messageId,
          },
        },
        create: {
          chatId,
          messageId: message.messageId,
          publishedAt: new Date(message.publishedAt),
          url: message.url,
          latestViews: views,
          latestReactions:
            reactions.length > 0 ? (reactions as Prisma.InputJsonValue) : Prisma.DbNull,
          latestReactionsTotal: reactionsTotal,
          latestSnapshotAt: capturedAt,
        },
        update: {
          publishedAt: new Date(message.publishedAt),
          url: message.url,
          latestViews: views,
          latestReactions:
            reactions.length > 0 ? (reactions as Prisma.InputJsonValue) : Prisma.DbNull,
          latestReactionsTotal: reactionsTotal,
          latestSnapshotAt: capturedAt,
        },
        select: {
          id: true,
        },
      });

      await this.prisma.channelPostViewSnapshot.create({
        data: {
          channelPostId: post.id,
          views,
          capturedAt,
        },
      });
    }
  }

  private async ensureWebhookCoverage(): Promise<Date | null> {
    if (!this.backgroundEnabled) {
      return null;
    }

    if (this.subscriptionCoverageFrom) {
      return this.subscriptionCoverageFrom;
    }

    let ensuredAt: Date | null = null;
    await this.withRedisLock(
      'channel-stats:webhook-subscriptions',
      CHANNEL_STATS_SUBSCRIPTIONS_LOCK_TTL_MS,
      async () => {
        await this.maxClient.ensureWebhookSubscription([...CHANNEL_STATS_REQUIRED_UPDATE_TYPES]);
        ensuredAt = new Date();
      },
    );

    if (ensuredAt) {
      this.subscriptionCoverageFrom = ensuredAt;
      return ensuredAt;
    }

    return this.subscriptionCoverageFrom;
  }

  private async withRedisLock(
    key: string,
    ttlMs: number,
    task: () => Promise<void>,
  ): Promise<boolean> {
    const token = randomUUID();
    const acquired = await this.redis.set(key, token, 'PX', ttlMs, 'NX');
    if (acquired !== 'OK') {
      return false;
    }

    try {
      await task();
      return true;
    } finally {
      await this.redis.eval(
        'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end',
        1,
        key,
        token,
      );
    }
  }
}
