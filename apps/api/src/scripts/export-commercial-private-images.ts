import {
  commercialReviewEvidenceMetadataSchema,
  type CommercialReviewEvidenceMetadata,
} from '@maxim/contracts/safety-desk';
import { ConfigService } from '@nestjs/config';
import { config as loadEnv } from 'dotenv';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { Prisma, createPrismaClient } from '../prisma/prisma-client';
import {
  SecurePhotoDownloader,
  type DownloadedPhoto,
} from '../moderation/photo-duplicate/secure-photo-downloader';
import {
  extractCommercialOcrExactMessageSource,
  type CommercialOcrExactMessageSource,
} from '../moderation/commercial-ocr/commercial-ocr-exact-source';
import { buildCommercialQualitySample } from '../moderation/commercial/commercial-quality-sampling';
import {
  buildAuditScanWindowSql,
  resolveCommercialAuditPrismaPoolConfig,
} from './commercial-audit-scan-window';
import { withCommercialAuditRunLock } from './commercial-audit-run-lock.util';
import {
  hasResidualCommercialContactCandidate,
  sanitizeCommercialCorpusText,
} from './commercial-corpus-sanitization.util';

export const PRIVATE_IMAGE_SOURCE_CAP = 500;
export const PRIVATE_IMAGE_BYTE_CAP = 256 * 1024 * 1024;
const RUN_DEADLINE_MS = 120_000;
const SOURCE_PADDING_MS = 10 * 60_000;
type Counter = Record<string, number>;
type Sample = { source?: string; qualityMetadata: unknown };
type Receipt = { normalizedPayload: unknown };
type Selected = {
  quality: CommercialReviewEvidenceMetadata;
  source: CommercialOcrExactMessageSource;
};
export type PrivateImageExportOptions = {
  since: string;
  until: string;
  limit: number;
  outputDir: string | null;
  apply: boolean;
};
const count = (counts: Counter, name: string, amount = 1) => {
  counts[name] = (counts[name] ?? 0) + amount;
};
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

