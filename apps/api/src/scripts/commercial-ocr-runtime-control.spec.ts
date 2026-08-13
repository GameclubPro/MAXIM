import type {
  CommercialOcrRuntimeControlSnapshot,
  CommercialOcrRuntimeControlV1,
} from '../moderation/commercial-ocr/commercial-ocr-runtime-policy.service';
import {
  readCommercialOcrRuntimeControlOptions,
  runCommercialOcrRuntimeControlCommand,
  serializeCommercialOcrRuntimeControlResult,
} from './commercial-ocr-runtime-control';

function control(revision = 1): CommercialOcrRuntimeControlV1 {
  return {
    version: 1,
    revision,
    mode: 'canary',
    enforcementChatIds: ['chat-1'],
    actor: 'operator',
    reason: 'canary',
    createdAt: '2026-08-13T08:00:00.000Z',
    updatedAt: '2026-08-13T08:00:00.000Z',
    expiresAt: '2026-08-13T09:00:00.000Z',
  };
}

function active(revision = 1): CommercialOcrRuntimeControlSnapshot {
  return { kind: 'active', revision, control: control(revision) };
}

function operator(snapshots: readonly CommercialOcrRuntimeControlSnapshot[] = [active()]) {
  const getControlSnapshot = jest.fn();
  for (const snapshot of snapshots) {
    getControlSnapshot.mockResolvedValueOnce(snapshot);
  }
  return {
    getControlSnapshot,
    previewSetControl: jest.fn(
      ({ control: proposed }: { control: unknown }) => proposed as CommercialOcrRuntimeControlV1,
    ),
    setControl: jest.fn().mockResolvedValue({
      kind: 'applied',
      revision: 2,
      expiresAt: '2026-08-13T09:00:00.000Z',
    }),
    clearControl: jest
      .fn()
      .mockResolvedValue({ kind: 'cleared', previousRevision: 1, revision: 2 }),
  };
}

