import { normalizePublisherAutoReplyTrigger } from './publisher-auto-reply-normalization';

const TOKEN_PATTERN = /[\p{L}\p{M}\p{N}]+/gu;
const FUZZY_CHARACTER_PATTERN = /[\p{L}\p{M}\p{N}]/u;
const FUZZY_YO_PATTERN = /ё/gu;

export const PUBLISHER_AUTO_REPLY_MATCHER_LIMITS = Object.freeze({
  messageCodePoints: 4_096,
  messageTokens: 256,
  candidates: 200,
  fuzzyCandidates: 50,
});

export type PublisherAutoReplyTriggerCandidate = {
  ruleId: string;
  triggerId: string;
  position: number;
  phrase: string;
  normalizedPhrase: string;
  matchInContext: boolean;
  fuzzyMatch: boolean;
};

export type PublisherAutoReplyMatchKind =
  | 'exact_full'
  | 'exact_context'
  | 'fuzzy_full'
  | 'fuzzy_context';

export type PublisherAutoReplyMatchWinner = {
  ruleId: string;
  triggerId: string;
  phrase: string;
  normalizedPhrase: string;
  matchKind: PublisherAutoReplyMatchKind;
  distance: number;
  position: number;
};

export type PublisherAutoReplyMatchResult =
  | { kind: 'no_match'; reason?: 'budget_exceeded' }
  | { kind: 'matched'; winner: PublisherAutoReplyMatchWinner }
  | { kind: 'ambiguous'; winners: PublisherAutoReplyMatchWinner[] };

export function arePublisherAutoReplyMatchDecisionsEqual(
  left: PublisherAutoReplyMatchResult,
  right: PublisherAutoReplyMatchResult,
): boolean {
  if (left.kind === 'matched' && right.kind === 'matched') {
    return sameWinner(left.winner, right.winner);
  }
  if (left.kind === 'ambiguous' && right.kind === 'ambiguous') {
    return (
      left.winners.length === right.winners.length &&
      left.winners.every((winner, index) => sameWinner(winner, right.winners[index]!))
    );
  }
  if (left.kind === 'no_match' && right.kind === 'no_match') {
    return left.reason === right.reason;
  }
  return false;
}

type PreparedCandidate = {
  source: PublisherAutoReplyTriggerCandidate;
  normalizedPhrase: string;
  tokens: string[];
  fuzzyText: string;
  fuzzyDistanceLimit: number | null;
  specificityLength: number;
};

type ScoredMatch = {
  winner: PublisherAutoReplyMatchWinner;
  rank: number;
  tokenCount: number;
  specificityLength: number;
};

const MATCH_KIND_RANK: Record<PublisherAutoReplyMatchKind, number> = {
  exact_full: 4,
  exact_context: 3,
  fuzzy_full: 2,
  fuzzy_context: 1,
};

export function matchPublisherAutoReply(
  message: string,
  candidates: readonly PublisherAutoReplyTriggerCandidate[],
): PublisherAutoReplyMatchResult {
  if (
    candidates.length > PUBLISHER_AUTO_REPLY_MATCHER_LIMITS.candidates ||
    exceedsCodePointLimit(message, PUBLISHER_AUTO_REPLY_MATCHER_LIMITS.messageCodePoints)
  ) {
    return budgetExceeded();
  }

  const normalizedMessage = normalizePublisherAutoReplyTrigger(message);
  if (
    exceedsCodePointLimit(normalizedMessage, PUBLISHER_AUTO_REPLY_MATCHER_LIMITS.messageCodePoints)
  ) {
    return budgetExceeded();
  }
  const messageTokens = tokenize(normalizedMessage);
  if (messageTokens.length > PUBLISHER_AUTO_REPLY_MATCHER_LIMITS.messageTokens) {
    return budgetExceeded();
  }

  const prepared = candidates
    .map(prepareCandidate)
    .filter((candidate): candidate is PreparedCandidate => candidate !== null);
  const exactMatches = collectExactMatches(normalizedMessage, messageTokens, prepared);
  if (exactMatches.length > 0) {
    return resolveMatches(exactMatches);
  }

  if (
    candidates.filter((candidate) => candidate.fuzzyMatch).length >
    PUBLISHER_AUTO_REPLY_MATCHER_LIMITS.fuzzyCandidates
  ) {
    return budgetExceeded();
  }

  return resolveMatches(collectFuzzyMatches(messageTokens, prepared));
}

