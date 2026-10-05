import { createHash } from 'node:crypto';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCommercialQualitySample } from '../moderation/commercial/commercial-quality-sampling';
import { extractCommercialOcrExactMessageSource } from '../moderation/commercial-ocr/commercial-ocr-exact-source';
import {
  assertPrivateImageOutputSafe,
  capturePrivateImageExport,
  findPrivateImageRepositoryRoot,
  runPrivateImageCheckpointExport,
  readPrivateImageExportOptions,
  selectPrivateImageExportSources,
  PRIVATE_IMAGE_SOURCE_CAP,
  PRIVATE_IMAGE_RAW_SCAN_CAP,
  PRIVATE_IMAGE_SCAN_PAGE_CAP,
  type PrivateImagePageOptions,
  type PrivateImageSamplePageRow,
  type PrivateImageReceiptPageRow,
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
  async function workspace(layout: 'SOURCE' | 'RUNTIME') {
    const scripts = join(
      repo,
      ...(layout === 'SOURCE'
        ? ['apps', 'api', 'src', 'scripts']
        : ['apps', 'api', 'dist', 'apps', 'api', 'src', 'scripts']),
    );
    await mkdir(scripts, { recursive: true, mode: 0o700 });
    await mkdir(join(repo, 'packages', 'contracts'), { recursive: true, mode: 0o700 });
    await writeFile(join(repo, 'apps', 'api', 'package.json'), '{"name":"@maxim/api"}');
    await writeFile(
      join(repo, 'packages', 'contracts', 'package.json'),
      '{"name":"@maxim/contracts"}',
    );
    return scripts;
  }
  function checkpointFixture(
    samples?: PrivateImageSamplePageRow[],
    receipts?: PrivateImageReceiptPageRow[],
  ) {
    const raw = receipt();
    const sampleRows = samples ?? [
      { ...sample(raw), id: 'sample-source', observedAt: new Date('2026-10-05T00:02:00.000Z') },
    ];
    const receiptRows = receipts ?? [
      { ...raw, id: 'receipt-source', createdAt: new Date('2026-10-05T00:01:00.000Z') },
    ];
    const next = <T extends { id: string }>(
      rows: T[],
      options: PrivateImagePageOptions,
      at: (row: T) => Date,
    ) =>
      rows
        .filter(
          (row) =>
            !options.cursor ||
            at(row).getTime() > options.cursor.createdAt.getTime() ||
            (at(row).getTime() === options.cursor.createdAt.getTime() &&
              row.id > options.cursor.id),
        )
        .slice(0, options.pageSize);
    return {
      options: { ...window, checkpointPath: join(folder, 'checkpoint.json') },
      secret,
      repositoryRoot: repo,
      sourceIdentitySha256: 'f'.repeat(64),
      loadSamplePage: jest.fn(async (options: PrivateImagePageOptions) =>
        next(sampleRows, options, (row) => row.observedAt),
      ),
      loadReceiptPage: jest.fn(async (options: PrivateImagePageOptions) =>
        next(receiptRows, options, (row) => row.createdAt),
      ),
      loadMatchedReceipts: jest.fn(async (ids: readonly string[]) =>
        receiptRows.filter((row) => ids.includes(row.id)),
      ),
      downloader: {
        download: jest.fn(async () => ({
          bytes: Buffer.from('private original'),
          format: 'jpeg' as const,
        })),
      },
      now: () => Date.now(),
    };
  }
  it('advances across TEXT-only pages and resumes past noisy padding without exposing private cursors', async () => {
    const raw = receipt();
    const text = Array.from({ length: 1000 }, (_, index) => ({
      id: `text-${String(index).padStart(4, '0')}`,
      observedAt: new Date(window.since),
      source: 'TEXT',
      qualityMetadata: {},
    }));
    const noise = Array.from({ length: 6000 }, (_, index) => ({
      id: `noise-${String(index).padStart(4, '0')}`,
      createdAt: new Date(Date.parse(window.since) - 9 * 60000),
      normalizedPayload: { type: 'not-message', raw: 'private-noise' },
    }));
    const params = checkpointFixture(
      [
        ...text,
        { ...sample(raw), id: 'source-sample', observedAt: new Date('2026-10-05T00:02:00.000Z') },
      ],
      [...noise, { ...raw, id: 'source-receipt', createdAt: new Date('2026-10-05T00:01:00.000Z') }],
    );
    const first = await runPrivateImageCheckpointExport(params);
    expect(first).toMatchObject({
      sampleRows: 1,
      matchedAlbums: 0,
      resumeRequired: true,
      rawRowsScannedThisRun: PRIVATE_IMAGE_RAW_SCAN_CAP,
      sampleWindowExhausted: true,
    });
    const checkpoint = await readFile(params.options.checkpointPath, 'utf8');
    expect(checkpoint).toContain('noise-3998');
    expect(checkpoint).not.toContain('private-noise');
    expect((await stat(params.options.checkpointPath)).mode & 0o077).toBe(0);
    const resumed = await runPrivateImageCheckpointExport({
      ...params,
      options: { ...params.options, resume: true },
    });
    expect(resumed).toMatchObject({
      matchedAlbums: 1,
      sourceLookupComplete: true,
      resumeRequired: false,
    });
    expect(params.downloader.download).not.toHaveBeenCalled();
    expect(JSON.stringify([first, resumed])).not.toMatch(
      /source-sample|source-receipt|noise-|private-chat|private-user|oneme/u,
    );
    expect(
      params.loadSamplePage.mock.calls.every(
        ([page]) => page.pageSize <= PRIVATE_IMAGE_SCAN_PAGE_CAP,
      ),
    ).toBe(true);
  });
  it('charges fetched raw rows when the source cap is reached midway through a page', async () => {
    const rows = Array.from({ length: 499 }, (_, index) => {
      const raw = receipt(`message-${index}`, '', [`photo-${index}`]);
      return {
        ...sample(raw),
        id: `sample-${String(index).padStart(4, '0')}`,
        observedAt: new Date(window.since),
      };
    });
    const final = {
      ...sample(receipt('last')),
      id: 'zz-final',
      observedAt: new Date('2026-10-05T00:00:01.000Z'),
    };
    const texts = Array.from({ length: 499 }, (_, index) => ({
      source: 'TEXT',
      qualityMetadata: {},
      id: `text-${String(index).padStart(4, '0')}`,
      observedAt: new Date('2026-10-05T00:00:02.000Z'),
    }));
    const noise = Array.from({ length: 5000 }, (_, index) => ({
      id: `noise-${String(index).padStart(4, '0')}`,
      createdAt: new Date(window.since),
      normalizedPayload: {},
    }));
    const params = checkpointFixture(
      [
        ...rows,
        { source: 'TEXT', qualityMetadata: {}, id: 'zz-text', observedAt: new Date(window.since) },
        final,
        ...texts,
      ],
      noise,
    );
    const report = await runPrivateImageCheckpointExport(params);
    expect(report).toMatchObject({
      sampleRows: 500,
      rawRowsScannedThisRun: PRIVATE_IMAGE_RAW_SCAN_CAP,
      rawSampleRowsScanned: 1000,
      rawReceiptRowsScanned: 4000,
      resumeRequired: true,
    });
  });
  it('roundtrips an authenticated checkpoint, exports once and carries image-budget residuals into a new batch', async () => {
    const one = receipt('one', '', ['photo-one']);
    const two = receipt('two', '', ['photo-two']);
    const params = checkpointFixture(
      [
        { ...sample(one), id: 'sample-one', observedAt: new Date(window.since) },
        { ...sample(two), id: 'sample-two', observedAt: new Date(window.since) },
      ],
      [
        { ...one, id: 'receipt-one', createdAt: new Date(window.since) },
        { ...two, id: 'receipt-two', createdAt: new Date(window.since) },
      ],
    );
    params.options.limit = 1;
    await runPrivateImageCheckpointExport(params);
    const applied = {
      ...params,
      options: {
        ...params.options,
        resume: true,
        apply: true,
        outputDir: join(folder, 'first-images'),
      },
    };
    const first = await runPrivateImageCheckpointExport(applied);
    expect(first).toMatchObject({
      capturedAlbums: 1,
      residualMatchedAlbums: 1,
      nextFrameAvailable: true,
      completeWithinMatchedSources: false,
    });
    await runPrivateImageCheckpointExport(applied);
    expect(params.downloader.download).toHaveBeenCalledTimes(1);
    await runPrivateImageCheckpointExport({
      ...params,
      options: { ...params.options, resume: true, nextFrame: true },
    });
    const next = await runPrivateImageCheckpointExport({
      ...params,
      options: {
        ...params.options,
        resume: true,
        apply: true,
        outputDir: join(folder, 'second-images'),
      },
    });
    expect(next).toMatchObject({
      capturedAlbums: 1,
      residualMatchedAlbums: 0,
      nextFrameAvailable: false,
    });
    expect(params.downloader.download).toHaveBeenCalledTimes(2);
    expect(params.downloader.download.mock.calls).toEqual([
      [expect.stringContaining('photo-one'), expect.anything()],
      [expect.stringContaining('photo-two'), expect.anything()],
    ]);
  });
  it('revalidates frozen source bytes/identity before any download', async () => {
    const params = checkpointFixture();
    await runPrivateImageCheckpointExport(params);
    params.loadMatchedReceipts.mockResolvedValueOnce([
      {
        ...receipt('source-one', 'Edited'),
        id: 'receipt-source',
        createdAt: new Date(window.since),
      },
    ]);
    const report = await runPrivateImageCheckpointExport({
      ...params,
      options: {
        ...params.options,
        resume: true,
        apply: true,
        outputDir: join(folder, 'changed-source'),
      },
    });
    expect(report.counters.source_receipt_revalidation_failed).toBe(1);
    expect(report.completeWithinMatchedSources).toBe(false);
    expect(params.downloader.download).not.toHaveBeenCalled();
  });
  it('reports an oversized album as a terminal omission and does not block the next sample batch', async () => {
    const raw = receipt('oversized', '', ['one', 'two']);
    const params = checkpointFixture(
      [{ ...sample(raw), id: 'source-sample', observedAt: new Date(window.since) }],
      [{ ...raw, id: 'source-receipt', createdAt: new Date(window.since) }],
    );
    params.options.limit = 1;
    await runPrivateImageCheckpointExport(params);
    const report = await runPrivateImageCheckpointExport({
      ...params,
      options: {
        ...params.options,
        resume: true,
        apply: true,
        outputDir: join(folder, 'oversized'),
      },
    });
    expect(report).toMatchObject({
      terminalAlbumBudgetOmissions: 1,
      residualMatchedAlbums: 0,
      nextFrameAvailable: false,
      completeWithinMatchedSources: false,
    });
    expect(params.downloader.download).not.toHaveBeenCalled();
  });
  it('keeps unavailable original-source reasons and treats an exact-full raw page as unproven exhaustion', async () => {
    const raw = receipt();
    const missing = receipt();
    missing.normalizedPayload.raw.message.body.attachments[0]!.payload.url = '';
    const params = checkpointFixture(
      [{ ...sample(raw), id: 'source-sample', observedAt: new Date(window.since) }],
      [{ ...missing, id: 'source-receipt', createdAt: new Date(window.since) }],
    );
    const report = await runPrivateImageCheckpointExport(params);
    expect(report).toMatchObject({
      matchedAlbums: 0,
      receiptWindowExhausted: true,
      counters: { matched_source_unavailable: 1, unmatched_sample_revisions: 1 },
    });
    const textOnly = checkpointFixture(
      Array.from({ length: PRIVATE_IMAGE_RAW_SCAN_CAP }, (_, index) => ({
        id: `text-${String(index).padStart(4, '0')}`,
        source: 'TEXT',
        qualityMetadata: {},
        observedAt: new Date(window.since),
      })),
      [],
    );
    textOnly.options.checkpointPath = join(folder, 'text-checkpoint.json');
    const full = await runPrivateImageCheckpointExport(textOnly);
    expect(full).toMatchObject({ sampleWindowExhausted: false, resumeRequired: true });
    const probe = await runPrivateImageCheckpointExport({
      ...textOnly,
      options: { ...textOnly.options, resume: true },
    });
    expect(probe).toMatchObject({
      sampleWindowExhausted: true,
      resumeRequired: false,
      rawRowsScannedThisRun: 0,
    });
  });
  it('blocks an interrupted export on resume and stops private writes after run-lock loss', async () => {
    const params = checkpointFixture();
    await runPrivateImageCheckpointExport(params);
    let lost = false;
    params.downloader.download.mockImplementationOnce(async () => {
      lost = true;
      return { bytes: Buffer.from('private'), format: 'jpeg' };
    });
    const applied = {
      ...params,
      options: {
        ...params.options,
        resume: true,
        apply: true,
        outputDir: join(folder, 'interrupted'),
      },
      assertHeld: () => {
        if (lost) throw new Error('Lost audit lock');
      },
    };
    await expect(runPrivateImageCheckpointExport(applied)).rejects.toThrow('Lost audit lock');
    await expect(
      runPrivateImageCheckpointExport({ ...params, options: { ...params.options, resume: true } }),
    ).rejects.toThrow('Interrupted private export requires operator recovery');
    expect(params.downloader.download).toHaveBeenCalledTimes(1);
    expect(await readdir(join(folder, 'interrupted'))).toEqual(['.capture-in-progress']);
  });
  it('rejects changed window/key/source, tampering and unsafe checkpoint locations before scanning', async () => {
    const params = checkpointFixture();
    await runPrivateImageCheckpointExport(params);
    params.loadSamplePage.mockClear();
    params.loadReceiptPage.mockClear();
    for (const change of [
      { options: { ...params.options, resume: true, since: '2026-10-05T00:00:01.000Z' } },
      { options: { ...params.options, resume: true }, secret: 'another-private-key-1234567890' },
      { options: { ...params.options, resume: true }, sourceIdentitySha256: 'a'.repeat(64) },
    ])
      await expect(runPrivateImageCheckpointExport({ ...params, ...change })).rejects.toThrow();
    expect(params.loadSamplePage).not.toHaveBeenCalled();
    expect(params.loadReceiptPage).not.toHaveBeenCalled();
    const original = await readFile(params.options.checkpointPath, 'utf8');
    await writeFile(params.options.checkpointPath, original.replace('READY', 'SAMPLES'));
    await expect(
      runPrivateImageCheckpointExport({ ...params, options: { ...params.options, resume: true } }),
    ).rejects.toThrow();
    await writeFile(params.options.checkpointPath, original);
    await chmod(params.options.checkpointPath, 0o644);
    await expect(
      runPrivateImageCheckpointExport({ ...params, options: { ...params.options, resume: true } }),
    ).rejects.toThrow();
    await chmod(params.options.checkpointPath, 0o600);
    const alias = join(folder, 'checkpoint-alias');
    await symlink(params.options.checkpointPath, alias);
    await expect(
      runPrivateImageCheckpointExport({
        ...params,
        options: { ...params.options, checkpointPath: alias, resume: true },
      }),
    ).rejects.toThrow();
    await expect(
      runPrivateImageCheckpointExport({
        ...params,
        options: { ...params.options, checkpointPath: join(repo, 'inside.json') },
      }),
    ).rejects.toThrow();
  });
  it('locates the loaded runtime workspace without a root package manifest', async () => {
    const scripts = await workspace('RUNTIME');
    expect(await readdir(repo)).not.toContain('package.json');
    const root = await findPrivateImageRepositoryRoot(scripts);
    expect(root).toBe(repo);
    await expect(
      assertPrivateImageOutputSafe(join(folder, 'private-output'), root),
    ).resolves.toBeUndefined();
    for (const output of [
      join(repo, 'private-output'),
      join(repo, 'apps', 'api', 'dist', 'private-output'),
      join(repo, 'packages', 'contracts', 'private-output'),
    ])
      await expect(assertPrivateImageOutputSafe(output, root)).rejects.toThrow(
        'Original images must remain outside the repository',
      );
  });
  it('locates the source workspace and ignores a misleading cwd with a maxim manifest', async () => {
    const scripts = await workspace('SOURCE');
    await writeFile(join(repo, 'package.json'), '{"name":"maxim"}');
    const unrelated = join(folder, 'unrelated');
    await mkdir(unrelated);
    await writeFile(join(unrelated, 'package.json'), '{"name":"maxim"}');
    const cwd = jest.spyOn(process, 'cwd').mockReturnValue(unrelated);
    try {
      await expect(findPrivateImageRepositoryRoot(scripts)).resolves.toBe(repo);
      expect(cwd).not.toHaveBeenCalled();
      await expect(findPrivateImageRepositoryRoot(unrelated)).rejects.toThrow(
        'Repository root unavailable; refuse original-image output',
      );
    } finally {
      cwd.mockRestore();
    }
  });
  it.each(['apps/api/package.json', 'packages/contracts/package.json'])(
    'rejects a wrong or missing workspace marker at %s even with a maxim root manifest',
    async (manifest) => {
      const scripts = await workspace('RUNTIME');
      await writeFile(join(repo, 'package.json'), '{"name":"maxim"}');
      await writeFile(join(repo, manifest), '{"name":"unrelated-workspace"}');
      await expect(findPrivateImageRepositoryRoot(scripts)).rejects.toThrow(
        'Repository root unavailable; refuse original-image output',
      );
      await rm(join(repo, manifest));
      await expect(findPrivateImageRepositoryRoot(scripts)).rejects.toThrow(
        'Repository root unavailable; refuse original-image output',
      );
    },
  );
  it('resolves module symlinks to the actual workspace and rejects symlinked workspace markers', async () => {
    const scripts = await workspace('RUNTIME');
    const alias = join(folder, 'module-alias');
    await symlink(scripts, alias);
    const root = await findPrivateImageRepositoryRoot(alias);
    expect(root).toBe(repo);
    await expect(assertPrivateImageOutputSafe(join(repo, 'out'), root)).rejects.toThrow();
    const contracts = join(repo, 'packages', 'contracts', 'package.json');
    const marker = join(folder, 'foreign-contracts.json');
    await writeFile(marker, '{"name":"@maxim/contracts"}');
    await rm(contracts);
    await symlink(marker, contracts);
    await expect(findPrivateImageRepositoryRoot(scripts)).rejects.toThrow(
      'Repository root unavailable; refuse original-image output',
    );
  });
  it('rejects an unsupported module layout, a missing module and a relative module path', async () => {
    await workspace('SOURCE');
    const wrong = join(repo, 'apps', 'api', 'dist', 'src', 'scripts');
    await mkdir(wrong, { recursive: true });
    for (const moduleDirectory of [
      wrong,
      join(folder, 'missing-private-module'),
      'apps/api/src/scripts',
    ])
      await expect(findPrivateImageRepositoryRoot(moduleDirectory)).rejects.toThrow(
        'Repository root unavailable; refuse original-image output',
      );
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
