import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCommercialQualitySample } from '../moderation/commercial/commercial-quality-sampling';
import { extractCommercialOcrExactMessageSource } from '../moderation/commercial-ocr/commercial-ocr-exact-source';
import {
  assertPrivateImageOutputSafe,
  capturePrivateImageExport,
  readPrivateImageExportOptions,
  selectPrivateImageExportSources,
  PRIVATE_IMAGE_SOURCE_CAP,
} from './export-commercial-private-images';

const secret = 'private-image-test-secret-1234567890';
const window = {
  since: '2026-10-05T00:00:00.000Z',
  until: '2026-10-05T01:00:00.000Z',
  limit: 500,
  outputDir: null,
  apply: false,
};
function receipt(id = 'source-one', caption = '', photos = ['photo-one']) {
  return {
    normalizedPayload: {
      type: 'message_created',
      raw: {
        message: {
          timestamp: '2026-10-05T00:01:00.000Z',
          recipient: { chat_id: 'private-chat' },
          sender: { user_id: 'private-user', is_bot: false },
          body: {
            mid: id,
            text: caption,
            attachments: photos.map((photoId) => ({
              type: 'image',
              payload: { photo_id: photoId, url: `https://i.oneme.ru/private/${photoId}` },
            })),
          },
        },
      },
    },
  };
}
function sample(row = receipt(), stratum: 'NO_HIT' | 'TECHNICAL' = 'NO_HIT') {
  const exact = extractCommercialOcrExactMessageSource(row.normalizedPayload.raw)!;
  const sampled = buildCommercialQualitySample({
    secret,
    chatId: exact.source.chatId,
    userId: exact.source.senderId,
    messageId: exact.source.messageId,
    text: exact.source.caption,
    messageCreatedAt: exact.source.sourceCreatedAt,
    source: 'OCR',
    hasDetection: true,
    sourceIdentity: JSON.stringify(exact.source),
  })!;
  return {
    source: 'OCR',
    qualityMetadata: {
      ...sampled,
      schemaVersion: 2,
      samplingProbability: stratum === 'NO_HIT' ? 0.1 : 1,
      samplingStratum: stratum,
      imageReviewRequired: true,
      sourceExcerptComplete: true,
      settingsProfileDigest: 'a'.repeat(64),
      detectorSourceSha256: 'b'.repeat(64),
      hasDetection: false,
      decisionOutcome: 'KEEP',
      deleteEligible: false,
      executionOutcome: 'NOT_REQUESTED',
      analysisOutcome: stratum === 'TECHNICAL' ? 'TECHNICAL_INCOMPLETE' : 'COMPLETE',
      candidateDecision: null,
    },
  };
}