export function readPrivateImageExportOptions(argv: readonly string[]): PrivateImageExportOptions {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      since: { type: 'string' },
      until: { type: 'string' },
      limit: { type: 'string' },
      'output-dir': { type: 'string' },
      apply: { type: 'boolean', default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  const limit = Number(values.limit ?? '50');
  if (
    !values.since ||
    !values.until ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(values.since) ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(values.until) ||
    !Number.isFinite(Date.parse(values.since)) ||
    !Number.isFinite(Date.parse(values.until)) ||
    Date.parse(values.since) >= Date.parse(values.until) ||
    Date.parse(values.until) - Date.parse(values.since) > 86400_000 ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > PRIVATE_IMAGE_SOURCE_CAP ||
    (values['output-dir'] && !isAbsolute(values['output-dir'])) ||
    (values.apply && !values['output-dir'])
  )
    throw new Error(
      'Usage: --since <UTC ISO> --until <UTC ISO; window <=24h> [--limit <1..500>] [--output-dir <new private absolute directory outside repository> --apply]',
    );
  return {
    since: new Date(values.since).toISOString(),
    until: new Date(values.until).toISOString(),
    limit,
    outputDir: values['output-dir'] ?? null,
    apply: values.apply,
  };
}

// FLAG: Source selection matches the exact frozen revision, never a caption proxy or latest edit.
// All captured strata are eligible for collection; detector decisions never choose image labels.
export function selectPrivateImageExportSources(
  samples: readonly Sample[],
  receipts: readonly Receipt[],
  secret: string | undefined,
) {
  const counters: Counter = {};
  const wanted = new Map<string, CommercialReviewEvidenceMetadata>();
  const keyIdentity = buildCommercialQualitySample({
    secret,
    chatId: 'identity-check',
    userId: 'identity-check',
    messageId: 'identity-check',
    text: '',
    messageCreatedAt: '2000-01-01T00:00:00.000Z',
    source: 'OCR',
    hasDetection: true,
  })?.pseudonymizationKeyId;
  for (const sample of samples.slice(0, PRIVATE_IMAGE_SOURCE_CAP)) {
    if (sample.source !== undefined && sample.source !== 'OCR') continue;
    const parsed = commercialReviewEvidenceMetadataSchema.safeParse(sample.qualityMetadata);
    if (
      !parsed.success ||
      !parsed.data.sourceSnapshotSha256 ||
      !parsed.data.pseudonymizationKeyId
    ) {
      count(counters, 'source_provenance_unavailable');
      continue;
    }
    if (!keyIdentity || parsed.data.pseudonymizationKeyId !== keyIdentity) {
      count(counters, 'pseudonym_key_mismatch');
      continue;
    }
    if (wanted.has(parsed.data.sourceSnapshotSha256)) {
      count(counters, 'duplicate_sample_revision');
      continue;
    }
    wanted.set(parsed.data.sourceSnapshotSha256, parsed.data);
  }
  const selected: Selected[] = [];
  const seen = new Set<string>();
  for (const row of receipts.slice(0, PRIVATE_IMAGE_SOURCE_CAP)) {
    const payload = record(row.normalizedPayload);
    if (!['message_created', 'message_edited'].includes(String(payload.type))) continue;
    const exact = extractCommercialOcrExactMessageSource(payload.raw);
    if (!exact || exact.authorKind !== 'user') {
      count(counters, 'receipt_source_ineligible');
      continue;
    }
    const identity = buildCommercialQualitySample({
      secret,
      chatId: exact.source.chatId,
      userId: exact.source.senderId,
      messageId: exact.source.messageId,
      text: exact.source.caption,
      messageCreatedAt: exact.source.sourceCreatedAt,
      source: 'OCR',
      hasDetection: true,
      sourceIdentity: JSON.stringify(exact.source),
    });
    const quality = identity && wanted.get(identity.sourceSnapshotSha256);
    if (!quality || !identity || seen.has(identity.sourceSnapshotSha256)) continue;
    if (
      !exact.images.length ||
      new Set(exact.source.orderedPhotoIds).size !== exact.images.length ||
      exact.images.some((image) => !image.downloadUrl)
    ) {
      count(counters, 'matched_source_unavailable');
      continue;
    }
    selected.push({ quality, source: exact });
    seen.add(identity.sourceSnapshotSha256);
  }
  counters.unmatched_sample_revisions = wanted.size - seen.size;
  return { selected, counters };
}

export async function assertPrivateImageOutputSafe(outputDir: string, repositoryRoot: string) {
  const output = resolve(outputDir);
  const parent = dirname(output);
  if (!isAbsolute(outputDir) || basename(output) === '.' || basename(output) === '..')
    throw new Error('A new absolute private directory is required');
  const [parentReal, parentInfo] = await Promise.all([realpath(parent), lstat(parent)]);
  if (
    parentReal !== parent ||
    parentInfo.isSymbolicLink() ||
    !parentInfo.isDirectory() ||
    (parentInfo.mode & 0o077) !== 0 ||
    (typeof process.getuid === 'function' && parentInfo.uid !== process.getuid())
  )
    throw new Error('Output parent must be an existing owner-private real directory');
  const repo = await realpath(repositoryRoot);
  const distance = relative(repo, output);
  if (!distance || (!distance.startsWith(`..${sep}`) && distance !== '..' && !isAbsolute(distance)))
    throw new Error('Original images must remain outside the repository');
  try {
    await lstat(output);
    throw new Error('Output directory must not already exist');
  } catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'))
      throw error;
  }
}

