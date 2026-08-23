import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import {
  KARAVAN_STOREFRONT_ALLOWLIST_PAGE_LIMIT_DEFAULT,
  KARAVAN_STOREFRONT_ALLOWLIST_PAGE_LIMIT_MAX,
  type KaravanStorefrontDuration,
} from '@maxim/contracts/karavan-storefront';
import { Prisma } from '../../prisma/prisma-client';
import type { AuthUser } from '../../common/decorators/current-user.decorator';
import { PrismaService } from '../../prisma/prisma.service';
import { ManagedEntitiesService } from '../../admin/managed-entities.service';
import { RedisCounterService } from '../../moderation/redis-counter.service';

type AllowlistEntryRow =
  Prisma.KaravanStorefrontAllowlistEntryGetPayload<Prisma.KaravanStorefrontAllowlistEntryDefaultArgs>;

type AllowlistWhere = {
  chatId?: string;
  userId?: string;
  id?: string;
  OR?: Array<{ expiresAt: null } | { expiresAt: { gt: Date } }>;
};

export type KaravanStorefrontAllowlistEntry = AllowlistEntryRow;

export type KaravanStorefrontAllowlistList = {
  items: Array<{
    id: string;
    chatId: string;
    userId: string;
    displayName: string | null;
    expiresAt: string | null;
    createdByUserId: string;
    sourceMessageId: string | null;
    createdAt: string;
    updatedAt: string;
  }>;
  hasMore: boolean;
  nextCursor: string | null;
};

export type KaravanStorefrontAllowlistUpsertInput = {
  chatId: string;
  userId: string;
  displayName?: string | null;
  expiresAt: Date | null;
  createdByUserId: string;
  sourceMessageId?: string | null;
};

const MAX_PAGE_SIZE = KARAVAN_STOREFRONT_ALLOWLIST_PAGE_LIMIT_MAX;
const DEFAULT_PAGE_SIZE = KARAVAN_STOREFRONT_ALLOWLIST_PAGE_LIMIT_DEFAULT;
const AUTH_CACHE_TTL_MS = 15_000;
const AUTH_CACHE_TTL_SEC = Math.ceil(AUTH_CACHE_TTL_MS / 1_000);
const AUTH_CACHE_KEY_PREFIX = 'karavan-storefront-allowlist:v1';
const AUDIT_ACTION_ADD = 'KARAVAN_STOREFRONT_ALLOWLIST_ADD';
const AUDIT_ACTION_REVOKE = 'KARAVAN_STOREFRONT_ALLOWLIST_REVOKE';

export function resolveKaravanStorefrontExpiresAt(
  duration: KaravanStorefrontDuration,
  now = new Date(),
): Date | null {
  if (duration === 'forever') {
    return null;
  }
  const match = /^(1|7|30|90)d$/u.exec(duration);
  const days = match ? Number.parseInt(match[1]!, 10) : 0;
  if (days <= 0) {
    throw new BadRequestException('Некорректный срок разрешения.');
  }
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) {
    throw new BadRequestException('Некорректная дата выдачи разрешения.');
  }
  return new Date(nowMs + days * 24 * 60 * 60 * 1_000);
}

@Injectable()
export class KaravanStorefrontAllowlistService {
  private readonly logger = new Logger(KaravanStorefrontAllowlistService.name);
  private readonly authorizationCache = new Map<
    string,
    { allowed: boolean; expiresAtMs: number }
  >();

  constructor(
    private readonly prisma: PrismaService,
    private readonly managedEntitiesService: ManagedEntitiesService,
    @Optional() private readonly redisCounter?: RedisCounterService,
  ) {}

  async list(
    chatId: string,
    actor: AuthUser,
    options: { cursor?: string; limit?: number; includeExpired?: boolean } = {},
  ): Promise<KaravanStorefrontAllowlistList> {
    const normalizedChatId = this.requireId(chatId, 'chatId');
    await this.assertChatAdmin(normalizedChatId, actor.userId);

    const limit = this.parseLimit(options.limit);
    const cursor = this.normalizeCursor(options.cursor);
    const where: AllowlistWhere = { chatId: normalizedChatId };
    if (!options.includeExpired) {
      where.OR = [{ expiresAt: null }, { expiresAt: { gt: new Date() } }];
    }

    const rows = await this.delegate.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    const hasNext = rows.length > limit;
    const page = hasNext ? rows.slice(0, limit) : rows;

    return {
      items: page.map((row) => this.toPublicEntry(row)),
      hasMore: hasNext,
      nextCursor: hasNext ? (page.at(-1)?.id ?? null) : null,
    };
  }

