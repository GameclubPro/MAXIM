import type { ChannelSettings } from '@maxim/contracts';
import { createHash } from 'node:crypto';

import {
  buildMaxActionChannelSuggestionPublicationJobId,
  isMaxActionChannelSuggestionPublicationLedger,
  MAX_ACTION_CHANNEL_SUGGESTION_PUBLICATION_LEDGER_PREFIX,
  MAX_ACTION_CHANNEL_SUGGESTION_PUBLICATION_SOURCE_TAG,
} from '../max/max-action-ledger-keys';
import type { MaxMessageButton } from '../max/max-client.service';
import type { ChannelSuggestionAuthorAttribution } from './admin.service.support';

export const CHANNEL_SUGGESTION_PUBLICATION_PROTOCOL_V1 = 'max_action_ledger_v1';
export const CHANNEL_SUGGESTION_PUBLICATION_LEDGER_PREFIX =
  MAX_ACTION_CHANNEL_SUGGESTION_PUBLICATION_LEDGER_PREFIX;
export const CHANNEL_SUGGESTION_PUBLICATION_SOURCE_TAG =
  MAX_ACTION_CHANNEL_SUGGESTION_PUBLICATION_SOURCE_TAG;
export const CHANNEL_SUGGESTION_PUBLICATION_CLAIM_STALE_MS = 15 * 60_000;
const CHANNEL_SUGGESTION_PUBLICATION_CONTEXT_MAX_BYTES = 64 * 1_024;

export type ChannelSuggestionPublicationClaimV1 = {
  protocol: typeof CHANNEL_SUGGESTION_PUBLICATION_PROTOCOL_V1;
  ledgerJobId: string;
  claimToken: string;
  claimedAt: string;
  claimedByUserId: string;
  claimedByDisplayName: string | null;
};

export type ChannelSuggestionPublicationContextV1 = {
  protocol: typeof CHANNEL_SUGGESTION_PUBLICATION_PROTOCOL_V1;
  preparedAt: string;
  messageDigest: string;
  contextDigest: string;
  botId: string;
  threadId: string | null;
  buttons: MaxMessageButton[][];
  includeCommentsButton: boolean;
  includeSuggestButton: boolean;
  suggestButtonText: string | null;
  suggestionEntryMode: ChannelSettings['postSuggestionsEntryMode'];
  authorAttribution: ChannelSuggestionAuthorAttribution;
};

export type ChannelSuggestionPublicationLedgerRow = {
  jobId: string;
  actionType: string;
  chatId: string;
  sourceTag: string | null;
  status: string;
  ambiguous: boolean;
  terminal: boolean;
  dispatchToken: string | null;
  dispatchStartedAt: Date | null;
  dispatchBotId: string | null;
  remoteMessageId: string | null;
  metadata: unknown;
};

export type ChannelSuggestionPublicationLedgerBindingV1 = {
  suggestionId: string;
  publicationProtocol: typeof CHANNEL_SUGGESTION_PUBLICATION_PROTOCOL_V1;
  claimToken: string;
  actorUserId: string;
  messageDigest: string;
  contextDigest: string;
};

export type ChannelSuggestionPublicationLedgerAuditDecision =
  | 'linked_publishing'
  | 'missing_audit'
  | 'pending_audit'
  | 'published_audit'
  | 'mismatched_audit';

export type ChannelSuggestionPublicationRecoveryDecision =
  | {
      kind: 'manual';
      reason:
        | 'legacy'
        | 'ledger_mismatch'
        | 'dispatch_ambiguous'
        | 'context_missing'
        | 'context_without_ledger';
    }
  | { kind: 'waiting'; claim: ChannelSuggestionPublicationClaimV1 }
  | {
      kind: 'release_pre_dispatch';
      claim: ChannelSuggestionPublicationClaimV1;
      ledger: ChannelSuggestionPublicationLedgerRow | null;
    }
  | {
      kind: 'completed';
      claim: ChannelSuggestionPublicationClaimV1;
      context: ChannelSuggestionPublicationContextV1;
      ledger: ChannelSuggestionPublicationLedgerRow & {
        dispatchBotId: string;
        remoteMessageId: string;
      };
    };

export function buildChannelSuggestionPublicationLedgerJobId(suggestionId: string): string {
  return buildMaxActionChannelSuggestionPublicationJobId(suggestionId);
}

