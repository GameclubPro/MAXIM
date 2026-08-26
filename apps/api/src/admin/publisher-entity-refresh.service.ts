import {
  publisherEntityRefreshResponseSchema,
  type ManagedEntityType,
  type PublisherEntityRefreshResponse,
} from '@maxim/contracts/publisher';
import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import { MaxBotRegistryService } from '../max/max-bot-registry.service';
import { PublisherBindingRefreshQueueService } from '../publisher/publisher-binding-refresh.queue';
import { PublisherPolicyService } from './publisher-policy.service';

const PUBLISHER_MANUAL_REFRESH_USER_WINDOW_MS = 60_000;
const PUBLISHER_MANUAL_REFRESH_USER_MAX_REQUESTS = 10;
const PUBLISHER_MANUAL_REFRESH_USER_MAX_TRACKED = 10_000;

@Injectable()
export class PublisherEntityRefreshService {
  private readonly recentRequestsByUser = new Map<string, number[]>();

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

  private admitManualRefresh(userId: string, nowMs = Date.now()): void {
    const windowStart = nowMs - PUBLISHER_MANUAL_REFRESH_USER_WINDOW_MS;
    for (const [trackedUserId, requests] of this.recentRequestsByUser) {
      if ((requests.at(-1) ?? 0) <= windowStart) {
        this.recentRequestsByUser.delete(trackedUserId);
      }
    }
    const recent = (this.recentRequestsByUser.get(userId) ?? []).filter(
      (requestedAt) => requestedAt > windowStart,
    );
    if (recent.length >= PUBLISHER_MANUAL_REFRESH_USER_MAX_REQUESTS) {
      throw new HttpException(
        'Слишком много проверок доступа. Повторите через минуту.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    if (
      !this.recentRequestsByUser.has(userId) &&
      this.recentRequestsByUser.size >= PUBLISHER_MANUAL_REFRESH_USER_MAX_TRACKED
    ) {
      const oldestUserId = this.recentRequestsByUser.keys().next().value as string | undefined;
      if (oldestUserId) {
        this.recentRequestsByUser.delete(oldestUserId);
      }
    }
    recent.push(nowMs);
    this.recentRequestsByUser.delete(userId);
    this.recentRequestsByUser.set(userId, recent);
  }
}
