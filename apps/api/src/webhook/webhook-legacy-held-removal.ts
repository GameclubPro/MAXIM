import { buildGroupCommandKey } from '../common/group-command-key';
import { Prisma, type WebhookEvent } from '../prisma/prisma-client';
import { buildPublisherAutoReplySourceSemanticKey } from '../publisher/publisher-auto-reply-source-key';
import { readLegacyReceiptClaims } from './webhook-legacy-claims';
import { parseWebhookEventTimestampMs } from './webhook-event-timestamp';
import { legacySnapshotDigest } from './webhook-legacy-source';
import { buildWebhookReceiptSemanticKey } from './webhook-receipt-semantic-key';
import { buildWebhookSemanticEventKey } from './webhook-semantic-event-key';
import { tryLockWebhookSemanticClaimFences } from './webhook-semantic-claim-fence';
import { WebhookParser } from './webhook.parser';

const HELD_RETRY = 'Webhook preparation deferred: Legacy scope installation is not sealed';
const RAW_KEYS = new Set([
  'update_type',
  'update_id',
  'timestamp',
  'chat_id',
  'message_id',
  'user_id',
  'post_id',
  'is_channel',
]);
function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function identity(value: unknown): string | null {
  if (typeof value === 'number') return Number.isSafeInteger(value) ? String(value) : null;
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 512 &&
    value.trim() === value
    ? value
    : null;
}
function finite(value: Date | null | undefined): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

type Scope = { id: string; messageId: string; certificateId: string };

