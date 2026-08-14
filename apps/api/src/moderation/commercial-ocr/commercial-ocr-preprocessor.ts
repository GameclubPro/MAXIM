import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import sharp, { type Metadata, type OutputInfo } from 'sharp';

const DEFAULT_MAX_INPUT_PIXELS = 40_000_000;
const DEFAULT_MAX_OUTPUT_PIXELS = 3_000_000;
const DEFAULT_MAX_SIDE = 2_000;
const CONFIRMATION_THRESHOLD = 160;

export const COMMERCIAL_OCR_SHARP_CONCURRENCY = 1;
export const COMMERCIAL_OCR_SHARP_PROCESSING_TIMEOUT_SECONDS = 5;

export const COMMERCIAL_OCR_PREPROCESS_PROFILES = Object.freeze({
  primary: 'gray-bounded-v3',
  confirmation: 'normalized-threshold160-v3',
} as const);

export type CommercialOcrPassName = keyof typeof COMMERCIAL_OCR_PREPROCESS_PROFILES;

export type CommercialOcrPreprocessLimits = Readonly<{
  maxInputPixels: number;
  maxOutputPixels: number;
  maxSide: number;
}>;

export interface CommercialOcrPreprocessConfigReader {
  get(propertyPath: string): unknown;
}

export const COMMERCIAL_OCR_DEFAULT_PREPROCESS_LIMITS: CommercialOcrPreprocessLimits =
  Object.freeze({
    maxInputPixels: DEFAULT_MAX_INPUT_PIXELS,
    maxOutputPixels: DEFAULT_MAX_OUTPUT_PIXELS,
    maxSide: DEFAULT_MAX_SIDE,
  });

export type CommercialOcrPreparedImage = {
  bytes: Buffer;
  width: number;
  height: number;
};

export class CommercialOcrImageRejectedError extends Error {
  constructor(
    readonly reason:
      | 'invalid_image'
      | 'too_many_pixels'
      | 'animated_image'
      | 'processing_timeout',
  ) {
    super(`Commercial OCR image rejected: ${reason}`);
    this.name = 'CommercialOcrImageRejectedError';
  }
}

@Injectable()
export class CommercialOcrPreprocessor {
  private readonly maxInputPixels: number;
  private readonly maxOutputPixels: number;
  private readonly maxSide: number;

  constructor(configService: ConfigService) {
    const limits = resolveCommercialOcrPreprocessLimits(configService);
    this.maxInputPixels = limits.maxInputPixels;
    this.maxOutputPixels = limits.maxOutputPixels;
    this.maxSide = limits.maxSide;
    sharp.concurrency(COMMERCIAL_OCR_SHARP_CONCURRENCY);
  }