describe('bounded private commercial source-image export', () => {
  let folder: string;
  let repo: string;
  beforeEach(async () => {
    folder = await mkdtemp(join(tmpdir(), 'commercial-private-test-'));
    repo = join(folder, 'repository');
    await mkdir(repo, { mode: 0o700 });
  });
  afterEach(async () => {
    await rm(folder, { recursive: true, force: true });
  });
  it('defaults to preview and requires an explicit UTC window, bounded image limit and apply output', () => {
    expect(
      readPrivateImageExportOptions(['--since', window.since, '--until', window.until]).apply,
    ).toBe(false);
    for (const args of [
      [],
      ['--since', window.since, '--until', window.until, '--apply'],
      ['--since', window.since, '--until', window.until, '--limit', '501'],
      ['--since', window.since, '--until', '2026-10-07T00:00:00.000Z'],
      ['--since', window.since, '--until', window.until, '--output-dir', './public'],
      ['--since', window.since, '--until', window.until, '--sql', 'select secret'],
    ])
      expect(() => readPrivateImageExportOptions(args)).toThrow();
  });
  it('retains captionless no-hits and technical samples, exact source revisions and mirrored deduplication', () => {
    const first = receipt();
    const second = receipt('source-two', '', ['photo-two']);
    const selected = selectPrivateImageExportSources(
      [sample(first), sample(second, 'TECHNICAL')],
      [first, first, second],
      secret,
    );
    expect(selected.selected).toHaveLength(2);
    expect(selected.selected.map((row) => row.quality.samplingStratum)).toEqual([
      'NO_HIT',
      'TECHNICAL',
    ]);
    expect(selected.selected[0]?.source.source.caption).toBe('');
    expect(
      selectPrivateImageExportSources(
        [sample(first)],
        [receipt('source-one', 'Edited caption')],
        secret,
      ).selected,
    ).toEqual([]);
    expect(
      selectPrivateImageExportSources([sample(first)], [first], 'different-private-key-1234567890')
        .counters.pseudonym_key_mismatch,
    ).toBe(1);
  });
  it('does not inspect sample or receipt rows beyond the hard source cap', () => {
    const raw = receipt();
    const receipts = [
      ...Array.from({ length: PRIVATE_IMAGE_SOURCE_CAP }, () => ({
        normalizedPayload: { type: 'not-message' },
      })),
      raw,
    ];
    const selected = selectPrivateImageExportSources([sample(raw)], receipts, secret);
    expect(selected.selected).toEqual([]);
    expect(selected.counters.unmatched_sample_revisions).toBe(1);
  });
  it('performs no download or filesystem mutation in preview and emits no identifiers or private source data', async () => {
    const raw = receipt('private-message', 'Контакт +7 900 123-45-67');
    const downloader = { download: jest.fn() };
    const report = await capturePrivateImageExport({
      options: window,
      samples: [sample(raw)],
      receipts: [raw],
      secret,
      downloader,
      repositoryRoot: repo,
      deadlineAtMs: Date.now() + 1000,
    });
    expect(downloader.download).not.toHaveBeenCalled();
    expect(await readdir(folder)).toEqual(['repository']);
    expect(JSON.stringify(report)).not.toMatch(
      /private-message|private-user|private-chat|oneme|900|Контакт/u,
    );
    expect(report).toMatchObject({
      mode: 'PREVIEW',
      matchedAlbums: 1,
      capturedImages: 0,
      populationCoverageKnown: false,
    });
  });
  it('refuses existing, shared, symlinked and repository-owned output locations', async () => {
    await expect(assertPrivateImageOutputSafe(join(folder, 'out'), repo)).resolves.toBeUndefined();
    await expect(assertPrivateImageOutputSafe(repo, repo)).rejects.toThrow();
    await expect(assertPrivateImageOutputSafe(join(repo, 'out'), repo)).rejects.toThrow();
    const shared = join(folder, 'shared');
    await mkdir(shared, { mode: 0o755 });
    await expect(assertPrivateImageOutputSafe(join(shared, 'out'), repo)).rejects.toThrow();
    const link = join(folder, 'alias');
    await symlink(folder, link);
    await expect(assertPrivateImageOutputSafe(join(link, 'out'), repo)).rejects.toThrow();
  });
  it('writes original byte hashes and blinded review manifests with private permissions, omitting scores, labels, URLs and raw identities', async () => {
    const raw = receipt('private-message', 'Позвоните +7 900 123-45-67');
    const bytes = Buffer.from('original private photo bytes');
    const expectedHash = createHash('sha256').update(bytes).digest('hex');
    const downloader = { download: jest.fn().mockResolvedValue({ bytes, format: 'jpeg' }) };
    const outputDir = join(folder, 'images');
    const report = await capturePrivateImageExport({
      options: { ...window, apply: true, outputDir },
      samples: [sample(raw)],
      receipts: [raw],
      secret,
      downloader,
      repositoryRoot: repo,
      deadlineAtMs: Date.now() + 1000,
    });
    const manifestBytes = await readFile(join(outputDir, 'review-sources.jsonl'));
    const manifest = JSON.parse(manifestBytes.toString()) as {
      images: Array<{ file: string; sha256: string }>;
    };
    expect(manifest.images[0]?.sha256).toBe(expectedHash);
    expect(
      createHash('sha256')
        .update(await readFile(join(outputDir, manifest.images[0]!.file)))
        .digest('hex'),
    ).toBe(expectedHash);
    expect(report.reviewManifestSha256).toBe(
      createHash('sha256').update(manifestBytes).digest('hex'),
    );
    expect(manifestBytes.toString()).not.toMatch(
      /900|private-message|private-user|private-chat|https|samplingStratum|score|label|decisionOutcome/u,
    );
    const provenance = await readFile(join(outputDir, 'operator-provenance.json'), 'utf8');
    expect(provenance).not.toMatch(
      /private-message|private-user|private-chat|oneme|900|candidateDecision|deleteEligible/u,
    );
    expect((await stat(outputDir)).mode & 0o077).toBe(0);
    expect((await stat(join(outputDir, manifest.images[0]!.file))).mode & 0o077).toBe(0);
    expect(bytes.every((value) => value === 0)).toBe(true);
    expect(await readdir(outputDir)).not.toContain('.capture-in-progress');
    expect(report).toMatchObject({
      capturedAlbums: 1,
      capturedImages: 1,
      completeWithinMatchedSources: true,
      populationCoverageKnown: false,
    });
  });
  it('preserves complete albums at image caps and does not retain partial albums after a failed download', async () => {
    const raw = receipt('album-source', '', ['one', 'two']);
    const outputDir = join(folder, 'capped');
    const downloader = { download: jest.fn() };
    const capped = await capturePrivateImageExport({
      options: { ...window, limit: 1, apply: true, outputDir },
      samples: [sample(raw)],
      receipts: [raw],
      secret,
      downloader,
      repositoryRoot: repo,
      deadlineAtMs: Date.now() + 1000,
    });
    expect(downloader.download).not.toHaveBeenCalled();
    expect(capped.capturedImages).toBe(0);
    expect(capped.counters.complete_album_over_image_budget).toBe(1);
    expect(capped.completeWithinMatchedSources).toBe(false);
    const bytes = Buffer.from('original');
    downloader.download
      .mockResolvedValueOnce({ bytes, format: 'jpeg' })
      .mockRejectedValueOnce(new Error('https://private.example/secret'));
    const failedDir = join(folder, 'failed');
    const failed = await capturePrivateImageExport({
      options: { ...window, apply: true, outputDir: failedDir },
      samples: [sample(raw)],
      receipts: [raw],
      secret,
      downloader,
      repositoryRoot: repo,
      deadlineAtMs: Date.now() + 1000,
    });
    expect(failed.capturedImages).toBe(0);
    expect(failed.counters.album_capture_failed).toBe(1);
    expect(await readdir(failedDir)).toEqual(['operator-provenance.json', 'review-sources.jsonl']);
    expect(bytes.every((value) => value === 0)).toBe(true);
    expect(JSON.stringify(failed)).not.toContain('private.example');
  });
  it('marks receipt/sample cap saturation, source mismatches and deadlines as incomplete', async () => {
    const raw = receipt();
    const sampleRows = Array.from({ length: PRIVATE_IMAGE_SOURCE_CAP + 1 }, () => sample(raw));
    const report = await capturePrivateImageExport({
      options: { ...window, apply: true, outputDir: join(folder, 'deadline') },
      samples: sampleRows,
      receipts: [raw],
      secret,
      downloader: { download: jest.fn() },
      repositoryRoot: repo,
      deadlineAtMs: Date.now() - 1,
    });
    expect(report.sampleTruncated).toBe(true);
    expect(report.completeWithinMatchedSources).toBe(false);
    expect(report.capturedImages).toBe(0);
    expect(report.counters.collection_deadline).toBe(1);
  });
});
