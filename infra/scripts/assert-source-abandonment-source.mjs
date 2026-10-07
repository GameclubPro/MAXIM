import { execFileSync } from 'node:child_process';

// FLAG: Installed exact-source exclusions survive rollback. Preserving only the
// schema or legacy member-wide readers cannot fence these independent sources.
export const SOURCE_ABANDONMENT_SOURCE_CHECKS = Object.freeze([
  [
    'apps/api/src/webhook/webhook-source-abandonment.contract.ts',
    [
      "SOURCE_ABANDONMENT_OPERATION = 'MODERN_SOURCE_ABANDONMENT_V1'",
      'SOURCE_ABANDONMENT_VERSION = 1',
    ],
  ],
  [
    'apps/api/src/webhook/webhook-source-abandonment.ts',
    [
      'export async function materializeSourceAbandonmentReceipt(',
      'certificate.sealedAt',
      'sourceAbandonmentReceiptSourceDigest(event, proof.originalStatus)',
      'source_frozen_owner_unproved',
      'source_receipt_independent_claim',
      'tx.webhookSourceReceiptDisposition.create(',
      'sourceDispositionId: proof.id',
      'sourceDispositionReceiptId: event.id',
      'inspectSourceAbandonmentSource(owner, onRefusal)',
      'inspectSourceAbandonmentSource(owner, onRefusal, settings ?? undefined)',
      'inspectSourceAbandonmentPostSealSource(event, settings ?? undefined)',
    ],
  ],
  [
    'apps/api/src/webhook/webhook-legacy-forward-source.ts',
    [
      'export function inspectLegacyForwardText(',
      "link.type !== 'forward'",
      'const direct = body(message?.body);',
      'const linked = body(link?.message, true);',
      'item.attachments.length <= 10',
      'item.attachments.every(isLegacyImageAttachment)',
      'legacyParsedTextMatches(update)',
      '[direct.text, linked.text, normalized.text]',
      'parseAdminForwardedModerationCommand(text, settings)',
    ],
  ],
  [
    'apps/api/src/webhook/webhook-source-abandonment-content.ts',
    [
      'export function isSourceAbandonmentDirectMedia(',
      "item.type === 'share'",
      "onlyKeys(item, ['type', 'payload', 'title', 'description', 'image_url'])",
      'export function isSourceAbandonmentMarkup(',
      'export function inspectSourceAbandonmentReplyText(',
      "link.type !== 'reply'",
      'item.attachments.length <= 10',
      'item.attachments.every(isLegacyImageAttachment)',
      'legacyParsedTextMatches(update)',
      '[direct.text, linked.text, normalized.text]',
      'parseAdminForwardedModerationCommand(text, settings)',
    ],
  ],
  [
    'apps/api/src/webhook/webhook-legacy-source.ts',
    [
      'inspectLegacyForwardText(update, settings)',
      'export function inspectSourceAbandonmentSource(',
      'export function inspectSourceAbandonmentPostSealSource(',
      "profile: 'legacy' | 'source-abandonment' = 'legacy'",
      '!isSourceAbandonmentDirectMedia(body.attachments, message.link)',
      '!isSourceAbandonmentMarkup(body.markup, body.text)',
      'inspectSourceAbandonmentReplyText(update, settings)',
      'const chatId = identity(recipient.chat_id);',
      'const messageId = identity(body.mid);',
      'const userId = identity(sender.user_id);',
      'return { chatId, messageId, userId, sourceAt: new Date(sourceAt) };',
    ],
  ],
  [
    'apps/api/src/webhook/webhook-legacy-hold.service.ts',
    [
      'async isSourceAbandoned(',
      'async isSourceChildHeld(',
      'FROM "webhook_source_abandonments"',
      'FROM "webhook_source_child_holds"',
      'materializeSourceAbandonmentReceipt(tx, webhookEventId)',
      '."source_disposition_id" IS NOT NULL',
      "'PhotoDuplicateModerationService'",
      "'CommercialOcrModerationService'",
      "'MessageDuplicateMediaService'",
      "'MessageDuplicateDeleteGuardService'",
    ],
  ],
  [
    'apps/api/prisma/schema.prisma',
    [
      'model WebhookSourceAbandonmentCertificate {',
      'model WebhookSourceAbandonment {',
      'model WebhookSourceChildHold {',
      'model WebhookSourceReceiptDisposition {',
      'fields: [sourceDispositionReceiptId, sourceDispositionId], references: [receiptId, id]',
    ],
  ],
  [
    'apps/api/src/moderation/photo-duplicate/photo-duplicate-moderation.service.ts',
    [
      'private readonly legacyHolds?: WebhookLegacyHoldService',
      'if (await this.legacyHolds?.isUpdateHeld(update)) return;',
      'await this.legacyHolds?.isMessageHeld(album.chatId, observation.duplicateOfMessageId)',
    ],
  ],
  [
    'apps/api/src/moderation/commercial-ocr/commercial-ocr-moderation.service.ts',
    [
      'private readonly legacyHolds?: WebhookLegacyHoldService',
      'if (await this.legacyHolds?.isUpdateHeld(update)) return;',
      'await this.legacyHolds?.isUpdateHeld(webhookEvent.normalizedPayload as unknown as MaxUpdate)',
    ],
  ],
  [
    'apps/api/src/moderation/message-duplicate/message-duplicate-media.service.ts',
    [
      'private readonly legacyHolds?: WebhookLegacyHoldService',
      'if (update?.message && (await this.legacyHolds?.isUpdateHeld(update))) return null;',
    ],
  ],
  [
    'apps/api/src/moderation/message-duplicate/message-duplicate-delete-guard.service.ts',
    [
      'private readonly legacyHolds?: WebhookLegacyHoldService',
      'await this.assertLegacySourcesAllowed(chatId, binding);',
      'await this.assertLegacySourcesAllowed(params.chatId, binding);',
      'await this.legacyHolds?.isAnyMessageSourceHeld(chatId, [',
      '{ messageId: binding.messageId, userId: binding.senderId }',
      '{ messageId: binding.original.messageId, userId: binding.original.senderId }',
    ],
  ],
  [
    'apps/api/src/moderation/moderation-delete-intent.service.ts',
    [
      'private async isAbandonedIntentWithoutReceipt(',
      'if (await this.isAbandonedIntentWithoutReceipt(intent)) return this.toAttemptResult(intent);',
      'if (intent.retentionOwned || (await this.isAbandonedIntentWithoutReceipt(intent))) return;',
      '!(intent.remoteDeleteSucceededAt && intent.remoteDeleteSucceededBotId)',
      'FROM "webhook_source_abandonments" held',
    ],
  ],
  [
    'apps/api/src/moderation/moderation-rule-followup.service.ts',
    ['FROM "webhook_source_abandonments" held', 'isSourceAbandoned?.(row.chatId, row.messageId)'],
  ],
  [
    'apps/api/src/moderation/global-spammer-intelligence.service.ts',
    [
      "isSourceChildHeld?.('SPAMMER_OBSERVATION', job.observationId)",
      'private async isAbandonedSourceObservation(',
      'isSourceAbandoned?.(input.chatId, input.messageId)',
    ],
  ],
  [
    'apps/api/src/webhook/webhook-outbox.service.ts',
    [
      '"source_disposition_id",',
      '"legacy_disposition_id" IS NULL AND "source_disposition_id" IS NULL',
      'FROM "webhook_source_abandonments" original',
      'FROM "webhook_source_receipt_dispositions" proof',
    ],
  ],
]);

export function assertSourceAbandonmentSource(
  commitSha,
  readSource = (path) =>
    execFileSync('git', ['show', `${commitSha}:${path}`], {
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
) {
  if (!/^[0-9a-f]{40}$/u.test(commitSha ?? '')) throw new Error('Exact source SHA required');
  for (const [path, markers] of SOURCE_ABANDONMENT_SOURCE_CHECKS) {
    const source = readSource(path);
    if (typeof source !== 'string' || markers.some((marker) => !source.includes(marker)))
      throw new Error(`Rollback target lacks permanent exact-source abandonment readers: ${path}`);
  }
  const holds = readSource('apps/api/src/webhook/webhook-legacy-hold.service.ts');
  const members = holds.slice(
    holds.indexOf('  async hasChatHolds('),
    holds.indexOf('  async isAnyMessageSourceHeld('),
  );
  if (!members || members.includes('webhook_source_'))
    throw new Error('Exact-source abandonment must not grant blanket participant immunity');
}
