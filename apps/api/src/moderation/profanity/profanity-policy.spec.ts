import {
  classifyProfanityVariant,
  createProfanityDecision,
  isProfanityCategoryEnabled,
  resolveProfanityRolloutMode,
  resolveProfanitySensitivity,
} from './profanity-policy';

describe('profanity policy', () => {
  it('resolves sensitivity with a safe BALANCED fallback', () => {
    expect(resolveProfanitySensitivity(undefined)).toBe('BALANCED');
    expect(resolveProfanitySensitivity({})).toBe('BALANCED');
    expect(resolveProfanitySensitivity({ profanitySensitivity: 'UNKNOWN' })).toBe('BALANCED');
    expect(resolveProfanitySensitivity({ profanitySensitivity: 'CORE_ONLY' })).toBe('CORE_ONLY');
    expect(resolveProfanitySensitivity({ profanitySensitivity: 'STRICT' })).toBe('STRICT');
  });

  it('defaults rollout to on and accepts only the explicit legacy switch', () => {
    expect(resolveProfanityRolloutMode({})).toBe('on');
    expect(resolveProfanityRolloutMode({ PROFANITY_V2_ROLLOUT_MODE: 'on' })).toBe('on');
    expect(resolveProfanityRolloutMode({ PROFANITY_V2_ROLLOUT_MODE: 'LEGACY' })).toBe('on');
    expect(resolveProfanityRolloutMode({ PROFANITY_V2_ROLLOUT_MODE: 'legacy' })).toBe('legacy');
  });

  it('assigns category scores and applies sensitivity gates', () => {
    expect(classifyProfanityVariant('блять', 'CORE_PATTERN')).toBe('CORE_MAT');
    expect(classifyProfanityVariant('мразь', 'EXACT_VARIANT')).toBe('SEVERE_ABUSE');
    expect(classifyProfanityVariant('скотина', 'EXACT_VARIANT')).toBe('MILD_INSULT');
    expect(classifyProfanityVariant('кретин', 'EXACT_VARIANT')).toBe('MILD_INSULT');
    expect(classifyProfanityVariant('лох', 'EXACT_VARIANT')).toBe('MILD_INSULT');
    expect(classifyProfanityVariant('валенок', 'TARGETED_VARIANT')).toBe('MILD_INSULT');
    expect(classifyProfanityVariant('дурак', 'TARGETED_VARIANT')).toBe('MILD_INSULT');
    expect(classifyProfanityVariant('чурка', 'TARGETED_VARIANT')).toBe('SEVERE_ABUSE');

    expect(isProfanityCategoryEnabled('CORE_MAT', 'CORE_ONLY', 'on', 'core:blyad')).toBe(true);
    expect(isProfanityCategoryEnabled('SEVERE_ABUSE', 'CORE_ONLY', 'on', 'exact:мраз')).toBe(false);
    expect(isProfanityCategoryEnabled('MILD_INSULT', 'BALANCED', 'on', 'exact:скотин')).toBe(false);
    expect(isProfanityCategoryEnabled('MILD_INSULT', 'STRICT', 'on', 'exact:скотин')).toBe(true);

    expect(
      createProfanityDecision({
        category: 'SEVERE_ABUSE',
        sensitivity: 'BALANCED',
        rolloutMode: 'on',
        familyId: 'exact:мраз',
        matchKind: 'EXACT_VARIANT',
        matchedVariant: 'мразь',
        evidence: ['TOKEN'],
      }).score,
    ).toBe(0.95);
    expect(
      createProfanityDecision({
        category: 'MILD_INSULT',
        sensitivity: 'STRICT',
        rolloutMode: 'legacy',
        familyId: 'exact:скотин',
        matchKind: 'EXACT_VARIANT',
        matchedVariant: 'скотина',
        evidence: ['TOKEN'],
      }).score,
    ).toBe(0.95);
  });
});
