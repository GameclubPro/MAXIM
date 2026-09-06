import type { ChatSettings } from '../../prisma/prisma-client';
import { MessageLimitsBlockedDomainDetector } from '../rule-engine-blocked-domains.detector';
import { MessageLimitsBlockedWordDetector } from '../rule-engine-blocked-words.detector';
import type { CommercialOcrPass } from './commercial-ocr-decision-policy';

export const IMAGE_TEXT_STOP_LIST_MIN_CONFIDENCE_PERMILLE = 900;
export const IMAGE_TEXT_STOP_LIST_POLICY_VERSION = 'image-text-stop-list-v1';

export type ImageTextStopListSettings = Pick<
  ChatSettings,
  'messageLimitsBlockedWords' | 'messageLimitsBlockedDomains'
>;

export type ImageTextStopListPasses = Readonly<{
  imageIndex: number;
  primary: CommercialOcrPass;
  confirmation?: CommercialOcrPass | null;
}>;

export type ImageTextStopListDecision =
  | Readonly<{ kind: 'no_action' }>
  | Readonly<{
      kind: 'match';
      ruleCode: 'MESSAGE_BLOCKED_WORD' | 'MESSAGE_BLOCKED_DOMAIN';
      value: string;
      imageIndex: number;
      primaryConfidencePermille: number;
      confirmationConfidencePermille: number;
    }>;

type ImageTextStopListPassMatch = Pick<
  Extract<ImageTextStopListDecision, { kind: 'match' }>,
  'ruleCode' | 'value'
>;

const blockedWordDetector = new MessageLimitsBlockedWordDetector();
const blockedDomainDetector = new MessageLimitsBlockedDomainDetector();

/**
 * Requires two independent OCR passes to agree on the same configured stop-list value.
 * Recognized source text deliberately never leaves this decision boundary.
 */
export function evaluateImageTextStopListDecision(params: {
  settings: ImageTextStopListSettings;
  images: readonly ImageTextStopListPasses[];
  isLinkAllowlisted?: (link: string) => boolean;
}): ImageTextStopListDecision {
  for (const image of params.images) {
    const confirmation = image.confirmation;
    if (!confirmation) {
      continue;
    }

    const primaryMatches = resolveEligiblePassMatches(
      image.primary,
      params.settings,
      params.isLinkAllowlisted,
    );
    if (primaryMatches.length === 0) {
      continue;
    }

    const confirmationMatches = resolveEligiblePassMatches(
      confirmation,
      params.settings,
      params.isLinkAllowlisted,
    );
    const confirmationKeys = new Set(confirmationMatches.map(matchKey));
    const agreedMatch = primaryMatches.find((match) => confirmationKeys.has(matchKey(match)));
    if (!agreedMatch) {
      continue;
    }

    return {
      kind: 'match',
      ruleCode: agreedMatch.ruleCode,
      value: agreedMatch.value,
      imageIndex: image.imageIndex,
      primaryConfidencePermille: image.primary.confidencePermille,
      confirmationConfidencePermille: confirmation.confidencePermille,
    };
  }

  return { kind: 'no_action' };
}

export function shouldConfirmImageTextStopListPass(
  pass: CommercialOcrPass,
  settings: ImageTextStopListSettings,
  isLinkAllowlisted?: (link: string) => boolean,
): boolean {
  return resolveEligiblePassMatches(pass, settings, isLinkAllowlisted).length > 0;
}

function isEligiblePass(pass: CommercialOcrPass): boolean {
  return (
    pass.status === 'recognized' &&
    pass.text.trim().length > 0 &&
    Number.isSafeInteger(pass.confidencePermille) &&
    pass.confidencePermille >= IMAGE_TEXT_STOP_LIST_MIN_CONFIDENCE_PERMILLE &&
    pass.confidencePermille <= 1_000
  );
}

function resolveEligiblePassMatches(
  pass: CommercialOcrPass,
  settings: ImageTextStopListSettings,
  isLinkAllowlisted?: (link: string) => boolean,
): ImageTextStopListPassMatch[] {
  if (!isEligiblePass(pass)) {
    return [];
  }
  const trustedSegments = buildHighConfidenceTextSegments(pass);
  if (!trustedSegments) {
    return [];
  }
  const matches = trustedSegments.flatMap((text) =>
    detectPassMatches(text, settings, isLinkAllowlisted),
  );
  return [...new Map(matches.map((match) => [matchKey(match), match])).values()];
}

function buildHighConfidenceTextSegments(pass: CommercialOcrPass): string[] | null {
  if (!Array.isArray(pass.words) || pass.words.length === 0 || pass.words.length > 1_024) {
    return null;
  }
  let previousEnd = 0;
  for (const word of pass.words) {
    if (
      !word ||
      typeof word.text !== 'string' ||
      word.text.length === 0 ||
      word.text.length > 256 ||
      !Number.isSafeInteger(word.start) ||
      !Number.isSafeInteger(word.end) ||
      word.start < previousEnd ||
      word.end <= word.start ||
      word.end > pass.text.length ||
      pass.text.slice(word.start, word.end) !== word.text ||
      !Number.isSafeInteger(word.confidencePermille) ||
      word.confidencePermille < 0 ||
      word.confidencePermille > 1_000
    ) {
      return null;
    }
    previousEnd = word.end;
  }
  // Tesseract offsets use UTF-16 units. Every alphanumeric token must be backed by a word span;
  // otherwise untrusted text outside the bounded word list could influence a decision.
  const covered = new Uint8Array(pass.text.length);
  for (const word of pass.words) {
    covered.fill(1, word.start, word.end);
  }
  for (const match of pass.text.matchAll(/[\p{L}\p{N}]+/gu)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    for (let index = start; index < end; index += 1) {
      if (covered[index] !== 1) return null;
    }
  }
  const segments: string[] = [];
  let segmentStart = 0;
  for (const word of pass.words) {
    if (word.confidencePermille >= IMAGE_TEXT_STOP_LIST_MIN_CONFIDENCE_PERMILLE) continue;
    const segment = pass.text.slice(segmentStart, word.start).trim();
    if (segment) segments.push(segment);
    segmentStart = word.end;
  }
  const finalSegment = pass.text.slice(segmentStart).trim();
  if (finalSegment) segments.push(finalSegment);
  return segments;
}

function detectPassMatches(
  text: string,
  settings: ImageTextStopListSettings,
  isLinkAllowlisted?: (link: string) => boolean,
): ImageTextStopListPassMatch[] {
  return [
    ...blockedWordDetector
      .detectAll(text, settings.messageLimitsBlockedWords)
      .map((match) => ({
        ruleCode: 'MESSAGE_BLOCKED_WORD' as const,
        value: match.blockedWord,
      })),
    ...blockedDomainDetector
      .detectAll(
        text,
        settings.messageLimitsBlockedDomains,
        isLinkAllowlisted ? { isLinkAllowlisted } : {},
      )
      .map((match) => ({
        ruleCode: 'MESSAGE_BLOCKED_DOMAIN' as const,
        value: match.blockedDomain,
      })),
  ];
}

function matchKey(match: ImageTextStopListPassMatch): string {
  return `${match.ruleCode}\0${match.value}`;
}
