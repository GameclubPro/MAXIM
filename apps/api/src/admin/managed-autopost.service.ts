import {
  createManagedAutopostRuleRequestSchema,
  managedAutopostPayloadSchema,
  managedAutopostRuleDetailsSchema,
  managedAutopostRuleSummarySchema,
  type ManagedAutopostPayload,
  type ManagedAutopostRuleDetails,
  type ManagedAutopostRuleSummary,
  type ManagedEntityType,
  type SendBroadcastRequest,
  updateManagedAutopostRuleRequestSchema,
} from '@maxim/contracts';
import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  ChatEntityType,
  ManagedAutopostMaterializationStatus,
  ManagedAutopostRuleStatus,
  ManagedBroadcastStatus,
  Prisma,
  type ManagedAutopostRule as PersistedManagedAutopostRule,
} from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import { MAX_API_SOURCE_TAGS } from '../max/max-client.service';
import { BackgroundRuntimeGovernorService } from '../system/background-runtime-governor.service';
import { isSystemModeRecoveryWindow, SystemModeService } from '../system/system-mode.service';
import { ManagedBroadcastService } from './managed-broadcast.service';
import { ManagedEntitiesService } from './managed-entities.service';
import { mapManagedEntityTypeToChatEntityType } from './admin.service.support';
import { isPrismaKnownError } from './admin-legacy-utils';

const AUTOSCHEDULE_HORIZON_DAYS = 14;
const AUTOSCHEDULE_MIN_DELAY_MS = 30_000;
const AUTOSCHEDULE_LOCK_STALE_MS = 5 * 60_000;
const AUTOSCHEDULE_BATCH_SIZE = 20;
const AUTOSCHEDULE_RETRY_MS = 5 * 60_000;
const AUTOSCHEDULE_MATERIALIZATION_STALE_MS = 10 * 60_000;
const AUTOSCHEDULE_BACKGROUND_POLL_MS = 60_000;
const AUTOSCHEDULE_MIN_RULE_SLOT_DELAY_MS =
  AUTOSCHEDULE_BACKGROUND_POLL_MS + 2 * AUTOSCHEDULE_MIN_DELAY_MS;

type MaterializeReason = 'startup' | 'scheduled' | 'manual';
type MaterializableRuleStatus =
  | typeof ManagedAutopostRuleStatus.ACTIVE
  | typeof ManagedAutopostRuleStatus.ERROR;

type ManagedAutopostRuleWithCount = PersistedManagedAutopostRule & {
  _count?: { materializations?: number };
};

