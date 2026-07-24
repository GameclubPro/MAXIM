import { stripUrlsFromText } from '../../common/url-text.util';
import { COMMERCIAL_ENGINE_CONFIG } from './commercial-config';
import {
  normalizeCommercialConfusables,
  normalizeCommercialRawText,
  normalizeCommercialText,
} from './commercial-normalization';
import { ADS_SPECIAL_TOKEN_MATCHERS } from './commercial-patterns';

export type CommercialMarkerContext = {
  normalizedTextWithoutUrls: string;
  normalizedConfusableTextWithoutUrls: string;
  rawLoweredTextWithoutUrls: string;
  normalizedTokensWithoutUrls: string[];
};

export type CommercialTextMatcher = {
  context: CommercialMarkerContext;
  hasMarker(marker: string): boolean;
  matchesPattern(pattern: RegExp): boolean;
};

type NormalizedCommercialMarker = {
  normalizedMarker: string;
  rawLoweredMarker: string;
  tokenOnly: boolean;
  specialTokenMatcher: RegExp | undefined;
};

export type CommercialTextMatcherOptions = {
  rawLoweredTextIsCommercialNormalized?: boolean;
};

const COMMERCIAL_MARKER_TOKEN_PATTERN = /^[\p{L}\p{N}]+$/u;
const normalizedCommercialMarkerCache = new Map<string, NormalizedCommercialMarker>();

export function createCommercialTextMatcher(
  normalizedText: string,
  rawLoweredText: string,
  options: CommercialTextMatcherOptions = {},
): CommercialTextMatcher {
  const context = buildCommercialMarkerContext(normalizedText, rawLoweredText, options);
  const markerCache = new Map<string, boolean>();
  const patternCache = new WeakMap<RegExp, boolean>();

  return {
    context,
    hasMarker(marker: string): boolean {
      const cached = markerCache.get(marker);
      if (cached !== undefined) {
        return cached;
      }

      const hit = hasCommercialMarker(marker, context);
      markerCache.set(marker, hit);
      return hit;
    },
    matchesPattern(pattern: RegExp): boolean {
      const cached = patternCache.get(pattern);
      if (cached !== undefined) {
        return cached;
      }

      const hit = matchesCommercialPattern(pattern, context);
      patternCache.set(pattern, hit);
      return hit;
    },
  };
}

export function buildCommercialMarkerContext(
  normalizedText: string,
  rawLoweredText: string,
  options: CommercialTextMatcherOptions = {},
): CommercialMarkerContext {
  const commercialRawLoweredText = options.rawLoweredTextIsCommercialNormalized
    ? rawLoweredText
    : normalizeCommercialRawText(rawLoweredText);
  const rawLoweredTextWithoutUrls = stripUrlsFromText(commercialRawLoweredText);
  const rawLoweredTextWithoutUrlsNormalized = options.rawLoweredTextIsCommercialNormalized
    ? rawLoweredTextWithoutUrls
    : normalizeCommercialConfusables(rawLoweredTextWithoutUrls);
  const normalizedTextWithoutUrls =
    rawLoweredTextWithoutUrls === rawLoweredText
      ? normalizedText
      : normalizeCommercialText(rawLoweredTextWithoutUrls);
  const normalizedTextWithRawConfusables =
    rawLoweredTextWithoutUrlsNormalized === rawLoweredTextWithoutUrls
      ? normalizedTextWithoutUrls
      : normalizeCommercialText(rawLoweredTextWithoutUrlsNormalized);
  const hasDistinctConfusableText = normalizedTextWithRawConfusables !== normalizedTextWithoutUrls;
  const normalizedTokensWithoutUrls = [
    ...(normalizedTextWithoutUrls.match(/[\p{L}\p{N}]+/gu) ?? []),
    ...(hasDistinctConfusableText
      ? (normalizedTextWithRawConfusables.match(/[\p{L}\p{N}]+/gu) ?? [])
      : []),
  ];

  return {
    normalizedTextWithoutUrls,
    normalizedConfusableTextWithoutUrls: hasDistinctConfusableText
      ? normalizedTextWithRawConfusables
      : '',
    rawLoweredTextWithoutUrls,
    normalizedTokensWithoutUrls,
  };
}

