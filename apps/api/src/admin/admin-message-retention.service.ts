import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Optional,
  ServiceUnavailableException,
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
import { retentionStatus } from '../message-retention/message-retention-status';
import { buildPublisherBotDescriptor } from '../publisher/publisher-bot-descriptor';
import { ManagedEntitiesService } from './managed-entities.service';
import { AdminSettingsBotCapabilityService } from './admin-settings-bot-capability.service';
import type { NetworkSettingsWriteOptions } from './network-settings-write';
import { EraserControlService } from '../message-retention/eraser-control.service';

@Injectable()
export class AdminMessageRetentionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ManagedEntitiesService,
    private readonly capabilities: AdminSettingsBotCapabilityService,
    private readonly store: MessageRetentionStore,
    private readonly config: ConfigService,
    @Optional() private readonly eraser?: EraserControlService,
  ) {}

  async read(chatId: string, user: AuthUser): Promise<MessageRetentionState> {
    await this.authorize(chatId, user);
    if (await this.useEraser(chatId)) return this.requireEraser().read(chatId);
    return this.snapshot(chatId);
  }

  async update(
    chatId: string,
    user: AuthUser,
    body: unknown,
    networkWrite?: NetworkSettingsWriteOptions,
  ): Promise<MessageRetentionState> {
    await this.authorize(chatId, user);
    const parsed = updateMessageRetentionSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    const request = parsed.data;
    if (await this.useEraser(chatId))
      return this.requireEraser().update(chatId, user.userId, request, networkWrite);
    if (request.hours === 168)
      throw new ServiceUnavailableException('Подключите Ластика, чтобы выбрать срок 1 неделя.');
    if (request.enabled) {
      if (!this.store.allows(chatId))
        throw new BadRequestException('Модуль пока недоступен в этом чате.');
      await this.capabilities.assertChatSettingsBotCapabilities(chatId, [
        { permission: 'write', featureKeys: ['messageRetention'] },
      ]);
    }
    if (networkWrite?.validateOnly) {
      const current = await this.prisma.messageRetentionPolicy.findUnique({ where: { chatId } });
      if ((current?.revision ?? 0) !== request.expectedRevision)
        throw new ConflictException('Настройки удаления сообщений уже изменены.');
      return this.snapshot(chatId);
    }
    await this.prisma.$transaction(async (tx) => {
      await networkWrite?.beforeWrite?.(tx);
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
          // FLAG: Ended receipts retain their own schedule after active credit reaches zero.
          // A DB-only visit recomputes the next due receipt even when this policy is disabled.
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
      await networkWrite?.onCommitted?.(tx, String(current.revision + 1));
    });
    return this.snapshot(chatId);
  }

  async resumeEraserOperation(
    chatId: string,
    user: AuthUser,
    operationId: string,
    options?: NetworkSettingsWriteOptions,
  ): Promise<MessageRetentionState | null> {
    if (!(await this.useEraser(chatId))) return null;
    await this.authorize(chatId, user);
    return this.requireEraser().resume(chatId, user.userId, operationId, options);
  }

  private requireEraser(): EraserControlService {
    if (!this.eraser) throw new ServiceUnavailableException('Ластик временно недоступен.');
    return this.eraser;
  }

  private async useEraser(chatId: string): Promise<boolean> {
    if (this.config.get<boolean>('ERASER_ENABLED', false)) return true;
    // FLAG: A switched-off or unreachable Lastik never falls back to moderator deletion.
    return this.eraser ? this.eraser.owns(chatId) : false;
  }

  private async authorize(chatId: string, user: AuthUser): Promise<void> {
    const publisherId = buildPublisherBotDescriptor({
      id: this.config.get('MAX_PUBLISHER_BOT_ID'),
    }).id;
    if (user.launchBotId === publisherId) throw new ForbiddenException();
    if (!/^-[1-9]\d*$/.test(chatId))
      throw new BadRequestException('Некорректный идентификатор чата.');
    await this.access.assertChatAdminAccess(chatId, user);
    const chat = await this.prisma.chat.findUnique({
      where: { id: chatId },
      select: { entityType: true },
    });
    if (chat?.entityType !== 'CHAT')
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
    const diagnostics = await this.store.diagnostics(chatId);
    const dueMs = diagnostics.oldestDueAt?.getTime() ?? Infinity;
    const status = retentionStatus(
      policy,
      this.store.mode,
      runtimeAvailable,
      dueMs,
      diagnostics.blockerStatus,
    );
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
