import { createHash } from 'node:crypto';
import type { AuthUser } from '../common/decorators/current-user.decorator';

export const PUBLISHER_SUGGESTION_REVIEW_PROTOCOL = 'publik_publication_v1';
export const PUBLISHER_SUGGESTION_DISPATCH_PROFILE = 'PUBLIK_V1';
export const PUBLISHER_SUGGESTION_LEGACY_INLINE_STALE_MS = 15 * 60_000;

export type PublisherSuggestionReviewClaim = {
  action: 'publish' | 'draft';
  claimToken: string;
  claimedAt: string;
  requestId: string;
  user: AuthUser;
};

export type LegacyPublisherSuggestionInlineClaim = {
  claimedAt: string;
  claimedByUserId: string;
  requestId: string;
};

export function buildPublisherSuggestionPublicationRequestId(
  suggestionId: string,
  claimToken: string,
): string {
  return `psg_${createHash('sha256')
    .update(`${suggestionId}\0${claimToken}`)
    .digest('hex')
    .slice(0, 32)}`;
}

export function buildLegacyPublisherSuggestionPublicationRequestId(suggestionId: string): string {
  return `psg_${createHash('sha256').update(suggestionId).digest('hex').slice(0, 32)}`;
}

export function isPublisherSuggestionReviewProtocol(payload: Record<string, unknown>): boolean {
  return readString(payload.reviewPublicationProtocol) === PUBLISHER_SUGGESTION_REVIEW_PROTOCOL;
}

export function readLegacyPublisherSuggestionInlineClaim(
  payload: Record<string, unknown>,
  suggestionId: string,
  nowMs = Date.now(),
): LegacyPublisherSuggestionInlineClaim | null {
  if (
    readString(payload.reviewStatus)?.toLowerCase() !== 'publishing' ||
    payload.reviewPublicationProtocol != null
  ) {
    return null;
  }
  const claimedAt = readIsoDateString(payload.reviewedAt);
  const claimedByUserId = readString(payload.reviewedByUserId);
  if (
    !claimedAt ||
    !claimedByUserId ||
    new Date(claimedAt).getTime() > nowMs - PUBLISHER_SUGGESTION_LEGACY_INLINE_STALE_MS
  ) {
    return null;
  }
  return {
    claimedAt,
    claimedByUserId,
    requestId: buildLegacyPublisherSuggestionPublicationRequestId(suggestionId),
  };
}

export function readPublisherSuggestionReviewClaim(
  payload: Record<string, unknown>,
  suggestionId: string,
  options: { allowPending?: boolean } = {},
): PublisherSuggestionReviewClaim | null {
  const reviewStatus = readString(payload.reviewStatus)?.toLowerCase();
  if (
    (reviewStatus !== 'publishing' &&
      !(options.allowPending === true && reviewStatus === 'pending')) ||
    payload.reviewDispatchProfile !== PUBLISHER_SUGGESTION_DISPATCH_PROFILE ||
    !isPublisherSuggestionReviewProtocol(payload)
  ) {
    return null;
  }

  const action = readString(payload.reviewAction)?.toLowerCase();
  if (action !== 'publish' && action !== 'draft') {
    return null;
  }

  const claimToken = readString(payload.reviewClaimToken);
  const claimedAt = readIsoDateString(payload.reviewClaimedAt);
  const claimedByUserId = readString(payload.reviewClaimedByUserId);
  const requestId = readString(payload.reviewPublicationRequestId);
  const expectedRequestId = buildPublisherSuggestionPublicationRequestId(
    suggestionId,
    claimToken ?? '',
  );
  const migratedLegacyRequestId =
    payload.reviewClaimMigratedFrom === 'inline_v0'
      ? buildLegacyPublisherSuggestionPublicationRequestId(suggestionId)
      : null;
  if (
    !claimToken ||
    !claimedAt ||
    !claimedByUserId ||
    !requestId ||
    (requestId !== expectedRequestId && requestId !== migratedLegacyRequestId)
  ) {
    return null;
  }

  return {
    action,
    claimToken,
    claimedAt,
    requestId,
    user: {
      userId: claimedByUserId,
      username: readNullableString(payload.reviewClaimedByUsername),
      displayName: readNullableString(payload.reviewClaimedByDisplayName),
      avatarUrl: readNullableString(payload.reviewClaimedByAvatarUrl),
      profileUrl: readNullableString(payload.reviewClaimedByProfileUrl),
    },
  };
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function readNullableString(value: unknown): string | null {
  return value == null ? null : readString(value);
}

function readIsoDateString(value: unknown): string | null {
  const normalized = readString(value);
  if (!normalized) return null;
  return Number.isFinite(new Date(normalized).getTime()) ? normalized : null;
}
