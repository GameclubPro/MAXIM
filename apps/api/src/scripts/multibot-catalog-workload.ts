export function parseCatalogViolationPercent(value: string | undefined): number {
  if (value === undefined) return 100;
  if (!/^(?:0|[1-9]\d?|100)$/u.test(value))
    throw new Error('Use --violations=<integer from 0 to 100>');
  return Number(value);
}

// FLAG: This is an explicit synthetic assumption, never an inferred production label.
// Spread violations through the run so a benign prefix cannot hide a final overload burst.
export function isCatalogViolation(index: number, percent: number): boolean {
  return Math.floor(((index + 1) * percent) / 100) > Math.floor((index * percent) / 100);
}
