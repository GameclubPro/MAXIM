import type { CommercialOcrPass } from '../commercial-ocr-decision-policy';
import {
  criticalTokenAppearsInTranscript,
  type CommercialOcrEvalCaseV2,
} from './commercial-ocr-eval.schema';

export type CommercialOcrEvalQualityCounts = {
  expectedPasses: number;
  attemptedPasses: number;
  failedPasses: number;
  expectedPrimaryPasses: number;
  attemptedPrimaryPasses: number;
  failedPrimaryPasses: number;
  expectedConfirmationPasses: number;
  attemptedConfirmationPasses: number;
  failedConfirmationPasses: number;
  characterEdits: number;
  characterReferenceLength: number;
  wordEdits: number;
  wordReferenceLength: number;
  criticalTokens: number;
  criticalTokensMatchedPrimary: number;
  criticalTokensMatchedConfirmation: number;
  criticalTokensMatchedBoth: number;
  confidenceObservations: number;
  absoluteConfidenceCalibrationErrorPermille: number;
  highConfidencePasses: number;
  highConfidenceSevereErrorPasses: number;
};

export type CommercialOcrEvalQualityMetrics = CommercialOcrEvalQualityCounts & {
  characterErrorRate: number;
  wordErrorRate: number;
  criticalTokenRecall: number;
  meanAbsoluteConfidenceCalibrationError: number;
  highConfidenceSevereErrorRate: number;
};

export type CommercialOcrEvalAttemptedPass = CommercialOcrPass | null | undefined;

export function evaluateCommercialOcrEvalCaseQuality(params: {
  fixture: CommercialOcrEvalCaseV2;
  passes: readonly Readonly<{
    primary: CommercialOcrEvalAttemptedPass;
    confirmation: CommercialOcrEvalAttemptedPass;
  }>[];
}): CommercialOcrEvalQualityMetrics {
  const counts = emptyCommercialOcrEvalQualityCounts();
  for (let imageIndex = 0; imageIndex < params.fixture.images.length; imageIndex += 1) {
    const image = params.fixture.images[imageIndex]!;
    const passes = params.passes[imageIndex];
    counts.expectedPasses += 2;
    counts.expectedPrimaryPasses += 1;
    counts.expectedConfirmationPasses += 1;
    recordPassQuality(counts, image.transcript, passes?.primary, 'primary');
    recordPassQuality(counts, image.transcript, passes?.confirmation, 'confirmation');

    for (const token of image.criticalTokens) {
      counts.criticalTokens += 1;
      const primaryMatched = passContainsCriticalToken(passes?.primary, token);
      const confirmationMatched = passContainsCriticalToken(passes?.confirmation, token);
      if (primaryMatched) counts.criticalTokensMatchedPrimary += 1;
      if (confirmationMatched) counts.criticalTokensMatchedConfirmation += 1;
      if (primaryMatched && confirmationMatched) counts.criticalTokensMatchedBoth += 1;
    }
  }
  return summarizeCommercialOcrEvalQuality(counts);
}

export function aggregateCommercialOcrEvalQuality(
  observations: readonly CommercialOcrEvalQualityCounts[],
): CommercialOcrEvalQualityMetrics {
  const counts = emptyCommercialOcrEvalQualityCounts();
  for (const observation of observations) {
    for (const key of QUALITY_COUNT_KEYS) {
      counts[key] += observation[key];
    }
  }
  return summarizeCommercialOcrEvalQuality(counts);
}

export function emptyCommercialOcrEvalQualityCounts(): CommercialOcrEvalQualityCounts {
  return {
    expectedPasses: 0,
    attemptedPasses: 0,
    failedPasses: 0,
    expectedPrimaryPasses: 0,
    attemptedPrimaryPasses: 0,
    failedPrimaryPasses: 0,
    expectedConfirmationPasses: 0,
    attemptedConfirmationPasses: 0,
    failedConfirmationPasses: 0,
    characterEdits: 0,
    characterReferenceLength: 0,
    wordEdits: 0,
    wordReferenceLength: 0,
    criticalTokens: 0,
    criticalTokensMatchedPrimary: 0,
    criticalTokensMatchedConfirmation: 0,
    criticalTokensMatchedBoth: 0,
    confidenceObservations: 0,
    absoluteConfidenceCalibrationErrorPermille: 0,
    highConfidencePasses: 0,
    highConfidenceSevereErrorPasses: 0,
  };
}

const QUALITY_COUNT_KEYS = Object.freeze(
  Object.keys(emptyCommercialOcrEvalQualityCounts()) as Array<keyof CommercialOcrEvalQualityCounts>,
);

