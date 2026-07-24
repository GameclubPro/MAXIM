import { createHash } from 'node:crypto';
import { readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp } from 'node:fs/promises';

import {
  COMMERCIAL_MANUAL_OVERLAY_SCHEMA_VERSION,
  fingerprintCommercialManualOverlayContext,
  type CommercialManualOverlayRecord,
} from './commercial-manual-overlay.util';
import { remapCommercialManualOverlay } from './commercial-manual-overlay-remap.util';

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

const settings = {
  commercialAdsSensitivity: 'BALANCED' as const,
  commercialAdsWarnThreshold: 45,
  commercialAdsDeleteThreshold: 65,
};
const commercialCampaignContext = {
  senderDistinctChatCount: 1,
  sameTextDistinctChatCount: 1,
  repeatedPhoneDistinctChatCount: 0,
  repeatedLinkDistinctChatCount: 0,
};

function corpusRecord(text: string, context = commercialCampaignContext) {
  return { text, settings, commercialCampaignContext: context };
}

describe('remapCommercialManualOverlay', () => {
  it('remaps text hashes by corpus line while preserving validated manual metadata', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'commercial-overlay-remap-'));
    const sourcePath = join(directory, 'source.jsonl');
    const targetPath = join(directory, 'target.jsonl');
    const overlayPath = join(directory, 'overlay.jsonl');
    const outputPath = join(directory, 'remapped.jsonl');
    const summaryPath = join(directory, 'lineage.json');
    const sourceBody = `${JSON.stringify(corpusRecord('Телефон +79990000000'))}\n`;
    const targetBody = `${JSON.stringify(corpusRecord('Телефон [phone]'))}\n`;
    const sourceSha256 = sha256(sourceBody);
    const contextFingerprint = fingerprintCommercialManualOverlayContext(
      settings,
      commercialCampaignContext,
    );
    const overlay: CommercialManualOverlayRecord = {
      schemaVersion: COMMERCIAL_MANUAL_OVERLAY_SCHEMA_VERSION,
      inputSha256: sourceSha256,
      line: 1,
      textSha256: sha256('Телефон +79990000000'),
      manualLabel: 'service',
      confidence: 'high',
      recommendedAction: 'WARN',
      sourceFiles: ['review.tsv'],
      settings,
      commercialCampaignContext,
      contextFingerprint,
    };
    await Promise.all([
      writeFile(sourcePath, sourceBody),
      writeFile(targetPath, targetBody),
      writeFile(overlayPath, `${JSON.stringify(overlay)}\n`),
    ]);

    try {
      const summary = await remapCommercialManualOverlay({
        sourceInputPath: sourcePath,
        targetInputPath: targetPath,
        overlayPath,
        outputPath,
        summaryOutputPath: summaryPath,
      });
      const remapped = JSON.parse((await readFile(outputPath, 'utf8')).trim()) as Record<
        string,
        unknown
      >;

      expect(summary.validation).toEqual({
        sourceTextHashes: 1,
        contextFingerprints: 1,
        changedTextHashes: 1,
      });
      expect(remapped).toEqual({
        ...overlay,
        inputSha256: sha256(targetBody),
        textSha256: sha256('Телефон [phone]'),
      });
      expect((await stat(outputPath)).mode & 0o777).toBe(0o600);
      expect((await stat(summaryPath)).mode & 0o777).toBe(0o600);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('fails closed when target settings or campaign context drift at a selected line', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'commercial-overlay-remap-drift-'));
    const sourcePath = join(directory, 'source.jsonl');
    const targetPath = join(directory, 'target.jsonl');
    const overlayPath = join(directory, 'overlay.jsonl');
    const outputPath = join(directory, 'remapped.jsonl');
    const summaryPath = join(directory, 'lineage.json');
    const sourceText = 'Исходный текст';
    const sourceBody = `${JSON.stringify(corpusRecord(sourceText))}\n`;
    const targetBody = `${JSON.stringify(
      corpusRecord('Новый текст', { ...commercialCampaignContext, senderDistinctChatCount: 2 }),
    )}\n`;
    const overlay: CommercialManualOverlayRecord = {
      schemaVersion: COMMERCIAL_MANUAL_OVERLAY_SCHEMA_VERSION,
      inputSha256: sha256(sourceBody),
      line: 1,
      textSha256: sha256(sourceText),
      manualLabel: 'service',
      confidence: 'high',
      recommendedAction: null,
      sourceFiles: ['review.tsv'],
      settings,
      commercialCampaignContext,
      contextFingerprint: fingerprintCommercialManualOverlayContext(
        settings,
        commercialCampaignContext,
      ),
    };
    await Promise.all([
      writeFile(sourcePath, sourceBody),
      writeFile(targetPath, targetBody),
      writeFile(overlayPath, `${JSON.stringify(overlay)}\n`),
    ]);

    try {
      await expect(
        remapCommercialManualOverlay({
          sourceInputPath: sourcePath,
          targetInputPath: targetPath,
          overlayPath,
          outputPath,
          summaryOutputPath: summaryPath,
        }),
      ).rejects.toThrow('Target context drift');
      await expect(readFile(outputPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(readFile(summaryPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