  async revoke(chatId: string, entryId: string, actor: AuthUser): Promise<{ revoked: true }> {
    const normalizedChatId = this.requireId(chatId, 'chatId');
    const normalizedEntryId = this.requireId(entryId, 'entryId');
    await this.assertChatAdmin(normalizedChatId, actor.userId);

    const row = await this.delegate.findMany({
      where: { chatId: normalizedChatId, id: normalizedEntryId },
      take: 1,
    });
    if (row.length === 0) {
      throw new NotFoundException('Разрешённый пользователь не найден.');
    }

    await this.runTransaction(async (tx) => {
      await tx.karavanStorefrontAllowlistEntry.delete({ where: { id: normalizedEntryId } });
      await tx.auditLog.create({
        data: {
          chatId: normalizedChatId,
          actorUserId: actor.userId,
          action: AUDIT_ACTION_REVOKE,
          payload: {
            entryId: normalizedEntryId,
            targetUserId: row[0]?.userId ?? null,
          } as Prisma.InputJsonObject,
        },
      });
    });
    this.invalidate(normalizedChatId, row[0]?.userId);
    return { revoked: true };
  }

  /**
   * Used by the private bot flow after the target user and duration callback
   * have been verified. The actor is rechecked as a managed-chat admin here.
   */
  async upsert(
    input: KaravanStorefrontAllowlistUpsertInput,
  ): Promise<KaravanStorefrontAllowlistEntry> {
    const chatId = this.requireId(input.chatId, 'chatId');
    const userId = this.requireId(input.userId, 'userId');
    const createdByUserId = this.requireId(input.createdByUserId, 'createdByUserId');
    // Keep the mutation safe even when a private-control caller forgets to
    // repeat its callback-level admin assertion.
    await this.assertChatAdmin(chatId, createdByUserId);
    if (
      input.expiresAt !== null &&
      (!(input.expiresAt instanceof Date) ||
        !Number.isFinite(input.expiresAt.getTime()) ||
        input.expiresAt.getTime() <= Date.now())
    ) {
      throw new BadRequestException('Срок разрешения должен быть в будущем.');
    }

    const row = await this.runTransaction(async (tx) => {
      const saved = await tx.karavanStorefrontAllowlistEntry.upsert({
        where: { chatId_userId: { chatId, userId } },
        create: {
          chatId,
          userId,
          displayName: this.boundDisplayName(input.displayName),
          expiresAt: input.expiresAt,
          createdByUserId,
          sourceMessageId: this.boundSourceMessageId(input.sourceMessageId),
        },
        update: {
          displayName: this.boundDisplayName(input.displayName),
          expiresAt: input.expiresAt,
          createdByUserId,
          sourceMessageId: this.boundSourceMessageId(input.sourceMessageId),
        },
      });
      await tx.auditLog.create({
        data: {
          chatId,
          actorUserId: createdByUserId,
          action: AUDIT_ACTION_ADD,
          payload: {
            targetUserId: userId,
            entryId: saved.id,
            expiresAt: input.expiresAt?.toISOString() ?? null,
            sourceMessageId: this.boundSourceMessageId(input.sourceMessageId),
          } as Prisma.InputJsonObject,
        },
      });
      return saved;
    });
    this.invalidate(chatId, userId);
    return row;
  }

