import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import sharp, { type Metadata } from 'sharp';

const DEFAULT_MAX_INPUT_PIXELS = 40_000_000;
const DEFAULT_MAX_OUTPUT_PIXELS = 3_000_000;
const DEFAULT_MAX_SIDE = 2_000;
const CONFIRMATION_THRESHOLD = 160;

export const COMMERCIAL_OCR_PREPROCESS_PROFILES = Object.freeze({
  primary: 'gray-bounded-v3',
  confirmation: 'normalized-threshold160-v3',
} as const);

export type CommercialOcrPassName = keyof typeof COMMERCIAL_OCR_PREPROCESS_PROFILES;

export type CommercialOcrPreparedImage = {
  bytes: Buffer;
  width: number;
  height: number;
};

export class CommercialOcrImageRejectedError extends Error {
  constructor(readonly reason: 'invalid_image' | 'too_many_pixels' | 'animated_image') {
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
    this.maxInputPixels = readPositiveInt(
      configService.get('COMMERCIAL_OCR_MAX_INPUT_PIXELS'),
      DEFAULT_MAX_INPUT_PIXELS,
    );
    this.maxOutputPixels = readPositiveInt(
      configService.get('COMMERCIAL_OCR_MAX_OUTPUT_PIXELS'),
      DEFAULT_MAX_OUTPUT_PIXELS,
    );
    this.maxSide = readPositiveInt(configService.get('COMMERCIAL_OCR_MAX_SIDE'), DEFAULT_MAX_SIDE);
  }

  async prepare(input: Buffer, pass: CommercialOcrPassName): Promise<CommercialOcrPreparedImage> {
    let metadata: Metadata;
    try {
      metadata = await sharp(input, { limitInputPixels: this.maxInputPixels }).metadata();
    } catch (error: unknown) {
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
      .rotate()
      .resize(width, height, { fit: 'inside', withoutEnlargement: true, fastShrinkOnLoad: true })
      .grayscale();
    if (pass === 'confirmation') {
      pipeline = pipeline.normalize().threshold(CONFIRMATION_THRESHOLD, { greyscale: true });
    }
    const prepared = await pipeline
      .png({ compressionLevel: 1, adaptiveFiltering: false })
      .toBuffer({
        resolveWithObject: true,
      });
    return {
      bytes: prepared.data,
      width: prepared.info.width,
      height: prepared.info.height,
    };
  }
}

function readPositiveInt(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function isPixelLimitError(error: unknown): boolean {
  return error instanceof Error && error.message.toLowerCase().includes('pixel limit');
}