describe('commercial OCR runtime control operator', () => {
  it('defaults mutations to preview and requires explicit CAS arguments', () => {
    expect(readCommercialOcrRuntimeControlOptions(['get', '--json'])).toEqual({
      command: 'get',
      json: true,
    });
    const options = readCommercialOcrRuntimeControlOptions([
      'set',
      '--expected-revision',
      '1',
      '--control-json',
      JSON.stringify({ version: 1 }),
    ]);
    expect(options).toMatchObject({ command: 'set', apply: false, expectedRevision: 1 });
    expect(() => readCommercialOcrRuntimeControlOptions(['clear'])).toThrow(/expected-revision/u);
  });

  it('does not mutate Redis during a preview', async () => {
    const target = operator();
    const options = readCommercialOcrRuntimeControlOptions(['clear', '--expected-revision', '1']);
    const result = await runCommercialOcrRuntimeControlCommand(target, options);

    expect(result.result).toEqual({ kind: 'preview', expectedRevision: 1, wouldMatch: true });
    expect(target.clearControl).not.toHaveBeenCalled();
  });

  it('applies an explicit clear and serializes no connection details', async () => {
    const target = operator([active(), { kind: 'missing', control: null, revision: 2 }]);
    const options = readCommercialOcrRuntimeControlOptions([
      'clear',
      '--expected-revision',
      '1',
      '--apply',
      '--json',
    ]);
    const result = await runCommercialOcrRuntimeControlCommand(target, options);

    expect(result.complete).toBe(true);
    expect(result.after).toEqual({ kind: 'missing', control: null, revision: 2 });
    expect(target.getControlSnapshot).toHaveBeenCalledTimes(2);
    expect(target.clearControl).toHaveBeenCalledWith({ expectedRevision: 1 });
    expect(serializeCommercialOcrRuntimeControlResult(result, true)).not.toContain('REDIS_URL');
  });

  it('verifies an applied set against the exact post-attempt control', async () => {
    const proposed = control(2);
    const target = operator([active(1), active(2)]);
    const result = await runCommercialOcrRuntimeControlCommand(target, {
      command: 'set',
      apply: true,
      json: true,
      expectedRevision: 1,
      control: proposed,
    });

    expect(result).toMatchObject({
      command: 'set',
      apply: true,
      complete: true,
      after: active(2),
      proposedControl: proposed,
      result: { kind: 'applied', revision: 2 },
    });
    expect(target.getControlSnapshot).toHaveBeenCalledTimes(2);
  });

  it('does not complete an applied response when the post-attempt state differs', async () => {
    const target = operator([active(1), { kind: 'missing', control: null, revision: 1 }]);

    await expect(
      runCommercialOcrRuntimeControlCommand(target, {
        command: 'set',
        apply: true,
        json: false,
        expectedRevision: 1,
        control: control(2),
      }),
    ).resolves.toMatchObject({
      complete: false,
      after: { kind: 'missing', revision: 1 },
      result: { kind: 'applied' },
    });
  });

  it.each([
    {
      label: 'set',
      snapshots: [active(1), active(2)],
      options: {
        command: 'set' as const,
        apply: true,
        json: false,
        expectedRevision: 1,
        control: control(2),
      },
      expectedResult: {
        kind: 'applied',
        revision: 2,
        expiresAt: '2026-08-13T09:00:00.000Z',
      },
    },
    {
      label: 'clear',
      snapshots: [active(1), { kind: 'missing' as const, control: null, revision: 2 }],
      options: {
        command: 'clear' as const,
        apply: true,
        json: false,
        expectedRevision: 1,
      },
      expectedResult: { kind: 'cleared', previousRevision: 1, revision: 2 },
    },
  ])(
    'reconciles an ambiguous $label as complete only when the post-read proves it',
    async ({ snapshots, options, expectedResult }) => {
      const target = operator(snapshots);
      if (options.command === 'set') {
        target.setControl.mockResolvedValue({
          kind: 'ambiguous',
          reason: 'mutation_timeout',
        } as never);
      } else {
        target.clearControl.mockResolvedValue({
          kind: 'ambiguous',
          reason: 'mutation_timeout',
        } as never);
      }

      const result = await runCommercialOcrRuntimeControlCommand(target, options);

      expect(result.complete).toBe(true);
      expect(result.result).toEqual(expectedResult);
      expect(target.getControlSnapshot).toHaveBeenCalledTimes(2);
    },
  );

  it('keeps an unproven timeout explicitly ambiguous and incomplete', async () => {
    const target = operator([active(1), active(1)]);
    target.setControl.mockResolvedValue({
      kind: 'ambiguous',
      reason: 'mutation_timeout',
    } as never);

    const result = await runCommercialOcrRuntimeControlCommand(target, {
      command: 'set',
      apply: true,
      json: false,
      expectedRevision: 1,
      control: control(2),
    });

    expect(result).toMatchObject({
      complete: false,
      after: active(1),
      result: { kind: 'ambiguous', reason: 'mutation_timeout' },
    });
    expect(target.setControl).toHaveBeenCalledTimes(1);
  });

  it('reconciles an ambiguous mutation to conflict at the target revision', async () => {
    const conflicting = control(2);
    conflicting.reason = 'another operator';
    const target = operator([active(1), { kind: 'active', revision: 2, control: conflicting }]);
    target.setControl.mockResolvedValue({
      kind: 'ambiguous',
      reason: 'mutation_timeout',
    } as never);

    await expect(
      runCommercialOcrRuntimeControlCommand(target, {
        command: 'set',
        apply: true,
        json: false,
        expectedRevision: 1,
        control: control(2),
      }),
    ).resolves.toMatchObject({
      complete: false,
      after: { kind: 'active', revision: 2, control: conflicting },
      result: { kind: 'conflict', currentRevision: 2 },
    });
  });

  it('keeps a later revision ambiguous because the requested CAS may have been superseded', async () => {
    const target = operator([active(1), active(3)]);
    target.setControl.mockResolvedValue({
      kind: 'ambiguous',
      reason: 'mutation_timeout',
    } as never);

    await expect(
      runCommercialOcrRuntimeControlCommand(target, {
        command: 'set',
        apply: true,
        json: false,
        expectedRevision: 1,
        control: control(2),
      }),
    ).resolves.toMatchObject({
      complete: false,
      after: active(3),
      result: { kind: 'ambiguous', reason: 'mutation_timeout' },
    });
  });

  it('keeps a target revision without a valid control ambiguous after set', async () => {
    const target = operator([active(1), { kind: 'missing', control: null, revision: 2 }]);
    target.setControl.mockResolvedValue({
      kind: 'ambiguous',
      reason: 'mutation_timeout',
    } as never);

    await expect(
      runCommercialOcrRuntimeControlCommand(target, {
        command: 'set',
        apply: true,
        json: false,
        expectedRevision: 1,
        control: control(2),
      }),
    ).resolves.toMatchObject({
      complete: false,
      result: { kind: 'ambiguous', reason: 'mutation_timeout' },
    });
  });

  it('fails explicitly when the mandatory post-mutation read is unavailable', async () => {
    const target = operator([active(1)]);
    target.getControlSnapshot.mockRejectedValueOnce(new Error('redis unavailable'));

    await expect(
      runCommercialOcrRuntimeControlCommand(target, {
        command: 'clear',
        apply: true,
        json: false,
        expectedRevision: 1,
      }),
    ).rejects.toThrow('outcome could not be verified after mutation');
    expect(target.clearControl).toHaveBeenCalledTimes(1);
    expect(target.getControlSnapshot).toHaveBeenCalledTimes(2);
  });
});
