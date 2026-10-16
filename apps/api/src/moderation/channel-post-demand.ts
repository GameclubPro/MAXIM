import type { MaxUpdate } from '@maxim/contracts';
import { Prisma } from '../prisma/prisma-client';

// FLAG: These rows nominate an exact post for the existing guarded poll path. They
// never authorize an edit, grant access, settle a webhook or replay a started handler.
export const CHANNEL_POST_DEMAND_LIFETIME_MS = 24 * 60 * 60_000;
export type ChannelPostDemandInput = {
  chatId: string;
  messageId: string;
  sourceAt: Date;
  expiresAt: Date;
};
// FLAG: Preserve PostgreSQL's microseconds for the scheduling CAS; a Date loses them.
export type ClaimedChannelPostDemand = ChannelPostDemandInput & { claimedUntil: string };
type Store = Pick<Prisma.TransactionClient, '$executeRaw' | '$queryRaw'>;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function captureChannelPostDemand(
  update: MaxUpdate,
  publisherBotId: string,
  nowMs = Date.now(),
): ChannelPostDemandInput | null {
  const message = update.message;
  const raw = record(update.raw);
  const source = record(raw?.message);
  const recipient = record(source?.recipient);
  const body = record(source?.body);
  if (
    !update.botId ||
    update.botId === publisherBotId ||
    update.type !== 'message_created' ||
    raw?.update_type !== 'message_created' ||
    !message ||
    message.entityType !== 'channel' ||
    message.postId ||
    !/^-[1-9]\d*$/.test(message.chatId) ||
    !message.messageId ||
    message.messageId.length > 512 ||
    recipient?.chat_type !== 'channel' ||
    String(recipient.chat_id) !== message.chatId ||
    recipient.post_id != null ||
    body?.mid !== message.messageId ||
    update.eventTimestampSource === 'ingress'
  )
    return null;
  const sourceAtMs = Date.parse(message.createdAt);
  if (
    !Number.isSafeInteger(sourceAtMs) ||
    sourceAtMs <= 0 ||
    source?.timestamp !== sourceAtMs ||
    sourceAtMs > nowMs + 1_000 ||
    sourceAtMs + CHANNEL_POST_DEMAND_LIFETIME_MS <= nowMs
  )
    return null;
  return {
    chatId: message.chatId,
    messageId: message.messageId,
    sourceAt: new Date(sourceAtMs),
    expiresAt: new Date(sourceAtMs + CHANNEL_POST_DEMAND_LIFETIME_MS),
  };
}

export async function persistChannelPostDemand(
  tx: Store,
  input: ChannelPostDemandInput,
): Promise<void> {
  // FLAG: Parent first, then item. The idle transition locks the same parent before
  // checking its children, so a concurrent arrival cannot lose its wake-up. The caller
  // owns the receipt transaction; only a newly inserted post may wake a delayed parent.
  // Mirrors preserve both the original horizon and the existing item/channel retry.
  const inserted = await tx.$executeRaw(Prisma.sql`
    WITH eligible AS MATERIALIZED (
      SELECT c.id FROM chats c JOIN channel_settings s ON s.chat_id = c.id
      WHERE c.id = ${input.chatId} AND c.entity_type = 'CHANNEL'
        AND (s.post_signature_enabled OR s.quick_buttons_enabled OR s.comments_enabled OR s.post_suggestions_enabled)
        AND s.updated_at <= ${input.sourceAt}
        AND ${input.expiresAt} > (SELECT clock_timestamp() AT TIME ZONE 'UTC')
    ), parent AS (
      INSERT INTO channel_post_demand_channels (chat_id, due_at)
      SELECT id, (clock_timestamp() AT TIME ZONE 'UTC') FROM eligible
      ON CONFLICT (chat_id) DO UPDATE SET due_at = COALESCE(channel_post_demand_channels.due_at, EXCLUDED.due_at)
      RETURNING chat_id
    )
    INSERT INTO channel_post_demands (chat_id, message_id, source_at, expires_at, due_at)
    SELECT chat_id, ${input.messageId}, ${input.sourceAt}, ${input.expiresAt},
      (clock_timestamp() AT TIME ZONE 'UTC') FROM parent
    ON CONFLICT (chat_id, message_id) DO NOTHING
  `);
  if (inserted > 0) {
    await tx.$executeRaw(Prisma.sql`UPDATE channel_post_demand_channels
      SET due_at = LEAST(due_at, (clock_timestamp() AT TIME ZONE 'UTC'))
      WHERE chat_id = ${input.chatId}`);
  }
}

