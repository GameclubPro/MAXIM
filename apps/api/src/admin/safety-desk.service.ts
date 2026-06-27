import {
  safetyDeskDecisionRequestSchema,
  safetyDeskDecisionResponseSchema,
  safetyDeskQueueResponseSchema,
  type SafetyDeskAuditEntry,
  type SafetyDeskDecisionResponse,
  type SafetyDeskQueueItem,
  type SafetyDeskQueueResponse,
  type SafetyDeskRiskLevel,
} from '@maxim/contracts';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ChatEntityType, Prisma } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { VkPublishService } from './vk-publish.service';

type ReviewPostRow = Prisma.VkParsingPostGetPayload<{
  include: {
    chat: { select: { title: true; entityType: true } };
    source: true;
  };
}>;
type SafetyAuditRow = Prisma.AuditLogGetPayload<Record<string, never>>;

const SAFETY_DESK_ACTOR_USER_ID = 'safety-desk-owner';
const VK_SOURCE_STATUS_ACTIVE = 'ACTIVE';
const VK_SOURCE_PUBLISH_MODE_REVIEW = 'REVIEW';
const VK_POST_STATUS_NEW = 'NEW';
const VK_POST_STATUS_FAILED = 'FAILED';
const VK_POST_STATUS_PUBLISHED = 'PUBLISHED';
const VK_POST_STATUS_UNAVAILABLE = 'UNAVAILABLE';
const VK_POST_STATUS_SKIPPED = 'SKIPPED';
const SAFETY_DESK_AUDIT_PREFIX = 'SAFETY_DESK_';
const SAFETY_DESK_TRUSTED_DOMAIN_ROOTS = ['max.ru', 'vk.ru', 'vk.com'];
const SAFETY_DESK_BLOCKED_APPROVE_MESSAGE =
  'Этот материал нельзя опубликовать автоматически: есть неподдерживаемые вложения или после фильтрации не осталось текста, фото или ссылок.';

