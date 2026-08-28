import {
  MAX_IMAGE_UPLOAD_MAX_DIMENSION_PX,
  MaxMediaUploadValidationError,
  validateMaxMediaUploadPayload,
  type MaxValidatedImageUpload,
} from './max-media-upload-validation';

const MAX_IMAGE_NORMALIZATION_INPUT_PIXELS = 16_000_000;
const MAX_IMAGE_NORMALIZATION_CONCURRENCY = 2;
const JPEG_QUALITY_LADDER = [92, 82, 72] as const;

let imageNormalizationsInFlight = 0;
const imageNormalizationWaiters: Array<() => void> = [];

export const MAX_IMAGE_UPLOAD_NORMALIZATION_ERROR_CODES = Object.freeze({
  DIMENSIONS_EXCEEDED: 'MAX_IMAGE_NORMALIZATION_DIMENSIONS_EXCEEDED',
  INPUT_PIXEL_LIMIT_EXCEEDED: 'MAX_IMAGE_NORMALIZATION_INPUT_PIXEL_LIMIT_EXCEEDED',
  OUTPUT_TOO_LARGE: 'MAX_IMAGE_NORMALIZATION_OUTPUT_TOO_LARGE',
  TRANSCODE_FAILED: 'MAX_IMAGE_NORMALIZATION_TRANSCODE_FAILED',
} as const);

export type MaxImageUploadNormalizationErrorCode =
  (typeof MAX_IMAGE_UPLOAD_NORMALIZATION_ERROR_CODES)[keyof typeof MAX_IMAGE_UPLOAD_NORMALIZATION_ERROR_CODES];

export class MaxImageUploadNormalizationError extends Error {
  constructor(
    readonly code: MaxImageUploadNormalizationErrorCode,
    options: { cause?: unknown } = {},
  ) {
    super(code);
    this.name = 'MaxImageUploadNormalizationError';
    if (options.cause !== undefined) {
      Object.defineProperty(this, 'cause', {
        configurable: true,
        value: options.cause,
        writable: false,
      });
    }
  }
}

export type NormalizedMaxImageUpload = {
  bytes: Buffer;
  extension: MaxValidatedImageUpload['extension'];
  mimeType: MaxValidatedImageUpload['mimeType'];
};

export async function normalizeUnsupportedMaxImageUpload(
  data: Buffer,
  maxBytes: number,
): Promise<NormalizedMaxImageUpload> {
  if (
    !Buffer.isBuffer(data) ||
    data.length === 0 ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes <= 0
  ) {
    throw new MaxImageUploadNormalizationError(
      MAX_IMAGE_UPLOAD_NORMALIZATION_ERROR_CODES.TRANSCODE_FAILED,
    );
  }

  const admission = acquireImageNormalizationSlot();
  if (admission) {
    await admission;
  }

  try {
    return await transcodeAndValidate(data, maxBytes);
  } finally {
    releaseImageNormalizationSlot();
  }
}

async function transcodeAndValidate(
  data: Buffer,
  maxBytes: number,
): Promise<NormalizedMaxImageUpload> {
  try {
    const { default: sharp } = await import('sharp');
    const createPipeline = () =>
      sharp(data, {
        failOn: 'error',
        limitInputPixels: MAX_IMAGE_NORMALIZATION_INPUT_PIXELS,
        sequentialRead: true,
      }).rotate();
    const metadata = await createPipeline().metadata();

    if (
      !metadata.width ||
      !metadata.height ||
      metadata.width > MAX_IMAGE_UPLOAD_MAX_DIMENSION_PX ||
      metadata.height > MAX_IMAGE_UPLOAD_MAX_DIMENSION_PX
    ) {
      throw new MaxImageUploadNormalizationError(
        MAX_IMAGE_UPLOAD_NORMALIZATION_ERROR_CODES.DIMENSIONS_EXCEEDED,
      );
    }

    if (metadata.hasAlpha) {
      const png = await createPipeline()
        .png({ compressionLevel: 9, adaptiveFiltering: true })
        .toBuffer();
      if (png.length <= maxBytes) {
        return validateNormalizedBytes(png);
      }
    }

    for (const quality of JPEG_QUALITY_LADDER) {
      const jpeg = await createPipeline()
        .flatten({ background: '#ffffff' })
        .jpeg({ quality, progressive: true })
        .toBuffer();
      if (jpeg.length <= maxBytes) {
        return validateNormalizedBytes(jpeg);
      }
    }

    throw new MaxImageUploadNormalizationError(
      MAX_IMAGE_UPLOAD_NORMALIZATION_ERROR_CODES.OUTPUT_TOO_LARGE,
    );
  } catch (error: unknown) {
    if (
      error instanceof MaxImageUploadNormalizationError ||
      error instanceof MaxMediaUploadValidationError
    ) {
      throw error;
    }
    if (error instanceof Error && error.message.toLowerCase().includes('pixel limit')) {
      throw new MaxImageUploadNormalizationError(
        MAX_IMAGE_UPLOAD_NORMALIZATION_ERROR_CODES.INPUT_PIXEL_LIMIT_EXCEEDED,
        { cause: error },
      );
    }
    throw new MaxImageUploadNormalizationError(
      MAX_IMAGE_UPLOAD_NORMALIZATION_ERROR_CODES.TRANSCODE_FAILED,
      { cause: error },
    );
  }
}

async function validateNormalizedBytes(bytes: Buffer): Promise<NormalizedMaxImageUpload> {
  const validated = await validateMaxMediaUploadPayload('image', bytes);
  return {
    bytes,
    extension: validated.extension,
    mimeType: validated.mimeType,
  };
}

function acquireImageNormalizationSlot(): Promise<void> | null {
  if (
    imageNormalizationsInFlight < MAX_IMAGE_NORMALIZATION_CONCURRENCY &&
    imageNormalizationWaiters.length === 0
  ) {
    imageNormalizationsInFlight += 1;
    return null;
  }
  return new Promise<void>((resolve) => imageNormalizationWaiters.push(resolve));
}

function releaseImageNormalizationSlot(): void {
  const next = imageNormalizationWaiters.shift();
  if (next) {
    next();
    return;
  }
  imageNormalizationsInFlight = Math.max(0, imageNormalizationsInFlight - 1);
}