function recordPassQuality(
  target: CommercialOcrEvalQualityCounts,
  transcript: string,
  pass: CommercialOcrEvalAttemptedPass,
  passName: 'primary' | 'confirmation',
): void {
  if (pass === undefined) return;
  target.attemptedPasses += 1;
  if (passName === 'primary') target.attemptedPrimaryPasses += 1;
  else target.attemptedConfirmationPasses += 1;
  if (pass === null || pass.status === 'failed') {
    target.failedPasses += 1;
    if (passName === 'primary') target.failedPrimaryPasses += 1;
    else target.failedConfirmationPasses += 1;
  }
  const referenceCharacters = qualityCharacters(transcript);
  const hypothesisCharacters = qualityCharacters(pass?.status === 'recognized' ? pass.text : '');
  const characterEdits = levenshteinDistance(referenceCharacters, hypothesisCharacters);
  const characterReferenceLength = Math.max(1, referenceCharacters.length);
  target.characterEdits += characterEdits;
  target.characterReferenceLength += characterReferenceLength;

  const referenceWords = qualityWords(transcript);
  const hypothesisWords = qualityWords(pass?.status === 'recognized' ? pass.text : '');
  target.wordEdits += levenshteinDistance(referenceWords, hypothesisWords);
  target.wordReferenceLength += Math.max(1, referenceWords.length);

  if (pass?.status !== 'recognized') return;
  const boundedCharacterAccuracy = 1 - Math.min(1, characterEdits / characterReferenceLength);
  target.confidenceObservations += 1;
  target.absoluteConfidenceCalibrationErrorPermille += Math.round(
    Math.abs(pass.confidencePermille / 1_000 - boundedCharacterAccuracy) * 1_000,
  );
  if (pass.confidencePermille >= 900) {
    target.highConfidencePasses += 1;
    if (characterEdits / characterReferenceLength > 0.5) {
      target.highConfidenceSevereErrorPasses += 1;
    }
  }
}

function passContainsCriticalToken(
  pass: CommercialOcrEvalAttemptedPass,
  token: CommercialOcrEvalCaseV2['images'][number]['criticalTokens'][number],
): boolean {
  return Boolean(
    pass?.status === 'recognized' && criticalTokenAppearsInTranscript(token, pass.text),
  );
}

function summarizeCommercialOcrEvalQuality(
  counts: CommercialOcrEvalQualityCounts,
): CommercialOcrEvalQualityMetrics {
  return {
    ...counts,
    characterErrorRate: ratio(counts.characterEdits, counts.characterReferenceLength),
    wordErrorRate: ratio(counts.wordEdits, counts.wordReferenceLength),
    criticalTokenRecall: ratio(counts.criticalTokensMatchedBoth, counts.criticalTokens),
    meanAbsoluteConfidenceCalibrationError: ratio(
      counts.absoluteConfidenceCalibrationErrorPermille,
      counts.confidenceObservations * 1_000,
    ),
    highConfidenceSevereErrorRate: ratio(
      counts.highConfidenceSevereErrorPasses,
      counts.highConfidencePasses,
    ),
  };
}

function qualityCharacters(value: string): string[] {
  return Array.from(
    value.normalize('NFKC').toLocaleLowerCase('ru-RU').replace(/\s+/gu, ' ').trim(),
  );
}

function qualityWords(value: string): string[] {
  return Array.from(
    value
      .normalize('NFKC')
      .toLocaleLowerCase('ru-RU')
      .matchAll(/[\p{L}\p{N}]+/gu),
    (match) => match[0],
  );
}

function levenshteinDistance<T>(left: readonly T[], right: readonly T[]): number {
  if (left.length < right.length) return levenshteinDistance(right, left);
  if (right.length === 0) return left.length;

  // Myers' bit-vector algorithm keeps exact distance practical for the schema's long transcripts.
  const patternBits = BigInt(right.length);
  const fullMask = (1n << patternBits) - 1n;
  const highBit = 1n << (patternBits - 1n);
  const equalityMasks = new Map<T, bigint>();
  for (let index = 0; index < right.length; index += 1) {
    const bit = 1n << BigInt(index);
    equalityMasks.set(right[index]!, (equalityMasks.get(right[index]!) ?? 0n) | bit);
  }
  let positive = fullMask;
  let negative = 0n;
  let score = right.length;
  for (const token of left) {
    const equal = equalityMasks.get(token) ?? 0n;
    const vertical = equal | negative;
    const horizontal = ((((equal & positive) + positive) ^ positive) | equal) & fullMask;
    let positiveHorizontal = (negative | ~(horizontal | positive)) & fullMask;
    let negativeHorizontal = positive & horizontal & fullMask;
    if ((positiveHorizontal & highBit) !== 0n) score += 1;
    else if ((negativeHorizontal & highBit) !== 0n) score -= 1;
    positiveHorizontal = ((positiveHorizontal << 1n) | 1n) & fullMask;
    negativeHorizontal = (negativeHorizontal << 1n) & fullMask;
    positive = (negativeHorizontal | ~(vertical | positiveHorizontal)) & fullMask;
    negative = positiveHorizontal & vertical & fullMask;
  }
  return score;
}

function ratio(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}
