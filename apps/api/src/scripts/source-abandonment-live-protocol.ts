import {
  legacyRecoveryLiveDigest,
  parseLegacyRecoveryLiveRequest,
  parseLegacyRecoveryPublisherBotId,
  type LegacyRecoveryLiveBinding,
  type LegacyRecoveryLiveOutput,
} from './legacy-recovery-live-protocol';
import { sourceAbandonmentOwnerSnapshot } from '../webhook/webhook-source-abandonment';
import {
  SOURCE_ABANDONMENT_OPERATION,
  type SourceAbandonmentCandidate,
  type SourceAbandonmentChild,
} from '../webhook/webhook-source-abandonment.contract';

export const SOURCE_ABANDONMENT_PROTOCOL = 'source-abandonment-v1' as const;
export const SOURCE_ABANDONMENT_REQUEST_MAX_BYTES = 64 * 1024;
export const SOURCE_ABANDONMENT_OUTPUT_MAX_BYTES = 8 * 1024 * 1024;
export const SOURCE_ABANDONMENT_MAX_OWNERS = 8;
export const SOURCE_ABANDONMENT_OBSERVATION_QUEUE = 'sql:spammer-observation';
export const sourceAbandonmentDigest = legacyRecoveryLiveDigest;

export type SourceAbandonmentLiveSelection = Readonly<{
  protocol: typeof SOURCE_ABANDONMENT_PROTOCOL;
  abandonBefore: string;
  ownerWebhookEventIds: readonly string[];
  majorBotIds: readonly string[];
}>;
export type SourceAbandonmentLiveRequest = Readonly<{
  version: 1;
  operation: 'inventory_preview';
  binding: LegacyRecoveryLiveBinding;
  selection: SourceAbandonmentLiveSelection;
  expectedInventorySha256?: string;
}>;
export type SourceAbandonmentAdmissionRequest = Readonly<{
  version: 1;
  operation: 'admission_preview';
  sourceSha: string;
  imageId: string;
  selection: SourceAbandonmentLiveSelection;
  publisherBotId?: string;
}>;
export type SourceAbandonmentLiveOutput = LegacyRecoveryLiveOutput &
  Readonly<{
    sqlEvidenceSha256: string | null;
    redisEvidenceSha256: string | null;
  }>;
export type SourceAbandonmentChildEvidence = SourceAbandonmentLiveOutput['children'][number];

export function sourceAbandonmentRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid source abandonment object');
  return value as Record<string, unknown>;
}
export function assertSourceAbandonmentKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): void {
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw new Error('Unknown source abandonment field');
}
export function isSourceAbandonmentIdentity(value: unknown, max = 1024): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value === value.trim() &&
    Buffer.byteLength(value) <= max &&
    ![...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  );
}
export function parseSourceAbandonmentSelection(value: unknown): SourceAbandonmentLiveSelection {
  const row = sourceAbandonmentRecord(value);
  assertSourceAbandonmentKeys(row, [
    'protocol',
    'abandonBefore',
    'ownerWebhookEventIds',
    'majorBotIds',
  ]);
  const before = typeof row.abandonBefore === 'string' ? Date.parse(row.abandonBefore) : NaN;
  if (
    row.protocol !== SOURCE_ABANDONMENT_PROTOCOL ||
    !Number.isSafeInteger(before) ||
    before <= 0 ||
    new Date(before).toISOString() !== row.abandonBefore
  )
    throw new Error('Invalid exact source protocol or cutoff');
  const ids = (input: unknown, maximum: number): readonly string[] => {
    if (
      !Array.isArray(input) ||
      input.length === 0 ||
      input.length > maximum ||
      input.some((id) => typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/u.test(id)) ||
      new Set(input).size !== input.length
    )
      throw new Error('Invalid finite source selection');
    return Object.freeze([...input].sort());
  };
  return Object.freeze({
    protocol: SOURCE_ABANDONMENT_PROTOCOL,
    abandonBefore: row.abandonBefore as string,
    ownerWebhookEventIds: ids(row.ownerWebhookEventIds, SOURCE_ABANDONMENT_MAX_OWNERS),
    majorBotIds: ids(row.majorBotIds, 100),
  });
}

// FLAG: Reuse only stopped-generation syntax validation. Modern source selection
// is separately parsed and hashed; legacy candidate eligibility is never invoked.
export function parseSourceAbandonmentLiveRequest(input: string): SourceAbandonmentLiveRequest {
  if (Buffer.byteLength(input) > SOURCE_ABANDONMENT_REQUEST_MAX_BYTES)
    throw new Error('Source request budget exceeded');
  const row = sourceAbandonmentRecord(JSON.parse(input));
  assertSourceAbandonmentKeys(row, [
    'version',
    'operation',
    'binding',
    'selection',
    'expectedInventorySha256',
  ]);
  const selection = parseSourceAbandonmentSelection(row.selection);
  const parsed = parseLegacyRecoveryLiveRequest(
    JSON.stringify({
      ...row,
      selection: {
        ownerWebhookEventIds: selection.ownerWebhookEventIds,
        majorBotIds: selection.majorBotIds,
      },
    }),
  );
  return Object.freeze({ ...parsed, selection });
}

