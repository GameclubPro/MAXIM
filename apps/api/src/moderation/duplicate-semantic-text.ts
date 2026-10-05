const SI_PREFIXES = [
  '',
  'Q',
  'R',
  'Y',
  'Z',
  'E',
  'P',
  'T',
  'G',
  'M',
  'k',
  'h',
  'da',
  'd',
  'c',
  'm',
  'µ',
  'μ',
  'n',
  'p',
  'f',
  'a',
  'z',
  'y',
  'r',
  'q',
];
const SI_SYMBOLS = [
  'm',
  'g',
  's',
  'A',
  'K',
  'mol',
  'cd',
  'rad',
  'sr',
  'Hz',
  'N',
  'Pa',
  'J',
  'W',
  'C',
  'V',
  'F',
  'Ω',
  'S',
  'Wb',
  'T',
  'H',
  'lm',
  'lx',
  'Bq',
  'Gy',
  'Sv',
  'kat',
  'l',
  'L',
  'eV',
  'b',
  'B',
  'bps',
  'Bps',
  'bit',
  'bits',
  'byte',
  'bytes',
  // FLAG: Established concatenated electrical symbols retain SI-prefix case.
  // MWh/mWh, MAh/mAh, MVA/mVA and Mvar/mvar are different quantities.
  'Wh',
  'Ah',
  'VA',
  'var',
];
const CYRILLIC_PREFIXES = ['', 'Т', 'Г', 'М', 'к', 'д', 'с', 'м', 'мк', 'н', 'п'];
const CYRILLIC_SYMBOLS = [
  'м',
  'г',
  'с',
  'А',
  'К',
  'Гц',
  'Н',
  'Па',
  'Дж',
  'Вт',
  'Кл',
  'В',
  'Ф',
  'Ом',
  'См',
  'Вб',
  'Тл',
  'Гн',
  'лм',
  'лк',
  'Бк',
  'Гр',
  'Зв',
  'л',
  'эВ',
  'б',
  'Б',
  'Втч',
  'Ач',
  'ВА',
  'вар',
  'ч',
];
const QUANTITY_UNITS = new Set(
  [
    ...SI_PREFIXES.flatMap((prefix) => SI_SYMBOLS.map((symbol) => prefix + symbol)),
    ...CYRILLIC_PREFIXES.flatMap((prefix) => CYRILLIC_SYMBOLS.map((symbol) => prefix + symbol)),
    ...['Ki', 'Mi', 'Gi', 'Ti', 'Pi', 'Ei', 'Zi', 'Yi'].flatMap((prefix) =>
      ['b', 'B', 'bps', 'Bps', 'bit', 'bits', 'byte', 'bytes'].map((symbol) => prefix + symbol),
    ),
    'Кб',
    'КБ',
  ].map((unit) => unit.normalize('NFC').toLowerCase()),
);

function protectedQuantityUnit(unit: string): string {
  // FLAG: Written bit/byte names keep cosmetic prose case; only their SI prefix
  // remains case-sensitive. Symbol spellings (B/b, Bps/bps) retain their case.
  const wordUnit = /^(.*?)(bytes?|bits?)$/iu.exec(unit);
  return wordUnit ? wordUnit[1]! + wordUnit[2]!.toLowerCase() : unit;
}

function isQuantityUnit(unit: string): boolean {
  // FLAG: Format controls may hide a finite symbol, but remain in the returned
  // original-source text. Never scrub them from lifecycle or comparison identity.
  return QUANTITY_UNITS.has(unit.replace(/\p{Cf}/gu, '').toLowerCase());
}

export function hasDuplicateQuantityUnitSuffix(value: string): boolean {
  const unit = /^[\s\p{Cf}()[\]{}«»"'“‘”’]*([\p{L}\p{M}\p{Cf}]+)(?![\p{L}\p{M}_])/u.exec(
    value.normalize('NFC'),
  )?.[1];
  return unit !== undefined && isQuantityUnit(unit);
}

// FLAG: Superscript exponent digits belong to a unit expression; ordinary digits remain
// identifier adjacency. Rejecting every Unicode number here would erase MΩ²/mΩ² case.
const QUANTITY_UNIT_TOKEN =
  /(?<![\p{L}\p{M}\p{N}_])([\p{L}\p{M}\p{Cf}]+)(?=[²³⁻⁰¹⁴⁵⁶⁷⁸⁹]|$|[^\p{L}\p{M}\p{N}_])/gu;
