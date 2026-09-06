import sharp, { type Metadata, type OutputInfo } from 'sharp';

import {
  COMMERCIAL_OCR_SHARP_CONCURRENCY,
  COMMERCIAL_OCR_SHARP_PROCESSING_TIMEOUT_SECONDS,
  CommercialOcrImageRejectedError,
  type CommercialOcrPassName,
  type CommercialOcrPreparedImage,
  type CommercialOcrPreprocessLimits,
} from './commercial-ocr-preprocess-config';

export * from './commercial-ocr-preprocess-config';

const CONFIRMATION_THRESHOLD = 160;

export class NativeOcrImagePreprocessor {
  constructor(private readonly limits: CommercialOcrPreprocessLimits) {
    sharp.concurrency(COMMERCIAL_OCR_SHARP_CONCURRENCY);
  }

  async prepare(
    input: Buffer,
    pass: CommercialOcrPassName,
    options: { deadlineAtMs?: number } = {},
  ): Promise<CommercialOcrPreparedImage> {
    let metadata: Metadata;
    try {
      metadata = await sharp(input, { limitInputPixels: this.limits.maxInputPixels })
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
    if (!Number.isSafeInteger(inputPixels) || inputPixels > this.limits.maxInputPixels) {
      throw new CommercialOcrImageRejectedError('too_many_pixels');
    }
    const swapsAxes =
      metadata.orientation !== undefined && metadata.orientation >= 5 && metadata.orientation <= 8;
    const orientedWidth = swapsAxes ? metadata.height : metadata.width;
    const orientedHeight = swapsAxes ? metadata.width : metadata.height;
    const outputScale = Math.min(
      1,
      this.limits.maxSide / Math.max(orientedWidth, orientedHeight),
      Math.sqrt(this.limits.maxOutputPixels / inputPixels),
    );
    const width = Math.max(1, Math.round(orientedWidth * outputScale));
    const height = Math.max(1, Math.round(orientedHeight * outputScale));

    let pipeline = sharp(input, {
      limitInputPixels: this.limits.maxInputPixels,
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