export function parseSourceAbandonmentAdmissionRequest(
  input: string,
): SourceAbandonmentAdmissionRequest {
  if (Buffer.byteLength(input) > SOURCE_ABANDONMENT_REQUEST_MAX_BYTES)
    throw new Error('Source request budget exceeded');
  const row = sourceAbandonmentRecord(JSON.parse(input));
  assertSourceAbandonmentKeys(row, [
    'version',
    'operation',
    'sourceSha',
    'imageId',
    'selection',
    'publisherBotId',
  ]);
  if (
    row.version !== 1 ||
    row.operation !== 'admission_preview' ||
    typeof row.sourceSha !== 'string' ||
    !/^[0-9a-f]{40}$/u.test(row.sourceSha) ||
    typeof row.imageId !== 'string' ||
    !/^sha256:[0-9a-f]{64}$/u.test(row.imageId)
  )
    throw new Error('Invalid source admission identity');
  const selection = parseSourceAbandonmentSelection(row.selection);
  const publisherBotId = parseLegacyRecoveryPublisherBotId(
    row.publisherBotId,
    selection.majorBotIds,
  );
  return Object.freeze({
    version: 1,
    operation: 'admission_preview',
    sourceSha: row.sourceSha,
    imageId: row.imageId,
    selection,
    ...(publisherBotId ? { publisherBotId } : {}),
  });
}

export function sourceAbandonmentSelectedOwner(
  candidate: SourceAbandonmentCandidate,
): SourceAbandonmentLiveOutput['selectedOwners'][number] {
  return {
    ownerWebhookEventId: candidate.owner.id,
    semanticKey: candidate.claim.semanticKey,
    claimId: candidate.claim.id,
    ...candidate.source,
    sourceAt: candidate.source.sourceAt.toISOString(),
    rawPayloadSha256: candidate.rawPayloadDigest,
    normalizedPayloadSha256: candidate.normalizedPayloadDigest,
    ownerSnapshotSha256: sourceAbandonmentDigest(sourceAbandonmentOwnerSnapshot(candidate.owner)),
    claimSnapshotSha256: sourceAbandonmentDigest(candidate.claim),
  };
}

export function buildSourceAbandonmentPreviewDigest(
  candidates: readonly SourceAbandonmentCandidate[],
  children: readonly SourceAbandonmentChildEvidence[],
  selection: SourceAbandonmentLiveSelection,
  registrySha256: string,
): string {
  return sourceAbandonmentDigest({
    operation: SOURCE_ABANDONMENT_OPERATION,
    selection,
    registrySha256,
    selectedOwners: candidates
      .map(sourceAbandonmentSelectedOwner)
      .sort((a, b) => a.ownerWebhookEventId.localeCompare(b.ownerWebhookEventId)),
    children: [...children].sort(
      (a, b) => a.queueName.localeCompare(b.queueName) || a.jobKey.localeCompare(b.jobKey),
    ),
  });
}

// FLAG: Child authority binds an exact chat/message source, never a participant
// match, temporal proximity or an unrelated action's destination.
export function sourceAbandonmentChildInputs(
  candidates: readonly SourceAbandonmentCandidate[],
  children: readonly SourceAbandonmentChildEvidence[],
): SourceAbandonmentChild[] {
  return children.map((child) => {
    const owners = candidates.filter(
      (candidate) =>
        candidate.source.chatId === child.chatId &&
        candidate.source.messageId === child.messageId &&
        (child.userId === undefined || child.userId === candidate.source.userId),
    );
    if (owners.length !== 1) throw new Error('Child exact source attribution is unavailable');
    return {
      ownerWebhookEventId: owners[0]!.owner.id,
      kind:
        child.queueName === SOURCE_ABANDONMENT_OBSERVATION_QUEUE
          ? 'SPAMMER_OBSERVATION'
          : 'MAX_ACTION',
      childKey: child.jobKey,
      payloadDigest: child.jobPayloadDigest,
    };
  });
}

export function buildSourceAbandonmentInventoryDigest(
  output: Pick<
    SourceAbandonmentLiveOutput,
    | 'binding'
    | 'selectionSha256'
    | 'registrySha256'
    | 'sqlEvidenceSha256'
    | 'redisEvidenceSha256'
    | 'previewSha256'
  >,
): string {
  return sourceAbandonmentDigest({
    version: 1,
    operation: SOURCE_ABANDONMENT_OPERATION,
    binding: output.binding,
    selectionSha256: output.selectionSha256,
    registrySha256: output.registrySha256,
    sql: output.sqlEvidenceSha256,
    redis: output.redisEvidenceSha256,
    previewSha256: output.previewSha256,
  });
}
