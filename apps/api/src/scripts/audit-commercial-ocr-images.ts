import { chatSettingsSchema } from '@maxim/contracts';
import { ConfigService } from '@nestjs/config';
import { config as loadEnv } from 'dotenv';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';

import { Prisma, createPrismaClient, type ChatSettings } from '../prisma/prisma-client';
import { SecurePhotoDownloader } from '../moderation/photo-duplicate/secure-photo-downloader';
import type { LogicalPhotoAlbum } from '../moderation/photo-duplicate/photo-attachment-extractor';
import { CommercialOcrPreprocessor } from '../moderation/commercial-ocr/commercial-ocr-preprocessor';
import { NativeTesseractOcrAdapter } from '../moderation/commercial-ocr/native-tesseract-ocr.adapter';
import { extractCommercialOcrExactMessageSource } from '../moderation/commercial-ocr/commercial-ocr-exact-source';
import { convertCommercialOcrNativePayload } from '../moderation/commercial-ocr/commercial-ocr-native-result.converter';
import { runCommercialOcrAlbumSchedule } from '../moderation/commercial-ocr/commercial-ocr-album-scheduler';
import {
  COMMERCIAL_OCR_DECISION_POLICY_VERSION,
  isCommercialOcrCyrillicOnlyDeleteDecision,
} from '../moderation/commercial-ocr/commercial-ocr-decision-policy';
import {
  COMMERCIAL_OCR_DETECTOR_SOURCE_SHA256,
  COMMERCIAL_OCR_RUNTIME_SOURCE_SHA256,
} from '../moderation/commercial-ocr/commercial-ocr-detector-source.generated';
import { COMMERCIAL_OCR_DEFAULT_VERSION } from '../moderation/commercial-ocr/commercial-ocr.queue';
import {
  NATIVE_OCR_SANDBOX_SOCKET_PATH_ENV,
  resolveNativeOcrSandboxSocketPath,
} from '../moderation/commercial-ocr/native-ocr-sandbox.protocol';
import {
  buildAuditScanWindowSql,
  resolveCommercialAuditPrismaPoolConfig,
} from './commercial-audit-scan-window';
import { withCommercialAuditRunLock } from './commercial-audit-run-lock.util';

export const COMMERCIAL_OCR_AUDIT_MAX_RECEIPTS = 500;
export const COMMERCIAL_OCR_AUDIT_MAX_IMAGES = 3;
const TOTAL_AUDIT_DEADLINE_MS = 90_000;
const ALBUM_DEADLINE_MS = 30_000;

type Receipt = { normalizedPayload: unknown; commercialSettings?: unknown };
type Counters = Record<string, number>;
const increment = (counters: Counters, key: string) => {
  counters[key] = (counters[key] ?? 0) + 1;
};

export function readCommercialOcrImageAuditOptions(argv: readonly string[]) {
  if (argv.length === 0) return { lookbackHours: 1 };
  const lookbackHours = Number(argv[1]);
  if (
    argv.length !== 2 ||
    argv[0] !== '--lookback-hours' ||
    !Number.isSafeInteger(lookbackHours) ||
    lookbackHours < 1 ||
    lookbackHours > 24
  ) {
    throw new Error('Usage: [--lookback-hours <1..24>]');
  }
  return { lookbackHours };
}

/** Private sources remain only in memory. Complete albums preserve every safe-context veto. */
export function selectCommercialOcrAuditAlbums(rows: readonly Receipt[]) {
  const counters: Counters = {};
  const albums: LogicalPhotoAlbum[] = [];
  const seenPhotos = new Set<string>();
  const settingsByChat = new Map<string, ChatSettings>();
  let selectedImages = 0;
  for (const row of rows.slice(0, COMMERCIAL_OCR_AUDIT_MAX_RECEIPTS)) {
    increment(counters, 'receipts_scanned');
    const update = asRecord(row.normalizedPayload);
    if (!update || !['message_created', 'message_edited'].includes(String(update.type))) {
      increment(counters, 'not_message');
      continue;
    }
    const exact = extractCommercialOcrExactMessageSource(update.raw);
    if (!exact || exact.authorKind !== 'user') {
      increment(counters, 'source_ineligible');
      continue;
    }
    if (row.commercialSettings !== undefined) {
      const commercialSettings = asRecord(row.commercialSettings);
      if (commercialSettings?.commercialAdsFilterEnabled !== true) {
        increment(counters, 'filter_not_enabled');
        continue;
      }
      const parsed = chatSettingsSchema.safeParse(commercialSettings);
      if (!parsed.success) {
        increment(counters, 'settings_invalid');
        continue;
      }
      settingsByChat.set(exact.source.chatId, parsed.data as unknown as ChatSettings);
    }
    const ids = exact.source.orderedPhotoIds;
    if (new Set(ids).size !== ids.length || ids.some((id) => seenPhotos.has(id))) {
      increment(counters, 'duplicate_photo');
      continue;
    }
    if (selectedImages + ids.length > COMMERCIAL_OCR_AUDIT_MAX_IMAGES) {
      increment(counters, 'album_over_image_budget');
      continue;
    }
    if (exact.images.some((image) => !image.downloadUrl)) {
      increment(counters, 'missing_download_source');
      continue;
    }
    albums.push({
      chatId: exact.source.chatId,
      messageId: exact.source.messageId,
      senderId: exact.source.senderId,
      createdAtMs: Date.parse(exact.source.sourceCreatedAt),
      caption: exact.source.caption,
      images: exact.images,
    });
    ids.forEach((id) => seenPhotos.add(id));
    selectedImages += ids.length;
    increment(counters, 'albums_selected');
    if (selectedImages === COMMERCIAL_OCR_AUDIT_MAX_IMAGES) break;
  }
  return { albums, counters, selectedImages, settingsByChat };
}