export function readChannelSuggestionPublicationClaimV1(
  payload: Record<string, unknown>,
  suggestionId: string,
): ChannelSuggestionPublicationClaimV1 | null {
  if (
    readLowerString(payload.reviewStatus) !== 'publishing' ||
    readLowerString(payload.reviewAction) !== 'publish' ||
    readString(payload.reviewPublicationProtocol) !== CHANNEL_SUGGESTION_PUBLICATION_PROTOCOL_V1
  ) {
    return null;
  }

  const ledgerJobId = readString(payload.reviewPublicationLedgerJobId);
  const expectedLedgerJobId = buildChannelSuggestionPublicationLedgerJobId(suggestionId);
  const claimToken = readString(payload.reviewClaimToken);
  const claimedAt = readIsoDateString(payload.reviewClaimedAt);
  const claimedByUserId = readString(payload.reviewClaimedByUserId);
  if (ledgerJobId !== expectedLedgerJobId || !claimToken || !claimedAt || !claimedByUserId) {
    return null;
  }

  return {
    protocol: CHANNEL_SUGGESTION_PUBLICATION_PROTOCOL_V1,
    ledgerJobId,
    claimToken,
    claimedAt,
    claimedByUserId,
    claimedByDisplayName: readString(payload.reviewClaimedByDisplayName),
  };
}

export function readChannelSuggestionPublicationContextV1(
  payload: Record<string, unknown>,
): ChannelSuggestionPublicationContextV1 | null {
  const raw = readRecord(payload.reviewPublicationContext);
  if (!raw || readString(raw.protocol) !== CHANNEL_SUGGESTION_PUBLICATION_PROTOCOL_V1) {
    return null;
  }
  try {
    if (
      Buffer.byteLength(JSON.stringify(raw), 'utf8') >
      CHANNEL_SUGGESTION_PUBLICATION_CONTEXT_MAX_BYTES
    ) {
      return null;
    }
  } catch {
    return null;
  }

  const preparedAt = readIsoDateString(raw.preparedAt);
  const messageDigest = readSha256(raw.messageDigest);
  const contextDigest = readSha256(raw.contextDigest);
  const botId = readString(raw.botId);
  const buttons = readButtonRows(raw.buttons);
  const author = readRecord(raw.authorAttribution);
  const authorUserId = readString(author?.userId);
  const suggestionEntryMode =
    raw.suggestionEntryMode === 'MINIAPP'
      ? 'MINIAPP'
      : raw.suggestionEntryMode === 'BOT'
        ? 'BOT'
        : null;
  if (
    !preparedAt ||
    !messageDigest ||
    !contextDigest ||
    !botId ||
    !buttons ||
    !author ||
    !authorUserId ||
    typeof raw.includeCommentsButton !== 'boolean' ||
    typeof raw.includeSuggestButton !== 'boolean' ||
    !suggestionEntryMode
  ) {
    return null;
  }
  const threadId = readNullableString(raw.threadId);
  const suggestButtonText = readNullableString(raw.suggestButtonText);
  const expectedButtonRows = Number(raw.includeCommentsButton) + Number(raw.includeSuggestButton);
  if (
    (expectedButtonRows > 0 && (!threadId || buttons.length !== expectedButtonRows)) ||
    (expectedButtonRows === 0 && (threadId !== null || buttons.length !== 0)) ||
    (raw.includeSuggestButton === true && !suggestButtonText) ||
    (raw.includeSuggestButton === false && suggestButtonText !== null)
  ) {
    return null;
  }

  const contextWithoutDigest: Omit<ChannelSuggestionPublicationContextV1, 'contextDigest'> = {
    protocol: CHANNEL_SUGGESTION_PUBLICATION_PROTOCOL_V1,
    preparedAt,
    messageDigest,
    botId,
    threadId,
    buttons,
    includeCommentsButton: raw.includeCommentsButton,
    includeSuggestButton: raw.includeSuggestButton,
    suggestButtonText,
    suggestionEntryMode,
    authorAttribution: {
      userId: authorUserId,
      displayName: readNullableString(author.displayName),
      mentionDisplayName: readNullableString(author.mentionDisplayName),
      username: readNullableString(author.username),
      profileUrl: readNullableString(author.profileUrl),
    },
  };
  if (buildChannelSuggestionPublicationContextDigest(contextWithoutDigest) !== contextDigest) {
    return null;
  }
  return { ...contextWithoutDigest, contextDigest };
}

export function withChannelSuggestionPublicationContextDigest(
  context: Omit<ChannelSuggestionPublicationContextV1, 'contextDigest'>,
): ChannelSuggestionPublicationContextV1 {
  return {
    ...context,
    contextDigest: buildChannelSuggestionPublicationContextDigest(context),
  };
}