@Injectable()
export class SafetyDeskService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly vkPublishService: VkPublishService,
  ) {}

  async getQueue(): Promise<SafetyDeskQueueResponse> {
    const [posts, audit, approved, rejected] = await Promise.all([
      this.loadReviewPosts(),
      this.loadAuditEntries(),
      this.prisma.auditLog.count({ where: { action: 'SAFETY_DESK_APPROVE' } }),
      this.prisma.auditLog.count({ where: { action: 'SAFETY_DESK_REJECT' } }),
    ]);
    const items = posts.map((post) => this.mapReviewPost(post));
    const blocked = items.filter((item) => item.status === 'BLOCKED').length;

    return safetyDeskQueueResponseSchema.parse({
      generatedAt: new Date().toISOString(),
      items,
      summary: {
        review: items.filter((item) => item.status === 'REVIEW').length,
        approved,
        rejected,
        blocked,
        servicePosts: 0,
      },
      audit,
    });
  }

  async approveItem(
    itemId: string,
    actorUserId: string | null,
    body: unknown,
  ): Promise<SafetyDeskDecisionResponse> {
    const parsed = safetyDeskDecisionRequestSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }
    const post = await this.findReviewPostOrThrow(itemId, { includeCancelled: false });
    const item = this.mapReviewPost(post);
    if (!this.isApprovableItem(item)) {
      throw new BadRequestException(this.buildNotApprovableMessage(item));
    }

    await this.approveReviewPost(post, actorUserId, parsed.data.reason ?? null);

    return safetyDeskDecisionResponseSchema.parse({
      item: null,
      queue: await this.getQueue(),
      message: 'Материал одобрен и опубликован в MAX.',
    });
  }

  async approveAllReviewItems(
    actorUserId: string | null,
    body: unknown,
  ): Promise<SafetyDeskDecisionResponse> {
    const parsed = safetyDeskDecisionRequestSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }

    const candidates = (await this.loadReviewPosts()).filter((post) =>
      this.isApprovableItem(this.mapReviewPost(post)),
    );
    let approved = 0;
    let failed = 0;

    for (const post of candidates) {
      try {
        await this.approveReviewPost(post, actorUserId, parsed.data.reason ?? null);
        approved += 1;
      } catch {
        failed += 1;
      }
    }

    return safetyDeskDecisionResponseSchema.parse({
      item: null,
      queue: await this.getQueue(),
      message: this.buildApproveAllMessage(approved, failed, candidates.length),
    });
  }

  async rejectItem(
    itemId: string,
    actorUserId: string | null,
    body: unknown,
  ): Promise<SafetyDeskDecisionResponse> {
    const parsed = safetyDeskDecisionRequestSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }
    const post = await this.findReviewPostOrThrow(itemId, { includeCancelled: false });
    const now = new Date();
    await this.prisma.vkParsingPost.update({
      where: { id: post.id },
      data: {
        publishQueuedAt: null,
        publishScheduledAt: null,
        publishCancelledAt: now,
        publishCancelledByUserId: this.resolveActor(actorUserId),
        publishLockedAt: null,
        publishIdempotencyKey: null,
        publishReason: null,
      },
    });
    await this.writeAuditLog(post.chatId, actorUserId, 'SAFETY_DESK_REJECT', {
      postId: post.id,
      sourceId: post.sourceId,
      itemTitle: this.buildTitle(post),
      reason: parsed.data.reason ?? null,
    });

    return safetyDeskDecisionResponseSchema.parse({
      item: null,
      queue: await this.getQueue(),
      message: 'Материал отклонен. В MAX ничего не отправлено.',
    });
  }

  async recheckItem(
    itemId: string,
    actorUserId: string | null,
  ): Promise<SafetyDeskDecisionResponse> {
    const post = await this.findReviewPostOrThrow(itemId, { includeCancelled: true });
    const updated = await this.prisma.vkParsingPost.update({
      where: { id: post.id },
      data: {
        status: post.status === VK_POST_STATUS_FAILED ? VK_POST_STATUS_NEW : post.status,
        publishCancelledAt: null,
        publishCancelledByUserId: null,
        publishLockedAt: null,
        publishIdempotencyKey: null,
        publishReason: null,
        lastError: null,
        autoPublishError: null,
      },
      include: {
        chat: { select: { title: true, entityType: true } },
        source: true,
      },
    });
    const item = this.mapReviewPost(updated);
    await this.writeAuditLog(updated.chatId, actorUserId, 'SAFETY_DESK_RECHECK', {
      postId: updated.id,
      sourceId: updated.sourceId,
      itemTitle: item.title,
    });

    return safetyDeskDecisionResponseSchema.parse({
      item,
      queue: await this.getQueue(),
      message: 'Материал возвращен на проверку.',
    });
  }

  private async loadReviewPosts(): Promise<ReviewPostRow[]> {
    return this.prisma.vkParsingPost.findMany({
      where: {
        status: { in: [VK_POST_STATUS_NEW, VK_POST_STATUS_FAILED] },
        publishCancelledAt: null,
        skippedAt: null,
        unavailableAt: null,
        source: {
          status: VK_SOURCE_STATUS_ACTIVE,
          publishMode: VK_SOURCE_PUBLISH_MODE_REVIEW,
        },
      },
      include: {
        chat: { select: { title: true, entityType: true } },
        source: true,
      },
      orderBy: [{ vkPublishedAt: 'desc' }, { createdAt: 'desc' }],
      take: 100,
    });
  }

  private async findReviewPostOrThrow(
    itemId: string,
    options: { includeCancelled: boolean },
  ): Promise<ReviewPostRow> {
    const post = await this.prisma.vkParsingPost.findFirst({
      where: {
        id: itemId,
        status: {
          notIn: [VK_POST_STATUS_PUBLISHED, VK_POST_STATUS_UNAVAILABLE, VK_POST_STATUS_SKIPPED],
        },
        skippedAt: null,
        unavailableAt: null,
        ...(options.includeCancelled ? {} : { publishCancelledAt: null }),
        source: {
          status: VK_SOURCE_STATUS_ACTIVE,
          publishMode: VK_SOURCE_PUBLISH_MODE_REVIEW,
        },
      },
      include: {
        chat: { select: { title: true, entityType: true } },
        source: true,
      },
    });

    if (!post) {
      throw new NotFoundException('Материал проверки не найден.');
    }

    return post;
  }

  private async loadAuditEntries(): Promise<SafetyDeskAuditEntry[]> {
    const rows = await this.prisma.auditLog.findMany({
      where: { action: { startsWith: SAFETY_DESK_AUDIT_PREFIX } },
      orderBy: [{ createdAt: 'desc' }],
      take: 30,
    });

    return rows.map((row) => this.mapAuditEntry(row));
  }

  private mapReviewPost(post: ReviewPostRow): SafetyDeskQueueItem {
    const photoUrls = this.readStringArray(post.photoUrls);
    const linkUrls = this.readStringArray(post.linkUrls);
    const domains = this.extractDomains([post.url, ...linkUrls]);
    const risk = this.resolveRisk(post, domains, photoUrls);
    const reasons = this.buildReasons(post, domains, photoUrls);
    const checks = this.buildChecks(post, domains);
    const status =
      risk === 'BLOCKED' || checks.some((check) => check.state === 'BLOCKED')
        ? 'BLOCKED'
        : 'REVIEW';

    return {
      id: post.id,
      source: 'VK_REVIEW',
      sourceId: post.sourceId,
      chatId: post.chatId,
      entityTitle: this.buildEntityTitle(post),
      sourceTitle: post.source.title,
      author: post.source.title || 'Внешний источник',
      status,
      risk,
      title: this.buildTitle(post),
      text: post.text,
      domains,
      photoUrls,
      linkUrls,
      originalUrl: post.url || null,
      scheduledAt: post.publishScheduledAt ? post.publishScheduledAt.toISOString() : null,
      createdAt: post.createdAt.toISOString(),
      updatedAt: post.updatedAt.toISOString(),
      reasons,
      checks,
    };
  }

  private buildReasons(post: ReviewPostRow, domains: string[], photoUrls: string[]): string[] {
    const reasons = ['Источник настроен на ручную проверку перед публикацией'];

    if (post.status === VK_POST_STATUS_FAILED || post.lastError) {
      reasons.push(
        `Предыдущая попытка остановлена: ${post.lastError ?? 'требуется повторная проверка'}`,
      );
    }
    if (domains.length > 0) {
      reasons.push('Найдены внешние ссылки');
    }
    if (photoUrls.length > 0) {
      reasons.push(`Медиа вложения: ${photoUrls.length}`);
    }
    if (post.hasUnsupportedAttachments) {
      reasons.push('Есть вложения, которые нельзя безопасно перенести автоматически');
    }
    if (post.isAdvertising || this.readStringArray(post.advertisingMarkers).length > 0) {
      reasons.push('Найдены коммерческие маркеры, нужна ручная оценка');
    }
    if (post.publishScheduledAt) {
      reasons.push('Материал был поставлен в отложенную публикацию');
    }

    return reasons;
  }

  private buildChecks(post: ReviewPostRow, domains: string[]): SafetyDeskQueueItem['checks'] {
    return [
      {
        label: 'Принудительное добавление пользователей не используется',
        state: 'PASSED',
      },
      {
        label:
          post.isAdvertising || this.readStringArray(post.advertisingMarkers).length > 0
            ? 'Коммерческие маркеры требуют ручной оценки'
            : 'Запрещенные категории не обнаружены автоматически',
        state:
          post.isAdvertising || this.readStringArray(post.advertisingMarkers).length > 0
            ? 'WARNING'
            : 'PASSED',
      },
      {
        label: domains.length > 0 ? 'Ссылки извлечены для проверки' : 'Внешних ссылок нет',
        state: domains.length > 0 ? 'WARNING' : 'PASSED',
      },
      {
        label: post.hasUnsupportedAttachments
          ? 'Есть неподдерживаемые вложения'
          : 'Вложения пригодны для безопасной публикации',
        state: post.hasUnsupportedAttachments ? 'BLOCKED' : 'PASSED',
      },
      {
        label: 'До решения владельца в MAX ничего не отправляется',
        state: 'PASSED',
      },
    ];
  }

  private isApprovableItem(item: SafetyDeskQueueItem): boolean {
    return item.status === 'REVIEW' && item.checks.every((check) => check.state !== 'BLOCKED');
  }

  private buildNotApprovableMessage(item: SafetyDeskQueueItem): string {
    const blockedReasons = item.checks
      .filter((check) => check.state === 'BLOCKED')
      .map((check) => check.label);

    if (blockedReasons.length === 0) {
      const reason = item.reasons[0]?.trim();
      return reason
        ? `Этот материал нельзя опубликовать автоматически: ${reason}.`
        : SAFETY_DESK_BLOCKED_APPROVE_MESSAGE;
    }

    return `Этот материал нельзя опубликовать автоматически: ${blockedReasons.join('; ')}.`;
  }

  private resolveRisk(
    post: ReviewPostRow,
    domains: string[],
    photoUrls: string[],
  ): SafetyDeskRiskLevel {
    if (post.status === VK_POST_STATUS_FAILED || post.lastError) {
      return 'BLOCKED';
    }
    if (post.hasUnsupportedAttachments) {
      return 'HIGH';
    }
    if (post.isAdvertising || this.readStringArray(post.advertisingMarkers).length > 0) {
      return 'HIGH';
    }
    if (domains.length > 0 || photoUrls.length > 0) {
      return 'MEDIUM';
    }
    return 'LOW';
  }

  private mapAuditEntry(row: SafetyAuditRow): SafetyDeskAuditEntry {
    const payload = this.asRecord(row.payload) ?? {};
    return {
      id: row.id,
      itemId: this.readString(payload.postId) || null,
      action: row.action,
      title: this.readString(payload.itemTitle) || this.auditActionLabel(row.action),
      createdAt: row.createdAt.toISOString(),
    };
  }

  private buildTitle(post: ReviewPostRow): string {
    const firstLine = post.text
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .find(Boolean);
    if (firstLine) {
      return firstLine.length > 80 ? `${firstLine.slice(0, 77)}...` : firstLine;
    }
    if (post.source.title) {
      return `Публикация из ${post.source.title}`;
    }
    return `Материал ${post.vkOwnerId}_${post.vkPostId}`;
  }

  private buildEntityTitle(post: ReviewPostRow): string {
    const prefix = post.chat.entityType === ChatEntityType.CHANNEL ? 'Канал' : 'Чат';
    return `${prefix}: ${post.chat.title || post.chatId}`;
  }

  private extractDomains(urls: string[]): string[] {
    const domains = new Set<string>();
    for (const url of urls) {
      try {
        const parsed = new URL(url);
        const hostname = parsed.hostname.toLowerCase();
        if (hostname && !this.isTrustedDomain(hostname)) {
          domains.add(hostname);
        }
      } catch {
        continue;
      }
    }
    return [...domains].sort();
  }

  private isTrustedDomain(hostname: string): boolean {
    const normalized = hostname.replace(/\.$/u, '');
    return SAFETY_DESK_TRUSTED_DOMAIN_ROOTS.some(
      (root) => normalized === root || normalized.endsWith(`.${root}`),
    );
  }

  private async approveReviewPost(
    post: ReviewPostRow,
    actorUserId: string | null,
    reason: string | null,
  ): Promise<void> {
    const photoUrls = this.readStringArray(post.photoUrls);
    const linkUrls = this.readStringArray(post.linkUrls);
    const result = await this.vkPublishService.publishPost(
      post.chatId,
      post.id,
      SAFETY_DESK_ACTOR_USER_ID,
      {
        text: post.text,
        photoUrls,
        linkUrls,
      },
    );
    await this.writeAuditLog(post.chatId, actorUserId, 'SAFETY_DESK_APPROVE', {
      postId: post.id,
      sourceId: post.sourceId,
      itemTitle: this.buildTitle(post),
      reason,
      messageId: result.messageId,
      url: result.url,
    });
  }

  private buildApproveAllMessage(approved: number, failed: number, total: number): string {
    if (total === 0) {
      return 'Нет материалов, доступных для массового одобрения.';
    }
    if (failed > 0) {
      return `Одобрено ${approved} из ${total}. Не удалось опубликовать: ${failed}.`;
    }
    return `Одобрено и опубликовано материалов: ${approved}.`;
  }

  private readStringArray(value: Prisma.JsonValue | unknown): string[] {
    if (!Array.isArray(value)) {
      return [];
    }
    return value.filter(
      (item): item is string => typeof item === 'string' && item.trim().length > 0,
    );
  }

  private async writeAuditLog(
    chatId: string,
    actorUserId: string | null,
    action: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await this.prisma.auditLog.create({
      data: {
        chatId,
        actorUserId: this.resolveActor(actorUserId),
        action,
        payload: this.toJsonInput(payload),
      },
    });
  }

  private resolveActor(actorUserId: string | null): string {
    const normalized = actorUserId?.trim();
    return normalized || SAFETY_DESK_ACTOR_USER_ID;
  }

  private auditActionLabel(action: string): string {
    if (action === 'SAFETY_DESK_APPROVE') {
      return 'Материал одобрен';
    }
    if (action === 'SAFETY_DESK_REJECT') {
      return 'Материал отклонен';
    }
    if (action === 'SAFETY_DESK_RECHECK') {
      return 'Повторная проверка';
    }
    return 'Решение Safety Desk';
  }

  private asRecord(value: unknown): Record<string, unknown> | null {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  }

  private readString(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
  }

  private toJsonInput(value: unknown): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(value ?? null)) as Prisma.InputJsonValue;
  }
}
