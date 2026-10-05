export const MULTIBOT_EXECUTION_AUTHORITY_VERSION = 'semantic-owner-lease-v1' as const;

export function compareWebhookOrder(
  left: { createdAt: Date; id: string },
  right: { createdAt: Date; id: string },
): number {
  return (
    left.createdAt.getTime() - right.createdAt.getTime() ||
    (left.id === right.id ? 0 : left.id < right.id ? -1 : 1)
  );
}

export async function isEarlierWebhookReceipt(
  client: { webhookEvent: { findFirst?: unknown } },
  left: { createdAt: Date; id: string },
  right: { createdAt: Date; id: string },
): Promise<boolean> {
  const timeDifference = left.createdAt.getTime() - right.createdAt.getTime();
  if (timeDifference !== 0 || left.id === right.id) return timeDifference < 0;
  const findFirst = client.webhookEvent.findFirst;
  if (typeof findFirst !== 'function') return compareWebhookOrder(left, right) < 0;
  // Equal timestamps use the database's exact id collation, matching indexed order heads.
  const first = (await findFirst.call(client.webhookEvent, {
    where: { id: { in: [left.id, right.id] } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true },
  })) as { id: string } | null;
  if (!first) throw new Error('Webhook order comparison receipts unavailable');
  return first.id === left.id;
}