export async function auditCommercialOcrAlbums(params: {
  albums: readonly LogicalPhotoAlbum[];
  settings: ChatSettings;
  settingsByChat?: ReadonlyMap<string, ChatSettings>;
  downloader: Pick<SecurePhotoDownloader, 'download'>;
  preprocessor: Pick<CommercialOcrPreprocessor, 'prepare'>;
  native: Pick<NativeTesseractOcrAdapter, 'recognize' | 'isSandboxBoundaryVerified'>;
  deadlineAtMs: number;
}) {
  const counters: Counters = {};
  const passLatencies: number[] = [];
  let totalImages = 0;
  for (const album of params.albums) {
    if (totalImages + album.images.length > COMMERCIAL_OCR_AUDIT_MAX_IMAGES) break;
    totalImages += album.images.length;
    if (!params.native.isSandboxBoundaryVerified() || Date.now() >= params.deadlineAtMs) {
      increment(counters, 'sandbox_or_deadline_unavailable');
      break;
    }
    const deadlineAtMs = Math.min(params.deadlineAtMs, Date.now() + ALBUM_DEADLINE_MS);
    const scheduled = await runCommercialOcrAlbumSchedule<{ bytes: Buffer | null }, string>({
      caption: album.caption,
      settings: params.settingsByChat?.get(album.chatId) ?? params.settings,
      imageSources: album.images.map((image) => image.source),
      // FLAG: This read-only diagnostic recognizes all selected actual photos, including safe
      // captions. Final policy still receives the original caption and every image veto.
      requireCompletePrimaryScan: true,
      shouldResolveConfirmation: () => true,
      createImageContext: () => ({ bytes: null }),
      resolvePass: async ({ context, imageIndex, pass }) => {
        if (!params.native.isSandboxBoundaryVerified() || Date.now() >= deadlineAtMs) {
          return { kind: 'stop', result: 'sandbox_or_deadline_unavailable' };
        }
        if (!context.bytes) {
          try {
            context.bytes = (
              await params.downloader.download(album.images[imageIndex]!.downloadUrl!, {
                deadlineAtMs,
              })
            ).bytes;
            increment(counters, 'images_downloaded');
          } catch {
            return { kind: 'stop', result: 'download_failed' };
          }
        }
        let prepared: Buffer | null = null;
        const startedAt = performance.now();
        try {
          prepared = (await params.preprocessor.prepare(context.bytes, pass, { deadlineAtMs }))
            .bytes;
          const result = await params.native.recognize(prepared, {
            psm: pass === 'primary' ? 11 : 6,
            passLabel: 'readonly-audit',
            deadlineAtMs,
          });
          if (!result.ok) return { kind: 'stop', result: 'native_failed' };
          const converted = convertCommercialOcrNativePayload(result);
          if (converted.kind !== 'ready') return { kind: 'stop', result: 'invalid_native_output' };
          increment(counters, `${pass}_${result.status}`);
          if (pass === 'primary') increment(counters, 'images_recognized');
          return { kind: 'ready', value: converted.pass };
        } catch {
          return { kind: 'stop', result: 'preprocess_or_native_failed' };
        } finally {
          prepared?.fill(0);
          passLatencies.push(Math.round(performance.now() - startedAt));
        }
      },
      finishImage: (context) => {
        context.bytes?.fill(0);
        context.bytes = null;
      },
    });
    if (scheduled.kind === 'stopped') increment(counters, scheduled.result);
    else {
      increment(counters, 'albums_completed');
      increment(
        counters,
        isCommercialOcrCyrillicOnlyDeleteDecision(scheduled.decision)
          ? 'strict_delete_candidates'
          : 'strict_keep_decisions',
      );
    }
  }
  return {
    counters,
    latencyMs: {
      passes: passLatencies.length,
      average: passLatencies.length
        ? Math.round(passLatencies.reduce((sum, value) => sum + value, 0) / passLatencies.length)
        : null,
      maximum: passLatencies.length ? Math.max(...passLatencies) : null,
    },
  };
}

