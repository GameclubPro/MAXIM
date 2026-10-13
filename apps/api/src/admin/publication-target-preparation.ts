import { measurePublicationStage } from './publication-delivery-timing';
import { publicationButtonSchema, publicationEntityTypeSchema } from '@maxim/contracts/publication';
import type { BroadcastLinkButton, ManagedEntityType } from '@maxim/contracts';
import { ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '../prisma/prisma-client';
import type { AdminManagedBroadcastRuntimeContext } from './admin-managed-broadcast-runtime-context';
import { readPublisherPreparedDialogContext } from './publisher-dialog-context.service';

export function createPendingPublicationContext(
  target: { chatId: string; entityType: ManagedEntityType },
  requiredBotId: string,
  customButtons: readonly BroadcastLinkButton[],
): Prisma.InputJsonObject {
  return {
    version: 0,
    preparation: 'pending',
    chatId: target.chatId,
    entityType: target.entityType,
    dialogBotId: requiredBotId,
    customButtons: customButtons.map(({ text, url }) => ({ text, url })),
  };
}

export function preparePendingPublicationContext(
  context: Pick<AdminManagedBroadcastRuntimeContext, 'prisma' | 'publisherDialogContextService'> &
    Partial<Pick<AdminManagedBroadcastRuntimeContext, 'logger'>>,
  delivery: { id: string; targetChatId: string; publisherDialogContext?: Prisma.JsonValue },
  requiredBotId: string,
): Promise<void> {
  return measurePublicationStage(context.logger, 'target_preparation', () =>
    preparePendingPublicationContextInternal(context, delivery, requiredBotId),
  );
}

async function preparePendingPublicationContextInternal(
  context: Pick<AdminManagedBroadcastRuntimeContext, 'prisma' | 'publisherDialogContextService'>,
  delivery: { id: string; targetChatId: string; publisherDialogContext?: Prisma.JsonValue },
  requiredBotId: string,
): Promise<void> {
  const marker = delivery.publisherDialogContext;
  if (
    !marker ||
    typeof marker !== 'object' ||
    Array.isArray(marker) ||
    marker.version !== 0 ||
    marker.preparation !== 'pending'
  )
    return;
  const entityType = publicationEntityTypeSchema.safeParse(marker.entityType);
  const buttons = publicationButtonSchema.array().max(8).safeParse(marker.customButtons);
  if (
    marker.chatId !== delivery.targetChatId ||
    marker.dialogBotId !== requiredBotId ||
    !entityType.success ||
    !buttons.success ||
    !context.publisherDialogContextService
  )
    throw new ServiceUnavailableException('Publication target preparation unavailable');
  const prepared = await context.publisherDialogContextService.prepare({
    chatId: delivery.targetChatId,
    entityType: entityType.data,
    dialogBotId: requiredBotId,
    customButtons: buttons.data,
    includeManagedDialogs: true,
  });
  // FLAG: Preparation may read metadata but has no external SEND. Only the untouched pending marker may
  // change; a concurrent prepare, cancellation or attempt wins the CAS. The final
  // content/schedule and actor/bot guards remain mandatory before HTTP dispatch.
  const persisted = await context.prisma.managedBroadcastDelivery.updateMany({
    where: {
      id: delivery.id,
      status: 'PENDING',
      attemptCount: 0,
      dispatchProfile: 'PUBLIK_V1',
      requiredBotId,
      publicationOccurrenceId: { not: null },
      publisherDialogContext: { equals: marker },
    },
    data: { publisherDialogContext: prepared as unknown as Prisma.InputJsonValue },
  });
  if (persisted.count !== 1) {
    // FLAG: A preflight winner may have prepared the same untouched delivery. Reuse
    // only its durable context; cancellation/claim never becomes permission to send.
    const winner = await context.prisma.managedBroadcastDelivery.findFirst({
      where: {
        id: delivery.id,
        targetChatId: delivery.targetChatId,
        status: 'PENDING',
        attemptCount: 0,
        dispatchProfile: 'PUBLIK_V1',
        requiredBotId,
        dialogBotId: requiredBotId,
      },
      select: { publisherDialogContext: true },
    });
    if (
      !winner ||
      !readPublisherPreparedDialogContext(winner.publisherDialogContext, requiredBotId)
    )
      throw new ServiceUnavailableException('Publication preparation fence changed');
    delivery.publisherDialogContext = winner.publisherDialogContext;
    return;
  }
  delivery.publisherDialogContext = prepared as unknown as Prisma.JsonValue;
}
