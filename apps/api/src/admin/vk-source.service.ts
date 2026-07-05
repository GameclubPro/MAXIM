import {
  addVkParsingSourceRequestSchema,
  bulkUpdateVkParsingSourcesRequestSchema,
  updateVkParsingSourceRequestSchema,
  type VkParsingFeed,
  type VkParsingCapability,
  type VkParsingRefreshResult,
} from '@maxim/contracts';
import { InjectQueue } from '@nestjs/bullmq';
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Queue } from 'bullmq';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import { Prisma } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { VkApiClientService } from './vk-api-client.service';
import { VkParsingFeedService } from './vk-parsing-feed.service';
import {
  VK_PARSING_SYNC_QUEUE,
  VK_PARSING_SYNC_RETRY_POLICY,
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
const VK_SOURCE_PUBLISH_MODE_QUEUE = 'QUEUE';
const VK_SOURCE_PRIORITY_NORMAL = 'NORMAL';
const VK_SYNC_JOB_NAME = 'sync-vk-source';
const VK_PARSING_AVAILABLE_CAPABILITY: VkParsingCapability = {
  enabled: true,
  canUse: true,
  reasonCode: null,
  reason: null,
};

@Injectable()
export class VkSourceService {
  private readonly logger = new Logger(VkSourceService.name);
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
        importEnabled: true,
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
        importEnabled: true,
        syncStatus: VK_SOURCE_SYNC_STATUS_QUEUED,
        nextSyncAt: new Date(),
        syncLockedAt: null,
        syncLockedBy: null,
        syncLockDeadlineAt: null,
        syncHeartbeatAt: null,
        terminalFailureCount: 0,
        circuitOpenedAt: null,
        circuitReasonCode: null,
        circuitReason: null,
        circuitRetryAt: null,
        lastError: null,
        lastErrorCode: null,
      },
    });

    const queued = await this.enqueueSourceSync(source.id, 'source-added');
    const feed = await this.feedService.buildFeed(chatId, VK_PARSING_AVAILABLE_CAPABILITY);
    return { ...feed, imported: 0, queued };
  }

  async updateSource(
    chatId: string,
    sourceId: string,
    user: Pick<AuthUser, 'userId'>,
    body: unknown,
  ): Promise<VkParsingFeed> {
    const parsed = updateVkParsingSourceRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }

    const source = await this.prisma.vkParsingSource.findFirst({
      where: { id: sourceId, chatId, status: VK_SOURCE_STATUS_ACTIVE },
    });
    if (!source) {
      throw new NotFoundException('VK-источник не найден.');
    }

    const now = new Date();
    const autoPublishEnabledAt =
      typeof parsed.data.autoPublishEnabled === 'boolean'
        ? parsed.data.autoPublishEnabled
          ? source.autoPublishEnabled
            ? (source.autoPublishEnabledAt ?? now)
            : now
          : null
        : undefined;
    const importEnabled = parsed.data.importEnabled ?? source.importEnabled;
    const shouldQueueSync = parsed.data.importEnabled === true && !source.importEnabled;
    await this.prisma.vkParsingSource.update({
      where: { id: source.id },
      data: {
        ...parsed.data,
        status: VK_SOURCE_STATUS_ACTIVE,
        importEnabled,
        ...(autoPublishEnabledAt !== undefined ? { autoPublishEnabledAt } : {}),
        ...(parsed.data.autoPublishEnabled === true
          ? { autoPublishPausedAt: null, autoPublishPausedReason: null }
          : {}),
        ...(parsed.data.autoPublishEnabled === false
          ? { autoPublishPausedAt: now, autoPublishPausedReason: 'manual' }
          : {}),
        ...(importEnabled
          ? shouldQueueSync
            ? {
                syncStatus: VK_SOURCE_SYNC_STATUS_QUEUED,
                nextSyncAt: now,
                syncLockedAt: null,
                syncLockedBy: null,
                syncLockDeadlineAt: null,
                syncHeartbeatAt: null,
              }
            : {}
          : {
              syncStatus: VK_SOURCE_SYNC_STATUS_IDLE,
              nextSyncAt: null,
              syncLockedAt: null,
              syncLockedBy: null,
              syncLockDeadlineAt: null,
              syncHeartbeatAt: null,
            }),
      },
    });

    if (shouldQueueSync) {
      await this.enqueueSourceSync(source.id, 'manual');
    }
    await this.writeAuditLog(chatId, user.userId, 'VK_PARSING_UPDATE_SOURCE', {
      sourceId: source.id,
      before: this.pickAuditedSourceSettings(source),
      after: parsed.data,
    });

    return this.feedService.buildFeed(chatId, VK_PARSING_AVAILABLE_CAPABILITY);
  }

  async applyBulkPreset(
    chatId: string,
    user: Pick<AuthUser, 'userId'>,
    body: unknown,
  ): Promise<VkParsingFeed> {
    const parsed = bulkUpdateVkParsingSourcesRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }

    const sourceIds = [...new Set(parsed.data.sourceIds)];
    const preset = this.resolvePresetSettings(parsed.data.preset);
    const now = new Date();
    await this.prisma.vkParsingSource.updateMany({
      where: {
        chatId,
        id: { in: sourceIds },
        status: VK_SOURCE_STATUS_ACTIVE,
      },
      data: {
        ...preset,
        ...(preset.importEnabled
          ? {
              status: VK_SOURCE_STATUS_ACTIVE,
              syncStatus: VK_SOURCE_SYNC_STATUS_QUEUED,
              nextSyncAt: now,
              syncLockedAt: null,
              syncLockedBy: null,
              syncLockDeadlineAt: null,
              syncHeartbeatAt: null,
            }
          : {
              syncStatus: VK_SOURCE_SYNC_STATUS_IDLE,
              nextSyncAt: null,
              syncLockedAt: null,
              syncLockedBy: null,
              syncLockDeadlineAt: null,
              syncHeartbeatAt: null,
            }),
        ...(preset.autoPublishEnabled
          ? {
              autoPublishEnabledAt: now,
              autoPublishPausedAt: null,
              autoPublishPausedReason: null,
            }
          : {
              autoPublishEnabledAt: null,
              autoPublishPausedAt: now,
              autoPublishPausedReason: 'preset',
            }),
      },
    });
    if (preset.importEnabled) {
      const sources = await this.prisma.vkParsingSource.findMany({
        where: { chatId, id: { in: sourceIds }, status: VK_SOURCE_STATUS_ACTIVE },
      });
      await this.enqueueSources(sources, 'manual');
    }

    await this.writeAuditLog(chatId, user.userId, 'VK_PARSING_APPLY_PRESET', {
      preset: parsed.data.preset,
      sourceIds,
      settings: preset,
    });
    return this.feedService.buildFeed(chatId, VK_PARSING_AVAILABLE_CAPABILITY);
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
        importEnabled: false,
        autoPublishEnabled: false,
        autoPublishEnabledAt: null,
        autoPublishPausedAt: new Date(),
        autoPublishPausedReason: 'removed',
        syncStatus: VK_SOURCE_SYNC_STATUS_IDLE,
        nextSyncAt: null,
        syncLockedAt: null,
        syncLockedBy: null,
        syncLockDeadlineAt: null,
        syncHeartbeatAt: null,
        circuitRetryAt: null,
      },
    });
    return this.feedService.buildFeed(chatId, VK_PARSING_AVAILABLE_CAPABILITY);
  }

  async refresh(chatId: string): Promise<VkParsingRefreshResult> {
    const sources = await this.prisma.vkParsingSource.findMany({
      where: { chatId, status: VK_SOURCE_STATUS_ACTIVE, importEnabled: true },
      orderBy: [{ createdAt: 'asc' }],
    });

    const queued = await this.enqueueSources(sources, 'manual');

    const feed = await this.feedService.buildFeed(chatId, VK_PARSING_AVAILABLE_CAPABILITY);
    return { ...feed, imported: 0, queued };
  }

  async refreshSource(chatId: string, sourceId: string): Promise<VkParsingRefreshResult> {
    const source = await this.prisma.vkParsingSource.findFirst({
      where: { chatId, id: sourceId, status: VK_SOURCE_STATUS_ACTIVE },
    });
    if (!source) {
      throw new NotFoundException('VK-источник не найден.');
    }
    if (!source.importEnabled) {
      throw new BadRequestException('Источник поставлен на паузу.');
    }

    const queued = await this.enqueueSourceSync(source.id, 'manual');
    const feed = await this.feedService.buildFeed(chatId, VK_PARSING_AVAILABLE_CAPABILITY);
    return { ...feed, imported: 0, queued };
  }

  async syncDueSources(reason: VkParsingSyncReason = 'scheduled'): Promise<number> {
    const now = new Date();
    const staleLockBefore = new Date(now.getTime() - this.syncLeaseTtlMs);
    const sources = await this.prisma.vkParsingSource.findMany({
      where: {
        status: VK_SOURCE_STATUS_ACTIVE,
        importEnabled: true,
        syncStatus: { not: VK_SOURCE_SYNC_STATUS_ERROR },
        circuitOpenedAt: null,
        OR: [
          {
            syncStatus: { notIn: [VK_SOURCE_SYNC_STATUS_QUEUED, VK_SOURCE_SYNC_STATUS_SYNCING] },
            OR: [{ nextSyncAt: null }, { nextSyncAt: { lte: now } }],
          },
          {
            syncStatus: VK_SOURCE_SYNC_STATUS_QUEUED,
            updatedAt: { lt: staleLockBefore },
          },
          {
            syncStatus: VK_SOURCE_SYNC_STATUS_SYNCING,
            OR: [
              { syncLockDeadlineAt: { lt: now } },
              {
                syncLockDeadlineAt: null,
                syncLockedAt: { lt: staleLockBefore },
              },
            ],
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
    const now = new Date();
    const staleLockBefore = new Date(now.getTime() - this.syncLeaseTtlMs);
    const resetCircuitState = reason === 'manual' || reason === 'source-added';
    const updated = await this.prisma.vkParsingSource.updateMany({
      where: {
        id: sourceId,
        OR: [
          { syncStatus: { not: VK_SOURCE_SYNC_STATUS_SYNCING } },
          {
            syncStatus: VK_SOURCE_SYNC_STATUS_SYNCING,
            OR: [
              { syncLockDeadlineAt: { lt: now } },
              {
                syncLockDeadlineAt: null,
                syncLockedAt: { lt: staleLockBefore },
              },
            ],
          },
        ],
      },
      data: {
        syncStatus: VK_SOURCE_SYNC_STATUS_QUEUED,
        nextSyncAt: now,
        syncLockedAt: null,
        syncLockedBy: null,
        syncLockDeadlineAt: null,
        syncHeartbeatAt: null,
        ...(resetCircuitState
          ? {
              terminalFailureCount: 0,
              circuitOpenedAt: null,
              circuitReasonCode: null,
              circuitReason: null,
              circuitRetryAt: null,
            }
          : {}),
      },
    });
    if (updated.count === 0) {
      return 0;
    }

    const job = this.buildSyncJob(sourceId, reason, now);
    const jobId = this.buildSyncJobId(sourceId);
    const recovered = await this.recoverExistingSyncJob(jobId, job);
    if (recovered !== null) {
      return recovered ? 1 : 0;
    }

    await this.syncQueue.add(
      VK_SYNC_JOB_NAME,
      job,
      {
        jobId,
        ...VK_PARSING_SYNC_RETRY_POLICY,
      },
    );

    return 1;
  }

  private buildSyncJob(
    sourceId: string,
    reason: VkParsingSyncReason,
    createdAt: Date,
  ): VkParsingSyncJob {
    return {
      sourceId,
      reason,
      retryPolicyName: 'vk-parsing-sync',
      createdAt: createdAt.toISOString(),
    };
  }

  private async recoverExistingSyncJob(
    jobId: string,
    job: VkParsingSyncJob,
  ): Promise<boolean | null> {
    try {
      const existingJob = await this.syncQueue.getJob(jobId);
      if (!existingJob) {
        return null;
      }

      const state = await existingJob.getState();
      if (state === 'failed' || state === 'completed') {
        await existingJob.updateData(job);
        await existingJob.retry(state, {
          resetAttemptsMade: true,
          resetAttemptsStarted: true,
        });
      }

      return true;
    } catch (error: unknown) {
      this.logger.warn(
        {
          jobId,
          sourceId: job.sourceId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to recover VK parsing sync job',
      );
      return false;
    }
  }

  private buildSyncJobId(sourceId: string): string {
    return `vk-parsing-sync__${sourceId}`;
  }

  private resolvePresetSettings(preset: string) {
    if (preset === 'NEWS') {
      return {
        importEnabled: true,
        autoPublishEnabled: true,
        publishIntervalMinutes: 20,
        dailyLimit: 12,
        minPublishIntervalMinutes: 15,
        publishMode: 'QUEUE',
        priority: 'HIGH',
      };
    }
    if (preset === 'SLOW') {
      return {
        importEnabled: true,
        autoPublishEnabled: true,
        publishIntervalMinutes: 180,
        dailyLimit: 3,
        minPublishIntervalMinutes: 60,
        publishMode: 'QUEUE',
        priority: VK_SOURCE_PRIORITY_NORMAL,
      };
    }
    if (preset === 'REVIEW') {
      return {
        importEnabled: true,
        autoPublishEnabled: false,
        publishIntervalMinutes: 60,
        dailyLimit: 5,
        minPublishIntervalMinutes: 30,
        publishMode: 'REVIEW',
        priority: VK_SOURCE_PRIORITY_NORMAL,
      };
    }

    return {
      importEnabled: true,
      autoPublishEnabled: true,
      publishIntervalMinutes: 90,
      dailyLimit: 4,
      minPublishIntervalMinutes: 45,
      publishMode: VK_SOURCE_PUBLISH_MODE_QUEUE,
      priority: VK_SOURCE_PRIORITY_NORMAL,
    };
  }

  private pickAuditedSourceSettings(source: VkParsingSourceRow): Record<string, unknown> {
    return {
      importEnabled: source.importEnabled,
      autoPublishEnabled: source.autoPublishEnabled,
      publishIntervalMinutes: source.publishIntervalMinutes,
      dailyLimit: source.dailyLimit,
      minPublishIntervalMinutes: source.minPublishIntervalMinutes,
      publishMode: source.publishMode,
      priority: source.priority,
      quietHoursStart: source.quietHoursStart,
      quietHoursEnd: source.quietHoursEnd,
    };
  }

  private async writeAuditLog(
    chatId: string,
    actorUserId: string,
    action: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    if (!this.prisma.auditLog?.create) {
      return;
    }
    await this.prisma.auditLog.create({
      data: {
        chatId,
        actorUserId,
        action,
        payload: this.toJsonInput(payload),
      },
    });
  }

  private normalizeSourceInput(input: string): NormalizedVkSourceInput {
    const trimmed = input.trim();
    if (!trimmed) {
      throw new BadRequestException('Укажите ссылку на VK-сообщество.');
    }

    let sourcePath = trimmed;
    if (/^https?:\/\//iu.test(trimmed) || /^(?:www\.|m\.)?(?:vk\.com|vk\.ru)\//iu.test(trimmed)) {
      const url = this.parseVkSourceUrl(
        /^https?:\/\//iu.test(trimmed) ? trimmed : `https://${trimmed}`,
      );
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
    const groups = (wall.groups ?? [])
      .map((item) => this.asRecord(item))
      .filter((item): item is Record<string, unknown> => item !== null);
    const firstPost = (wall.items ?? [])
      .map((item) => this.asRecord(item))
      .find((item): item is Record<string, unknown> => item !== null);
    const groupIdFromPost = this.resolveGroupIdFromPost(firstPost ?? null);
    const group =
      typeof groupIdFromPost === 'number'
        ? (groups.find((item) => this.readNumber(item.id) === groupIdFromPost) ?? null)
        : (this.findGroupByInputDomain(groups, input.domain) ??
          (groups.length === 1 ? groups[0] : null));
    const groupId = groupIdFromPost ?? this.readNumber(group?.id);
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

  private findGroupByInputDomain(
    groups: Record<string, unknown>[],
    domain: string,
  ): Record<string, unknown> | null {
    const normalizedDomain = domain.toLowerCase();
    for (const group of groups) {
      const id = this.readNumber(group.id);
      const screenName = this.readString(group.screen_name).toLowerCase();
      if (screenName && screenName === normalizedDomain) {
        return group;
      }
      if (
        typeof id === 'number' &&
        (normalizedDomain === `club${id}` || normalizedDomain === `public${id}`)
      ) {
        return group;
      }
    }

    return null;
  }

  private parseVkSourceUrl(value: string): URL {
    try {
      return new URL(value);
    } catch {
      throw new BadRequestException('Некорректная ссылка на VK-сообщество.');
    }
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

  private toJsonInput(value: unknown): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(value ?? null)) as Prisma.InputJsonValue;
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
