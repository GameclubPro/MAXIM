import {
  MAX_PUBLICATION_DELETE_AFTER_MINUTES,
  type PublicationPostActionRequest,
} from '@maxim/contracts/publication';
import { publicationPostActionRequestSchema } from '@maxim/contracts/publication-post-action-request';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import { type ManagedBroadcastDelivery, type Prisma } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { PublisherPolicyService } from './publisher-policy.service';
import {
  allowedPublicationPostActions,
  mapPublicationPostActions,
  publicationPostActionsVersion,
} from './publication-post-actions';

export function buildPublicationPostActionChange(
  row: ManagedBroadcastDelivery,
  request: PublicationPostActionRequest,
  policy: unknown,
  now = new Date(),
): Prisma.ManagedBroadcastDeliveryUpdateManyMutationInput {
  if (!allowedPublicationPostActions(row, policy, now.getTime()).includes(request.action)) {
    throw new ConflictException('Действие уже выполняется или больше недоступно. Обновите пост.');
  }
  const data: Prisma.ManagedBroadcastDeliveryUpdateManyMutationInput = { postActionsToken: null };
  const wakeAt = new Date(
    now.getTime() === row.postActionsNextAt?.getTime() ? now.getTime() - 1 : now.getTime(),
  );
  if (request.action === 'reschedule_delete') {
    const deleteAt = new Date(request.deleteAt);
    const remaining = deleteAt.getTime() - now.getTime();
    if (remaining < 30_000 || remaining > MAX_PUBLICATION_DELETE_AFTER_MINUTES * 60_000) {
      throw new BadRequestException('Выберите время удаления от 30 секунд до 30 дней в будущем.');
    }
    Object.assign(data, {
      deleteAt,
      deleteStatus: 'PENDING',
      deleteAttemptCount: 0,
      deleteError: null,
      postActionsNextAt: row.pinStatus === 'PENDING' ? wakeAt : deleteAt,
    });
  } else if (request.action === 'cancel_delete') {
    // FLAG: Keep the historical deadline so an older worker cannot re-enroll deletion from
    // the content policy. A distinct wake timestamp also fences its pre-claim snapshot.
    Object.assign(data, {
      deleteStatus: 'SKIPPED',
      deleteError: null,
      postActionsNextAt: row.pinStatus === 'PENDING' ? wakeAt : null,
    });
  } else if (request.action === 'retry_delete') {
    Object.assign(data, {
      deleteStatus: 'PENDING',
      deleteAttemptCount: 0,
      deleteError: null,
      postActionsNextAt: now,
    });
  } else {
    Object.assign(data, {
      pinStatus: 'PENDING',
      pinAttemptCount: 0,
      pinError: null,
      postActionsNextAt: now,
    });
  }
  return data;
}

@Injectable()
export class PublicationPostActionCommandsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly policy: PublisherPolicyService,
  ) {}

  async execute(publicationId: string, deliveryId: string, user: AuthUser, body: unknown) {
    const parsed = publicationPostActionRequestSchema.safeParse(body);
    if (
      !parsed.success ||
      !publicationId ||
      publicationId.length > 256 ||
      !deliveryId ||
      deliveryId.length > 256
    )
      throw new BadRequestException('Некорректные параметры действия.');
    const request = parsed.data;
    const publication = await this.prisma.publication.findFirst({
      where: { id: publicationId, actorUserId: user.userId, dispatchProfile: 'PUBLIK_V1' },
      select: { id: true, version: true, requiredBotId: true },
    });
    if (!publication) throw new NotFoundException('Публикация не найдена.');
    const where = {
      id: deliveryId,
      dispatchProfile: 'PUBLIK_V1' as const,
      publicationOccurrence: { is: { publicationId } },
    };
    const readDelivery = async () => {
      const row = await this.prisma.managedBroadcastDelivery.findFirst({
        where,
        include: {
          broadcast: { select: { entityType: true } },
          contentRevision: { select: { postPublish: true } },
        },
      });
      if (!row) throw new NotFoundException('Доставка не найдена.');
      return row;
    };
    const row = await readDelivery();
    await this.policy.getEntity(
      row.broadcast.entityType === 'CHANNEL' ? 'channel' : 'chat',
      row.targetChatId,
      user,
    );
    const requestHash = createHash('sha256')
      .update(JSON.stringify({ operation: 'post_action', publicationId, deliveryId, request }))
      .digest('hex');
    const replayWhere = {
      actorUserId_requestId: { actorUserId: user.userId, requestId: request.requestId },
    };
    const isReplay = async () => {
      const replay = await this.prisma.publicationMutationRecord.findUnique({ where: replayWhere });
      if (!replay) return false;
      if (replay.publicationId !== publicationId || replay.requestHash !== requestHash)
        throw new ConflictException('Идентификатор запроса уже использован.');
      return true;
    };
    if (await isReplay()) return mapPublicationPostActions(row, row.contentRevision?.postPublish);
    if (request.expectedVersion !== publicationPostActionsVersion(row))
      throw new ConflictException('Состояние поста изменилось. Обновите его и повторите действие.');
    if (
      !publication.requiredBotId ||
      row.botId !== publication.requiredBotId ||
      row.requiredBotId !== publication.requiredBotId
    )
      throw new ConflictException('Не удалось подтвердить исходный пост.');
    const data = buildPublicationPostActionChange(row, request, row.contentRevision?.postPublish);
    try {
      await this.prisma.$transaction(async (tx) => {
        // FLAG: The command competes with the worker's pre-dispatch lease; never accept an
        // undo after execution starts, and never reset the original send status or receipt.
        const changed = await tx.managedBroadcastDelivery.updateMany({
          where: {
            ...where,
            status: 'SENT',
            updatedAt: row.updatedAt,
            postActionsToken: null,
            pinStatus: row.pinStatus,
            deleteStatus: row.deleteStatus,
            deleteAt: row.deleteAt,
            postActionsNextAt: row.postActionsNextAt,
            remoteMessageId: row.remoteMessageId,
            botId: row.botId,
            requiredBotId: row.requiredBotId,
          },
          data,
        });
        if (!changed.count)
          throw new ConflictException(
            'Действие уже началось или состояние изменилось. Обновите пост.',
          );
        await tx.publicationMutationRecord.create({
          data: {
            actorUserId: user.userId,
            requestId: request.requestId,
            requestHash,
            publicationId,
            resultingVersion: publication.version,
          },
        });
      });
    } catch (error) {
      if (!(await isReplay())) throw error;
    }
    const current = await readDelivery();
    return mapPublicationPostActions(current, current.contentRevision?.postPublish);
  }
}
