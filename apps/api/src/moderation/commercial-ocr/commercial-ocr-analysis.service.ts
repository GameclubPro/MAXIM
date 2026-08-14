import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';

import { raceWithTimeout } from '../../common/promise-timeout.util';
import type { ChatSettings } from '../../prisma/prisma-client';
import { CommercialAdDetector } from '../commercial/commercial-ad.detector';
import type { LogicalPhotoAlbum } from '../photo-duplicate/photo-attachment-extractor';
import {
  PhotoDownloadHttpError,
  SecurePhotoDownloader,
} from '../photo-duplicate/secure-photo-downloader';
import {
  CommercialOcrCacheStore,
  type CommercialOcrCacheIdentity,
  type CommercialOcrCacheValue,
} from './commercial-ocr-cache.store';
import {
  type CommercialOcrDecision,
  type CommercialOcrDetector,
  type CommercialOcrPass,
} from './commercial-ocr-decision-policy';
import { runCommercialOcrAlbumSchedule } from './commercial-ocr-album-scheduler';
import {
  CommercialOcrMetricsService,
  type CommercialOcrImageCpuSample,
} from './commercial-ocr-metrics.service';
import {
  commercialOcrCacheValueToDecisionPass,
  convertCommercialOcrNativePayload,
} from './commercial-ocr-native-result.converter';
import {
  CommercialOcrImageRejectedError,
  CommercialOcrPreprocessor,
  resolveCommercialOcrPreprocessCacheProfile,
  resolveCommercialOcrPreprocessLimits,
  type CommercialOcrPassName,
  type CommercialOcrPreprocessLimits,
} from './commercial-ocr-preprocessor';
import {
  validateCommercialOcrImageCount,
  validateCommercialOcrVersion,
} from './commercial-ocr.queue';
import { NativeTesseractOcrAdapter } from './native-tesseract-ocr.adapter';
import type {
  NativeTesseractFailureReason,
  NativeTesseractPageSegmentationMode,
} from './native-tesseract-ocr.types';

const DEFAULT_CACHE_TTL_SECONDS = 7 * 24 * 60 * 60;
const GOVERNOR_DEFER_MS = 30_000;
const RETRYABLE_DOWNLOAD_ERROR_CODES = new Set([
  'EAI_AGAIN',
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTDOWN',
  'EHOSTUNREACH',
  'ENETDOWN',
  'ENETRESET',
  'ENETUNREACH',
  'ENOTFOUND',
  'EPIPE',
  'ETIMEDOUT',
]);
const RETRYABLE_OCR_FAILURE_REASONS = new Set<NativeTesseractFailureReason>([
  'capacity_exhausted',
  'worker_unavailable',
  'tesseract_failed',
  'shutting_down',
]);

export type CommercialOcrAnalysisStage = 'download' | 'ocr';

export type CommercialOcrAnalysisIncompleteReason =
  | 'invalid_album'
  | 'job_deadline_exceeded'
  | 'missing_download_url'
  | 'download_failed'
  | 'image_rejected'
  | 'preprocess_timeout'
  | 'ocr_failed'
  | 'ocr_timeout'
  | 'ocr_truncated'
  | 'invalid_ocr_output';

export type CommercialOcrAnalysisRetryReason = 'download_failed' | 'ocr_failed';

export type CommercialOcrAnalysisResult =
  | { kind: 'complete'; decision: CommercialOcrDecision }
  | {
      kind: 'incomplete';
      reason: CommercialOcrAnalysisIncompleteReason;
      imageIndex?: number;
      pass?: CommercialOcrPassName;
    }
  | {
      kind: 'defer';
      reason: 'governor_pressure';
      delayMs: number;
    }
  | {
      kind: 'retry';
      reason: CommercialOcrAnalysisRetryReason;
      imageIndex: number;
      pass?: CommercialOcrPassName;
    };

type PassResult =
  | { kind: 'ready'; pass: CommercialOcrPass; value: CommercialOcrCacheValue }
  | Extract<CommercialOcrAnalysisResult, { kind: 'incomplete' | 'defer' | 'retry' }>;

@Injectable()
export class CommercialOcrAnalysisService {
  private readonly cacheTtlSeconds: number;
  private readonly preprocessLimits: CommercialOcrPreprocessLimits;
  private readonly detector: CommercialOcrDetector = new CommercialAdDetector();

