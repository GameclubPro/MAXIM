import {
  parseCommercialTextControlOptions,
  runCommercialTextControlCommand,
} from './commercial-text-runtime-control';

describe('commercial text control operator boundary', () => {
  const service = () => ({
    snapshot: jest.fn().mockResolvedValue({ revision: 0, control: null }),
    set: jest.fn().mockResolvedValue({ applied: true, revision: 1 }),
  });
  it('previews emergency off and requires explicit apply to change shared authority', async () => {
    const h = service();
    await expect(
      runCommercialTextControlCommand(h, ['off', '--expected-revision', '0']),
    ).resolves.toMatchObject({ preview: true, proposed: { mode: 'off', revision: 1 } });
    expect(h.set).not.toHaveBeenCalled();
    await expect(
      runCommercialTextControlCommand(h, ['off', '--expected-revision', '0', '--apply']),
    ).resolves.toMatchObject({ applied: true, revision: 1 });
    expect(h.set).toHaveBeenCalledTimes(1);
  });
  it('never applies a stale revision', async () => {
    const h = service();
    h.snapshot.mockResolvedValue({ revision: 2, control: null });
    await expect(
      runCommercialTextControlCommand(h, ['off', '--expected-revision', '0', '--apply']),
    ).rejects.toThrow('Revision conflict');
    expect(h.set).not.toHaveBeenCalled();
  });
  it.each(
    [
      ['set', '--mode', 'canary', '--expected-revision', '0', '--ttl-hours', '1'],
      [
        'set',
        '--mode',
        'on',
        '--expected-revision',
        '0',
        '--ttl-hours',
        '1',
        '--cohort',
        'owned-service-contrast-v1',
      ],
      ['set', '--mode', 'on', '--expected-revision', '0', '--ttl-hours', '25'],
      ['off', '--expected-revision', '0', '--cohort', 'owned-service-contrast-v1'],
    ].map((args) => [args]),
  )(
    'rejects ambiguous scope, missing independent promotion evidence and invalid lifetime: %j',
    (args) => {
      expect(() => parseCommercialTextControlOptions(args)).toThrow();
    },
  );
  it('restores the released baseline explicitly without experiment evidence', () => {
    expect(
      parseCommercialTextControlOptions(['baseline', '--expected-revision', '0']),
    ).toMatchObject({ control: { mode: 'baseline', promotedPolicyCohorts: [] } });
  });
});
