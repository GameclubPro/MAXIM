const URL_DELIMITER_PATTERN = /[\s<>"'`()[\]{}]/u;
const SCHEME_URL_PATTERN = /https?:\/\/[^\s<>"'`()[\]{}]+/giu;
const BARE_URL_PATTERN =
  /(?<![@\p{L}\p{N}\p{Cf}])(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?\.)+(?:xn--[a-z0-9-]{2,59}|[a-z]{2,24}|рф)(?:[/?#][^\s<>"'`()[\]{}]+)?/giu;
const TRAILING_URL_PUNCTUATION_PATTERN = /[)\]},.;!?:]+$/u;

type UrlMatch = {
  start: number;
  end: number;
  text: string;
};

function createSchemeUrlRegex(): RegExp {
  return new RegExp(SCHEME_URL_PATTERN);
}

function createBareUrlRegex(): RegExp {
  return new RegExp(BARE_URL_PATTERN);
}

function normalizeMatchedUrl(value: string): string {
  return value.trim().replace(TRAILING_URL_PUNCTUATION_PATTERN, '');
}

function collectMatches(value: string, regex: RegExp): UrlMatch[] {
  const matches: UrlMatch[] = [];

  for (const match of value.matchAll(regex)) {
    const raw = match[0];
    const text = normalizeMatchedUrl(raw);
    if (!text) {
      continue;
    }

    const start = match.index ?? 0;
    matches.push({
      start,
      end: start + raw.length,
      text,
    });
  }

  return matches;
}

function rangesOverlap(left: UrlMatch, right: UrlMatch): boolean {
  return left.start < right.end && right.start < left.end;
}

function isContainedWithin(left: UrlMatch, right: UrlMatch): boolean {
  return left.start >= right.start && left.end <= right.end;
}

function endsAtUrlDelimiter(value: string, index: number): boolean {
  if (index >= value.length) {
    return true;
  }

  return URL_DELIMITER_PATTERN.test(value[index] ?? '');
}

function isLikelyNumberedListItem(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || /^https?:\/\//iu.test(trimmed)) {
    return false;
  }

  const hostEnd = trimmed.search(/[/?#]/u);
  const host = hostEnd === -1 ? trimmed : trimmed.slice(0, hostEnd);
  const parts = host.split('.');
  if (parts.length !== 2) {
    return false;
  }

  return /^\d+$/u.test(parts[0]);
}

function collectUrlMatches(value: string): UrlMatch[] {
  const schemeMatches = collectMatches(value, createSchemeUrlRegex());
  const bareMatches = collectMatches(value, createBareUrlRegex()).filter(
    (candidate) =>
      !schemeMatches.some(
        (existing) => rangesOverlap(candidate, existing) && isContainedWithin(candidate, existing),
      ) &&
      !isLikelyNumberedListItem(candidate.text),
  );

  return [...schemeMatches, ...bareMatches]
    .filter((candidate) => endsAtUrlDelimiter(value, candidate.end))
    .sort((left, right) => left.start - right.start || right.end - left.end);
}

export function extractUrlsFromText(value: string): string[] {
  if (!value || value.trim().length === 0) {
    return [];
  }

  const seen = new Set<string>();
  const extracted: string[] = [];

  for (const match of collectUrlMatches(value)) {
    if (seen.has(match.text)) {
      continue;
    }

    seen.add(match.text);
    extracted.push(match.text);
  }

  return extracted;
}

export function stripUrlsFromText(value: string): string {
  if (!value) {
    return '';
  }

  const matches = collectUrlMatches(value);
  if (matches.length === 0) {
    return value.replace(/\s+/g, ' ').trim();
  }

  let cursor = 0;
  let result = '';

  for (const match of matches) {
    if (match.end <= cursor) {
      continue;
    }

    result += value.slice(cursor, match.start);
    result += ' ';
    cursor = match.end;
  }

  result += value.slice(cursor);
  return result.replace(/\s+/g, ' ').trim();
}
