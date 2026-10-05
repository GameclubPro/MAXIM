import {
  commercialReviewEvidenceMetadataSchema,
  type CommercialReviewEvidenceMetadata,
} from '@maxim/contracts/safety-desk';
import { ConfigService } from '@nestjs/config';
import { config as loadEnv } from 'dotenv';
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';
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
export const PRIVATE_IMAGE_SCAN_PAGE_CAP = 500;
export const PRIVATE_IMAGE_RAW_SCAN_CAP = 5000;
const RUN_DEADLINE_MS = 120_000;
const SOURCE_PADDING_MS = 10 * 60_000;
const CHECKPOINT_BYTE_CAP = 8 * 1024 * 1024;
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
  checkpointPath?: string | null;
  resume?: boolean;
  nextFrame?: boolean;
};
export type PrivateImagePageCursor = { createdAt: Date; id: string };
export type PrivateImagePageOptions = {
  since: string;
  until: string;
  cursor?: PrivateImagePageCursor;
  pageSize: number;
};
export type PrivateImageSamplePageRow = Sample & { id: string; observedAt: Date };
export type PrivateImageReceiptPageRow = Receipt & { id: string; createdAt: Date };
const count = (counts: Counter, name: string, amount = 1) => {
  counts[name] = (counts[name] ?? 0) + amount;
};
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

function validatePrivateImagePage(options: PrivateImagePageOptions, paddingMs = 0) {
  const since = Date.parse(options.since) - paddingMs;
  const until = Date.parse(options.until);
  if (
    !Number.isFinite(since) ||
    !Number.isFinite(until) ||
    since >= until ||
    !Number.isInteger(options.pageSize) ||
    options.pageSize < 1 ||
    options.pageSize > PRIVATE_IMAGE_SCAN_PAGE_CAP ||
    (options.cursor &&
      (!options.cursor.id ||
        !Number.isFinite(options.cursor.createdAt.getTime()) ||
        options.cursor.createdAt.getTime() < since ||
        options.cursor.createdAt.getTime() >= until))
  )
    throw new Error('Invalid private image scan window or cursor');
}

// FLAG: Raw indexed pages precede source/JSON filtering; empty OCR pages still advance.
export function buildPrivateImageSamplePageSql(options: PrivateImagePageOptions): Prisma.Sql {
  validatePrivateImagePage(options);
  const cursor = options.cursor
    ? Prisma.sql`AND (observed_at, id) > (${options.cursor.createdAt}, ${options.cursor.id})`
    : Prisma.sql``;
  return Prisma.sql`SELECT id, observed_at AS "observedAt", source,
    quality_metadata AS "qualityMetadata" FROM commercial_review_samples
    WHERE observed_at >= ${new Date(options.since)} AND observed_at < ${new Date(options.until)}
    ${cursor} ORDER BY observed_at ASC, id ASC LIMIT ${options.pageSize}`;
}

export function buildPrivateImageReceiptPageSql(options: PrivateImagePageOptions): Prisma.Sql {
  validatePrivateImagePage(options, SOURCE_PADDING_MS);
  const scan = buildAuditScanWindowSql({
    loadSince: new Date(Date.parse(options.since) - SOURCE_PADDING_MS),
    until: new Date(options.until),
    pageSize: options.pageSize,
    ...(options.cursor
      ? { cursor: { createdAt: options.cursor.createdAt, webhookEventId: options.cursor.id } }
      : {}),
  });
  return Prisma.sql`WITH scan_page AS MATERIALIZED (${scan})
    SELECT id, created_at AS "createdAt", normalized_payload AS "normalizedPayload"
    FROM scan_page WHERE created_at < ${new Date(options.until)} ORDER BY created_at ASC, id ASC`;
}