// FLAG: This is notification abandonment, never removal execution or original-author
// evidence. The caller holds the exact bounded receipt until its immutable proof commits.
// Missing, saturated, conflicting or concurrently owned evidence keeps it held.
export async function inspectHeldRemovalDisposition(
  tx: Prisma.TransactionClient,
  event: WebhookEvent,
): Promise<{ authorityId: string } | 'NOT_HELD' | null> {
  const update = object(event.normalizedPayload);
  const message = object(update?.message);
  const raw = object(update?.raw);
  const sampled = object(event.rawPayload);
  // FLAG: Both original and normalized bindings nominate possible holds only. A
  // mismatch can never gain abandonment authority by hiding the original held actor.
  const chatIds = [
    ...new Set(
      [identity(message?.chatId), identity(raw?.chat_id), identity(sampled?.chat_id)].filter(
        (v): v is string => v !== null,
      ),
    ),
  ];
  const actors = [
    ...new Set(
      [identity(message?.senderId), identity(raw?.user_id), identity(sampled?.user_id)].filter(
        (v): v is string => v !== null,
      ),
    ),
  ];
  const messageIds = new Set([
    identity(message?.messageId),
    identity(raw?.message_id),
    identity(sampled?.message_id),
  ]);
  if (!chatIds.length || !actors.length) return null;
  const scopes = new Map<string, Scope>();
  for (const chatId of chatIds) {
    // FLAG: Bound the indexed chat prefix BEFORE message filtering. A competing
    // chat/user index must not turn LIMIT into a scan of retained chat history.
    const prefix = await tx.$queryRaw<Scope[]>(Prisma.sql`
      SELECT id, message_id AS "messageId", certificate_id AS "certificateId"
      FROM webhook_legacy_recoveries WHERE chat_id = ${chatId} LIMIT 33`);
    if (prefix.length >= 33) return null;
    for (const scope of prefix) if (messageIds.has(scope.messageId)) scopes.set(scope.id, scope);
  }
  for (const actor of actors) {
    const matches = await tx.$queryRaw<Scope[]>(Prisma.sql`
      SELECT id, message_id AS "messageId", certificate_id AS "certificateId"
      FROM webhook_legacy_recoveries WHERE user_id = ${actor} LIMIT 33`);
    if (matches.length >= 33) return null;
    for (const scope of matches) scopes.set(scope.id, scope);
  }
  if (!scopes.size) return 'NOT_HELD';
  if (
    !update ||
    !message ||
    !raw ||
    !sampled ||
    event.status !== 'RECEIVED' ||
    event.enqueueAttempts !== 0 ||
    event.queueName ||
    event.queuedAt ||
    event.processedAt ||
    event.timeoutQuarantineExpiresAt ||
    (event.errorMessage !== null && event.errorMessage !== HELD_RETRY) ||
    !finite(event.createdAt) ||
    (event.nextEnqueueAt !== null && !finite(event.nextEnqueueAt)) ||
    (event.executionDeadlineAt !== null && !finite(event.executionDeadlineAt)) ||
    !identity(event.botId) ||
    update.botId !== event.botId ||
    update.type !== 'message_removed' ||
    raw.update_type !== 'message_removed' ||
    Object.keys(raw).some((key) => !RAW_KEYS.has(key)) ||
    (raw.is_channel !== undefined && raw.is_channel !== false) ||
    (message.entityType !== undefined && message.entityType !== 'chat') ||
    !identity(raw.chat_id) ||
    identity(raw.chat_id) !== message.chatId ||
    !identity(raw.message_id) ||
    identity(raw.message_id) !== message.messageId ||
    !identity(raw.user_id) ||
    identity(raw.user_id) !== message.senderId ||
    (raw.post_id !== undefined && !identity(raw.post_id)) ||
    (raw.update_id !== undefined && !identity(raw.update_id)) ||
    typeof raw.timestamp !== 'number' ||
    update.eventTimestampSource !== 'payload'
  )
    return null;
  const at = parseWebhookEventTimestampMs(raw.timestamp);
  if (at === null || at > event.createdAt.getTime() + 1_000) return null;
  let canonical: string | null;
  let observation: string | null;
  try {
    const parsed = new WebhookParser().parse(raw, { botId: event.botId! });
    canonical = buildWebhookSemanticEventKey(parsed);
    observation = buildWebhookReceiptSemanticKey(parsed, event.botId!);
    if (
      !canonical ||
      event.dedupKey !== `${event.botId}:${parsed.updateId}` ||
      (event.semanticKey !== null &&
        event.semanticKey !== canonical &&
        event.semanticKey !== observation) ||
      legacySnapshotDigest(parsed) !== legacySnapshotDigest(update) ||
      (Object.keys(sampled).length !== 0 &&
        legacySnapshotDigest(sampled) !== legacySnapshotDigest(raw))
    )
      return null;
  } catch {
    return null;
  }
  let selected: string | undefined;
  for (const scope of [...scopes.values()].sort((a, b) => a.id.localeCompare(b.id))) {
    const recovery = await tx.webhookLegacyRecovery.findUnique({
      where: { id: scope.id },
      select: {
        id: true,
        authorityVersion: true,
        disposition: true,
        certificateId: true,
        ownerWebhookEventId: true,
      },
    });
    const certificate = await tx.webhookLegacyQuiescenceCertificate.findUnique({
      where: { id: scope.certificateId },
      select: {
        id: true,
        authorityVersion: true,
        sourceSha: true,
        imageId: true,
        attestationDigest: true,
        previewSha256: true,
        sealedAt: true,
        quiescedAt: true,
      },
    });
    const authority = await tx.webhookLegacySealedAuthority.findUnique({
      where: { certificateId: scope.certificateId },
    });
    if (
      !recovery ||
      recovery.ownerWebhookEventId === event.id ||
      recovery.authorityVersion !== 1 ||
      recovery.disposition !== 'NO_REPLAY_ORDER_RELEASED' ||
      recovery.certificateId !== scope.certificateId ||
      !certificate ||
      certificate.authorityVersion !== 1 ||
      !authority ||
      authority.authorityVersion !== 1 ||
      authority.certificateId !== certificate.id ||
      !/^[a-f0-9]{40}$/u.test(authority.sourceSha) ||
      !/^sha256:[a-f0-9]{64}$/u.test(authority.imageId) ||
      !/^[a-f0-9]{64}$/u.test(authority.attestationDigest) ||
      !/^[a-f0-9]{64}$/u.test(authority.previewSha256) ||
      authority.sourceSha !== certificate.sourceSha ||
      authority.imageId !== certificate.imageId ||
      authority.attestationDigest !== certificate.attestationDigest ||
      authority.previewSha256 !== certificate.previewSha256 ||
      !finite(certificate.sealedAt) ||
      !finite(certificate.quiescedAt) ||
      !finite(authority.sealedAt) ||
      certificate.quiescedAt > certificate.sealedAt ||
      authority.sealedAt.getTime() !== certificate.sealedAt.getTime() ||
      event.createdAt <= authority.sealedAt ||
      at < authority.sealedAt.getTime()
    )
      return null;
    selected ??= authority.id;
  }
  const commandKey = buildGroupCommandKey(message.chatId as string, message.messageId as string);
  const publisherSourceKey = buildPublisherAutoReplySourceSemanticKey({
    publisherBotId: event.botId!,
    chatId: message.chatId as string,
    sourceMessageId: message.messageId as string,
  });
  if (
    !(await tryLockWebhookSemanticClaimFences(tx, [
      canonical,
      observation,
      event.semanticKey,
      commandKey,
      publisherSourceKey,
    ]))
  )
    return null;
  // FLAG: A historical journal can outlive its source claim. Any exact journal
  // keeps the notification held; its state is never evidence of removal execution.
  if (
    await tx.publisherAutoReplyDelivery.findUnique({
      where: {
        chatId_sourceMessageId: {
          chatId: message.chatId as string,
          sourceMessageId: message.messageId as string,
        },
      },
      select: { id: true },
    })
  )
    return null;
  // FLAG: Reconstruct and inspect every alias, including Publisher observation and
  // unknown claim kinds. A saved null key never hides a canonical execution owner.
  for (const key of new Set([
    canonical,
    observation,
    event.semanticKey,
    commandKey,
    publisherSourceKey,
  ])) {
    const claims = await readLegacyReceiptClaims(tx, event.id, key, commandKey);
    if (!claims || claims.length !== 0) return null;
  }
  return selected ? { authorityId: selected } : null;
}
