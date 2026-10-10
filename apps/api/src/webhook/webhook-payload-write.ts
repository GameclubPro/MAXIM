import { Prisma, WebhookStatus } from '../prisma/prisma-client';

// FLAG: This is only for payload-only preparation writes. Status transitions,
// leases, dispatch markers and execution claims must never use the no-op guard.
export function webhookPayloadChange(
  id: string,
  payload: Prisma.InputJsonValue,
): Prisma.WebhookEventUpdateManyArgs {
  return {
    where: {
      id,
      status: { in: [WebhookStatus.RECEIVED, WebhookStatus.FAILED, WebhookStatus.QUEUED] },
      normalizedPayload: { not: payload },
    },
    data: { normalizedPayload: payload },
  };
}

// FLAG: This retains the same pending-status and JSON no-op guards as the ORM
// predicate above. PostgreSQL commits the single statement before preparation proceeds.
export async function writeWebhookPayload(
  client: Pick<Prisma.TransactionClient, '$executeRaw'>,
  id: string,
  payload: Prisma.InputJsonValue,
): Promise<{ count: number }> {
  const count = await client.$executeRaw(Prisma.sql`
    UPDATE webhook_events SET normalized_payload = ${JSON.stringify(payload)}::jsonb
    WHERE id = ${id} AND status IN ('RECEIVED', 'FAILED', 'QUEUED')
      AND normalized_payload <> ${JSON.stringify(payload)}::jsonb
  `);
  return { count };
}
