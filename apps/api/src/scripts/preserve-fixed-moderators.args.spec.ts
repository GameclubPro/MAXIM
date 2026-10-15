import { parseModeratorPreservationArgs } from './preserve-fixed-moderators.args';

describe('fixed moderator operator arguments', () => {
  it.each(['--explain-chat', '--after'])('accepts an exact negative MAX ID after %s', (flag) => {
    const id = '-900719925474099312345';
    const args = ['--source-sha', 'a'.repeat(40), flag, id, '--limit', '25'];
    const original = [...args];
    expect(parseModeratorPreservationArgs(args)).toMatchObject({
      [flag.slice(2)]: id,
      'source-sha': 'a'.repeat(40),
      limit: '25',
      apply: false,
    });
    expect(args).toEqual(original);
    expect(parseModeratorPreservationArgs([`${flag}=${id}`])).toMatchObject({
      [flag.slice(2)]: id,
    });
  });

  it('keeps positive and fixture IDs and the explicit apply journal arguments intact', () => {
    expect(parseModeratorPreservationArgs(['--after', 'fixture-1'])).toMatchObject({
      after: 'fixture-1',
      limit: '25',
      apply: false,
    });
    expect(parseModeratorPreservationArgs(['--explain-chat', '123'])).toMatchObject({
      'explain-chat': '123',
    });
    expect(
      parseModeratorPreservationArgs(['--apply', '--reviewed-digest', 'b'.repeat(64)]),
    ).toMatchObject({ apply: true, 'reviewed-digest': 'b'.repeat(64) });
  });

  it.each([
    ['--after', '--apply'],
    ['--explain-chat', '--limit', '25'],
    ['--after'],
    ['--unknown', '-123'],
    ['--after', '-123', 'extra'],
  ])('retains strict refusal for %j', (...args) => {
    expect(() => parseModeratorPreservationArgs(args)).toThrow();
  });
});
