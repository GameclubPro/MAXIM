import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// FLAG: Dormant receipts and permission ceilings survive image rollback. Schema
// compatibility alone cannot prevent an older worker from reactivating or replaying them.
export const MANAGED_ENTITY_ACTIVATION_SOURCE_CHECKS = Object.freeze([
  [
    'apps/api/src/max/managed-entity-activation.util.ts',
    [
      'MANAGED_ENTITY_ACTIVATION_READER_VERSION = 1',
      "MAJOR_EXPLICIT_ACTIVATION_PENDING_SOURCE = 'major_explicit_activation_pending'",
      'ChatBotAccessState.DENIED',
      'ChatBotAccessState.LOST',
      'ChatBotAccessState.CONFIRMED_MEMBER',
      'export function isMajorManagedEntityActivationRequired(',
      'export function isManagedEntityReceiptAfterActivation(',
      'Date.parse(activatedAt) <= receiptSourceAt.getTime()',
      'activationCapabilityCeiling',
      'hasConfirmedDeleteMessageAccess(',
      'export async function hasPersistedManagedEntityActivationSource(',
      'client.webhookEvent.findUnique(',
      'readWebhookEventTimestamp(payload)',
      'export function hasExplicitHumanAdministrator(',
      'export function hasMajorActivationCapabilities(',
    ],
  ],
  [
    'apps/api/src/max/max-bot-access-policy.util.ts',
    [
      "Object.hasOwn(row, 'activationCapabilityCeiling')",
      "Object.hasOwn(row, 'explicitActivationSourceAt')",
      'MANAGED_ENTITY_EXECUTION_PURPOSES.filter(',
    ],
  ],
  [
    'apps/api/src/max/bot-access-snapshot.util.ts',
    [
      'activationCapabilityCeiling: [...access.activationCapabilityCeiling]',
      '{ explicitActivationSourceAt: options.explicitActivationSourceAt }',
    ],
  ],
  [
    'apps/api/src/max/max-bot-link.service.ts',
    [
      'async assertChatBotAccessProbeAllowed(',
      'hasPersistedManagedEntityActivationSource(this.prisma, activation)',
      'hasPersistedManagedEntityActivationSource(tx, proof)',
      'hasExplicitHumanAdministrator(',
      'hasMajorActivationCapabilities(',
      'isMajorManagedEntityActivationRequired(',
      'restrictPassiveBotAccess<',
      'activationCapabilityCeiling',
      'isPublisherManagedEntityActivationRequired(',
      'MAJOR_EXPLICIT_ACTIVATION_PENDING_SOURCE',
      'isManagedEntityReceiptAfterActivation(row.permissionsSnapshot, receiptSourceAt)',
      'isManagedEntityReceiptAfterActivation(membership.permissionsSnapshot, receiptSourceAt)',
      'params.explicitActivation.sourceAt.toISOString()',
    ],
  ],
  [
    'apps/api/src/max/managed-entity-passive-access.util.ts',
    [
      'export function restrictPassiveManagedEntityAccess<',
      'const previousCeiling = MANAGED_ENTITY_EXECUTION_PURPOSES.filter(',
      'const ceiling = previousCeiling.filter(',
      'activationCapabilityCeiling: ceiling',
      'ceiling.includes(purpose) && permits(access, purpose)',
    ],
  ],
  [
    'apps/api/src/max/max-delete-message-access.util.ts',
    ['!snapshot.activationCapabilityCeiling.includes(action)'],
  ],
  [
    'apps/api/src/max/max-execution-owner-readiness.service.ts',
    ['isMajorManagedEntityActivationRequired('],
  ],
  [
    'apps/api/src/max/max-client.service.ts',
    [
      'await this.maxBotLinkService.assertChatBotAccessProbeAllowed(',
      'this.maxBotLinkService.restrictPassiveBotAccess(',
      'options.explicitActivation !== undefined',
    ],
  ],
  [
    'apps/api/src/max/max-execution-route-proof.ts',
    [
      'isMajorManagedEntityActivationRequired(membership, state.entityType)',
      '!hasExecutionCapability(membership, state.entityType, purpose)',
      '!snapshot.activationCapabilityCeiling.includes(purpose)',
    ],
  ],
  [
    'apps/api/src/webhook/webhook-dormant-observation.ts',
    [
      "DORMANT_BOT_OBSERVATION_MARKER = 'DORMANT_BOT_OBSERVATION_V1'",
      'export async function settleDormantWebhookObservation(',
      'Math.min(receivedAt.getTime(), sourceAt?.getTime() ?? Infinity)',
      'await tx.chat.createMany({',
      'catalogKind: ChatCatalogKind.CONTEXT_ONLY',
      'resolveDormantReceiptPeer(chatId, botId, tx, receiptSourceAt)',
      'SELECT id FROM chats WHERE id = ${chatId} FOR UPDATE',
      'WHERE id = ${webhookEventId} FOR UPDATE',
      'tx.webhookExecutionClaim.findFirst(',
      'if (ownedClaim) return false;',
      'route.peerBotId',
      'errorMessage: DORMANT_BOT_OBSERVATION_MARKER',
      'status: WebhookStatus.PROCESSED',
    ],
  ],
  [
    'apps/api/src/webhook/webhook.service.ts',
    [
      'await settleDormantWebhookObservation(',
      'SELECT error_message AS "errorMessage" FROM webhook_events',
      'WHERE id = ${webhookEventId} FOR UPDATE',
      'receipt.errorMessage === DORMANT_BOT_OBSERVATION_MARKER',
    ],
  ],
  [
    'apps/api/src/publisher/publisher-entity-connection.util.ts',
    [
      "PUBLISHER_EXPLICIT_ACTIVATION_PENDING_SOURCE = 'publisher_explicit_activation_pending'",
      'export function isPublisherManagedEntityActivationRequired(',
      'isPublisherExplicitActivationPending(row)',
      'hasPublisherKnownWriteDenial(',
      'export function publisherRefreshEvidenceWhere(',
      'export function isPublisherActivationSourceAfterEpoch(',
    ],
  ],
  [
    'apps/api/src/publisher/publisher-binding-refresh.service.ts',
    [
      'hasPersistedManagedEntityActivationSource(this.prisma, explicitActivation)',
      'hasPersistedManagedEntityActivationSource(tx, params.explicitActivation)',
      'isPublisherActivationSourceAfterEpoch(binding, params.explicitActivation.sourceAt)',
      'hasExplicitHumanAdministrator(',
      'where: newerManagedEntityActorConflictWhere(',
      'eventAt: { gte: params.probeStartedAt }',
      'if (actorActivity || actorVerdict) return false;',
      'tx.managedEntityAccessEdge.updateMany(',
      'tx.publisherEntityBinding.upsert(',
      'job.activationSourceAt',
    ],
  ],
  [
    'apps/api/src/publisher/publisher-readiness.service.ts',
    ['isPublisherManagedEntityActivationRequired(binding)'],
  ],
  [
    'apps/api/src/publisher/publisher-bot-access-executor.ts',
    [
      'PUBLISHER_EXPLICIT_ACTIVATION_PENDING_SOURCE',
      'ChatBotAccessState.DENIED',
      'ChatBotAccessState.LOST',
      'ChatBotAccessState.CONFIRMED_MEMBER',
      'hasPublisherKnownWriteDenial(botAccess)',
    ],
  ],
  [
    'apps/api/src/publisher/publisher-entity-binding-lifecycle.service.ts',
    [
      'isPublisherManagedEntityActivationRequired(current)',
      'isPublisherManagedEntityActivationRequired(binding)',
      'PUBLISHER_EXPLICIT_ACTIVATION_PENDING_SOURCE',
      '!dormantPassiveObservation',
    ],
  ],
  [
    'apps/api/src/publisher/publisher-fresh-bot-proof.ts',
    ['isPublisherManagedEntityActivationRequired(binding)'],
  ],
  [
    'apps/api/src/publisher/publisher-binding-refresh-scheduler.service.ts',
    ['publisherRefreshEvidenceWhere(this.publisherBotId)'],
  ],
  [
    'apps/api/src/publisher/publisher-catalog-refresh-executor.ts',
    ['isPublisherManagedEntityActivationRequired(binding)'],
  ],
  [
    'apps/api/src/publisher/publisher-roster-refresh-executor.ts',
    ['isPublisherManagedEntityActivationRequired(binding)'],
  ],
  [
    'apps/api/src/publisher/publisher-actor-access-executor.ts',
    ['isPublisherManagedEntityActivationRequired(binding)'],
  ],
]);

