import {
  addVkParsingSourceRequestSchema,
  type VkParsingFeed,
  type VkParsingRefreshResult,
} from '@maxim/contracts';
import { InjectQueue } from '@nestjs/bullmq';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Queue } from 'bullmq';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import { Prisma } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { VkApiClientService } from './vk-api-client.service';
import { VkParsingFeedService } from './vk-parsing-feed.service';
import {
  VK_PARSING_SYNC_QUEUE,
  type VkParsingSyncJob,
  type VkParsingSyncReason,
} from './vk-parsing.queue';

type VkParsingSourceRow = Prisma.VkParsingSourceGetPayload<Record<string, never>>;

type VkWallGetResponse = {
  count?: number;
  items?: unknown[];
  groups?: unknown[];
};

type NormalizedVkSourceInput = {
  domain: string;
  url: string;
};

type NormalizedVkSourceInfo = {
  ownerId: number;
  wallOwnerId: number;
  screenName: string;
  title: string;
  url: string;
};

const VK_SOURCE_STATUS_ACTIVE = 'ACTIVE';
const VK_SOURCE_STATUS_DISABLED = 'DISABLED';
const VK_SOURCE_SYNC_STATUS_IDLE = 'IDLE';
const VK_SOURCE_SYNC_STATUS_QUEUED = 'QUEUED';
const VK_SOURCE_SYNC_STATUS_SYNCING = 'SYNCING';
const VK_SOURCE_SYNC_STATUS_ERROR = 'ERROR';
const VK_SYNC_JOB_NAME = 'sync-vk-source';