export async function claimChannelPostDemandChannels(
  tx: Store,
  limit: number,
  retryMs: number,
): Promise<{ chatId: string }[]> {
  if (limit <= 0) return [];
  return tx.$queryRaw(Prisma.sql`
    WITH due AS MATERIALIZED (
      SELECT chat_id FROM channel_post_demand_channels
      WHERE due_at <= (SELECT clock_timestamp() AT TIME ZONE 'UTC')
      ORDER BY due_at, chat_id LIMIT ${Math.min(32, Math.floor(limit))} FOR UPDATE SKIP LOCKED
    ) UPDATE channel_post_demand_channels target
      SET due_at = (clock_timestamp() AT TIME ZONE 'UTC') + ${Math.max(30_000, retryMs)} * INTERVAL '1 millisecond'
      FROM due WHERE target.chat_id = due.chat_id RETURNING target.chat_id AS "chatId"
  `);
}

export async function claimChannelPostDemandItems(
  tx: Store,
  chatId: string,
  limit: number,
  retryMs: number,
): Promise<ClaimedChannelPostDemand[]> {
  return tx.$queryRaw(Prisma.sql`
    WITH due AS MATERIALIZED (
      SELECT chat_id, message_id FROM channel_post_demands
      WHERE chat_id = ${chatId} AND due_at <= (SELECT clock_timestamp() AT TIME ZONE 'UTC')
      ORDER BY due_at, message_id LIMIT ${Math.max(1, Math.min(32, Math.floor(limit)))} FOR UPDATE SKIP LOCKED
    ) UPDATE channel_post_demands target
      SET due_at = (clock_timestamp() AT TIME ZONE 'UTC') + ${Math.max(30_000, retryMs)} * INTERVAL '1 millisecond'
      FROM due WHERE target.chat_id = due.chat_id AND target.message_id = due.message_id
      RETURNING target.chat_id AS "chatId", target.message_id AS "messageId",
        target.source_at AS "sourceAt", target.expires_at AS "expiresAt",
        target.due_at::text AS "claimedUntil"
  `);
}

export async function deferUnavailableChannelPostDemand(
  tx: Store,
  input: ClaimedChannelPostDemand,
): Promise<void> {
  // FLAG: An unavailable old source is retained, never declared deleted/completed.
  // Delay only this exact reservation; a late read cannot postpone a newer claim.
  await tx.$executeRaw(Prisma.sql`UPDATE channel_post_demands
    SET due_at = LEAST(expires_at, GREATEST(due_at,
      (clock_timestamp() AT TIME ZONE 'UTC') + INTERVAL '5 minutes'))
    WHERE chat_id = ${input.chatId} AND message_id = ${input.messageId}
      AND source_at = ${input.sourceAt} AND due_at = ${input.claimedUntil}::timestamp`);
}

export async function settleChannelPostDemand(
  tx: Store,
  input: ChannelPostDemandInput,
): Promise<void> {
  await tx.$executeRaw(Prisma.sql`DELETE FROM channel_post_demands
    WHERE chat_id = ${input.chatId} AND message_id = ${input.messageId} AND source_at = ${input.sourceAt}`);
}

export async function idleChannelPostDemand(tx: Store, chatId: string): Promise<void> {
  // Caller owns a short transaction. No MAX request may run under this parent lock.
  await tx.$queryRaw(
    Prisma.sql`SELECT chat_id FROM channel_post_demand_channels WHERE chat_id = ${chatId} FOR UPDATE`,
  );
  // FLAG: Use the earliest retained child, including unvisited work after a failed
  // read. Ready channels rotate behind other due channels instead of reclaiming their
  // old queue position. Empty channels become idle; future retries consume no due slot.
  // The parent lock also serializes fresh ingress wake-ups. MAX cooldowns remain in
  // the scan manager and final transport admission, outside this scheduling hint.
  await tx.$executeRaw(Prisma.sql`UPDATE channel_post_demand_channels
    SET due_at = (SELECT GREATEST(due_at, (clock_timestamp() AT TIME ZONE 'UTC'))
      FROM channel_post_demands
      WHERE chat_id = ${chatId} ORDER BY due_at, message_id LIMIT 1)
    WHERE chat_id = ${chatId}`);
}

export async function purgeExpiredChannelPostDemands(tx: Store): Promise<number> {
  return tx.$executeRaw(Prisma.sql`
    WITH expired AS MATERIALIZED (
      SELECT ctid FROM channel_post_demands
      WHERE expires_at <= (SELECT clock_timestamp() AT TIME ZONE 'UTC')
      ORDER BY expires_at, chat_id, message_id LIMIT 500 FOR UPDATE SKIP LOCKED
    ) DELETE FROM channel_post_demands WHERE ctid = ANY(ARRAY(SELECT ctid FROM expired))
  `);
}
