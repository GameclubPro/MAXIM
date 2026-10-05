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

export function normalizeDuplicateSemanticText(value: string): string {
  const source = value.normalize('NFC');
  // FLAG: Prose case is cosmetic, but quantity symbols are case-sensitive (MB/Mb,
  // MΩ/mΩ). Protect only finite units beside a number, never arbitrary identifiers.
  const quantities =
    /(?:(?<![\p{L}\p{M}\p{N}_])|(?<=\p{N}[xXхХ]))[+-]?\p{N}+(?:[.,]\p{N}+)?(?:[eE][+-]?\p{N}+)?[\s\p{Cf}()[\]{}«»"'“‘”’·⋅∙*/×÷∕⁄]*([\p{L}\p{M}\p{Cf}]+)(?![\p{L}\p{M}_])/gu;
  const compound =
    /(?:\^[+-]?\p{N}+|[²³⁻⁰¹⁴⁵⁶⁷⁸⁹]+)?(?:[\s\p{Cf})\]}»"'”’]*[/·⋅∙*×÷∕⁄][\s\p{Cf}([{«"'“‘]*|[\p{Cf})\]}»"'”’]*\s[\s\p{Cf}()[\]{}«»"'“‘”’]*)([\p{L}\p{M}\p{Cf}]+)(?![\p{L}\p{M}_])/uy;
  const spans: Array<[number, number]> = [];
  let quantity: RegExpExecArray | null;
  while ((quantity = quantities.exec(source)) !== null) {
    const unit = quantity[1]!;
    if (!isQuantityUnit(unit)) continue;
    let end = quantity.index + quantity[0].length;
    spans.push([end - unit.length, end]);
    // FLAG: Compound quantity units keep their component order and case, including
    // denominators. Sticky continuation reads each adjacent component once.
    while (true) {
      compound.lastIndex = end;
      const next = compound.exec(source);
      if (!next || !isQuantityUnit(next[1]!)) break;
      end = next.index + next[0].length;
      spans.push([end - next[1]!.length, end]);
    }
    // FLAG: Compound exponents must not restart quantity scans inside the consumed
    // expression and repeatedly traverse its suffix. Advance the outer scanner as well.
    quantities.lastIndex = end;
  }
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
