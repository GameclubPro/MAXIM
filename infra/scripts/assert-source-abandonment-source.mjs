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