  constructor(
    private readonly downloader: SecurePhotoDownloader,
    private readonly preprocessor: CommercialOcrPreprocessor,
    private readonly ocr: NativeTesseractOcrAdapter,
    private readonly cache: CommercialOcrCacheStore,
    private readonly metrics: CommercialOcrMetricsService,
    configService: ConfigService,
  ) {
    this.cacheTtlSeconds = readPositiveInteger(
      configService.get('COMMERCIAL_OCR_CACHE_TTL_SEC'),
      DEFAULT_CACHE_TTL_SECONDS,
    );
    this.preprocessLimits = resolveCommercialOcrPreprocessLimits(configService);
  }

  async analyzeAlbum(params: {
    album: LogicalPhotoAlbum;
    caption: string;
    settings: ChatSettings;
    ocrVersion: string;
    deadlineAtMs: number;
    authorizeStage: (stage: CommercialOcrAnalysisStage) => Promise<boolean>;
  }): Promise<CommercialOcrAnalysisResult> {
    if (deadlineExpired(params.deadlineAtMs)) {
      return deadlineIncomplete();
    }
    const imageCount = params.album.images.length;
    try {
      validateCommercialOcrImageCount(imageCount);
    } catch {
      return { kind: 'incomplete', reason: 'invalid_album' };
    }
    let ocrVersion: string;
    try {
      ocrVersion = validateCommercialOcrVersion(params.ocrVersion);
    } catch {
      return { kind: 'incomplete', reason: 'invalid_album' };
    }

    type RuntimeImageContext = {
      cpuSample: CommercialOcrImageCpuSample;
      rawBytes: Buffer | null;
      contentSha256: string | null;
    };
    const scheduled = await runCommercialOcrAlbumSchedule<
      RuntimeImageContext,
      Exclude<CommercialOcrAnalysisResult, { kind: 'complete' }>
    >({
      caption: params.caption,
      settings: params.settings,
      imageSources: params.album.images.map((image) => image.source),
      detector: this.detector,
      preflight: () => {
        const missingDownloadUrlIndex = params.album.images.findIndex(
          (image) => !image.downloadUrl,
        );
        return missingDownloadUrlIndex < 0
          ? { kind: 'ready', value: undefined }
          : {
              kind: 'stop',
              result: {
                kind: 'incomplete',
                reason: 'missing_download_url',
                imageIndex: missingDownloadUrlIndex,
              },
            };
      },
      createImageContext: () => ({
        cpuSample: this.metrics.startImageCpuSample(),
        rawBytes: null,
        contentSha256: null,
      }),
      resolvePass: async ({ context, imageIndex, pass }) => {
        if (pass === 'confirmation') {
          this.metrics.recordCounter('confirmation.requested');
        }
        if (deadlineExpired(params.deadlineAtMs)) {
          return {
            kind: 'stop',
            result: deadlineIncomplete(imageIndex, context.rawBytes === null ? undefined : pass),
          };
        }
        if (context.rawBytes === null || context.contentSha256 === null) {
          if (!(await this.authorizeStage(params.authorizeStage, 'download'))) {
            return { kind: 'stop', result: governorDefer() };
          }
          if (deadlineExpired(params.deadlineAtMs)) {
            return { kind: 'stop', result: deadlineIncomplete(imageIndex) };
          }
          const downloadStartedAt = performance.now();
          try {
            context.rawBytes = (
              await this.downloader.download(params.album.images[imageIndex]!.downloadUrl!, {
                deadlineAtMs: params.deadlineAtMs,
              })
            ).bytes;
          } catch (error: unknown) {
            return {
              kind: 'stop',
              result: isRetryableDownloadError(error)
                ? ({ kind: 'retry', reason: 'download_failed', imageIndex } as const)
                : ({ kind: 'incomplete', reason: 'download_failed', imageIndex } as const),
            };
          } finally {
            this.metrics.recordStageDuration(
              'download',
              Math.max(0, performance.now() - downloadStartedAt),
            );
          }
          context.contentSha256 = createHash('sha256').update(context.rawBytes).digest('hex');
        }
        const resolved = await this.resolvePass({
          rawBytes: context.rawBytes,
          contentSha256: context.contentSha256,
          ocrVersion,
          pass,
          psm: pass === 'primary' ? 11 : 6,
          authorizeStage: params.authorizeStage,
          deadlineAtMs: params.deadlineAtMs,
          imageIndex,
          cpuSample: context.cpuSample,
        });
        if (pass === 'confirmation' && resolved.kind === 'ready') {
          this.metrics.recordCounter('confirmation.completed');
        }
        return resolved.kind === 'ready'
          ? { kind: 'ready', value: resolved.pass }
          : { kind: 'stop', result: resolved };
      },
      finishImage: ({ cpuSample }) => this.metrics.finishImageCpuSample(cpuSample),
      observePolicyDuration: (durationMs) => this.metrics.recordStageDuration('policy', durationMs),
    });
    return scheduled.kind === 'complete'
      ? { kind: 'complete', decision: scheduled.decision }
      : scheduled.result;
  }