export function assertManagedEntityActivationSource(
  commitSha,
  readSource = (path) =>
    execFileSync('git', ['show', `${commitSha}:${path}`], {
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
) {
  if (!/^[0-9a-f]{40}$/u.test(commitSha ?? '')) throw new Error('Exact source SHA required');
  for (const [path, markers] of MANAGED_ENTITY_ACTIVATION_SOURCE_CHECKS) {
    const source = readSource(path);
    if (typeof source !== 'string' || markers.some((marker) => !source.includes(marker)))
      throw new Error(`Rollback target lacks explicit bot activation readers: ${path}`);
  }
  const client = readSource('apps/api/src/max/max-client.service.ts');
  const probe = client.slice(
    client.indexOf('  async getCurrentChatMemberAccess('),
    client.indexOf('  private async fetchCurrentChatMemberAccessUncached('),
  );
  const gate = probe.indexOf('await this.maxBotLinkService.assertChatBotAccessProbeAllowed(');
  const cache = probe.indexOf('await this.readJsonCache(');
  const live = probe.indexOf('this.fetchCurrentChatMemberAccessUncached(');
  if (gate < 0 || cache <= gate || live <= gate)
    throw new Error('Rollback target probes dormant bots before its activation gate');
  const webhook = readSource('apps/api/src/webhook/webhook.service.ts');
  const settle = webhook.indexOf('await settleDormantWebhookObservation(');
  const marker = webhook.indexOf('receipt.errorMessage === DORMANT_BOT_OBSERVATION_MARKER', settle);
  const claim = webhook.indexOf('await tx.webhookExecutionClaim.createMany(', settle);
  if (settle < 0 || marker <= settle || claim <= marker)
    throw new Error('Rollback target admits execution before dormant receipt settlement');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    assertManagedEntityActivationSource(process.argv[2]);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