  async prepare(
    input: Buffer,
    pass: CommercialOcrPassName,
    options: { deadlineAtMs?: number } = {},
  ): Promise<CommercialOcrPreparedImage> {
    let metadata: Metadata;
    try {
      metadata = await sharp(input, { limitInputPixels: this.maxInputPixels })
        .timeout({ seconds: resolveSharpTimeoutSeconds(options.deadlineAtMs) })
        .metadata();
    } catch (error: unknown) {
      if (isProcessingTimeoutError(error)) {
        throw new CommercialOcrImageRejectedError('processing_timeout');
      }
      if (isPixelLimitError(error)) {
        throw new CommercialOcrImageRejectedError('too_many_pixels');
      }
      throw new CommercialOcrImageRejectedError('invalid_image');
    }
    if (!metadata.width || !metadata.height) {
      throw new CommercialOcrImageRejectedError('invalid_image');
    }
    if ((metadata.pages ?? 1) > 1) {
      throw new CommercialOcrImageRejectedError('animated_image');
    }

    const inputPixels = metadata.width * metadata.height;
    if (!Number.isSafeInteger(inputPixels) || inputPixels > this.maxInputPixels) {
      throw new CommercialOcrImageRejectedError('too_many_pixels');
    }
    const swapsAxes =
      metadata.orientation !== undefined && metadata.orientation >= 5 && metadata.orientation <= 8;
    const orientedWidth = swapsAxes ? metadata.height : metadata.width;
    const orientedHeight = swapsAxes ? metadata.width : metadata.height;
    const outputScale = Math.min(
      1,
      this.maxSide / Math.max(orientedWidth, orientedHeight),
      Math.sqrt(this.maxOutputPixels / inputPixels),
    );
    const width = Math.max(1, Math.round(orientedWidth * outputScale));
    const height = Math.max(1, Math.round(orientedHeight * outputScale));

    let pipeline = sharp(input, {
      limitInputPixels: this.maxInputPixels,
      sequentialRead: true,
      animated: false,
    })
      .timeout({ seconds: resolveSharpTimeoutSeconds(options.deadlineAtMs) })
      .rotate()
      .resize(width, height, { fit: 'inside', withoutEnlargement: true, fastShrinkOnLoad: true })
      .grayscale();
    if (pass === 'confirmation') {
      pipeline = pipeline.normalize().threshold(CONFIRMATION_THRESHOLD, { greyscale: true });
    }
    let prepared: { data: Buffer; info: OutputInfo };
    try {
      prepared = await pipeline
        .png({ compressionLevel: 1, adaptiveFiltering: false })
        .toBuffer({ resolveWithObject: true });
    } catch (error: unknown) {
      if (isProcessingTimeoutError(error)) {
        throw new CommercialOcrImageRejectedError('processing_timeout');
      }
      if (isPixelLimitError(error)) {
        throw new CommercialOcrImageRejectedError('too_many_pixels');
      }
      throw new CommercialOcrImageRejectedError('invalid_image');
    }
    return {
      bytes: prepared.data,
      width: prepared.info.width,
      height: prepared.info.height,
    };
  }
}

export function resolveCommercialOcrPreprocessLimits(
  configService?: CommercialOcrPreprocessConfigReader,
): CommercialOcrPreprocessLimits {
  return Object.freeze({
    maxInputPixels: readPositiveInt(
      configService?.get('COMMERCIAL_OCR_MAX_INPUT_PIXELS'),
      DEFAULT_MAX_INPUT_PIXELS,
    ),
    maxOutputPixels: readPositiveInt(
      configService?.get('COMMERCIAL_OCR_MAX_OUTPUT_PIXELS'),
      DEFAULT_MAX_OUTPUT_PIXELS,
    ),
    maxSide: readPositiveInt(configService?.get('COMMERCIAL_OCR_MAX_SIDE'), DEFAULT_MAX_SIDE),
  });
}

export function resolveCommercialOcrPreprocessCacheProfile(
  pass: CommercialOcrPassName,
  limits: CommercialOcrPreprocessLimits,
): string {
  return [
    COMMERCIAL_OCR_PREPROCESS_PROFILES[pass],
    `i${limits.maxInputPixels}`,
    `o${limits.maxOutputPixels}`,
    `s${limits.maxSide}`,
  ].join('.');
}

function readPositiveInt(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function isPixelLimitError(error: unknown): boolean {
  return error instanceof Error && error.message.toLowerCase().includes('pixel limit');
}

function isProcessingTimeoutError(error: unknown): boolean {
  return error instanceof CommercialOcrImageRejectedError
    ? error.reason === 'processing_timeout'
    : error instanceof Error && error.message.toLowerCase().includes('timeout');
}

function resolveSharpTimeoutSeconds(deadlineAtMs: number | undefined): number {
  if (deadlineAtMs === undefined) {
    return COMMERCIAL_OCR_SHARP_PROCESSING_TIMEOUT_SECONDS;
  }
  const remainingWholeSeconds = Math.floor((deadlineAtMs - Date.now()) / 1_000);
  if (!Number.isSafeInteger(deadlineAtMs) || remainingWholeSeconds < 1) {
    throw new CommercialOcrImageRejectedError('processing_timeout');
  }
  return Math.min(COMMERCIAL_OCR_SHARP_PROCESSING_TIMEOUT_SECONDS, remainingWholeSeconds);
}