function prepareCandidate(candidate: PublisherAutoReplyTriggerCandidate): PreparedCandidate | null {
  const normalizedPhrase = normalizePublisherAutoReplyTrigger(candidate.normalizedPhrase);
  if (!normalizedPhrase) {
    return null;
  }
  const tokens = tokenize(normalizedPhrase);
  const specificityLength = tokens.reduce((total, token) => total + countCodePoints(token), 0);
  return {
    source: candidate,
    normalizedPhrase,
    tokens,
    fuzzyText: tokens.map(normalizeForFuzzy).join(' '),
    fuzzyDistanceLimit: fuzzyDistanceLimit(tokens),
    specificityLength,
  };
}

function collectExactMatches(
  normalizedMessage: string,
  messageTokens: readonly string[],
  candidates: readonly PreparedCandidate[],
): ScoredMatch[] {
  const matches: ScoredMatch[] = [];
  for (const candidate of candidates) {
    if (normalizedMessage === candidate.normalizedPhrase) {
      matches.push(buildMatch(candidate, 'exact_full', 0));
      continue;
    }
    if (
      candidate.source.matchInContext &&
      candidate.tokens.length > 0 &&
      containsTokenSequence(messageTokens, candidate.tokens)
    ) {
      matches.push(buildMatch(candidate, 'exact_context', 0));
    }
  }
  return matches;
}

function collectFuzzyMatches(
  messageTokens: readonly string[],
  candidates: readonly PreparedCandidate[],
): ScoredMatch[] {
  const matches: ScoredMatch[] = [];
  const fuzzyMessageTokens = messageTokens.map(normalizeForFuzzy);
  const fuzzyMessage = fuzzyMessageTokens.join(' ');

  for (const candidate of candidates) {
    const limit = candidate.fuzzyDistanceLimit;
    if (!candidate.source.fuzzyMatch || limit === null || candidate.tokens.length === 0) {
      continue;
    }

    if (fuzzyMessageTokens.length === candidate.tokens.length) {
      const distance = boundedOsaDistance(fuzzyMessage, candidate.fuzzyText, limit);
      if (distance <= limit) {
        matches.push(buildMatch(candidate, 'fuzzy_full', distance));
      }
      continue;
    }
    if (!candidate.source.matchInContext || fuzzyMessageTokens.length < candidate.tokens.length) {
      continue;
    }

    const distance = closestWindowDistance(
      fuzzyMessageTokens,
      candidate.tokens.length,
      candidate.fuzzyText,
      limit,
    );
    if (distance <= limit) {
      matches.push(buildMatch(candidate, 'fuzzy_context', distance));
    }
  }
  return matches;
}

function closestWindowDistance(
  messageTokens: readonly string[],
  windowSize: number,
  phrase: string,
  limit: number,
): number {
  let best = limit + 1;
  for (let start = 0; start <= messageTokens.length - windowSize; start += 1) {
    const window = messageTokens.slice(start, start + windowSize).join(' ');
    const distance = boundedOsaDistance(window, phrase, limit);
    if (distance < best) {
      best = distance;
      if (best === 0) {
        break;
      }
    }
  }
  return best;
}

function buildMatch(
  candidate: PreparedCandidate,
  matchKind: PublisherAutoReplyMatchKind,
  distance: number,
): ScoredMatch {
  return {
    winner: {
      ruleId: candidate.source.ruleId,
      triggerId: candidate.source.triggerId,
      phrase: candidate.source.phrase,
      normalizedPhrase: candidate.normalizedPhrase,
      matchKind,
      distance,
      position: candidate.source.position,
    },
    rank: MATCH_KIND_RANK[matchKind],
    tokenCount: candidate.tokens.length,
    specificityLength: candidate.specificityLength,
  };
}

function resolveMatches(matches: readonly ScoredMatch[]): PublisherAutoReplyMatchResult {
  if (matches.length === 0) {
    return { kind: 'no_match' };
  }

  const bestByRule = new Map<string, ScoredMatch>();
  for (const match of matches) {
    const current = bestByRule.get(match.winner.ruleId);
    const quality = current ? compareQuality(match, current) : 1;
    if (quality > 0 || (quality === 0 && compareWinners(match.winner, current!.winner) < 0)) {
      bestByRule.set(match.winner.ruleId, match);
    }
  }

  const ruleMatches = [...bestByRule.values()];
  let best = ruleMatches[0]!;
  for (const match of ruleMatches.slice(1)) {
    if (compareQuality(match, best) > 0) {
      best = match;
    }
  }
  const tied = ruleMatches
    .filter((match) => compareQuality(match, best) === 0)
    .map((match) => match.winner)
    .sort(compareWinners);
  return tied.length === 1
    ? { kind: 'matched', winner: tied[0]! }
    : { kind: 'ambiguous', winners: tied };
}

