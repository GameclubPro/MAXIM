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
  COMMERCIAL_OCR_CACHE_SCHEMA_VERSION,
  CommercialOcrCacheStore,
  type CommercialOcrCacheIdentity,
  type CommercialOcrCacheValue,
} from './commercial-ocr-cache.store';
import {
  evaluateCommercialOcrDecision,
  type CommercialOcrDecision,
  type CommercialOcrDetector,
  type CommercialOcrImageDecisionInput,
  type CommercialOcrPass,
} from './commercial-ocr-decision-policy';
import { deriveCommercialOcrCriticalEvidence } from './commercial-ocr-evidence';
import {
  CommercialOcrMetricsService,
  type CommercialOcrImageCpuSample,
} from './commercial-ocr-metrics.service';
import {
  COMMERCIAL_OCR_PREPROCESS_PROFILES,
  CommercialOcrPreprocessor,
  type CommercialOcrPassName,
} from './commercial-ocr-preprocessor';
import {
  validateCommercialOcrImageCount,
  validateCommercialOcrVersion,
} from './commercial-ocr.queue';
import { NativeTesseractOcrAdapter } from './native-tesseract-ocr.adapter';
import type {
  NativeTesseractFailureReason,
  NativeTesseractPageSegmentationMode,
  NativeTesseractRecognizedResult,
} from './native-tesseract-ocr.types';

const DEFAULT_CACHE_TTL_SECONDS = 7 * 24 * 60 * 60;
const GOVERNOR_DEFER_MS = 30_000;
const MAX_CACHE_WORDS = 1_024;
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

type AnalyzedImage = {
  imageIndex: number;
  source: 'direct' | 'forward';
  primary: CommercialOcrPass;
  verification: CommercialOcrPass | null;
};

type PassResult =
  | { kind: 'ready'; pass: CommercialOcrPass; value: CommercialOcrCacheValue }
  | Extract<CommercialOcrAnalysisResult, { kind: 'incomplete' | 'defer' | 'retry' }>;

@Injectable()
export class CommercialOcrAnalysisService {
  private readonly cacheTtlSeconds: number;
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

    if (params.caption.trim()) {
      const captionDecision = this.evaluate({
        caption: params.caption,
        expectedImageCount: imageCount,
        images: [],
        settings: params.settings,
      });
      if (captionDecision.caption.safeContextBucket !== 'none') {
        return { kind: 'complete', decision: captionDecision };
      }
    }

    const missingDownloadUrlIndex = params.album.images.findIndex((image) => !image.downloadUrl);
    if (missingDownloadUrlIndex >= 0) {
      return {
        kind: 'incomplete',
        reason: 'missing_download_url',
        imageIndex: missingDownloadUrlIndex,
      };
    }

    const images: AnalyzedImage[] = [];
    for (let imageIndex = 0; imageIndex < imageCount; imageIndex += 1) {
      const cpuSample = this.metrics.startImageCpuSample();
      try {
        const image = params.album.images[imageIndex];
        const downloadUrl = image!.downloadUrl!;
        if (deadlineExpired(params.deadlineAtMs)) {
          return deadlineIncomplete(imageIndex);
        }
        if (!(await authorize(params.authorizeStage, 'download'))) {
          return governorDefer();
        }
        if (deadlineExpired(params.deadlineAtMs)) {
          return deadlineIncomplete(imageIndex);
        }

        let rawBytes: Buffer;
        try {
          rawBytes = (
            await this.downloader.download(downloadUrl, { deadlineAtMs: params.deadlineAtMs })
          ).bytes;
        } catch (error: unknown) {
          if (isRetryableDownloadError(error)) {
            return { kind: 'retry', reason: 'download_failed', imageIndex };
          }
          return { kind: 'incomplete', reason: 'download_failed', imageIndex };
        }
        const contentSha256 = createHash('sha256').update(rawBytes).digest('hex');
        const primary = await this.resolvePass({
          rawBytes,
          contentSha256,
          ocrVersion,
          pass: 'primary',
          psm: 11,
          authorizeStage: params.authorizeStage,
          deadlineAtMs: params.deadlineAtMs,
          imageIndex,
          cpuSample,
        });
        if (primary.kind !== 'ready') {
          return primary;
        }
        images.push({
          imageIndex,
          source: image!.source,
          primary: primary.pass,
          verification: null,
        });
        const primaryDecision = this.evaluate({
          caption: params.caption,
          expectedImageCount: imageCount,
          images: toDecisionImages(images),
          settings: params.settings,
        });
        if (hasSafeContextVeto(primaryDecision)) {
          return { kind: 'complete', decision: primaryDecision };
        }
        if (!isPrimaryDeleteCandidate(primaryDecision, imageIndex)) {
          continue;
        }

        const confirmation = await this.resolvePass({
          rawBytes,
          contentSha256,
          ocrVersion,
          pass: 'confirmation',
          psm: 6,
          authorizeStage: params.authorizeStage,
          deadlineAtMs: params.deadlineAtMs,
          imageIndex,
          cpuSample,
        });
        if (confirmation.kind !== 'ready') {
          return confirmation;
        }
        images[images.length - 1]!.verification = confirmation.pass;
        const confirmedDecision = this.evaluate({
          caption: params.caption,
          expectedImageCount: imageCount,
          images: toDecisionImages(images),
          settings: params.settings,
        });
        if (hasSafeContextVeto(confirmedDecision)) {
          return { kind: 'complete', decision: confirmedDecision };
        }
      } finally {
        this.metrics.finishImageCpuSample(cpuSample);
      }
    }