const privateCursorSchema = z
  .object({ at: z.iso.datetime(), id: z.string().min(1).max(256) })
  .strict();
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const counterSchema = z.partialRecord(
  z.enum([
    'source_provenance_unavailable',
    'pseudonym_key_mismatch',
    'duplicate_sample_revision',
    'receipt_source_ineligible',
    'matched_source_unavailable',
    'unmatched_sample_revisions',
    'complete_album_over_image_budget',
    'collection_deadline',
    'album_capture_failed',
    'source_receipt_revalidation_failed',
  ]),
  z.number().int().nonnegative(),
);
const checkpointStateSchema = z
  .object({
    schemaVersion: z.literal('commercial-private-image-checkpoint/v1'),
    since: z.iso.datetime(),
    until: z.iso.datetime(),
    pseudonymizationKeyId: digestSchema,
    sourceIdentitySha256: digestSchema,
    repositoryRoot: z.string().min(1),
    imageLimit: z.number().int().min(1).max(PRIVATE_IMAGE_SOURCE_CAP),
    frame: z.number().int().positive(),
    phase: z.enum(['SAMPLES', 'RECEIPTS', 'READY', 'EXPORTING', 'EXPORTED']),
    sampleCursor: privateCursorSchema.nullable(),
    receiptCursor: privateCursorSchema.nullable(),
    sampleWindowExhausted: z.boolean(),
    receiptWindowExhausted: z.boolean(),
    rawSampleRows: z.number().int().nonnegative(),
    rawReceiptRows: z.number().int().nonnegative(),
    samples: z
      .array(
        z
          .object({
            source: z.literal('OCR'),
            qualityMetadata: commercialReviewEvidenceMetadataSchema,
          })
          .strict(),
      )
      .max(PRIVATE_IMAGE_SOURCE_CAP),
    matches: z
      .array(z.object({ snapshot: digestSchema, receiptId: z.string().min(1).max(256) }).strict())
      .max(PRIVATE_IMAGE_SOURCE_CAP),
    capturedSnapshots: z.array(digestSchema).max(PRIVATE_IMAGE_SOURCE_CAP),
    unavailableSnapshots: z.array(digestSchema).max(PRIVATE_IMAGE_SOURCE_CAP),
    oversizedSnapshots: z.array(digestSchema).max(PRIVATE_IMAGE_SOURCE_CAP),
    counters: counterSchema,
    outputDir: z.string().nullable(),
    captured: z
      .object({
        albums: z.number().int().nonnegative().max(PRIVATE_IMAGE_SOURCE_CAP),
        images: z.number().int().nonnegative().max(PRIVATE_IMAGE_SOURCE_CAP),
        bytes: z.number().int().nonnegative().max(PRIVATE_IMAGE_BYTE_CAP),
        reviewManifestSha256: digestSchema.nullable(),
        provenanceManifestSha256: digestSchema.nullable(),
        complete: z.boolean(),
      })
      .strict(),
  })
  .strict();
export type PrivateImageCheckpointState = z.infer<typeof checkpointStateSchema>;
const emptyCapture = () => ({
  albums: 0,
  images: 0,
  bytes: 0,
  reviewManifestSha256: null,
  provenanceManifestSha256: null,
  complete: false,
});
function privateKeyIdentity(secret: string | undefined) {
  return buildCommercialQualitySample({
    secret,
    chatId: 'identity-check',
    userId: 'identity-check',
    messageId: 'identity-check',
    text: '',
    messageCreatedAt: '2000-01-01T00:00:00.000Z',
    source: 'OCR',
    hasDetection: true,
  })?.pseudonymizationKeyId;
}

export async function assertPrivateImageCheckpointSafe(
  path: string,
  repositoryRoot: string,
  existing: boolean,
) {
  await assertPrivateImageParentSafe(path, repositoryRoot);
  if (!existing) return assertPrivateImageOutputSafe(path, repositoryRoot);
  const info = await lstat(path);
  if (
    (await realpath(path)) !== resolve(path) ||
    !info.isFile() ||
    info.isSymbolicLink() ||
    (info.mode & 0o077) !== 0 ||
    info.size > CHECKPOINT_BYTE_CAP ||
    (typeof process.getuid === 'function' && info.uid !== process.getuid())
  )
    throw new Error('Checkpoint must be a bounded owner-private real file outside repository');
}

function checkpointMac(state: PrivateImageCheckpointState, secret: string) {
  return createHmac('sha256', secret)
    .update('commercial-private-image-checkpoint/v1\0')
    .update(JSON.stringify(checkpointStateSchema.parse(state)))
    .digest('hex');
}

