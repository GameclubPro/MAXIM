import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { COMMERCIAL_INTENT_QUALITY_COHORT } from '../moderation/commercial/commercial-policy-cohorts';
import * as holdoutEvidence from './commercial-text-holdout-artifact';
import {
  parseCommercialTextControlOptions,
  runCommercialTextControlCommand,
} from './commercial-text-runtime-control';

describe('commercial text control operator boundary', () => {
  afterEach(() => jest.restoreAllMocks());
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

  const qualityArgs = () => [
    'set',
    '--mode',
    'canary',
    '--expected-revision',
    '0',
    '--ttl-hours',
    '1',
    '--chat-id=-123',
    '--cohort',
    COMMERCIAL_INTENT_QUALITY_COHORT,
    '--artifact',
    '/private/selected.json',
    '--reviewed-artifact-sha256',
    'a'.repeat(64),
    '--settings-profile-digest',
    holdoutEvidence.COMMERCIAL_TEXT_QUALITY_REQUIRED_PROFILES[0]!.digest,
  ];
  const companionArgs = () => [
    '--companion-artifact',
    '/private/companion.json',
    '--reviewed-companion-artifact-sha256',
    'b'.repeat(64),
  ];
  it.each(['missing', 'unpaired', 'duplicate-path', 'duplicate-hash', 'invalid-hash'])(
    'rejects quality promotion with missing or unreviewed companion inputs: %s',
    (failure) => {
      const companions = failure === 'missing' ? [] : companionArgs();
      if (failure === 'unpaired') companions.splice(2, 2);
      if (failure === 'duplicate-path') companions[1] = '/private/selected.json';
      if (failure === 'duplicate-hash') companions[3] = 'a'.repeat(64);
      if (failure === 'invalid-hash') companions[3] = 'unknown';
      expect(() => parseCommercialTextControlOptions([...qualityArgs(), ...companions])).toThrow(
        'companion artifacts',
      );
    },
  );
  it('keeps legacy promotion independent of the new companion contract', () => {
    const args = qualityArgs();
    args[args.indexOf(COMMERCIAL_INTENT_QUALITY_COHORT)] = 'owned-service-contrast-v1';
    expect(() => parseCommercialTextControlOptions(args)).not.toThrow();
    expect(() => parseCommercialTextControlOptions([...args, ...companionArgs()])).toThrow(
      'only an intent quality',
    );
  });

  async function withPrivateArtifacts(
    callback: (
      args: string[],
      selected: unknown,
      companion: unknown,
      companionPath: string,
    ) => Promise<void>,
  ) {
    const directory = await mkdtemp(join(tmpdir(), 'commercial-quality-control-'));
    try {
      const selected = { expiresAt: '2026-10-05T10:50:00.000Z' };
      const companion = { expiresAt: '2026-10-05T10:20:00.000Z' };
      const selectedPath = join(directory, 'selected.json');
      const companionPath = join(directory, 'companion.json');
      const selectedBytes = JSON.stringify(selected);
      const companionBytes = JSON.stringify(companion);
      await writeFile(selectedPath, selectedBytes);
      await writeFile(companionPath, companionBytes);
      const args = qualityArgs();
      args[args.indexOf('/private/selected.json')] = selectedPath;
      args[args.indexOf('a'.repeat(64))] = createHash('sha256').update(selectedBytes).digest('hex');
      const companions = companionArgs();
      companions[1] = companionPath;
      companions[3] = createHash('sha256').update(companionBytes).digest('hex');
      await callback([...args, ...companions, '--apply'], selected, companion, companionPath);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  it('verifies both reviewed files, caps expiry to their minimum and binds only the selected profile', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-05T10:00:00.000Z'));
    const companionValidation = jest
      .spyOn(holdoutEvidence, 'validateCommercialTextQualityCompanionArtifacts')
      .mockReturnValue({
        valid: true,
        approvedCohorts: [COMMERCIAL_INTENT_QUALITY_COHORT],
        errors: [],
        cohortMetrics: [],
      });
    const selectedValidation = jest.spyOn(holdoutEvidence, 'validateCommercialTextHoldoutArtifact');
    await withPrivateArtifacts(async (args, selected, companion) => {
      const h = service();
      await expect(runCommercialTextControlCommand(h, args)).resolves.toMatchObject({
        applied: true,
      });
      expect(companionValidation).toHaveBeenCalledWith(
        [selected, companion],
        expect.objectContaining({
          settingsProfileDigest:
            holdoutEvidence.COMMERCIAL_TEXT_QUALITY_REQUIRED_PROFILES[0]!.digest,
        }),
      );
      expect(selectedValidation).not.toHaveBeenCalled();
      expect(h.set).toHaveBeenCalledWith(
        expect.objectContaining({
          settingsProfileDigests: [
            holdoutEvidence.COMMERCIAL_TEXT_QUALITY_REQUIRED_PROFILES[0]!.digest,
          ],
          holdoutArtifactSha256: args[args.indexOf('--reviewed-artifact-sha256') + 1],
          expiresAt: '2026-10-05T10:20:00.000Z',
        }),
        0,
      );
    });
  });

  it('does not apply when companion bytes changed after independent review', async () => {
    await withPrivateArtifacts(async (args, _selected, _companion, path) => {
      await writeFile(path, '{"changed":true}');
      const h = service();
      await expect(runCommercialTextControlCommand(h, args)).rejects.toThrow(
        'Frozen artifact digest mismatch',
      );
      expect(h.set).not.toHaveBeenCalled();
    });
  });

  it('does not apply when either independently reviewed profile fails the joint gate', async () => {
    jest.spyOn(holdoutEvidence, 'validateCommercialTextQualityCompanionArtifacts').mockReturnValue({
      valid: false,
      approvedCohorts: [],
      errors: ['STRICT companion failed'],
      cohortMetrics: [],
    });
    await withPrivateArtifacts(async (args) => {
      const h = service();
      await expect(runCommercialTextControlCommand(h, args)).rejects.toThrow(
        'Independent holdout quality/provenance gate failed',
      );
      expect(h.set).not.toHaveBeenCalled();
    });
  });
});