  private async resolvePass(params: {
    rawBytes: Buffer;
    contentSha256: string;
    ocrVersion: string;
    pass: CommercialOcrPassName;
    psm: NativeTesseractPageSegmentationMode;
    authorizeStage: (stage: CommercialOcrAnalysisStage) => Promise<boolean>;
    deadlineAtMs: number;
    imageIndex: number;
    cpuSample: CommercialOcrImageCpuSample;
  }): Promise<PassResult> {
    const identity: CommercialOcrCacheIdentity = {
      contentSha256: params.contentSha256,
      ocrVersion: params.ocrVersion,
      pass: params.pass,
      preprocessProfile: resolveCommercialOcrPreprocessCacheProfile(
        params.pass,
        this.preprocessLimits,
      ),
      psm: params.psm,
    };
    const lookup = await this.cache.read(identity);
    if (lookup.kind === 'hit') {
      this.metrics.recordCounter(`cache.${params.pass}.hit`);
      return {
        kind: 'ready',
        pass: commercialOcrCacheValueToDecisionPass(lookup.value),
        value: lookup.value,
      };
    }
    this.metrics.recordCounter(`cache.${params.pass}.miss`);
    if (deadlineExpired(params.deadlineAtMs)) {
      return deadlineIncomplete(params.imageIndex, params.pass);
    }
    if (!(await this.authorizeStage(params.authorizeStage, 'ocr'))) {
      return governorDefer();
    }
    if (deadlineExpired(params.deadlineAtMs)) {
      return deadlineIncomplete(params.imageIndex, params.pass);
    }

    const remainingMs = params.deadlineAtMs - Date.now();
    if (remainingMs <= 0) {
      return deadlineIncomplete(params.imageIndex, params.pass);
    }
    let coalesced = false;
    const operation = this.cache.coalesceLocal<PassResult>(
      identity,
      params.deadlineAtMs,
      async () => {
        const reread = await this.cache.read(identity);
        if (reread.kind === 'hit') {
          return {
            kind: 'ready',
            pass: commercialOcrCacheValueToDecisionPass(reread.value),
            value: reread.value,
          };
        }
        return this.runLocalOcr(params, identity);
      },
      {
        onCoalesced: () => {
          coalesced = true;
          this.metrics.recordCounter(`cache.${params.pass}.coalesced`);
        },
      },
    );
    if (!coalesced) {
      return operation;
    }
    return raceWithTimeout<PassResult>({
      operation,
      timeoutMs: remainingMs,
      onTimeout: () => deadlineIncomplete(params.imageIndex, params.pass),
    });
  }

