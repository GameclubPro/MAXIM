export type CommercialOcrLetterScript = 'cyrillic_only' | 'latin_only' | 'mixed' | 'unknown';

export type CommercialOcrLetterScriptAnalysis = Readonly<{
  letterScript: CommercialOcrLetterScript;
  cyrillicLetterCount: number;
  latinLetterCount: number;
  otherLetterCount: number;
}>;

const UNICODE_LETTER_PATTERN = /\p{Letter}/u;
const CYRILLIC_SCRIPT_PATTERN = /\p{Script=Cyrillic}/u;
const LATIN_SCRIPT_PATTERN = /\p{Script=Latin}/u;

export function classifyCommercialOcrLetterScript(text: string): CommercialOcrLetterScriptAnalysis {
  let cyrillicLetterCount = 0;
  let latinLetterCount = 0;
  let otherLetterCount = 0;
  for (const character of text.normalize('NFKC')) {
    if (!UNICODE_LETTER_PATTERN.test(character)) continue;
    if (CYRILLIC_SCRIPT_PATTERN.test(character)) {
      cyrillicLetterCount += 1;
    } else if (LATIN_SCRIPT_PATTERN.test(character)) {
      latinLetterCount += 1;
    } else {
      otherLetterCount += 1;
    }
  }

  const populatedScripts = [cyrillicLetterCount, latinLetterCount, otherLetterCount].filter(
    (count) => count > 0,
  ).length;
  const letterScript: CommercialOcrLetterScript =
    populatedScripts > 1
      ? 'mixed'
      : cyrillicLetterCount > 0
        ? 'cyrillic_only'
        : latinLetterCount > 0
          ? 'latin_only'
          : 'unknown';
  return { letterScript, cyrillicLetterCount, latinLetterCount, otherLetterCount };
}
