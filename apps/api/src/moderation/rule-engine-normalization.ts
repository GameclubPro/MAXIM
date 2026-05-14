export const MIXED_CHAR_MAP: Readonly<Record<string, string>> = {
  a: 'а',
  b: 'б',
  c: 'с',
  d: 'д',
  e: 'е',
  f: 'ф',
  g: 'г',
  h: 'х',
  i: 'и',
  j: 'й',
  k: 'к',
  l: 'л',
  m: 'м',
  n: 'н',
  o: 'о',
  p: 'п',
  q: 'к',
  r: 'р',
  s: 'с',
  t: 'т',
  u: 'у',
  v: 'в',
  w: 'в',
  x: 'х',
  y: 'у',
  z: 'з',
  '0': 'о',
  '1': 'и',
  '3': 'з',
  '4': 'а',
  '6': 'б',
  '7': 'т',
  '8': 'в',
  '9': 'д',
  '@': 'а',
  $: 'с',
};

export function normalizeMixedWriting(value: string): string {
  let result = '';
  for (const char of value) {
    result += MIXED_CHAR_MAP[char] ?? char;
  }
  return result;
}

export function normalizeForDetection(value: string): string {
  if (!value) {
    return '';
  }

  let normalized = value.toLowerCase();
  normalized = normalizeMixedWriting(normalized);
  normalized = normalized.replace(/([a-zа-яё0-9])\1{2,}/giu, '$1$1');
  normalized = normalized.replace(/[_*~`"'«»“”(){}[[]\]|]+/g, ' ');
  normalized = normalized.replace(/[^\p{L}\p{N}\s:/?.,&%+-]/gu, ' ');
  normalized = normalized.replace(/\s+/g, ' ').trim();
  return normalized;
}