async function readPrivateCheckpoint(path: string, repositoryRoot: string, secret: string) {
  await assertPrivateImageCheckpointSafe(path, repositoryRoot, true);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (
      !info.isFile() ||
      info.size > CHECKPOINT_BYTE_CAP ||
      (info.mode & 0o077) !== 0 ||
      (typeof process.getuid === 'function' && info.uid !== process.getuid())
    )
      throw new Error('Invalid checkpoint');
    const bytes = Buffer.alloc(CHECKPOINT_BYTE_CAP + 1);
    const read = await file.read(bytes, 0, bytes.length, 0);
    if (read.bytesRead > CHECKPOINT_BYTE_CAP) throw new Error('Checkpoint byte cap');
    const envelope = z
      .object({ state: checkpointStateSchema, hmacSha256: digestSchema })
      .strict()
      .parse(JSON.parse(bytes.subarray(0, read.bytesRead).toString('utf8')));
    const expected = Buffer.from(checkpointMac(envelope.state, secret), 'hex');
    if (!timingSafeEqual(expected, Buffer.from(envelope.hmacSha256, 'hex')))
      throw new Error('Checkpoint integrity unavailable');
    return envelope.state;
  } finally {
    await file.close();
  }
}

async function writePrivateCheckpoint(
  path: string,
  state: PrivateImageCheckpointState,
  secret: string,
  existing: boolean,
) {
  await assertPrivateImageCheckpointSafe(path, state.repositoryRoot, existing);
  const content = JSON.stringify({ state, hmacSha256: checkpointMac(state, secret) }) + '\n';
  if (Buffer.byteLength(content) > CHECKPOINT_BYTE_CAP) throw new Error('Checkpoint byte cap');
  const destination = existing
    ? resolve(dirname(path), `.private-image-checkpoint-${randomUUID()}`)
    : path;
  const file = await open(
    destination,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await file.writeFile(content);
    await file.sync();
  } finally {
    await file.close();
  }
  if (existing) {
    try {
      await assertPrivateImageCheckpointSafe(path, state.repositoryRoot, true);
      await rename(destination, path);
    } catch (error) {
      await unlink(destination).catch(() => undefined);
      throw error;
    }
  }
}

function checkpointAggregate(
  state: PrivateImageCheckpointState,
  persisted: boolean,
  scannedThisRun: number,
) {
  const ready = ['READY', 'EXPORTING', 'EXPORTED'].includes(state.phase);
  return {
    schemaVersion: 'commercial-private-image-export/v1',
    mode: state.phase === 'EXPORTED' ? 'PRIVATE_EXPORT' : 'PREVIEW',
    since: state.since,
    until: state.until,
    frame: state.frame,
    sampleCap: PRIVATE_IMAGE_SOURCE_CAP,
    receiptCap: PRIVATE_IMAGE_SOURCE_CAP,
    rawPageCap: PRIVATE_IMAGE_SCAN_PAGE_CAP,
    rawScanRowCap: PRIVATE_IMAGE_RAW_SCAN_CAP,
    imageCap: state.imageLimit,
    rawRowsScannedThisRun: scannedThisRun,
    rawSampleRowsScanned: state.rawSampleRows,
    rawReceiptRowsScanned: state.rawReceiptRows,
    sampleRows: state.samples.length,
    receiptRows: state.matches.length,
    sampleTruncated: !state.sampleWindowExhausted,
    receiptTruncated: !ready,
    sampleWindowExhausted: state.sampleWindowExhausted,
    receiptWindowExhausted: state.receiptWindowExhausted,
    sourceLookupComplete: ready,
    checkpointAvailable: persisted,
    resumeRequired: !ready,
    resumeAvailable: persisted && !ready,
    residualMatchedAlbums: state.matches.filter(
      (match) =>
        !state.capturedSnapshots.includes(match.snapshot) &&
        !state.oversizedSnapshots.includes(match.snapshot),
    ).length,
    terminalAlbumBudgetOmissions: state.oversizedSnapshots.length,
    nextFrameAvailable:
      state.phase === 'EXPORTED' &&
      (!state.sampleWindowExhausted ||
        state.matches.some(
          (match) =>
            !state.capturedSnapshots.includes(match.snapshot) &&
            !state.oversizedSnapshots.includes(match.snapshot),
        )),
    matchedAlbums: state.matches.length,
    capturedAlbums: state.captured.albums,
    capturedImages: state.captured.images,
    capturedBytes: state.captured.bytes,
    counters: {
      ...state.counters,
      matched_source_unavailable: state.unavailableSnapshots.filter(
        (snapshot) => !state.matches.some((match) => match.snapshot === snapshot),
      ).length,
      unmatched_sample_revisions: state.samples.length - state.matches.length,
    },
    populationCoverageKnown: false,
    receiptScope: 'PROCESSED_ONLY',
    lateOrUnprocessedSourcesEvaluated: false,
    completeWithinMatchedSources: state.captured.complete,
    reviewManifestSha256: state.captured.reviewManifestSha256,
    provenanceManifestSha256: state.captured.provenanceManifestSha256,
  };
}

