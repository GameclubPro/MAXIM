import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { assertLegacyRetentionRetirementSource } from './assert-eraser-source.mjs';
import { assertSourceAbandonmentSource } from './assert-source-abandonment-source.mjs';

export const LEGACY_DISPOSITION_SOURCE_CHECKS = Object.freeze([
  // FLAG: Compatible terminal readers do not fence a stale claim writer. Retain
  // the shared protocol and every admission site after positive receipt closure.
  [
    'apps/api/src/webhook/webhook-semantic-claim-fence.ts',
    [
      'WEBHOOK_SEMANTIC_CLAIM_FENCE_VERSION = 1',
      'export async function tryLockWebhookSemanticClaimFences(',
      'export async function lockWebhookSemanticClaimFences(',
      'export async function lockWebhookClaimReceiptAdmission(',
      "'webhook-semantic-claim-fence-v1'",
      'digest.readInt32BE(0), digest.readInt32BE(4)',
      'pg_try_advisory_xact_lock(',
      'pg_advisory_xact_lock(',
      'FOR UPDATE',
      'receipt.status !== WebhookStatus.NO_REPLAY_HELD',
      'receipt.status !== WebhookStatus.QUARANTINED',
      'receipt.status !== WebhookStatus.CANCELLED',
      'receipt.errorMessage !== DORMANT_BOT_OBSERVATION_MARKER',
      'receipt.legacyDispositionId === null',
      'receipt.legacyDispositionReceiptId === null',
      'receipt.sourceDispositionId === null',
      'receipt.sourceDispositionReceiptId === null',
    ],
  ],
  [
    'apps/api/src/webhook/webhook.service.ts',
    [
      'if (!(await tryLockWebhookSemanticClaimFences(tx, [semanticKey])))',
      "throw new WebhookPreparationDeferredError('Semantic claim admission is busy', 1_000)",
      'if (!(await lockWebhookClaimReceiptAdmission(tx, webhookEventId))) return false;',
    ],
  ],
  [
    'apps/api/src/common/group-command-authority.service.ts',
    [
      'await lockWebhookSemanticClaimFences(tx, [semanticKey]);',
      'if (!(await lockWebhookClaimReceiptAdmission(tx, receipt.id))) return;',
      'if (!(await lockWebhookClaimReceiptAdmission(tx, receipt.id))) return false;',
    ],
  ],
  [
    'apps/api/src/publisher/publisher-auto-reply-source-fence.service.ts',
    [
      'export class PublisherAutoReplySourceReceiptHeldError extends Error',
      'await this.lockSourceReceiptAdmission(tx, semanticKey, sourceWebhookEventId);',
      'await lockWebhookSemanticClaimFences(tx, [semanticKey]);',
      'if (!(await lockWebhookClaimReceiptAdmission(tx, receiptId)))',
      'throw new PublisherAutoReplySourceReceiptHeldError();',
      'await this.checkExistingSourceReceiptAdmission(semanticKey, params.sourceWebhookEventId);',
      'this.lockSourceReceiptAdmission(tx, semanticKey, receiptId)',
      'buildPublisherAutoReplySourceSemanticKey(params)',
    ],
  ],
  [
    'apps/api/src/publisher/publisher-auto-reply-producer.service.ts',
    [
      'if (error instanceof PublisherAutoReplySourceReceiptHeldError) return;',
      'await lockWebhookClaimReceiptAdmission(tx, receiptId)',
      'await tx.publisherAutoReplyDelivery.updateMany(',
    ],
  ],
  [
    'apps/api/src/publisher/publisher-auto-reply-source-key.ts',
    [
      'export function buildPublisherAutoReplySourceSemanticKey(',
      "createHash('sha256')",
      "(['publisherBotId', 'chatId', 'sourceMessageId'] as const).map(",
      'const value = params[label].trim();',
      '.update(JSON.stringify(values))',
      ".digest('hex')",
      'publisher-auto-reply-source:',
    ],
  ],
  [
    'apps/api/src/webhook/webhook-legacy-held-removal.ts',
    [
      'const publisherSourceKey = buildPublisherAutoReplySourceSemanticKey({',
      'await tryLockWebhookSemanticClaimFences(tx, [',
      'tx.publisherAutoReplyDelivery.findUnique({',
      'chatId_sourceMessageId: {',
      'sourceMessageId: message.messageId as string,',
      'for (const key of new Set(',
    ],
  ],
  [
    'apps/api/src/webhook/webhook-backlog-cancellation.ts',
    ['materializeBacklogCancellation', "status = 'CANCELLED'", 'webhook_backlog_receipts'],
  ],
  [
    'apps/api/src/webhook/webhook-legacy-hold.service.ts',
    ['backlogUpdateHeldSql', 'materializeBacklogCancellation', 'webhook_backlog_children'],
  ],
  ['apps/api/src/webhook/webhook.service.ts', ['WebhookStatus.CANCELLED']],
  [
    'apps/api/src/webhook/webhook-outbox.service.ts',
    ['WebhookStatus.CANCELLED', 'webhook_backlog_receipts'],
  ],
  ['apps/api/src/moderation/webhook-canonical-execution.service.ts', ['WebhookStatus.CANCELLED']],
  ['apps/api/src/moderation/moderation-delete-intent.service.ts', ['webhook_backlog_receipts']],
  ['apps/api/src/moderation/moderation-rule-followup.service.ts', ['webhook_backlog_receipts']],
  [
    'apps/api/src/webhook/webhook-legacy-hold.service.ts',
    [
      'WEBHOOK_LEGACY_DISPOSITION_VERSION = 1',
      'NO_REPLAY_ORDER_RELEASED',
      'async isMessageHeld(',
      'async hasChatHolds(',
      "'WebhookService',",
      "'WebhookCanonicalExecutionService',",
      "'WebhookOutboxService',",
      "'GroupCommandAuthorityService',",
      "'ModerationService',",
      "'MaxClientService',",
      "'MaxActionLedgerService',",
      "'MaxActionDispatchService',",
      "'ModerationDeleteIntentService',",
      "'ModerationStateDeleteGuardService',",
      "'PrivateControlService',",
      "'MessageDuplicateDeleteGuardService',",
      "'MessageDuplicateMediaService',",
      "'PhotoDuplicateModerationService',",
      "'CommercialOcrModerationService',",
      "'ModerationRuleFollowupService',",
      "'GlobalSpammerIntelligenceService',",
      'async isAnyMessageSourceHeld(',
      "'PublisherChatCommentProducerService',",
      "'PublisherChatCommentDeliveryService',",
      'async isMemberHeld(',
      'async isGlobalUserHeld(',
      'async isOutboundJobHeld(',
      'async isLegacyChatSendHeld(',
      'instance.legacyHolds !== this',
      'throw new WebhookLegacyHoldRejectedError()',
      'certificate."sealed_at" IS NOT NULL',
      'job.sendAutoDelete.sourceSendJobId',
      'new Date(job.sendAutoDelete.sourceCreatedAt ?? NaN)',
      'exactMessageOnly: true',
      'materializeLegacyReceiptDisposition(',
      '."legacy_disposition_id" IS NOT NULL',
    ],
  ],
  [
    'apps/api/src/prisma/prisma.module.ts',
    [
      'providers: [PrismaService, WebhookLegacyHoldService]',
      'exports: [PrismaService, WebhookLegacyHoldService]',
    ],
  ],
  [
    'apps/api/src/webhook/webhook.service.ts',
    ['this.legacyHolds', 'settleHeldReceipt(', 'WebhookStatus.NO_REPLAY_HELD'],
  ],
  [
    'apps/api/src/moderation/webhook-canonical-execution.service.ts',
    ['this.legacyHolds', 'settleHeldReceipt(', 'WebhookStatus.NO_REPLAY_HELD'],
  ],
  [
    'apps/api/src/webhook/webhook-legacy-receipt-disposition.ts',
    [
      'export async function materializeLegacyReceiptDisposition(',
      'readLegacyReceiptClaims(tx, event.id, event.semanticKey, commandKey)',
      'tx.webhookLegacyReceiptDisposition.create(',
      'legacyDispositionId: proof.id',
      'legacyDispositionReceiptId: event.id',
      "...(scopeKind === 'EXACT_OWNER' ? {} : { status: 'NO_REPLAY_HELD' as const })",
      'parseAdminForwardedModerationCommand(text, settings ?? undefined)',
      "return 'BLOCKED_UNKNOWN'",
    ],
  ],
  [
    'apps/api/src/webhook/webhook-legacy-claims.ts',
    [
      'export async function readLegacyReceiptClaims(',
      'take: 33',
      'i <= 32',
      'kind_semanticKey: { kind: next.kind, semanticKey }',
    ],
  ],
  [
    'apps/api/src/webhook/webhook-legacy-source.ts',
    ['isLegacyOpaqueSequence(body.seq)', 'inspectLegacyForwardText(update, settings)'],
  ],
  [
    'apps/api/src/webhook/webhook-legacy-forward-source.ts',
    [
      "} from './webhook-legacy-content-primitives';",
      'isLegacyOpaqueSequence(item.seq)',
      'identity(item.mid)',
    ],
  ],
  [
    'apps/api/src/webhook/webhook-legacy-content-primitives.ts',
    ['export function isLegacyOpaqueSequence(', 'Math.abs(value) <= 2 ** 63'],
  ],
  [
    'apps/api/src/common/group-command-authority.service.ts',
    [
      'this.legacyHolds',
      'await this.assertPermitAllowed(permit, tx)',
      'await this.legacyHolds.readFreshCommandReceipt(',
      'if (!command) throw new WebhookLegacyHoldRejectedError()',
      'async assertFreshHeldCommandAccess(',
      'verifyFreshHeldCommandAccess(max, proof, permit.executionBotId)',
    ],
  ],
  [
    'apps/api/src/webhook/webhook-outbox.service.ts',
    ['legacyOrderReleasedSql(', 'webhook_legacy_recoveries'],
  ],
  [
    'apps/api/src/moderation/moderation.service.legacy.ts',
    [
      'await this.legacyHolds.isMessageHeld(',
      'this.legacyHolds.isMemberHeld(',
      'await this.legacyHolds?.isGlobalUserHeld(',
      'legacyBotCleanupSourceAt(params)',
      'isLegacyChatSendHeld(chatId, originalSourceAt ?? new Date(NaN))',
      "botMessageOriginalCreatedAtSource: 'max_message_timestamp_v1'",
    ],
  ],
  [
    'apps/api/src/moderation/moderation-delete-intent.service.ts',
    [
      'await this.legacyHolds.isMessageHeld(',
      'this.legacyHolds.isMemberHeld(',
      'readLegacyBotCleanupSourceAt(reason.metadata)',
      'isLegacyChatSendHeld(intent.chatId, sourceAt ?? new Date(NaN))',
      "code === 'photo_duplicate_legacy_evidence_retired'",
      "'photo_duplicate_legacy_evidence_retired',",
      "'Retired photo evidence cannot authorize a new deletion'",
    ],
  ],
  [
    'apps/api/src/moderation/message-duplicate/message-duplicate-delete-guard.service.ts',
    [
      'await this.legacyHolds?.isAnyMessageSourceHeld(',
      '{ messageId: binding.original.messageId, userId: binding.original.senderId }',
      "'message_duplicate_source_held'",
    ],
  ],
  [
    'apps/api/src/moderation/message-duplicate/message-duplicate-media.service.ts',
    [
      "['NO_REPLAY_HELD', 'CANCELLED'].includes(row.status)",
      'await this.legacyHolds?.isUpdateHeld(update)',
    ],
  ],
  [
    'apps/api/src/moderation/moderation-state-delete-guard.service.ts',
    [
      'await this.legacyHolds?.isMessageHeld(',
      'await this.legacyHolds?.isMemberHeld(',
      'await this.legacyHolds?.isGlobalUserHeld(',
    ],
  ],
  [
    'apps/api/src/moderation/moderation-rule-followup.service.ts',
    [
      'await this.legacyHolds?.isMessageHeld(',
      'await this.legacyHolds?.isMemberHeld(',
      'await this.legacyHolds?.isGlobalUserHeld(',
    ],
  ],
  [
    'apps/api/src/publisher/publisher-chat-comment-producer.service.ts',
    [
      'private readonly legacyHolds: WebhookLegacyHoldService',
      'legacyHolds.isMessageHeld(',
      'legacyHolds.isMemberHeld(',
      'legacyHolds.isGlobalUserHeld(',
    ],
  ],
  [
    'apps/api/src/publisher/publisher-chat-comment-delivery.service.ts',
    [
      'private readonly legacyHolds: WebhookLegacyHoldService',
      'legacyHolds.isMessageHeld(',
      'legacyHolds.isMemberHeld(',
      'legacyHolds.isGlobalUserHeld(',
      'moderationSource: {',
    ],
  ],
  [
    'apps/api/src/moderation/photo-duplicate/photo-duplicate.processor.ts',
    ['await this.orderingStore.abandon({'],
  ],
  [
    'apps/api/src/moderation/photo-duplicate/photo-duplicate-moderation.service.ts',
    ['NO_REPLAY_HELD'],
  ],
  [
    'apps/api/src/moderation/commercial-ocr/commercial-ocr-moderation.service.ts',
    ['NO_REPLAY_HELD'],
  ],
  [
    'apps/api/src/moderation/global-spammer-intelligence.service.ts',
    ['await this.legacyHolds?.isGlobalUserHeld('],
  ],
  [
    'apps/api/src/moderation/private-control.service.ts',
    ['legacyHolds?: WebhookLegacyHoldService', '      legacyHolds,'],
  ],
  [
    'apps/api/src/moderation/private-control.service.legacy.ts',
    [
      "import * as legacyHoldAdvisory from './private-control-legacy-hold-advisory'",
      'this.describeChatHolds = legacyHoldAdvisory.create(this.adminService, this.legacyHolds)',
      'description: await this.describeChatHolds(context.actor.userId, session, config?.description)',
    ],
  ],
  [
    'apps/api/src/moderation/private-control-legacy-hold-advisory.ts',
    [
      'export function create(',
      "(session.selectedEntityType ?? 'chat') !== 'chat'",
      'await adminService.assertManagedEntityAdminAccess(',
      'await legacyHolds.hasChatHolds(session.selectedChatId)',
      'Автоматическая модерация для некоторых участников этого чата',
      'Статус ограничений автоматической модерации временно недоступен',
    ],
  ],
  [
    'apps/api/src/max/max-client.service.ts',
    [
      'await assertLegacyActionAllowed(this.legacyHolds, action)',
      'await this.legacyHolds.isMessageHeld(',
      '!action.userId || !executionOptions.beforeMemberMutation',
      'private async assertLegacyMessageLinkAllowed(',
      'await this.assertLegacyMessageLinkAllowed(',
      'await this.assertLegacyMessageMutationAllowed(chatId, sourceMessageId)',
      'sourceCreatedAt: action.createdAt',
      'sourceMessageId: action.messageId ?? null',
      'sourceUserId: action.userId ?? null',
    ],
  ],
  [
    'apps/api/src/max/max-send-auto-delete-marker.ts',
    [
      'sourceSendJobId: string',
      'sourceCreatedAt?: string',
      'sourceUserId?: string | null',
      'sourceMessageId?: string | null',
      'validSource',
    ],
  ],
  [
    'apps/api/src/max/max-action-ledger.service.ts',
    ['await assertLegacyActionAllowed(this.legacyHolds, job, tx)'],
  ],
  [
    'apps/api/src/max/max-action-dispatch.service.ts',
    [
      'await assertLegacyActionAllowed(this.legacyHolds, job)',
      'private async assertLegacyEffectsAllowed(',
      "attemptJob.actionType !== 'TRY_UNBAN_MEMBER'",
    ],
  ],
  [
    'apps/api/prisma/schema.prisma',
    [
      'model WebhookLegacyQuiescenceCertificate {',
      'model WebhookLegacyRecovery {',
      'model WebhookLegacyChildHold {',
      'model WebhookLegacyReceiptDisposition {',
      'model WebhookLegacyMaterializationCursor {',
      'NO_REPLAY_HELD',
      'fields: [legacyDispositionReceiptId, legacyDispositionId], references: [receiptId, id]',
    ],
  ],
]);

