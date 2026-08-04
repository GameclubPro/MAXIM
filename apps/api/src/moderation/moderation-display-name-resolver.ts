import type { Logger } from '@nestjs/common';
import { normalizeMaxUserDisplayName } from '../common/max-user-display-name.util';
import { raceWithTimeout } from '../common/promise-timeout.util';
import { MAX_API_SOURCE_TAGS, type MaxClientService } from '../max/max-client.service';
import type { PrismaService } from '../prisma/prisma.service';
import { buildLocalAdminContactDisplayNameQuery } from './local-admin-contact-display-name.query';
import {
  ADMIN_CONTACT_DISPLAY_NAME_CACHE_TTL_MS,
  ADMIN_CONTACT_DISPLAY_NAME_LOOKUP_TIMEOUT_MS,
} from './moderation.service.support';

export class ModerationDisplayNameResolver {
  private readonly cache = new Map<string, { value: string | null; expiresAtMs: number }>();
  private readonly inFlight = new Map<string, Promise<string | null>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly maxClient: MaxClientService,
    private readonly logger: Pick<Logger, 'debug'>,
  ) {}

  async resolve(chatId: string, userId: string): Promise<string | null> {
    const cacheKey = `${chatId}:${userId}`;
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAtMs > Date.now()) {
      return cached.value;
    }

    const activeLookup = this.inFlight.get(cacheKey);
    if (activeLookup) {
      return activeLookup;
    }

    const lookup = (async () => {
      const local = normalizeMaxUserDisplayName(await this.resolveLocal(chatId, userId), userId);
      const resolved =
        local ?? normalizeMaxUserDisplayName(await this.resolveRemote(chatId, userId), userId);
      this.cache.set(cacheKey, {
        value: resolved,
        expiresAtMs: Date.now() + ADMIN_CONTACT_DISPLAY_NAME_CACHE_TTL_MS,
      });
      return resolved;
    })().finally(() => {
      this.inFlight.delete(cacheKey);
    });
    this.inFlight.set(cacheKey, lookup);
    return lookup;
  }

  private async resolveLocal(chatId: string, userId: string): Promise<string | null> {
    if (typeof this.prisma.$queryRaw !== 'function') {
      return null;
    }

    try {
      const rows = await this.prisma.$queryRaw<Array<{ sender_name: string | null }>>(
        buildLocalAdminContactDisplayNameQuery(chatId, userId),
      );
      const senderName = Array.isArray(rows) ? rows[0]?.sender_name?.trim() : '';
      return senderName || null;
    } catch (error: unknown) {
      this.logger.debug(
        {
          chatId,
          userId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to resolve local moderation display name',
      );
      return null;
    }
  }

  private async resolveRemote(chatId: string, userId: string): Promise<string | null> {
    const loadProfiles = this.maxClient.getChatMemberProfiles?.bind(this.maxClient);
    if (!loadProfiles) {
      return null;
    }

    try {
      const profiles = await raceWithTimeout({
        operation: loadProfiles(chatId, [userId], {
          trafficClass: 'interactive',
          actionHealthLane: 'background',
          sourceTag: MAX_API_SOURCE_TAGS.MODERATION_NOTICE,
          timeoutMs: ADMIN_CONTACT_DISPLAY_NAME_LOOKUP_TIMEOUT_MS,
          ignoreFailureMetricStatuses: [403, 404],
        }),
        timeoutMs: ADMIN_CONTACT_DISPLAY_NAME_LOOKUP_TIMEOUT_MS,
        onTimeout: () => new Map(),
      });
      const displayName = profiles.get(userId)?.displayName?.trim() ?? '';
      return displayName || null;
    } catch (error: unknown) {
      this.logger.debug(
        {
          chatId,
          userId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to resolve remote moderation display name',
      );
      return null;
    }
  }
}