// FLAG: Checkpoints contain bounded PK/provenance references only. The advisory run lock
// owns every page/write/download; interrupted exports remain blocked rather than redownloaded.
export async function runPrivateImageCheckpointExport(params: {
  options: PrivateImageExportOptions;
  secret: string | undefined;
  repositoryRoot: string;
  sourceIdentitySha256: string;
  loadSamplePage(options: PrivateImagePageOptions): Promise<PrivateImageSamplePageRow[]>;
  loadReceiptPage(options: PrivateImagePageOptions): Promise<PrivateImageReceiptPageRow[]>;
  loadMatchedReceipts(ids: readonly string[]): Promise<PrivateImageReceiptPageRow[]>;
  downloader: Pick<SecurePhotoDownloader, 'download'>;
  assertHeld?: () => void;
  now?: () => number;
}) {
  const now = params.now ?? Date.now;
  const deadlineAtMs = now() + RUN_DEADLINE_MS;
  const assertHeld = params.assertHeld ?? (() => undefined);
  const options = params.options;
  const repositoryRoot = await realpath(params.repositoryRoot);
  const keyIdentity = privateKeyIdentity(params.secret);
  if (
    !keyIdentity ||
    !params.secret ||
    !digestSchema.safeParse(params.sourceIdentitySha256).success ||
    Date.parse(options.until) > now()
  )
    throw new Error('Frozen source identity unavailable');
  const secret = params.secret;
  const checkpoint = options.checkpointPath;
  if ((options.resume && !checkpoint) || (options.apply && (!checkpoint || !options.resume)))
    throw new Error('Private checkpoint and explicit resume required');
  assertHeld();
  let state: PrivateImageCheckpointState = options.resume
    ? await readPrivateCheckpoint(checkpoint!, repositoryRoot, secret)
    : {
        schemaVersion: 'commercial-private-image-checkpoint/v1',
        since: options.since,
        until: options.until,
        pseudonymizationKeyId: keyIdentity,
        sourceIdentitySha256: params.sourceIdentitySha256,
        repositoryRoot,
        imageLimit: options.limit,
        frame: 1,
        phase: 'SAMPLES',
        sampleCursor: null,
        receiptCursor: null,
        sampleWindowExhausted: false,
        receiptWindowExhausted: false,
        rawSampleRows: 0,
        rawReceiptRows: 0,
        samples: [],
        matches: [],
        capturedSnapshots: [],
        unavailableSnapshots: [],
        oversizedSnapshots: [],
        counters: {},
        outputDir: null,
        captured: emptyCapture(),
      };
  const sampleSince = Date.parse(options.since);
  const until = Date.parse(options.until);
  const validCursor = (cursor: PrivateImageCheckpointState['sampleCursor'], since: number) =>
    !cursor || (Date.parse(cursor.at) >= since && Date.parse(cursor.at) < until);
  if (
    state.since !== options.since ||
    state.until !== options.until ||
    state.pseudonymizationKeyId !== keyIdentity ||
    state.sourceIdentitySha256 !== params.sourceIdentitySha256 ||
    state.repositoryRoot !== repositoryRoot ||
    state.imageLimit !== options.limit ||
    !validCursor(state.sampleCursor, sampleSince) ||
    !validCursor(state.receiptCursor, sampleSince - SOURCE_PADDING_MS) ||
    new Set(state.samples.map((row) => row.qualityMetadata.sourceSnapshotSha256)).size !==
      state.samples.length ||
    new Set(state.matches.map((row) => row.snapshot)).size !== state.matches.length ||
    new Set(state.capturedSnapshots).size !== state.capturedSnapshots.length ||
    state.capturedSnapshots.some(
      (snapshot) => !state.matches.some((match) => match.snapshot === snapshot),
    ) ||
    state.matches.some(
      (match) =>
        !state.samples.some((row) => row.qualityMetadata.sourceSnapshotSha256 === match.snapshot),
    ) ||
    state.samples.some((row) => row.qualityMetadata.pseudonymizationKeyId !== keyIdentity)
  )
    throw new Error('Checkpoint window, key, source, layout or cursor mismatch');
  if (state.phase === 'EXPORTING')
    throw new Error('Interrupted private export requires operator recovery');
  if (options.nextFrame) {
    const residual = state.matches.filter(
      (match) =>
        !state.capturedSnapshots.includes(match.snapshot) &&
        !state.oversizedSnapshots.includes(match.snapshot),
    );
    if (
      !options.resume ||
      options.apply ||
      state.phase !== 'EXPORTED' ||
      (state.sampleWindowExhausted && !residual.length)
    )
      throw new Error('Next frame requires an exported resumable sample window');
    state = {
      ...state,
      frame: state.frame + 1,
      phase: residual.length ? 'READY' : 'SAMPLES',
      receiptCursor: residual.length ? state.receiptCursor : null,
      receiptWindowExhausted: residual.length ? state.receiptWindowExhausted : false,
      samples: residual.length
        ? state.samples.filter((sample) =>
            residual.some(
              (match) => match.snapshot === sample.qualityMetadata.sourceSnapshotSha256,
            ),
          )
        : [],
      matches: residual,
      capturedSnapshots: [],
      unavailableSnapshots: [],
      oversizedSnapshots: [],
      counters: {},
      outputDir: null,
      captured: emptyCapture(),
    };
  } else if (state.phase === 'EXPORTED') {
    if (options.apply && resolve(options.outputDir ?? '') !== state.outputDir)
      throw new Error('Completed export output mismatch');
    return checkpointAggregate(state, Boolean(checkpoint), 0);
  }
  if (checkpoint && !options.resume) await writePrivateCheckpoint(checkpoint, state, secret, false);
  const save = async () => {
    assertHeld();
    if (checkpoint) await writePrivateCheckpoint(checkpoint, state, secret, true);
  };
  if (options.nextFrame) await save();
  let scanned = 0;
  const cursor = (value: PrivateImageCheckpointState['sampleCursor']) =>
    value ? { createdAt: new Date(value.at), id: value.id } : undefined;
  const validateRows = (
    rows: Array<{ id: string; at: Date }>,
    previous: PrivateImageCheckpointState['sampleCursor'],
    since: number,
    pageSize: number,
  ) => {
    if (rows.length > pageSize) throw new Error('Raw scan page cap exceeded');
    let last = previous;
    for (const row of rows) {
      const at = row.at.getTime();
      if (
        !row.id ||
        row.id.length > 256 ||
        !Number.isFinite(at) ||
        at < since ||
        at >= until ||
        (last && (at < Date.parse(last.at) || (at === Date.parse(last.at) && row.id <= last.id)))
      )
        throw new Error('Raw scan returned an invalid window or cursor');
      last = { at: row.at.toISOString(), id: row.id };
    }
  };
  while (
    ['SAMPLES', 'RECEIPTS'].includes(state.phase) &&
    scanned < PRIVATE_IMAGE_RAW_SCAN_CAP &&
    now() < deadlineAtMs
  ) {
    assertHeld();
    const pageSize = Math.min(PRIVATE_IMAGE_SCAN_PAGE_CAP, PRIVATE_IMAGE_RAW_SCAN_CAP - scanned);
    if (state.phase === 'SAMPLES') {
      const rows = await params.loadSamplePage({
        since: options.since,
        until: options.until,
        pageSize,
        ...(state.sampleCursor ? { cursor: cursor(state.sampleCursor) } : {}),
      });
      validateRows(
        rows.map((row) => ({ id: row.id, at: row.observedAt })),
        state.sampleCursor,
        sampleSince,
        pageSize,
      );
      state.rawSampleRows += rows.length;
      scanned += rows.length;
      for (const row of rows) {
        state.sampleCursor = { at: row.observedAt.toISOString(), id: row.id };
        if (row.source === 'OCR') {
          const selected = selectPrivateImageExportSources([row], [], secret);
          for (const [name, amount] of Object.entries(selected.counters)) {
            if (name !== 'unmatched_sample_revisions')
              count(state.counters as Counter, name, amount);
          }
          const quality = commercialReviewEvidenceMetadataSchema.safeParse(row.qualityMetadata);
          if (
            quality.success &&
            quality.data.sourceSnapshotSha256 &&
            quality.data.pseudonymizationKeyId === keyIdentity
          ) {
            if (
              state.samples.some(
                (sample) =>
                  sample.qualityMetadata.sourceSnapshotSha256 === quality.data.sourceSnapshotSha256,
              )
            )
              count(state.counters as Counter, 'duplicate_sample_revision');
            else
              state.samples.push({
                source: 'OCR',
                qualityMetadata: {
                  ...quality.data,
                  hasDetection: null,
                  decisionOutcome: null,
                  deleteEligible: null,
                  executionOutcome: 'UNKNOWN',
                  analysisOutcome: 'UNKNOWN',
                  candidateDecision: null,
                },
              });
          }
        }
        if (state.samples.length === PRIVATE_IMAGE_SOURCE_CAP) {
          state.phase = 'RECEIPTS';
          break;
        }
      }
      if (state.phase === 'SAMPLES' && rows.length < pageSize) {
        state.sampleWindowExhausted = true;
        state.phase = state.samples.length ? 'RECEIPTS' : 'READY';
      }
    } else {
      const frozenByHash = new Map(
        state.samples.map((sample) => [
          sample.qualityMetadata.sourceSnapshotSha256!,
          sample.qualityMetadata,
        ]),
      );
      const rows = await params.loadReceiptPage({
        since: options.since,
        until: options.until,
        pageSize,
        ...(state.receiptCursor ? { cursor: cursor(state.receiptCursor) } : {}),
      });
      validateRows(
        rows.map((row) => ({ id: row.id, at: row.createdAt })),
        state.receiptCursor,
        sampleSince - SOURCE_PADDING_MS,
        pageSize,
      );
      state.rawReceiptRows += rows.length;
      scanned += rows.length;
      for (const row of rows) {
        state.receiptCursor = { at: row.createdAt.toISOString(), id: row.id };
        const matched = resolvePrivateImageReceipt(
          frozenByHash,
          row,
          secret,
          (reason, snapshot) => {
            if (
              reason === 'matched_source_unavailable' &&
              snapshot &&
              !state.unavailableSnapshots.includes(snapshot)
            )
              state.unavailableSnapshots.push(snapshot);
          },
        );
        if (
          matched &&
          !state.matches.some((match) => match.snapshot === matched.quality.sourceSnapshotSha256)
        )
          state.matches.push({
            snapshot: matched.quality.sourceSnapshotSha256!,
            receiptId: row.id,
          });
        if (state.matches.length === state.samples.length) {
          state.phase = 'READY';
          break;
        }
      }
      if (state.phase === 'RECEIPTS' && rows.length < pageSize) {
        state.receiptWindowExhausted = true;
        state.phase = 'READY';
      }
    }
    await save();
  }
  if (!options.apply || state.phase !== 'READY' || now() >= deadlineAtMs)
    return checkpointAggregate(state, Boolean(checkpoint), scanned);
  if (!options.outputDir) throw new Error('Private output directory is required');
  await assertPrivateImageOutputSafe(options.outputDir, repositoryRoot);
  assertHeld();
  const receipts = await params.loadMatchedReceipts(state.matches.map((match) => match.receiptId));
  if (
    receipts.length > PRIVATE_IMAGE_SOURCE_CAP ||
    new Set(receipts.map((row) => row.id)).size !== receipts.length
  )
    throw new Error('Matched receipt cap or uniqueness invalid');
  const wanted = new Map(state.matches.map((match) => [match.receiptId, match.snapshot]));
  const validReceipts = receipts.filter((row) => {
    const snapshot = wanted.get(row.id);
    if (
      !snapshot ||
      row.createdAt.getTime() < sampleSince - SOURCE_PADDING_MS ||
      row.createdAt.getTime() >= until
    )
      return false;
    const frozen = state.samples.filter(
      (sample) => sample.qualityMetadata.sourceSnapshotSha256 === snapshot,
    );
    return selectPrivateImageExportSources(frozen, [row], secret).selected.length === 1;
  });
  count(
    state.counters as Counter,
    'source_receipt_revalidation_failed',
    state.matches.length - validReceipts.length,
  );
  state.matches = state.matches.filter((match) =>
    validReceipts.some((row) => row.id === match.receiptId),
  );
  const frozenByHash = new Map(
    state.samples.map((sample) => [
      sample.qualityMetadata.sourceSnapshotSha256!,
      sample.qualityMetadata,
    ]),
  );
  state.oversizedSnapshots = validReceipts.flatMap((row) => {
    const source = resolvePrivateImageReceipt(frozenByHash, row, secret);
    return source && source.source.images.length > state.imageLimit
      ? [source.quality.sourceSnapshotSha256!]
      : [];
  });
  if (now() >= deadlineAtMs) {
    await save();
    return checkpointAggregate(state, Boolean(checkpoint), scanned);
  }
  state.outputDir = resolve(options.outputDir);
  state.phase = 'EXPORTING';
  await save();
  const captured = await capturePrivateImageExport({
    options,
    samples: state.samples,
    receipts: validReceipts,
    secret,
    downloader: params.downloader,
    repositoryRoot,
    deadlineAtMs,
    onAlbumCaptured: (snapshot) => state.capturedSnapshots.push(snapshot),
    assertHeld,
  });
  state.captured = {
    albums: captured.capturedAlbums,
    images: captured.capturedImages,
    bytes: captured.capturedBytes,
    reviewManifestSha256: captured.reviewManifestSha256,
    provenanceManifestSha256: captured.provenanceManifestSha256,
    complete:
      captured.completeWithinMatchedSources && validReceipts.length === state.samples.length,
  };
  for (const [name, amount] of Object.entries(captured.counters)) {
    if (name !== 'unmatched_sample_revisions') count(state.counters as Counter, name, amount);
  }
  state.phase = 'EXPORTED';
  await save();
  return checkpointAggregate(state, Boolean(checkpoint), scanned);
}

