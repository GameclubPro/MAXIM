import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import {
  updateMessageRetentionSchema,
  type MessageRetentionState,
} from '@maxim/contracts/settings';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { MessageRetentionStore } from '../message-retention/message-retention-store.service';
import { retentionQuotaShard } from '../message-retention/message-retention.policy';
import { buildPublisherBotDescriptor } from '../publisher/publisher-bot-descriptor';
import { ManagedEntitiesService } from './managed-entities.service';
import { AdminSettingsBotCapabilityService } from './admin-settings-bot-capability.service';

@Injectable()
export class AdminMessageRetentionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ManagedEntitiesService,
    private readonly capabilities: AdminSettingsBotCapabilityService,
    private readonly store: MessageRetentionStore,
    private readonly config: ConfigService,
  ) {}

  async read(chatId: string, user: AuthUser): Promise<MessageRetentionState> {
    await this.authorize(chatId, user);
    return this.snapshot(chatId);
  }

  async update(chatId: string, user: AuthUser, body: unknown): Promise<MessageRetentionState> {
    await this.authorize(chatId, user);
    const parsed = updateMessageRetentionSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    const request = parsed.data;
    if (request.enabled) {
      if (!this.store.allows(chatId))
        throw new BadRequestException('Модуль пока недоступен в этом чате.');
      await this.capabilities.assertChatSettingsBotCapabilities(chatId, [
        { permission: 'write', featureKeys: ['messageRetention'] },
      ]);
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.messageRetentionPolicy.createMany({
        data: [{ chatId, activationId: randomUUID(), quotaShard: retentionQuotaShard(chatId) }],
        skipDuplicates: true,
      });
      await tx.$queryRaw`SELECT "chat_id" FROM "message_retention_policies" WHERE "chat_id" = ${chatId} FOR UPDATE`;
      const current = await tx.messageRetentionPolicy.findUniqueOrThrow({ where: { chatId } });
      if (current.revision !== request.expectedRevision)
        throw new ConflictException({
          code: 'MESSAGE_RETENTION_REVISION_CONFLICT',
          message: 'Настройки уже изменены. Обновите их перед сохранением.',
        });
      const now = new Date();
      const activationChanged = current.enabled !== request.enabled;
      await tx.messageRetentionPolicy.update({
        where: { chatId },
        data: {
          enabled: request.enabled,
          hours: request.hours,
          revision: { increment: 1 },
          updatedAt: now,
          ...(activationChanged
            ? {
                activationId: randomUUID(),
                enabledAt: request.enabled ? now : current.enabledAt,
                captureAfter: request.enabled ? now : null,
              }
            : {}),
          nextRunAt: now,
          lastStatus: request.enabled ? 'running' : 'off',
        },
      });
      await tx.auditLog.create({
        data: {
          chatId,
          actorUserId: user.userId,
          action: 'UPDATE_MESSAGE_RETENTION',
          payload: {
            enabled: request.enabled,
            hours: request.hours,
            revision: current.revision + 1,
          },
        },
      });
    });
    return this.snapshot(chatId);
  }

  private async authorize(chatId: string, user: AuthUser): Promise<void> {
    const publisherId = buildPublisherBotDescriptor({
      id: this.config.get('MAX_PUBLISHER_BOT_ID'),
    }).id;
    if (user.launchBotId === publisherId) throw new ForbiddenException();
    await this.access.assertChatAdminAccess(chatId, user);
    const chat = await this.prisma.chat.findUnique({
      where: { id: chatId },
      select: { entityType: true },
    });
    if (!/^-[1-9]\d*$/.test(chatId) || chat?.entityType !== 'CHAT')
      throw new BadRequestException('Модуль доступен только в групповых чатах.');
  }

  private async snapshot(chatId: string): Promise<MessageRetentionState> {
    const policy = await this.prisma.messageRetentionPolicy.findUnique({ where: { chatId } });
    const runtimeAvailable = this.store.allows(chatId);
    if (!policy)
      return {
        enabled: false,
        hours: 48,
        revision: 0,
        enabledAt: null,
        captureAfter: null,
        pausedAt: null,
        status: runtimeAvailable ? 'off' : 'unavailable',
        pendingCount: 0,
        deletedCount: 0,
        skippedCount: 0,
        oldestDueAt: null,
      };
    const pending = await this.prisma.messageRetentionCandidate.findFirst({
      where: { chatId, status: 'pending' },
      orderBy: [{ sourceAt: 'asc' }, { messageId: 'asc' }],
      select: { sourceAt: true },
    });
    const retry = await this.prisma.messageRetentionCandidate.findFirst({
      where: { chatId, status: 'retry' },
      orderBy: [{ sourceAt: 'asc' }, { messageId: 'asc' }],
      select: { sourceAt: true },
    });
    const oldest = Math.min(
      pending?.sourceAt.getTime() ?? Infinity,
      retry?.sourceAt.getTime() ?? Infinity,
    );
    const dueMs = oldest + policy.hours * 3_600_000;
    let status: MessageRetentionState['status'] = !runtimeAvailable
      ? 'unavailable'
      : !policy.enabled
        ? 'off'
        : policy.pausedAt
          ? 'capacity_paused'
          : this.store.mode === 'shadow'
            ? 'shadow'
            : ['paused', 'no_access', 'error'].includes(policy.lastStatus)
              ? (policy.lastStatus as MessageRetentionState['status'])
              : dueMs < Date.now() - 3_600_000
                ? 'delayed'
                : 'running';
    if (!policy.enabled && runtimeAvailable) status = 'off';
    return {
      enabled: policy.enabled,
      hours: policy.hours === 24 ? 24 : 48,
      revision: policy.revision,
      enabledAt: policy.enabledAt?.toISOString() ?? null,
      captureAfter: policy.captureAfter?.toISOString() ?? null,
      pausedAt: policy.pausedAt?.toISOString() ?? null,
      status,
      pendingCount: policy.pendingCount,
      deletedCount: policy.deletedCount,
      skippedCount: policy.skippedCount,
      oldestDueAt: Number.isFinite(dueMs) ? new Date(dueMs).toISOString() : null,
    };
  }
}
