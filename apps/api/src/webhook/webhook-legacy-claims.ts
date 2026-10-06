import type { Prisma, WebhookExecutionClaim } from '../prisma/prisma-client';

// FLAG: Semantic keys have a (kind, semantic_key) index. An unqualified semantic OR
// scans retained claim history. Enumerate at most 32 indexed kind prefixes and keep
// every command, linked-event and unknown-kind alias in the unchanged safety decision.
export async function readLegacyReceiptClaims(
  tx: Prisma.TransactionClient,
  eventId: string,
  semanticKey: string | null,
  commandKey: string,
): Promise<WebhookExecutionClaim[] | null> {
  const claims = await tx.webhookExecutionClaim.findMany({
    where: { webhookEventId: eventId },
    take: 33,
  });
  if (claims.length > 32) return null;
  const command = await tx.webhookExecutionClaim.findUnique({
    where: { kind_semanticKey: { kind: 'COMMAND', semanticKey: commandKey } },
  });
  if (command) claims.push(command);
  if (semanticKey) {
    let after: string | undefined;
    const seen = new Set<string>();
    for (let i = 0; i <= 32; i++) {
      const next = await tx.webhookExecutionClaim.findFirst({
        where: after === undefined ? {} : { kind: { gt: after } },
        select: { kind: true },
        orderBy: { kind: 'asc' },
      });
      if (!next) break;
      if (i === 32 || seen.has(next.kind)) return null;
      seen.add(next.kind);
      after = next.kind;
      const claim = await tx.webhookExecutionClaim.findUnique({
        where: { kind_semanticKey: { kind: next.kind, semanticKey } },
      });
      if (claim) claims.push(claim);
    }
  }
  return [...new Map(claims.map((claim) => [claim.id, claim])).values()].sort((a, b) =>
    a.id.localeCompare(b.id),
  );
}
