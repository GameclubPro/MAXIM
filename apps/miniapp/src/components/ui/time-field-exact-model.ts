export function parseExactTimePart(value: string, maximum: 23 | 59): number | null {
  if (!/^\d{1,2}$/u.test(value)) return null;
  const number = Number(value);
  return number <= maximum ? number : null;
}

export function shiftExactTimePart(value: string, delta: -1 | 1, maximum: 23 | 59): string | null {
  const parsed = parseExactTimePart(value, maximum);
  return parsed === null
    ? null
    : String((parsed + delta + maximum + 1) % (maximum + 1)).padStart(2, '0');
}