export function hasCommercialMarker(marker: string, context: CommercialMarkerContext): boolean {
  const { normalizedMarker, rawLoweredMarker, tokenOnly, specialTokenMatcher } =
    getNormalizedCommercialMarker(marker);
  if (!normalizedMarker) {
    return false;
  }

  if (specialTokenMatcher) {
    return context.normalizedTokensWithoutUrls.some((token) =>
      testCommercialPattern(specialTokenMatcher, token),
    );
  }

  if (tokenOnly) {
    return context.normalizedTokensWithoutUrls.some((token) => token.startsWith(normalizedMarker));
  }

  return (
    context.normalizedTextWithoutUrls.includes(normalizedMarker) ||
    (context.normalizedConfusableTextWithoutUrls !== '' &&
      context.normalizedConfusableTextWithoutUrls.includes(normalizedMarker)) ||
    context.rawLoweredTextWithoutUrls.includes(rawLoweredMarker)
  );
}

function getNormalizedCommercialMarker(marker: string): NormalizedCommercialMarker {
  const cached = normalizedCommercialMarkerCache.get(marker);
  if (cached) {
    return cached;
  }

  const normalizedMarker = normalizeCommercialText(marker);
  const normalized = {
    normalizedMarker,
    rawLoweredMarker: marker.toLowerCase(),
    tokenOnly: COMMERCIAL_MARKER_TOKEN_PATTERN.test(normalizedMarker),
    specialTokenMatcher: ADS_SPECIAL_TOKEN_MATCHERS.get(normalizedMarker),
  };
  normalizedCommercialMarkerCache.set(marker, normalized);
  return normalized;
}

export function matchesCommercialPattern(
  pattern: RegExp,
  context: CommercialMarkerContext,
): boolean {
  const shouldTestRawText =
    context.rawLoweredTextWithoutUrls !== context.normalizedTextWithoutUrls &&
    context.rawLoweredTextWithoutUrls !== context.normalizedConfusableTextWithoutUrls;

  return (
    testCommercialPattern(pattern, context.normalizedTextWithoutUrls) ||
    (context.normalizedConfusableTextWithoutUrls !== '' &&
      testCommercialPattern(pattern, context.normalizedConfusableTextWithoutUrls)) ||
    (shouldTestRawText && testCommercialPattern(pattern, context.rawLoweredTextWithoutUrls))
  );
}

export function collectFirstMarkers(
  markers: readonly string[],
  predicate: (marker: string) => boolean,
  limit: number,
): string[] {
  const hits: string[] = [];
  for (const marker of markers) {
    if (hits.length >= limit) {
      break;
    }
    if (predicate(marker) && !hits.includes(marker)) {
      hits.push(marker);
    }
  }
  return hits;
}

export function collectFirstPatternLabels(
  patterns: readonly { label: string; pattern: RegExp }[],
  predicate: (pattern: RegExp) => boolean,
  limit: number,
  seed: readonly string[] = [],
): string[] {
  const hits = [...seed];
  for (const { label, pattern } of patterns) {
    if (hits.length >= limit) {
      break;
    }
    if (!hits.includes(label) && predicate(pattern)) {
      hits.push(label);
    }
  }
  return hits;
}

export function countPatternMatches(
  value: string,
  pattern: RegExp,
  limit: number = COMMERCIAL_ENGINE_CONFIG.secondStage.countLimits.defaultPatternMatches,
): number {
  if (!value || limit <= 0) {
    return 0;
  }

  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  const matcher = new RegExp(pattern.source, flags);
  let count = 0;

  while (count < limit && matcher.exec(value)) {
    count += 1;
  }

  return count;
}

export function hasPriceLikeText(value: string): boolean {
  return /(?:₽|руб|(?:^|[\s.,:;()/%+-])(?:\d(?:\uFE0F?\u20E3)?(?:[\d\s.,]|\uFE0F|\u20E3)*)р(?:$|[^\p{L}\p{N}_-])|₸|\$|€|💵|цен|стоимост|прайс)/iu.test(
    value,
  );
}

function testCommercialPattern(pattern: RegExp, value: string): boolean {
  if (!pattern.global && !pattern.sticky) {
    return pattern.test(value);
  }

  pattern.lastIndex = 0;
  const hit = pattern.test(value);
  pattern.lastIndex = 0;
  return hit;
}
