import { createHash } from 'node:crypto';

export const LEGACY_RECOVERY_LIVE_PROTOCOL_VERSION = 1;
export const LEGACY_RECOVERY_LIVE_REQUEST_MAX_BYTES = 64 * 1024;
export const LEGACY_RECOVERY_LIVE_OUTPUT_MAX_BYTES = 8 * 1024 * 1024;
export const LEGACY_RECOVERY_LIVE_MAX_OWNERS = 200;

export type LegacyRecoveryStoppedGeneration = Readonly<{
  serviceName: string;
  containerId: string;
  imageId: string;
  sourceSha: string;
  stopped: true;
}>;

export type LegacyRecoveryLiveBinding = Readonly<{
  maintenanceId: string;
  queueFenceNonce: string;
  transitionJournalSha256: string;
  sourceSha: string;
  imageId: string;
  stoppedGenerations: readonly LegacyRecoveryStoppedGeneration[];
  /** FLAG: Separate host-attested Publisher identity; never a Major execution candidate. */
  publisherBotId?: string;
}>;

/** FLAG: This input identifies an offline review; it never grants startup or a MAX effect. */
export type LegacyRecoveryLiveRequest = Readonly<{
  version: 1;
  operation: 'inventory_preview';
  binding: LegacyRecoveryLiveBinding;
  selection: Readonly<{
    ownerWebhookEventIds: readonly string[];
    majorBotIds: readonly string[];
  }>;
  expectedInventorySha256?: string;
}>;

export type LegacyRecoveryLiveIssue = Readonly<{ code: string; descriptor: string }>;
export type LegacyRecoveryLivePlanProof = Readonly<{
  descriptor: string;
  querySha256: string;
  planSha256: string;
  indexes: readonly string[];
  returnedRows: number;
  examinedRows: number;
  probes: number;
}>;
export type LegacyRecoveryLiveOutput = Readonly<{
  version: 1;
  operation: 'inventory_preview';
  applied: false;
  activationAuthorized: false;
  decision: 'READY_TO_INSTALL' | 'DENY';
  binding: LegacyRecoveryLiveBinding;
  selectionSha256: string;
  registrySha256: string;
  inventorySha256: string | null;
  previewSha256: string | null;
  selectedOwners: readonly Readonly<{
    ownerWebhookEventId: string;
    semanticKey: string;
    claimId: string;
    chatId: string;
    messageId: string;
    userId: string;
    sourceAt: string;
    rawPayloadSha256: string;
    normalizedPayloadSha256: string;
    ownerSnapshotSha256: string;
    claimSnapshotSha256: string;
  }>[];
  children: readonly Readonly<{
    jobKey: string;
    queueName: string;
    jobPayloadDigest: string;
    chatId: string;
    messageId?: string;
    userId?: string;
  }>[];
  sqlPlans: readonly LegacyRecoveryLivePlanProof[];
  issues: readonly LegacyRecoveryLiveIssue[];
  cost: Readonly<{ pages: number; rows: number; probes: number; bytes: number }>;
}>;

const apiServices = [
  'api-ingress',
  'api-admin',
  'api-enqueue',
  'api-moderation',
  'api-moderation-critical',
  'api-moderation-join',
  'api-moderation-realtime-b',
  'api-moderation-realtime-c',
  'api-moderation-realtime-d',
  'api-moderation-background',
  'api-media-analysis',
  'api-action',
  'api-publisher',
  'api-message-retention',
  'ocr-native-sandbox',
  'photo-native-sandbox',
] as const;
const sha256 = /^[0-9a-f]{64}$/u;
const sourceSha = /^[0-9a-f]{40}$/u;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const identity = /^[a-zA-Z0-9_-]{1,128}$/u;
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid offline inventory request');
  return value as Record<string, unknown>;
}
function keys(row: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(row).some((key) => !allowed.includes(key)))
    throw new Error('Unknown offline inventory field');
}
function identities(value: unknown, max: number): string[] {
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.length > max ||
    value.some((item) => typeof item !== 'string' || !identity.test(item)) ||
    new Set(value).size !== value.length
  )
    throw new Error('Invalid finite offline selection');
  return [...value].sort();
}

export function parseLegacyRecoveryPublisherBotId(
  value: unknown,
  majorBotIds: readonly string[],
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !identity.test(value) || majorBotIds.includes(value))
    throw new Error('Invalid separate Publisher catalog');
  return value;
}

