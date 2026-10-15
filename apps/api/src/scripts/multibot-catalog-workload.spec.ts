import { isCatalogViolation, parseCatalogViolationPercent } from './multibot-catalog-workload';

describe('explicit synthetic catalog workloads', () => {
  it('keeps the all-delete overload as the default', () => {
    expect(parseCatalogViolationPercent(undefined)).toBe(100);
    expect(Array.from({ length: 12 }, (_, index) => isCatalogViolation(index, 100))).toEqual(
      Array(12).fill(true),
    );
  });

  it.each(['', '-1', '101', '1.5', 'NaN', '25percent', ' 25', '25 ', '1e2'])(
    'refuses ambiguous workload input %j',
    (value) => expect(() => parseCatalogViolationPercent(value)).toThrow('violations'),
  );

  it('retains benign cases and distributes the chosen violation fraction', () => {
    expect(Array.from({ length: 8 }, (_, index) => isCatalogViolation(index, 25))).toEqual([
      false,
      false,
      false,
      true,
      false,
      false,
      false,
      true,
    ]);
    expect(Array.from({ length: 12 }, (_, index) => isCatalogViolation(index, 0))).toEqual(
      Array(12).fill(false),
    );
    expect(parseCatalogViolationPercent('0')).toBe(0);
    expect(parseCatalogViolationPercent('25')).toBe(25);
    expect(parseCatalogViolationPercent('100')).toBe(100);
  });
});