// FLAG: Repeated call sites represent independent writers. Keeping only one guard
// in COMMAND or Publisher must not satisfy the permanent rollback writer floor.
export const LEGACY_CLAIM_WRITER_SOURCE_COUNTS = Object.freeze([
  [
    'apps/api/src/common/group-command-authority.service.ts',
    'await lockWebhookSemanticClaimFences(tx, [semanticKey]);',
    2,
  ],
  [
    'apps/api/src/publisher/publisher-auto-reply-source-fence.service.ts',
    'await this.lockSourceReceiptAdmission(tx, semanticKey, sourceWebhookEventId);',
    2,
  ],
  [
    'apps/api/src/publisher/publisher-auto-reply-source-fence.service.ts',
    'await this.checkExistingSourceReceiptAdmission(semanticKey, params.sourceWebhookEventId);',
    2,
  ],
  [
    'apps/api/src/publisher/publisher-auto-reply-source-fence.service.ts',
    'buildPublisherAutoReplySourceSemanticKey(params)',
    4,
  ],
]);

function refuseSource(path) {
  throw new Error(
    `Rollback target lacks permanent legacy disposition readers or final effect guards: ${path}`,
  );
}

// FLAG: A marker outside the journal transaction cannot close the receipt/journal
// race. Fail closed on a changed callback shape until its lock scope is reviewed.
function assertAtomicPublisherJournal(source) {
  const path = 'apps/api/src/publisher/publisher-auto-reply-producer.service.ts';
  const methodStart = source.indexOf('  private async cancelPendingSourceDelivery(');
  const methodEnd = source.indexOf('\n  private async admitSource(', methodStart);
  if (methodStart < 0 || methodEnd <= methodStart) refuseSource(path);
  const method = source.slice(methodStart, methodEnd);
  const transactionStart = method.indexOf('await this.prisma.$transaction(async (tx) => {');
  const transactionEnd = method.indexOf('\n    });', transactionStart);
  if (transactionStart < 0 || transactionEnd <= transactionStart) refuseSource(path);
  const callback = method.slice(transactionStart, transactionEnd);
  const receipt = callback.indexOf('const receiptId = sourceWebhookEventId?.trim();');
  const guard = callback.indexOf(
    'if (receiptId && !(await lockWebhookClaimReceiptAdmission(tx, receiptId))) return;',
  );
  const journal = callback.indexOf('await tx.publisherAutoReplyDelivery.updateMany(');
  if (
    receipt < 0 ||
    guard <= receipt ||
    journal <= guard ||
    method.includes('this.prisma.publisherAutoReplyDelivery.updateMany(') ||
    method.split('await tx.publisherAutoReplyDelivery.updateMany(').length !== 2
  )
    refuseSource(path);
}

