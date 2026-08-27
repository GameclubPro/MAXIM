import {
  MAX_PUBLISHER_BULK_REFRESH_TARGETS,
  publisherEntitiesRefreshResponseSchema,
  publisherEntityRefreshResponseSchema,
  type ManagedEntityType,
  type PublisherEntitiesRefreshResponse,
  type PublisherEntityRefreshResponse,
} from '@maxim/contracts/publisher';
import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import { MaxBotRegistryService } from '../max/max-bot-registry.service';
import { PublisherBindingRefreshQueueService } from '../publisher/publisher-binding-refresh.queue';
import { PublisherPolicyService } from './publisher-policy.service';

const PUBLISHER_MANUAL_REFRESH_USER_WINDOW_MS = 60_000;
const PUBLISHER_MANUAL_REFRESH_USER_MAX_REQUESTS = 10;
const PUBLISHER_BULK_REFRESH_USER_MAX_REQUESTS = 3;
const PUBLISHER_MANUAL_REFRESH_USER_MAX_TRACKED = 10_000;
const PUBLISHER_BULK_ROTATION_TTL_MS = 5 * 60_000;
const PUBLISHER_BULK_ROTATION_MAX_USERS = 1_000;
const PUBLISHER_BULK_ROTATION_MAX_IDS_PER_USER = 500;

@Injectable()
export class PublisherEntityRefreshService {
  private readonly recentRequestsByUser = new Map<string, number[]>();
  private readonly recentBulkRequestsByUser = new Map<string, number[]>();
  private readonly recentBulkEntityIdsByUser = new Map<string, Map<string, number>>();
  private readonly bulkRunsByUser = new Map<string, Promise<PublisherEntitiesRefreshResponse>>();

  constructor(
    private readonly policyService: PublisherPolicyService,
    private readonly refreshQueue: PublisherBindingRefreshQueueService,
    private readonly botRegistry: MaxBotRegistryService,
  ) {}

  async requestRefresh(
    entityType: ManagedEntityType,
    entityId: string,
    user: AuthUser,
  ): Promise<PublisherEntityRefreshResponse> {
    const entity = await this.policyService.getEntity(entityType, entityId, user);
    this.admitManualRefresh(user.userId);

    await this.refreshQueue.enqueue({
      chatId: entity.id,
      publisherBotId: this.botRegistry.getPublisherBotDescriptor().id,
      reason: 'manual_recheck',
    });

    return publisherEntityRefreshResponseSchema.parse({ accepted: true });
  }

  async requestBulkRefresh(user: AuthUser): Promise<PublisherEntitiesRefreshResponse> {
    this.admitBulkRefresh(user.userId);
    const previous = this.bulkRunsByUser.get(user.userId) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(() => this.executeBulkRefresh(user));
    const tracked = run.finally(() => {
      if (this.bulkRunsByUser.get(user.userId) === tracked) {
        this.bulkRunsByUser.delete(user.userId);
      }
    });
    this.bulkRunsByUser.set(user.userId, tracked);
    return tracked;
  }

  private async executeBulkRefresh(user: AuthUser): Promise<PublisherEntitiesRefreshResponse> {
    const requestedAt = new Date();
    const excludedEntityIds = this.readBulkRotationExclusions(user.userId, requestedAt.getTime());
    const entityIds = [
      ...new Set(
        await this.policyService.listRefreshableEntityIds(
          user,
          MAX_PUBLISHER_BULK_REFRESH_TARGETS,
          excludedEntityIds,
        ),
      ),
    ].slice(0, MAX_PUBLISHER_BULK_REFRESH_TARGETS);
    const publisherBotId = this.botRegistry.getPublisherBotDescriptor().id;
    const queuedEntityIds: string[] = [];
    try {
      for (const chatId of entityIds) {
        await this.refreshQueue.enqueue({
          chatId,
          publisherBotId,
          reason: 'manual_recheck',
          requestedAt,
        });
        queuedEntityIds.push(chatId);
      }
    } finally {
      this.rememberBulkRotationSelection(user.userId, queuedEntityIds, requestedAt.getTime());
    }

    return publisherEntitiesRefreshResponseSchema.parse({
      accepted: true,
      queuedCount: queuedEntityIds.length,
    });
  }