@Injectable()
export class ManagedAutopostService {
  private readonly logger = new Logger(ManagedAutopostService.name);
  private throttleLogAtMs = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly managedEntitiesService: ManagedEntitiesService,
    private readonly managedBroadcastService: ManagedBroadcastService,
    private readonly systemModeService: SystemModeService,
    private readonly backgroundRuntimeGovernorService: BackgroundRuntimeGovernorService,
  ) {}

  async listChatAutopostRules(
    sourceChatId: string,
    user: AuthUser,
  ): Promise<ManagedAutopostRuleSummary[]> {
    await this.managedEntitiesService.assertChatReadAccess(sourceChatId, user);
    return this.listRulesForEntity(sourceChatId, 'chat');
  }

  async listChannelAutopostRules(
    sourceChatId: string,
    user: AuthUser,
  ): Promise<ManagedAutopostRuleSummary[]> {
    await this.managedEntitiesService.assertChannelReadAccess(sourceChatId, user);
    return this.listRulesForEntity(sourceChatId, 'channel');
  }

  async getChatAutopostRule(
    sourceChatId: string,
    ruleId: string,
    user: AuthUser,
  ): Promise<ManagedAutopostRuleDetails> {
    await this.managedEntitiesService.assertChatReadAccess(sourceChatId, user);
    return this.getRuleForEntity(sourceChatId, ruleId, 'chat');
  }

  async getChannelAutopostRule(
    sourceChatId: string,
    ruleId: string,
    user: AuthUser,
  ): Promise<ManagedAutopostRuleDetails> {
    await this.managedEntitiesService.assertChannelReadAccess(sourceChatId, user);
    return this.getRuleForEntity(sourceChatId, ruleId, 'channel');
  }

  async createChatAutopostRule(
    sourceChatId: string,
    user: AuthUser,
    body: unknown,
  ): Promise<ManagedAutopostRuleDetails> {
    await this.managedEntitiesService.assertChatAdminAccess(sourceChatId, user);
    return this.createRuleForEntity(sourceChatId, user, body, 'chat');
  }

  async createChannelAutopostRule(
    sourceChatId: string,
    user: AuthUser,
    body: unknown,
  ): Promise<ManagedAutopostRuleDetails> {
    await this.managedEntitiesService.assertChannelAdminAccess(sourceChatId, user);
    return this.createRuleForEntity(sourceChatId, user, body, 'channel');
  }

  async updateChatAutopostRule(
    sourceChatId: string,
    ruleId: string,
    user: AuthUser,
    body: unknown,
  ): Promise<ManagedAutopostRuleDetails> {
    await this.managedEntitiesService.assertChatAdminAccess(sourceChatId, user);
    return this.updateRuleForEntity(sourceChatId, ruleId, user, body, 'chat');
  }

  async updateChannelAutopostRule(
    sourceChatId: string,
    ruleId: string,
    user: AuthUser,
    body: unknown,
  ): Promise<ManagedAutopostRuleDetails> {
    await this.managedEntitiesService.assertChannelAdminAccess(sourceChatId, user);
    return this.updateRuleForEntity(sourceChatId, ruleId, user, body, 'channel');
  }

  async deleteChatAutopostRule(
    sourceChatId: string,
    ruleId: string,
    user: AuthUser,
  ): Promise<ManagedAutopostRuleDetails> {
    await this.managedEntitiesService.assertChatAdminAccess(sourceChatId, user);
    return this.disableRuleForEntity(sourceChatId, ruleId, user, 'chat');
  }

  async deleteChannelAutopostRule(
    sourceChatId: string,
    ruleId: string,
    user: AuthUser,
  ): Promise<ManagedAutopostRuleDetails> {
    await this.managedEntitiesService.assertChannelAdminAccess(sourceChatId, user);
    return this.disableRuleForEntity(sourceChatId, ruleId, user, 'channel');
  }

  async processDueAutopostRules(reason: MaterializeReason): Promise<void> {
    const decision = await this.resolveBackgroundDecision(reason);
    if (decision === 'pause') {
      return;
    }

    const now = new Date();
    const staleLockBefore = new Date(now.getTime() - AUTOSCHEDULE_LOCK_STALE_MS);
    const rows = await this.prisma.managedAutopostRule.findMany({
      where: {
        status: { in: [ManagedAutopostRuleStatus.ACTIVE, ManagedAutopostRuleStatus.ERROR] },
        nextMaterializeAt: { lte: now },
        OR: [{ lockedAt: null }, { lockedAt: { lt: staleLockBefore } }],
      },
      orderBy: [{ nextMaterializeAt: 'asc' }, { updatedAt: 'asc' }],
      take:
        decision === 'slow'
          ? Math.max(1, Math.floor(AUTOSCHEDULE_BATCH_SIZE / 2))
          : AUTOSCHEDULE_BATCH_SIZE,
      select: { id: true },
    });

    for (const row of rows) {
      await this.materializeRule(row.id, reason, staleLockBefore);
    }
  }

  private async listRulesForEntity(
    sourceChatId: string,
    entityType: ManagedEntityType,
  ): Promise<ManagedAutopostRuleSummary[]> {
    const rows = await this.prisma.managedAutopostRule.findMany({
      where: {
        sourceChatId,
        entityType: mapManagedEntityTypeToChatEntityType(entityType),
        status: { not: ManagedAutopostRuleStatus.DISABLED },
      },
      orderBy: [{ status: 'asc' }, { nextMaterializeAt: 'asc' }, { updatedAt: 'desc' }],
      include: { _count: { select: { materializations: true } } },
    });

    return rows.map((row) => this.mapRuleSummary(row, entityType));
  }

  private async getRuleForEntity(
    sourceChatId: string,
    ruleId: string,
    entityType: ManagedEntityType,
  ): Promise<ManagedAutopostRuleDetails> {
    const row = await this.prisma.managedAutopostRule.findFirst({
      where: {
        id: ruleId,
        sourceChatId,
        entityType: mapManagedEntityTypeToChatEntityType(entityType),
        status: { not: ManagedAutopostRuleStatus.DISABLED },
      },
      include: { _count: { select: { materializations: true } } },
    });
    if (!row) {
      throw new BadRequestException('Автопост не найден.');
    }

    return this.mapRuleDetails(row, entityType);
  }

  private async createRuleForEntity(
    sourceChatId: string,
    user: AuthUser,
    body: unknown,
    entityType: ManagedEntityType,
  ): Promise<ManagedAutopostRuleDetails> {
    const parsed = createManagedAutopostRuleRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }
    const request = parsed.data;
    await this.assertPayloadTargets(sourceChatId, user, request.payload, entityType);
    this.assertAutopostSlots(request.payload);
    const nextMaterializeAt = this.resolveNextMaterializeAt(request.payload);
    const hasFutureSend = this.resolveNextSendAt(request.payload) !== null;
    const created = await this.prisma.managedAutopostRule.create({
      data: {
        sourceChatId,
        entityType: mapManagedEntityTypeToChatEntityType(entityType),
        actorUserId: user.userId,
        title: request.title,
        payload: request.payload as Prisma.InputJsonValue,
        status: hasFutureSend
          ? ManagedAutopostRuleStatus.ACTIVE
          : ManagedAutopostRuleStatus.COMPLETED,
        nextMaterializeAt,
      },
      include: { _count: { select: { materializations: true } } },
    });

    await this.prisma.auditLog.create({
      data: {
        chatId: sourceChatId,
        actorUserId: user.userId,
        action: 'CREATE_AUTOPOST_RULE',
        payload: {
          ruleId: created.id,
          entityType,
          slots: request.payload.scheduledSlots.length,
        },
      },
    });

    return this.getRuleForEntity(sourceChatId, created.id, entityType);
  }

  private async updateRuleForEntity(
    sourceChatId: string,
    ruleId: string,
    user: AuthUser,
    body: unknown,
    entityType: ManagedEntityType,
  ): Promise<ManagedAutopostRuleDetails> {
    const parsed = updateManagedAutopostRuleRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }
    const request = parsed.data;
    const existing = await this.getPersistedRule(sourceChatId, ruleId, entityType);
    this.assertRuleEditable(existing);
    const nextPayload = request.payload ?? this.parsePayload(existing.payload);
    const payloadChanged = request.payload !== undefined;
    const requestedStatus =
      request.status ??
      (payloadChanged &&
      (existing.status === ManagedAutopostRuleStatus.ERROR ||
        existing.status === ManagedAutopostRuleStatus.COMPLETED)
        ? ManagedAutopostRuleStatus.ACTIVE
        : existing.status);
    if (payloadChanged || request.status === ManagedAutopostRuleStatus.ACTIVE) {
      await this.assertPayloadTargets(sourceChatId, user, nextPayload, entityType);
      this.assertAutopostSlots(nextPayload);
    }
    const nextRevision = existing.revision + (payloadChanged ? 1 : 0);
    const nextMaterializeAt = await this.resolveNextMaterializeAtForRule(
      existing.id,
      nextRevision,
      nextPayload,
    );
    const nextSendAt = this.resolveNextSendAt(nextPayload);
    const hasFutureSend = nextSendAt !== null;
    const nextStatus =
      requestedStatus === ManagedAutopostRuleStatus.ACTIVE && !hasFutureSend
        ? ManagedAutopostRuleStatus.COMPLETED
        : requestedStatus;
    const statusChanged = request.status !== undefined && request.status !== existing.status;
    const data: Prisma.ManagedAutopostRuleUpdateInput = {
      ...(request.title !== undefined ? { title: request.title } : {}),
      actorUserId: user.userId,
      ...(payloadChanged
        ? {
            payload: nextPayload as Prisma.InputJsonValue,
            revision: { increment: 1 },
            lastError: null,
          }
        : {}),
      status: nextStatus,
      nextMaterializeAt: this.isMaterializableStatus(nextStatus)
        ? (nextMaterializeAt ?? this.resolveCompletionCheckAt(nextSendAt))
        : null,
      lockedAt: null,
      lockToken: null,
    };
    const requiresFutureCancellation =
      nextStatus === ManagedAutopostRuleStatus.PAUSED ||
      nextStatus === ManagedAutopostRuleStatus.DISABLED ||
      payloadChanged;
    const editLockToken = requiresFutureCancellation
      ? await this.claimRuleEditLock(existing.id)
      : null;

    try {
      if (requiresFutureCancellation) {
        await this.cancelFutureMaterializedBroadcasts(existing.id, user, entityType);
      }

      const updated = await this.prisma.$transaction(async (tx) => {
        const staleLockBefore = new Date(Date.now() - AUTOSCHEDULE_LOCK_STALE_MS);
        const result = await tx.managedAutopostRule.updateMany({
          where: editLockToken
            ? { id: existing.id, lockToken: editLockToken }
            : {
                id: existing.id,
                OR: [{ lockedAt: null }, { lockedAt: { lt: staleLockBefore } }],
              },
          data,
        });
        if (result.count === 0) {
          throw new ServiceUnavailableException('Автопост обновляется. Повторите позже.');
        }
        const row = await tx.managedAutopostRule.findUnique({
          where: { id: existing.id },
          include: { _count: { select: { materializations: true } } },
        });
        if (!row) {
          throw new BadRequestException('Автопост не найден.');
        }
        return row;
      });

      await this.prisma.auditLog.create({
        data: {
          chatId: sourceChatId,
          actorUserId: user.userId,
          action: 'UPDATE_AUTOPOST_RULE',
          payload: {
            ruleId: updated.id,
            entityType,
            status: updated.status,
            payloadChanged,
            statusChanged,
          },
        },
      });

      return this.getRuleForEntity(sourceChatId, updated.id, entityType);
    } catch (error: unknown) {
      if (editLockToken) {
        await this.releaseRuleEditLock(existing.id, editLockToken);
      }
      throw error;
    }
  }

  private async disableRuleForEntity(
    sourceChatId: string,
    ruleId: string,
    user: AuthUser,
    entityType: ManagedEntityType,
  ): Promise<ManagedAutopostRuleDetails> {
    const existing = await this.getPersistedRule(sourceChatId, ruleId, entityType);
    this.assertRuleEditable(existing);
    const editLockToken = await this.claimRuleEditLock(existing.id);

    try {
      await this.cancelFutureMaterializedBroadcasts(existing.id, user, entityType);
      const disabled = await this.prisma.$transaction(async (tx) => {
        const result = await tx.managedAutopostRule.updateMany({
          where: { id: existing.id, lockToken: editLockToken },
          data: {
            status: ManagedAutopostRuleStatus.DISABLED,
            nextMaterializeAt: null,
            lockedAt: null,
            lockToken: null,
          },
        });
        if (result.count === 0) {
          throw new ServiceUnavailableException('Автопост обновляется. Повторите позже.');
        }
        const row = await tx.managedAutopostRule.findUnique({
          where: { id: existing.id },
          include: { _count: { select: { materializations: true } } },
        });
        if (!row) {
          throw new BadRequestException('Автопост не найден.');
        }
        return row;
      });
      await this.prisma.auditLog.create({
        data: {
          chatId: sourceChatId,
          actorUserId: user.userId,
          action: 'DELETE_AUTOPOST_RULE',
          payload: {
            ruleId: disabled.id,
            entityType,
          },
        },
      });
      return this.mapRuleDetails(disabled, entityType);
    } catch (error: unknown) {
      await this.releaseRuleEditLock(existing.id, editLockToken);
      throw error;
    }
  }

  private async materializeRule(
    ruleId: string,
    reason: MaterializeReason,
    staleLockBefore: Date,
  ): Promise<void> {
    const lockToken = randomUUID();
    const lockedAt = new Date();
    const claim = await this.prisma.managedAutopostRule.updateMany({
      where: {
        id: ruleId,
        status: { in: [ManagedAutopostRuleStatus.ACTIVE, ManagedAutopostRuleStatus.ERROR] },
        OR: [{ lockedAt: null }, { lockedAt: { lt: staleLockBefore } }],
      },
      data: {
        lockedAt,
        lockToken,
      },
    });
    if (claim.count === 0) {
      return;
    }

    let claimedRevision: number | null = null;
    try {
      const row = await this.prisma.managedAutopostRule.findUnique({
        where: { id: ruleId },
      });
      if (!row || !this.isMaterializableStatus(row.status)) {
        return;
      }

      claimedRevision = row.revision;
      const entityType = this.fromPrismaEntityType(row.entityType);
      const payload = this.parsePayload(row.payload);
      const slots = this.selectMaterializationSlots(payload);
      let createdCount = 0;

      for (const scheduledAt of slots) {
        const materialized = await this.materializeSlot(
          row.id,
          row.revision,
          lockToken,
          payload,
          entityType,
          scheduledAt,
        );
        if (materialized) {
          createdCount += 1;
        }
      }

      const latest = await this.prisma.managedAutopostRule.findUnique({
        where: { id: ruleId },
        select: { status: true },
      });
      if (!latest || !this.isMaterializableStatus(latest.status)) {
        return;
      }

      const hasMissedFailedSlot = await this.hasMissedFailedMaterialization(
        row.id,
        row.revision,
        payload,
      );
      const nextMaterializeAt = await this.resolveNextMaterializeAtForRule(
        row.id,
        row.revision,
        payload,
      );
      const nextSendAt = this.resolveNextSendAt(payload);
      const nextStatus = hasMissedFailedSlot
        ? ManagedAutopostRuleStatus.ERROR
        : nextSendAt
          ? ManagedAutopostRuleStatus.ACTIVE
          : ManagedAutopostRuleStatus.COMPLETED;
      await this.prisma.managedAutopostRule.updateMany({
        where: { id: ruleId, revision: row.revision, lockToken },
        data: {
          status: nextStatus,
          nextMaterializeAt: this.isMaterializableStatus(nextStatus)
            ? (nextMaterializeAt ?? this.resolveCompletionCheckAt(nextSendAt))
            : null,
          lastMaterializedAt: createdCount > 0 ? new Date() : undefined,
          lastError: hasMissedFailedSlot
            ? 'Не удалось создать отправку автопоста: время уже прошло.'
            : null,
          lockedAt: null,
          lockToken: null,
        },
      });
    } catch (error: unknown) {
      const message = this.normalizeError(error);
      this.logger.warn(
        {
          ruleId,
          reason,
          err: message,
        },
        'Failed to materialize autopost rule',
      );
      if (claimedRevision !== null) {
        await this.prisma.managedAutopostRule.updateMany({
          where: { id: ruleId, revision: claimedRevision, lockToken },
          data: {
            status: ManagedAutopostRuleStatus.ERROR,
            nextMaterializeAt: new Date(Date.now() + AUTOSCHEDULE_RETRY_MS),
            lastError: message,
            lockedAt: null,
            lockToken: null,
          },
        });
      }
    } finally {
      await this.prisma.managedAutopostRule.updateMany({
        where: { id: ruleId, lockToken },
        data: {
          lockedAt: null,
          lockToken: null,
        },
      });
    }
  }

  private async materializeSlot(
    ruleId: string,
    revision: number,
    lockToken: string,
    payload: ManagedAutopostPayload,
    entityType: ManagedEntityType,
    scheduledAt: Date,
  ): Promise<boolean> {
    const currentRule = await this.prisma.managedAutopostRule.findFirst({
      where: {
        id: ruleId,
        revision,
        lockToken,
        status: { in: [ManagedAutopostRuleStatus.ACTIVE, ManagedAutopostRuleStatus.ERROR] },
      },
    });
    if (!currentRule) {
      return false;
    }

    const stalePendingBefore = new Date(Date.now() - AUTOSCHEDULE_MATERIALIZATION_STALE_MS);
    await this.prisma.managedAutopostMaterialization.updateMany({
      where: {
        ruleId,
        revision,
        scheduledAt,
        status: ManagedAutopostMaterializationStatus.PENDING,
        updatedAt: { lt: stalePendingBefore },
      },
      data: {
        status: ManagedAutopostMaterializationStatus.FAILED,
        lastError: 'Материализация не завершилась.',
      },
    });

    const existing = await this.prisma.managedAutopostMaterialization.findFirst({
      where: {
        ruleId,
        revision,
        scheduledAt,
      },
      orderBy: [{ createdAt: 'desc' }],
      select: { id: true, requestId: true, attempt: true, status: true },
    });

    if (
      existing?.status === ManagedAutopostMaterializationStatus.PENDING ||
      existing?.status === ManagedAutopostMaterializationStatus.CREATED
    ) {
      return false;
    }

    const nextAttempt =
      existing?.status === ManagedAutopostMaterializationStatus.FAILED
        ? existing.attempt
        : (existing?.attempt ?? 0) + 1;
    const requestId =
      existing?.status === ManagedAutopostMaterializationStatus.FAILED
        ? existing.requestId
        : this.buildMaterializationRequestId(ruleId, revision, scheduledAt, nextAttempt);
    const slotIso = scheduledAt.toISOString();
    let ledgerId: string | null = null;

    try {
      if (existing?.status === ManagedAutopostMaterializationStatus.FAILED) {
        const updated = await this.prisma.managedAutopostMaterialization.updateMany({
          where: {
            id: existing.id,
            status: ManagedAutopostMaterializationStatus.FAILED,
          },
          data: {
            status: ManagedAutopostMaterializationStatus.PENDING,
            lastError: null,
          },
        });
        if (updated.count === 0) {
          return false;
        }
        ledgerId = existing.id;
      } else {
        const ledger = await this.prisma.managedAutopostMaterialization.create({
          data: {
            ruleId,
            revision,
            attempt: nextAttempt,
            requestId,
            scheduledAt,
            status: ManagedAutopostMaterializationStatus.PENDING,
          },
          select: { id: true },
        });
        ledgerId = ledger.id;
      }
    } catch (error: unknown) {
      if (isPrismaKnownError(error, 'P2002')) {
        return false;
      }
      throw error;
    }

    const broadcastPayload: SendBroadcastRequest = {
      ...payload,
      requestId,
      scheduleMode: 'calendar',
      scheduledSlots: [slotIso],
      replaceConflictingSlots: false,
      sendAt: null,
      cycleEnabled: false,
      cycleEveryHours: 1,
      cycleCount: 1,
    };
    const user: AuthUser = {
      userId: currentRule.actorUserId,
      username: null,
      displayName: null,
      chatTitle: null,
    };

    try {
      const result =
        entityType === 'channel'
          ? await this.managedBroadcastService.sendChannelBroadcast(
              currentRule.sourceChatId,
              user,
              broadcastPayload,
              'autopost_rule',
            )
          : await this.managedBroadcastService.sendBroadcast(
              currentRule.sourceChatId,
              user,
              broadcastPayload,
              'autopost_rule',
            );
      if (!result.scheduleId) {
        throw new Error('Материализация автопоста не создала расписание.');
      }
      await this.prisma.managedAutopostMaterialization.update({
        where: { id: ledgerId },
        data: {
          broadcastId: result.scheduleId,
          status: ManagedAutopostMaterializationStatus.CREATED,
          lastError: null,
        },
      });
      return true;
    } catch (error: unknown) {
      const message = this.normalizeError(error);
      await this.prisma.managedAutopostMaterialization.update({
        where: { id: ledgerId },
        data: {
          status: ManagedAutopostMaterializationStatus.FAILED,
          lastError: message,
        },
      });
      throw error;
    }
  }

  private async cancelFutureMaterializedBroadcasts(
    ruleId: string,
    user: AuthUser,
    entityType: ManagedEntityType,
  ): Promise<void> {
    const materializations = await this.prisma.managedAutopostMaterialization.findMany({
      where: {
        ruleId,
        status: ManagedAutopostMaterializationStatus.CREATED,
        broadcastId: { not: null },
        broadcast: {
          nextSendAt: { not: null },
          status: {
            in: [
              ManagedBroadcastStatus.ACTIVE,
              ManagedBroadcastStatus.PARTIAL,
              ManagedBroadcastStatus.FAILED,
            ],
          },
        },
      },
      include: { broadcast: { select: { sourceChatId: true } } },
      orderBy: { scheduledAt: 'asc' },
    });

    const failedBroadcastIds: string[] = [];
    for (const materialization of materializations) {
      if (!materialization.broadcastId || !materialization.broadcast) {
        continue;
      }
      try {
        if (entityType === 'channel') {
          await this.managedBroadcastService.cancelChannelManagedBroadcast(
            materialization.broadcast.sourceChatId,
            materialization.broadcastId,
            user,
          );
        } else {
          await this.managedBroadcastService.cancelManagedBroadcast(
            materialization.broadcast.sourceChatId,
            materialization.broadcastId,
            user,
          );
        }
        await this.prisma.managedAutopostMaterialization.update({
          where: { id: materialization.id },
          data: { status: ManagedAutopostMaterializationStatus.CANCELED },
        });
      } catch (error: unknown) {
        failedBroadcastIds.push(materialization.broadcastId);
        this.logger.warn(
          {
            ruleId,
            broadcastId: materialization.broadcastId,
            err: this.normalizeError(error),
          },
          'Failed to cancel materialized autopost broadcast',
        );
      }
    }

    if (failedBroadcastIds.length > 0) {
      throw new ServiceUnavailableException('Не удалось снять будущие отправки автопоста.');
    }
  }

  private async getPersistedRule(
    sourceChatId: string,
    ruleId: string,
    entityType: ManagedEntityType,
  ): Promise<PersistedManagedAutopostRule> {
    const row = await this.prisma.managedAutopostRule.findFirst({
      where: {
        id: ruleId,
        sourceChatId,
        entityType: mapManagedEntityTypeToChatEntityType(entityType),
        status: { not: ManagedAutopostRuleStatus.DISABLED },
      },
    });
    if (!row) {
      throw new BadRequestException('Автопост не найден.');
    }
    return row;
  }

  private async claimRuleEditLock(ruleId: string): Promise<string> {
    const lockToken = `edit_${randomUUID()}`;
    const staleLockBefore = new Date(Date.now() - AUTOSCHEDULE_LOCK_STALE_MS);
    const result = await this.prisma.managedAutopostRule.updateMany({
      where: {
        id: ruleId,
        OR: [{ lockedAt: null }, { lockedAt: { lt: staleLockBefore } }],
      },
      data: {
        lockedAt: new Date(),
        lockToken,
      },
    });
    if (result.count === 0) {
      throw new ServiceUnavailableException('Автопост обновляется. Повторите позже.');
    }
    return lockToken;
  }

  private async releaseRuleEditLock(ruleId: string, lockToken: string): Promise<void> {
    await this.prisma.managedAutopostRule.updateMany({
      where: { id: ruleId, lockToken },
      data: {
        lockedAt: null,
        lockToken: null,
      },
    });
  }

  private assertRuleEditable(row: PersistedManagedAutopostRule): void {
    if (
      row.lockedAt &&
      row.lockedAt.getTime() >= Date.now() - AUTOSCHEDULE_LOCK_STALE_MS
    ) {
      throw new ServiceUnavailableException('Автопост обновляется. Повторите позже.');
    }
  }

  private async assertPayloadTargets(
    sourceChatId: string,
    user: AuthUser,
    payload: ManagedAutopostPayload,
    entityType: ManagedEntityType,
  ): Promise<void> {
    if (payload.targetMode === 'current') {
      return;
    }

    if (entityType === 'channel') {
      throw new BadRequestException('Для каналов доступен только текущий канал.');
    }

    const availableChats = await this.managedEntitiesService.listChats(user, {
      fresh: false,
    });
    const allowedTargetIds = new Set([
      sourceChatId,
      ...availableChats.filter((chat) => chat.entityType === 'chat').map((chat) => chat.id),
    ]);
    if (payload.targetMode === 'all') {
      if (allowedTargetIds.size === 0) {
        throw new BadRequestException('Нет доступных чатов.');
      }
      return;
    }

    const invalidTargetChatIds = payload.targetChatIds.filter(
      (chatId) => !allowedTargetIds.has(chatId),
    );
    if (invalidTargetChatIds.length > 0) {
      throw new BadRequestException('Обновите выбор чатов.');
    }
  }

  private assertAutopostSlots(payload: ManagedAutopostPayload): void {
    const now = Date.now();
    const slots = payload.scheduledSlots
      .map((value) => new Date(value))
      .filter((slot) => Number.isFinite(slot.getTime()))
      .sort((left, right) => left.getTime() - right.getTime());
    const nextSlot = slots.find((slot) => slot.getTime() > now);
    if (!nextSlot) {
      throw new BadRequestException('Добавьте будущее время.');
    }
    if (nextSlot.getTime() - now < AUTOSCHEDULE_MIN_RULE_SLOT_DELAY_MS) {
      throw new BadRequestException('Ближайшее время должно быть минимум через 2 минуты.');
    }
  }

  private selectMaterializationSlots(payload: ManagedAutopostPayload): Date[] {
    const nowMs = Date.now();
    const horizonMs = nowMs + AUTOSCHEDULE_HORIZON_DAYS * 24 * 60 * 60_000;
    return payload.scheduledSlots
      .map((value) => new Date(value))
      .filter(
        (slot) =>
          Number.isFinite(slot.getTime()) &&
          slot.getTime() - nowMs >= AUTOSCHEDULE_MIN_DELAY_MS &&
          slot.getTime() <= horizonMs,
      )
      .sort((left, right) => left.getTime() - right.getTime());
  }

  private async hasMissedFailedMaterialization(
    ruleId: string,
    revision: number,
    payload: ManagedAutopostPayload,
  ): Promise<boolean> {
    const payloadSlotKeys = new Set(
      payload.scheduledSlots
        .map((value) => new Date(value))
        .filter((slot) => Number.isFinite(slot.getTime()))
        .map((slot) => slot.toISOString()),
    );
    if (payloadSlotKeys.size === 0) {
      return false;
    }

    const failedRows = await this.prisma.managedAutopostMaterialization.findMany({
      where: {
        ruleId,
        revision,
        status: ManagedAutopostMaterializationStatus.FAILED,
        scheduledAt: { lt: new Date(Date.now() + AUTOSCHEDULE_MIN_DELAY_MS) },
      },
      select: { scheduledAt: true },
    });

    return failedRows.some((row) => payloadSlotKeys.has(row.scheduledAt.toISOString()));
  }

  private resolveNextMaterializeAt(payload: ManagedAutopostPayload): Date | null {
    return this.resolveNextMaterializeAtFromSlots(payload.scheduledSlots);
  }

  private async resolveNextMaterializeAtForRule(
    ruleId: string,
    revision: number,
    payload: ManagedAutopostPayload,
  ): Promise<Date | null> {
    const stalePendingBefore = new Date(Date.now() - AUTOSCHEDULE_MATERIALIZATION_STALE_MS);
    const materializations = await this.prisma.managedAutopostMaterialization.findMany({
      where: {
        ruleId,
        revision,
        OR: [
          { status: ManagedAutopostMaterializationStatus.CREATED },
          {
            status: ManagedAutopostMaterializationStatus.PENDING,
            updatedAt: { gte: stalePendingBefore },
          },
        ],
      },
      select: { scheduledAt: true },
    });
    const materializedSlotKeys = new Set(
      materializations.map((materialization) => materialization.scheduledAt.toISOString()),
    );
    return this.resolveNextMaterializeAtFromSlots(
      payload.scheduledSlots.filter((slot) => {
        const parsed = new Date(slot);
        return (
          Number.isFinite(parsed.getTime()) && !materializedSlotKeys.has(parsed.toISOString())
        );
      }),
    );
  }

  private resolveNextMaterializeAtFromSlots(slotsInput: readonly string[]): Date | null {
    const slots = slotsInput
      .map((value) => new Date(value))
      .filter((slot) => Number.isFinite(slot.getTime()))
      .sort((left, right) => left.getTime() - right.getTime());
    const now = Date.now();
    const nextSlot = slots.find((slot) => slot.getTime() - now >= AUTOSCHEDULE_MIN_DELAY_MS);
    if (!nextSlot) {
      return null;
    }

    const materializeAtMs =
      nextSlot.getTime() - AUTOSCHEDULE_HORIZON_DAYS * 24 * 60 * 60_000;
    return new Date(Math.max(now, materializeAtMs));
  }

  private resolveCompletionCheckAt(nextSendAt: Date | null): Date | null {
    if (!nextSendAt) {
      return null;
    }
    return new Date(nextSendAt.getTime() + AUTOSCHEDULE_MIN_DELAY_MS);
  }

  private buildMaterializationRequestId(
    ruleId: string,
    revision: number,
    scheduledAt: Date,
    attempt: number,
  ): string {
    const slotKey = scheduledAt
      .toISOString()
      .replace(/[-:.]/gu, '')
      .replace(/Z$/u, '');
    return `ap_${ruleId.replace(/[^A-Za-z0-9_-]/gu, '').slice(0, 40)}_${revision}_${slotKey}_${attempt}`.slice(
      0,
      128,
    );
  }

  private parsePayload(value: Prisma.JsonValue): ManagedAutopostPayload {
    return managedAutopostPayloadSchema.parse(value);
  }

  private mapRuleSummary(
    row: ManagedAutopostRuleWithCount,
    entityType: ManagedEntityType,
  ): ManagedAutopostRuleSummary {
    const payload = this.parsePayload(row.payload);
    return managedAutopostRuleSummarySchema.parse({
      id: row.id,
      sourceChatId: row.sourceChatId,
      entityType,
      status: row.status,
      title: row.title,
      textPreview: this.resolveTextPreview(payload),
      textLength: payload.text.length,
      targetMode: payload.targetMode,
      applyToAllChats: payload.applyToAllChats,
      targetChatIds: payload.targetChatIds,
      targetChats: Math.max(1, payload.targetChatIds.length),
      hasImage: payload.images.length > 0 || payload.imageEnabled,
      imageCount: payload.images.length || (payload.imageEnabled ? 1 : 0),
      hasVideo: payload.mediaType === 'video',
      buttons: payload.buttons,
      scheduleTimezone: payload.scheduleTimezone,
      scheduledSlots: payload.scheduledSlots,
      nextSendAt: this.resolveNextSendAt(payload)?.toISOString() ?? null,
      materializedCount: row._count?.materializations ?? 0,
      revision: row.revision,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      lastError: row.lastError && row.lastError.trim() ? row.lastError : null,
    });
  }

  private mapRuleDetails(
    row: ManagedAutopostRuleWithCount,
    entityType: ManagedEntityType,
  ): ManagedAutopostRuleDetails {
    const summary = this.mapRuleSummary(row, entityType);
    return managedAutopostRuleDetailsSchema.parse({
      ...summary,
      payload: this.parsePayload(row.payload),
    });
  }

  private resolveTextPreview(payload: ManagedAutopostPayload): string {
    const normalizedText = payload.text.replace(/\s+/gu, ' ').trim();
    if (normalizedText) {
      return normalizedText.slice(0, 160);
    }
    if (payload.mediaType === 'video') {
      return 'Видео без текста';
    }
    if (payload.images.length > 0 || payload.imageEnabled) {
      return 'Фото без текста';
    }
    return 'Пусто';
  }

  private resolveNextSendAt(payload: ManagedAutopostPayload): Date | null {
    const now = Date.now();
    return (
      payload.scheduledSlots
        .map((value) => new Date(value))
        .filter((slot) => Number.isFinite(slot.getTime()) && slot.getTime() > now)
        .sort((left, right) => left.getTime() - right.getTime())[0] ?? null
    );
  }

  private isMaterializableStatus(
    status: ManagedAutopostRuleStatus,
  ): status is MaterializableRuleStatus {
    return (
      status === ManagedAutopostRuleStatus.ACTIVE ||
      status === ManagedAutopostRuleStatus.ERROR
    );
  }

  private fromPrismaEntityType(value: ChatEntityType): ManagedEntityType {
    return value === ChatEntityType.CHANNEL ? 'channel' : 'chat';
  }

  private normalizeError(error: unknown): string {
    if (error instanceof BadRequestException) {
      const response = error.getResponse();
      if (typeof response === 'string') {
        return response;
      }
      if (response && typeof response === 'object') {
        const message = (response as { message?: unknown }).message;
        if (typeof message === 'string') {
          return message;
        }
        if (Array.isArray(message)) {
          return message.filter((item): item is string => typeof item === 'string').join(', ');
        }
      }
    }
    return error instanceof Error && error.message.trim() ? error.message : String(error);
  }

  private async resolveBackgroundDecision(
    reason: MaterializeReason,
  ): Promise<'run' | 'slow' | 'pause'> {
    const decision = await this.backgroundRuntimeGovernorService.decide({
      component: 'managed-autopost-materializer',
      sourceTag: MAX_API_SOURCE_TAGS.MANAGED_BROADCAST,
    });
    if (decision.action !== 'run') {
      this.logThrottle(reason, decision.reason);
      return decision.action;
    }

    const snapshot = await this.systemModeService.getSnapshot();
    if (snapshot.mode === 'degrade' && !isSystemModeRecoveryWindow(snapshot)) {
      this.logThrottle(reason, snapshot.reason);
      return 'pause';
    }

    return 'run';
  }

  private logThrottle(reason: MaterializeReason, details: string): void {
    const now = Date.now();
    if (now - this.throttleLogAtMs < AUTOSCHEDULE_RETRY_MS) {
      return;
    }
    this.throttleLogAtMs = now;
    this.logger.log(
      {
        reason,
        details,
      },
      'Paused managed autopost materializer',
    );
  }
}
