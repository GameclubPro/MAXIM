import { readLegacyReceiptClaims } from './webhook-legacy-claims';
import type { MaxUpdate } from '@maxim/contracts';
import { buildGroupCommandKey } from '../common/group-command-key';
import { parseAdminForwardedModerationCommand } from '../moderation/admin-forwarded-command.util';
import { randomUUID } from 'node:crypto';
import { Prisma, type WebhookEvent } from '../prisma/prisma-client';
import {
  inspectLegacyPostSealTextSource,
  inspectLegacyRecoverySource,
  legacySnapshotDigest,
} from './webhook-legacy-source';

export type LegacyReceiptDispositionResult =
  | 'NOT_HELD'
  | 'BLOCKED_UNKNOWN'
  | 'APPLIED_WITH_PROOF'
  | 'ALREADY_APPLIED_SAME_PROOF';
type Options = { preSeal: true; certificateId: string };

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function legacyReceiptSourceDigest(
  event: WebhookEvent,
  originalStatus = event.status,
): string {
  const original = Object.fromEntries(
    Object.entries(event).filter(
      ([key]) => !['legacyDispositionId', 'legacyDispositionReceiptId'].includes(key),
    ),
  );
  return legacySnapshotDigest({ ...original, status: originalStatus });
}

// FLAG: Must run inside the receipt transaction. Positive abandonment never changes
// original claim outcomes. Original receipt state remains immutable in the proof; A scope match alone cannot remove a row from ordering.
export async function materializeLegacyReceiptDisposition(
  tx: Prisma.TransactionClient,
  receiptId: string,
  options?: Options,
): Promise<LegacyReceiptDispositionResult> {
  const locked = await tx.$queryRaw<Array<{ id: string; payloadBytes: number }>>(Prisma.sql`
    SELECT "id", octet_length("raw_payload"::text) + octet_length("normalized_payload"::text) AS "payloadBytes"
    FROM "webhook_events" WHERE "id" = ${receiptId} FOR UPDATE`);
  if (locked.length !== 1 || locked[0]!.payloadBytes > 256 * 1024) return 'BLOCKED_UNKNOWN';
  const event = await tx.webhookEvent.findUnique({ where: { id: receiptId } });
  if (!event) return 'BLOCKED_UNKNOWN';
  const sourceDigest = legacyReceiptSourceDigest(event);
  if (event.legacyDispositionId) {
    const proof = await tx.webhookLegacyReceiptDisposition.findUnique({
      where: { id: event.legacyDispositionId },
      include: { authority: true },
    });
    return proof &&
      proof.receiptId === event.id &&
      proof.sourceDigest === legacyReceiptSourceDigest(event, proof.originalStatus) &&
      proof.reason === 'NO_REPLAY_HELD' &&
      (proof.scopeKind === 'EXACT_OWNER'
        ? proof.originalStatus === event.status
        : event.status === 'NO_REPLAY_HELD') &&
      proof.authority.authorityVersion === 1 &&
      (!options || proof.authority.certificateId === options.certificateId)
      ? 'ALREADY_APPLIED_SAME_PROOF'
      : 'BLOCKED_UNKNOWN';
  }
  const update = record(event.normalizedPayload);
  const message = record(update?.message);
  if (!message || typeof message.chatId !== 'string') return 'NOT_HELD';
  const scopes = await tx.$queryRaw<
    Array<{ recoveryId: string; authorityId: string | null }>
  >(Prisma.sql`
    SELECT recovery."id" AS "recoveryId", authority."id" AS "authorityId"
    FROM "webhook_legacy_recoveries" recovery
    LEFT JOIN "webhook_legacy_sealed_authorities" authority ON authority."certificate_id" = recovery."certificate_id"
    WHERE (recovery."chat_id" = ${message.chatId} AND recovery."message_id" = ${typeof message.messageId === 'string' ? message.messageId : ''}
      OR recovery."user_id" = ${typeof message.senderId === 'string' ? message.senderId : ''})
      ${options ? Prisma.sql`AND recovery."certificate_id" = ${options.certificateId}` : Prisma.empty}
    ORDER BY (recovery."owner_webhook_event_id" = ${receiptId}) DESC, recovery."id" LIMIT 1`);
  if (!scopes.length) return 'NOT_HELD';
  const scope = scopes[0]!;
  if (!scope.authorityId) return 'BLOCKED_UNKNOWN';
  const authority = await tx.webhookLegacySealedAuthority.findUnique({
    where: { id: scope.authorityId },
  });
  const recovery = await tx.webhookLegacyRecovery.findUnique({ where: { id: scope.recoveryId } });
  if (
    !authority ||
    !recovery ||
    authority.authorityVersion !== 1 ||
    recovery.authorityVersion !== 1 ||
    recovery.disposition !== 'NO_REPLAY_ORDER_RELEASED'
  )
    return 'BLOCKED_UNKNOWN';
  if (['PROCESSED', 'DUPLICATE', 'NO_REPLAY_HELD'].includes(event.status)) return 'BLOCKED_UNKNOWN';
  const commandKey =
    typeof message.messageId === 'string'
      ? buildGroupCommandKey(message.chatId, message.messageId)
      : '';
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "webhook_execution_claims"
    WHERE "webhook_event_id" = ${event.id} OR ("semantic_key" IN (${event.semanticKey}, ${commandKey}) AND "kind" IN ('EXECUTION', 'COMMAND'))
    ORDER BY "id" FOR UPDATE`);
  const claims = await readLegacyReceiptClaims(tx, event.id, event.semanticKey, commandKey);
  if (!claims) return 'BLOCKED_UNKNOWN';
  if (
    claims.some(
      (claim) =>
        claim.businessStartedAt ||
        claim.completedAt ||
        claim.status === 'COMPLETED' ||
        claim.leaseToken ||
        claim.leaseExpiresAt ||
        claim.commandResult !== null,
    )
  )
    return 'BLOCKED_UNKNOWN';
  let scopeKind: 'EXACT_OWNER' | 'PRE_SEAL_SOURCE' | 'POST_SEAL_MEMBER';
  if (event.id === recovery.ownerWebhookEventId) {
    const { rawPayload, normalizedPayload, ...ownerSnapshot } = event;
    if (
      !options ||
      legacySnapshotDigest(ownerSnapshot) !== legacySnapshotDigest(recovery.ownerSnapshot) ||
      legacySnapshotDigest(rawPayload) !== recovery.rawPayloadDigest ||
      legacySnapshotDigest(normalizedPayload) !== recovery.normalizedPayloadDigest ||
      claims.length !== 1 ||
      claims[0]!.id !== recovery.claimId ||
      legacySnapshotDigest(claims[0]) !== legacySnapshotDigest(recovery.claimSnapshot)
    )
      return 'BLOCKED_UNKNOWN';
    scopeKind = 'EXACT_OWNER';
  } else if (event.createdAt <= authority.sealedAt) {
    // FLAG: The sealed global hold may project a positively validated ordinary source
    // lazily at preparation. Commands and unknown sources retain their order fence.
    const settings = await tx.chatSettings.findUnique({ where: { chatId: message.chatId } });
    if (!inspectLegacyRecoverySource(event, undefined, settings ?? undefined))
      return 'BLOCKED_UNKNOWN';
    if (
      parseAdminForwardedModerationCommand(
        (event.normalizedPayload as unknown as MaxUpdate).message!.text,
        settings ?? undefined,
      )
    )
      return 'BLOCKED_UNKNOWN';
    scopeKind = 'PRE_SEAL_SOURCE';
  } else {
    // FLAG: Original persisted MAX provenance binds member/message identity. Source
    // timestamps never grant authority and may be future-dated. Permanent automatic
    // sanction protection does not grant authority to discard explicit commands.
    const raw = record(update?.raw);
    const rawMessage = record(raw?.message);
    const sender = record(rawMessage?.sender);
    const recipient = record(rawMessage?.recipient);
    const body = record(rawMessage?.body);
    if (
      !['message_created', 'message_edited'].includes(String(update?.type)) ||
      raw?.update_type !== update?.type ||
      update?.botId !== event.botId ||
      !event.botId ||
      message.entityType !== 'chat' ||
      recipient?.chat_type !== 'chat' ||
      sender?.is_bot !== false ||
      String(recipient?.chat_id) !== message.chatId ||
      String(sender?.user_id) !== message.senderId ||
      typeof message.messageId !== 'string' ||
      body?.mid !== message.messageId ||
      claims.length !== 0 ||
      event.errorMessage ||
      event.processedAt ||
      event.timeoutQuarantineExpiresAt
    )
      return 'BLOCKED_UNKNOWN';
    const text = typeof message.text === 'string' ? message.text : '';
    const settings = await tx.chatSettings.findUnique({ where: { chatId: message.chatId } });
    if (
      (rawMessage?.link !== undefined || body?.text !== message.text) &&
      !inspectLegacyPostSealTextSource(event, settings ?? undefined)
    )
      return 'BLOCKED_UNKNOWN';
    try {
      if (
        /^[/$]/u.test(text.trim()) ||
        /^старт$/iu.test(text.trim()) ||
        parseAdminForwardedModerationCommand(text) ||
        parseAdminForwardedModerationCommand(text, settings ?? undefined)
      )
        return 'BLOCKED_UNKNOWN';
    } catch {
      // Invalid command arguments still identify a command, never ordinary abandoned work.
      return 'BLOCKED_UNKNOWN';
    }
    scopeKind = 'POST_SEAL_MEMBER';
  }
  const proof = await tx.webhookLegacyReceiptDisposition.create({
    data: {
      id: randomUUID(),
      receiptId: event.id,
      authorityId: authority.id,
      sourceDigest,
      originalStatus: event.status,
      originalSnapshot: JSON.parse(
        JSON.stringify({
          version: 1,
          receipt: Object.fromEntries(
            Object.entries(event).filter(
              ([key]) =>
                ![
                  'rawPayload',
                  'normalizedPayload',
                  'legacyDispositionId',
                  'legacyDispositionReceiptId',
                ].includes(key),
            ),
          ),
          rawPayloadDigest: legacySnapshotDigest(event.rawPayload),
          normalizedPayloadDigest: legacySnapshotDigest(event.normalizedPayload),
          claims,
        }),
      ),
      scopeKind,
    },
  });
  const changed = await tx.webhookEvent.updateMany({
    where: { id: event.id, legacyDispositionId: null, status: event.status },
    data: {
      legacyDispositionId: proof.id,
      legacyDispositionReceiptId: event.id,
      ...(scopeKind === 'EXACT_OWNER' ? {} : { status: 'NO_REPLAY_HELD' as const }),
    },
  });
  if (changed.count !== 1) throw new Error('Legacy disposition CAS did not install exact proof');
  return 'APPLIED_WITH_PROOF';
}
