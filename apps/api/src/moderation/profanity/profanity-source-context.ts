import { replaceUrlsInText } from '../../common/url-text.util';

export type ProfanitySourceCandidate = {
  value: string;
  joined: boolean;
  rawValue?: string;
  rawIndex?: number;
  rawEnd?: number;
};

const EMAIL_PATTERN =
  /(?<![\p{L}\p{N}._%+-])[a-z0-9._%+-]{1,64}@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}(?![\p{L}\p{N}-])/giu;
const LITERAL_LATIN_TERM =
  /^(?:ebit(?:da)?|hues?|huygens)(?:[-_]\d{2,4})?(?:\.(?:csv|xlsx?|pdf|docx?|txt|json))?$/iu;
const MEASUREMENT_LITERAL =
  /^(?:(?:на|по|до|за)\s*)?[+-]?\d{1,6}(?:[.,]\d{1,3})?\s*-?\s*(л(?:итр(?:а|ов)?)?|l(?:it(?:er|re)s?)?|л\.?\s*с\.?|лет(?:н(?:ий|яя|ее|ие|его|ей|их|ими|им|ем|юю))?)$/iu;
const VOLUME_CONTEXT =
  /(?:об[ъь]?ем|емкост|ёмкост|бак|канистр|вод[аыу]|топлив|бензин|дизел|масл|аквариум|рюкзак|кастрюл|ведр|бутыл|бочк|литр|volume|tank|water|fuel|capacity|backpack)/iu;

export function prepareProfanitySource(text: string): string {
  // FLAG: Non-linguistic spans are barriers, not joinable gaps. All candidate offsets refer
  // to this same prepared source; link and stop-word policies still inspect their own input.
  // FLAG: Only the parser may create barriers; user-supplied nulls remain ordinary obfuscation.
  return replaceUrlsInText(text.replace(/\0/gu, ''), '\0').replace(EMAIL_PATTERN, '\0');
}

export function isLiteralLatinProfanityException(candidate: ProfanitySourceCandidate): boolean {
  if (candidate.joined) return false;
  const literal = (candidate.rawValue ?? candidate.value).replace(
    /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu,
    '',
  );
  return LITERAL_LATIN_TERM.test(literal);
}

export function getMeasurementLiteralContext(
  source: string,
  candidate: ProfanitySourceCandidate,
  canonicalToken: string,
): { text: string; unambiguousUnit: boolean } | null {
  if (candidate.rawIndex === undefined) return null;
  const literal = (candidate.rawValue ?? candidate.value).replace(
    /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu,
    '',
  );
  const match = MEASUREMENT_LITERAL.exec(literal);
  const unit = match?.[1];
  if (!unit) return null;
  const unambiguousUnit = !/^[лl]$/iu.test(unit);
  const start = candidate.rawIndex;
  const end = candidate.rawEnd ?? start + (candidate.rawValue ?? candidate.value).length;
  const before =
    source
      .slice(Math.max(0, start - 120), start)
      .split(/[,.;!?\r\n\0]/u)
      .at(-1) ?? '';
  const after = source.slice(end, end + 120).split(/[,.;!?\r\n\0]/u)[0] ?? '';
  const standalone = !/[\p{L}\p{N}]/u.test(source.slice(0, start) + source.slice(end));
  if (!unambiguousUnit && !standalone && !VOLUME_CONTEXT.test(`${before} ${after}`)) return null;
  return { text: `${before} ${canonicalToken} ${after}`, unambiguousUnit };
}

export function tokenizeProfanityContext(
  text: string,
  directAddressMarkers: ReadonlySet<string>,
): string[] {
  const tokens = text.match(/[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*|[.!?;\r\n\0]+/gu) ?? [];
  return tokens.filter((token, index) => {
    if (!/^[.!?;\r\n\0]+$/u.test(token)) return true;
    // A standalone pronoun is not a completed sentence: keep "ty... <insult>" detectable.
    return !directAddressMarkers.has(tokens[index - 1] ?? '') && !/^\.{2,}$/u.test(token);
  });
}

export function excludeProtectedProfanitySpans(
  candidates: ProfanitySourceCandidate[],
  protectedCandidates: ProfanitySourceCandidate[],
): ProfanitySourceCandidate[] {
  const ranges: Array<{ start: number; end: number }> = [];
  const ordered = protectedCandidates
    .filter((candidate) => candidate.rawIndex !== undefined && candidate.rawEnd !== undefined)
    .map((candidate) => ({ start: candidate.rawIndex!, end: candidate.rawEnd! }))
    .sort((left, right) => left.start - right.start);
  for (const range of ordered) {
    const last = ranges.at(-1);
    if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
    else ranges.push(range);
  }
  if (ranges.length === 0) return candidates;

  // Measurements can repeat throughout a long listing; avoid comparing every candidate pair.
  return candidates.filter((candidate) => {
    if (candidate.rawIndex === undefined || candidate.rawEnd === undefined) return true;
    let left = 0;
    let right = ranges.length;
    while (left < right) {
      const middle = Math.floor((left + right) / 2);
      if (ranges[middle].end <= candidate.rawIndex) left = middle + 1;
      else right = middle;
    }
    return left === ranges.length || ranges[left].start >= candidate.rawEnd;
  });
}
