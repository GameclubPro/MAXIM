import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const LEGACY_DISPOSITION_SOURCE_CHECKS = Object.freeze([
  [
    'apps/api/src/webhook/webhook-legacy-hold.service.ts',
    [
      'WEBHOOK_LEGACY_DISPOSITION_VERSION = 1',
      'NO_REPLAY_ORDER_RELEASED',
      'async isMessageHeld(',
      'async hasChatHolds(',
      "'PrivateControlService',",
      "'MessageRetentionStore',",
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
      'return Prisma.sql`${Prisma.raw(eventAlias)}."legacy_disposition_id" IS NOT NULL`',
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
      'tx.webhookLegacyReceiptDisposition.create(',
      'legacyDispositionId: proof.id',
      'legacyDispositionReceiptId: event.id',
      "...(scopeKind === 'EXACT_OWNER' ? {} : { status: 'NO_REPLAY_HELD' as const })",
      'parseAdminForwardedModerationCommand(text, settings ?? undefined)',
      "return 'BLOCKED_UNKNOWN'",
    ],
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
    'apps/api/src/message-retention/message-retention-store.service.ts',
    [
      'WebhookLegacyHoldService.forPrisma(this.prisma)',
      'await holds?.isMessageHeld(',
      'await holds?.isMemberHeld(',
      'await holds?.isGlobalUserHeld(',
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
  for (const [path, markers] of LEGACY_DISPOSITION_SOURCE_CHECKS) {
    const source = readSource(path);
    if (typeof source !== 'string' || markers.some((marker) => !source.includes(marker)))
      throw new Error(
        `Rollback target lacks permanent legacy disposition readers or final effect guards: ${path}`,
      );
  }
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
