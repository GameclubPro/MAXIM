export type TextLinkSegment =
  | {
      type: 'text';
      text: string;
    }
  | {
      type: 'link';
      text: string;
      href: string;
    };

type UrlMatch = {
  start: number;
  end: number;
  text: string;
};

const SCHEME_URL_PATTERN = /\b(?:https?:\/\/|max:\/\/)[^\s<>"'`]+/giu;
const BARE_URL_PATTERN =
  /(^|[^\p{L}\p{N}@/])((?:[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?\.)+(?:[a-z]{2,24}|рф)(?::\d{2,5})?(?:[/?#][^\s<>"'`]*)?)/giu;
const TRAILING_URL_PUNCTUATION_PATTERN = /[),.;!?]+$/u;
const EXPLICIT_URL_SCHEME_PATTERN = /^(?:https?:\/\/|max:\/\/)/iu;

function createSchemeUrlRegex(): RegExp {
  return new RegExp(SCHEME_URL_PATTERN);
}

function createBareUrlRegex(): RegExp {
  return new RegExp(BARE_URL_PATTERN);
}

function trimTrailingUrlPunctuation(value: string): string {
  return value.trim().replace(TRAILING_URL_PUNCTUATION_PATTERN, '');
}

function normalizeHref(value: string): string {
  return EXPLICIT_URL_SCHEME_PATTERN.test(value) ? value : `https://${value}`;
}

function rangesOverlap(left: UrlMatch, right: UrlMatch): boolean {
  return left.start < right.end && right.start < left.end;
}

function isLikelyNumberedListItem(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || EXPLICIT_URL_SCHEME_PATTERN.test(trimmed)) {
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

function collectSchemeMatches(value: string): UrlMatch[] {
  const matches: UrlMatch[] = [];

  for (const match of value.matchAll(createSchemeUrlRegex())) {
    const raw = match[0];
    const text = trimTrailingUrlPunctuation(raw);
    if (!text) {
      continue;
    }

    const start = match.index ?? 0;
    matches.push({
      start,
      end: start + text.length,
      text,
    });
  }

  return matches;
}

function collectBareMatches(value: string): UrlMatch[] {
  const matches: UrlMatch[] = [];

  for (const match of value.matchAll(createBareUrlRegex())) {
    const prefix = match[1] ?? '';
    const raw = match[2] ?? '';
    const text = trimTrailingUrlPunctuation(raw);
    if (!text || isLikelyNumberedListItem(text)) {
      continue;
    }

    const start = (match.index ?? 0) + prefix.length;
    matches.push({
      start,
      end: start + text.length,
      text,
    });
  }

  return matches;
}

function collectUrlMatches(value: string): UrlMatch[] {
  const schemeMatches = collectSchemeMatches(value);
  const bareMatches = collectBareMatches(value).filter(
    (candidate) => !schemeMatches.some((existing) => rangesOverlap(candidate, existing)),
  );

  return [...schemeMatches, ...bareMatches].sort((left, right) => left.start - right.start);
}

export function tokenizeTextLinks(value: string): TextLinkSegment[] {
  if (!value) {
    return [];
  }

  const matches = collectUrlMatches(value);
  if (matches.length === 0) {
    return [{ type: 'text', text: value }];
  }

  const segments: TextLinkSegment[] = [];
  let cursor = 0;

  for (const match of matches) {
    if (match.start > cursor) {
      segments.push({ type: 'text', text: value.slice(cursor, match.start) });
    }

    segments.push({
      type: 'link',
      text: match.text,
      href: normalizeHref(match.text),
    });
    cursor = match.end;
  }

  if (cursor < value.length) {
    segments.push({ type: 'text', text: value.slice(cursor) });
  }

  return segments;
}