    return {
      kind: 'complete',
      decision: this.evaluate({
        caption: params.caption,
        expectedImageCount: imageCount,
        images: toDecisionImages(images),
        settings: params.settings,
      }),
    };
  }

  private evaluate(params: {
    caption: string;
    expectedImageCount: number;
    images: readonly CommercialOcrImageDecisionInput[];
    settings: ChatSettings;
  }): CommercialOcrDecision {
    return evaluateCommercialOcrDecision({ ...params, detector: this.detector });
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
      preprocessProfile: COMMERCIAL_OCR_PREPROCESS_PROFILES[params.pass],
      psm: params.psm,
    };
    const lookup = await this.cache.read(identity);
    if (lookup.kind === 'hit') {
      return { kind: 'ready', pass: toDecisionPass(lookup.value), value: lookup.value };
    }
    if (deadlineExpired(params.deadlineAtMs)) {
      return deadlineIncomplete(params.imageIndex, params.pass);
    }
    if (!(await authorize(params.authorizeStage, 'ocr'))) {
      return governorDefer();
    }
    if (deadlineExpired(params.deadlineAtMs)) {
      return deadlineIncomplete(params.imageIndex, params.pass);
    }

    const remainingMs = params.deadlineAtMs - Date.now();
    if (remainingMs <= 0) {
      return deadlineIncomplete(params.imageIndex, params.pass);
    }
    return raceWithTimeout<PassResult>({
      operation: this.cache.coalesceLocal(identity, params.deadlineAtMs, async () => {
        const reread = await this.cache.read(identity);
        if (reread.kind === 'hit') {
          return { kind: 'ready', pass: toDecisionPass(reread.value), value: reread.value };
        }
        return this.runLocalOcr(params, identity);
      }),
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
    try {
      prepared = (await this.preprocessor.prepare(params.rawBytes, params.pass)).bytes;
    } catch {
      return {
        kind: 'incomplete',
        reason: 'image_rejected',
        imageIndex: params.imageIndex,
        pass: params.pass,
      };
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
    if (result.truncated) {
      return {
        kind: 'incomplete',
        reason: 'ocr_truncated',
        imageIndex: params.imageIndex,
        pass: params.pass,
      };
    }
    const value = fromNativeResult(result);
    if (!value) {
      return {
        kind: 'incomplete',
        reason: 'invalid_ocr_output',
        imageIndex: params.imageIndex,
        pass: params.pass,
      };
    }
    await this.cache.write(identity, value, this.cacheTtlSeconds);
    return { kind: 'ready', pass: toDecisionPass(value), value };
  }
}

function fromNativeResult(result: NativeTesseractRecognizedResult): CommercialOcrCacheValue | null {
  if (result.status === 'no_text') {
    return result.text === '' && result.words.length === 0
      ? {
          schemaVersion: COMMERCIAL_OCR_CACHE_SCHEMA_VERSION,
          status: 'no_text',
          text: '',
          confidencePermille: 0,
          words: [],
        }
      : null;
  }
  if (
    !result.text.trim() ||
    result.aggregateConfidence === null ||
    result.words.length === 0 ||
    result.words.length > MAX_CACHE_WORDS ||
    !isNativeConfidence(result.aggregateConfidence)
  ) {
    return null;
  }
  let previousEnd = 0;
  for (const word of result.words) {
    if (
      !word.text ||
      !Number.isSafeInteger(word.start) ||
      !Number.isSafeInteger(word.end) ||
      word.start < previousEnd ||
      word.end <= word.start ||
      word.end > result.text.length ||
      result.text.slice(word.start, word.end) !== word.text ||
      !isNativeConfidence(word.confidence)
    ) {
      return null;
    }
    previousEnd = word.end;
  }
  return {
    schemaVersion: COMMERCIAL_OCR_CACHE_SCHEMA_VERSION,
    status: 'recognized',
    text: result.text,
    confidencePermille: toPermille(result.aggregateConfidence),
    words: result.words.map((word) => ({
      text: word.text,
      start: word.start,
      end: word.end,
      confidencePermille: toPermille(word.confidence),
    })),
  };
}

function toDecisionPass(value: CommercialOcrCacheValue): CommercialOcrPass {
  return {
    status: value.status,
    text: value.text,
    confidencePermille: value.confidencePermille,
    criticalEvidence:
      value.status === 'recognized'
        ? deriveCommercialOcrCriticalEvidence({ text: value.text, words: value.words })
        : [],
  };
}

function toDecisionImages(images: readonly AnalyzedImage[]): CommercialOcrImageDecisionInput[] {
  return images.map((image) => ({
    imageIndex: image.imageIndex,
    source: image.source,
    primary: image.primary,
    verification: image.verification,
  }));
}

function isPrimaryDeleteCandidate(decision: CommercialOcrDecision, imageIndex: number): boolean {
  return decision.images.some(
    (image) =>
      image.imageIndex === imageIndex &&
      image.primary.deleteEligible &&
      image.primary.criticalSignature.length >= 2 &&
      image.primary.detection !== null,
  );
}

function hasSafeContextVeto(decision: CommercialOcrDecision): boolean {
  return (
    decision.caption.safeContextBucket !== 'none' ||
    decision.reasonCodes.some((reason) => reason.startsWith('image-safe-context:'))
  );
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

function toPermille(confidence: number): number {
  return Math.max(0, Math.min(1_000, Math.round(confidence * 10)));
}

function isNativeConfidence(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 100;
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