@Injectable()
export class VkSourceService {
  private readonly queueBatchSize: number;
  private readonly syncLeaseTtlMs: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly feedService: VkParsingFeedService,
    private readonly vkApiClient: VkApiClientService,
    @InjectQueue(VK_PARSING_SYNC_QUEUE)
    private readonly syncQueue: Queue<VkParsingSyncJob>,
    configService: ConfigService,
  ) {
    this.queueBatchSize = configService.get<number>('VK_PARSING_QUEUE_BATCH_SIZE') ?? 100;
    this.syncLeaseTtlMs = configService.get<number>('VK_PARSING_LEASE_TTL_MS') ?? 120_000;
  }

  async addSource(
    chatId: string,
    user: Pick<AuthUser, 'userId'>,
    body: unknown,
  ): Promise<VkParsingRefreshResult> {
    const parsed = addVkParsingSourceRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }

    const normalized = this.normalizeSourceInput(parsed.data.url);
    const wall = await this.fetchWall({ domain: normalized.domain, count: 1 });
    const sourceInfo = this.resolveSourceInfo(normalized, wall);
    const source = await this.prisma.vkParsingSource.upsert({
      where: {
        chatId_wallOwnerId: {
          chatId,
          wallOwnerId: sourceInfo.wallOwnerId,
        },
      },
      create: {
        chatId,
        ownerId: sourceInfo.ownerId,
        wallOwnerId: sourceInfo.wallOwnerId,
        screenName: sourceInfo.screenName,
        title: sourceInfo.title,
        url: sourceInfo.url,
        status: VK_SOURCE_STATUS_ACTIVE,
        syncStatus: VK_SOURCE_SYNC_STATUS_QUEUED,
        nextSyncAt: new Date(),
        createdByUserId: user.userId,
      },
      update: {
        ownerId: sourceInfo.ownerId,
        screenName: sourceInfo.screenName,
        title: sourceInfo.title,
        url: sourceInfo.url,
        status: VK_SOURCE_STATUS_ACTIVE,
        syncStatus: VK_SOURCE_SYNC_STATUS_QUEUED,
        nextSyncAt: new Date(),
        lastError: null,
        lastErrorCode: null,
      },
    });

    const queued = await this.enqueueSourceSync(source.id, 'source-added');
    const feed = await this.feedService.buildFeed(chatId, { enabled: true, canUse: true });
    return { ...feed, imported: 0, queued };
  }

  async removeSource(chatId: string, sourceId: string): Promise<VkParsingFeed> {
    const source = await this.prisma.vkParsingSource.findFirst({
      where: { id: sourceId, chatId },
    });
    if (!source) {
      throw new NotFoundException('VK-источник не найден.');
    }

    await this.prisma.vkParsingSource.update({
      where: { id: source.id },
      data: {
        status: VK_SOURCE_STATUS_DISABLED,
        syncStatus: VK_SOURCE_SYNC_STATUS_IDLE,
        nextSyncAt: null,
        syncLockedAt: null,
        syncLockedBy: null,
      },
    });
    return this.feedService.buildFeed(chatId, { enabled: true, canUse: true });
  }

  async refresh(chatId: string): Promise<VkParsingRefreshResult> {
    const sources = await this.prisma.vkParsingSource.findMany({
      where: { chatId, status: VK_SOURCE_STATUS_ACTIVE },
      orderBy: [{ createdAt: 'asc' }],
    });

    const queued = await this.enqueueSources(sources, 'manual');

    const feed = await this.feedService.buildFeed(chatId, { enabled: true, canUse: true });
    return { ...feed, imported: 0, queued };
  }

  async syncDueSources(reason: VkParsingSyncReason = 'scheduled'): Promise<number> {
    const now = new Date();
    const staleLockBefore = new Date(now.getTime() - this.syncLeaseTtlMs);
    const sources = await this.prisma.vkParsingSource.findMany({
      where: {
        status: VK_SOURCE_STATUS_ACTIVE,
        syncStatus: { not: VK_SOURCE_SYNC_STATUS_ERROR },
        OR: [
          { nextSyncAt: null },
          { nextSyncAt: { lte: now } },
          {
            syncStatus: VK_SOURCE_SYNC_STATUS_SYNCING,
            syncLockedAt: { lt: staleLockBefore },
          },
        ],
      },
      orderBy: [{ nextSyncAt: 'asc' }, { lastSyncAt: 'asc' }, { createdAt: 'asc' }],
      take: this.queueBatchSize,
    });

    return this.enqueueSources(sources, reason);
  }

  private async enqueueSources(
    sources: VkParsingSourceRow[],
    reason: VkParsingSyncReason,
  ): Promise<number> {
    let queued = 0;
    for (const source of sources) {
      queued += await this.enqueueSourceSync(source.id, reason);
    }

    return queued;
  }

  private async enqueueSourceSync(sourceId: string, reason: VkParsingSyncReason): Promise<number> {
    await this.prisma.vkParsingSource.update({
      where: { id: sourceId },
      data: {
        syncStatus: VK_SOURCE_SYNC_STATUS_QUEUED,
        nextSyncAt: new Date(),
      },
    });

    await this.syncQueue.add(
      VK_SYNC_JOB_NAME,
      {
        sourceId,
        reason,
        retryPolicyName: 'vk-parsing-sync',
        createdAt: new Date().toISOString(),
      },
      {
        jobId: this.buildSyncJobId(sourceId),
        attempts: 1,
        removeOnComplete: true,
        removeOnFail: 500,
      },
    );

    return 1;
  }

  private buildSyncJobId(sourceId: string): string {
    return `vk-parsing-sync__${sourceId}`;
  }

  private normalizeSourceInput(input: string): NormalizedVkSourceInput {
    const trimmed = input.trim();
    if (!trimmed) {
      throw new BadRequestException('Укажите ссылку на VK-сообщество.');
    }

    let sourcePath = trimmed;
    if (/^https?:\/\//iu.test(trimmed) || /^(?:www\.|m\.)?(?:vk\.com|vk\.ru)\//iu.test(trimmed)) {
      const url = new URL(/^https?:\/\//iu.test(trimmed) ? trimmed : `https://${trimmed}`);
      const host = url.hostname
        .replace(/^www\./iu, '')
        .replace(/^m\./iu, '')
        .toLowerCase();
      if (host !== 'vk.com' && host !== 'vk.ru') {
        throw new BadRequestException('Поддерживаются только ссылки vk.ru и vk.com.');
      }

      const segment = url.pathname
        .split('/')
        .map((part) => part.trim())
        .filter(Boolean)[0];
      if (!segment) {
        throw new BadRequestException('Укажите ссылку на VK-сообщество.');
      }
      sourcePath = segment;
    }

    const domain = sourcePath.replace(/^@/u, '').trim();
    if (/^(?:wall|photo|video|album|topic)-?\d+/iu.test(domain)) {
      throw new BadRequestException('Нужна ссылка на сообщество, не на отдельный материал.');
    }
    if (!/^[A-Za-z0-9_.-]{2,80}$/u.test(domain)) {
      throw new BadRequestException('Некорректная ссылка на VK-сообщество.');
    }

    return {
      domain,
      url: `https://vk.ru/${domain}`,
    };
  }

  private resolveSourceInfo(
    input: NormalizedVkSourceInput,
    wall: VkWallGetResponse,
  ): NormalizedVkSourceInfo {
    const group = (wall.groups ?? [])
      .map((item) => this.asRecord(item))
      .find((item): item is Record<string, unknown> => item !== null);
    const firstPost = (wall.items ?? [])
      .map((item) => this.asRecord(item))
      .find((item): item is Record<string, unknown> => item !== null);
    const groupId = this.readNumber(group?.id) ?? this.resolveGroupIdFromPost(firstPost ?? null);
    if (!groupId) {
      throw new BadRequestException('VK-сообщество не найдено или недоступно.');
    }

    const screenName = this.readString(group?.screen_name) || input.domain;
    const title = this.readString(group?.name) || screenName;
    return {
      ownerId: groupId,
      wallOwnerId: -Math.abs(groupId),
      screenName,
      title,
      url: `https://vk.ru/${screenName}`,
    };
  }

  private resolveGroupIdFromPost(post: Record<string, unknown> | null): number | null {
    const ownerId = this.readNumber(post?.owner_id);
    if (typeof ownerId !== 'number' || ownerId >= 0) {
      return null;
    }

    return Math.abs(ownerId);
  }

  private async fetchWall(options: {
    domain?: string;
    ownerId?: number;
    count: number;
    offset?: number;
  }): Promise<VkWallGetResponse> {
    const params: Record<string, string> = {
      count: String(Math.max(1, Math.min(options.count, 100))),
      filter: 'owner',
      extended: '1',
    };
    if (options.domain) {
      params.domain = options.domain;
    }
    if (typeof options.ownerId === 'number') {
      params.owner_id = String(options.ownerId);
    }
    if (typeof options.offset === 'number' && options.offset > 0) {
      params.offset = String(Math.max(0, Math.trunc(options.offset)));
    }

    const response = await this.vkApiClient.request('wall.get', params);
    if (!this.asRecord(response)) {
      throw new BadRequestException('VK вернул пустой ответ.');
    }

    return response as VkWallGetResponse;
  }

  private asRecord(value: unknown): Record<string, unknown> | null {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  }

  private readString(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
  }

  private readNumber(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === 'string' && value.trim()) {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
  }
}
