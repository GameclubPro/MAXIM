import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import { duplicateDiagnosticsQuerySchema } from '@maxim/contracts/settings';
import { Prisma } from '../prisma/prisma-client';

const cursorSchema = z
  .object({
    version: z.literal(1),
    chatId: z.string().min(1).max(512),
    until: z.iso.datetime(),
    at: z.iso.datetime(),
    id: z.string().min(1).max(512),
  })
  .strict();
export type DuplicateHistoryCursor = z.infer<typeof cursorSchema>;

export function readDuplicateHistoryPage(chatId: string, query: unknown, now = Date.now()) {
  const parsed = duplicateDiagnosticsQuerySchema.safeParse(query ?? {});
  if (!parsed.success) throw new BadRequestException('Invalid duplicate diagnostics page');
  let cursor: DuplicateHistoryCursor | undefined;
  if (parsed.data.cursor) {
    try {
      const decoded = cursorSchema.parse(
        JSON.parse(Buffer.from(parsed.data.cursor, 'base64url').toString('utf8')),
      );
      const until = Date.parse(decoded.until);
      // FLAG: A cursor selects the same authorized chat and a bounded, recent snapshot.
      if (
        decoded.chatId !== chatId ||
        until > now ||
        now - until > 15 * 60_000 ||
        Date.parse(decoded.at) > until ||
        Date.parse(decoded.at) < until - 86_400_000
      )
        throw new Error('Cursor scope changed');
      cursor = decoded;
    } catch {
      throw new BadRequestException('Invalid or expired duplicate diagnostics cursor');
    }
  }
  const until = cursor?.until ?? new Date(now).toISOString();
  return {
    limit: parsed.data.limit,
    cursor,
    until,
    since: new Date(Date.parse(until) - 86_400_000).toISOString(),
  };
}

export function encodeDuplicateHistoryCursor(cursor: DuplicateHistoryCursor): string {
  return Buffer.from(JSON.stringify(cursorSchema.parse(cursor))).toString('base64url');
}

export function duplicateHistoryQuery(
  chatId: string,
  page: ReturnType<typeof readDuplicateHistoryPage>,
) {
  const before = page.cursor
    ? Prisma.sql`AND (history.intent_created_at, history.intent_id) < (CAST(${page.cursor.at} AS timestamp), ${page.cursor.id})`
    : Prisma.empty;
  // FLAG: LIMIT applies to the dedicated duplicate projection before any reason/event
  // metadata is inspected. Retention and unrelated rules cannot evict duplicate entries.
  return Prisma.sql`
    WITH recent AS MATERIALIZED (
      SELECT intent_id, intent_created_at, registered_at
      FROM duplicate_diagnostics_history history
      WHERE history.chat_id = ${chatId}
        AND history.intent_created_at >= CAST(${page.since} AS timestamp)
        AND history.intent_created_at <= CAST(${page.until} AS timestamp)
        ${before}
      ORDER BY history.intent_created_at DESC, history.intent_id DESC
      LIMIT ${page.limit + 1}
    )
    SELECT intent.id, intent.message_id AS "messageId", intent.source_message_at AS "sourceMessageAt",
      intent.status, intent.created_at AS "createdAt", intent.updated_at AS "updatedAt",
      intent.next_attempt_at AS "nextAttemptAt", intent.retry_until_at AS "retryUntilAt",
      intent.remote_delete_succeeded_at AS "remoteDeleteSucceededAt",
      intent.absence_verified_at AS "absenceVerifiedAt", intent.last_error_code AS "lastErrorCode",
      recent.registered_at AS "registeredAt",
      to_char(recent.intent_created_at, 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "cursorAt",
      reason.binding, reason.kind,
      COALESCE(sanctions.evidence, '[]'::jsonb) AS "sanctionEvidence"
    FROM recent
    JOIN moderation_delete_intents intent ON intent.id = recent.intent_id AND intent.chat_id = ${chatId}
    LEFT JOIN LATERAL (
      SELECT metadata->'messageDuplicate' AS binding, metadata->>'fingerprintType' AS kind
      FROM moderation_delete_intent_reasons
      WHERE intent_id = intent.id AND rule_code = 'DUPLICATE_DELETE'
      ORDER BY updated_at DESC, id DESC LIMIT 1
    ) reason ON TRUE
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(jsonb_build_object('action', action, 'applied', metadata->'sanctionApplied',
        'binding', metadata->'messageDuplicate')) AS evidence
      FROM (
        SELECT action, metadata FROM moderation_events
        WHERE chat_id = ${chatId} AND message_id = intent.message_id
          AND rule_code IN ('DUPLICATE_WARN', 'DUPLICATE_MUTE', 'DUPLICATE_BAN')
        ORDER BY created_at DESC, id DESC LIMIT 5
      ) bounded_events
    ) sanctions ON TRUE
    ORDER BY recent.intent_created_at DESC, recent.intent_id DESC
  `;
}
