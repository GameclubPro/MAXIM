import { Prisma, WebhookStatus } from '../prisma/prisma-client';

export type OldestPendingWebhook = {
  id: string;
  createdAt: Date;
  nextEnqueueAt: Date | null;
  executionDeadlineAt: Date | null;
};

export function buildOldestPendingWebhookQuery(
  status: typeof WebhookStatus.RECEIVED | typeof WebhookStatus.QUEUED,
): Prisma.Sql {
  if (status !== WebhookStatus.RECEIVED && status !== WebhookStatus.QUEUED) {
    throw new Error('Oldest pending webhook requires a pending status');
  }
  // FLAG: Read one covered (status, created_at, id) index entry before fetching
  // metadata by primary key. A timestamp-only ORM scan can walk retained history
  // after backlog cancellation. Keep literal status estimates and the full order.
  const predicate =
    status === WebhookStatus.RECEIVED
      ? Prisma.sql`status = 'RECEIVED'::"WebhookStatus"`
      : Prisma.sql`status = 'QUEUED'::"WebhookStatus"`;
  return Prisma.sql`
    /* webhook_oldest_pending */
    WITH head AS MATERIALIZED (
      SELECT id, created_at
      FROM webhook_events
      WHERE ${predicate}
      ORDER BY created_at, id
      LIMIT 1
    )
    SELECT head.id, head.created_at AS "createdAt",
           metadata.next_enqueue_at AS "nextEnqueueAt",
           metadata.execution_deadline_at AS "executionDeadlineAt"
    FROM head
    CROSS JOIN LATERAL (
      SELECT next_enqueue_at, execution_deadline_at
      FROM webhook_events WHERE id = head.id OFFSET 0
    ) metadata
  `;
}