export function buildChannelSuggestionPublicationContextDigest(
  context: Omit<ChannelSuggestionPublicationContextV1, 'contextDigest'>,
): string {
  const canonical = {
    protocol: context.protocol,
    preparedAt: context.preparedAt,
    messageDigest: context.messageDigest,
    botId: context.botId,
    threadId: context.threadId,
    buttons: context.buttons,
    includeCommentsButton: context.includeCommentsButton,
    includeSuggestButton: context.includeSuggestButton,
    suggestButtonText: context.suggestButtonText,
    suggestionEntryMode: context.suggestionEntryMode,
    authorAttribution: {
      userId: context.authorAttribution.userId,
      displayName: context.authorAttribution.displayName,
      mentionDisplayName: context.authorAttribution.mentionDisplayName,
      username: context.authorAttribution.username,
      profileUrl: context.authorAttribution.profileUrl,
    },
  };
  return createHash('sha256').update(stableJsonStringify(canonical)).digest('hex');
}

export function readChannelSuggestionPublicationLedgerBindingV1(
  metadata: unknown,
): ChannelSuggestionPublicationLedgerBindingV1 | null {
  const ledgerContext = readRecord(readRecord(metadata)?.ledgerContext);
  const suggestionId = readString(ledgerContext?.suggestionId);
  const publicationProtocol = readString(ledgerContext?.publicationProtocol);
  const claimToken = readString(ledgerContext?.claimToken);
  const actorUserId = readString(ledgerContext?.actorUserId);
  const messageDigest = readSha256(ledgerContext?.messageDigest);
  const contextDigest = readSha256(ledgerContext?.contextDigest);
  if (
    !suggestionId ||
    publicationProtocol !== CHANNEL_SUGGESTION_PUBLICATION_PROTOCOL_V1 ||
    !claimToken ||
    !actorUserId ||
    !messageDigest ||
    !contextDigest
  ) {
    return null;
  }
  return {
    suggestionId,
    publicationProtocol: CHANNEL_SUGGESTION_PUBLICATION_PROTOCOL_V1,
    claimToken,
    actorUserId,
    messageDigest,
    contextDigest,
  };
}

export function classifyChannelSuggestionPublicationRecovery(params: {
  payload: Record<string, unknown>;
  suggestionId: string;
  chatId: string;
  actorUserId: string;
  ledger: ChannelSuggestionPublicationLedgerRow | null;
  nowMs?: number;
}): ChannelSuggestionPublicationRecoveryDecision {
  const claim = readChannelSuggestionPublicationClaimV1(params.payload, params.suggestionId);
  if (!claim) {
    return { kind: 'manual', reason: 'legacy' };
  }

  const ledger = params.ledger;
  if (ledger && !isOwnedSuggestionPublicationLedger(ledger, claim, params.chatId)) {
    return { kind: 'manual', reason: 'ledger_mismatch' };
  }

  if (ledger?.remoteMessageId) {
    const context = readChannelSuggestionPublicationContextV1(params.payload);
    const binding = readChannelSuggestionPublicationLedgerBindingV1(ledger.metadata);
    const dispatchBotId = readString(ledger.dispatchBotId);
    if (
      !context ||
      !binding ||
      !dispatchBotId ||
      context.botId !== dispatchBotId ||
      context.authorAttribution.userId !== params.actorUserId ||
      binding.suggestionId !== params.suggestionId ||
      binding.claimToken !== claim.claimToken ||
      binding.actorUserId !== params.actorUserId ||
      binding.messageDigest !== context.messageDigest ||
      binding.contextDigest !== context.contextDigest
    ) {
      return { kind: 'manual', reason: 'context_missing' };
    }
    return {
      kind: 'completed',
      claim,
      context,
      ledger: {
        ...ledger,
        dispatchBotId,
        remoteMessageId: ledger.remoteMessageId,
      },
    };
  }

  if (
    ledger?.ambiguous ||
    ledger?.status === 'AMBIGUOUS' ||
    Boolean(ledger?.dispatchToken) ||
    Boolean(ledger?.dispatchStartedAt) ||
    Boolean(ledger?.dispatchBotId)
  ) {
    return { kind: 'manual', reason: 'dispatch_ambiguous' };
  }

  if (!ledger && readChannelSuggestionPublicationContextV1(params.payload)) {
    // A context is written only after the durable dispatch fence. Its presence without
    // that ledger row cannot prove that MAX was never called (including legacy fallback).
    return { kind: 'manual', reason: 'context_without_ledger' };
  }

  const nowMs = params.nowMs ?? Date.now();
  if (nowMs - new Date(claim.claimedAt).getTime() < CHANNEL_SUGGESTION_PUBLICATION_CLAIM_STALE_MS) {
    return { kind: 'waiting', claim };
  }

  return { kind: 'release_pre_dispatch', claim, ledger };
}

export function isVersionedChannelSuggestionPublicationLedger(params: {
  jobId: string;
  actionType: string;
  sourceTag: string | null;
}): boolean {
  return isMaxActionChannelSuggestionPublicationLedger(params);
}

