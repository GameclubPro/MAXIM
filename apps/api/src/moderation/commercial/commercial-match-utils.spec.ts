import { collectFirstPatternLabels } from './commercial-match-utils';

describe('commercial match utils', () => {
  it('does not evaluate pattern variants for labels that are already present', () => {
    const seeded = /seeded/u;
    const first = /first/u;
    const duplicateFirst = /duplicate-first/u;
    const second = /second/u;
    const predicate = jest.fn((pattern: RegExp) => pattern !== duplicateFirst);

    expect(
      collectFirstPatternLabels(
        [
          { label: 'seeded', pattern: seeded },
          { label: 'first', pattern: first },
          { label: 'first', pattern: duplicateFirst },
          { label: 'second', pattern: second },
        ],
        predicate,
        3,
        ['seeded'],
      ),
    ).toEqual(['seeded', 'first', 'second']);
    expect(predicate).toHaveBeenCalledTimes(2);
    expect(predicate).toHaveBeenNthCalledWith(1, first);
    expect(predicate).toHaveBeenNthCalledWith(2, second);
  });
});
