import type { MaxUpdate } from '@maxim/contracts';
import { Prisma, type ChatSettings } from '../prisma/prisma-client';
import type { EnsureModerationDeleteIntentInput } from './moderation-delete-intent.types';
import { fingerprintModerationSettings } from './moderation-settings-fingerprint';

export const VOICE_SOURCE_LIFETIME_MS = 5 * 60_000;
const NATIVE_VOICE_TYPES = new Set(['audio', 'voice', 'audio_message', 'ptt']);

type Identity = { chatId: string; messageId: string };
export type VoiceSourceInput = Identity &
  (
    | { kind: 'invalidate' }
    | { kind: 'created'; userId: string; sourceAtMs: number; deadlineAtMs: number }
  );

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

// FLAG: Only authenticated direct message identities may supply voice authority.
// Filenames, MIME guesses, nested forwards/replies and synthetic IDs never qualify.
export function captureVoiceSourceInput(
  update: MaxUpdate,
  nowMs = Date.now(),
): VoiceSourceInput | null {
  const message = update.message;
  const raw = record(update.raw);
  if (!update.botId || !message || !raw || message.entityType === 'channel' || message.postId)
    return null;
  const { chatId, messageId } = message;
  if (!/^-[1-9]\d*$/.test(chatId) || !messageId || messageId.length > 512) return null;
  const type = raw.update_type ?? raw.type;
  if (type !== update.type) return null;
  if (type === 'message_removed') {
    return String(raw.chat_id) === chatId && raw.message_id === messageId && raw.post_id == null
      ? { kind: 'invalidate', chatId, messageId }
      : null;
  }
  if (type !== 'message_created' && type !== 'message_edited') return null;
  const source = record(raw.message);
  const recipient = record(source?.recipient);
  const body = record(source?.body);
  if (
    String(recipient?.chat_id) !== chatId ||
    body?.mid !== messageId ||
    recipient?.chat_type === 'channel'
  )
    return null;
  // FLAG: Every exact edit revokes the original voice proof, including unknown-time edits
  // and edits received before creation. A later mirrored creation must not resurrect it.
  if (type === 'message_edited') return { kind: 'invalidate', chatId, messageId };
  const sender = record(source?.sender);
  const sourceAtMs = Date.parse(message.createdAt);
  if (
    !message.senderId ||
    String(sender?.user_id) !== message.senderId ||
    sender?.is_bot === true ||
    update.eventTimestampSource === 'ingress' ||
    !Number.isSafeInteger(sourceAtMs) ||
    sourceAtMs <= 0 ||
    sourceAtMs > nowMs + 1_000 ||
    nowMs >= sourceAtMs + VOICE_SOURCE_LIFETIME_MS ||
    !Array.isArray(body.attachments) ||
    body.attachments.length !== 1 ||
    !NATIVE_VOICE_TYPES.has(String(record(body.attachments[0])?.type))
  )
    return null;
  return {
    kind: 'created',
    chatId,
    messageId,
    userId: message.senderId,
    sourceAtMs,
    deadlineAtMs: sourceAtMs + VOICE_SOURCE_LIFETIME_MS,
  };
}

// FLAG: Capture and revocation commit in the same transaction as the authenticated
// receipt. This compact proof stores no audio bytes, media URLs, tokens or message text.
export async function persistVoiceSource(
  tx: Pick<Prisma.TransactionClient, '$executeRaw'>,
  input: VoiceSourceInput,
  receiptId: string,
): Promise<void> {
  if (input.kind === 'invalidate') {
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "moderation_voice_sources" ("chat_id", "message_id", "invalidated_at", "expires_at")
      VALUES (${input.chatId}, ${input.messageId}, clock_timestamp() AT TIME ZONE 'UTC',
        (clock_timestamp() AT TIME ZONE 'UTC') + INTERVAL '24 hours')
      ON CONFLICT ("chat_id", "message_id") DO UPDATE SET
        "invalidated_at" = COALESCE("moderation_voice_sources"."invalidated_at", EXCLUDED."invalidated_at"),
        "expires_at" = GREATEST("moderation_voice_sources"."expires_at", EXCLUDED."expires_at")
    `);
    return;
  }
  await tx.$executeRaw(Prisma.sql`
    INSERT INTO "moderation_voice_sources"
      ("chat_id", "message_id", "user_id", "source_at", "deadline_at", "receipt_id", "expires_at")
    SELECT ${input.chatId}, ${input.messageId}, ${input.userId}, ${new Date(input.sourceAtMs)},
      ${new Date(input.deadlineAtMs)}, ${receiptId},
      (clock_timestamp() AT TIME ZONE 'UTC') + INTERVAL '24 hours'
    WHERE ${new Date(input.sourceAtMs)} <= (clock_timestamp() AT TIME ZONE 'UTC') + INTERVAL '1 second'
      AND ${new Date(input.deadlineAtMs)} > (clock_timestamp() AT TIME ZONE 'UTC')
    ON CONFLICT ("chat_id", "message_id") DO UPDATE SET
      "invalidated_at" = COALESCE("moderation_voice_sources"."invalidated_at", clock_timestamp() AT TIME ZONE 'UTC')
    WHERE "moderation_voice_sources"."user_id" IS DISTINCT FROM EXCLUDED."user_id"
      OR "moderation_voice_sources"."source_at" IS DISTINCT FROM EXCLUDED."source_at"
  `);
}

export function bindVoiceSourceEvidence(
  intent: EnsureModerationDeleteIntentInput,
  update: MaxUpdate,
  settings: ChatSettings,
  receiptId: string | undefined,
): EnsureModerationDeleteIntentInput {
  if (!receiptId || intent.ruleCode !== 'VOICE_BLOCKED_DELETE') return intent;
  const source = captureVoiceSourceInput(update);
  if (
    !source ||
    source.kind !== 'created' ||
    source.chatId !== intent.chatId ||
    source.messageId !== intent.messageId ||
    source.userId !== intent.subjectUserId ||
    new Date(intent.sourceMessageAt ?? NaN).getTime() !== source.sourceAtMs
  )
    return intent;
  return {
    ...intent,
    retryUntilAt: new Date(source.deadlineAtMs),
    event: {
      ...intent.event,
      metadata: {
        ...record(intent.event?.metadata),
        voiceSourceEvidenceVersion: 1,
        voiceSourceAtMs: source.sourceAtMs,
        voiceSourceDeadlineAtMs: source.deadlineAtMs,
        voiceSourcePolicySha256: fingerprintModerationSettings(settings, 'VOICE_BLOCKED_DELETE'),
      },
    },
  };
}

export async function purgeExpiredVoiceSources(
  tx: Pick<Prisma.TransactionClient, '$executeRaw'>,
): Promise<number> {
  // FLAG: Expiry is at least 24 hours after capture; authority lasts only five minutes.
  // Bounded indexed cleanup can never revive an old creation or delete live authority.
  return tx.$executeRaw(Prisma.sql`
    WITH expired AS (
      SELECT "chat_id", "message_id" FROM "moderation_voice_sources"
      WHERE "expires_at" <= (SELECT clock_timestamp() AT TIME ZONE 'UTC')
      ORDER BY "expires_at", "chat_id", "message_id" LIMIT ${500} FOR UPDATE SKIP LOCKED
    ) DELETE FROM "moderation_voice_sources" target USING expired
      WHERE target."chat_id" = expired."chat_id" AND target."message_id" = expired."message_id"
  `);
}