  /** Fast-path check used by the relay; no HTTP/admin assertion is performed. */
  async isActive(chatId: string, userId: string): Promise<boolean> {
    const normalizedChatId = this.requireId(chatId, 'chatId');
    const normalizedUserId = this.requireId(userId, 'userId');
    const cacheKey = this.buildCacheKey(normalizedChatId, normalizedUserId);
    const now = Date.now();
    const cached = this.authorizationCache.get(cacheKey);
    if (cached && cached.expiresAtMs > now) {
      return cached.allowed;
    }

    const sharedCached = await this.readSharedAuthorizationCache(cacheKey, now);
    if (sharedCached) {
      this.authorizationCache.set(cacheKey, sharedCached);
      this.pruneAuthorizationCache(now);
      return sharedCached.allowed;
    }

    const row = await this.delegate.findFirst({
      where: {
        chatId: normalizedChatId,
        userId: normalizedUserId,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date(now) } }],
      },
      select: { id: true, expiresAt: true },
    });
    const allowed = Boolean(row);
    const cacheExpiresAtMs =
      row?.expiresAt instanceof Date
        ? Math.min(now + AUTH_CACHE_TTL_MS, row.expiresAt.getTime())
        : now + AUTH_CACHE_TTL_MS;
    this.authorizationCache.set(cacheKey, {
      allowed,
      expiresAtMs: cacheExpiresAtMs,
    });
    void this.writeSharedAuthorizationCache(cacheKey, allowed, cacheExpiresAtMs, now);
    this.pruneAuthorizationCache(now);
    return allowed;
  }

  private async assertChatAdmin(chatId: string, userId: string): Promise<void> {
    await this.managedEntitiesService.assertChatAdminAccess(chatId, {
      userId,
      username: null,
      displayName: null,
    });
  }

  private get delegate(): PrismaService['karavanStorefrontAllowlistEntry'] {
    return this.prisma.karavanStorefrontAllowlistEntry;
  }

  private async runTransaction<T>(
    operation: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return this.prisma.$transaction(operation);
  }

  private toPublicEntry(row: AllowlistEntryRow) {
    return {
      id: row.id,
      chatId: row.chatId,
      userId: row.userId,
      displayName: row.displayName?.trim() || null,
      expiresAt: row.expiresAt?.toISOString() ?? null,
      createdByUserId: row.createdByUserId,
      sourceMessageId: row.sourceMessageId,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private invalidate(chatId: string, userId?: string | null): void {
    if (!userId) {
      const prefix = `${encodeURIComponent(chatId)}:`;
      for (const key of this.authorizationCache.keys()) {
        if (key.startsWith(prefix)) {
          this.authorizationCache.delete(key);
          void this.redisCounter?.deleteKey(this.sharedCacheKey(key)).catch(() => undefined);
        }
      }
      return;
    }
    const cacheKey = this.buildCacheKey(chatId, userId);
    this.authorizationCache.delete(cacheKey);
    void this.redisCounter?.deleteKey(this.sharedCacheKey(cacheKey)).catch(() => undefined);
  }

  private buildCacheKey(chatId: string, userId: string): string {
    return `${encodeURIComponent(chatId)}:${encodeURIComponent(userId)}`;
  }

  private pruneAuthorizationCache(now: number): void {
    if (this.authorizationCache.size <= 10_000) {
      return;
    }
    for (const [key, entry] of this.authorizationCache) {
      if (entry.expiresAtMs <= now) {
        this.authorizationCache.delete(key);
      }
    }
  }

  private sharedCacheKey(cacheKey: string): string {
    return `${AUTH_CACHE_KEY_PREFIX}:${cacheKey}`;
  }

  private async readSharedAuthorizationCache(
    cacheKey: string,
    now: number,
  ): Promise<{ allowed: boolean; expiresAtMs: number } | null> {
    if (!this.redisCounter) {
      return null;
    }
    try {
      const raw = await this.redisCounter.getString(this.sharedCacheKey(cacheKey));
      if (!raw) {
        return null;
      }
      const [status, expiryRaw] = raw.split(':', 2);
      const expiresAtMs = expiryRaw ? Number(expiryRaw) : now + AUTH_CACHE_TTL_MS;
      if (!Number.isFinite(expiresAtMs) || expiresAtMs <= now) {
        void this.redisCounter.deleteKey(this.sharedCacheKey(cacheKey)).catch(() => undefined);
        return null;
      }
      if (status !== '1' && status !== '0') {
        return null;
      }
      return { allowed: status === '1', expiresAtMs };
    } catch (error: unknown) {
      this.logger.debug(
        { cacheKey, err: error instanceof Error ? error.message : String(error) },
        'Karavan allowlist shared cache read failed; falling back to Prisma',
      );
      return null;
    }
  }

  private async writeSharedAuthorizationCache(
    cacheKey: string,
    allowed: boolean,
    expiresAtMs: number,
    now: number,
  ): Promise<void> {
    if (!this.redisCounter) {
      return;
    }
    const ttlSec = Math.max(
      1,
      Math.ceil((Math.min(expiresAtMs, now + AUTH_CACHE_TTL_MS) - now) / 1_000),
    );
    try {
      await this.redisCounter.setStringWithTtl(
        this.sharedCacheKey(cacheKey),
        `${allowed ? '1' : '0'}:${expiresAtMs}`,
        Math.min(AUTH_CACHE_TTL_SEC, ttlSec),
      );
    } catch (error: unknown) {
      this.logger.debug(
        { cacheKey, err: error instanceof Error ? error.message : String(error) },
        'Karavan allowlist shared cache write failed; keeping local cache',
      );
    }
  }

  private parseLimit(value: number | undefined): number {
    if (value === undefined) {
      return DEFAULT_PAGE_SIZE;
    }
    if (!Number.isInteger(value) || value < 1 || value > MAX_PAGE_SIZE) {
      throw new BadRequestException(`limit должен быть целым числом от 1 до ${MAX_PAGE_SIZE}.`);
    }
    return value;
  }

  private normalizeCursor(value: string | undefined): string | undefined {
    if (value === undefined || value.trim().length === 0) {
      return undefined;
    }
    return this.requireId(value, 'cursor');
  }

  private requireId(value: string, label: string): string {
    const normalized = value.trim();
    if (!normalized || normalized.length > 200) {
      throw new BadRequestException(`Некорректный ${label}.`);
    }
    return normalized;
  }

  private boundDisplayName(value: string | null | undefined): string | null {
    if (value === undefined || value === null) {
      return null;
    }
    const normalized = value.trim();
    return normalized ? normalized.slice(0, 256) : null;
  }

  private boundSourceMessageId(value: string | null | undefined): string | null {
    if (value === undefined || value === null) {
      return null;
    }
    const normalized = value.trim();
    return normalized ? normalized.slice(0, 200) : null;
  }
}

export const KARAVAN_STOREFRONT_ALLOWLIST_AUDIT_ACTIONS = {
  ADD: AUDIT_ACTION_ADD,
  REVOKE: AUDIT_ACTION_REVOKE,
} as const;
