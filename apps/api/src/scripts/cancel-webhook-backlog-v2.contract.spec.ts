import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  BACKLOG_CANCELLATION_V2_LIMITS,
  backlogCancellationBytesV2,
  backlogCancellationDigestV2,
  parseBacklogCancellationApplyV2,
  parseBacklogCancellationNominationV2,
  type BacklogCancellationNominationV2,
  type BacklogCancellationApplyV2,
} from './cancel-webhook-backlog-v2.contract';

const fixture = JSON.parse(
  readFileSync(
    resolve(__dirname, '../../../../infra/fixtures/backlog-cancellation-v2-contract.json'),
    'utf8',
  ),
) as {
  rootLimit: number;
  nominationMaxBytes: number;
  applyMaxBytes: number;
  validNomination: BacklogCancellationNominationV2;
  validApply: BacklogCancellationApplyV2;
};
describe('exact cancellation v2 contract', () => {
  it('agrees with the shared host fixture and fixed bounds', () => {
    expect(
      parseBacklogCancellationNominationV2(backlogCancellationBytesV2(fixture.validNomination)),
    ).toEqual(fixture.validNomination);
    expect(parseBacklogCancellationApplyV2(backlogCancellationBytesV2(fixture.validApply))).toEqual(
      fixture.validApply,
    );
    expect(BACKLOG_CANCELLATION_V2_LIMITS.roots).toBe(fixture.rootLimit);
    expect(BACKLOG_CANCELLATION_V2_LIMITS.nominationBytes).toBe(fixture.nominationMaxBytes);
    expect(BACKLOG_CANCELLATION_V2_LIMITS.applyBytes).toBe(fixture.applyMaxBytes);
  });
  it.each([
    { version: 3 },
    { force: true },
    { rootIds: [] },
    { rootIds: ['b', 'a'] },
    { rootIds: ['a', 'a'] },
    { rootIds: ['root-\u0000'] },
    { rootIds: ['root-\u001f'] },
    { rootIds: ['root-\u007f'] },
    { rootIds: Array.from({ length: 129 }, (_, i) => `root-${String(i).padStart(3, '0')}`) },
    { cutoff: '2026-10-10' },
    { imageId: 'latest' },
  ])('rejects widened or ambiguous nomination %p', (patch) => {
    expect(() =>
      parseBacklogCancellationNominationV2(
        backlogCancellationBytesV2({ ...fixture.validNomination, ...patch }),
      ),
    ).toThrow('INVALID_INPUT');
  });
  it('rejects duplicate keys, noncanonical bytes and oversized inputs', () => {
    const canonical = backlogCancellationBytesV2(fixture.validNomination);
    expect(() =>
      parseBacklogCancellationNominationV2(canonical.replace('{', '{"version":2,')),
    ).toThrow();
    expect(() =>
      parseBacklogCancellationNominationV2(JSON.stringify(fixture.validNomination, null, 2)),
    ).toThrow();
    expect(() => parseBacklogCancellationNominationV2(' '.repeat(16385))).toThrow();
  });
  it('binds data changes and is stable across object key order', () => {
    expect(backlogCancellationDigestV2({ b: 2, a: 1 })).toBe(
      backlogCancellationDigestV2({ a: 1, b: 2 }),
    );
    expect(backlogCancellationDigestV2(fixture.validNomination)).not.toBe(
      backlogCancellationDigestV2({ ...fixture.validNomination, rootIds: ['different'] }),
    );
  });
});
