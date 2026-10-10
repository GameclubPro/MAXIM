import { Prisma, type WebhookEvent, type WebhookStatus } from '../prisma/prisma-client';

export type WebhookEnqueueSnapshot = Pick<
  WebhookEvent,
  | 'id'
  | 'status'
  | 'queueName'
  | 'enqueueAttempts'
  | 'queuedAt'
  | 'nextEnqueueAt'
  | 'timeoutQuarantineExpiresAt'
  | 'errorMessage'
>;

export type WebhookEnqueueWrite = {
  status: WebhookStatus;
  queueName?: string | null;
  queuedAt?: Date | null;
  nextEnqueueAt: Date | null;
  timeoutQuarantineExpiresAt: null;
  errorMessage: string | null;
  processedAt?: Date;
  enqueueAttempts?: { increment: number };
};

// FLAG: One UPDATE is already atomic in PostgreSQL. Retain every snapshot field in
// the CAS, including nulls; do not add BEGIN/COMMIT round trips for this single write.
export async function writeWebhookEnqueueState(
  client: Pick<Prisma.TransactionClient, '$executeRaw'>,
  event: WebhookEnqueueSnapshot,
  data: WebhookEnqueueWrite,
): Promise<{ count: number }> {
  const assignments = [
    Prisma.sql`status = ${data.status}::"WebhookStatus"`,
    Prisma.sql`next_enqueue_at = ${data.nextEnqueueAt}`,
    Prisma.sql`timeout_quarantine_expires_at = ${data.timeoutQuarantineExpiresAt}`,
    Prisma.sql`error_message = ${data.errorMessage}`,
  ];
  if (data.queueName !== undefined) assignments.push(Prisma.sql`queue_name = ${data.queueName}`);
  if (data.queuedAt !== undefined) assignments.push(Prisma.sql`queued_at = ${data.queuedAt}`);
  if (data.processedAt !== undefined)
    assignments.push(Prisma.sql`processed_at = ${data.processedAt}`);
  if (data.enqueueAttempts !== undefined)
    assignments.push(
      Prisma.sql`enqueue_attempts = enqueue_attempts + ${data.enqueueAttempts.increment}`,
    );
  const count = await client.$executeRaw(Prisma.sql`
    UPDATE webhook_events SET ${Prisma.join(assignments)}
    WHERE id = ${event.id} AND status = ${event.status}::"WebhookStatus"
      AND queue_name IS NOT DISTINCT FROM ${event.queueName}
      AND enqueue_attempts = ${event.enqueueAttempts}
      AND queued_at IS NOT DISTINCT FROM ${event.queuedAt}
      AND next_enqueue_at IS NOT DISTINCT FROM ${event.nextEnqueueAt}
      AND timeout_quarantine_expires_at IS NOT DISTINCT FROM ${event.timeoutQuarantineExpiresAt}
      AND error_message IS NOT DISTINCT FROM ${event.errorMessage}
  `);
  return { count };
}
