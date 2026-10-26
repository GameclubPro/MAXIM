import type { PrismaClient } from '../prisma/prisma-client';

type HeldMessage = Readonly<{ chatId: string; messageId: string }>;
export class EraserSourceHoldBarrierError extends Error {
  constructor() {
    super('Lastik source holds are not confirmed; source installation remains refused');
    this.name = 'EraserSourceHoldBarrierError';
  }
}

// FLAG: Cold writers must receive a durable independent hold acknowledgement before
// installing source dispositions. A failed database commit may leave a conservative hold.
// Runtime mirrors only inherit an already installed exact source and never call this helper.
export async function confirmEraserSourceHolds(
  prisma: Pick<PrismaClient, '$queryRaw'>,
  messages: readonly HeldMessage[],
  legacyAuthorIds: readonly string[] = [],
  force = false,
): Promise<void> {
  if (!messages.length && !legacyAuthorIds.length) return;
  const binding = force
    ? { owned: true }
    : (
        await prisma.$queryRaw<{ owned: boolean }[]>`
    SELECT EXISTS(SELECT 1 FROM eraser_chat_bindings LIMIT 1) AS owned`
      )[0];
  // All moderator writers are stopped by the cold protocol. Future ownership bootstraps
  // existing dispositions before enabling; an active independent service needs this barrier.
  if (!binding?.owned) return;
  if (messages.some((row) => !row.chatId || !row.messageId))
    throw new EraserSourceHoldBarrierError();
  const origin = process.env.ERASER_CONTROL_URL;
  const token = process.env.ERASER_CONTROL_TOKEN;
  if (!origin || !token) throw new EraserSourceHoldBarrierError();
  let url: URL;
  try {
    url = new URL(origin);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    )
      throw new Error('Invalid control origin');
  } catch {
    throw new EraserSourceHoldBarrierError();
  }
  const exact = [
    ...new Map(messages.map((row) => [`${row.chatId}\u0000${row.messageId}`, row])).values(),
  ];
  const authors = [...new Set(legacyAuthorIds)];
  for (let offset = 0; offset < Math.max(exact.length, authors.length); offset += 500) {
    try {
      const response = await fetch(`${url.origin}/internal/v1/holds`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          holdMessages: exact.slice(offset, offset + 500),
          holdAuthorIds: authors.slice(offset, offset + 500),
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok || ((await response.json()) as { success?: unknown }).success !== true)
        throw new EraserSourceHoldBarrierError();
    } catch {
      // FLAG: Unknown acknowledgement is a refusal, never permission to install or replay.
      throw new EraserSourceHoldBarrierError();
    }
  }
}
