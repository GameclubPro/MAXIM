import type { DuplicateFingerprint } from '../rule-engine-duplicate-detector';
import { selectMessageDuplicateFingerprints } from './message-duplicate-history.service';

describe('bounded message duplicate fingerprints', () => {
  const many = (type: DuplicateFingerprint['type'], count: number): DuplicateFingerprint[] =>
    Array.from({ length: count }, (_, index) => ({ type, value: `${type}-${index}` }));

  it('preserves the original selection below the budget', () => {
    const input = [...many('exact', 1), ...many('link', 8), ...many('phone', 2)];
    expect(selectMessageDuplicateFingerprints(input)).toEqual(input);
  });

  it('reserves room for each enabled kind without increasing the budget', () => {
    const selected = selectMessageDuplicateFingerprints([
      ...many('exact', 1),
      ...many('link', 40),
      ...many('phone', 40),
      ...many('content', 1),
      ...many('near', 1),
    ]);
    expect(selected).toHaveLength(16);
    expect(selected[0]?.type).toBe('exact');
    expect(new Set(selected.map((part) => part.type))).toEqual(
      new Set(['exact', 'link', 'phone', 'content', 'near']),
    );
    expect(new Set(selected.map((part) => part.value)).size).toBe(16);
  });

  it('selects the same bounded values when links and phones are reordered', () => {
    const exact = many('exact', 1);
    const links = many('link', 40);
    const phones = many('phone', 40);
    expect(selectMessageDuplicateFingerprints([...exact, ...links, ...phones])).toEqual(
      selectMessageDuplicateFingerprints([...exact, ...links.reverse(), ...phones.reverse()]),
    );
  });
});
