import {
  parseMessageDuplicateControlOptions,
  runMessageDuplicateControlCommand,
} from './message-duplicate-runtime-control';

describe('message duplicate control CLI', () => {
  const args = [
    'set',
    '--expected-revision',
    '0',
    '--chat-id=-123',
    '--mode',
    'delete_only',
    '--ttl-hours',
    '24',
  ];
  it('previews an explicit finite cohort without mutations or disclosing ids', async () => {
    const operator = {
      snapshot: jest.fn().mockResolvedValue({ revision: 0, control: null }),
      set: jest.fn(),
    };
    const result = await runMessageDuplicateControlCommand(operator, args);
    expect(result).toMatchObject({
      preview: true,
      proposed: { chatCount: 1, mode: 'delete_only' },
    });
    expect(JSON.stringify(result)).not.toContain('-123');
    expect(operator.set).not.toHaveBeenCalled();
  });
  it('applies only at the expected revision and provides a downgrade-only off command', async () => {
    const operator = {
      snapshot: jest.fn().mockResolvedValue({ revision: 0, control: null }),
      set: jest.fn().mockResolvedValue({ applied: true, revision: 1 }),
    };
    expect(await runMessageDuplicateControlCommand(operator, [...args, '--apply'])).toMatchObject({
      applied: true,
      revision: 1,
    });
    expect(parseMessageDuplicateControlOptions(['off', '--expected-revision', '1'])).toMatchObject({
      control: { mode: 'off', chatIds: [], revision: 2 },
    });
    operator.snapshot.mockResolvedValue({ revision: 2, control: null });
    await expect(runMessageDuplicateControlCommand(operator, args)).rejects.toThrow(
      'revision conflict',
    );
  });
  it.each(
    [
      ['set'],
      ['get', '--apply'],
      ['off', '--expected-revision', '1', '--mode', 'delete_only'],
      [...args, '--unknown'],
      [...args.slice(0, -1), '25'],
      ['set', '--expected-revision', '0', '--mode', 'delete_only', '--ttl-hours', '1'],
      [...args, '--chat-id=-123'],
      [...args, '--chat-id=*'],
    ].map((invalid) => ({ invalid })),
  )('rejects ambiguous authority $invalid', ({ invalid }) =>
    expect(() => parseMessageDuplicateControlOptions(invalid)).toThrow(),
  );
});