export function classifyChannelSuggestionPublicationLedgerAudit(params: {
  ledger: ChannelSuggestionPublicationLedgerRow;
  audit: {
    id: string;
    chatId: string;
    actorUserId: string;
    action: string;
    payload: Record<string, unknown>;
  } | null;
}): ChannelSuggestionPublicationLedgerAuditDecision {
  const audit = params.audit;
  if (!audit) {
    return 'missing_audit';
  }
  const expectedJobId = buildChannelSuggestionPublicationLedgerJobId(audit.id);
  if (
    audit.action !== 'CHANNEL_DIALOG_SUGGESTION' ||
    readLowerString(audit.payload.type) !== 'suggest' ||
    params.ledger.jobId !== expectedJobId ||
    params.ledger.actionType !== 'SEND_MESSAGE' ||
    params.ledger.chatId !== audit.chatId ||
    params.ledger.sourceTag !== CHANNEL_SUGGESTION_PUBLICATION_SOURCE_TAG
  ) {
    return 'mismatched_audit';
  }

  const reviewStatus = readLowerString(audit.payload.reviewStatus) ?? 'pending';
  if (reviewStatus === 'pending') {
    return 'pending_audit';
  }
  if (reviewStatus === 'publishing') {
    const recovery = classifyChannelSuggestionPublicationRecovery({
      payload: audit.payload,
      suggestionId: audit.id,
      chatId: audit.chatId,
      actorUserId: audit.actorUserId,
      ledger: params.ledger,
    });
    return recovery.kind === 'manual' ? 'mismatched_audit' : 'linked_publishing';
  }
  if (reviewStatus !== 'published') {
    return 'mismatched_audit';
  }

  const context = readChannelSuggestionPublicationContextV1(audit.payload);
  const binding = readChannelSuggestionPublicationLedgerBindingV1(params.ledger.metadata);
  const publishedMessageId = readString(audit.payload.publishedMessageId);
  if (
    readString(audit.payload.reviewPublicationProtocol) !==
      CHANNEL_SUGGESTION_PUBLICATION_PROTOCOL_V1 ||
    readString(audit.payload.reviewPublicationLedgerJobId) !== expectedJobId ||
    params.ledger.status !== 'SUCCEEDED' ||
    params.ledger.ambiguous ||
    !params.ledger.terminal ||
    !context ||
    !binding ||
    !publishedMessageId ||
    publishedMessageId !== params.ledger.remoteMessageId ||
    context.botId !== readString(params.ledger.dispatchBotId) ||
    context.authorAttribution.userId !== audit.actorUserId ||
    binding.suggestionId !== audit.id ||
    binding.actorUserId !== audit.actorUserId ||
    binding.messageDigest !== context.messageDigest ||
    binding.contextDigest !== context.contextDigest
  ) {
    return 'mismatched_audit';
  }
  return 'published_audit';
}

function readButtonRows(value: unknown): MaxMessageButton[][] | null {
  if (!Array.isArray(value) || value.length > 20) {
    return null;
  }

  const rows: MaxMessageButton[][] = [];
  for (const rawRow of value) {
    if (!Array.isArray(rawRow) || rawRow.length === 0 || rawRow.length > 20) {
      return null;
    }
    const row: MaxMessageButton[] = [];
    for (const rawButton of rawRow) {
      const button = readRecord(rawButton);
      if (!button || !readString(button.type) || !readString(button.text)) {
        return null;
      }
      row.push({ ...button } as MaxMessageButton);
    }
    rows.push(row);
  }
  return rows;
}

function isOwnedSuggestionPublicationLedger(
  ledger: ChannelSuggestionPublicationLedgerRow,
  claim: ChannelSuggestionPublicationClaimV1,
  chatId: string,
): boolean {
  return (
    ledger.jobId === claim.ledgerJobId &&
    ledger.actionType === 'SEND_MESSAGE' &&
    ledger.chatId === chatId &&
    ledger.sourceTag === CHANNEL_SUGGESTION_PUBLICATION_SOURCE_TAG
  );
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readNullableString(value: unknown): string | null {
  return value == null ? null : readString(value);
}

function readLowerString(value: unknown): string | null {
  return readString(value)?.toLowerCase() ?? null;
}

function readIsoDateString(value: unknown): string | null {
  const normalized = readString(value);
  if (!normalized) {
    return null;
  }
  const parsed = new Date(normalized);
  return Number.isFinite(parsed.getTime()) ? normalized : null;
}

function readSha256(value: unknown): string | null {
  const normalized = readString(value)?.toLowerCase() ?? null;
  return normalized && /^[a-f0-9]{64}$/u.test(normalized) ? normalized : null;
}

function stableJsonStringify(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? JSON.stringify(value) : 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJsonStringify(item)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJsonStringify(record[key])}`);
    return `{${entries.join(',')}}`;
  }
  return 'null';
}
