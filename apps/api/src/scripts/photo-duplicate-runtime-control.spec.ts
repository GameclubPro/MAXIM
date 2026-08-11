import type {
  PhotoDuplicateRuntimeControlSnapshot,
  PhotoDuplicateRuntimeControlV1,
} from '../moderation/photo-duplicate/photo-duplicate-runtime-policy.service';
import {
  readPhotoDuplicateRuntimeControlOptions,
  runPhotoDuplicateRuntimeControlCommand,
  serializePhotoDuplicateRuntimeControlResult,
} from './photo-duplicate-runtime-control';

function buildControl(revision = 1): PhotoDuplicateRuntimeControlV1 {
  return {
    version: 1,
    revision,
    mode: 'delete_only',
    enforcementChatIds: ['chat-1'],
    advancedCanaryChatIds: [],
    allowedMatchKinds: ['canonical_sha256'],
    maxAction: 'DELETE_MESSAGE',
    actor: 'operator:user-1',
    reason: 'bounded delete-only canary',
    createdAt: '2026-08-11T09:00:00.000Z',
    updatedAt: '2026-08-11T09:00:00.000Z',
    expiresAt: '2026-08-11T10:00:00.000Z',
  };
}

function createOperator(
  snapshot: PhotoDuplicateRuntimeControlSnapshot = {
    kind: 'missing',
    control: null,
    revision: null,
  },
) {
  return {
    getControlSnapshot: jest.fn().mockResolvedValue(snapshot),
    previewSetControl: jest.fn(
      ({ control }: { control: unknown }) => control as PhotoDuplicateRuntimeControlV1,
    ),
    setControl: jest.fn().mockResolvedValue({
      kind: 'applied' as const,
      revision: 1,
      expiresAt: '2026-08-11T10:00:00.000Z',
    }),
    clearControl: jest.fn().mockResolvedValue({
      kind: 'cleared' as const,
      previousRevision: 1,
      revision: 2,
    }),
  };
}

describe('photo duplicate runtime control operator script', () => {
  it('parses get, bounded set preview and explicit clear apply commands', () => {
    const control = buildControl();
    expect(readPhotoDuplicateRuntimeControlOptions(['get', '--json'])).toEqual({
      command: 'get',
      json: true,
    });
    expect(
      readPhotoDuplicateRuntimeControlOptions([
        'set',
        '--expected-revision',
        'none',
        '--control-json',
        JSON.stringify(control),
      ]),
    ).toEqual({
      command: 'set',
      apply: false,
      json: false,
      expectedRevision: null,
      control,
    });
    expect(
      readPhotoDuplicateRuntimeControlOptions([
        'clear',
        '--expected-revision',
        '7',
        '--apply',
        '--json',
      ]),
    ).toEqual({
      command: 'clear',
      apply: true,
      json: true,
      expectedRevision: 7,
    });
  });

  it.each([
    { argv: [], message: 'Usage:' },
    { argv: ['get', '--apply'], message: 'get accepts only --json' },
    {
      argv: ['set', '--expected-revision', 'none'],
      message: 'set requires --control-json',
    },
    {
      argv: ['clear', '--expected-revision', 'none'],
      message: '--expected-revision must be a positive safe integer',
    },
    {
      argv: ['clear', '--expected-revision', '1', '--apply', '--dry-run'],
      message: '--apply cannot be combined with --dry-run',
    },
    { argv: ['get', '--token', 'secret'], message: 'Unknown option: --token' },
  ])('rejects unsafe or incomplete command arguments', ({ argv, message }) => {
    expect(() => readPhotoDuplicateRuntimeControlOptions(argv)).toThrow(message);
  });

  it('previews a set without invoking the mutating CAS', async () => {
    const control = buildControl();
    const operator = createOperator();
    const options = readPhotoDuplicateRuntimeControlOptions([
      'set',
      '--expected-revision',
      'none',
      '--control-json',
      JSON.stringify(control),
    ]);

    await expect(runPhotoDuplicateRuntimeControlCommand(operator, options)).resolves.toEqual(
      expect.objectContaining({
        command: 'set',
        apply: false,
        complete: true,
        proposedControl: control,
        result: { kind: 'preview', expectedRevision: null, wouldMatch: true },
      }),
    );
    expect(operator.previewSetControl).toHaveBeenCalledTimes(1);
    expect(operator.setControl).not.toHaveBeenCalled();
  });

  it('applies set and clear only when --apply was parsed', async () => {
    const control = buildControl();
    const setOperator = createOperator();
    const setOptions = readPhotoDuplicateRuntimeControlOptions([
      'set',
      '--expected-revision',
      'none',
      '--control-json',
      JSON.stringify(control),
      '--apply',
    ]);
    await expect(
      runPhotoDuplicateRuntimeControlCommand(setOperator, setOptions),
    ).resolves.toMatchObject({ apply: true, complete: true, result: { kind: 'applied' } });
    expect(setOperator.setControl).toHaveBeenCalledWith({
      expectedRevision: null,
      control,
    });

    const activeSnapshot = { kind: 'active' as const, control, revision: 1 };
    const clearOperator = createOperator(activeSnapshot);
    const clearOptions = readPhotoDuplicateRuntimeControlOptions([
      'clear',
      '--expected-revision',
      '1',
      '--apply',
    ]);
    await expect(
      runPhotoDuplicateRuntimeControlCommand(clearOperator, clearOptions),
    ).resolves.toMatchObject({ apply: true, complete: true, result: { kind: 'cleared' } });
    expect(clearOperator.clearControl).toHaveBeenCalledWith({ expectedRevision: 1 });
  });

  it('reports CAS conflicts as incomplete structured output', async () => {
    const control = buildControl(2);
    const operator = createOperator({
      kind: 'active' as const,
      control: buildControl(1),
      revision: 1,
    });
    operator.setControl.mockResolvedValue({ kind: 'conflict', currentRevision: 3 } as never);
    const options = readPhotoDuplicateRuntimeControlOptions([
      'set',
      '--expected-revision',
      '1',
      '--control-json',
      JSON.stringify(control),
      '--apply',
    ]);

    const result = await runPhotoDuplicateRuntimeControlCommand(operator, options);
    expect(result).toMatchObject({
      command: 'set',
      apply: true,
      complete: false,
      result: { kind: 'conflict', currentRevision: 3 },
    });
    expect(serializePhotoDuplicateRuntimeControlResult(result, true)).not.toContain('REDIS_URL');
  });

  it('gets a sanitized snapshot without invoking a mutation', async () => {
    const operator = createOperator({ kind: 'invalid' as const, control: null, revision: null });

    await expect(
      runPhotoDuplicateRuntimeControlCommand(operator, { command: 'get', json: true }),
    ).resolves.toMatchObject({
      command: 'get',
      apply: false,
      complete: false,
      before: { kind: 'invalid', control: null, revision: null },
    });
    expect(operator.setControl).not.toHaveBeenCalled();
    expect(operator.clearControl).not.toHaveBeenCalled();
  });
});