export function readPrivateImageExportOptions(argv: readonly string[]): PrivateImageExportOptions {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      since: { type: 'string' },
      until: { type: 'string' },
      limit: { type: 'string' },
      'output-dir': { type: 'string' },
      checkpoint: { type: 'string' },
      resume: { type: 'boolean', default: false },
      'next-frame': { type: 'boolean', default: false },
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
    (values.checkpoint && !isAbsolute(values.checkpoint)) ||
    (values.resume && !values.checkpoint) ||
    (values['next-frame'] && (!values.resume || values.apply)) ||
    (values.apply && (!values['output-dir'] || !values.checkpoint || !values.resume))
  )
    throw new Error(
      'Usage: --since <UTC ISO> --until <UTC ISO; frozen window <=24h> [--limit <1..500>] [--checkpoint <private absolute file> [--resume [--next-frame]]] [--output-dir <new private directory outside repository> --resume --apply]',
    );
  return {
    since: new Date(values.since).toISOString(),
    until: new Date(values.until).toISOString(),
    limit,
    outputDir: values['output-dir'] ?? null,
    apply: values.apply,
    checkpointPath: values.checkpoint ?? null,
    resume: values.resume,
    nextFrame: values['next-frame'],
  };
}

function resolvePrivateImageReceipt(
  wanted: ReadonlyMap<string, CommercialReviewEvidenceMetadata>,
  row: Receipt,
  secret: string | undefined,
  reason?: (name: string, snapshot?: string) => void,
): Selected | null {
  const payload = record(row.normalizedPayload);
  if (!['message_created', 'message_edited'].includes(String(payload.type))) return null;
  const exact = extractCommercialOcrExactMessageSource(payload.raw);
  if (!exact || exact.authorKind !== 'user') {
    reason?.('receipt_source_ineligible');
    return null;
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
  if (!quality || !identity) return null;
  if (
    !exact.images.length ||
    new Set(exact.source.orderedPhotoIds).size !== exact.images.length ||
    exact.images.some((image) => !image.downloadUrl)
  ) {
    reason?.('matched_source_unavailable', identity.sourceSnapshotSha256);
    return null;
  }
  return { quality, source: exact };
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
    const matched = resolvePrivateImageReceipt(wanted, row, secret, (name) =>
      count(counters, name),
    );
    if (!matched || seen.has(matched.quality.sourceSnapshotSha256!)) continue;
    selected.push(matched);
    seen.add(matched.quality.sourceSnapshotSha256!);
  }
  counters.unmatched_sample_revisions = wanted.size - seen.size;
  return { selected, counters };
}