export function parseLegacyRecoveryLiveRequest(input: string): LegacyRecoveryLiveRequest {
  if (Buffer.byteLength(input) > LEGACY_RECOVERY_LIVE_REQUEST_MAX_BYTES)
    throw new Error('Offline request budget exceeded');
  const request = object(JSON.parse(input));
  keys(request, ['version', 'operation', 'binding', 'selection', 'expectedInventorySha256']);
  if (
    request.version !== 1 ||
    request.operation !== 'inventory_preview' ||
    (request.expectedInventorySha256 !== undefined &&
      (typeof request.expectedInventorySha256 !== 'string' ||
        !sha256.test(request.expectedInventorySha256)))
  )
    throw new Error('Unsupported offline inventory operation');
  const binding = object(request.binding);
  keys(binding, [
    'maintenanceId',
    'queueFenceNonce',
    'transitionJournalSha256',
    'sourceSha',
    'imageId',
    'stoppedGenerations',
    'publisherBotId',
  ]);
  if (
    typeof binding.maintenanceId !== 'string' ||
    !uuid.test(binding.maintenanceId) ||
    typeof binding.queueFenceNonce !== 'string' ||
    !identity.test(binding.queueFenceNonce) ||
    binding.queueFenceNonce.length < 16 ||
    typeof binding.transitionJournalSha256 !== 'string' ||
    !sha256.test(binding.transitionJournalSha256) ||
    typeof binding.sourceSha !== 'string' ||
    !sourceSha.test(binding.sourceSha) ||
    typeof binding.imageId !== 'string' ||
    !/^sha256:[0-9a-f]{64}$/u.test(binding.imageId) ||
    !Array.isArray(binding.stoppedGenerations) ||
    binding.stoppedGenerations.length !== apiServices.length
  )
    throw new Error('Incomplete stopped-generation binding');
  const generations = binding.stoppedGenerations.map((value) => {
    const row = object(value);
    keys(row, ['serviceName', 'containerId', 'imageId', 'sourceSha', 'stopped']);
    if (
      typeof row.serviceName !== 'string' ||
      !apiServices.some((name) => name === row.serviceName) ||
      typeof row.containerId !== 'string' ||
      !sha256.test(row.containerId) ||
      row.imageId !== binding.imageId ||
      row.sourceSha !== binding.sourceSha ||
      row.stopped !== true
    )
      throw new Error('Stopped-generation identity mismatch');
    return Object.freeze(row) as LegacyRecoveryStoppedGeneration;
  });
  if (
    new Set(generations.map((row) => row.serviceName)).size !== apiServices.length ||
    new Set(generations.map((row) => row.containerId)).size !== apiServices.length
  )
    throw new Error('Ambiguous stopped generations');
  const selection = object(request.selection);
  keys(selection, ['ownerWebhookEventIds', 'majorBotIds']);
  const majorBotIds = identities(selection.majorBotIds, 100);
  const publisherBotId = parseLegacyRecoveryPublisherBotId(binding.publisherBotId, majorBotIds);
  return Object.freeze({
    version: 1,
    operation: 'inventory_preview',
    binding: Object.freeze({
      ...binding,
      ...(publisherBotId ? { publisherBotId } : {}),
      stoppedGenerations: Object.freeze(
        generations.sort((a, b) => a.serviceName.localeCompare(b.serviceName)),
      ),
    }) as LegacyRecoveryLiveBinding,
    selection: Object.freeze({
      ownerWebhookEventIds: Object.freeze(
        identities(selection.ownerWebhookEventIds, LEGACY_RECOVERY_LIVE_MAX_OWNERS),
      ),
      majorBotIds: Object.freeze(majorBotIds),
    }),
    ...(request.expectedInventorySha256
      ? { expectedInventorySha256: request.expectedInventorySha256 as string }
      : {}),
  });
}

export function legacyRecoveryLiveDigest(value: unknown): string {
  const canonical = (item: unknown): unknown => {
    if (item instanceof Date) return item.toISOString();
    if (Array.isArray(item)) return item.map(canonical);
    if (item && typeof item === 'object')
      return Object.fromEntries(
        Object.entries(item)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, val]) => [key, canonical(val)]),
      );
    return item;
  };
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
}
