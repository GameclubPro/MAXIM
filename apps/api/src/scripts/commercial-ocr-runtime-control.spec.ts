import {
  COMMERCIAL_OCR_MAX_PROMOTABLE_EXPECTED_REVISION,
  type CommercialOcrRuntimeControlSnapshot,
  type CommercialOcrRuntimeControlV1,
} from '../moderation/commercial-ocr/commercial-ocr-runtime-policy.service';
import { digestCommercialOcrSettingsFingerprintSet } from '../moderation/commercial-ocr/commercial-ocr-settings-profile';
import { Readable } from 'node:stream';
import {
  readCommercialOcrRuntimeControlOptions,
  readCommercialOcrRuntimeControlStdin,
  runCommercialOcrRuntimeControlCommand,
  serializeCommercialOcrRuntimeControlResult,
} from './commercial-ocr-runtime-control';

const certificationSha256 = 'b'.repeat(64);
const certificationExpiresAt = '2026-08-14T08:00:00.000Z';
const approvalKeyIdSha256 = 'c'.repeat(64);
const behaviorIdentitySha256 = 'd'.repeat(64);
const certifiedSettingsFingerprint = 'a'.repeat(64);

function control(
  revision = 1,
  overrides: Partial<CommercialOcrRuntimeControlV1> = {},
): CommercialOcrRuntimeControlV1 {
  return {
    version: 1,
    revision,
    mode: 'canary',
    enforcementChatIds: ['chat-1'],
    certificationSha256,
    certificationExpiresAt,
    approvalKeyIdSha256,
    behaviorIdentitySha256,
    certifiedSettingsFingerprints: [certifiedSettingsFingerprint],
    certifiedSettingsFingerprintSetSha256: digestCommercialOcrSettingsFingerprintSet([
      certifiedSettingsFingerprint,
    ]),
    actor: 'operator',
    reason: 'canary',
    createdAt: '2026-08-13T08:00:00.000Z',
    updatedAt: '2026-08-13T08:00:00.000Z',
    expiresAt: '2026-08-13T09:00:00.000Z',
    ...overrides,
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
    const options = readCommercialOcrRuntimeControlOptions(
      ['set', '--expected-revision', '1', '--control-stdin'],
      JSON.stringify({ version: 1 }),
    );
    expect(options).toMatchObject({ command: 'set', apply: false, expectedRevision: 1 });
    expect(() => readCommercialOcrRuntimeControlOptions(['clear'])).toThrow(/expected-revision/u);
  });

  it('uses distinct safe revision ceilings for set and clear', () => {
    expect(
      readCommercialOcrRuntimeControlOptions(
        [
          'set',
          '--expected-revision',
          String(COMMERCIAL_OCR_MAX_PROMOTABLE_EXPECTED_REVISION),
          '--control-stdin',
        ],
        '{}',
      ),
    ).toMatchObject({ expectedRevision: COMMERCIAL_OCR_MAX_PROMOTABLE_EXPECTED_REVISION });
    expect(() =>
      readCommercialOcrRuntimeControlOptions(
        [
          'set',
          '--expected-revision',
          String(COMMERCIAL_OCR_MAX_PROMOTABLE_EXPECTED_REVISION + 1),
          '--control-stdin',
        ],
        '{}',
      ),
    ).toThrow(/supported mutation range/u);
    expect(
      readCommercialOcrRuntimeControlOptions([
        'clear',
        '--expected-revision',
        String(Number.MAX_SAFE_INTEGER - 1),
      ]),
    ).toMatchObject({ expectedRevision: Number.MAX_SAFE_INTEGER - 1 });
    expect(() =>
      readCommercialOcrRuntimeControlOptions([
        'clear',
        '--expected-revision',
        String(Number.MAX_SAFE_INTEGER),
      ]),
    ).toThrow(/supported mutation range/u);
  });

  it('accepts bounded control JSON from stdin without placing it in argv', async () => {
    const proposed = control(2);
    const serialized = JSON.stringify(proposed);

    expect(
      readCommercialOcrRuntimeControlOptions(
        ['set', '--expected-revision', '1', '--control-stdin', '--apply', '--json'],
        serialized,
      ),
    ).toEqual({
      command: 'set',
      apply: true,
      json: true,
      expectedRevision: 1,
      control: proposed,
    });
    await expect(readCommercialOcrRuntimeControlStdin(Readable.from([serialized]))).resolves.toBe(
      serialized,
    );
  });

  it('rejects missing, duplicate, invalid and oversized stdin controls', async () => {
    const base = ['set', '--expected-revision', '1'] as const;

    expect(() => readCommercialOcrRuntimeControlOptions(base)).toThrow(/requires --control-stdin/u);
    expect(() => readCommercialOcrRuntimeControlOptions([...base, '--control-stdin'])).toThrow(
      /standard input/u,
    );
    expect(() =>
      readCommercialOcrRuntimeControlOptions([...base, '--control-stdin', '--control-stdin'], '{}'),
    ).toThrow(/exactly once/u);
    expect(() =>
      readCommercialOcrRuntimeControlOptions([...base, '--control-stdin'], '{invalid'),
    ).toThrow(/valid JSON/u);
    await expect(
      readCommercialOcrRuntimeControlStdin(Readable.from(['x'.repeat(32 * 1024 + 1)])),
    ).rejects.toThrow(/at most 32768 bytes/u);
  });

  it.each([
    ['get', '--json'],
    ['clear', '--apply'],
    ['clear', '--dry-run'],
  ])('rejects a duplicate %s command flag %s', (command, flag) => {
    const revision = command === 'clear' ? ['--expected-revision', '1'] : [];
    expect(() =>
      readCommercialOcrRuntimeControlOptions([command, ...revision, flag, flag]),
    ).toThrow(/exactly once/u);
  });

  it('forbids control JSON in argv without echoing its value', () => {
    const sensitiveArgument = '{"actor":"private-argv-audit"}';
    let thrown: unknown;

    try {
      readCommercialOcrRuntimeControlOptions([
        'set',
        '--expected-revision',
        '1',
        '--control-json',
        sensitiveArgument,
      ]);
    } catch (error: unknown) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toMatch(/--control-json is forbidden/u);
    expect((thrown as Error).message).not.toContain(sensitiveArgument);
  });

  it('does not echo an unknown positional argv value', () => {
    const sensitiveArgument = '{"reason":"private-positional-audit"}';
    let thrown: unknown;

    try {
      readCommercialOcrRuntimeControlOptions(['set', sensitiveArgument]);
    } catch (error: unknown) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toMatch(/Unknown option/u);
    expect((thrown as Error).message).not.toContain(sensitiveArgument);
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

  it.each(['get', 'set', 'clear'] as const)(
    'serializes a privacy-safe %s summary without raw control or audit data',
    (command) => {
      const rawChatIds = ['42', '-12'];
      const rawActor = 'private-runtime-actor';
      const rawReason = 'private runtime audit reason';
      const sensitiveControl = control(2, {
        enforcementChatIds: rawChatIds,
        actor: rawActor,
        reason: rawReason,
      });
      const sensitiveSnapshot: CommercialOcrRuntimeControlSnapshot = {
        kind: 'active',
        revision: 2,
        control: sensitiveControl,
      };
      const result =
        command === 'get'
          ? {
              command,
              apply: false,
              complete: true,
              before: sensitiveSnapshot,
              result: { kind: 'read' as const },
            }
          : command === 'set'
            ? {
                command,
                apply: true,
                complete: true,
                before: active(1),
                after: sensitiveSnapshot,
                proposedControl: sensitiveControl,
                result: {
                  kind: 'applied' as const,
                  revision: 2,
                  expiresAt: sensitiveControl.expiresAt,
                },
              }
            : {
                command,
                apply: true,
                complete: true,
                before: sensitiveSnapshot,
                after: { kind: 'missing' as const, revision: 3, control: null },
                result: { kind: 'cleared' as const, previousRevision: 2, revision: 3 },
              };

      const serialized = serializeCommercialOcrRuntimeControlResult(result, true);
      const parsed = JSON.parse(serialized) as Record<string, unknown>;

      expect(parsed).toMatchObject({
        command,
        complete: true,
        resultKind: command === 'get' ? 'read' : command === 'set' ? 'applied' : 'cleared',
        beforeKind: command === 'set' ? 'active' : sensitiveSnapshot.kind,
        kind: command === 'clear' ? 'missing' : 'active',
        revision: command === 'clear' ? 3 : 2,
        mode: command === 'clear' ? null : 'canary',
        chatCount: command === 'clear' ? 0 : 2,
        expiresAt: command === 'clear' ? null : sensitiveControl.expiresAt,
      });
      if (command !== 'clear') {
        expect(parsed.chatDigest).toBe(
          '6ee1a1c861cbd6928b51b3a8772d03924a25a327cad26fea9cfb319bc1ad85aa',
        );
      }
      expect(parsed).not.toHaveProperty('before');
      expect(parsed).not.toHaveProperty('after');
      expect(parsed).not.toHaveProperty('proposedControl');
      for (const forbidden of [
        'enforcementChatIds',
        'certificationExpiresAt',
        'approvalKeyIdSha256',
        'behaviorIdentitySha256',
        'actor',
        'reason',
        approvalKeyIdSha256,
        behaviorIdentitySha256,
        ...rawChatIds,
        rawActor,
        rawReason,
      ]) {
        expect(serialized).not.toContain(forbidden);
      }
    },
  );

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
