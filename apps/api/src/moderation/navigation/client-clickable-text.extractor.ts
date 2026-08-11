import { LinkifyIt } from 'linkify-it';
import tlds from 'tlds';

import type {
  MaxNavigationContentView,
  MaxNavigationMessageView,
  PlainTextLinkCandidate,
} from './navigation-evidence.types';

const FORMAT_OR_CONTROL_PATTERN = /[\p{Cc}\p{Cf}]/u;
const NON_CLICKABLE_MARKUP_TYPES = new Set(['code', 'monospaced', 'pre']);
const STRUCTURED_NAVIGATION_MARKUP_TYPES = new Set(['link', 'user_mention']);
// IANA root-zone delta against the latest published `tlds` package, verified 2026-08-11.
const REMOVED_IANA_TLDS = new Set(['goo', 'wolterskluwer']);
const CURRENT_IANA_TLDS = [
  ...tlds.filter((value) => !REMOVED_IANA_TLDS.has(value.toLowerCase())),
  'merck',
  'web',
];

const linkifier = new LinkifyIt({
  fuzzyEmail: false,
  fuzzyIP: false,
  fuzzyLink: true,
  maxLength: 2_048,
})
  .tlds(CURRENT_IANA_TLDS)
  .add('ftp:', null)
  .add('mailto:', null);

export function extractClientClickableTextEvidence(
  view: MaxNavigationMessageView,
): PlainTextLinkCandidate[] {
  return [view.direct, view.visibleForward]
    .filter((content): content is MaxNavigationContentView => content !== null)
    .flatMap((content) => extractContentLinks(content));
}

function extractContentLinks(content: MaxNavigationContentView): PlainTextLinkCandidate[] {
  const nonNavigationUrls = new Set(
    content.nonNavigationUrls
      .map((value) => normalizeComparableUrl(value))
      .filter((value): value is string => value !== null),
  );
  const excludedRanges: Array<{ from: number; end: number }> = [];
  for (const markup of content.markup) {
    if (
      !markup.type ||
      (!NON_CLICKABLE_MARKUP_TYPES.has(markup.type) &&
        !STRUCTURED_NAVIGATION_MARKUP_TYPES.has(markup.type))
    ) {
      continue;
    }
    const malformedRangeInvalidatesPlainText = NON_CLICKABLE_MARKUP_TYPES.has(markup.type);
    const from = readSafeInteger(markup.from);
    const length = readSafeInteger(markup.length);
    if (from === null || length === null || from < 0 || length <= 0) {
      if (malformedRangeInvalidatesPlainText) {
        return [];
      }
      continue;
    }
    const end = from + length;
    if (end > content.text.length) {
      if (malformedRangeInvalidatesPlainText) {
        return [];
      }
      continue;
    }
    excludedRanges.push({ from, end });
  }

  return (linkifier.match(content.text) ?? []).flatMap((match) => {
    if (
      FORMAT_OR_CONTROL_PATTERN.test(match.raw) ||
      (match.schema !== '' && match.schema !== 'http:' && match.schema !== 'https:') ||
      excludedRanges.some((range) => match.index < range.end && match.lastIndex > range.from)
    ) {
      return [];
    }

    const target = normalizeClickableTarget(match.url, match.schema === '');
    if (!target || nonNavigationUrls.has(normalizeComparableUrl(target) ?? '')) {
      return [];
    }

    return [
      {
        provenance: content.provenance,
        target,
        from: match.index,
        length: match.lastIndex - match.index,
        sourcePath: `${content.path}.text`,
      },
    ];
  });
}

function normalizeComparableUrl(value: string): string | null {
  try {
    return new URL(value).toString();
  } catch {
    return null;
  }
}

function normalizeClickableTarget(normalizedUrl: string, inferredScheme: boolean): string | null {
  try {
    const parsed = new URL(normalizedUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    if (!parsed.hostname || parsed.username || parsed.password) {
      return null;
    }
    if (inferredScheme) {
      parsed.protocol = 'https:';
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

function readSafeInteger(value: unknown): number | null {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim()
        ? Number(value)
        : Number.NaN;
  return Number.isSafeInteger(parsed) ? parsed : null;
}