  private readBulkRotationExclusions(userId: string, nowMs: number): string[] {
    const entries = this.recentBulkEntityIdsByUser.get(userId);
    if (!entries) {
      return [];
    }
    for (const [entityId, expiresAtMs] of entries) {
      if (expiresAtMs <= nowMs) {
        entries.delete(entityId);
      }
    }
    if (entries.size === 0) {
      this.recentBulkEntityIdsByUser.delete(userId);
      return [];
    }
    this.recentBulkEntityIdsByUser.delete(userId);
    this.recentBulkEntityIdsByUser.set(userId, entries);
    return [...entries.keys()];
  }

  private rememberBulkRotationSelection(
    userId: string,
    entityIds: readonly string[],
    nowMs: number,
  ): void {
    if (entityIds.length === 0) {
      return;
    }
    let entries = this.recentBulkEntityIdsByUser.get(userId);
    if (!entries) {
      if (this.recentBulkEntityIdsByUser.size >= PUBLISHER_BULK_ROTATION_MAX_USERS) {
        const oldestUserId = this.recentBulkEntityIdsByUser.keys().next().value as
          | string
          | undefined;
        if (oldestUserId) {
          this.recentBulkEntityIdsByUser.delete(oldestUserId);
        }
      }
      entries = new Map<string, number>();
      this.recentBulkEntityIdsByUser.set(userId, entries);
    }
    const expiresAtMs = nowMs + PUBLISHER_BULK_ROTATION_TTL_MS;
    for (const entityId of entityIds) {
      entries.delete(entityId);
      entries.set(entityId, expiresAtMs);
    }
    while (entries.size > PUBLISHER_BULK_ROTATION_MAX_IDS_PER_USER) {
      const oldestEntityId = entries.keys().next().value as string | undefined;
      if (!oldestEntityId) {
        break;
      }
      entries.delete(oldestEntityId);
    }
  }

  private admitManualRefresh(userId: string, nowMs = Date.now()): void {
    this.admitRequest(
      this.recentRequestsByUser,
      userId,
      PUBLISHER_MANUAL_REFRESH_USER_MAX_REQUESTS,
      'Слишком много проверок доступа. Повторите через минуту.',
      nowMs,
    );
  }

  private admitBulkRefresh(userId: string, nowMs = Date.now()): void {
    this.admitRequest(
      this.recentBulkRequestsByUser,
      userId,
      PUBLISHER_BULK_REFRESH_USER_MAX_REQUESTS,
      'Слишком много массовых проверок доступа. Повторите через минуту.',
      nowMs,
    );
  }

  private admitRequest(
    recentRequestsByUser: Map<string, number[]>,
    userId: string,
    maxRequests: number,
    message: string,
    nowMs: number,
  ): void {
    const windowStart = nowMs - PUBLISHER_MANUAL_REFRESH_USER_WINDOW_MS;
    for (const [trackedUserId, requests] of recentRequestsByUser) {
      if ((requests.at(-1) ?? 0) <= windowStart) {
        recentRequestsByUser.delete(trackedUserId);
      }
    }
    const recent = (recentRequestsByUser.get(userId) ?? []).filter(
      (requestedAt) => requestedAt > windowStart,
    );
    if (recent.length >= maxRequests) {
      throw new HttpException(message, HttpStatus.TOO_MANY_REQUESTS);
    }
    if (
      !recentRequestsByUser.has(userId) &&
      recentRequestsByUser.size >= PUBLISHER_MANUAL_REFRESH_USER_MAX_TRACKED
    ) {
      const oldestUserId = recentRequestsByUser.keys().next().value as string | undefined;
      if (oldestUserId) {
        recentRequestsByUser.delete(oldestUserId);
      }
    }
    recent.push(nowMs);
    recentRequestsByUser.delete(userId);
    recentRequestsByUser.set(userId, recent);
  }
}