  private async runLocalOcr(
    params: {
      rawBytes: Buffer;
      pass: CommercialOcrPassName;
      psm: NativeTesseractPageSegmentationMode;
      authorizeStage: (stage: CommercialOcrAnalysisStage) => Promise<boolean>;
      deadlineAtMs: number;
      imageIndex: number;
      cpuSample: CommercialOcrImageCpuSample;
    },
    identity: CommercialOcrCacheIdentity,
  ): Promise<PassResult> {
    if (deadlineExpired(params.deadlineAtMs)) {
      return deadlineIncomplete(params.imageIndex, params.pass);
    }
    let prepared: Buffer;
    const preprocessStartedAt = performance.now();
    try {
      prepared = (
        await this.preprocessor.prepare(params.rawBytes, params.pass, {
          deadlineAtMs: params.deadlineAtMs,
        })
      ).bytes;
    } catch (error: unknown) {
      if (deadlineExpired(params.deadlineAtMs)) {
        return deadlineIncomplete(params.imageIndex, params.pass);
      }
      return {
        kind: 'incomplete',
        reason:
          error instanceof CommercialOcrImageRejectedError &&
          error.reason === 'processing_timeout'
            ? 'preprocess_timeout'
            : 'image_rejected',
        imageIndex: params.imageIndex,
        pass: params.pass,
      };
    } finally {
      this.metrics.recordStageDuration(
        'preprocess',
        Math.max(0, performance.now() - preprocessStartedAt),
      );
    }
    if (deadlineExpired(params.deadlineAtMs)) {
      return deadlineIncomplete(params.imageIndex, params.pass);
    }

    let result: Awaited<ReturnType<NativeTesseractOcrAdapter['recognize']>>;
    const nativePassStartedAt = performance.now();
    try {
      result = await this.ocr.recognize(prepared, {
        psm: params.psm,
        passLabel: params.pass,
        deadlineAtMs: params.deadlineAtMs,
      });
      this.metrics.recordNativePass(params.cpuSample, result.durationMs);
    } catch {
      this.metrics.recordNativePass(
        params.cpuSample,
        Math.max(0, performance.now() - nativePassStartedAt),
      );
      return {
        kind: 'retry',
        reason: 'ocr_failed',
        imageIndex: params.imageIndex,
        pass: params.pass,
      };
    }
    if (!result.ok && result.reason === 'timeout') {
      return {
        kind: 'incomplete',
        reason: 'ocr_timeout',
        imageIndex: params.imageIndex,
        pass: params.pass,
      };
    }
    if (!result.ok && RETRYABLE_OCR_FAILURE_REASONS.has(result.reason)) {
      return {
        kind: 'retry',
        reason: 'ocr_failed',
        imageIndex: params.imageIndex,
        pass: params.pass,
      };
    }
    if (!result.ok) {
      return {
        kind: 'incomplete',
        reason: 'ocr_failed',
        imageIndex: params.imageIndex,
        pass: params.pass,
      };
    }
    const converted = convertCommercialOcrNativePayload(result);
    if (converted.kind === 'rejected') {
      return {
        kind: 'incomplete',
        reason: converted.reason === 'truncated' ? 'ocr_truncated' : 'invalid_ocr_output',
        imageIndex: params.imageIndex,
        pass: params.pass,
      };
    }
    await this.cache.write(identity, converted.value, this.cacheTtlSeconds);
    return { kind: 'ready', pass: converted.pass, value: converted.value };
  }

  private async authorizeStage(
    callback: (stage: CommercialOcrAnalysisStage) => Promise<boolean>,
    stage: CommercialOcrAnalysisStage,
  ): Promise<boolean> {
    const authorized = await authorize(callback, stage);
    this.metrics.recordCounter(`stage.${stage}.${authorized ? 'authorized' : 'denied'}`);
    return authorized;
  }
}

async function authorize(
  callback: (stage: CommercialOcrAnalysisStage) => Promise<boolean>,
  stage: CommercialOcrAnalysisStage,
): Promise<boolean> {
  try {
    return (await callback(stage)) === true;
  } catch {
    return false;
  }
}

function governorDefer(): Extract<CommercialOcrAnalysisResult, { kind: 'defer' }> {
  return { kind: 'defer', reason: 'governor_pressure', delayMs: GOVERNOR_DEFER_MS };
}

function deadlineIncomplete(
  imageIndex?: number,
  pass?: CommercialOcrPassName,
): Extract<CommercialOcrAnalysisResult, { kind: 'incomplete' }> {
  return {
    kind: 'incomplete',
    reason: 'job_deadline_exceeded',
    ...(imageIndex === undefined ? {} : { imageIndex }),
    ...(pass === undefined ? {} : { pass }),
  };
}

function deadlineExpired(deadlineAtMs: number): boolean {
  return !Number.isSafeInteger(deadlineAtMs) || deadlineAtMs <= Date.now();
}

function isRetryableDownloadError(error: unknown): boolean {
  if (error instanceof PhotoDownloadHttpError) {
    return (
      error.statusCode === 408 ||
      error.statusCode === 425 ||
      error.statusCode === 429 ||
      (error.statusCode >= 500 && error.statusCode <= 599)
    );
  }
  if (error instanceof Error && error.message === 'Photo download timed out') {
    return true;
  }
  const code = (error as NodeJS.ErrnoException | null | undefined)?.code;
  return typeof code === 'string' && RETRYABLE_DOWNLOAD_ERROR_CODES.has(code);
}

function readPositiveInteger(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