const QUANTITY_COMPOUND_COMPONENT =
  /(?:\^[+-]?\p{N}+|[²³⁻⁺⁰¹⁴⁵⁶⁷⁸⁹]+)?(?:[\s\p{Cf})\]}»"'”’]*[/·⋅∙*×÷∕⁄][\s\p{Cf}([{«"'“‘]*|[\p{Cf})\]}»"'”’]*\s[\s\p{Cf}()[\]{}«»"'“‘”’]*)([\p{L}\p{M}\p{Cf}]+)(?![\p{L}\p{M}_])/uy;
const QUANTITY_PREFIX_SEPARATOR =
  /(?:[\s\p{Cf}()[\]{}«»"'“‘”’]*(?:[:=—–])[\s\p{Cf}()[\]{}«»"'“‘”’]*|[\s\p{Cf}()[\]{}«»"'“‘”’]+-[\s\p{Cf}()[\]{}«»"'“‘”’]+|[\s\p{Cf}()[\]{}«»"'“‘”’]+)/uy;
type QuantityUnitSpan = [number, number];

function prefixQuantityUnitSpans(source: string, valueFollows: boolean): QuantityUnitSpan[] {
  const tokens = new RegExp(QUANTITY_UNIT_TOKEN);
  const compound = new RegExp(QUANTITY_COMPOUND_COMPONENT);
  const separator = new RegExp(QUANTITY_PREFIX_SEPARATOR);
  const scalar = /[+-]?\p{N}+(?:[.,]\p{N}+)?(?:[eE][+-]?\p{N}+)?/uy;
  const exponent = /(?:\^[+-]?\p{N}+|[²³⁻⁺⁰¹⁴⁵⁶⁷⁸⁹]+)/uy;
  const spans: QuantityUnitSpan[] = [];
  let token: RegExpExecArray | null;
  while ((token = tokens.exec(source)) !== null) {
    if (!isQuantityUnit(token[1]!)) continue;
    let end = token.index + token[0].length;
    const expressionSpans: QuantityUnitSpan[] = [[token.index, end]];
    while (true) {
      compound.lastIndex = end;
      const next = compound.exec(source);
      if (!next || !isQuantityUnit(next[1]!)) break;
      end = next.index + next[0].length;
      expressionSpans.push([end - next[1]!.length, end]);
    }
    exponent.lastIndex = end;
    if (exponent.exec(source)) end = exponent.lastIndex;
    // FLAG: Inspect a unit expression once, including unsuccessful numeric-prefix probes.
    // Never restart inside a compound suffix or accept compact model identifiers (MB100).
    tokens.lastIndex = end;
    separator.lastIndex = end;
    if (!separator.exec(source)) continue;
    if (valueFollows) {
      if (separator.lastIndex === source.length) return expressionSpans;
    } else {
      scalar.lastIndex = separator.lastIndex;
      if (scalar.exec(source)) for (const span of expressionSpans) spans.push(span);
    }
  }
  return spans;
}

export function hasDuplicateQuantityUnitPrefix(value: string): boolean {
  return prefixQuantityUnitSpans(value.normalize('NFC'), true).length > 0;
}

function mergeQuantityUnitSpans(
  suffix: readonly QuantityUnitSpan[],
  prefix: readonly QuantityUnitSpan[],
): QuantityUnitSpan[] {
  const spans: QuantityUnitSpan[] = [];
  let suffixIndex = 0;
  let prefixIndex = 0;
  while (suffixIndex < suffix.length || prefixIndex < prefix.length) {
    const next =
      prefixIndex >= prefix.length ||
      (suffixIndex < suffix.length && suffix[suffixIndex]![0] <= prefix[prefixIndex]![0])
        ? suffix[suffixIndex++]!
        : prefix[prefixIndex++]!;
    if (spans.at(-1)?.[0] === next[0]) continue;
    spans.push(next);
  }
  return spans;
}

export function normalizeDuplicateSemanticText(value: string): string {
  const source = value.normalize('NFC');
  // FLAG: Prose case is cosmetic, but quantity symbols are case-sensitive (MB/Mb,
  // MΩ/mΩ). Protect only finite units beside a number, never arbitrary identifiers.
  const quantities =
    /(?:(?<![\p{L}\p{M}\p{N}_])|(?<=\p{N}[xXхХ]))[+-]?\p{N}+(?:[.,]\p{N}+)?(?:[eE][+-]?\p{N}+)?[\s\p{Cf}()[\]{}«»"'“‘”’·⋅∙*/×÷∕⁄:=—–-]*([\p{L}\p{M}\p{Cf}]+)(?![\p{L}\p{M}_])/gu;
  const compound = new RegExp(QUANTITY_COMPOUND_COMPONENT);
  const suffixSpans: QuantityUnitSpan[] = [];
  let quantity: RegExpExecArray | null;
  while ((quantity = quantities.exec(source)) !== null) {
    const unit = quantity[1]!;
    if (!isQuantityUnit(unit)) continue;
    let end = quantity.index + quantity[0].length;
    suffixSpans.push([end - unit.length, end]);
    // FLAG: Compound quantity units keep their component order and case, including
    // denominators. Sticky continuation reads each adjacent component once.
    while (true) {
      compound.lastIndex = end;
      const next = compound.exec(source);
      if (!next || !isQuantityUnit(next[1]!)) break;
      end = next.index + next[0].length;
      suffixSpans.push([end - next[1]!.length, end]);
    }
    // FLAG: Compound exponents must not restart quantity scans inside the consumed
    // expression and repeatedly traverse its suffix. Advance the outer scanner as well.
    quantities.lastIndex = end;
  }
  // FLAG: Technical field labels (MB: 100, MΩ = 10) carry the same unit semantics as
  // suffix quantities. The ordered merge keeps both passes linear and shares phone guards.
  const spans = mergeQuantityUnitSpans(suffixSpans, prefixQuantityUnitSpans(source, false));
  const parts: string[] = [];
  let cursor = 0;
  for (const [from, end] of spans) {
    if (from < cursor) continue;
    parts.push(
      source.slice(cursor, from).toLowerCase(),
      protectedQuantityUnit(source.slice(from, end)),
    );
    cursor = end;
  }
  parts.push(source.slice(cursor).toLowerCase());
  return parts.join('').replace(/\s+/gu, ' ').trim();
}
