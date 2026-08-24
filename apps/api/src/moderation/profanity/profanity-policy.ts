import {
  PROFANITY_CATEGORY_SCORES,
  PROFANITY_DETECTOR_VERSION,
  PROFANITY_SENSITIVITIES,
  type ProfanityCategory,
  type ProfanityDetectionDecision,
  type ProfanityEvidence,
  type ProfanityMatchKind,
  type ProfanityRolloutMode,
  type ProfanitySensitivity,
} from './profanity.types';

const MILD_EXACT_VARIANT_PATTERNS = [
  /^(?:скотин|скотск|засран|придур|кретин|лох|хамл|дрян|недоум)/u,
  /^(?:skotin|skotsk|zasran|pridur|kretin|loh|lokh|haml|dryan|nedoum)/u,
] as const;
const SEVERE_TARGETED_VARIANT_PATTERNS = [
  /^(?:даун|аутист|психопат|шиз|нарик|наркоман|алкаш|алкогол|петух|макак|обезьян|чурк|шкур)/u,
  /^(?:daun|autist|psihopat|psyhopat|shiz|nark|alkash|alkogol|petuh|makak|obezyan|churk|shkur)/u,
] as const;
const V2_ONLY_FAMILY_IDS = new Set(['targeted:вален', 'targeted:valen']);
const MAX_STORED_MATCHED_VARIANT_LENGTH = 64;

export function resolveProfanitySensitivity(settings: unknown): ProfanitySensitivity {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    return 'BALANCED';
  }

  const value = (settings as Record<string, unknown>).profanitySensitivity;
  return typeof value === 'string' &&
    PROFANITY_SENSITIVITIES.includes(value as ProfanitySensitivity)
    ? (value as ProfanitySensitivity)
    : 'BALANCED';
}

export function resolveProfanityRolloutMode(
  env: Readonly<Record<string, string | undefined>> = process.env,
): ProfanityRolloutMode {
  return env.PROFANITY_V2_ROLLOUT_MODE === 'legacy' ? 'legacy' : 'on';
}

export function classifyProfanityVariant(
  matchedVariant: string,
  matchKind: ProfanityMatchKind,
): ProfanityCategory {
  if (matchKind === 'CORE_PATTERN') {
    return 'CORE_MAT';
  }

  if (matchKind === 'TARGETED_VARIANT') {
    return SEVERE_TARGETED_VARIANT_PATTERNS.some((pattern) => pattern.test(matchedVariant))
      ? 'SEVERE_ABUSE'
      : 'MILD_INSULT';
  }

  if (MILD_EXACT_VARIANT_PATTERNS.some((pattern) => pattern.test(matchedVariant))) {
    return 'MILD_INSULT';
  }

  return 'SEVERE_ABUSE';
}

export function isProfanityCategoryEnabled(
  category: ProfanityCategory,
  sensitivity: ProfanitySensitivity,
  rolloutMode: ProfanityRolloutMode,
  familyId: string,
): boolean {
  if (rolloutMode === 'legacy') {
    return !V2_ONLY_FAMILY_IDS.has(familyId);
  }
  if (category === 'CORE_MAT') {
    return true;
  }
  if (category === 'SEVERE_ABUSE') {
    return sensitivity !== 'CORE_ONLY';
  }
  return sensitivity === 'STRICT';
}

export function createProfanityDecision(params: {
  category: ProfanityCategory;
  sensitivity: ProfanitySensitivity;
  rolloutMode: ProfanityRolloutMode;
  familyId: string;
  matchKind: ProfanityMatchKind;
  matchedVariant: string;
  evidence: ProfanityEvidence[];
}): ProfanityDetectionDecision {
  return {
    ...params,
    matchedVariant: params.matchedVariant.slice(0, MAX_STORED_MATCHED_VARIANT_LENGTH),
    score: params.rolloutMode === 'legacy' ? 0.95 : PROFANITY_CATEGORY_SCORES[params.category],
    detectorVersion: PROFANITY_DETECTOR_VERSION,
  };
}