function assertPublisherRemovalEvidence(source) {
  const path = 'apps/api/src/webhook/webhook-legacy-held-removal.ts';
  const fence = source.indexOf('await tryLockWebhookSemanticClaimFences(tx, [');
  const fenceEnd = source.indexOf(']))', fence);
  const claims = source.indexOf('for (const key of new Set(', fenceEnd);
  const claimsEnd = source.indexOf(']))', claims);
  const journal = source.indexOf('await tx.publisherAutoReplyDelivery.findUnique(', fenceEnd);
  if (
    fence < 0 ||
    fenceEnd <= fence ||
    journal <= fenceEnd ||
    claims <= journal ||
    claimsEnd <= claims ||
    !source.slice(fence, fenceEnd).includes('publisherSourceKey') ||
    !source.slice(claims, claimsEnd).includes('publisherSourceKey') ||
    !/if\s*\(\s*await tx\.publisherAutoReplyDelivery\.findUnique\([\s\S]*?\)\s*\)\s*return null;/u.test(
      source.slice(journal - 32, claims),
    )
  )
    refuseSource(path);
}

export function assertLegacyDispositionSource(
  commitSha,
  readSource = (path) =>
    execFileSync('git', ['show', `${commitSha}:${path}`], {
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
) {
  if (!/^[0-9a-f]{40}$/u.test(commitSha ?? ''))
    throw new Error('Legacy rollback requires an exact source SHA');
  const sources = new Map();
  for (const [path, markers] of LEGACY_DISPOSITION_SOURCE_CHECKS) {
    let source;
    try {
      source = readSource(path);
    } catch {
      throw new Error(
        `Rollback target lacks permanent legacy disposition readers or final effect guards: ${path}`,
      );
    }
    if (typeof source !== 'string' || markers.some((marker) => !source.includes(marker)))
      throw new Error(
        `Rollback target lacks permanent legacy disposition readers or final effect guards: ${path}`,
      );
    sources.set(path, source);
  }
  // FLAG: A removed intake needs no source admission; prove permanent retirement instead.
  const retentionPath = 'apps/api/src/message-retention/message-retention-store.service.ts';
  const retention = readSource(retentionPath);
  const oldGuards = [
    'WebhookLegacyHoldService.forPrisma(this.prisma)',
    'await holds?.isMessageHeld(',
    'await holds?.isMemberHeld(',
    'await holds?.isGlobalUserHeld(',
  ];
  const legacyHoldSource = sources.get('apps/api/src/webhook/webhook-legacy-hold.service.ts');
  if (
    typeof retention !== 'string' ||
    oldGuards.some((marker) => !retention.includes(marker)) ||
    !legacyHoldSource?.includes("'MessageRetentionStore',")
  ) {
    try {
      assertLegacyRetentionRetirementSource(commitSha, 'api-shared', readSource);
    } catch {
      throw new Error(
        `Rollback target lacks permanent legacy disposition readers or final effect guards: ${retentionPath}`,
      );
    }
  }
  for (const [path, marker, minimum] of LEGACY_CLAIM_WRITER_SOURCE_COUNTS)
    if ((sources.get(path)?.split(marker).length ?? 1) - 1 < minimum)
      throw new Error(
        `Rollback target lacks permanent legacy disposition readers or final effect guards: ${path}`,
      );
  assertAtomicPublisherJournal(
    sources.get('apps/api/src/publisher/publisher-auto-reply-producer.service.ts'),
  );
  assertPublisherRemovalEvidence(
    sources.get('apps/api/src/webhook/webhook-legacy-held-removal.ts'),
  );
  assertSourceAbandonmentSource(commitSha, readSource);
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    assertLegacyDispositionSource(process.argv[2]);
  } catch {
    process.stderr.write(
      'Rollback target lacks permanent legacy disposition readers or final effect guards.\n',
    );
    process.exitCode = 1;
  }
}
