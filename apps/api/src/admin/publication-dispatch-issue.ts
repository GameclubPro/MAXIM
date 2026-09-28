import type { PublicationDispatchIssue } from '@maxim/contracts/publication';

export type InternalPublicationDispatchIssue = PublicationDispatchIssue | 'decision_required';

export const PUBLISHER_ACTOR_ACCESS_BLOCKER_CODE = 'PUBLISHER_ACTOR_ACCESS_REQUIRED';
export const PUBLISHER_MISSED_WINDOW_BLOCKER_CODE = 'PUBLISHER_MISSED_WINDOW_REVIEW';
export const PUBLISHER_EXPLICIT_RETRY_CODE = 'PUBLISHER_EXPLICIT_RETRY';

const TARGET_SETUP_BLOCKERS = new Set([
  'POLICY_DISABLED',
  'BOT_NOT_CONNECTED',
  'CATALOG_UNCONFIRMED',
  'AUDIENCE_EMPTY',
  'BOT_ACCESS_UNCONFIRMED',
  'BOT_ACCESS_EXPIRED',
  'BOT_NOT_ADMIN',
  'WRITE_PERMISSION_MISSING',
  'MODULE_DISABLED',
  'PUBLISHER_SETUP_REQUIRED',
  'PUBLISHER_BOT_CHANGED',
]);

export type PublicationDispatchBlockerRow = {
  publicationId: string;
  occurrenceId: string;
  blockerCode: string;
};

export type PublicationDispatchIssueIndex = {
  byPublicationId: Map<string, InternalPublicationDispatchIssue>;
  byOccurrenceId: Map<string, InternalPublicationDispatchIssue>;
};

export function emptyPublicationDispatchIssueIndex(): PublicationDispatchIssueIndex {
  return {
    byPublicationId: new Map(),
    byOccurrenceId: new Map(),
  };
}

export function resolvePublicationDispatchIssue(
  blockerCodes: readonly (string | null | undefined)[],
): InternalPublicationDispatchIssue | null {
  const normalized = blockerCodes
    .map((code) => code?.trim().toUpperCase() ?? '')
    .filter((code) => Boolean(code) && code !== PUBLISHER_EXPLICIT_RETRY_CODE);
  if (normalized.includes(PUBLISHER_MISSED_WINDOW_BLOCKER_CODE)) return 'decision_required';
  if (normalized.includes(PUBLISHER_ACTOR_ACCESS_BLOCKER_CODE)) {
    return 'actor_access_required';
  }
  if (normalized.some((code) => TARGET_SETUP_BLOCKERS.has(code))) {
    return 'target_setup_required';
  }
  return normalized.length > 0 ? 'temporarily_unavailable' : null;
}

export function buildPublicationDispatchIssueIndex(
  rows: readonly PublicationDispatchBlockerRow[],
): PublicationDispatchIssueIndex {
  const codesByPublicationId = new Map<string, string[]>();
  const codesByOccurrenceId = new Map<string, string[]>();
  for (const row of rows) {
    const blockerCode = row.blockerCode.trim();
    if (!blockerCode) {
      continue;
    }
    const publicationCodes = codesByPublicationId.get(row.publicationId) ?? [];
    publicationCodes.push(blockerCode);
    codesByPublicationId.set(row.publicationId, publicationCodes);
    const occurrenceCodes = codesByOccurrenceId.get(row.occurrenceId) ?? [];
    occurrenceCodes.push(blockerCode);
    codesByOccurrenceId.set(row.occurrenceId, occurrenceCodes);
  }

  const index = emptyPublicationDispatchIssueIndex();
  for (const [publicationId, blockerCodes] of codesByPublicationId) {
    const issue = resolvePublicationDispatchIssue(blockerCodes);
    if (issue) {
      index.byPublicationId.set(publicationId, issue);
    }
  }
  for (const [occurrenceId, blockerCodes] of codesByOccurrenceId) {
    const issue = resolvePublicationDispatchIssue(blockerCodes);
    if (issue) {
      index.byOccurrenceId.set(occurrenceId, issue);
    }
  }
  return index;
}
