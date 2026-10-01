import {
  safetyDeskRetentionRuntimeResponseSchema,
  safetyDeskRetentionPreviewResponseSchema,
  safetyDeskRetryRetentionRequestSchema,
  type SafetyDeskRetentionRuntimeResponse,
  type SafetyDeskRetentionPreviewResponse,
} from '@maxim/contracts/safety-desk';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service';
import { MessageRetentionStore } from '../message-retention/message-retention-store.service';
import { retentionStatus } from '../message-retention/message-retention-status';
import {
  MESSAGE_RETENTION_CHAT_LIMIT,
  MESSAGE_RETENTION_SHARD_LIMIT,
  MESSAGE_RETENTION_RULE,
} from '../message-retention/message-retention.policy';
import { AdminSettingsBotCapabilityService } from './admin-settings-bot-capability.service';

@Injectable()
export class SafetyDeskRetentionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly store: MessageRetentionStore,
    private readonly capabilities: AdminSettingsBotCapabilityService,
  ) {}

  async runtime(input?: unknown): Promise<SafetyDeskRetentionRuntimeResponse> {
    const parsed = z
      .string()
      .regex(/^-[1-9]\d*$/)
      .optional()
      .safeParse(input);
    if (!parsed.success) throw new BadRequestException('Некорректный курсор чатов.');
    const after = parsed.data;
    // FLAG: Fleet diagnostics keyset-page policies, never aggregate the deletion ledger.
    const [policies, quotas] = await Promise.all([
      this.prisma.messageRetentionPolicy.findMany({
        where: after ? { chatId: { gt: after } } : {},
        orderBy: { chatId: 'asc' },
        take: 51,
      }),
      this.prisma.messageRetentionQuota.findMany({ orderBy: { shard: 'asc' }, take: 32 }),
    ]);
    const page = policies.slice(0, 50);
    const chats = page.length
      ? await this.prisma.chat.findMany({
          where: { id: { in: page.map((policy) => policy.chatId) } },
          select: { id: true, title: true },
          take: 50,
        })
      : [];
    const titles = new Map(chats.map((chat) => [chat.id, chat.title]));
    const items = [];
    for (const policy of page) {
      const diagnostics = await this.store.diagnostics(policy.chatId);
      items.push({
        chatId: policy.chatId,
        chatTitle: titles.get(policy.chatId) ?? 'Чат недоступен',
        enabled: policy.enabled,
        hours: policy.hours === 24 ? 24 : 48,
        revision: policy.revision,
        activationId: policy.activationId,
        pendingCount: policy.pendingCount,
        deletedCount: policy.deletedCount,
        skippedCount: policy.skippedCount,
        status: retentionStatus(
          policy,
          this.store.mode,
          this.store.allows(policy.chatId),
          diagnostics.oldestDueAt?.getTime(),
          diagnostics.blockerStatus,
        ),
        oldestDueAt: diagnostics.oldestDueAt?.toISOString() ?? null,
        nextRunAt: policy.nextRunAt?.toISOString() ?? null,
        hasTerminalReview: diagnostics.hasTerminalReview,
        hasUnresolvedReceipt: diagnostics.hasUnresolvedReceipt,
        captureAfter: policy.captureAfter?.toISOString() ?? null,
        pausedAt: policy.pausedAt?.toISOString() ?? null,
        updatedAt: policy.updatedAt.toISOString(),
      });
    }
    return safetyDeskRetentionRuntimeResponseSchema.parse({
      generatedAt: new Date().toISOString(),
      mode: this.store.mode,
      nextAfter: policies.length > 50 ? page.at(-1)!.chatId : null,
      quotas: quotas.map((q) => ({
        shard: q.shard,
        pendingCount: q.pendingCount,
        cap: MESSAGE_RETENTION_SHARD_LIMIT,
      })),
      items,
    });
  }

  async preview(chatId: string): Promise<SafetyDeskRetentionPreviewResponse> {
    this.assertChatId(chatId);
    const policy = await this.prisma.messageRetentionPolicy.findUnique({ where: { chatId } });
    if (!policy) throw new NotFoundException('Настройки очистки не найдены.');
    const [terminal, recovery, quota] = await Promise.all([
      this.prisma.messageRetentionCandidate.findMany({
        where: { chatId, outcomeCode: 'terminal_review' },
        orderBy: { messageId: 'asc' },
        take: 10,
      }),
      this.prisma.messageRetentionCandidate.findMany({
        where: { chatId, outcomeCode: 'reconciliation' },
        orderBy: { messageId: 'asc' },
        take: 10,
      }),
      this.prisma.messageRetentionQuota.findUnique({ where: { shard: policy.quotaShard } }),
    ]);
    const candidates = [...terminal, ...recovery];
    const intents = candidates.length
      ? await this.prisma.moderationDeleteIntent.findMany({
          where: { id: { in: candidates.flatMap((c) => (c.intentId ? [c.intentId] : [])) } },
          include: { reasons: { select: { ruleCode: true }, take: 2 } },
          take: 20,
        })
      : [];
    const byId = new Map(intents.map((intent) => [intent.id, intent]));
    return safetyDeskRetentionPreviewResponseSchema.parse({
      chatId,
      revision: policy.revision,
      activationId: policy.activationId,
      items: candidates.map((candidate) => {
        const intent = candidate.intentId ? byId.get(candidate.intentId) : undefined;
        const retryAllowed =
          this.store.allows(chatId, true) &&
          policy.enabled &&
          !policy.pausedAt &&
          quota !== null &&
          !quota.pausedAt &&
          policy.pendingCount < MESSAGE_RETENTION_CHAT_LIMIT * 0.8 &&
          quota.pendingCount < MESSAGE_RETENTION_SHARD_LIMIT * 0.8 &&
          candidate.activationId === policy.activationId &&
          !candidate.shadowOnly &&
          candidate.outcomeCode === 'terminal_review' &&
          ['skipped', 'cancelled'].includes(candidate.status) &&
          intent?.retentionOwned === true &&
          intent.chatId === chatId &&
          intent.messageId === candidate.messageId &&
          intent.subjectUserId === candidate.authorId &&
          ['FAILED_TERMINAL', 'EXPIRED'].includes(intent.status) &&
          intent.reasons.length === 1 &&
          intent.reasons[0]?.ruleCode === MESSAGE_RETENTION_RULE &&
          !intent.deleteDispatchStartedAt &&
          !intent.deleteDispatchStartedBotId &&
          !intent.remoteDeleteSucceededAt &&
          !intent.remoteDeleteSucceededBotId;
        return {
          messageId: candidate.messageId,
          authorId: candidate.authorId,
          sourceAt: candidate.sourceAt.toISOString(),
          dueAt: new Date(candidate.sourceAt.getTime() + policy.hours * 3_600_000).toISOString(),
          status: candidate.status,
          outcomeCode: candidate.outcomeCode,
          intentId: candidate.intentId,
          intentStatus: intent?.status ?? null,
          intentUpdatedAt: intent?.updatedAt.toISOString() ?? null,
          intentAttemptCount: intent?.attemptCount ?? null,
          reconcileAfter: candidate.reconcileAfter?.toISOString() ?? null,
          retryAllowed,
        };
      }),
    });
  }

  async retry(
    chatId: string,
    actorUserId: string | null,
    body: unknown,
  ): Promise<SafetyDeskRetentionPreviewResponse> {
    this.assertChatId(chatId);
    const parsed = safetyDeskRetryRetentionRequestSchema.safeParse(body);
    if (!parsed.success)
      throw new BadRequestException('Обновите сведения о сообщении перед повтором.');
    if (!this.store.allows(chatId, true))
      throw new BadRequestException('Обработка выключена для этого чата.');
    await this.capabilities.assertChatSettingsBotCapabilities(
      chatId,
      [{ permission: 'write', featureKeys: ['messageRetention'] }],
      { forceLive: true },
    );
    // FLAG: The store atomically checks versions, ownership, mutation evidence and credits.
    // An operator can only schedule the normal guarded worker, never dispatch DELETE here.
    const changed = await this.store.reopenTerminalCandidate({
      ...parsed.data,
      chatId,
      expectedIntentUpdatedAt: new Date(parsed.data.expectedIntentUpdatedAt),
      actorUserId: actorUserId?.trim() || 'safety-desk-owner',
    });
    if (!changed)
      throw new ConflictException('Состояние или условия обработки изменились. Обновите сведения.');
    return this.preview(chatId);
  }

  private assertChatId(chatId: string): void {
    if (!/^-[1-9]\d*$/.test(chatId))
      throw new BadRequestException('Некорректный идентификатор чата.');
  }
}