async function assertPrivateImageParentSafe(outputDir: string, repositoryRoot: string) {
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
}

export async function assertPrivateImageOutputSafe(outputDir: string, repositoryRoot: string) {
  await assertPrivateImageParentSafe(outputDir, repositoryRoot);
  const output = resolve(outputDir);
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
  onAlbumCaptured?: (snapshot: string) => void;
  assertHeld?: () => void;
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
  params.assertHeld?.();
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
    params.assertHeld?.();
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
        params.assertHeld?.();
        if (Date.now() >= params.deadlineAtMs) throw new Error('Collection deadline');
        const downloaded = await params.downloader.download(image.downloadUrl!, {
          deadlineAtMs: params.deadlineAtMs,
        });
        photos.push(downloaded);
        params.assertHeld?.();
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
        params.assertHeld?.();
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
      params.onAlbumCaptured?.(quality.sourceSnapshotSha256!);
    } catch {
      count(counters, 'album_capture_failed');
      for (const file of files) await unlink(file).catch(() => undefined);
      params.assertHeld?.();
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
  params.assertHeld?.();
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
      const repositoryRoot = await findPrivateImageRepositoryRoot();
      const sourceIdentitySha256 = sha256(
        JSON.stringify([
          repositoryRoot,
          await realpath(__dirname),
          sha256(await readFile(__filename)),
          sha256(process.env.DATABASE_URL ?? ''),
        ]),
      );
      const loadRows = <T>(query: Prisma.Sql) =>
        prisma.$transaction(
          async (tx) => {
            await tx.$executeRaw`SET TRANSACTION READ ONLY`;
            await tx.$executeRaw`SET LOCAL statement_timeout = '10s'`;
            await tx.$executeRaw`SET LOCAL lock_timeout = '250ms'`;
            return tx.$queryRaw<T[]>(query);
          },
          { timeout: 15000 },
        );
      return runPrivateImageCheckpointExport({
        options,
        repositoryRoot,
        sourceIdentitySha256,
        secret: config.get<string>('MAX_WEBHOOK_SECRET_PATH'),
        downloader: new SecurePhotoDownloader(config),
        assertHeld: () => lock.assertHeld(),
        loadSamplePage: (page) =>
          loadRows<PrivateImageSamplePageRow>(buildPrivateImageSamplePageSql(page)),
        loadReceiptPage: (page) =>
          loadRows<PrivateImageReceiptPageRow>(buildPrivateImageReceiptPageSql(page)),
        loadMatchedReceipts: (ids) =>
          ids.length
            ? loadRows<PrivateImageReceiptPageRow>(Prisma.sql`
          SELECT id, created_at AS "createdAt", normalized_payload AS "normalizedPayload"
          FROM webhook_events WHERE id IN (${Prisma.join(ids)}) AND status = 'PROCESSED'
            AND created_at >= ${new Date(Date.parse(options.since) - SOURCE_PADDING_MS)}
            AND created_at < ${new Date(options.until)}`)
            : Promise.resolve([]),
      });
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
