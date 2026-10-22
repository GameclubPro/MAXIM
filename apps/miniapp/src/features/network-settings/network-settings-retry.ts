import type { NetworkSettingsOperationReceipt } from '../../lib/network-settings-operation-storage';

export function networkSettingsRetryCandidates(
  failedRecipients: readonly string[],
  parent: Pick<
    NetworkSettingsOperationReceipt,
    'operationId' | 'userId' | 'entityType' | 'section'
  >,
  receipts: readonly NetworkSettingsOperationReceipt[],
): string[] {
  // FLAG: A linked retry owns its exact recipients, including prepared and uncertain states.
  // Continue its own receipt; never re-dispatch those recipients from the parent operation.
  const original = receipts.find(
    (receipt) =>
      receipt.operationId === parent.operationId &&
      receipt.userId === parent.userId &&
      receipt.entityType === parent.entityType &&
      receipt.section === parent.section,
  );
  if (!original) return [];
  const assigned = new Set([
    ...(original.retriedRecipientIds ?? []),
    ...receipts
      .filter(
        (receipt) =>
          receipt.retryOfOperationId === parent.operationId &&
          receipt.userId === parent.userId &&
          receipt.entityType === parent.entityType &&
          receipt.section === parent.section,
      )
      .flatMap((receipt) => receipt.recipientIds ?? []),
  ]);
  return [...new Set(failedRecipients)].filter((id) => !assigned.has(id));
}