export async function capturePrivateImageExport(params: {
  options: PrivateImageExportOptions;
  samples: readonly Sample[];
  receipts: readonly Receipt[];
  secret: string | undefined;
  downloader: Pick<SecurePhotoDownloader, 'download'>;
  repositoryRoot: string;
  deadlineAtMs: number;
}) {
  const { selected, counters } = selectPrivateImageExportSources(
    params.samples,
    params.receipts,
    params.secret,
  );
  const report = {
    schemaVersion: 'commercial-private-image-export/v1',
    mode: params.options.apply ? 'PRIVATE_EXPORT' : 'PREVIEW',
    since: params.options.since,
    until: params.options.until,
    sampleCap: PRIVATE_IMAGE_SOURCE_CAP,
    receiptCap: PRIVATE_IMAGE_SOURCE_CAP,
    imageCap: params.options.limit,
    sampleRows: Math.min(params.samples.length, PRIVATE_IMAGE_SOURCE_CAP),
    receiptRows: Math.min(params.receipts.length, PRIVATE_IMAGE_SOURCE_CAP),
    sampleTruncated: params.samples.length > PRIVATE_IMAGE_SOURCE_CAP,
    receiptTruncated: params.receipts.length > PRIVATE_IMAGE_SOURCE_CAP,
    matchedAlbums: selected.length,
    capturedAlbums: 0,
    capturedImages: 0,
    capturedBytes: 0,
    counters,
    populationCoverageKnown: false,
    completeWithinMatchedSources: false,
    reviewManifestSha256: null as string | null,
    provenanceManifestSha256: null as string | null,
  };
  if (!params.options.apply) return report;
  if (!params.options.outputDir) throw new Error('Private output directory is required');
  await assertPrivateImageOutputSafe(params.options.outputDir, params.repositoryRoot);
  const out = resolve(params.options.outputDir);
  await mkdir(out, { mode: 0o700 });
  await writeFile(resolve(out, '.capture-in-progress'), 'Private image collection incomplete\n', {
    flag: 'wx',
    mode: 0o600,
  });
  const reviewRecords: Record<string, unknown>[] = [];
  const provenance: Record<string, unknown>[] = [];
  for (const { source, quality } of selected) {
    if (report.capturedImages + source.images.length > params.options.limit) {
      count(counters, 'complete_album_over_image_budget');
      continue;
    }
    if (Date.now() >= params.deadlineAtMs) {
      count(counters, 'collection_deadline', selected.length - report.capturedAlbums);
      break;
    }
    const photos: DownloadedPhoto[] = [];
    const files: string[] = [];
    try {
      for (const image of source.images) {
        if (Date.now() >= params.deadlineAtMs) throw new Error('Collection deadline');
        const downloaded = await params.downloader.download(image.downloadUrl!, {
          deadlineAtMs: params.deadlineAtMs,
        });
        photos.push(downloaded);
        if (
          report.capturedBytes + photos.reduce((sum, photo) => sum + photo.bytes.length, 0) >
          PRIVATE_IMAGE_BYTE_CAP
        )
          throw new Error('Private byte budget exceeded');
      }
      const images = photos.map((photo, index) => ({
        file: `${quality.sourceSnapshotSha256}-${index + 1}.${photo.format}`,
        sha256: sha256(photo.bytes),
        bytes: photo.bytes.length,
        position: index + 1,
      }));
      for (const [index, image] of images.entries()) {
        const destination = resolve(out, image.file);
        await writeFile(destination, photos[index]!.bytes, { flag: 'wx', mode: 0o600 });
        files.push(destination);
      }
      const caption = sanitizeCommercialCorpusText(source.source.caption);
      const excerptComplete =
        caption.length <= 2500 && !hasResidualCommercialContactCandidate(caption);
      const safeCaption = hasResidualCommercialContactCandidate(caption)
        ? '[контактные данные скрыты]'
        : caption.slice(0, 2500).replace(/[\uD800-\uDBFF]$/u, '');
      const imageEvidenceDigest = sha256(
        JSON.stringify([
          quality.sourceSnapshotSha256,
          images.map((image) => [image.position, image.sha256, image.bytes]),
          sha256(source.source.caption),
        ]),
      );
      // FLAG: Reviewer manifest contains no scores, decisions, technical outcomes or earlier labels.
      reviewRecords.push({
        schemaVersion: 'commercial-private-image-review-source/v1',
        sourceSnapshotSha256: quality.sourceSnapshotSha256,
        imageEvidenceDigest,
        caption: safeCaption,
        captionExcerptComplete: excerptComplete,
        images,
      });
      // Operator provenance stays separate from the blinded files supplied to human reviewers.
      provenance.push({
        sourceSnapshotSha256: quality.sourceSnapshotSha256,
        imageEvidenceDigest,
        pseudonymizationKeyId: quality.pseudonymizationKeyId,
        logicalMessageKey: quality.logicalMessageKey,
        authorGroupId: quality.authorGroupId,
        campaignGroupId: quality.campaignGroupId,
        campaignGroupIds: quality.campaignGroupIds,
        campaignGroupingComplete: quality.campaignGroupingComplete,
        messageCreatedAt: quality.messageCreatedAt,
        samplingProbability: quality.samplingProbability,
        randomEvaluationIncluded: quality.randomEvaluationIncluded,
        evaluationSamplingProbability: quality.evaluationSamplingProbability,
        samplingStratum: quality.samplingStratum,
        settingsProfileDigest: quality.settingsProfileDigest,
        detectorSourceSha256: quality.detectorSourceSha256,
        originalCaptionSha256: sha256(source.source.caption),
        sourceImageCount: source.images.length,
      });
      report.capturedAlbums += 1;
      report.capturedImages += images.length;
      report.capturedBytes += images.reduce((sum, image) => sum + image.bytes, 0);
    } catch {
      count(counters, 'album_capture_failed');
      for (const file of files) await unlink(file).catch(() => undefined);
    } finally {
      photos.forEach((photo) => photo.bytes.fill(0));
    }
  }
  report.completeWithinMatchedSources =
    !report.sampleTruncated &&
    !report.receiptTruncated &&
    report.capturedAlbums === selected.length &&
    Object.values(counters).every((value) => value === 0);
  const reviewManifest =
    reviewRecords.map((value) => JSON.stringify(value)).join('\n') +
    (reviewRecords.length ? '\n' : '');
  const provenanceManifest =
    JSON.stringify({
      schemaVersion: 'commercial-private-image-provenance/v1',
      capturedAt: new Date().toISOString(),
      report: { ...report },
      sources: provenance,
    }) + '\n';
  await writeFile(resolve(out, 'review-sources.jsonl'), reviewManifest, {
    flag: 'wx',
    mode: 0o600,
  });
  await writeFile(resolve(out, 'operator-provenance.json'), provenanceManifest, {
    flag: 'wx',
    mode: 0o600,
  });
  report.reviewManifestSha256 = sha256(reviewManifest);
  report.provenanceManifestSha256 = sha256(provenanceManifest);
  await unlink(resolve(out, '.capture-in-progress'));
  return report;
}