function compareQuality(left: ScoredMatch, right: ScoredMatch): number {
  if (left.rank !== right.rank) {
    return left.rank - right.rank;
  }
  if (left.winner.distance !== right.winner.distance) {
    return right.winner.distance - left.winner.distance;
  }
  if (left.tokenCount !== right.tokenCount) {
    return left.tokenCount - right.tokenCount;
  }
  return left.specificityLength - right.specificityLength;
}

function compareWinners(
  left: PublisherAutoReplyMatchWinner,
  right: PublisherAutoReplyMatchWinner,
): number {
  return (
    compareStrings(left.ruleId, right.ruleId) ||
    left.position - right.position ||
    compareStrings(left.triggerId, right.triggerId) ||
    compareStrings(left.normalizedPhrase, right.normalizedPhrase) ||
    compareStrings(left.phrase, right.phrase)
  );
}

function sameWinner(
  left: PublisherAutoReplyMatchWinner,
  right: PublisherAutoReplyMatchWinner,
): boolean {
  return (
    left.ruleId === right.ruleId &&
    left.triggerId === right.triggerId &&
    left.matchKind === right.matchKind &&
    left.distance === right.distance &&
    left.position === right.position
  );
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function containsTokenSequence(
  messageTokens: readonly string[],
  phraseTokens: readonly string[],
): boolean {
  if (phraseTokens.length === 0 || phraseTokens.length > messageTokens.length) {
    return false;
  }
  for (let start = 0; start <= messageTokens.length - phraseTokens.length; start += 1) {
    let matched = true;
    for (let offset = 0; offset < phraseTokens.length; offset += 1) {
      if (messageTokens[start + offset] !== phraseTokens[offset]) {
        matched = false;
        break;
      }
    }
    if (matched) {
      return true;
    }
  }
  return false;
}

function tokenize(value: string): string[] {
  return value.match(TOKEN_PATTERN) ?? [];
}

function normalizeForFuzzy(value: string): string {
  return value.replace(FUZZY_YO_PATTERN, 'е');
}

function fuzzyDistanceLimit(tokens: readonly string[]): number | null {
  const alphanumericLength = tokens.reduce((total, token) => {
    let count = 0;
    for (const character of token) {
      if (FUZZY_CHARACTER_PATTERN.test(character)) {
        count += 1;
      }
    }
    return total + count;
  }, 0);
  if (alphanumericLength < 5) {
    return null;
  }
  if (alphanumericLength <= 9) {
    return 1;
  }
  if (alphanumericLength <= 19) {
    return 2;
  }
  return 3;
}

function boundedOsaDistance(leftValue: string, rightValue: string, limit: number): number {
  if (leftValue === rightValue) {
    return 0;
  }
  const left = [...leftValue];
  const right = [...rightValue];
  if (Math.abs(left.length - right.length) > limit) {
    return limit + 1;
  }

  let previousPrevious: number[] | null = null;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  const outsideBand = limit + 1;

  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = Array<number>(right.length + 1).fill(outsideBand);
    current[0] = leftIndex;
    const start = Math.max(1, leftIndex - limit);
    const end = Math.min(right.length, leftIndex + limit);

    for (let rightIndex = start; rightIndex <= end; rightIndex += 1) {
      const substitutionCost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
      current[rightIndex] = Math.min(
        previous[rightIndex]! + 1,
        current[rightIndex - 1]! + 1,
        previous[rightIndex - 1]! + substitutionCost,
      );
      if (
        previousPrevious &&
        leftIndex > 1 &&
        rightIndex > 1 &&
        left[leftIndex - 1] === right[rightIndex - 2] &&
        left[leftIndex - 2] === right[rightIndex - 1]
      ) {
        current[rightIndex] = Math.min(current[rightIndex]!, previousPrevious[rightIndex - 2]! + 1);
      }
    }
    previousPrevious = previous;
    previous = current;
  }

  return previous[right.length]! <= limit ? previous[right.length]! : limit + 1;
}

function exceedsCodePointLimit(value: string, limit: number): boolean {
  let count = 0;
  const codePoints = value[Symbol.iterator]();
  while (!codePoints.next().done) {
    count += 1;
    if (count > limit) {
      return true;
    }
  }
  return false;
}

function countCodePoints(value: string): number {
  return Array.from(value).length;
}

function budgetExceeded(): PublisherAutoReplyMatchResult {
  return { kind: 'no_match', reason: 'budget_exceeded' };
}
