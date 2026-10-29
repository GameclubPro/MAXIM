import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { publicationActionRequestSchema } from '@maxim/contracts/publication';
import { Prisma } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import {
  publicationAdminAccessWhere,
  publicationAdminTargetWhere,
  type PublicationAdminScope,
} from './publication-admin-access';
import { isPrismaKnownError } from './admin-legacy-utils';
import { buildUnsafePublicationExecutionDeliveryWhere } from './publication-execution-safety';

export const PUBLISHER_TARGET_CANCELED = 'PUBLISHER_TARGET_CANCELED';

export async function tryCancelAccessiblePublicationTargets(
  prisma: PrismaService,
  scope: PublicationAdminScope,
  publicationId: string,
  body: unknown,
  hashRequest: (value: unknown) => string,
  findReplay: (requestId: string, hash: string) => Promise<{ publicationId: string } | null>,
): Promise<boolean> {
  const manageable = await prisma.publication.findFirst({
    where: { id: publicationId, ...publicationAdminAccessWhere(scope, 'PUBLIK_V1', 'manage') },
    select: { id: true },
  });
  if (manageable) return false;
  const parsed = publicationActionRequestSchema.safeParse(body);
  if (!parsed.success) throw new BadRequestException(parsed.error.format());
  const publication = await prisma.publication.findFirst({
    where: { id: publicationId, ...publicationAdminAccessWhere(scope, 'PUBLIK_V1') },
    select: {
      targets: { where: publicationAdminTargetWhere(scope), select: { targetChatId: true } },
    },
  });
  if (!publication) throw new NotFoundException('Публикация не найдена.');
  const requestHash = hashRequest({ publicationId, action: 'cancel', ...parsed.data });
  const replayed = async () => {
    const record = await findReplay(parsed.data.requestId, requestHash);
    if (record && record.publicationId !== publicationId)
      throw new BadRequestException('Ключ повтора относится к другой публикации.');
    return Boolean(record);
  };
  if (await replayed()) return true;
  try {
    await cancelAccessiblePublicationTargets(prisma, scope, {
      publicationId,
      ...parsed.data,
      requestHash,
      targetChatIds: publication.targets.map((target) => target.targetChatId),
    });
  } catch (error: unknown) {
    if (
      (isPrismaKnownError(error, 'P2002') || error instanceof ConflictException) &&
      (await replayed())
    )
      return true;
    throw error;
  }
  return true;
}

export function untouchedPublicationTargetDeliveryWhere(): Prisma.ManagedBroadcastDeliveryWhereInput {
  return {
    dispatchProfile: 'PUBLIK_V1',
    status: 'PENDING',
    attemptCount: 0,
    lockedAt: null,
    lockToken: null,
    remoteMessageId: null,
    sentAt: null,
    legacySentWithoutRemoteId: false,
    remoteMessageVerifiedAt: null,
    remoteMessageVerificationAttemptedAt: null,
    remoteMessageVerificationAttemptCount: 0,
  };
}

export async function cancelAccessiblePublicationTargets(
  prisma: PrismaService,
  scope: PublicationAdminScope,
  request: {
    publicationId: string;
    expectedRevision: number;
    requestId: string;
    requestHash: string;
    targetChatIds: string[];
  },
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw(
      Prisma.sql`SELECT pg_advisory_xact_lock(hashtext('publication-calendar'))`,
    );
    const targetWhere = {
      publicationId: request.publicationId,
      targetChatId: { in: request.targetChatIds },
      ...publicationAdminTargetWhere(scope),
    } satisfies Prisma.PublicationTargetWhereInput;
    // FLAG: A partial administrator can stop only their saved recipients. Reauthorize
    // every recipient in the write transaction; no foreign schedule or receipt is reset.
    const authorized = await tx.publicationTarget.findMany({
      where: targetWhere,
      select: { id: true, canceledAt: true },
    });
    if (!authorized.length || authorized.length !== request.targetChatIds.length)
      throw new NotFoundException('Публикация не найдена.');
    const updated = await tx.publication.updateMany({
      where: {
        id: request.publicationId,
        ...publicationAdminAccessWhere(scope, 'PUBLIK_V1'),
        version: request.expectedRevision,
        lifecycle: { notIn: ['CANCELED', 'COMPLETED'] },
      },
      data: { version: { increment: 1 } },
    });
    if (updated.count !== 1)
      throw new ConflictException({
        code: 'PUBLICATION_REVISION_CONFLICT',
        message: 'Публикация уже изменена. Обновите экран.',
      });
    const canceled = await tx.publicationTarget.updateMany({
      where: { ...targetWhere, canceledAt: null },
      data: { canceledAt: new Date() },
    });
    if (canceled.count !== authorized.filter((target) => target.canceledAt === null).length)
      throw new NotFoundException('Публикация не найдена.');
    await tx.managedBroadcastDelivery.updateMany({
      where: {
        publicationOccurrence: { is: { publicationId: request.publicationId } },
        targetChatId: { in: request.targetChatIds },
        ...untouchedPublicationTargetDeliveryWhere(),
      },
      data: { status: 'CANCELED' },
    });
    for (const targetChatId of request.targetChatIds) {
      await tx.managedBroadcastCalendarReservation.deleteMany({
        where: {
          targetChatId,
          broadcast: {
            is: {
              publicationOccurrence: { is: { publicationId: request.publicationId } },
              deliveries: {
                none: {
                  targetChatId,
                  OR: [
                    ...buildUnsafePublicationExecutionDeliveryWhere().OR,
                    { lockToken: { not: null } },
                    { remoteMessageId: { not: null } },
                    { sentAt: { not: null } },
                    { legacySentWithoutRemoteId: true },
                  ],
                },
              },
            },
          },
        },
      });
    }
    if (
      (await tx.publicationTarget.count({
        where: { publicationId: request.publicationId, canceledAt: null },
      })) === 0
    ) {
      await tx.publication.update({
        where: { id: request.publicationId },
        data: { lifecycle: 'CANCELED' },
      });
      await tx.publicationSchedule.updateMany({
        where: { publicationId: request.publicationId },
        data: { status: 'CANCELED', nextMaterializeAt: null },
      });
    }
    await tx.publicationMutationRecord.create({
      data: {
        actorUserId: scope.actorUserId,
        requestId: request.requestId,
        requestHash: request.requestHash,
        publicationId: request.publicationId,
        resultingVersion: request.expectedRevision + 1,
      },
    });
  });
}