// FLAG: Resolve the loaded module's real workspace, never cwd or an unrelated root manifest.
// The runtime image retains API/contracts manifests but omits the root package.json.
export async function findPrivateImageRepositoryRoot(moduleDirectory = __dirname) {
  if (isAbsolute(moduleDirectory)) {
    try {
      const moduleReal = await realpath(moduleDirectory);
      if (!(await lstat(moduleReal)).isDirectory()) throw new Error('Module directory unavailable');
      for (const layout of [
        ['apps', 'api', 'dist', 'apps', 'api', 'src', 'scripts'],
        ['apps', 'api', 'src', 'scripts'],
      ]) {
        const root = resolve(moduleReal, ...layout.map(() => '..'));
        if (relative(root, moduleReal) !== layout.join(sep)) continue;
        try {
          const names = await Promise.all(
            ['apps/api/package.json', 'packages/contracts/package.json'].map(async (path) => {
              const manifest = resolve(root, path);
              if ((await realpath(manifest)) !== manifest) return null;
              return record(JSON.parse(await readFile(manifest, 'utf8'))).name;
            }),
          );
          if (names[0] === '@maxim/api' && names[1] === '@maxim/contracts') return root;
        } catch {
          /* Missing or invalid workspace markers cannot establish the real repository root. */
        }
      }
    } catch {
      /* Resolve failures remain generic; private filesystem details never enter output. */
    }
  }
  throw new Error('Repository root unavailable; refuse original-image output');
}

export async function runPrivateImageExport(argv: readonly string[]) {
  const options = readPrivateImageExportOptions(argv);
  loadEnv({ quiet: true });
  loadEnv({ path: resolve(__dirname, '../../../../.env'), override: false, quiet: true });
  const config = new ConfigService({ ...process.env });
  const prisma = createPrismaClient(undefined, resolveCommercialAuditPrismaPoolConfig());
  try {
    return await withCommercialAuditRunLock(async (lock) => {
      const loaded = await prisma.$transaction(
        async (tx) => {
          await tx.$executeRaw`SET TRANSACTION READ ONLY`;
          await tx.$executeRaw`SET LOCAL statement_timeout = '10s'`;
          await tx.$executeRaw`SET LOCAL lock_timeout = '250ms'`;
          const samples = await tx.$queryRaw<Sample[]>(
            Prisma.sql`SELECT source, quality_metadata AS "qualityMetadata" FROM commercial_review_samples WHERE observed_at >= ${new Date(options.since)} AND observed_at < ${new Date(options.until)} ORDER BY observed_at ASC, id ASC LIMIT ${PRIVATE_IMAGE_SOURCE_CAP + 1}`,
          );
          const scan = buildAuditScanWindowSql({
            loadSince: new Date(Date.parse(options.since) - SOURCE_PADDING_MS),
            until: new Date(options.until),
            pageSize: PRIVATE_IMAGE_SOURCE_CAP + 1,
          });
          const receipts = await tx.$queryRaw<Receipt[]>(
            Prisma.sql`WITH scan_page AS MATERIALIZED (${scan}) SELECT normalized_payload AS "normalizedPayload" FROM scan_page ORDER BY created_at ASC, id ASC`,
          );
          return { samples, receipts };
        },
        { timeout: 15000 },
      );
      lock.assertHeld();
      const result = await capturePrivateImageExport({
        options,
        ...loaded,
        secret: config.get<string>('MAX_WEBHOOK_SECRET_PATH'),
        downloader: new SecurePhotoDownloader(config),
        repositoryRoot: await findPrivateImageRepositoryRoot(),
        deadlineAtMs: Date.now() + RUN_DEADLINE_MS,
      });
      lock.assertHeld();
      return result;
    });
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module)
  void runPrivateImageExport(process.argv.slice(2))
    .then((report) => process.stdout.write(`${JSON.stringify(report)}\n`))
    .catch(() => {
      // FLAG: Private source URLs, IDs, photos, credentials and transport errors never enter output.
      process.stderr.write(
        'Private commercial image export failed; no moderation action was requested.\n',
      );
      process.exitCode = 1;
    });