export async function runCommercialOcrImageAudit(argv: readonly string[]) {
  const options = readCommercialOcrImageAuditOptions(argv);
  loadEnv({ quiet: true });
  loadEnv({ path: resolve(__dirname, '../../../../.env'), override: false, quiet: true });
  const config = new ConfigService({ ...process.env });
  // FLAG: No local/native fallback. Only the existing isolated production UDS can receive bytes.
  if (!resolveNativeOcrSandboxSocketPath(config.get(NATIVE_OCR_SANDBOX_SOCKET_PATH_ENV))) {
    throw new Error('Verified native sandbox is required');
  }
  const prisma = createPrismaClient(undefined, resolveCommercialAuditPrismaPoolConfig());
  const native = new NativeTesseractOcrAdapter(config);
  const preprocessor = new CommercialOcrPreprocessor(config);
  const deadlineAtMs = Date.now() + TOTAL_AUDIT_DEADLINE_MS;
  try {
    return await withCommercialAuditRunLock(async (lock) => {
      const until = new Date();
      const since = new Date(until.getTime() - options.lookbackHours * 3_600_000);
      // FLAG: Fixed indexed window, read-only transaction, max 500 receipts; JSON/source work
      // stays outside the database. Never persist photos, text, URLs, IDs, jobs or decisions.
      const rows = await prisma.$transaction(
        async (tx) => {
          await tx.$executeRaw`SET TRANSACTION READ ONLY`;
          await tx.$executeRaw`SET LOCAL statement_timeout = '10s'`;
          const scan = buildAuditScanWindowSql({
            loadSince: since,
            until,
            pageSize: COMMERCIAL_OCR_AUDIT_MAX_RECEIPTS,
          });
          return tx.$queryRaw<Receipt[]>(Prisma.sql`with scan_page as materialized (${scan})
          select w.normalized_payload as "normalizedPayload",
            json_build_object('commercialAdsFilterEnabled', s.commercial_ads_filter_enabled,
              'commercialAdsSensitivity', s.commercial_ads_sensitivity,
              'commercialAdsWarnThreshold', s.commercial_ads_warn_threshold,
              'commercialAdsDeleteThreshold', s.commercial_ads_delete_threshold) as "commercialSettings"
            from scan_page w left join chat_settings s on s.chat_id = w.normalized_payload #>> '{message,chatId}'
            order by w.created_at asc, w.id asc`);
        },
        { timeout: 15_000 },
      );
      lock.assertHeld();
      const selection = selectCommercialOcrAuditAlbums(rows);
      native.onModuleInit();
      const startupDeadline = Math.min(deadlineAtMs, Date.now() + 15_000);
      while (!native.isSandboxBoundaryVerified() && Date.now() < startupDeadline) {
        await new Promise((resolveWait) => setTimeout(resolveWait, 25));
      }
      if (!native.isSandboxBoundaryVerified())
        throw new Error('Verified native sandbox is unavailable');
      const settings = chatSettingsSchema.parse({
        commercialAdsFilterEnabled: true,
      }) as unknown as ChatSettings;
      const result = await auditCommercialOcrAlbums({
        albums: selection.albums,
        settings,
        settingsByChat: selection.settingsByChat,
        downloader: new SecurePhotoDownloader(config),
        preprocessor,
        native,
        deadlineAtMs,
      });
      lock.assertHeld();
      const identity = native.getRuntimeStatus().behaviorIdentity;
      return {
        schemaVersion: 'commercial-ocr-readonly-audit/v1',
        mode: 'READ_ONLY',
        lookbackHours: options.lookbackHours,
        receiptsLoaded: rows.length,
        selectedImages: selection.selectedImages,
        counters: { ...selection.counters, ...result.counters },
        latencyMs: result.latencyMs,
        identity: {
          ocrVersion: COMMERCIAL_OCR_DEFAULT_VERSION,
          policyVersion: COMMERCIAL_OCR_DECISION_POLICY_VERSION,
          detectorSourceSha256: COMMERCIAL_OCR_DETECTOR_SOURCE_SHA256,
          policyRuntimeSourceSha256: COMMERCIAL_OCR_RUNTIME_SOURCE_SHA256,
          nativeFingerprintSha256: identity.fingerprintSha256,
          runtimeFingerprintSha256: identity.runtimeFingerprintSha256,
          nativeComplete: identity.complete,
          nativeVerified: identity.verified,
        },
      };
    });
  } finally {
    preprocessor.onModuleDestroy();
    await native.onModuleDestroy();
    await prisma.$disconnect();
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

if (require.main === module) {
  void runCommercialOcrImageAudit(process.argv.slice(2))
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch(() => {
      // FLAG: Private source/transport error details must never enter audit output.
      process.stderr.write(
        'Commercial OCR read-only audit failed; no moderation action was requested.\n',
      );
      process.exitCode = 1;
    });
}
