import type { Prisma, WebhookEvent, WebhookExecutionClaim } from '../prisma/prisma-client';
import type { LegacyRecoverySource } from './webhook-legacy-source';

export const SOURCE_ABANDONMENT_OPERATION = 'MODERN_SOURCE_ABANDONMENT_V1' as const;
export const SOURCE_ABANDONMENT_VERSION = 1 as const;
export const SOURCE_ABANDONMENT_MAX_SOURCES = 8;
export const SOURCE_ABANDONMENT_MAX_CHILDREN = 10_000;
export type SourceAbandonmentChildKind = 'MAX_ACTION' | 'SPAMMER_OBSERVATION';
export type SourceAbandonmentDatabase = Pick<
  Prisma.TransactionClient,
  '$queryRaw' | '$executeRaw' | 'webhookEvent' | 'webhookExecutionClaim' | 'chatSettings'
>;
export type SourceAbandonmentCandidate = {
  owner: WebhookEvent;
  claim: WebhookExecutionClaim;
  source: LegacyRecoverySource;
  rawPayloadDigest: string;
  normalizedPayloadDigest: string;
};
export type SourceAbandonmentSelection = {
  majorBotIds: readonly string[];
  abandonBefore: Date;
};
export type SourceAbandonmentChild = {
  ownerWebhookEventId: string;
  kind: SourceAbandonmentChildKind;
  childKey: string;
  payloadDigest: string;
};

// FLAG: This is an immutable offline source exclusion, never successful execution
// or blanket member/global-user immunity. Runtime consumers cannot install it.
export type SourceAbandonmentRow = {
  id: string;
  operationVersion: number;
  certificateId: string;
  semanticKey: string;
  ownerWebhookEventId: string;
  claimId: string;
  chatId: string;
  messageId: string;
  subjectUserId: string;
  sourceAt: Date;
  rawPayloadDigest: string;
  normalizedPayloadDigest: string;
  ownerSnapshot: Prisma.JsonValue;
  claimSnapshot: Prisma.JsonValue;
};
export type SourceAbandonmentCertificateRow = {
  id: string;
  operation: string;
  operationVersion: number;
  sourceSha: string;
  imageId: string;
  attestation: Prisma.JsonValue;
  attestationDigest: string;
  previewSha256: string;
  sourceClosureSha256: string;
  descendantsSha256: string;
  abandonBefore: Date;
  expectedSourceCount: number;
  expectedChildCount: number;
  sealedAt: Date | null;
};
