import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import {
  calculateCommercialAuditToolSourceDigest,
  calculateCommercialDetectorSourceDigest,
  resolveCommercialRunProvenance,
} from './commercial-run-provenance.util';

const REPOSITORY_ROOT = resolve(__dirname, '../../../..');

describe('commercial run provenance', () => {
  it('binds a run to detector sources and explicit policy versions', async () => {
    const startedAt = '2026-07-23T18:00:00.000Z';
    const provenance = await resolveCommercialRunProvenance({
      startedAt,
      repositoryRoot: REPOSITORY_ROOT,
    });

    expect(provenance).toEqual(
      expect.objectContaining({
        startedAt,
        git: expect.objectContaining({
          commit: expect.stringMatching(/^[a-f0-9]{40}$/u),
          dirty: expect.any(Boolean),
        }),
        detector: expect.objectContaining({
          digestKind: 'SOURCE_FILES',
          sourceSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
          decisionVersion: 'commercial-deterministic-v2',
          patternPolicyVersion: 'commercial-patterns-v2',
          classifierVersion: '2026-service-private-v4',
        }),
        auditTool: {
          digestKind: 'SOURCE_FILES',
          sourceSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        },
      }),
    );
  });

  it('calculates a deterministic detector source digest', async () => {
    const first = await calculateCommercialDetectorSourceDigest(REPOSITORY_ROOT);
    const second = await calculateCommercialDetectorSourceDigest(REPOSITORY_ROOT);

    expect(first).toEqual(second);
    expect(first.digestKind).toBe('SOURCE_FILES');
    expect(first.sourceSha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('calculates a deterministic audit-tool source digest', async () => {
    const first = await calculateCommercialAuditToolSourceDigest(REPOSITORY_ROOT);
    const second = await calculateCommercialAuditToolSourceDigest(REPOSITORY_ROOT);

    expect(first).toEqual(second);
    expect(first.digestKind).toBe('SOURCE_FILES');
    expect(first.sourceSha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('changes the detector digest when shared normalization changes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'commercial-provenance-normalization-'));
    const normalizationPath = join(
      directory,
      'apps/api/src/moderation/rule-engine-normalization.ts',
    );
    const sourceFiles = [
      'apps/api/src/common/url-text.util.ts',
      'apps/api/src/moderation/commercial-campaign.util.ts',
      'apps/api/src/moderation/commercial/example.ts',
      'apps/api/src/moderation/rule-engine-commercial-second-stage-cache.ts',
      'apps/api/src/moderation/rule-engine-commercial-thresholds.ts',
      'apps/api/src/moderation/rule-engine-detection-context.ts',
      'apps/api/src/moderation/rule-engine-normalization.ts',
    ];

    try {
      for (const relativePath of sourceFiles) {
        const pathname = join(directory, relativePath);
        await mkdir(dirname(pathname), { recursive: true });
        await writeFile(pathname, `export const source = ${JSON.stringify(relativePath)};\n`);
      }
      const before = await calculateCommercialDetectorSourceDigest(directory);
      await writeFile(normalizationPath, 'export const source = "changed";\n');
      const after = await calculateCommercialDetectorSourceDigest(directory);

      expect(before.digestKind).toBe('SOURCE_FILES');
      expect(after.digestKind).toBe('SOURCE_FILES');
      expect(after.sourceSha256).not.toBe(before.sourceSha256);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
