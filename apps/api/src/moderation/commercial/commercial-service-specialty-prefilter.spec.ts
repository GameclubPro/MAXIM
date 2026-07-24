import { RegExpParser } from '@eslint-community/regexpp';
import type { AST } from '@eslint-community/regexpp';

import { ADS_SERVICE_SPECIALTY_PATTERNS } from './commercial-patterns';
import {
  SERVICE_SPECIALTY_REQUIRED_VOCABULARY,
  selectServiceSpecialtyPatterns,
} from './commercial-service-specialty-prefilter';

const parser = new RegExpParser({ ecmaVersion: 2024 });

function containsRequiredLiteral(value: string, requiredVocabulary: readonly string[]): boolean {
  const lowered = value.toLowerCase();
  return requiredVocabulary.some((token) => lowered.includes(token));
}

function alternativeRequiresVocabulary(
  alternative: AST.Alternative,
  requiredVocabulary: readonly string[],
): boolean {
  let literalRun = '';
  const flushLiteralRun = (): boolean => {
    const hit = containsRequiredLiteral(literalRun, requiredVocabulary);
    literalRun = '';
    return hit;
  };

  for (const element of alternative.elements) {
    if (element.type === 'Character') {
      literalRun += String.fromCodePoint(element.value);
      continue;
    }
    if (flushLiteralRun() || elementRequiresVocabulary(element, requiredVocabulary)) {
      return true;
    }
  }

  return flushLiteralRun();
}

function alternativesRequireVocabulary(
  alternatives: readonly AST.Alternative[],
  requiredVocabulary: readonly string[],
): boolean {
  return alternatives.every((alternative) =>
    alternativeRequiresVocabulary(alternative, requiredVocabulary),
  );
}

function elementRequiresVocabulary(
  element: AST.Element,
  requiredVocabulary: readonly string[],
): boolean {
  if (element.type === 'Group' || element.type === 'CapturingGroup') {
    return alternativesRequireVocabulary(element.alternatives, requiredVocabulary);
  }
  if (element.type === 'Quantifier') {
    return element.min > 0 && elementRequiresVocabulary(element.element, requiredVocabulary);
  }
  if (element.type === 'Assertion' && element.kind === 'lookahead' && !element.negate) {
    return alternativesRequireVocabulary(element.alternatives, requiredVocabulary);
  }
  return false;
}

describe('service specialty prefilter', () => {
  it('covers every specialty label and proves its vocabulary mandatory for every regex path', () => {
    const labels = [...new Set(ADS_SERVICE_SPECIALTY_PATTERNS.map(({ label }) => label))].sort();
    expect(Object.keys(SERVICE_SPECIALTY_REQUIRED_VOCABULARY).sort()).toEqual(labels);

    for (const { label, pattern } of ADS_SERVICE_SPECIALTY_PATTERNS) {
      const requiredVocabulary = SERVICE_SPECIALTY_REQUIRED_VOCABULARY[label];
      const parsed = parser.parsePattern(pattern.source, 0, pattern.source.length, {
        unicode: pattern.unicode,
        unicodeSets: pattern.flags.includes('v'),
      });

      expect({
        label,
        everyRegexPathRequiresVocabulary: alternativesRequireVocabulary(
          parsed.alternatives,
          requiredVocabulary,
        ),
      }).toEqual({ label, everyRegexPathRequiresVocabulary: true });
    }
  });

  it('checks raw and normalized text and retains unknown labels conservatively', () => {
    const patterns = [
      ADS_SERVICE_SPECIALTY_PATTERNS.find(({ label }) => label === 'banquet-hall-catalog')!,
      { label: 'future-specialty', pattern: /future/u },
    ];

    expect(selectServiceSpecialtyPatterns(patterns, 'обычный текст', 'банкетный зал')).toEqual(
      patterns,
    );
    expect(selectServiceSpecialtyPatterns(patterns, 'банкетный зал', 'обычный текст')).toEqual(
      patterns,
    );
    expect(selectServiceSpecialtyPatterns(patterns, 'обычный текст', 'обычный текст')).toEqual([
      patterns[1],
    ]);
  });
});
